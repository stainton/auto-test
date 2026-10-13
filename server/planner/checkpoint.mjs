// An interrupted planner run, moved between nodes. The node that ran it packs the Claude session it kept
// (exportCheckpoint, served at GET .../jobs/<id>/checkpoint); the dispatcher stores the archive and, to continue,
// pushes it to any node like an asset (PUT .../assets/<sha256>) and submits continueFrom: { checkpoint: <sha256> }.
// That node unpacks it into a fresh workspace (restoreCheckpoint) and resumes the same conversation.
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packDirectory, unpackArchive, isSecret } from '../shared/archive.mjs';

export const CHECKPOINT_FORMAT = 'auto-test-planner-checkpoint';
const MANIFEST = 'checkpoint.json', CONFIG = 'claude-config';
const SESSION_RE = /^[0-9a-f-]{36}$/;
// The CLI keeps a conversation at <CLAUDE_CONFIG_DIR>/projects/<cwd with each non-alphanumeric character as '-'>/<session>.jsonl,
// so a session restored into a workspace at another path must move to that path's directory to be found by --resume.
export const projectDirName = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Only the session travels: the browser, page config and seed are rebuilt by the continuing run.
export async function exportCheckpoint({ sessionId, workspace }) {
  await writeFile(path.join(workspace, MANIFEST), JSON.stringify({ format: CHECKPOINT_FORMAT, version: 1, sessionId }), { mode: 0o600 });
  return packDirectory(workspace, { maxBytes: 150 * 1024 * 1024,
    skip: name => isSecret(name) || (name !== MANIFEST && name.split('/')[0] !== CONFIG) });
}

export async function restoreCheckpoint(archive, workspace) {
  await unpackArchive(archive, workspace, { rename: name => name === MANIFEST || name.split('/')[0] === CONFIG ? name : undefined });
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(workspace, MANIFEST), 'utf8')); }
  catch { throw new Error('The checkpoint has no readable manifest'); }
  if (manifest?.format !== CHECKPOINT_FORMAT || manifest.version !== 1 || !SESSION_RE.test(manifest.sessionId ?? ''))
    throw new Error('The checkpoint is not a planner session this service can continue');
  const projects = path.join(workspace, CONFIG, 'projects'), target = projectDirName(workspace);
  let found = false;
  for (const dir of await readdir(projects).catch(() => [])) {
    if (!(await readdir(path.join(projects, dir)).catch(() => [])).includes(`${manifest.sessionId}.jsonl`)) continue;
    if (dir !== target) await rename(path.join(projects, dir), path.join(projects, target));
    found = true; break;
  }
  if (!found) throw new Error('The checkpoint does not contain the interrupted conversation');
  return { sessionId: manifest.sessionId };
}
