import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateInput, outputSchema, formatResult, buildPrompt, MAX_CASES } from '../organizer/contract.mjs';
import { createOrganizerWorker } from '../organizer/worker.mjs';
import { createOrganizerService } from '../organizer/service.mjs';

const input = {
  target: { baseUrl: 'https://aigc.example.test/' },
    products: [{ code: 'AIGC', name: 'AIGC 平台', baseUrl: 'https://aigc.example.test/' },
      { code: 'JOY', name: 'JoyData', baseUrl: 'https://joy.example.test/', notes: '用同一个账号登录' }],
    cases: [{ id: 'TC-SYNC-ENTRY-FUNC-001', title: '资产操作菜单中同步至JoyData', folder: 'V1/一键同步', excerpt: '打开资产区' },
      { id: 'TC-SYNC2-ENTRY-FUNC-001', title: '批量同步至JoyData', folder: 'V2/同步' },
      { id: 'CASE-AB12CD', title: 'JoyData 接收同步文件' }],
    functions: [{ product: 'AIGC', code: 'ASYNC', path: ['资产区', '一键同步'] }]
};
const output = {
  groups: [
    { product: 'AIGC', path: ['资产区', '一键同步'], function_code: 'SYNC', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001', 'TC-SYNC2-ENTRY-FUNC-001'] },
    { product: 'JOY', path: ['资产接收'], function_code: 'ASYNC', category: 'REL', cases: ['CASE-AB12CD'] }
  ],
  explorationNotes: '',
  limitations: []
};

test('a request takes products, cases and a target, nothing else', () => {
  assert.deepEqual(validateInput(input), input);
  for (const invalid of [
    { ...input, requirements: [{ id: 'R', title: 't', content: 'c' }] },
    { ...input, caseCount: 3 },
    { ...input, target: { baseUrl: 'file:///etc/passwd' } },
    { ...input, context: { assets: [] } },
    { ...input, products: [] },
    { ...input, products: [{ ...input.products[0], code: 'a-b' }] },
    { ...input, products: [input.products[0], input.products[0]] },
    { ...input, products: [{ ...input.products[0], baseUrl: 'file:///etc' }] },
    { ...input, cases: [...input.cases, input.cases[0]] },
    { ...input, cases: Array.from({ length: MAX_CASES + 1 }, (_, i) => ({ id: `C${i}`, title: 't' })) },
    { ...input, functions: [{ product: 'NOPE', code: 'ASSET', path: ['资产区'] }] },
    { ...input, functions: [{ product: 'AIGC', code: 'ASSET', path: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] },
    { ...input, extra: true }
  ]) assert.throws(() => validateInput(invalid));
});

test('the schema only admits supplied products and case ids', () => {
  const schema = outputSchema(input);
  const group = schema.properties.groups.items.properties;
  assert.deepEqual(group.product.enum, ['AIGC', 'JOY']);
  assert.deepEqual(group.cases.items.enum, input.cases.map(c => c.id));
  assert.deepEqual(JSON.parse(buildPrompt(input)).cases, input.cases);
});

test('assignments follow the supplied order; function codes are per product and settled functions keep theirs', () => {
  const result = formatResult(output, input);
  // 资产区/一键同步 was settled as ASYNC, so the model's SYNC is overridden; JOY may reuse ASYNC for its own path.
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.product, a.functionCode, a.path.join('/'), a.category]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'AIGC', 'ASYNC', '资产区/一键同步', 'FUNC'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'AIGC', 'ASYNC', '资产区/一键同步', 'FUNC'],
    ['CASE-AB12CD', 'JOY', 'ASYNC', '资产接收', 'REL']]);
  assert.deepEqual(result.unassigned, []);
  assert.deepEqual(result.products, [{ code: 'AIGC', name: 'AIGC 平台' }, { code: 'JOY', name: 'JoyData' }]);
});

test('a code reused for another path gets a digit, a path given two codes keeps the first, leftovers are unassigned', () => {
  const result = formatResult({ ...output, groups: [
    { product: 'AIGC', path: ['资产区', '搜索'], function_code: 'ASYNC', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: ['资产区', '一键同步'], function_code: 'OTHER', category: 'UX', cases: ['TC-SYNC2-ENTRY-FUNC-001', 'TC-SYNC-ENTRY-FUNC-001'] }
  ] }, input);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.functionCode, a.path.join('/'), a.category]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'ASYNC2', '资产区/搜索', 'FUNC'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'ASYNC', '资产区/一键同步', 'UX']]);
  assert.deepEqual(result.unassigned, ['CASE-AB12CD']);
  assert.throws(() => formatResult({ ...output, groups: [] }, input), /none/);
  assert.throws(() => formatResult({ ...output, groups: [{ ...output.groups[0], path: ['a/b'] }] }, input));
});

