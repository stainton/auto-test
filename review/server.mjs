// Test-case & requirement review server.
//
// A dependency-free local web app that covers both ends of the pipeline:
//   - write / edit requirement docs under docs/
//   - review / edit the planner's test plans under specs/, then approve them
//     (moving the plan + its companion *.cases.md into specs/approved/) so the
//     generator is allowed to run on them.
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
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.env.REVIEW_PORT || 4400);

const EDIT_ROOTS = [SPECS, DOCS]; // directories the client may read/write within

/** Resolve a client-supplied path, refusing anything outside the editable roots or non-.md. */
function safePath(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('missing path');
  const abs = path.resolve(ROOT, rel);
  const ok = EDIT_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!ok) throw new Error('path outside docs/ or specs/');
  if (!abs.endsWith('.md')) throw new Error('only .md files');
  return abs;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const slugify = (s) =>
  String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

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

async function listTree() {
  const requirements = await listDir(DOCS);
  const drafts = (await listDir(SPECS)).filter((p) => p !== 'specs/exploration-notes.md');
  const approved = await listDir(APPROVED);
  return { requirements, drafts, approved };
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

const REQUIREMENT_TEMPLATE = (title) => `# ${title}

- **Requirement id:** REQ-XXX
- **Status:** draft
- **Owner:**

## Background / problem

## Goal

## Scope
### In scope

### Out of scope

## Functional requirements
1.

## Acceptance criteria
1.

## Open questions
-
`;

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

    if (req.method === 'GET' && (url.pathname === '/api/tree' || url.pathname === '/api/plans')) {
      return send(res, 200, await listTree());
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      const abs = safePath(url.searchParams.get('path'));
      return send(res, 200, { path: rel(abs), content: await readFile(abs, 'utf8') });
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const { path: rp, content } = await readBody(req);
      const abs = safePath(rp);
      if (typeof content !== 'string') throw new Error('content must be a string');
      await writeFile(abs, content, 'utf8');
      return send(res, 200, { ok: true, path: rel(abs) });
    }

    if (req.method === 'POST' && url.pathname === '/api/new-requirement') {
      const { title } = await readBody(req);
      const slug = slugify(title);
      if (!slug) throw new Error('title required');
      await mkdir(DOCS, { recursive: true });
      const abs = path.join(DOCS, `${slug}.md`);
      const exists = await stat(abs).then(() => true, () => false);
      if (exists) throw new Error(`docs/${slug}.md already exists`);
      await writeFile(abs, REQUIREMENT_TEMPLATE(String(title).trim()), 'utf8');
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
  console.log(`Review app:  http://localhost:${PORT}`);
  console.log(`  requirements -> ${rel(DOCS)}/*.md`);
  console.log(`  plan drafts  -> ${rel(SPECS)}/*.md`);
  console.log(`  approved     -> ${rel(APPROVED)}/*.md  (generator input)`);
});
