import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateInput, formatScript, formatResult, SCRIPT_OUTPUT_SCHEMA } from '../generator/contract.mjs';
import { createGeneratorWorker, EXCLUDED_TOOLS } from '../generator/worker.mjs';
import { buildPrompt } from '../generator/prompt.mjs';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { fileURLToPath } from 'node:url';
import { eventually } from './fixtures.mjs';

const input = {
  cases: [{ id: 'TC-LOGIN-AUTH-FUNC-001', title: '拒绝错误密码', priority: 'P1', requirement: 'REQ-001',
    precondition: '存在测试账号', steps: '1. 打开登录页\n2. 输入错误密码并提交', expects: '1. 显示表单\n2. 显示错误提示' }],
  requirements: [{ id: 'REQ-001', title: '登录', content: '错误密码应被拒绝。' }],
  target: { baseUrl: 'https://example.test/login' },
  context: { explorationNotes: 'Existing login form', testData: { password: 'super-secret-password' } }
};
const spec = `import { test, expect } from '@playwright/test';\ntest('拒绝错误密码', async ({ page }, testInfo) => { await test.step('打开登录页并确认表单', async () => { await page.goto('/login'); await expect(page).toHaveTitle(/登录/); await testInfo.attach('登录页显示表单', { body: await page.screenshot(), contentType: 'image/png' }); }); });\n`;
const output = { status: 'generated', code: spec, summary: '验证错误密码被拒绝', deviations: [], missingInputs: [], explorationNotes: 'Existing login form\nError banner' };

test('rejects malformed cases, local storage-state paths and unsupported fields', () => {
  assert.deepEqual(validateInput(input), input);
  for (const invalid of [ {}, { ...input, cases: [] }, { ...input, cases: [...input.cases, ...input.cases] },
    { ...input, cases: [{ ...input.cases[0], id: 'has space' }] },
    { ...input, cases: [{ ...input.cases[0], steps: '' }] },
    { ...input, cases: [{ ...input.cases[0], plan: 'x' }] },
    { ...input, target: { baseUrl: 'file:///etc/passwd' } },
    { ...input, target: { ...input.target, storageState: '/local/auth.json' } },
    { ...input, mcpConfig: { command: 'arbitrary-command' } } ]) assert.throws(() => validateInput(invalid));
});

test('accepts a runnable spec and refuses one that is stubbed, skipped or not a Playwright test', () => {
  const script = formatScript(output, input.cases[0]);
  assert.deepEqual(script, { caseId: 'TC-LOGIN-AUTH-FUNC-001', title: '拒绝错误密码', fileName: 'TC-LOGIN-AUTH-FUNC-001.spec.ts',
    language: 'typescript', status: 'generated', code: spec.trim(), summary: '验证错误密码被拒绝', deviations: [], missingInputs: [] });
  for (const invalid of [ { ...output, code: '// nothing here' },
    { ...output, code: `import { test } from '@playwright/test';\ntest.skip('x', async () => {});` },
    { ...output, code: `import { test } from '@playwright/test';\ntest('no evidence', async ({ page }) => { await page.goto('/'); });` },
    { ...output, code: `import { test, expect } from '@playwright/test';\ntest('partial evidence', async ({ page }, testInfo) => { await test.step('有证据', async () => { await expect(page).toHaveTitle(/x/); await testInfo.attach('有证据', { body: await page.screenshot(), contentType: 'image/png' }); }); await test.step('无证据', async () => { await expect(page).toHaveURL(/x/); }); });` },
    { ...output, status: 'done' }, { ...output, summary: '' }, { ...output, summary: '汉'.repeat(41) },
    { ...output, deviations: [{ risk: 'unknown', summary: 'x' }] } ]) assert.throws(() => formatScript(invalid, input.cases[0]));
});

test('a blocked case keeps its reason, drops any code and is reported as a limitation', () => {
  const blocked = formatScript({ status: 'blocked', code: spec, summary: '缺少测试账号，无法登录', deviations: [], missingInputs: ['可登录的测试账号'], explorationNotes: '' }, input.cases[0]);
  assert.equal(blocked.code, '');
  assert.equal(blocked.status, 'blocked');
  const result = formatResult([formatScript(output, input.cases[0]), blocked], { explorationNotes: 'notes' });
  assert.equal(result.generated, 1);
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.limitations, [{ risk: 'high', summary: '缺少测试账号，无法登录' }]);
  assert.equal(result.scripts.length, 2);
});

test('the prompt carries the case and only its own requirement, never the browser credentials', () => {
  const payload = JSON.parse(buildPrompt({ ...input, requirements: [...input.requirements, { id: 'REQ-002', title: '其他', content: '无关需求' }],
    target: { ...input.target, storageState: { cookies: [], origins: [] } } }, input.cases[0]));
  assert.equal(payload.case.id, 'TC-LOGIN-AUTH-FUNC-001');
  assert.equal(payload.fileName, 'TC-LOGIN-AUTH-FUNC-001.spec.ts');
  assert.deepEqual(payload.requirements.map(r => r.id), ['REQ-001']);
  assert.deepEqual(payload.target, { baseUrl: 'https://example.test/login', authenticationProvided: true });
  assert.equal(JSON.stringify(payload).includes('cookies'), false);
});

