import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Jobs } from '../shared/jobs.mjs';
import { formatResult } from '../planner/contract.mjs';
import { input, output, eventually } from './fixtures.mjs';

async function make(t, worker, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-jobs-test-'));
  const jobs = new Jobs({ dataDir, worker, ...options });
  t.after(async () => { await jobs.close(); await rm(dataDir, { recursive: true, force: true }); });
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

test('persists completed output and bounds progress without saving request credentials', async t => {
  const jobs = await make(t, async (_input, { emit }) => {
    for (let i = 0; i < 8; i++) emit({ stage: 'exploring', message: `Action ${i}` });
    return formatResult(output, input);
  }, { maxEvents: 3 });
  const job = jobs.submit(input);
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  const stored = await readFile(path.join(jobs.dataDir, `${job.id}.json`), 'utf8');
  assert.ok(!stored.includes('super-secret-password'));
  assert.equal(jobs.get(job.id).events.length, 3);
  const restored = new Jobs({ dataDir: jobs.dataDir, worker: blocked });
  assert.deepEqual(restored.get(job.id).result, formatResult(output, input));
});

test('marks interrupted persisted jobs failed on restart', async t => {
  const jobs = await make(t, blocked);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await writeFile(path.join(jobs.dataDir, `${id}.json`), JSON.stringify({ id, kind: 'planner', status: 'running', stage: 'exploring',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEventId: 0, events: [] }));
  const restored = new Jobs({ dataDir: jobs.dataDir, worker: blocked });
  assert.equal(restored.get(id).status, 'failed');
  assert.equal(restored.get(id).error.code, 'SERVER_RESTARTED');
});

test('enforces admission and expires completed jobs', async t => {
  const jobs = await make(t, async () => formatResult(output, input), { maxJobs: 1, retentionMs: 50 });
  const job = jobs.submit(input);
  assert.throws(() => jobs.submit(input), error => error.status === 503);
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  jobs.get(job.id).finishedAt = new Date(Date.now() - 100).toISOString();
  assert.throws(() => jobs.get(job.id), error => error.status === 404);
  assert.ok(jobs.submit(input).id);
});
