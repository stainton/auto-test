// Test-case review server.
//
// A dependency-free local web app for reviewing planner output before it is fed
// to the generator. It lists the markdown plans under specs/, renders and lets
// you edit them in place, and gates the generator by moving an approved plan
// (and its companion *.cases.md) into specs/approved/.
//
// Run: npm run review   (then open http://localhost:4400)

import http from 'node:http';
import { readFile, writeFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPECS = path.join(ROOT, 'specs');
const APPROVED = path.join(SPECS, 'approved');
const PORT = Number(process.env.REVIEW_PORT || 4400);

/** Resolve a client-supplied path and refuse anything outside specs/ or non-.md. */
function safeSpecPath(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('missing path');
  const abs = path.resolve(ROOT, rel);
  if (abs !== SPECS && !abs.startsWith(SPECS + path.sep)) throw new Error('path escapes specs/');
  if (!abs.endsWith('.md')) throw new Error('only .md files');
  return abs;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

async function listDir(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => rel(path.join(dir, e.name)))
    .sort();
}

async function listPlans() {
  const drafts = (await listDir(SPECS)).filter((p) => p !== 'specs/exploration-notes.md');
  const approved = await listDir(APPROVED);
  return { drafts, approved };
}

/** Base name of a plan, ignoring the `.cases` companion suffix. */
const planKey = (p) => path.basename(p).replace(/\.cases\.md$/, '').replace(/\.md$/, '');

async function movePlanSet(fromDir, toDir, key) {
  await mkdir(toDir, { recursive: true });
  const moved = [];
  for (const name of [`${key}.md`, `${key}.cases.md`]) {
    const src = path.join(fromDir, name);
    try {
      await stat(src);
    } catch {
      continue;
    }
    await rename(src, path.join(toDir, name));
    moved.push(name);
  }
  if (moved.length === 0) throw new Error(`no files found for "${key}"`);
  return moved;
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/plans') {
      return send(res, 200, await listPlans());
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      const abs = safeSpecPath(url.searchParams.get('path'));
      return send(res, 200, { path: rel(abs), content: await readFile(abs, 'utf8') });
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const { path: rp, content } = await readBody(req);
      const abs = safeSpecPath(rp);
      if (typeof content !== 'string') throw new Error('content must be a string');
      await writeFile(abs, content, 'utf8');
      return send(res, 200, { ok: true, path: rel(abs) });
    }

    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const { name } = await readBody(req);
      const moved = await movePlanSet(SPECS, APPROVED, planKey(String(name || '')));
      return send(res, 200, { ok: true, moved });
    }

    if (req.method === 'POST' && url.pathname === '/api/unapprove') {
      const { name } = await readBody(req);
      const moved = await movePlanSet(APPROVED, SPECS, planKey(String(name || '')));
      return send(res, 200, { ok: true, moved });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Test-case review app:  http://localhost:${PORT}`);
  console.log(`  drafts   -> ${rel(SPECS)}/*.md`);
  console.log(`  approved -> ${rel(APPROVED)}/*.md  (generator input)`);
});
