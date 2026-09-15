export const CASE_FIELDS = ['request', 'name', 'case_id', 'priority', 'precondition', 'description', 'steps', 'expects'];
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

export function validateInput(input) {
  keys(input, ['requirements', 'target', 'context'], 'request');
  check(Array.isArray(input.requirements) && input.requirements.length > 0 && input.requirements.length <= 50, 'requirements must contain 1–50 documents');
  const ids = new Set();
  for (const req of input.requirements) {
    keys(req, ['id', 'title', 'content'], 'requirement');
    string(req.id, 'requirement.id', 128);
    check(req.id !== '-' && !ids.has(req.id), 'requirement IDs must be unique and cannot be "-"');
    ids.add(req.id);
    string(req.title, 'requirement.title', 500);
    string(req.content, 'requirement.content');
  }
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
const MODEL_CASE_FIELDS = CASE_FIELDS.filter(field => field !== 'expects');
export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['cases', 'explorationNotes', 'limitations'],
  properties: {
    cases: { type: 'array', minItems: 1, maxItems: 500, items: {
      type: 'object', additionalProperties: false, required: MODEL_CASE_FIELDS,
      properties: Object.fromEntries(MODEL_CASE_FIELDS.map(field => [field,
        field === 'priority' ? { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }
        : field === 'steps' ? STEP_LIST
        : { type: 'string', minLength: 1 }]))
    } },
    explorationNotes: { type: 'string' },
    limitations: { type: 'array', items: { type: 'string' } }
  }
};
const numberedLines = list => list.map((line, index) => `${index + 1}. ${line}`).join('\n');

const cell = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r\n|\r|\n/g, '<br>');
export function formatResult(output, input) {
  check(Buffer.byteLength(JSON.stringify(output) ?? '') <= 2 * 1024 * 1024, 'planner structured output exceeds 2 MiB');
  keys(output, ['cases', 'explorationNotes', 'limitations'], 'planner output');
  check(Array.isArray(output.cases) && output.cases.length > 0 && output.cases.length <= 500, 'planner must return 1–500 cases');
  const ids = new Set(), requirements = new Set(input.requirements.map(r => r.id));
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
    check(!ids.has(item.case_id), 'duplicate case_id'); ids.add(item.case_id);
    check(['P0', 'P1', 'P2', 'P3'].includes(item.priority), 'invalid priority');
    return Object.fromEntries(CASE_FIELDS.map(field => [field,
      field === 'steps' ? numberedLines(item.steps.map(s => s.step))
      : field === 'expects' ? numberedLines(item.steps.map(s => s.expect))
      : item[field]]));
  });
  check(typeof output.explorationNotes === 'string', 'explorationNotes must be a string');
  check(Array.isArray(output.limitations) && output.limitations.every(v => typeof v === 'string'), 'limitations must be a string array');
  const casesMarkdown = [
    `| ${CASE_FIELDS.join(' | ')} |`,
    `| ${CASE_FIELDS.map(() => '---').join(' | ')} |`,
    ...cases.map(item => `| ${CASE_FIELDS.map(field => cell(item[field])).join(' | ')} |`)
  ].join('\n');
  const planMarkdown = ['# Test Plan (draft)', ...cases.map((c, i) =>
    `\n## ${i + 1}. ${c.name}\n\nRequirement: ${c.request}\n\nCase ID: ${c.case_id}\n\nPriority: ${c.priority}\n\n### Objective\n${c.description}\n\n### Preconditions\n${c.precondition}\n\n### Steps\n${c.steps}\n\n### Expected results\n${c.expects}`)].join('\n');
  return { reviewStatus: 'draft', cases, casesMarkdown, planMarkdown, explorationNotes: output.explorationNotes, limitations: output.limitations };
}
