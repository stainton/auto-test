import http from 'node:http';
import { readFileSync } from 'node:fs';
import { ServiceError, TERMINAL } from './jobs.mjs';

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
export function createHttpServer({ jobs, validateInput, openapiPath, maxBodyBytes = 2 * 1024 * 1024 }) {
  const spec = readFileSync(openapiPath, 'utf8');
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      if (req.method === 'POST' && url.pathname === '/v1/planner/jobs') {
        const payload = await body(req, maxBodyBytes);
        let input;
        try { input = validateInput(payload); }
        catch (error) { throw new ServiceError(400, 'INVALID_REQUEST', error.message); }
        const job = jobs.submit(input);
        res.setHeader('Location', `/v1/planner/jobs/${job.id}`);
        return json(res, 202, job);
      }
      const match = /^\/v1\/planner\/jobs\/([0-9a-f-]{36})(?:\/(result|events))?$/.exec(url.pathname);
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
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  server.closeStreams = () => { for (const res of streams) res.end(); };
  return server;
}
