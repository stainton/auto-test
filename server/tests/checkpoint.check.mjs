import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { packDirectory, packDiagnostics, unpackArchive } from '../shared/archive.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { exportCheckpoint, restoreCheckpoint, projectDirName } from '../planner/checkpoint.mjs';
import { createPlannerWorker } from '../planner/worker.mjs';
import { input, output } from './fixtures.mjs';

const SESSION = '4f2a6b1c-8e3d-4a5b-9c7d-1e2f3a4b5c6d';
async function dir(t, prefix) {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
async function put(root, files) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
}
// What an interrupted planner workspace holds: the CLI keeps the conversation under the workspace's own project dir.
async function interruptedWorkspace(t) {
  const workspace = await dir(t, 'planner-src-');
  await put(workspace, {
    [`claude-config/projects/${projectDirName(workspace)}/${SESSION}.jsonl`]: '{"turn":1}\n',
    'claude-config/.credentials.json': 'token', '.agent-settings.json': '{"env":{"KEY":"secret"}}',
    'seed.spec.ts': 'seed', 'auth/auth-state.json': 'cookie'
  });
  return workspace;
}

test('an archive round-trips nested, long and non-ASCII names and leaves out what it is told to', async t => {
  const source = await dir(t, 'archive-src-'), target = await dir(t, 'archive-out-');
  const long = `${'d'.repeat(120)}/截图 1.png`;
  await put(source, { 'a/x.txt': 'x', [long]: 'png', 'skip/me.txt': 'no' });
  const archive = await packDirectory(source, { skip: name => name === 'skip' });
  assert.deepEqual((await unpackArchive(archive, target)).sort(), ['a/x.txt', long].sort());
  assert.equal(await readFile(path.join(target, long), 'utf8'), 'png');
  await assert.rejects(packDirectory(source, { maxBytes: 2 }), /exceeds/);
  const truncated = await dir(t, 'archive-trunc-');
  await unpackArchive(await packDirectory(source, { maxBytes: 2, truncate: true }), truncated);
  assert.match(await readFile(path.join(truncated, 'OMITTED.txt'), 'utf8'), /Left out/);
});

test('diagnostics keep small logs ahead of alphabetically earlier trace frames', async t => {
  const workspace = await dir(t, 'diag-src-'), target = await dir(t, 'diag-out-');
  const frames = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`diagnostics/c/traces/resources/f${i}.jpeg`, 'j'.repeat(10)]));
  await put(workspace, { ...frames, 'diagnostics/c/huge.trace': 't'.repeat(40), 'progress.jsonl': 'p'.repeat(20) });
  const files = await unpackArchive(await packDiagnostics(workspace, { maxBytes: 80 }), target);
  assert.ok(files.includes('progress.jsonl') && files.includes('diagnostics/c/huge.trace'));
  assert.equal(files.filter(name => name.endsWith('.jpeg')).length, 2);
  assert.match(await readFile(path.join(target, 'OMITTED.txt'), 'utf8'), /f2\.jpeg/);
});

test('an archive entry that escapes the destination is refused', async t => {
  const header = name => { const block = Buffer.alloc(512); block.write(name, 0); block.write('0000001\0', 124); block.write('0', 156); block.write('ustar\0', 257); return block; };
  const evil = gzipSync(Buffer.concat([header('../escape.txt'), Buffer.from('x'.padEnd(512, '\0')), Buffer.alloc(1024)]));
  await assert.rejects(unpackArchive(evil, await dir(t, 'archive-evil-')), /unsafe path/);
  await assert.rejects(unpackArchive(Buffer.from('not gzip'), await dir(t, 'archive-bad-')), /not a readable/);
});

test('a checkpoint carries only the session and moves it to wherever the next node puts the workspace', async t => {
  const workspace = await interruptedWorkspace(t);
  const archive = await exportCheckpoint({ sessionId: SESSION, workspace });
  const next = await dir(t, 'planner-elsewhere-');
  assert.deepEqual(await restoreCheckpoint(archive, next), { sessionId: SESSION });
  assert.equal(await readFile(path.join(next, 'claude-config', 'projects', projectDirName(next), `${SESSION}.jsonl`), 'utf8'), '{"turn":1}\n');
  // Credentials, the task's settings, the saved login and the rest of the workspace stay behind.
  assert.deepEqual((await readdir(next)).sort(), ['checkpoint.json', 'claude-config']);
  assert.deepEqual(await readdir(path.join(next, 'claude-config')), ['projects']);
  const empty = await dir(t, 'planner-empty-');
  await assert.rejects(restoreCheckpoint(await packDirectory(empty), await dir(t, 'planner-x-')), /manifest/);
});

test('the planner continues on another node from a checkpoint pushed into its asset cache', async t => {
  const workspace = await interruptedWorkspace(t);
  const archive = await exportCheckpoint({ sessionId: SESSION, workspace });
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const assetCache = new AssetCache({ dir: await dir(t, 'planner-cache-') });
  await assetCache.put(sha256, Readable.from([archive]), archive.length);
  const temporaryRoot = await dir(t, 'planner-node-b-');
  let seen, settingsSeen;
  const worker = createPlannerWorker({ assetCache, temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json',
    runtime: async options => {
      seen = options;
      settingsSeen = JSON.parse(await readFile(options.settingsPath, 'utf8'));
      const session = path.join(options.env.CLAUDE_CONFIG_DIR, 'projects', projectDirName(options.cwd), `${SESSION}.jsonl`);
      assert.equal(await readFile(session, 'utf8'), '{"turn":1}\n');
      return output;
    } });
  const settings = { revision: '3', content: JSON.stringify({ model: 'task-model' }) };
  const result = await worker({ ...input, resume: { checkpoint: sha256 } }, { signal: new AbortController().signal, emit() {}, checkpoint() {}, settings });
  assert.equal(result.cases.length, 1);
  assert.equal(seen.resume, true); assert.equal(seen.sessionId, SESSION);
  assert.match(seen.prompt, /Continue that attempt/);
  assert.deepEqual(settingsSeen, { model: 'task-model' });
  assert.deepEqual(await readdir(temporaryRoot), []); // succeeded: nothing left behind
  // A checkpoint that is not (or no longer) in the cache fails cleanly and leaves no workspace.
  await assert.rejects(worker({ ...input, resume: { checkpoint: 'a'.repeat(64) } }, { signal: new AbortController().signal, emit() {} }), /no longer cached/);
  assert.deepEqual(await readdir(temporaryRoot), []);
});
