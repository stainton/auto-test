import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateInput } from '../planner/contract.mjs';
import { organizeSchema, formatOrganizeResult, buildOrganizePrompt, MAX_ORGANIZE_CASES } from '../planner/organize.mjs';
import { createPlannerWorker } from '../planner/worker.mjs';
import { createPlannerService } from '../planner/service.mjs';

const input = {
  target: { baseUrl: 'https://aigc.example.test/' },
  organize: {
    products: [{ code: 'AIGC', name: 'AIGC 平台', baseUrl: 'https://aigc.example.test/' },
      { code: 'JOY', name: 'JoyData', baseUrl: 'https://joy.example.test/', notes: '用同一个账号登录' }],
    cases: [{ id: 'TC-SYNC-ENTRY-FUNC-001', title: '资产操作菜单中同步至JoyData', folder: 'V1/一键同步', excerpt: '打开资产区' },
      { id: 'TC-SYNC2-ENTRY-FUNC-001', title: '批量同步至JoyData', folder: 'V2/同步' },
      { id: 'CASE-AB12CD', title: 'JoyData 接收同步文件' }],
    functions: [{ product: 'AIGC', code: 'ASYNC', path: ['资产区', '一键同步'] }]
  }
};
const output = {
  groups: [
    { product: 'AIGC', path: ['资产区', '一键同步'], function_code: 'SYNC', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001', 'TC-SYNC2-ENTRY-FUNC-001'] },
    { product: 'JOY', path: ['资产接收'], function_code: 'ASYNC', category: 'REL', cases: ['CASE-AB12CD'] }
  ],
  explorationNotes: '',
  limitations: []
};

test('an organize request takes products and cases instead of requirements', () => {
  assert.deepEqual(validateInput(input), input);
  for (const invalid of [
    { ...input, requirements: [{ id: 'R', title: 't', content: 'c' }] },
    { ...input, caseCount: 3 },
    { ...input, organize: { ...input.organize, products: [] } },
    { ...input, organize: { ...input.organize, products: [{ ...input.organize.products[0], code: 'a-b' }] } },
    { ...input, organize: { ...input.organize, products: [input.organize.products[0], input.organize.products[0]] } },
    { ...input, organize: { ...input.organize, products: [{ ...input.organize.products[0], baseUrl: 'file:///etc' }] } },
    { ...input, organize: { ...input.organize, cases: [...input.organize.cases, input.organize.cases[0]] } },
    { ...input, organize: { ...input.organize, cases: Array.from({ length: MAX_ORGANIZE_CASES + 1 }, (_, i) => ({ id: `C${i}`, title: 't' })) } },
    { ...input, organize: { ...input.organize, functions: [{ product: 'NOPE', code: 'ASSET', path: ['资产区'] }] } },
    { ...input, organize: { ...input.organize, functions: [{ product: 'AIGC', code: 'ASSET', path: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] } },
    { ...input, organize: { ...input.organize, extra: true } }
  ]) assert.throws(() => validateInput(invalid));
});

test('the schema only admits supplied products and case ids', () => {
  const schema = organizeSchema(input);
  const group = schema.properties.groups.items.properties;
  assert.deepEqual(group.product.enum, ['AIGC', 'JOY']);
  assert.deepEqual(group.cases.items.enum, input.organize.cases.map(c => c.id));
  assert.equal(JSON.parse(buildOrganizePrompt(input)).mode, 'organize');
});

test('assignments follow the supplied order; function codes are per product and settled functions keep theirs', () => {
  const result = formatOrganizeResult(output, input);
  // 资产区/一键同步 was settled as ASYNC, so the model's SYNC is overridden; JOY may reuse ASYNC for its own path.
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.product, a.functionCode, a.path.join('/'), a.category]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'AIGC', 'ASYNC', '资产区/一键同步', 'FUNC'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'AIGC', 'ASYNC', '资产区/一键同步', 'FUNC'],
    ['CASE-AB12CD', 'JOY', 'ASYNC', '资产接收', 'REL']]);
  assert.deepEqual(result.unassigned, []);
  assert.deepEqual(result.products, [{ code: 'AIGC', name: 'AIGC 平台' }, { code: 'JOY', name: 'JoyData' }]);
});

