import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASE_FIELDS, validateInput, formatResult } from '../planner/contract.mjs';
import { input, output } from './fixtures.mjs';

test('rejects missing documents, local file paths, duplicate requirement IDs and unsupported options', () => {
  assert.deepEqual(validateInput(input), input);
  for (const invalid of [ {}, { ...input, requirements: [] }, { ...input, requirements: [...input.requirements, ...input.requirements] },
    { ...input, requirements: [{ ...input.requirements[0], id: '-' }] },
    { ...input, target: { baseUrl: 'file:///etc/passwd' } },
    { ...input, target: { baseUrl: 'https://user:pass@example.test' } },
    { ...input, target: { ...input.target, storageState: '/local/auth.json' } },
    { ...input, mcpConfig: { command: 'arbitrary-command' } } ]) assert.throws(() => validateInput(invalid));
});

test('returns exact case fields and escaped Markdown in original model order', () => {
  const custom = structuredClone(output);
  custom.cases[0].name = '拒绝 | <script> &';
  const result = formatResult(custom, input);
  assert.deepEqual(Object.keys(result.cases[0]), CASE_FIELDS);
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
  for (const patch of [{ request: 'REQ-OTHER' }, { priority: 'P4' }, { steps: 'click login' }, { expects: '1. ' }, { steps: '2. Start' }, { expects: '99. Not a step' }, { name: '' }, { extra: 'field' }]) {
    const custom = structuredClone(output); Object.assign(custom.cases[0], patch);
    assert.throws(() => formatResult(custom, input));
  }
  assert.throws(() => formatResult({ ...output, cases: [...output.cases, ...output.cases] }, input));
  assert.throws(() => formatResult({ ...output, cases: [] }, input));
});
