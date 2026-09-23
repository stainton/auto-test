import http from 'node:http';
import { readFileSync } from 'node:fs';
import { ServiceError, TERMINAL } from './jobs.mjs';
import { takeAgentSettings } from './contract.mjs';
import { SHA256_RE, MAX_ASSET_BYTES } from './assets.mjs';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req, maxBytes) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ServiceError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'INVALID_JSON', 'Request body must contain valid JSON'); }
}
// basePath is the workflow's route prefix (/v1/planner, /v1/generator); everything below is shared.
export function createHttpHandler({ jobs, validateInput, openapiPath, maxBodyBytes = 2 * 1024 * 1024,
  basePath = '/v1/planner', applySettings, assetCache,
  validateSimplifyInput, simplify, simplifyTimeoutMs = 60000,
  validateEstimateInput, estimate, estimateTimeoutMs = 120000 }) {
  const spec = readFileSync(openapiPath, 'utf8');
  // Every request may carry the agent configuration CaseHub holds for this service. It is applied once
  // the request is known to be valid and before the work starts, so the run uses the configuration
  // CaseHub sent rather than whatever this container happened to keep from an earlier one.
  const settingsFor = payload => {
    try { return takeAgentSettings(payload); }
    catch (error) { throw new ServiceError(400, 'INVALID_REQUEST', error.message); }
  };
  const apply = async settings => {
    if (!settings || !applySettings) return;
    try { await applySettings(settings); }
    catch (error) {
      if (error.invalidSettings) throw new ServiceError(400, 'INVALID_AGENT_SETTINGS', error.message);
      throw new ServiceError(500, 'AGENT_SETTINGS_FAILED', `Cannot apply the agent configuration: ${error.message}`);
    }
  };
  const streams = new Set();
  const jobsPath = `${basePath}/jobs`;
  const jobRoute = new RegExp(`^${jobsPath.replace(/[/]/g, '\\/')}\\/([0-9a-f-]{36})(?:\\/(result|events))?$`);
  // Synchronous (non-job) model calls: validate, run with a hard timeout, map runtime failures to 502.
  const syncRoutes = new Map([
    [`${basePath}/simplify`, { run: simplify, validate: validateSimplifyInput, timeoutMs: simplifyTimeoutMs, code: 'SIMPLIFY_FAILED', label: 'Simplify' }],
    [`${basePath}/estimate`, { run: estimate, validate: validateEstimateInput, timeoutMs: estimateTimeoutMs, code: 'ESTIMATE_FAILED', label: 'Estimate' }]
  ]);
  const handler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Location');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://planner.local');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/readyz') return json(res, jobs.closing ? 503 : 200, { status: jobs.closing ? 'unavailable' : 'ready' });
      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(spec);
      }
      // Assets CaseHub pushes ahead of a task: HEAD asks whether a file is already cached, PUT stores it.
      const assetMatch = assetCache && url.pathname.startsWith(`${basePath}/assets/`) ? url.pathname.slice(`${basePath}/assets/`.length) : undefined;
      if (assetMatch !== undefined) {
        if (!SHA256_RE.test(assetMatch)) throw new ServiceError(404, 'NOT_FOUND', 'Route not found');
        if (req.method === 'HEAD' || req.method === 'GET') {
          res.writeHead(await assetCache.has(assetMatch) ? 200 : 404, { 'Cache-Control': 'no-store' }); return res.end();
        }
        if (req.method !== 'PUT') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        const size = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(size) || size < 1) throw new ServiceError(411, 'LENGTH_REQUIRED', 'Content-Length is required');
        if (size > MAX_ASSET_BYTES) throw new ServiceError(413, 'BODY_TOO_LARGE', 'Asset is too large');
        try { await assetCache.put(assetMatch, req, size); }
        catch (error) { throw new ServiceError(400, 'INVALID_ASSET', error.message); }
        return json(res, 201, { sha256: assetMatch, size });
      }
      if (req.method === 'POST' && url.pathname === jobsPath) {
        const payload = await body(req, maxBodyBytes);
        const settings = settingsFor(payload);
        let input;
        // validateInput may also resolve references the request makes to earlier jobs (continueFrom),
        // whose own status codes must survive instead of being flattened into a 400.
        try { input = await validateInput(payload); }
        catch (error) { throw error instanceof ServiceError ? error : new ServiceError(400, 'INVALID_REQUEST', error.message); }
        await apply(settings);
        const job = jobs.submit(input);
        res.setHeader('Location', `${jobsPath}/${job.id}`);
        return json(res, 202, job);
      }
      const sync = req.method === 'POST' && syncRoutes.get(url.pathname);
      if (sync && sync.run && sync.validate) {
        const payload = await body(req, maxBodyBytes);
        const settings = settingsFor(payload);
        let input;
        try { input = sync.validate(payload); }
        catch (error) { throw new ServiceError(400, 'INVALID_REQUEST', error.message); }
        await apply(settings);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`${sync.label} request timed out`)), sync.timeoutMs);
        let output;
        try { output = await sync.run(input, controller.signal); }
        catch (error) { throw new ServiceError(502, sync.code, error.message || `${sync.label} failed`); }
        finally { clearTimeout(timer); }
        return json(res, 200, output);
      }
      const match = jobRoute.exec(url.pathname);
      if (!match) throw new ServiceError(404, 'NOT_FOUND', 'Route not found');
      const [, id, resource] = match;
      const job = jobs.get(id);
      if (req.method === 'DELETE' && !resource) return json(res, 202, jobs.cancel(id));
      if (req.method !== 'GET') throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      if (!resource) return json(res, 200, jobs.summary(job));
      if (resource === 'result') {
        if (job.status !== 'succeeded') throw new ServiceError(409, 'RESULT_UNAVAILABLE', `Result unavailable while job is ${job.status}`);
        return json(res, 200, job.result);
      }
      const rawAfter = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
      if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter)) || Number(rawAfter) > job.lastEventId)
        throw new ServiceError(400, 'INVALID_CURSOR', 'Event cursor must be a nonnegative integer no greater than lastEventId');
      const after = Number(rawAfter);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      streams.add(res);
      // Disconnect slow consumers. They can replay using Last-Event-ID without retaining unbounded buffers.
      const send = (type, data, eventId) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(`${eventId === undefined ? '' : `id: ${eventId}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) res.destroy();
      };
      const listener = event => {
        send('progress', event, event.id);
        if (TERMINAL.has(event.status)) res.end();
      };
      const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 15000);
      heartbeat.unref();
      res.on('close', () => { clearInterval(heartbeat); jobs.off(id, listener); streams.delete(res); });
      jobs.on(id, listener);
      // A snapshot always tells reconnecting clients the current status, including completed tasks.
      send('snapshot', jobs.summary(job));
      if (job.events[0]?.id > after + 1) send('reset', { firstAvailableEventId: job.events[0].id, message: 'Earlier progress events have expired' });
      for (const event of job.events) if (event.id > after) send('progress', event, event.id);
      if (TERMINAL.has(job.status)) res.end();
    } catch (error) {
      if (res.headersSent) return res.destroy();
      json(res, error.status ?? 500, { error: { code: error.code && error.status ? error.code : 'INTERNAL_ERROR',
        message: error.message || 'Internal server error' } });
    }
  };
  handler.requestTimeout = assetCache ? 600000 : 30000;
  handler.closeStreams = () => { for (const res of streams) res.end(); };
  return handler;
}

export function createHttpServer(options) {
  const handler = createHttpHandler(options);
  const server = http.createServer(handler);
  server.requestTimeout = handler.requestTimeout;
  server.closeStreams = handler.closeStreams;
  return server;
}
