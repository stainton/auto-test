import test from 'node:test';
import assert from 'node:assert/strict';
import { Jobs } from '../shared/jobs.mjs';
import { formatResult } from '../planner/contract.mjs';
import { input, output, eventually } from './fixtures.mjs';

async function make(t, worker, options = {}) {
  const jobs = new Jobs({ worker, ...options });
  t.after(() => jobs.close());
  return jobs;
}
const blocked = (_input, { signal }) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('serializes queued jobs, cancels queued/running work and frees capacity', async t => {
  let calls = 0;
  const jobs = await make(t, async (...args) => { calls++; return blocked(...args); });
  const first = jobs.submit(input), second = jobs.submit(input);
  await eventually(() => jobs.get(first.id).status === 'running');
  assert.equal(jobs.get(second.id).status, 'queued');
  jobs.cancel(second.id); jobs.cancel(first.id);
  await eventually(() => jobs.get(first.id).status === 'cancelled');
  assert.equal(jobs.get(second.id).status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(jobs.get(first.id).error.code, 'JOB_CANCELLED');
});

test('times out actual worker and rejects late success', async t => {
  let aborted = false;
  const jobs = await make(t, async (_input, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return formatResult(output, input);
  }, { timeoutMs: 20 });
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'failed');
  assert.equal(aborted, true);
  assert.equal(jobs.get(job.id).error.code, 'JOB_TIMEOUT');
  assert.equal(jobs.get(job.id).result, undefined);
});

test('a per-job timeout from the caller replaces the server default', async t => {
  let aborted = false;
  const jobs = await make(t, async (_input, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return formatResult(output, input);
  }, { timeoutMs: 600000, timeoutFor: job => job.timeoutMs });
  const job = jobs.submit({ ...input, timeoutMs: 20 });
  await eventually(() => jobs.get(job.id).status === 'failed');
  assert.equal(aborted, true);
  assert.equal(jobs.get(job.id).error.code, 'JOB_TIMEOUT');
  assert.equal(jobs.get(job.id).timeoutMs, 20); // the limit actually used is visible on the job
});

test('an interrupted job is continuable once, then releases its session when pruned', async t => {
  const discarded = [];
  const session = { sessionId: 'session-1', workspace: '/tmp/planner-abc' };
  const jobs = await make(t, async (_input, { checkpoint }) => { checkpoint(session); throw new Error('Planner runtime failed'); },
    { discard: state => discarded.push(state) });
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'failed');
  // The caller only learns that continuing is on offer; the session's location stays on the server.
  const summary = jobs.summary(jobs.get(job.id));
  assert.equal(summary.continuable, true);
  assert.equal(summary.continuation, undefined);
  assert.deepEqual(jobs.claimContinuation(job.id), session);
  assert.equal(jobs.summary(jobs.get(job.id)).continuable, undefined);
  assert.ok(jobs.get(job.id).continuedAt);
  assert.throws(() => jobs.claimContinuation(job.id), /cannot be continued/);
  const record = jobs.get(job.id);
  record.finishedAt = new Date(Date.now() - 86400001).toISOString();
  record.continuation = session; // a continuation nobody claimed ages out together with the job
  jobs.prune();
  assert.deepEqual(discarded, [session]);
});

test('a succeeded or cancelled job offers no continuation', async t => {
  const jobs = await make(t, async (_input, { signal, checkpoint }) => {
    checkpoint({ sessionId: 'session-2', workspace: '/tmp/planner-def' });
    if (signal.aborted) throw signal.reason;
    checkpoint(null);
    return formatResult(output, input);
  });
  const done = jobs.submit(input);
  await eventually(() => jobs.get(done.id).status === 'succeeded');
  assert.equal(jobs.summary(jobs.get(done.id)).continuable, undefined);
  assert.throws(() => jobs.claimContinuation(done.id), /cannot be continued/);
});

test('bounds progress in memory and holds the result until the dispatcher releases the job', async t => {
  const discarded = [];
  const jobs = await make(t, async (_input, { emit, retain }) => {
    for (let i = 0; i < 8; i++) emit({ stage: 'exploring', message: `Action ${i}` });
    retain({ workspace: '/tmp/generator-kept' });
    return formatResult(output, input);
  }, { maxEvents: 3, discard: value => discarded.push(value) });
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  assert.equal(jobs.get(job.id).events.length, 3);
  assert.deepEqual(jobs.get(job.id).result, formatResult(output, input));
  assert.deepEqual(jobs.release(job.id), { id: job.id, released: true });
  assert.deepEqual(discarded, [{ workspace: '/tmp/generator-kept' }]);
  assert.throws(() => jobs.get(job.id), error => error.status === 404 && error.code === 'JOB_NOT_FOUND');
});

test('an unfinished job cannot be released', async t => {
  const jobs = await make(t, blocked);
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'running');
  assert.throws(() => jobs.release(job.id), error => error.status === 409 && error.code === 'JOB_ACTIVE');
});

