import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpServer, createHttpHandler, createRoutedServer } from '../shared/http.mjs';
import { unpackArchive } from '../shared/archive.mjs';
import { validateInput, formatResult } from '../planner/contract.mjs';
import { input, output, eventually } from './fixtures.mjs';

const openapiPath = fileURLToPath(new URL('../planner/openapi.json', import.meta.url));
async function setup(t, worker, options = {}, jobOptions = {}) {
  const jobs = new Jobs({ worker, maxEvents: 3, ...jobOptions });
  const server = createHttpServer({ jobs, validateInput, openapiPath, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (url, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    ...init
  });
  const submit = (payload, query = '') => request(`/v1/planner/jobs${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { jobs, server, request, submit };
}
const blocked = (_input, { signal }) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('HTTP validation, async result and terminal SSE replay follow documented contract', async t => {
  const { request, submit, jobs } = await setup(t, async (_input, { emit }) => {
    for (let i = 0; i < 8; i++) emit({ stage: 'exploring', message: `Observed action ${i}` });
    return formatResult(output, input);
  });
  assert.equal((await request('/healthz')).status, 200);
  const preflight = await request('/v1/planner/jobs', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const spec = await (await request('/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.security, []);
  assert.equal(spec.components.securitySchemes, undefined);
  assert.equal((await submit({ ...input, target: { baseUrl: 'file:///tmp/a' } })).status, 400);
  assert.equal((await request('/v1/planner/jobs', { method: 'POST', body: '{}' })).status, 415);
  const response = await submit(input); assert.equal(response.status, 202);
  const job = await response.json(); const base = `/v1/planner/jobs/${job.id}`;
  assert.equal(response.headers.get('Location'), base);
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  assert.equal((await (await request(base)).json()).status, 'succeeded');
  assert.deepEqual(await (await request(`${base}/result`)).json(), formatResult(output, input));
  const events = await request(`${base}/events`);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const text = await events.text();
  assert.match(text, /event: snapshot/); assert.match(text, /event: reset/); assert.match(text, /"status":"succeeded"/);
  const lastId = jobs.get(job.id).lastEventId;
  const resumed = await (await request(`${base}/events?after=0`, { headers: { 'Last-Event-ID': String(lastId) } })).text();
  assert.match(resumed, /event: snapshot/); assert.doesNotMatch(resumed, /event: progress/);
  assert.equal((await request(`${base}/events?after=${lastId + 1}`)).status, 400);
});

test('running task supports live progress, drawer disconnection and cancellation', async t => {
  const { request, submit, jobs } = await setup(t, (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const job = await (await submit(input)).json(); const base = `/v1/planner/jobs/${job.id}`;
  await eventually(() => jobs.get(job.id).status === 'running');
  assert.equal((await request(`${base}/result`)).status, 409);
  const controller = new AbortController();
  const stream = await request(`${base}/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
  controller.abort();
  assert.equal(jobs.get(job.id).status, 'running');
  assert.equal((await request(base, { method: 'DELETE' })).status, 202);
  await eventually(() => jobs.get(job.id).status === 'cancelled');
  assert.equal((await (await request(base, { method: 'DELETE' })).json()).status, 'cancelled');
});

test('oversized body gets a structured 413', async t => {
  const { submit } = await setup(t, async () => formatResult(output, input), { maxBodyBytes: 128 });
  const response = await submit(input);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'BODY_TOO_LARGE');
});

