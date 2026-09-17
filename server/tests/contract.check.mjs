import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASE_FIELDS, OUTPUT_SCHEMA, CASE_ID_RE, validateInput, formatResult, outputSchema, requirementCode } from '../planner/contract.mjs';
import { buildPrompt } from '../planner/prompt.mjs';
import { input, output } from './fixtures.mjs';

test('rejects missing documents, local file paths, duplicate requirement IDs and unsupported options', () => {
  assert.deepEqual(validateInput(input), input);
  for (const invalid of [ {}, { ...input, requirements: [] }, { ...input, requirements: [...input.requirements, ...input.requirements] },
    { ...input, requirements: [{ ...input.requirements[0], id: '-' }] },
    { ...input, target: { baseUrl: 'file:///etc/passwd' } },
    { ...input, target: { ...input.target, storageState: '/local/auth.json' } },
    { ...input, mcpConfig: { command: 'arbitrary-command' } } ]) assert.throws(() => validateInput(invalid));
});

test('returns exact case fields and escaped Markdown in original model order', () => {
  const custom = structuredClone(output);
  custom.cases[0].name = '拒绝 | <script> &';
  const result = formatResult(custom, input);
  assert.deepEqual(Object.keys(result.cases[0]), CASE_FIELDS);
  assert.equal(result.cases[0].description, '', 'description is reserved for human reviewers');
  assert.equal(result.reviewStatus, 'draft');
  assert.ok(result.casesMarkdown.startsWith(`| ${CASE_FIELDS.join(' | ')} |`));
  assert.match(result.casesMarkdown, /拒绝 &#124; &lt;script&gt; &amp;/);
  assert.match(result.casesMarkdown, /登录页<br>2\./);
  assert.match(result.planMarkdown, /TC-REQ001-AUTH-FUNC-001/);
  const spec = JSON.parse(readFileSync(new URL('../planner/openapi.json', import.meta.url)));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.components.schemas.Case.required, CASE_FIELDS);
  assert.deepEqual(Object.keys(spec.components.schemas.Case.properties), CASE_FIELDS);
});

test('rejects untraceable, duplicate and malformed generated cases', () => {
  for (const patch of [{ request: 'REQ-OTHER' }, { priority: 'P4' }, { steps: [] }, { steps: [{ step: '', expect: '显示表单' }] }, { steps: 'click login' }, { steps: [{ step: '打开登录页', expect: '' }] }, { name: '' }, { extra: 'field' }, { case_id: 'TC-X-001' }, { module_code: 'auth' }, { module_code: 'AU-TH' }, { category: 'FUNCTIONAL' }, { description: '模型不应填写' }]) {
    const custom = structuredClone(output); Object.assign(custom.cases[0], patch);
    assert.throws(() => formatResult(custom, input));
  }
  // identical cases no longer collide: the server numbers them
  assert.deepEqual(formatResult({ ...output, cases: [...output.cases, ...output.cases] }, input).cases.map(c => c.case_id),
    ['TC-REQ001-AUTH-FUNC-001', 'TC-REQ001-AUTH-FUNC-002']);
  assert.throws(() => formatResult({ ...output, cases: [] }, input));
});

