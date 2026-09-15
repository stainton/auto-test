import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { validateInput } from '../planner/contract.mjs';
import { validateSimplifyInput, createSimplifier, SIMPLIFY_OUTPUT_SCHEMA } from '../planner/simplify.mjs';

const simplifyInput = { title: '正确账号密码登录', preconditions: '用户账号已启用',
  steps: '1. 在 input[data-testid=username] 输入 demo\n2. 点击 button.submit', expected: '进入系统首页' };

test('rejects missing/empty steps and unsupported fields', () => {
  assert.deepEqual(validateSimplifyInput(simplifyInput), simplifyInput);
  assert.deepEqual(validateSimplifyInput({ steps: '1. 打开登录页' }),
    { title: '', preconditions: '', steps: '1. 打开登录页', expected: '' });
  for (const invalid of [{}, { steps: '' }, { steps: '   ' }, { ...simplifyInput, extra: 'field' }, { steps: 123 }])
    assert.throws(() => validateSimplifyInput(invalid));
});

async function setup(t, simplify) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-simplify-test-'));
  const jobs = new Jobs({ dataDir, worker: async () => { throw new Error('unused'); } });
  const server = createHttpServer({ jobs, validateInput, validateSimplifyInput, simplify,
    openapiPath: fileURLToPath(new URL('../planner/openapi.json', import.meta.url)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, init);
  const submit = payload => request('/v1/planner/simplify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { request, submit };
}

test('POST /v1/planner/simplify validates input and returns the runtime result', async t => {
  const friendly = { preconditions: '账号已启用', steps: '1. 输入用户名\n2. 点击登录按钮', expected: '进入系统首页' };
  const { submit } = await setup(t, async (input, signal) => {
    assert.equal(input.title, simplifyInput.title);
    assert.equal(signal.aborted, false);
    return friendly;
  });
  const bad = await submit({ steps: '' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
  const ok = await submit(simplifyInput);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), friendly);
});

test('a failing or hanging runtime surfaces as 502 and is aborted on timeout', async t => {
  const { submit } = await setup(t, async () => { throw new Error('claude runtime crashed'); });
  const res = await submit(simplifyInput);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'SIMPLIFY_FAILED');
});

test('route is absent (404) when the server is built without a simplifier', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-simplify-test-'));
  const jobs = new Jobs({ dataDir, worker: async () => { throw new Error('unused'); } });
  const server = createHttpServer({ jobs, validateInput, openapiPath: fileURLToPath(new URL('../planner/openapi.json', import.meta.url)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/planner/simplify`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(simplifyInput) });
  assert.equal(res.status, 404);
});

test('createSimplifier calls the injected runtime with a tool-free, no-MCP prompt', async t => {
  let captured;
  const simplify = createSimplifier({
    runtime: async options => { captured = options; return { preconditions: '', steps: [{ step: '步骤', expect: '结果' }] }; },
    command: 'claude', model: 'haiku', settingsPath: '/tmp/settings.json'
  });
  const controller = new AbortController();
  const result = await simplify(simplifyInput, controller.signal);
  assert.deepEqual(result, { preconditions: '', steps: '步骤', expected: '结果' });
  assert.deepEqual(captured.allowedTools, []);
  assert.deepEqual(captured.mcpConfig, { mcpServers: {} });
  assert.equal(captured.model, 'haiku');
  assert.equal(captured.signal, controller.signal);
  const prompt = JSON.parse(captured.prompt);
  assert.equal(prompt.steps, simplifyInput.steps);
});

test('createSimplifier numbers multiple friendly steps and joins their expected results', async () => {
  const simplify = createSimplifier({
    runtime: async () => ({ preconditions: '账号已启用',
      steps: [{ step: '输入用户名和密码', expect: '按钮变为可点击' }, { step: '点击登录', expect: '进入系统首页' }] })
  });
  const result = await simplify(simplifyInput, new AbortController().signal);
  assert.deepEqual(result, { preconditions: '账号已启用',
    steps: '1. 输入用户名和密码\n2. 点击登录', expected: '1. 按钮变为可点击\n2. 进入系统首页' });
});

test('SIMPLIFY_OUTPUT_SCHEMA caps each friendly step/expect at 30 characters', () => {
  const item = SIMPLIFY_OUTPUT_SCHEMA.properties.steps.items;
  assert.equal(item.properties.step.maxLength, 30);
  assert.equal(item.properties.expect.maxLength, 30);
});
