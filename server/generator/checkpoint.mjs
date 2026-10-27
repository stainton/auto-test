// Move only the Claude conversation for a timed-out generator case to another node.
// The browser and task settings are rebuilt from the new request; no credentials or diagnostics travel here.
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packDirectory, unpackArchive, isSecret } from '../shared/archive.mjs';
import { projectDirName } from '../planner/checkpoint.mjs';

const MANIFEST = 'checkpoint.json';
const SESSION_RE = /^[0-9a-f-]{36}$/;

export async function exportCheckpoint({ sessionId, workspace }) {
  await writeFile(path.join(workspace, MANIFEST), JSON.stringify({ format: 'auto-test-generator-checkpoint', version: 1, sessionId }), { mode: 0o600 });
  return packDirectory(workspace, { maxBytes: 150 * 1024 * 1024,
    skip: name => isSecret(name) || (name !== MANIFEST && name.split('/')[0] !== 'claude-config') });
}

export async function restoreCheckpoint(archive, workspace) {
  await unpackArchive(archive, workspace, { rename: name => name === MANIFEST || name.split('/')[0] === 'claude-config' ? name : undefined });
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(workspace, MANIFEST), 'utf8')); }
  catch { throw new Error('The generator checkpoint has no readable manifest'); }
  if (manifest?.format !== 'auto-test-generator-checkpoint' || manifest.version !== 1 || !SESSION_RE.test(manifest.sessionId ?? ''))
    throw new Error('The checkpoint is not a generator session this service can continue');
  const projects = path.join(workspace, 'claude-config', 'projects'), target = projectDirName(workspace);
  let found = false;
  for (const dir of await readdir(projects).catch(() => [])) {
    if (!(await readdir(path.join(projects, dir)).catch(() => [])).includes(`${manifest.sessionId}.jsonl`)) continue;
    if (dir !== target) await rename(path.join(projects, dir), path.join(projects, target));
    found = true; break;
  }
  if (!found) throw new Error('The checkpoint does not contain the interrupted generator conversation');
  return { sessionId: manifest.sessionId };
}
