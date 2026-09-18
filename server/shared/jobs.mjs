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
// kind/label/started/completion carry the workflow's own wording (planner designs cases,
// generator writes scripts) so the lifecycle itself stays workflow-agnostic.
export class Jobs extends EventEmitter {
  constructor({ worker, dataDir, concurrency = 1, timeoutMs = 900000, maxJobs = 100,
    retentionMs = 86400000, maxEvents = 500, kind = 'planner', label = 'Planner',
    // timeoutFor lets a workflow honour a per-job limit chosen by the caller (the planner
    // exposes it in the request, so a person can give a large exploration more time than the
    // server default). It returns undefined to keep timeoutMs; the workflow, not this class,
    // decides the acceptable range.
    timeoutFor = () => undefined,
    started = { stage: 'reading_requirements', message: 'Reading supplied requirements and context' },
    completion = result => ({ message: 'Draft test cases ready for review', casesGenerated: result.cases.length }) }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { worker, dataDir, concurrency, timeoutMs, maxJobs, retentionMs, maxEvents,
      kind, label, started, completion, timeoutFor });
    this.jobs = new Map(); this.inputs = new Map(); this.running = new Map(); this.closing = false;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(dataDir).filter(f => /^[0-9a-f-]{36}\.json$/.test(f))) {
      const job = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8'));
      if (`${job.id}.json` !== file || !Array.isArray(job.events)) throw new Error(`Invalid persisted ${kind} job`);
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
    if (this.closing) throw new ServiceError(503, 'SHUTTING_DOWN', `${this.label} is shutting down`);
    if (this.jobs.size >= this.maxJobs) throw new ServiceError(503, 'CAPACITY_EXCEEDED', `${this.label} job capacity reached; retry after retention expiry or raise the job limit`);
    const job = { id: randomUUID(), kind: this.kind, status: 'queued', stage: 'queued', createdAt: now(), updatedAt: now(), lastEventId: 0, events: [] };
    this.event(job, { stage: 'queued', message: `${this.label} task accepted` });
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
    const timeoutMs = this.timeoutFor(input) ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(new ServiceError(504, 'JOB_TIMEOUT', `${this.label} task exceeded its time limit of ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs);
    timer.unref();
    try {
      job.status = 'running'; job.startedAt = now();
      job.timeoutMs = timeoutMs;
      this.event(job, { ...this.started });
      const result = await this.worker(input, { signal: controller.signal,
        emit: progress => { if (!controller.signal.aborted) this.event(job, progress); } });
      controller.signal.throwIfAborted();
      job.result = result; job.status = 'succeeded'; job.finishedAt = now();
      this.event(job, { stage: 'completed', ...this.completion(result) });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      job.status = reason?.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
      job.finishedAt = now(); delete job.result;
      job.error = { code: reason?.code === 'JOB_TIMEOUT' ? 'JOB_TIMEOUT' : job.status === 'cancelled' ? 'JOB_CANCELLED' : `${this.kind.toUpperCase()}_FAILED`,
        message: job.status === 'cancelled' ? `${this.label} task cancelled` : reason?.message || `${this.label} execution failed` };
      this.event(job, { stage: job.status, message: job.error.message });
    } finally { clearTimeout(timer); }
  }
  cancel(id) {
    const job = this.get(id);
    if (TERMINAL.has(job.status)) return this.summary(job);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort(new ServiceError(409, 'JOB_CANCELLED', `${this.label} task cancelled`));
      this.event(job, { stage: 'cancelling', message: `Stopping ${this.kind} and browser processes` });
    } else {
      this.inputs.delete(id); job.status = 'cancelled'; job.finishedAt = now();
      job.error = { code: 'JOB_CANCELLED', message: `${this.label} task cancelled` };
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
