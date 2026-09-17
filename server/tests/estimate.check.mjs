import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { validateInput } from '../planner/contract.mjs';
import { validateEstimateInput, createEstimator, ESTIMATE_SYSTEM_PROMPT } from '../planner/estimate.mjs';

const estimateInput = { requirements: [{ id: 'REQ-001', title: '登录', content: '错误密码应被拒绝。' }],
  context: { instructions: '只覆盖登录页' } };

test('validates requirements and only accepts context.instructions', () => {
  assert.deepEqual(validateEstimateInput(estimateInput), estimateInput);
  assert.deepEqual(validateEstimateInput({ requirements: estimateInput.requirements }), { requirements: estimateInput.requirements });
  for (const invalid of [{}, { requirements: [] }, { ...estimateInput, target: { baseUrl: 'https://x.test' } },
    { ...estimateInput, context: { knownIssues: 'x' } }, { ...estimateInput, context: { instructions: 1 } },
    { requirements: [{ id: 'REQ-001', title: '登录' }] }])
    assert.throws(() => validateEstimateInput(invalid));
});

test('prompt carries the manual-testing constraints', () => {
  assert.match(ESTIMATE_SYSTEM_PROMPT, /30%/);
  assert.match(ESTIMATE_SYSTEM_PROMPT, /2 working days for a single tester/);
});

async function setup(t, estimate) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-estimate-test-'));
  const jobs = new Jobs({ dataDir, worker: async () => { throw new Error('unused'); } });
  const server = createHttpServer({ jobs, validateInput, validateEstimateInput, estimate,
    openapiPath: fileURLToPath(new URL('../planner/openapi.json', import.meta.url)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return payload => fetch(`http://127.0.0.1:${server.address().port}/v1/planner/estimate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

test('POST /v1/planner/estimate validates input and returns the runtime result', async t => {
  const submit = await setup(t, async (input, signal) => {
    assert.equal(input.requirements[0].id, 'REQ-001');
    assert.equal(signal.aborted, false);
    return { suggestedCaseCount: 12, rationale: '覆盖登录主流程与错误密码', requirementCodes: [{ requirement: 'REQ-001', code: 'LOGIN' }] };
  });
  const bad = await submit({ requirements: [] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
  const ok = await submit(estimateInput);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { suggestedCaseCount: 12, rationale: '覆盖登录主流程与错误密码', requirementCodes: [{ requirement: 'REQ-001', code: 'LOGIN' }] });
});

test('a failing runtime surfaces as 502 ESTIMATE_FAILED; route is 404 without an estimator', async t => {
  const submit = await setup(t, async () => { throw new Error('claude runtime crashed'); });
  const res = await submit(estimateInput);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'ESTIMATE_FAILED');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'planner-estimate-test-'));
  const jobs = new Jobs({ dataDir, worker: async () => { throw new Error('unused'); } });
  const server = createHttpServer({ jobs, validateInput, openapiPath: fileURLToPath(new URL('../planner/openapi.json', import.meta.url)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const missing = await fetch(`http://127.0.0.1:${server.address().port}/v1/planner/estimate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(estimateInput) });
  assert.equal(missing.status, 404);
});

test('createEstimator calls a tool-free runtime and rejects an invalid count', async () => {
  let captured;
  const estimate = createEstimator({ runtime: async options => { captured ??= options; return { suggestedCaseCount: 8, rationale: '理由', requirementCodes: [{ requirement: 'REQ-001', code: 'LOGIN' }] }; }, model: 'haiku' });
  const controller = new AbortController();
  assert.deepEqual(await estimate(estimateInput, controller.signal), { suggestedCaseCount: 8, rationale: '理由', requirementCodes: [{ requirement: 'REQ-001', code: 'LOGIN' }] });
  assert.equal(JSON.parse(captured.prompt).context.instructions, '只覆盖登录页');
  // a confirmed code wins over the suggestion; an invalid suggestion comes back empty
  const confirmed = { requirements: [{ ...estimateInput.requirements[0], code: 'SIGNIN' }] };
  assert.equal((await estimate(confirmed, controller.signal)).requirementCodes[0].code, 'SIGNIN');
  const sloppy = createEstimator({ runtime: async () => ({ suggestedCaseCount: 3, rationale: 'x', requirementCodes: [{ requirement: 'REQ-001', code: 'log-in' }] }) });
  assert.deepEqual((await sloppy(estimateInput, controller.signal)).requirementCodes, [{ requirement: 'REQ-001', code: '' }]);
  assert.deepEqual(captured.allowedTools, []);
  assert.deepEqual(captured.mcpConfig, { mcpServers: {} });
  assert.equal(captured.signal, controller.signal);
  const bad = createEstimator({ runtime: async () => ({ suggestedCaseCount: 0, rationale: 'x' }) });
  await assert.rejects(bad(estimateInput, controller.signal));
});
