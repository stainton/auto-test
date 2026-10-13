import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Reusable task lifecycle. Each workflow injects an async worker(input, {signal, emit}).
// kind/label/started/completion carry the workflow's own wording (planner designs cases,
// generator writes scripts) so the lifecycle itself stays workflow-agnostic.
//
// A node is a stateless executor: whoever dispatched a task (CaseHub) owns its record, so jobs live in memory
// only. A finished job is held until the dispatcher has collected what it needs and releases it, or until
// retentionMs passes for a caller that never releases; a restart forgets everything, and the dispatcher treats
// a job it can no longer find as interrupted.
export class Jobs extends EventEmitter {
  constructor({ worker, concurrency = 1, timeoutMs = 900000, maxJobs = 100,
    retentionMs = 86400000, maxRetained = 200, maxEvents = 500, kind = 'planner', label = 'Planner',
    // A worker may checkpoint the state that lets an interrupted job be continued later (the planner
    // keeps its Claude session); discard releases whatever that state holds once the job is gone.
    discard = () => {},
    // timeoutFor lets a workflow honour a per-job limit chosen by the caller (the planner
    // exposes it in the request, so a person can give a large exploration more time than the
    // server default). It returns undefined to keep timeoutMs; the workflow, not this class,
    // decides the acceptable range.
    timeoutFor = () => undefined,
    started = { stage: 'reading_requirements', message: 'Reading supplied requirements and context' },
    completion = result => ({ message: 'Draft test cases ready for review', casesGenerated: result.cases.length }) }) {
    super();
    this.setMaxListeners(0);
    // maxJobs bounds the work this node has accepted but not finished (queued + running); finished jobs
    // waiting to be collected are bounded separately by retentionMs and maxRetained, and never refuse new work.
    Object.assign(this, { worker, concurrency, timeoutMs, maxJobs, retentionMs, maxRetained, maxEvents,
      kind, label, started, completion, timeoutFor, discard });
    this.jobs = new Map(); this.inputs = new Map(); this.running = new Map();
    this.reserved = 0; this.closing = false;
  }
  event(job, progress) {
    const event = { ...progress, id: ++job.lastEventId, jobId: job.id, status: job.status, createdAt: now() };
    job.stage = event.stage; job.updatedAt = event.createdAt;
    job.events.push(event);
    if (job.events.length > this.maxEvents) job.events.splice(0, job.events.length - this.maxEvents);
    this.emit(job.id, event);
  }
  forget(job) {
    if (job.continuation) this.discard(job.continuation);
    if (job.artifacts) this.discard(job.artifacts);
    this.jobs.delete(job.id);
  }
  prune() {
    const finished = [...this.jobs.values()].filter(job => TERMINAL.has(job.status));
    for (const job of finished) if (Date.now() - Date.parse(job.finishedAt) > this.retentionMs) this.forget(job);
    // Oldest first: a caller that never releases cannot grow this node's memory without bound.
    const kept = finished.filter(job => this.jobs.has(job.id)).sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    for (const job of kept.slice(0, Math.max(0, kept.length - this.maxRetained))) this.forget(job);
  }
  get(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND', 'Job not found, expired, released, or lost in a restart of this node');
    return job;
  }
  summary(job) {
    // continuation and artifacts hold server-side paths; callers only learn what they can download.
    const { events, result, continuation, artifacts, ...summary } = job;
    return { ...structuredClone(summary), ...(continuation && job.status === 'failed' ? { continuable: true } : {}),
      ...(artifacts && TERMINAL.has(job.status) ? { diagnostics: true } : {}) };
  }
  queued() { let count = 0; for (const job of this.jobs.values()) if (job.status === 'queued') count++; return count; }
  // What a dispatcher reads to pick an idle node: free slots are those neither running nor already promised.
  capacity() {
    const running = this.running.size, queued = this.queued();
    return { kind: this.kind, concurrency: this.concurrency, running, queued, reserved: this.reserved,
      available: this.closing ? 0 : Math.max(0, this.concurrency - running - queued - this.reserved), accepting: !this.closing };
  }
  // Holds a place for a request while it is validated (validation may claim a continuation or check cached
  // assets), so two concurrent requests can never both take the last slot. queue=false asks for an idle slot
  // only and is refused with 429 rather than waiting behind other work: that is how a dispatcher finds out
  // this node is busy and tries another one. Every reservation is either consumed by submit or released.
  reserve({ queue = true } = {}) {
    this.prune();
    if (this.closing) throw new ServiceError(503, 'SHUTTING_DOWN', `${this.label} is shutting down`);
    const pending = this.running.size + this.queued() + this.reserved;
    if (!queue && pending >= this.concurrency) throw new ServiceError(429, 'BUSY', `${this.label} has no idle slot; try another node or queue the task`);
    if (pending >= this.maxJobs) throw new ServiceError(503, 'CAPACITY_EXCEEDED', `${this.label} already holds ${this.maxJobs} unfinished jobs; retry later or raise the job limit`);
    this.reserved++;
    let held = true;
    return () => { if (held) { held = false; this.reserved--; } };
  }
  submit(input, { reservation, settings } = {}) {
    const release = reservation ?? this.reserve();
    try {
      if (this.closing) throw new ServiceError(503, 'SHUTTING_DOWN', `${this.label} is shutting down`);
      const job = { id: randomUUID(), kind: this.kind, status: 'queued', stage: 'queued', createdAt: now(), updatedAt: now(), lastEventId: 0, events: [] };
      this.event(job, { stage: 'queued', message: `${this.label} task accepted` });
      this.jobs.set(job.id, job); this.inputs.set(job.id, { input, settings });
      setImmediate(() => this.pump());
      return this.summary(job);
    } finally { release(); }
  }
  pump() {
    if (this.closing) return;
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.concurrency) break;
      if (job.status !== 'queued') continue;
      const controller = new AbortController();
      const entry = { controller, promise: null };
      this.running.set(job.id, entry);
      const { input, settings } = this.inputs.get(job.id); this.inputs.delete(job.id);
      entry.promise = this.execute(job, input, settings, controller).finally(() => {
        this.running.delete(job.id); this.pump();
      });
    }
  }
  async execute(job, input, settings, controller) {
    const timeoutMs = this.timeoutFor(input) ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(new ServiceError(504, 'JOB_TIMEOUT', `${this.label} task exceeded its time limit of ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs);
    timer.unref();
    try {
      job.status = 'running'; job.startedAt = now();
      job.timeoutMs = timeoutMs;
      this.event(job, { ...this.started });
      const result = await this.worker(input, { signal: controller.signal,
        // The agent configuration this task was submitted with; the worker hands it to its own CLI runs so a
        // configuration applied for a later task never changes one already running.
        ...(settings ? { settings } : {}),
        emit: progress => { if (!controller.signal.aborted) this.event(job, progress); },
        // Diagnostic files the dispatcher may download until the job is released; they do not offer continuation.
        retain: artifacts => { if (artifacts) job.artifacts = artifacts; else delete job.artifacts; },
        // Recorded even after an abort: a task killed by its time limit is exactly the one worth continuing.
        checkpoint: state => { if (state) job.continuation = state; else delete job.continuation; } });
      controller.signal.throwIfAborted();
      job.result = result; job.status = 'succeeded'; job.finishedAt = now();
      this.event(job, { stage: 'completed', ...this.completion(result) });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      job.status = reason?.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
      job.finishedAt = now(); delete job.result;
      const passthrough = ['JOB_TIMEOUT', 'NODE_SHUTDOWN'].includes(reason?.code) ? reason.code : undefined;
      job.error = { code: passthrough ?? (job.status === 'cancelled' ? 'JOB_CANCELLED' : `${this.kind.toUpperCase()}_FAILED`),
        message: job.status === 'cancelled' ? `${this.label} task cancelled` : reason?.message || `${this.label} execution failed` };
      this.event(job, { stage: job.status, message: job.error.message });
    } finally { clearTimeout(timer); }
  }
  // Hands a failed job's checkpoint to the run that continues it, and takes it off that job: one
  // interrupted run is continued once, so two jobs never drive the same session.
  claimContinuation(id) {
    const job = this.get(id);
    if (!job.continuation || job.status !== 'failed')
      throw new ServiceError(409, 'NOT_CONTINUABLE', `This ${this.kind} task cannot be continued; start a new one`);
    const state = structuredClone(job.continuation);
    delete job.continuation; job.continuedAt = now();
    return state;
  }
  // The dispatcher has what it needs from a finished job: drop it and whatever files it still holds.
  release(id) {
    const job = this.get(id);
    if (!TERMINAL.has(job.status)) throw new ServiceError(409, 'JOB_ACTIVE', `This ${this.kind} task is still ${job.status}; cancel it first`);
    this.forget(job);
    this.emit('released', id);
    return { id, released: true };
  }
  cancel(id, reason = new ServiceError(409, 'JOB_CANCELLED', `${this.label} task cancelled`)) {
    const job = this.get(id);
    if (TERMINAL.has(job.status)) return this.summary(job);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort(reason);
      this.event(job, { stage: 'cancelling', message: reason.code === 'NODE_SHUTDOWN' ? reason.message : `Stopping ${this.kind} and browser processes` });
    } else {
      this.inputs.delete(id);
      job.status = reason.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed'; job.finishedAt = now();
      job.error = { code: reason.code, message: reason.message };
      this.event(job, { stage: job.status, message: job.error.message });
    }
    return this.summary(job);
  }
  // Graceful shutdown (SIGTERM, scale-in): take no more work, hand queued tasks back at once so the dispatcher
  // can run them elsewhere, let running ones finish within timeoutMs, then interrupt the rest as failed (not
  // cancelled) so an interrupted planner session stays continuable.
  async drain({ timeoutMs }) {
    this.closing = true;
    const shutdown = message => new ServiceError(503, 'NODE_SHUTDOWN', message);
    for (const job of [...this.jobs.values()]) if (job.status === 'queued')
      this.cancel(job.id, shutdown(`This ${this.kind} node is shutting down before the task started; submit it again`));
    const running = [...this.running.values()].map(entry => entry.promise);
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, 'expired'); timer.unref(); });
    if (await Promise.race([Promise.allSettled(running), expired]) === 'expired')
      for (const id of [...this.running.keys()]) this.cancel(id, shutdown(`This ${this.kind} node shut down before the task finished`));
    clearTimeout(timer);
    await Promise.allSettled([...this.running.values()].map(entry => entry.promise));
  }
  // Waits, at most timeoutMs, for the dispatcher to collect and release the finished jobs it has not taken yet.
  async awaitRelease(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while ([...this.jobs.values()].some(job => TERMINAL.has(job.status)) && Date.now() < deadline)
      await new Promise(resolve => { const timer = setTimeout(resolve, Math.min(200, deadline - Date.now())); timer.unref(); });
  }
  // Immediate stop (tests, a second signal): cancel everything and wait for the workers to unwind.
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) if (!TERMINAL.has(job.status)) this.cancel(job.id);
    await Promise.allSettled([...this.running.values()].map(entry => entry.promise));
  }
}