// The planner resolves continueFrom while validating (only the job store knows whether the interrupted
// session is still there), so a rejection there must keep its own status instead of becoming a 400.
test('a request rejected by the input resolver keeps its status code', async t => {
  const { submit } = await setup(t, async () => formatResult(output, input), {
    validateInput: payload => {
      const value = validateInput(payload);
      if (value.continueFrom) throw new ServiceError(409, 'NOT_CONTINUABLE', 'This planner task cannot be continued; start a new one');
      return value;
    }
  });
  const conflict = await submit({ ...input, continueFrom: '4f2a6b1c-8e3d-4a5b-9c7d-1e2f3a4b5c6d' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'NOT_CONTINUABLE');
  const bad = await submit({ ...input, requirements: [] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
});

test('the configuration CaseHub sends is applied before the work starts, on jobs and sync routes alike', async t => {
  const applied = [];
  const applySettings = async settings => {
    if (settings.content.includes('broken')) throw Object.assign(new Error('Claude settings file contains invalid JSON'), { invalidSettings: true });
    if (settings.content.includes('readonly')) throw new Error('EACCES: permission denied');
    applied.push(settings);
  };
  const { request, submit, jobs } = await setup(t, async () => formatResult(output, input), {
    applySettings, validateSimplifyInput: payload => payload, simplify: async () => ({ ok: true })
  });
  const settings = { revision: '12', content: JSON.stringify({ model: 'from-casehub' }) };
  const job = await (await submit({ ...input, agentSettings: settings })).json();
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  const simplify = url => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSettings: settings }) });
  assert.equal((await simplify('/v1/planner/simplify')).status, 200);
  assert.deepEqual(applied, [settings, settings]); // agentSettings never reaches a workflow's own contract.
  // A rejected request leaves the configuration alone; the sender's fault and ours map to different codes.
  assert.equal((await submit({ ...input, agentSettings: { revision: '13' } })).status, 400);
  assert.equal((await submit({ ...input, target: {}, agentSettings: { ...settings, revision: '13' } })).status, 400);
  const invalid = await submit({ ...input, agentSettings: { revision: '13', content: 'broken' } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_AGENT_SETTINGS');
  const failed = await submit({ ...input, agentSettings: { revision: '13', content: 'readonly' } });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'AGENT_SETTINGS_FAILED');
  assert.equal(applied.length, 2);
});