test('maxJobs bounds unfinished work only; finished jobs expire by age and by count', async t => {
  const jobs = await make(t, async () => formatResult(output, input), { maxJobs: 1, retentionMs: 50, maxRetained: 2 });
  const job = jobs.submit(input);
  assert.throws(() => jobs.submit(input), error => error.status === 503 && error.code === 'CAPACITY_EXCEEDED');
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  jobs.get(job.id).finishedAt = new Date(Date.now() - 100).toISOString();
  assert.throws(() => jobs.get(job.id), error => error.status === 404);
  // Results nobody collects never refuse new work: the oldest beyond maxRetained are dropped instead.
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const next = jobs.submit(input); ids.push(next.id);
    await eventually(() => jobs.get(next.id).status === 'succeeded');
  }
  jobs.prune();
  assert.deepEqual(ids.map(id => jobs.jobs.has(id)), [false, false, true, true]);
});

test('reports capacity and refuses work without an idle slot when the caller asks not to queue', async t => {
  const jobs = await make(t, blocked, { concurrency: 1 });
  assert.deepEqual(jobs.capacity(), { kind: 'planner', concurrency: 1, running: 0, queued: 0, reserved: 0, available: 1, accepting: true });
  // A reservation held during validation already takes the slot, so a concurrent request cannot get it too.
  const reservation = jobs.reserve({ queue: false });
  assert.equal(jobs.capacity().available, 0);
  assert.throws(() => jobs.reserve({ queue: false }), error => error.status === 429 && error.code === 'BUSY');
  const job = jobs.submit(input, { reservation });
  await eventually(() => jobs.get(job.id).status === 'running');
  assert.deepEqual({ ...jobs.capacity(), kind: undefined }, { kind: undefined, concurrency: 1, running: 1, queued: 0, reserved: 0, available: 0, accepting: true });
  assert.throws(() => jobs.reserve({ queue: false }), error => error.status === 429);
  const queued = jobs.submit(input); // the default still queues behind running work
  assert.equal(jobs.get(queued.id).status, 'queued');
  // A reservation given back without a job frees its place.
  const released = jobs.reserve(); released(); released();
  assert.equal(jobs.capacity().reserved, 0);
});

test('hands the configuration a job was submitted with to its worker', async t => {
  let seen;
  const jobs = await make(t, async (_input, { settings }) => { seen = settings; return formatResult(output, input); });
  const settings = { revision: '7', content: '{"model":"m"}' };
  const job = jobs.submit(input, { settings });
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  assert.deepEqual(seen, settings);
});

test('diagnostic artifacts are announced, never their location, and go when the job is released', async t => {
  const discarded = [];
  const artifacts = { workspace: '/tmp/generator-diagnostic-fixture' };
  const jobs = await make(t, async (_input, { retain }) => { retain(artifacts); throw new Error('validation failed'); },
    { discard: value => discarded.push(value) });
  const submitted = jobs.submit(input);
  await eventually(() => jobs.get(submitted.id).status === 'failed');
  const summary = jobs.summary(jobs.get(submitted.id));
  assert.equal(summary.diagnostics, true);
  assert.equal(summary.artifacts, undefined);
  assert.equal(summary.continuable, undefined);
  jobs.release(submitted.id);
  assert.deepEqual(discarded, [artifacts]);
});

test('draining hands queued work back, lets running work finish, and takes nothing new', async t => {
  let finish;
  const jobs = await make(t, () => new Promise(resolve => { finish = () => resolve(formatResult(output, input)); }));
  const running = jobs.submit(input), queued = jobs.submit(input);
  await eventually(() => jobs.get(running.id).status === 'running');
  const drained = jobs.drain({ timeoutMs: 60000 });
  assert.equal(jobs.get(queued.id).status, 'failed');
  assert.equal(jobs.get(queued.id).error.code, 'NODE_SHUTDOWN');
  assert.equal(jobs.capacity().accepting, false);
  assert.throws(() => jobs.submit(input), error => error.status === 503 && error.code === 'SHUTTING_DOWN');
  finish();
  await drained;
  assert.equal(jobs.get(running.id).status, 'succeeded');
});

test('draining past its limit interrupts running work as failed, so a planner session stays continuable', async t => {
  let reason;
  const jobs = await make(t, async (_input, { signal, checkpoint }) => {
    checkpoint({ sessionId: 'session-3', workspace: '/tmp/planner-ghi' });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    reason = signal.reason;
    throw signal.reason;
  });
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'running');
  await jobs.drain({ timeoutMs: 20 });
  assert.equal(reason.code, 'NODE_SHUTDOWN');
  assert.equal(jobs.get(job.id).status, 'failed');
  assert.equal(jobs.get(job.id).error.code, 'NODE_SHUTDOWN');
  assert.equal(jobs.summary(jobs.get(job.id)).continuable, true);
  // After draining, the node waits a bounded time for the dispatcher to collect and release what finished.
  const waited = jobs.awaitRelease(5000);
  jobs.release(job.id);
  await waited;
  const start = Date.now();
  const other = new Jobs({ worker: blocked }); other.jobs.set('x', { id: 'x', status: 'failed', finishedAt: new Date().toISOString() });
  await other.awaitRelease(50);
  assert.ok(Date.now() - start >= 45);
});
