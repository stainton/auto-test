// tar.gz in and out of a directory, without a tar binary (process deployments include Windows). What a node
// hands back to its dispatcher — a planner session to continue elsewhere, a failed run's diagnostics — leaves as
// one of these, so the dispatcher can store it as-is and a person can open it with any archive tool.
// Only directories and regular files are written or read; symlinks (the workspace's node_modules link) are skipped.
import { gzipSync, gunzipSync } from 'node:zlib';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;
const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';

function header(name, { size = 0, type = '0', mode = 0o600, mtime = 0 }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100); block.write(octal(0, 8), 108); block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124); block.write(octal(Math.floor(mtime / 1000), 12), 136);
  block.fill(' ', 148, 156); block.write(type, 156);
  block.write('ustar\0', 257); block.write('00', 263);
  let sum = 0; for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148);
  return block;
}
const pad = size => Buffer.alloc((BLOCK - size % BLOCK) % BLOCK);
// Names that do not fit ustar's 100 ASCII bytes travel in a pax header, which every current tar reads.
function entry(name, options, data) {
  const parts = [];
  if (Buffer.byteLength(name) > 99 || !/^[\x20-\x7e]*$/.test(name)) {
    // A pax record starts with its own total length in decimal, those digits included.
    const rest = ` path=${name}\n`, restBytes = Buffer.byteLength(rest);
    let digits = 1;
    while (String(digits + restBytes).length !== digits) digits++;
    const body = Buffer.from(`${digits + restBytes}${rest}`);
    parts.push(header('PaxHeader', { size: body.length, type: 'x' }), body, pad(body.length));
  }
  parts.push(header(name.slice(0, 99), { ...options, size: data?.length ?? 0 }));
  if (data) parts.push(data, pad(data.length));
  return parts;
}

// skip(relative, isDirectory) leaves an entry (and everything under a skipped directory) out. Past maxBytes of
// file content the archive either fails (a checkpoint must be complete) or, with truncate, notes what it left out.
// When truncating, what fits is chosen by value rather than name order: deprioritize(relative) files go last, and
// within each group smaller files first, so a few small logs are never crowded out by thousands of large frames.
export async function packDirectory(root, { skip = () => false, maxBytes = 100 * 1024 * 1024, truncate = false, deprioritize = () => false } = {}) {
  const parts = [], omitted = [], items = [];
  async function walk(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${item.name}` : item.name, full = path.join(root, name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || skip(name, info.isDirectory())) continue;
      if (info.isDirectory()) { items.push({ name, info, directory: true }); await walk(name); continue; }
      if (info.isFile()) items.push({ name, full, info });
    }
  }
  await walk('');
  const files = items.filter(item => !item.directory);
  const order = truncate ? [...files].sort((a, b) => Number(deprioritize(a.name)) - Number(deprioritize(b.name)) || a.info.size - b.info.size) : files;
  const kept = new Set();
  let total = 0;
  for (const file of order) {
    if (total + file.info.size > maxBytes) {
      if (!truncate) throw new Error(`Archive of ${root} exceeds ${maxBytes} bytes`);
      omitted.push(file); continue;
    }
    total += file.info.size;
    kept.add(file);
  }
  for (const item of items) {
    if (item.directory) parts.push(...entry(`${item.name}/`, { type: '5', mode: 0o700, mtime: item.info.mtimeMs }));
    else if (kept.has(item)) parts.push(...entry(item.name, { mode: 0o600, mtime: item.info.mtimeMs }, await readFile(item.full)));
  }
  if (omitted.length) {
    const lines = omitted.sort((a, b) => a.name.localeCompare(b.name)).map(file => `${file.name} (${file.info.size} bytes)`);
    const note = Buffer.from(`Left out to stay within ${maxBytes} bytes:\n${lines.join('\n')}\n`);
    parts.push(...entry('OMITTED.txt', { mtime: Date.now() }, note));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

// The task's own agent configuration (it may carry a model token) is written into the workspace under this name.
export const TASK_SETTINGS_FILE = '.agent-settings.json';
// Never shipped from a workspace: credentials and configuration, the saved login, and the CLI's own config dir.
const SECRET = new Set([TASK_SETTINGS_FILE, '.credentials.json']);
export const isSecret = name => SECRET.has(path.posix.basename(name));

// A failed run's workspace as the dispatcher downloads it: scripts, errors, runtime logs and Playwright output,
// trimmed to a size a database row can hold rather than refused.
export function packDiagnostics(workspace, { maxBytes = 50 * 1024 * 1024 } = {}) {
  // Trace screencast frames (traces/resources/*.jpeg) run to thousands of files; they go in only after the logs fit.
  return packDirectory(workspace, { maxBytes, truncate: true, deprioritize: name => /(^|\/)traces\/resources\//.test(name),
    skip: name => isSecret(name) || ['claude-config', 'auth', 'node_modules'].includes(path.posix.basename(name)) });
}

// Extracts into dest. rename(relative) may move an entry (or return undefined to drop it). Absolute paths and
// any `..` are refused outright: the archive came over the network.
export async function unpackArchive(archive, dest, { rename = name => name, maxBytes = 200 * 1024 * 1024 } = {}) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: maxBytes + 1024 * 1024 }); }
  catch (error) { throw new Error(`Archive is not a readable tar.gz: ${error.message}`); }
  let offset = 0, longName, total = 0;
  const written = [];
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every(byte => byte === 0)) break;
    const field = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8), type = field(156, 1) || '0';
    const prefix = field(345, 155);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1]; continue; }
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type !== '0' && type !== '5') continue;
    name = name.replace(/\/+$/, '');
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`Archive entry has an unsafe path: ${name}`);
    const target = rename(name);
    if (!target) continue;
    const full = path.join(dest, target);
    if (type === '5') { await mkdir(full, { recursive: true, mode: 0o700 }); continue; }
    total += size;
    if (total > maxBytes) throw new Error(`Archive content exceeds ${maxBytes} bytes`);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, data, { mode: 0o600 });
    written.push(target);
  }
  return written;
}
