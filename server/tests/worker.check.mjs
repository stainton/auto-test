import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlannerWorker } from '../planner/worker.mjs';
import { input, output } from './fixtures.mjs';

async function setup(t, runtime) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'planner-worker-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, worker: createPlannerWorker({ runtime, temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json' }) };
}
function browserSetup(options) {
  options.onMessage({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright-test', status: 'connected' }] });
  options.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'setup-1', name: 'mcp__playwright-test__planner_setup_page', input: { seedFile: 'seed.spec.ts' } }] } });
  options.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'setup-1', content: 'Ready' }] } });
}

test('uses caller input, isolated config, direct MCP tools, progress and strict structured output', async t => {
  const events = [];
  const { worker, temporaryRoot } = await setup(t, async options => {
    const prompt = JSON.parse(options.prompt);
    assert.deepEqual(prompt.requirements, input.requirements);
    assert.equal(prompt.context.explorationNotes, input.context.explorationNotes);
    assert.equal(prompt.target.storageState, undefined);
    assert.deepEqual(options.allowedTools, ['mcp__playwright-test__*']);
    assert.ok(options.disallowedTools.includes('mcp__playwright-test__generator_write_test'));
    assert.ok(options.mcpConfig.mcpServers['playwright-test'].args.includes('run-test-mcp-server'));
    // A fresh run opens its own session, kept inside the workspace so nothing outlives it.
    assert.match(options.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(options.resume, false);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(options.cwd, 'claude-config'));
    assert.ok(!options.mcpConfig.mcpServers['playwright-test'].args.some(arg => arg.includes('mcp-filter')));
    const config = await readFile(path.join(options.cwd, 'playwright.config.cjs'), 'utf8');
    assert.match(config, /example.test\/login/);
    assert.match(config, /"headless":true/);
    assert.match(await readFile(path.join(options.cwd, 'seed.spec.ts'), 'utf8'), /page.goto/);
    browserSetup(options);
    options.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'PLANNER_PROGRESS {"stage":"exploring","message":"super-secret-password"}\nPLANNER_PROGRESS invalid' }] } });
    return output;
  });
  const result = await worker(input, { signal: new AbortController().signal, emit: event => events.push(event) });
  assert.equal(result.cases[0].request, 'REQ-001');
  assert.ok(events.some(e => e.toolStatus === 'completed'));
  assert.ok(events.some(e => e.message === 'super-secret-password'));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('rejects fabricated completion without successful browser setup and keeps the session for a continuation', async t => {
  const { worker, temporaryRoot } = await setup(t, async () => output);
  let checkpoint;
  await assert.rejects(worker(input, { signal: new AbortController().signal, emit() {}, checkpoint: state => { checkpoint = state; } }), /initialize/);
  assert.deepEqual(await readdir(temporaryRoot), [path.basename(checkpoint.workspace)]);
  assert.match(checkpoint.sessionId, /^[0-9a-f-]{36}$/);
});

test('a cancelled run keeps nothing to continue', async t => {
  const controller = new AbortController();
  const { worker, temporaryRoot } = await setup(t, async options => {
    browserSetup(options);
    controller.abort(Object.assign(new Error('Planner task cancelled'), { code: 'JOB_CANCELLED' }));
    return output;
  });
  const checkpoints = [];
  await assert.rejects(worker(input, { signal: controller.signal, emit() {}, checkpoint: state => checkpoints.push(state) }));
  assert.equal(checkpoints.at(-1), null);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('a successful run leaves no session or workspace behind', async t => {
  const { worker, temporaryRoot } = await setup(t, async options => { browserSetup(options); return output; });
  const checkpoints = [];
  await worker(input, { signal: new AbortController().signal, emit() {}, checkpoint: state => checkpoints.push(state) });
  assert.equal(checkpoints.at(-1), null);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('continues an interrupted run in its own session instead of exploring again', async t => {
  // First run: interrupted before it returned anything, so its session stays for a continuation.
  const { worker, temporaryRoot } = await setup(t, async () => { throw new Error('Planner task exceeded its time limit'); });
  let checkpoint;
  await assert.rejects(worker(input, { signal: new AbortController().signal, emit() {}, checkpoint: state => { checkpoint = state; } }), /time limit/);

  let resumedOptions;
  const continuation = createPlannerWorker({ temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json',
    runtime: async options => { resumedOptions = options; return output; } });
  const events = [];
  // No planner_setup_page in this run: a continuation may finish from what the first run already explored.
  const result = await continuation({ ...input, resume: checkpoint },
    { signal: new AbortController().signal, emit: event => events.push(event), checkpoint() {} });
  assert.equal(result.cases.length, 1);
  assert.equal(resumedOptions.resume, true);
  assert.equal(resumedOptions.sessionId, checkpoint.sessionId);
  assert.equal(resumedOptions.cwd, checkpoint.workspace);
  assert.equal(resumedOptions.env.CLAUDE_CONFIG_DIR, path.join(checkpoint.workspace, 'claude-config'));
  assert.match(resumedOptions.prompt, /Continue that attempt/);
  assert.match(resumedOptions.prompt, /"REQ-001"/); // the request itself is repeated unchanged
  assert.ok(events.some(e => /Reopening the interrupted session/.test(e.message)));
  assert.deepEqual(await readdir(temporaryRoot), []); // the continuation succeeded, so the session is gone
});

test('attached assets are copied into the workspace and the model is given their local paths', async t => {
  const { createHash } = await import('node:crypto');
  const { AssetCache } = await import('../shared/assets.mjs');
  const { Readable } = await import('node:stream');
  const dir = await mkdtemp(path.join(tmpdir(), 'planner-worker-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assetCache = new AssetCache({ dir });
  const bytes = Buffer.from('picture'), sha256 = createHash('sha256').update(bytes).digest('hex');
  await assetCache.put(sha256, Readable.from([bytes]), bytes.length);
  const asset = { id: 'a1', name: '头像.png', type: 'image', mimeType: 'image/png', sha256, size: bytes.length };
  let seen;
  const worker = createPlannerWorker({ assetCache, runtime: async options => {
    seen = JSON.parse(options.prompt).context.assets[0];
    assert.deepEqual(await readFile(seen.path), bytes);
    assert.ok(seen.path.startsWith(options.cwd));
    throw new Error('stop after inspecting the prompt');
  } });
  await assert.rejects(worker({ ...input, context: { assets: [asset] } }, { signal: new AbortController().signal, emit() {} }), /stop after/);
  assert.equal(seen.name, '头像.png');
  await assert.rejects(createPlannerWorker({ runtime: async () => {} })({ ...input, context: { assets: [asset] } }, { signal: new AbortController().signal, emit() {} }), /no asset cache/);
});
