import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlannerWorker } from '../planner/worker.mjs';
import { exportCheckpoint } from '../planner/checkpoint.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { resolveClaudeOptions } from '../runtime/settings.mjs';
import { installSettings } from '../../build/planner/install-settings.mjs';
import { output } from './fixtures.mjs';
const runtimeRequire = createRequire(path.join(process.env.PLANNER_SMOKE_RUNTIME_DIR ?? fileURLToPath(new URL('../../', import.meta.url)), 'package.json'));

// Continuing an interrupted task is the one path that depends on the real CLI keeping a session on disk:
// the first run is killed mid-exploration (as its time limit would), the second reopens that session with
// --resume and must see the first run's turns. Same local model stub as runtime-smoke.mjs — no paid call.
// It runs twice: continuing on the same node (the session is still in its workspace), then on another node from
// an exported checkpoint restored into a workspace at a different path, which is what a dispatcher does.
let phase = 'interrupt', turns = 0, resumedHistory = 0;
const provider = http.createServer(async (req, res) => {
 try {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 100 })); }
  if (!req.url.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const request = JSON.parse(body);
  const toolNames = (request.tools ?? []).map(t => t.name);
  if (!toolNames.length) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_meta', type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: 'Local test' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }
  turns++;
  const setup = toolNames.find(n => n.endsWith('planner_setup_page'));
  const structured = toolNames.find(n => /structured/i.test(n));
  // First run: open the browser, then stop answering so the caller's abort kills the run mid-exploration.
  if (phase === 'interrupt') {
    if (turns === 1) return stream(res, request, { type: 'tool_use', id: 'toolu_setup', name: setup, input: { seedFile: 'seed.spec.ts' } });
    return; // hang
  }
  resumedHistory = Math.max(resumedHistory, request.messages.length);
  return stream(res, request, { type: 'tool_use', id: 'toolu_output_' + turns, name: structured, input: output });
 } catch (error) { console.error('Local model stub:', error.message); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: 'Local smoke stub failed' } })); }
});
function stream(res, request, tool) {
  const message = { id: 'msg_local', type: 'message', role: 'assistant', model: request.model, content: [tool], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message)); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  event('content_block_start', { index: 0, content_block: { ...tool, input: {} } });
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {}); res.end();
}
const target = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Planner Smoke</title><h1>Login</h1><button>Sign in</button>'); });
await new Promise(r => provider.listen(0, '127.0.0.1', r));
await new Promise(r => target.listen(0, '127.0.0.1', r));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'planner-continue-smoke-'));
const settingsPath = path.join(temporaryRoot, 'image/config/claude/settings.json');
await writeFile(path.join(temporaryRoot, 'setting.json'), JSON.stringify({ model: 'planner-settings-smoke-model', env: { ANTHROPIC_API_KEY: 'local-smoke-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}` } }));
await installSettings(temporaryRoot, settingsPath);
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = path.join(temporaryRoot, 'claude-config'); // the worker overrides this per run
const input = { requirements: [{ id: 'REQ-001', title: 'Login', content: 'Design a login test' }], target: { baseUrl: `http://127.0.0.1:${target.address().port}` } };
const options = { command: process.env.PLANNER_CLAUDE_COMMAND ?? 'claude',
  ...await resolveClaudeOptions({ env: { PLANNER_CLAUDE_SETTINGS: settingsPath } }),
  playwrightPackage: runtimeRequire.resolve('@playwright/test/package.json') };
const worker = createPlannerWorker({ ...options, temporaryRoot });
const log = e => console.log('Progress', JSON.stringify(e));
// Interrupts a fresh run mid-exploration (as its time limit would) and returns the session it kept.
async function interrupt() {
  phase = 'interrupt'; turns = 0; resumedHistory = 0;
  const interrupted = new AbortController();
  const timer = setTimeout(() => interrupted.abort(Object.assign(new Error('Planner task exceeded its time limit'), { code: 'JOB_TIMEOUT' })), 60000);
  let checkpoint;
  await worker(input, { signal: interrupted.signal, emit: log, checkpoint: state => { checkpoint = state ?? checkpoint; } })
    .then(() => { throw new Error('The interrupted run was expected to fail'); }, error => console.log('Interrupted as expected:', error.message));
  clearTimeout(timer);
  console.log('Checkpoint kept:', checkpoint.sessionId, await readdir(checkpoint.workspace));
  phase = 'continue';
  return checkpoint;
}
const reopened = label => {
  if (resumedHistory < 3) throw new Error(`${label}: the continued run did not reopen the interrupted conversation (${resumedHistory} messages)`);
};
try {
  const local = await interrupt();
  const result = await worker({ ...input, resume: local }, { signal: new AbortController().signal, emit: log, checkpoint() {} });
  reopened('Same node');
  console.log('Same-node continue succeeded:', result.cases.length, 'case(s), resumed with', resumedHistory, 'messages, workspaces left:', await readdir(temporaryRoot).then(x => x.filter(n => n.startsWith('planner-'))));

  // Another node: the archive is all that crosses over; the original workspace is gone before the continuation runs.
  const remote = await interrupt();
  const archive = await exportCheckpoint(remote);
  await rm(remote.workspace, { recursive: true, force: true });
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const nodeB = path.join(temporaryRoot, 'node-b', 'a', 'deeper', 'workspace-root');
  const assetCache = new AssetCache({ dir: path.join(temporaryRoot, 'node-b', 'assets') });
  await assetCache.put(sha256, Readable.from([archive]), archive.length);
  const elsewhere = createPlannerWorker({ ...options, assetCache, temporaryRoot: nodeB });
  const moved = await elsewhere({ ...input, resume: { checkpoint: sha256 } }, { signal: new AbortController().signal, emit: log, checkpoint() {} });
  reopened('Other node');
  console.log('Checkpoint continue succeeded:', moved.cases.length, 'case(s), archive', archive.length, 'bytes, resumed with', resumedHistory, 'messages, workspaces left:', await readdir(nodeB));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { provider.closeAllConnections(); target.closeAllConnections(); provider.close(); target.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