test('a code reused for another path gets a digit, a path given two codes keeps the first, leftovers are unassigned', () => {
  const result = formatOrganizeResult({ ...output, groups: [
    { product: 'AIGC', path: ['资产区', '搜索'], function_code: 'ASYNC', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: ['资产区', '一键同步'], function_code: 'OTHER', category: 'UX', cases: ['TC-SYNC2-ENTRY-FUNC-001', 'TC-SYNC-ENTRY-FUNC-001'] }
  ] }, input);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.functionCode, a.path.join('/'), a.category]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'ASYNC2', '资产区/搜索', 'FUNC'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'ASYNC', '资产区/一键同步', 'UX']]);
  assert.deepEqual(result.unassigned, ['CASE-AB12CD']);
  assert.throws(() => formatOrganizeResult({ ...output, groups: [] }, input), /none/);
  assert.throws(() => formatOrganizeResult({ ...output, groups: [{ ...output.groups[0], path: ['a/b'] }] }, input));
});

test('the worker runs organize with its own prompt, schema and result', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'planner-organize-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const worker = createPlannerWorker({ temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json',
    runtime: async options => {
      assert.match(options.systemPrompt, /ORGANIZE mode/);
      assert.ok(options.schema.properties.groups);
      assert.equal(JSON.parse(options.prompt).cases.length, 3);
      options.onMessage({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright-test', status: 'connected' }] });
      options.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'mcp__playwright-test__planner_setup_page', input: {} }] } });
      options.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's', content: 'Ready' }] } });
      return output;
    } });
  const result = await worker(validateInput(input), { signal: new AbortController().signal, emit() {} });
  assert.equal(result.mode, 'organize');
  assert.equal(result.assignments.length, 3);
});

// The job store reports a finished run in its completion event; an organize result has no cases to count.
test('an organize job succeeds through the planner service and keeps its result', async t => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'planner-organize-service-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const { jobs } = createPlannerService({ command: 'claude', concurrency: 1, workspaceRoot,
    playwrightPackage: '/runtime/node_modules/@playwright/test/package.json',
    runtime: async options => {
      options.onMessage({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright-test', status: 'connected' }] });
      options.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'mcp__playwright-test__planner_setup_page', input: {} }] } });
      options.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's', content: 'Ready' }] } });
      return output;
    } });
  t.after(() => jobs.close());
  const { id } = jobs.submit(validateInput(input));
  let job;
  for (let i = 0; i < 200 && !['succeeded', 'failed', 'cancelled'].includes((job = jobs.get(id)).status); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.assignments.length, 3);
  assert.equal(job.events.at(-1).casesClassified, 3);
});

// Dividing one existing folder further: the model returns only the levels below it.
test('a scoped run stays in the scope product and folder and returns paths relative to it', () => {
  const scoped = { ...input, organize: { ...input.organize, scope: { product: 'AIGC', path: ['资产区', '一键同步'] } } };
  assert.deepEqual(validateInput(scoped), scoped);
  for (const scope of [{ product: 'NOPE', path: [] }, { product: 'AIGC', path: ['a', 'b', 'c', 'd', 'e', 'f'] }, { product: 'AIGC', path: ['a/b'] }])
    assert.throws(() => validateInput({ ...input, organize: { ...input.organize, scope } }));
  const schema = organizeSchema(scoped).properties.groups.items.properties;
  assert.deepEqual(schema.product.enum, ['AIGC']);
  assert.equal(schema.path.minItems, 0);
  assert.equal(schema.path.maxItems, 4);
  assert.equal(JSON.parse(buildOrganizePrompt(scoped)).scope.product, 'AIGC');
  // A product-level scope still needs a module.
  assert.equal(organizeSchema({ ...input, organize: { ...input.organize, scope: { product: 'AIGC', path: [] } } }).properties.groups.items.properties.path.minItems, 1);

  const result = formatOrganizeResult({ ...output, groups: [
    { product: 'AIGC', path: ['菜单入口'], function_code: 'SYNCMENU', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: [], function_code: 'WHATEVER', category: 'REL', cases: ['TC-SYNC2-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: ['批量入口'], function_code: 'SYNCBATCH', category: 'FUNC', cases: ['CASE-AB12CD'] }
  ] }, scoped);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.path.join('/'), a.functionCode]), [
    ['TC-SYNC-ENTRY-FUNC-001', '资产区/一键同步/菜单入口', 'SYNCMENU'],
    ['TC-SYNC2-ENTRY-FUNC-001', '资产区/一键同步', 'ASYNC'], // the scope folder itself keeps its settled code
    ['CASE-AB12CD', '资产区/一键同步/批量入口', 'SYNCBATCH']]);
  assert.throws(() => formatOrganizeResult({ ...output, groups: [{ ...output.groups[1], path: [] }] }, scoped), /scope product/);
});