test('assets pushed by CaseHub are cached by hash, verified, and only then usable by a task', async t => {
  const { createHash } = await import('node:crypto');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'planner-asset-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { AssetCache } = await import('../shared/assets.mjs');
  const assetCache = new AssetCache({ dir: cacheDir });
  const { request } = await setup(t, async () => formatResult(output, input), { assetCache });
  const bytes = Buffer.from('not really a png'), sha = createHash('sha256').update(bytes).digest('hex');
  const put = (name, body, headers = {}) => request(`/v1/planner/assets/${name}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
  assert.equal((await request(`/v1/planner/assets/${sha}`, { method: 'HEAD' })).status, 404);
  assert.equal((await put(sha, bytes)).status, 201);
  assert.equal((await request(`/v1/planner/assets/${sha}`, { method: 'HEAD' })).status, 200);
  assert.deepEqual(await readFile(assetCache.path(sha)), bytes);
  // Wrong bytes for a hash are refused and leave nothing behind.
  const other = 'b'.repeat(64);
  const bad = await put(other, bytes);
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, 'INVALID_ASSET');
  assert.equal((await request(`/v1/planner/assets/${other}`, { method: 'HEAD' })).status, 404);
  assert.equal((await put('not-a-hash', bytes)).status, 404);
  const staged = await assetCache.stage({ id: 'a1', name: '../../etc/示例 图.png', sha256: sha }, path.join(cacheDir, 'ws'));
  assert.equal(path.dirname(staged), path.join(cacheDir, 'ws'));
  assert.deepEqual(await readFile(staged), bytes);
  await assert.rejects(assetCache.stage({ id: 'a2', name: 'x.png', sha256: other }, path.join(cacheDir, 'ws')), /no longer cached/);
});

test('a dispatcher can read capacity and ask for an idle slot only (429 when busy)', async t => {
  const { request, submit, jobs } = await setup(t, blocked);
  assert.deepEqual(await (await request('/v1/planner/capacity')).json(),
    { kind: 'planner', concurrency: 1, running: 0, queued: 0, reserved: 0, available: 1, accepting: true });
  const first = await submit(input, '?queue=false');
  assert.equal(first.status, 202);
  const busy = await submit(input, '?queue=false');
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'BUSY');
  assert.equal((await submit(input)).status, 202); // without the flag the task queues as before
  const capacity = await (await request('/v1/planner/capacity')).json();
  assert.equal(capacity.running + capacity.queued, 2); assert.equal(capacity.available, 0);
  // A request refused during validation gives its reservation back.
  await jobs.close();
});

test('a validation failure gives the reserved slot back', async t => {
  const { request, submit } = await setup(t, async () => formatResult(output, input));
  assert.equal((await submit({ ...input, requirements: [] }, '?queue=false')).status, 400);
  assert.equal((await (await request('/v1/planner/capacity')).json()).reserved, 0);
  assert.equal((await submit(input, '?queue=false')).status, 202);
});

test('the dispatcher releases a finished job once it has its result', async t => {
  const { request, submit, jobs } = await setup(t, async () => formatResult(output, input));
  const job = await (await submit(input)).json(); const base = `/v1/planner/jobs/${job.id}`;
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  assert.equal((await request(`${base}/release`)).status, 405);
  assert.deepEqual(await (await request(`${base}/release`, { method: 'POST' })).json(), { id: job.id, released: true });
  const gone = await request(base);
  assert.equal(gone.status, 404); assert.equal((await gone.json()).error.code, 'JOB_NOT_FOUND');
});

test('an unfinished job is neither released nor downloadable', async t => {
  const { request, submit, jobs } = await setup(t, blocked);
  const job = await (await submit(input)).json(); const base = `/v1/planner/jobs/${job.id}`;
  await eventually(() => jobs.get(job.id).status === 'running');
  assert.equal((await request(`${base}/release`, { method: 'POST' })).status, 409);
  assert.equal((await request(`${base}/diagnostics`)).status, 409);
  assert.equal((await request(`${base}/checkpoint`)).status, 409);
});

test('an interrupted session downloads as a checkpoint archive with its hash', async t => {
  const session = { sessionId: '4f2a6b1c-8e3d-4a5b-9c7d-1e2f3a4b5c6d', workspace: '/tmp/planner-x' };
  let packed;
  const { request, submit, jobs } = await setup(t, async (_input, { checkpoint }) => { checkpoint(session); throw new Error('time limit'); },
    { exportCheckpoint: async state => { packed = state; return Buffer.from('archive-bytes'); } });
  const job = await (await submit(input)).json();
  await eventually(() => jobs.get(job.id).status === 'failed');
  const response = await request(`/v1/planner/jobs/${job.id}/checkpoint`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('x-content-sha256'), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(packed, session);
  // Claimed on this node, the session is no longer on offer as a checkpoint either.
  jobs.claimContinuation(job.id);
  assert.equal((await request(`/v1/planner/jobs/${job.id}/checkpoint`)).status, 409);
});

test('a failed run\'s diagnostics download without secrets, the saved login or the CLI config', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'http-diagnostics-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const [file, text] of [['failure.json', '{"message":"boom"}'], ['diagnostics/TC-1/1/runtime.jsonl', '{}'],
    ['.agent-settings.json', '{"env":{"ANTHROPIC_API_KEY":"secret"}}'], ['claude-config/.credentials.json', 'secret'],
    ['claude-config/projects/x/s.jsonl', 'session'], ['auth/auth-state.json', 'cookie']]) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const { request, submit, jobs } = await setup(t, async (_input, { retain }) => { retain({ workspace }); throw new Error('blocked'); });
  const job = await (await submit(input)).json();
  await eventually(() => jobs.get(job.id).status === 'failed');
  assert.equal((await (await request(`/v1/planner/jobs/${job.id}`)).json()).diagnostics, true);
  const response = await request(`/v1/planner/jobs/${job.id}/diagnostics`);
  assert.equal(response.status, 200);
  const out = await mkdtemp(path.join(tmpdir(), 'http-diagnostics-out-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  assert.deepEqual((await unpackArchive(Buffer.from(await response.arrayBuffer()), out)).sort(),
    ['diagnostics/TC-1/1/runtime.jsonl', 'failure.json']);
  const none = await setup(t, async () => formatResult(output, input));
  const done = await (await none.submit(input)).json();
  await eventually(() => none.jobs.get(done.id).status === 'succeeded');
  const missing = await none.request(`/v1/planner/jobs/${done.id}/diagnostics`);
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'DIAGNOSTICS_UNAVAILABLE');
});

test('a draining node stays alive, turns unready, refuses work and still serves finished results', async t => {
  let finish;
  const jobs = new Jobs({ worker: () => new Promise(resolve => { finish = () => resolve(formatResult(output, input)); }) });
  const server = createRoutedServer([{ jobs, handler: createHttpHandler({ jobs, validateInput, openapiPath }) }]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const port = server.address().port, request = (url, init) => fetch(`http://127.0.0.1:${port}${url}`, init);
  const submit = () => request('/v1/planner/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const job = await (await submit()).json();
  await eventually(() => jobs.get(job.id).status === 'running');
  const drained = server.drain({ drainTimeoutMs: 60000, holdMs: 60000 });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/readyz')).status, 503);
  assert.equal((await request('/v1/planner/capacity').then(r => r.json())).accepting, false);
  const refused = await submit();
  assert.equal(refused.status, 503); assert.equal((await refused.json()).error.code, 'SHUTTING_DOWN');
  finish();
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  assert.deepEqual(await (await request(`/v1/planner/jobs/${job.id}/result`)).json(), formatResult(output, input));
  await request(`/v1/planner/jobs/${job.id}/release`, { method: 'POST' });
  await drained; // released, so the node closes without waiting out holdMs
  await assert.rejects(request('/healthz'));
});
