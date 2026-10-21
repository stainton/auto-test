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
    modules: [{ product: 'AIGC', code: 'ASSET', name: '资产区' }]
  }
};
const output = {
  groups: [
    { product: 'AIGC', module_code: 'ASSET', folders: ['资产区', '同步至JoyData'], category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001', 'TC-SYNC2-ENTRY-FUNC-001'] },
    { product: 'JOY', module_code: 'ASSET', folders: ['资产接收'], category: 'FUNC', cases: ['CASE-AB12CD'] }
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
    { ...input, organize: { ...input.organize, modules: [{ product: 'NOPE', code: 'ASSET', name: '资产区' }] } },
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

test('assignments follow the supplied order; module codes are per product and settled modules keep theirs', () => {
  const result = formatOrganizeResult(output, input);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.product, a.moduleCode, a.folders.join('/')]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'AIGC', 'ASSET', '资产区/同步至JoyData'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'AIGC', 'ASSET', '资产区/同步至JoyData'],
    ['CASE-AB12CD', 'JOY', 'ASSET', '资产接收']]);
  assert.deepEqual(result.unassigned, []);
  assert.deepEqual(result.products, [{ code: 'AIGC', name: 'AIGC 平台' }, { code: 'JOY', name: 'JoyData' }]);
});

test('a code reused for another module gets a digit, a name given two codes keeps the first, leftovers are unassigned', () => {
  const result = formatOrganizeResult({ ...output, groups: [
    { product: 'AIGC', module_code: 'ASSET', folders: ['素材库'], category: 'FUNC', cases: ['TC-SYNC-ENTRY-FUNC-001'] },
    { product: 'AIGC', module_code: 'SYNC', folders: ['资产区'], category: 'UX', cases: ['TC-SYNC2-ENTRY-FUNC-001', 'TC-SYNC-ENTRY-FUNC-001'] }
  ] }, input);
  assert.deepEqual(result.assignments.map(a => [a.caseId, a.moduleCode, a.folders[0], a.category]), [
    ['TC-SYNC-ENTRY-FUNC-001', 'ASSET2', '素材库', 'FUNC'],
    ['TC-SYNC2-ENTRY-FUNC-001', 'ASSET', '资产区', 'UX']]);
  assert.deepEqual(result.unassigned, ['CASE-AB12CD']);
  assert.throws(() => formatOrganizeResult({ ...output, groups: [] }, input), /none/);
  assert.throws(() => formatOrganizeResult({ ...output, groups: [{ ...output.groups[0], folders: ['a/b'] }] }, input));
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
