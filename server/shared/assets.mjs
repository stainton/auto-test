import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

// CaseHub pushes the files a task needs to the service (PUT .../assets/<sha256>) before it submits the
// task; the task then only references them. The service never reaches back to CaseHub, so it needs no
// address, credentials or database access of its own. Files are content-addressed: pushing the same file
// twice is a no-op, and a task can only name a file whose bytes were verified against its hash.
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export class AssetCache {
  constructor({ dir, maxBytes = 2 * 1024 * 1024 * 1024 }) { this.dir = dir; this.maxBytes = maxBytes; }
  path(sha) { return path.join(this.dir, sha); }
  async has(sha) {
    try { const now = new Date(); await utimes(this.path(sha), now, now); return true; } // touched: recently used
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  // Streams the request body to disk, hashing as it goes; nothing is kept unless size and hash both match.
  async put(sha, stream, size) {
    await mkdir(this.dir, { recursive: true });
    const temporary = path.join(this.dir, `.${randomUUID()}.tmp`), hash = createHash('sha256');
    let received = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = createWriteStream(temporary, { mode: 0o600 });
        out.on('error', reject); out.on('finish', resolve);
        stream.on('error', reject);
        stream.on('data', chunk => {
          received += chunk.length;
          if (received > size || received > MAX_ASSET_BYTES) return reject(new Error('Asset is larger than declared'));
          hash.update(chunk);
        });
        stream.pipe(out);
      });
      if (received !== size) throw new Error('Asset is smaller than declared');
      if (hash.digest('hex') !== sha) throw new Error('Asset content does not match its sha256');
      await rename(temporary, this.path(sha));
    } finally { await rm(temporary, { force: true }); }
    await this.prune(sha);
  }
  // Oldest-used files go first once the cache outgrows its budget; the file just written never does.
  async prune(keep) {
    const entries = [];
    for (const name of await readdir(this.dir)) {
      if (!SHA256_RE.test(name)) continue;
      const info = await stat(path.join(this.dir, name));
      entries.push({ name, size: info.size, used: info.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total <= this.maxBytes) break;
      if (entry.name === keep) continue;
      await rm(path.join(this.dir, entry.name), { force: true }); total -= entry.size;
    }
  }
  // A task's own copy, named for the person's file, inside the directory the browser tools may read.
  async stage(asset, directory) {
    await mkdir(directory, { recursive: true });
    const safe = path.basename(asset.name).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80) || 'asset';
    const target = path.join(directory, `${asset.id.replace(/[^\w-]/g, '_')}-${safe}`);
    try { await copyFile(this.path(asset.sha256), target); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Asset ${asset.name} is no longer cached on this service; submit the task again`);
      throw error;
    }
    return target;
  }
}
