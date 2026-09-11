import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeSettings } from '../../server/runtime/settings.mjs';

export async function installSettings(sourceDir, destination) {
  const source = path.join(sourceDir, 'setting.json');
  let exists = true;
  try { await access(source); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  const settings = exists ? await readClaudeSettings(source) : {};
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDir, destination] = process.argv.slice(2);
  if (!sourceDir || !destination) throw new Error('Usage: install-settings.mjs SOURCE_DIR DESTINATION');
  await installSettings(sourceDir, destination);
}
