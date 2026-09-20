import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { validateInput, formatResult } from '../planner/contract.mjs';
import { input, output, eventually } from './fixtures.mjs';

async function setup(t, worker, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-http-test-'));
  const jobs = new Jobs({ dataDir, worker, maxEvents: 3 });
  const server = createHttpServer({ jobs, validateInput,
    openapiPath: fileURLToPath(new URL('../planner/openapi.json', import.meta.url)), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    ...init
  });
  const submit = payload => request('/v1/planner/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { jobs, server, request, submit };
}

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
