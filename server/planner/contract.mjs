export const CASE_FIELDS = ['request', 'name', 'case_id', 'priority', 'precondition', 'description', 'steps', 'expects'];
// Fields kept in the wire format (test-model.md column order) but reserved for people: the model is never
// asked for them and they are always emitted empty. description is the case summary a reviewer writes
// after reading the case during review, so a model-written guess would only be noise to overwrite.
export const HUMAN_CASE_FIELDS = ['description'];

// case_id is assigned by formatResult, never written by the model:
//   TC-<requirement code>-<module code>-<category>-<NNN>, NNN counting up per prefix from 001.
// Codes are uppercase ASCII with no "-" so the ID splits back into its parts (CaseHub builds the review
// folders REQ / REQ-MOD / REQ-MOD-CAT from it and continues the numbering on import).
export const CODE_PATTERN = '^[A-Z][A-Z0-9]{1,11}$';
const CODE_RE = new RegExp(CODE_PATTERN);
export const TEST_CATEGORIES = { FUNC: '功能', REL: '可靠性', PERF: '性能', SEC: '安全', COMPAT: '兼容性', UX: '易用性' };
export const CASE_ID_RE = /^TC-([A-Z][A-Z0-9]{1,11})-([A-Z][A-Z0-9]{1,11})-(FUNC|REL|PERF|SEC|COMPAT|UX)-(\d{3,})$/;
// Fallback when a caller doesn't confirm a requirement code: derive one from the requirement id.
export function requirementCode(req) {
  if (req.code) return req.code;
  let code = req.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!/^[A-Z]/.test(code)) code = `R${code}`.slice(0, 12);
  return code.length >= 2 ? code : `${code}X`;
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function check(condition, message) { if (!condition) throw new Error(message); }
function string(value, name, max = 200000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} must be a nonempty string (max ${max} characters)`);
  return value;
}
function keys(value, allowed, name) {
  check(object(value), `${name} must be an object`);
  check(Object.keys(value).every(key => allowed.includes(key)), `${name} contains unsupported fields`);
}

export function validateRequirements(requirements) {
  check(Array.isArray(requirements) && requirements.length > 0 && requirements.length <= 50, 'requirements must contain 1–50 documents');
  const ids = new Set();
  for (const req of requirements) {
    keys(req, ['id', 'title', 'content', 'code'], 'requirement');
    if (req.code !== undefined) check(typeof req.code === 'string' && CODE_RE.test(req.code), `requirement.code must match ${CODE_PATTERN}`);
    string(req.id, 'requirement.id', 128);
    check(req.id !== '-' && !ids.has(req.id), 'requirement IDs must be unique and cannot be "-"');
    ids.add(req.id);
    string(req.title, 'requirement.title', 500);
    string(req.content, 'requirement.content');
  }
}

// caseCount is the caller-confirmed "建议覆盖用例数量" (normally prefilled from /v1/planner/estimate and
// adjusted by a person). The planner must then return between caseCount-5 and caseCount cases.
export const MAX_CASES = 500;
export const CASE_COUNT_SLACK = 5;
export function caseCountRange(caseCount) {
  return { min: Math.max(1, caseCount - CASE_COUNT_SLACK), max: caseCount };
}
export function validateCaseCount(value, name = 'caseCount') {
  check(Number.isSafeInteger(value) && value >= 1 && value <= MAX_CASES, `${name} must be an integer between 1 and ${MAX_CASES}`);
  return value;
}

export function validateInput(input) {
  keys(input, ['requirements', 'target', 'context', 'caseCount'], 'request');
  validateRequirements(input.requirements);
  if (input.caseCount !== undefined) validateCaseCount(input.caseCount);
  keys(input.target, ['baseUrl', 'storageState', 'extraHTTPHeaders'], 'target');
  const url = new URL(string(input.target.baseUrl, 'target.baseUrl', 4096));
  check(['http:', 'https:'].includes(url.protocol), 'target.baseUrl must be HTTP(S)');
  if (input.target.storageState !== undefined) {
    const state = input.target.storageState;
    keys(state, ['cookies', 'origins'], 'target.storageState');
    check(Array.isArray(state.cookies) && Array.isArray(state.origins), 'storageState requires cookies and origins arrays; file paths are not accepted');
    for (const cookie of state.cookies) {
      check(object(cookie) && ['name', 'value', 'domain', 'path'].every(k => typeof cookie[k] === 'string') &&
        Number.isFinite(cookie.expires) && typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean' &&
        ['Strict', 'Lax', 'None'].includes(cookie.sameSite), 'invalid storageState cookie');
    }
    for (const origin of state.origins) {
      check(object(origin) && typeof origin.origin === 'string' && Array.isArray(origin.localStorage), 'invalid storageState origin');
      for (const entry of origin.localStorage) check(object(entry) && typeof entry.name === 'string' && typeof entry.value === 'string', 'invalid localStorage entry');
    }
  }
  if (input.target.extraHTTPHeaders !== undefined) {
    check(object(input.target.extraHTTPHeaders) && Object.values(input.target.extraHTTPHeaders).every(v => typeof v === 'string'), 'extraHTTPHeaders must contain string values');
  }
  if (input.context !== undefined) {
    keys(input.context, ['explorationNotes', 'knownIssues', 'instructions', 'testData'], 'context');
    for (const key of ['explorationNotes', 'knownIssues', 'instructions']) {
      if (input.context[key] !== undefined) check(typeof input.context[key] === 'string' && input.context[key].length <= 200000, `context.${key} must be a string (max 200000 characters)`);
    }
    if (input.context.testData !== undefined) check(object(input.context.testData), 'context.testData must be an object');
  }
  return structuredClone(input);
}

// The model produces one array of {step, expect} pairs instead of two parallel arrays: JSON Schema
// cannot express "these two arrays have equal length", so asking for separate steps/expects arrays
// (even structurally, as arrays rather than prose) still lets the model emit mismatched counts, which
// used to fail the whole job post-hoc in formatResult() after a full (expensive) exploration run.
// Pairing them in one array makes a mismatch structurally impossible. formatResult() below splits the
// pairs back into the two numbered-line strings that stay the documented wire format (openapi.json,
// casehub, test-model.md) — only the model-facing shape changes.
const STEP_LIST = { type: 'array', minItems: 1, maxItems: 50, items: {
  type: 'object', additionalProperties: false, required: ['step', 'expect'],
  properties: { step: { type: 'string', minLength: 1 }, expect: { type: 'string', minLength: 1 } } } };
const MODEL_CASE_FIELDS = [...CASE_FIELDS.filter(field => !['expects', 'case_id'].includes(field) && !HUMAN_CASE_FIELDS.includes(field)),
  'module_code', 'category'];
// limitations are read by a non-technical reviewer right after the draft is imported, so the model writes
// each as a short plain-language summary with a risk level (hard caps below, not prose limits the model can
// drift past), and formatResult orders them from highest to lowest risk.
export const LIMITATION_MAX_CHARS = 40;
export const LIMITATION_RISKS = ['high', 'medium', 'low'];
const LIMITATION = { type: 'object', additionalProperties: false, required: ['risk', 'summary'],
  properties: { risk: { type: 'string', enum: LIMITATION_RISKS },
    summary: { type: 'string', minLength: 1, maxLength: LIMITATION_MAX_CHARS } } };
export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['cases', 'explorationNotes', 'limitations'],
  properties: {
    cases: { type: 'array', minItems: 1, maxItems: MAX_CASES, items: {
      type: 'object', additionalProperties: false, required: MODEL_CASE_FIELDS,
      properties: Object.fromEntries(MODEL_CASE_FIELDS.map(field => [field,
        field === 'priority' ? { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }
        : field === 'steps' ? STEP_LIST
        : field === 'module_code' ? { type: 'string', pattern: CODE_PATTERN }
        : field === 'category' ? { type: 'string', enum: Object.keys(TEST_CATEGORIES) }
        : { type: 'string', minLength: 1 }]))
    } },
    explorationNotes: { type: 'string' },
    limitations: { type: 'array', maxItems: 20, items: LIMITATION }
  }
};
// Per-job schema: a confirmed caseCount narrows the cases array so the runtime rejects an out-of-range
// draft while the model can still fix it, instead of failing the job after the expensive exploration.
export function outputSchema(input) {
  if (input?.caseCount === undefined) return OUTPUT_SCHEMA;
  const { min, max } = caseCountRange(input.caseCount);
  const schema = structuredClone(OUTPUT_SCHEMA);
  Object.assign(schema.properties.cases, { minItems: min, maxItems: max });
  return schema;
}
const numberedLines = list => list.map((line, index) => `${index + 1}. ${line}`).join('\n');

const cell = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r\n|\r|\n/g, '<br>');
export function formatResult(output, input) {
  check(Buffer.byteLength(JSON.stringify(output) ?? '') <= 2 * 1024 * 1024, 'planner structured output exceeds 2 MiB');
  keys(output, ['cases', 'explorationNotes', 'limitations'], 'planner output');
  check(Array.isArray(output.cases) && output.cases.length > 0 && output.cases.length <= MAX_CASES, `planner must return 1–${MAX_CASES} cases`);
  if (input.caseCount !== undefined) {
    const { min, max } = caseCountRange(input.caseCount);
    check(output.cases.length >= min && output.cases.length <= max,
      `planner must return ${min}–${max} cases for caseCount ${input.caseCount}, got ${output.cases.length}`);
  }
  const requirements = new Map(input.requirements.map(r => [r.id, requirementCode(r)])), sequence = new Map();
  const cases = output.cases.map(item => {
    keys(item, MODEL_CASE_FIELDS, 'case');
    for (const field of MODEL_CASE_FIELDS) {
      if (field === 'steps') {
        check(Array.isArray(item.steps) && item.steps.length >= 1 && item.steps.length <= 50 &&
          item.steps.every(s => object(s) && typeof s.step === 'string' && s.step.trim().length > 0 &&
            typeof s.expect === 'string' && s.expect.trim().length > 0),
          'case.steps must be a non-empty array of {step, expect} entries with non-empty text');
      } else {
        string(item[field], `case.${field}`);
      }
    }
    check(requirements.has(item.request), 'case.request must reference a supplied requirement');
    check(['P0', 'P1', 'P2', 'P3'].includes(item.priority), 'invalid priority');
    check(CODE_RE.test(item.module_code), `case.module_code must match ${CODE_PATTERN}`);
    check(Object.hasOwn(TEST_CATEGORIES, item.category), 'invalid case.category');
    const prefix = `TC-${requirements.get(item.request)}-${item.module_code}-${item.category}`;
    const n = (sequence.get(prefix) ?? 0) + 1; sequence.set(prefix, n);
    const caseId = `${prefix}-${String(n).padStart(3, '0')}`;
    return Object.fromEntries(CASE_FIELDS.map(field => [field,
      field === 'case_id' ? caseId :
      field === 'steps' ? numberedLines(item.steps.map(s => s.step))
      : field === 'expects' ? numberedLines(item.steps.map(s => s.expect))
      : HUMAN_CASE_FIELDS.includes(field) ? ''
      : item[field]]));
  });
  check(typeof output.explorationNotes === 'string', 'explorationNotes must be a string');
  check(Array.isArray(output.limitations) && output.limitations.every(v => object(v) && Object.keys(v).every(k => ['risk', 'summary'].includes(k)) &&
    LIMITATION_RISKS.includes(v.risk) && typeof v.summary === 'string' && v.summary.trim().length > 0 && [...v.summary].length <= LIMITATION_MAX_CHARS),
    `limitations must be {risk: high|medium|low, summary (max ${LIMITATION_MAX_CHARS} characters)} entries`);
  // Array.prototype.sort is stable, so equal-risk entries keep the model's order.
  const limitations = output.limitations.map(({ risk, summary }) => ({ risk, summary: summary.trim() }))
    .sort((a, b) => LIMITATION_RISKS.indexOf(a.risk) - LIMITATION_RISKS.indexOf(b.risk));
  const casesMarkdown = [
    `| ${CASE_FIELDS.join(' | ')} |`,
    `| ${CASE_FIELDS.map(() => '---').join(' | ')} |`,
    ...cases.map(item => `| ${CASE_FIELDS.map(field => cell(item[field])).join(' | ')} |`)
  ].join('\n');
  const planMarkdown = ['# Test Plan (draft)', ...cases.map((c, i) =>
    `\n## ${i + 1}. ${c.name}\n\nRequirement: ${c.request}\n\nCase ID: ${c.case_id}\n\nPriority: ${c.priority}\n\n### Preconditions\n${c.precondition}\n\n### Steps\n${c.steps}\n\n### Expected results\n${c.expects}`)].join('\n');
  return { reviewStatus: 'draft', cases, casesMarkdown, planMarkdown, explorationNotes: output.explorationNotes, limitations };
}
