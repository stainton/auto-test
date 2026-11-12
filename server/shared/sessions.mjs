import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Preserve original conversations, including subagents, without exporting CLI settings or credentials.
// This is an explicit diagnostic download, not a public progress event: task data remains verbatim.
export async function sessionFiles(job) {
  const workspace = job.artifacts?.workspace ?? job.continuation?.workspace;
  if (!workspace) return { type: 'claude_sessions', files: [] };
  const root = path.join(workspace, 'claude-config', 'projects');
  const files = [];
  async function walk(relative) {
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: `claude-config/projects/${name}`, content: await readFile(path.join(root, name), 'utf8') });
      }
    }
  }
  await walk('');
  return { type: 'claude_sessions', files };
}
