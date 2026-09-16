import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASE_FIELDS, OUTPUT_SCHEMA, validateInput, formatResult, outputSchema } from '../planner/contract.mjs';
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
  assert.match(result.planMarkdown, /TC-LOGIN-001/);
  const spec = JSON.parse(readFileSync(new URL('../planner/openapi.json', import.meta.url)));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.components.schemas.Case.required, CASE_FIELDS);
  assert.deepEqual(Object.keys(spec.components.schemas.Case.properties), CASE_FIELDS);
});

test('rejects untraceable, duplicate and malformed generated cases', () => {
  for (const patch of [{ request: 'REQ-OTHER' }, { priority: 'P4' }, { steps: [] }, { steps: [{ step: '', expect: '显示表单' }] }, { steps: 'click login' }, { steps: [{ step: '打开登录页', expect: '' }] }, { name: '' }, { extra: 'field' }, { description: '模型不应填写' }]) {
    const custom = structuredClone(output); Object.assign(custom.cases[0], patch);
    assert.throws(() => formatResult(custom, input));
  }
  assert.throws(() => formatResult({ ...output, cases: [...output.cases, ...output.cases] }, input));
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
  const many = n => ({ ...output, cases: Array.from({ length: n }, (_, i) => ({ ...output.cases[0], case_id: `TC-${i}` })) });
  assert.equal(formatResult(many(5), { ...input, caseCount: 10 }).cases.length, 5);
  assert.equal(formatResult(many(10), { ...input, caseCount: 10 }).cases.length, 10);
  assert.throws(() => formatResult(many(4), { ...input, caseCount: 10 }), /5–10 cases/);
  assert.throws(() => formatResult(many(11), { ...input, caseCount: 10 }), /5–10 cases/);
  assert.equal(formatResult(many(1), { ...input, caseCount: 1 }).cases.length, 1);
});
