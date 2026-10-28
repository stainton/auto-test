// Carry only verified exploration notes for a timed-out generator case to another node.
// The browser and task settings are rebuilt from the new request; no transcript or credentials travel here.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packDirectory, unpackArchive, isSecret } from '../shared/archive.mjs';

const MANIFEST = 'checkpoint.json';
const NOTES = 'resume-notes.json';

export async function exportCheckpoint({ workspace }) {
  await writeFile(path.join(workspace, MANIFEST), JSON.stringify({ format: 'auto-test-generator-checkpoint', version: 2 }), { mode: 0o600 });
  return packDirectory(workspace, { maxBytes: 1024 * 1024,
    skip: name => isSecret(name) || ![MANIFEST, NOTES].includes(name) });
}

export async function restoreCheckpoint(archive, workspace) {
  await unpackArchive(archive, workspace, { rename: name => [MANIFEST, NOTES].includes(name) ? name : undefined });
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(workspace, MANIFEST), 'utf8')); }
  catch { throw new Error('The generator checkpoint has no readable manifest'); }
  if (manifest?.format !== 'auto-test-generator-checkpoint' || manifest.version !== 2)
    throw new Error('The checkpoint is not a generator notes archive this service can continue');
  const notes = await readFile(path.join(workspace, NOTES), 'utf8').then(JSON.parse).catch(() => ({}));
  if (notes.explorationNotes !== undefined && (typeof notes.explorationNotes !== 'string' || notes.explorationNotes.length > 12000))
    throw new Error('The checkpoint has invalid exploration notes');
  return { explorationNotes: notes.explorationNotes ?? '' };
}