test('the worker runs with its own prompt, schema and result', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'organizer-worker-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const worker = createOrganizerWorker({ temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json',
    runtime: async options => {
      assert.match(options.systemPrompt, /test-case organizer/);
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

// The job store reports a finished run in its completion event by classified cases.
test('a job succeeds through the organizer service and keeps its result', async t => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'organizer-service-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const { jobs } = createOrganizerService({ command: 'claude', concurrency: 1, workspaceRoot,
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
  const scoped = { ...input, scope: { product: 'AIGC', path: ['资产区', '一键同步'] } };
  assert.deepEqual(validateInput(scoped), scoped);
  for (const scope of [{ product: 'NOPE', path: [] }, { product: 'AIGC', path: ['a', 'b', 'c', 'd', 'e', 'f'] }, { product: 'AIGC', path: ['a/b'] }])
    assert.throws(() => validateInput({ ...input, scope }));
  const schema = outputSchema(scoped).properties.groups.items.properties;
  assert.deepEqual(schema.product.enum, ['AIGC']);
  assert.equal(schema.path.minItems, 0);
  assert.equal(schema.path.maxItems, 2, 'default depth limit');
  assert.equal(JSON.parse(buildPrompt(scoped)).scope.product, 'AIGC');
  // A product-level scope still needs a module.
  assert.equal(outputSchema({ ...input, scope: { product: 'AIGC', path: [] } }).properties.groups.items.properties.path.minItems, 1);

  const result = formatResult({ ...output, groups: [
    { product: 'AIGC', path: ['菜单入口'], function_code: 'SYNCMENU', category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: [], function_code: 'WHATEVER', category: 'REL', cases: ['TC-SYNC2-ENTRY-FUNC-001'] },
    { product: 'AIGC', path: ['批量入口'], function_code: 'SYNCBATCH', category: 'FUNC', cases: ['CASE-AB12CD'] }
  ] }, scoped);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.path.join('/'), a.functionCode]), [
    ['TC-SYNC-ENTRY-FUNC-001', '资产区/一键同步/菜单入口', 'SYNCMENU'],
    ['TC-SYNC2-ENTRY-FUNC-001', '资产区/一键同步', 'ASYNC'], // the scope folder itself keeps its settled code
    ['CASE-AB12CD', '资产区/一键同步/批量入口', 'SYNCBATCH']]);
  assert.throws(() => formatResult({ ...output, groups: [{ ...output.groups[1], path: [] }] }, scoped), /scope product/);
});

test('a scoped run holds the sub-folder count and depth limits whatever the model returns', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `TC-AIGC-ASRCH-REL-00${i + 1}`);
  const scoped = { ...input, products: input.products, functions: [{ product: 'AIGC', code: 'ASRCH', path: ['资产区', '搜索'] }],
    cases: [...ids.map(id => ({ id, title: id })), { id: 'CASE-LEFT', title: '没被归类' }],
    scope: { product: 'AIGC', path: ['资产区', '搜索'], maxChildren: 2, maxDepth: 1 } };
  assert.deepEqual(validateInput(scoped), scoped);
  for (const limits of [{ maxChildren: 0 }, { maxChildren: 31 }, { maxDepth: 0 }, { maxDepth: 5 }, { maxChildren: 1.5 }])
    assert.throws(() => validateInput({ ...scoped, scope: { ...scoped.scope, ...limits } }));
  assert.equal(outputSchema(scoped).properties.groups.items.properties.path.maxItems, 1);
  const group = (path, code, cases) => ({ product: 'AIGC', path, function_code: code, category: 'FUNC', cases });
  const result = formatResult({ ...output, groups: [
    group(['关键词', '精确匹配'], 'AKEY', ids.slice(0, 3)), // deeper than maxDepth 1: trimmed to 关键词
    group(['标签'], 'ATAG', ids.slice(3, 5)),
    group(['分页'], 'APAGE', ids.slice(5, 6)),              // third sub-folder over maxChildren 2: the smallest moves up
    group([], 'ASRCH', ids.slice(6, 9))
  ] }, scoped);
  const where = Object.fromEntries(result.assignments.map(a => [a.caseId, `${a.path.join('/')} ${a.functionCode} ${a.category}`]));
  assert.equal(where[ids[0]], '资产区/搜索/关键词 AKEY FUNC');
  assert.equal(where[ids[3]], '资产区/搜索/标签 ATAG FUNC');
  assert.equal(where[ids[5]], '资产区/搜索 ASRCH FUNC');
  assert.equal(where['CASE-LEFT'], '资产区/搜索 ASRCH FUNC', 'a case the model left out stays in the folder itself');
  assert.deepEqual(result.leftInScope, ['CASE-LEFT']);
  assert.deepEqual(result.unassigned, []);
  assert.deepEqual(result.capped, [{ path: ['资产区', '搜索'], merged: ['分页'] }]);
  const children = new Set(result.assignments.filter(a => a.path.length > 2).map(a => a.path[2]));
  assert.ok(children.size <= 2 && result.assignments.every(a => a.path.length <= 3));
  // Defaults: 8 sub-folders, 2 levels.
  const wide = { ...scoped, scope: { product: 'AIGC', path: ['资产区'] } };
  const many = formatResult({ ...output, groups: ids.map((id, i) => group([`功能${i}`, '子', '孙'], `F${i}X`, [id])) }, wide);
  assert.equal(new Set(many.assignments.filter(a => a.path.length > 1).map(a => a.path[1])).size, 8);
  assert.ok(many.assignments.every(a => a.path.length <= 3));
});

// In the planner's process the organizer owns /v1/organizer/*, and the planner keeps everything else.
test('the organizer is routed beside the planner in one process', async t => {
  const { createPlannerService } = await import('../planner/service.mjs');
  const { createRoutedServer } = await import('../shared/http.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'organizer-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = { command: 'claude', concurrency: 1, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json', runtime: async () => output };
  const organizer = createOrganizerService({ ...common, workspaceRoot: path.join(root, 'o') });
  const planner = createPlannerService({ ...common, workspaceRoot: path.join(root, 'p') });
  const server = createRoutedServer([organizer, planner]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); organizer.jobs.close(); planner.jobs.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const kind of ['organizer', 'planner']) assert.equal((await fetch(`${base}/v1/${kind}/capacity`)).status, 200, kind);
  // A planner request is a planner request again: products/cases are not part of its contract.
  const rejected = await fetch(`${base}/v1/planner/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, organize: {} }) });
  assert.equal(rejected.status, 400);
  const accepted = await fetch(`${base}/v1/organizer/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(accepted.status, 202);
});