test('caseCount bounds the planner to [caseCount-5, caseCount] cases', () => {
  assert.deepEqual(validateInput({ ...input, caseCount: 10 }).caseCount, 10);
  for (const caseCount of [0, -1, 1.5, '10', 501]) assert.throws(() => validateInput({ ...input, caseCount }));
  assert.equal(outputSchema(input), OUTPUT_SCHEMA);
  const schema = outputSchema({ ...input, caseCount: 10 });
  assert.equal(schema.properties.cases.minItems, 5);
  assert.equal(schema.properties.cases.maxItems, 10);
  assert.equal(OUTPUT_SCHEMA.properties.cases.minItems, 1, 'shared schema must not be mutated');
  assert.equal(outputSchema({ ...input, caseCount: 3 }).properties.cases.minItems, 1);
  assert.deepEqual(JSON.parse(buildPrompt({ ...input, caseCount: 10 })).caseCountRange, { min: 5, max: 10 });
  assert.equal(JSON.parse(buildPrompt(input)).caseCountRange, undefined);
  const many = n => ({ ...output, cases: Array.from({ length: n }, () => structuredClone(output.cases[0])) });
  assert.equal(formatResult(many(5), { ...input, caseCount: 10 }).cases.length, 5);
  assert.equal(formatResult(many(10), { ...input, caseCount: 10 }).cases.length, 10);
  assert.throws(() => formatResult(many(4), { ...input, caseCount: 10 }), /5–10 cases/);
  assert.throws(() => formatResult(many(11), { ...input, caseCount: 10 }), /5–10 cases/);
  assert.equal(formatResult(many(1), { ...input, caseCount: 1 }).cases.length, 1);
});

test('limitations are short risk-tagged summaries ordered from high to low risk', () => {
  const lim = (risk, summary) => ({ risk, summary });
  const result = formatResult({ ...output, limitations: [lim('low', '未验证深色模式显示'), lim('high', '未验证短信验证码登录：缺少测试手机号'),
    lim('medium', '未验证密码长度边界'), lim('high', ' 未验证单点登录跳转 ')] }, input);
  assert.deepEqual(result.limitations, [lim('high', '未验证短信验证码登录：缺少测试手机号'), lim('high', '未验证单点登录跳转'),
    lim('medium', '未验证密码长度边界'), lim('low', '未验证深色模式显示')]);
  for (const limitations of [['plain string'], [lim('critical', 'x')], [lim('high', '')], [lim('high', '长'.repeat(41))], [{ ...lim('low', 'x'), extra: 1 }]])
    assert.throws(() => formatResult({ ...output, limitations }, input));
  assert.equal(formatResult({ ...output, limitations: [lim('low', '长'.repeat(40))] }, input).limitations.length, 1);
  const item = OUTPUT_SCHEMA.properties.limitations.items;
  assert.equal(item.properties.summary.maxLength, 40);
  assert.deepEqual(item.properties.risk.enum, ['high', 'medium', 'low']);
});

test('case_id is assigned as TC-<requirement code>-<module>-<category>-NNN, counting per prefix', () => {
  assert.equal(requirementCode({ id: 'REQ-001' }), 'REQ001');
  assert.equal(requirementCode({ id: '42' }), 'R42');
  assert.equal(validateInput({ ...input, requirements: [{ ...input.requirements[0], code: 'LOGIN' }] }).requirements[0].code, 'LOGIN');
  for (const code of ['login', 'LO-GIN', 'L', 'LOGINLOGINLOGIN', 1])
    assert.throws(() => validateInput({ ...input, requirements: [{ ...input.requirements[0], code }] }));
  const withCode = { ...input, requirements: [{ ...input.requirements[0], code: 'LOGIN' }] };
  const c = patch => ({ ...structuredClone(output.cases[0]), ...patch });
  const result = formatResult({ ...output, cases: [c({}), c({ category: 'SEC' }), c({}), c({ module_code: 'RESET' }), c({ category: 'SEC' })] }, withCode);
  assert.deepEqual(result.cases.map(x => x.case_id),
    ['TC-LOGIN-AUTH-FUNC-001', 'TC-LOGIN-AUTH-SEC-001', 'TC-LOGIN-AUTH-FUNC-002', 'TC-LOGIN-RESET-FUNC-001', 'TC-LOGIN-AUTH-SEC-002']);
  for (const x of result.cases) assert.match(x.case_id, CASE_ID_RE);
  assert.equal(formatResult(output, input).cases[0].case_id, 'TC-REQ001-AUTH-FUNC-001');
  const item = OUTPUT_SCHEMA.properties.cases.items;
  assert.ok(!item.required.includes('case_id'));
  assert.deepEqual(item.properties.category.enum, ['FUNC', 'REL', 'PERF', 'SEC', 'COMPAT', 'UX']);
});