async function setup(t, runtime, options = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'generator-worker-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, worker: createGeneratorWorker({ runtime, temporaryRoot,
    playwrightPackage: '/runtime/node_modules/@playwright/test/package.json', ...options }) };
}
const setupPage = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } });
const setupCall = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__playwright-test__generator_setup_page' }] } });

test('runs one model call per case, isolates the workspace and forwards progress', async t => {
  const runs = [];
  const { temporaryRoot, worker } = await setup(t, async options => {
    runs.push(options);
    options.onMessage(setupCall());
    options.onMessage(setupPage());
    options.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'GENERATOR_PROGRESS {"stage":"verifying","message":"Ran the spec once"}' }] } });
    return output;
  });
  const events = [];
  const two = { ...input, cases: [input.cases[0], { ...input.cases[0], id: 'TC-LOGIN-AUTH-FUNC-002', requirement: 'REQ-OTHER' }] };
  const result = await worker(two, { signal: new AbortController().signal, emit: e => events.push(e) });
  assert.equal(runs.length, 2);
  assert.deepEqual(result.scripts.map(s => s.caseId), ['TC-LOGIN-AUTH-FUNC-001', 'TC-LOGIN-AUTH-FUNC-002']);
  assert.equal(result.generated, 2);
  // Batch experience observed while generating the first case is handed to the second one, even across requirements.
  assert.match(JSON.parse(runs[1].prompt).context.explorationNotes, /Error banner/);
  assert.deepEqual(runs[0].disallowedTools, EXCLUDED_TOOLS.map(t => `mcp__playwright-test__${t}`));
  assert.ok(events.some(e => e.stage === 'verifying' && e.caseId === 'TC-LOGIN-AUTH-FUNC-001'));
  assert.ok(events.some(e => e.stage === 'generating' && e.caseStatus === 'generated' && e.caseTotal === 2));
  assert.equal(runs[0].mcpConfig.mcpServers['playwright-test'].args.includes('run-test-mcp-server'), true);
  assert.deepEqual(await readdir(temporaryRoot), []); // workspace removed after the run
});

test('a case that fails on its own is blocked, the rest of the batch still generates', async t => {
  let call = 0;
  const { worker } = await setup(t, async options => {
    options.onMessage(setupCall());
    options.onMessage(setupPage());
    if (++call === 1) throw new Error('Playwright MCP is not connected');
    return output;
  });
  const two = { ...input, cases: [input.cases[0], { ...input.cases[0], id: 'TC-LOGIN-AUTH-FUNC-002' }] };
  const result = await worker(two, { signal: new AbortController().signal, emit: () => {} });
  assert.equal(result.blocked, 1);
  assert.equal(result.scripts[0].status, 'blocked');
  assert.match(result.scripts[0].summary, /生成失败/);
  assert.equal(result.scripts[1].status, 'generated');
});

test('a browser session that never initialized blocks the case instead of returning a spec', async t => {
  const { worker } = await setup(t, async () => output);
  const result = await worker(input, { signal: new AbortController().signal, emit: () => {} });
  assert.equal(result.scripts[0].status, 'blocked');
});

test('cancelling the job aborts the run and does not turn cases into blocked results', async t => {
  const controller = new AbortController();
  const { worker } = await setup(t, (options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    controller.abort(new Error('Generator task cancelled'));
  }));
  await assert.rejects(worker(input, { signal: controller.signal, emit: () => {} }), /cancelled/);
});

test('the OpenAPI document describes this service and only its own routes', () => {
  const spec = JSON.parse(readFileSync(new URL('../generator/openapi.json', import.meta.url), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.security, []);
  assert.equal(spec.components.securitySchemes, undefined);
  assert.deepEqual(Object.keys(spec.paths).filter(p => p.startsWith('/v1')),
    ['/v1/generator/jobs', '/v1/generator/jobs/{jobId}', '/v1/generator/jobs/{jobId}/result', '/v1/generator/jobs/{jobId}/events']);
  assert.equal(spec.components.schemas.Job.properties.kind.const, 'generator');
  assert.equal(JSON.stringify(spec).includes('planner'), false);
  assert.deepEqual(Object.keys(SCRIPT_OUTPUT_SCHEMA.properties).sort(), ['code', 'deviations', 'explorationNotes', 'missingInputs', 'status', 'summary']);
});

test('the shared HTTP layer serves this service under its own base path', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'generator-http-test-'));
  const jobs = new Jobs({ dataDir, kind: 'generator', label: 'Generator',
    completion: result => ({ message: 'done', scriptsGenerated: result.generated }),
    worker: async () => formatResult([formatScript(output, input.cases[0])], { explorationNotes: '' }) });
  const server = createHttpServer({ jobs, validateInput, basePath: '/v1/generator',
    openapiPath: fileURLToPath(new URL('../generator/openapi.json', import.meta.url)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const url = p => `http://127.0.0.1:${server.address().port}${p}`;
  assert.equal((await fetch(url('/v1/planner/jobs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  const response = await fetch(url('/v1/generator/jobs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.kind, 'generator');
  assert.equal(response.headers.get('Location'), `/v1/generator/jobs/${job.id}`);
  await eventually(() => jobs.get(job.id).status === 'succeeded');
  const result = await (await fetch(url(`/v1/generator/jobs/${job.id}/result`))).json();
  assert.equal(result.scripts[0].fileName, 'TC-LOGIN-AUTH-FUNC-001.spec.ts');
  assert.equal(jobs.get(job.id).events.at(-1).scriptsGenerated, 1);
});
