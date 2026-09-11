import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Reusable task lifecycle. Each workflow injects an async worker(input, {signal, emit}).
// A single process owns each data directory; inputs/credentials are never persisted here.
export class Jobs extends EventEmitter {
  constructor({ worker, dataDir, concurrency = 1, timeoutMs = 900000, maxJobs = 100,
    retentionMs = 86400000, maxEvents = 500 }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { worker, dataDir, concurrency, timeoutMs, maxJobs, retentionMs, maxEvents });
    this.jobs = new Map(); this.inputs = new Map(); this.running = new Map(); this.closing = false;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(dataDir).filter(f => /^[0-9a-f-]{36}\.json$/.test(f))) {
      const job = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8'));
      if (`${job.id}.json` !== file || !Array.isArray(job.events)) throw new Error('Invalid persisted planner job');
      this.jobs.set(job.id, job);
      if (!TERMINAL.has(job.status)) {
        job.status = 'failed'; job.finishedAt = now();
        job.error = { code: 'SERVER_RESTARTED', message: 'The server restarted before completion; resubmit the request' };
        this.event(job, { stage: 'failed', message: job.error.message });
      }
    }
    this.prune();
  }
  persist(job) {
    const file = path.join(this.dataDir, `${job.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  event(job, progress) {
    const event = { ...progress, id: ++job.lastEventId, jobId: job.id, status: job.status, createdAt: now() };
    job.stage = event.stage; job.updatedAt = event.createdAt;
    job.events.push(event);
    if (job.events.length > this.maxEvents) job.events.splice(0, job.events.length - this.maxEvents);
    this.persist(job);
    this.emit(job.id, event);
  }
  prune() {
    for (const [id, job] of this.jobs) {
      if (TERMINAL.has(job.status) && Date.now() - Date.parse(job.finishedAt) > this.retentionMs) {
        unlinkSync(path.join(this.dataDir, `${id}.json`)); this.jobs.delete(id);
      }
    }
  }
  get(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND', 'Job not found or expired');
    return job;
  }
  summary(job) {
    const { events, result, ...summary } = job;
    return structuredClone(summary);
  }
  submit(input) {
    this.prune();
    if (this.closing) throw new ServiceError(503, 'SHUTTING_DOWN', 'Planner is shutting down');
    if (this.jobs.size >= this.maxJobs) throw new ServiceError(503, 'CAPACITY_EXCEEDED', 'Planner job capacity reached; retry after retention expiry or increase PLANNER_MAX_JOBS');
    const job = { id: randomUUID(), kind: 'planner', status: 'queued', stage: 'queued', createdAt: now(), updatedAt: now(), lastEventId: 0, events: [] };
    this.event(job, { stage: 'queued', message: 'Planner task accepted' });
    this.jobs.set(job.id, job); this.inputs.set(job.id, input);
    setImmediate(() => this.pump());
    return this.summary(job);
  }
  pump() {
    if (this.closing) return;
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.concurrency) break;
      if (job.status !== 'queued') continue;
      const controller = new AbortController();
      const entry = { controller, promise: null };
      this.running.set(job.id, entry);
      const input = this.inputs.get(job.id); this.inputs.delete(job.id);
      entry.promise = this.execute(job, input, controller).finally(() => {
        this.running.delete(job.id); this.pump();
      });
      // A storage failure must not cause an unhandled rejection or leave the job running in memory.
      entry.promise.catch(() => { this.closing = true; });
    }
  }
  async execute(job, input, controller) {
    const timer = setTimeout(() => controller.abort(new ServiceError(504, 'JOB_TIMEOUT', 'Planner task exceeded its time limit')), this.timeoutMs);
    timer.unref();
    try {
      job.status = 'running'; job.startedAt = now();
      this.event(job, { stage: 'reading_requirements', message: 'Reading supplied requirements and context' });
      const result = await this.worker(input, { signal: controller.signal,
        emit: progress => { if (!controller.signal.aborted) this.event(job, progress); } });
      controller.signal.throwIfAborted();
      job.result = result; job.status = 'succeeded'; job.finishedAt = now();
      this.event(job, { stage: 'completed', message: 'Draft test cases ready for review', casesGenerated: result.cases.length });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      job.status = reason?.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
      job.finishedAt = now(); delete job.result;
      job.error = { code: reason?.code === 'JOB_TIMEOUT' ? 'JOB_TIMEOUT' : job.status === 'cancelled' ? 'JOB_CANCELLED' : 'PLANNER_FAILED',
        message: job.status === 'cancelled' ? 'Planner task cancelled' : reason?.message || 'Planner execution failed' };
      this.event(job, { stage: job.status, message: job.error.message });
    } finally { clearTimeout(timer); }
  }
  cancel(id) {
    const job = this.get(id);
    if (TERMINAL.has(job.status)) return this.summary(job);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort(new ServiceError(409, 'JOB_CANCELLED', 'Planner task cancelled'));
      this.event(job, { stage: 'cancelling', message: 'Stopping planner and browser processes' });
    } else {
      this.inputs.delete(id); job.status = 'cancelled'; job.finishedAt = now();
      job.error = { code: 'JOB_CANCELLED', message: 'Planner task cancelled' };
      this.event(job, { stage: 'cancelled', message: job.error.message });
    }
    return this.summary(job);
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) if (!TERMINAL.has(job.status)) this.cancel(job.id);
    await Promise.allSettled([...this.running.values()].map(entry => entry.promise));
  }
}
