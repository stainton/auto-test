import { object, check, string, keys, validateTarget, riskEntry, riskList, LIMITATION_MAX_CHARS } from '../shared/contract.mjs';
import { validateAssets } from '../planner/contract.mjs';

// Input/output contract of the generator HTTP service: reviewed test cases in, one Playwright spec
// per case out. The caller (CaseHub's 自动化管理) owns the cases and stores the returned scripts; the
// service keeps no repository files, no plan directory and no approval state of its own — the human
// review gate lives in the caller, which only sends cases a person already approved.

export const MAX_CASES_PER_JOB = 50;
// One spec file. Well past a realistic generated spec, small enough that a runaway model output is
// rejected instead of persisted into the caller's state.
export const SCRIPT_MAX_CHARS = 120000;
export const MIN_CASE_TIMEOUT_MS = 60000, MAX_CASE_TIMEOUT_MS = 3600000;
export const CASE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$';
const CASE_ID_RE = new RegExp(CASE_ID_PATTERN);
export const SCRIPT_STATUSES = ['generated', 'blocked'];

// A case as the caller stores it: the reviewed text a person approved, plus the ID the script is
// filed under. steps/expects stay the numbered multi-line strings CaseHub and test-model.md use.
export function validateCases(cases) {
  check(Array.isArray(cases) && cases.length > 0 && cases.length <= MAX_CASES_PER_JOB,
    `cases must contain 1–${MAX_CASES_PER_JOB} test cases`);
  const ids = new Set();
  for (const item of cases) {
    keys(item, ['id', 'title', 'priority', 'precondition', 'steps', 'expects', 'requirement'], 'case');
    check(typeof item.id === 'string' && CASE_ID_RE.test(item.id), `case.id must match ${CASE_ID_PATTERN}`);
    check(!ids.has(item.id), 'case IDs must be unique');
    ids.add(item.id);
    string(item.title, 'case.title', 500);
    string(item.steps, 'case.steps');
    for (const field of ['precondition', 'expects']) {
      if (item[field] !== undefined) check(typeof item[field] === 'string' && item[field].length <= 200000, `case.${field} must be a string (max 200000 characters)`);
    }
    for (const field of ['priority', 'requirement']) {
      if (item[field] !== undefined) check(typeof item[field] === 'string' && item[field].length <= 128, `case.${field} must be a string (max 128 characters)`);
    }
  }
}

// Requirement documents are optional background: the generator asserts what the case says, and reads
// the requirement only to understand business rules the case text assumes. It never designs new cases.
export function validateRequirements(requirements) {
  check(Array.isArray(requirements) && requirements.length <= 50, 'requirements must contain at most 50 documents');
  for (const req of requirements) {
    keys(req, ['id', 'title', 'content', 'explorationNotes'], 'requirement');
    string(req.id, 'requirement.id', 128);
    string(req.title, 'requirement.title', 500);
    string(req.content, 'requirement.content');

    if (req.explorationNotes !== undefined) string(req.explorationNotes, 'requirement.explorationNotes');
  }
}

export function validateInput(input) {
  keys(input, ['cases', 'requirements', 'target', 'context', 'caseTimeoutMs'], 'request');
  validateCases(input.cases);
  if (input.requirements !== undefined) validateRequirements(input.requirements);
  validateTarget(input.target);
  if(input.caseTimeoutMs!==undefined)check(Number.isSafeInteger(input.caseTimeoutMs)&&input.caseTimeoutMs>=MIN_CASE_TIMEOUT_MS&&input.caseTimeoutMs<=MAX_CASE_TIMEOUT_MS,`caseTimeoutMs must be between ${MIN_CASE_TIMEOUT_MS} and ${MAX_CASE_TIMEOUT_MS}`);
  if (input.context !== undefined) {
    keys(input.context, ['explorationNotes', 'knownIssues', 'instructions', 'testData', 'assets'], 'context');
    for (const key of ['explorationNotes', 'knownIssues', 'instructions']) {
      if (input.context[key] !== undefined) check(typeof input.context[key] === 'string' && input.context[key].length <= 200000, `context.${key} must be a string (max 200000 characters)`);
    }
    if (input.context.testData !== undefined) check(object(input.context.testData), 'context.testData must be an object');
    if (input.context.assets !== undefined) validateAssets(input.context.assets);
  }
  return structuredClone(input);
}

// One model call per case (see worker.mjs), so the schema describes a single spec. A case the model
// cannot honestly automate comes back blocked with the reason instead of a spec that skips, fixmes or
// asserts something it never verified.
const missingInputsSchema={type:'array',minItems:0,maxItems:10,items:{type:'string',minLength:1,maxLength:200}};
// A report needs evidence at the same granularity as the generated business steps.
// This deliberately lightweight brace matcher is sufficient for generated specs and rejects a
// spec whose screenshots were appended only after all verification steps.
function stepBodies(code){
  const bodies=[];const re=/\btest\.step\s*\(\s*(['"][^'"]+['"])[\s\S]{0,300}?=>\s*\{/g;let match;
  while((match=re.exec(code))){let depth=1,index=re.lastIndex;for(;index<code.length&&depth;index++){if(code[index]==='{')depth++;else if(code[index]==='}')depth--;}if(depth)throw Error('a generated script has an unclosed test.step');bodies.push({title:match[1],body:code.slice(re.lastIndex,index-1)});re.lastIndex=index;}
  return bodies;
}
function validateStepEvidence(code){
  const steps=stepBodies(code);check(steps.length>0,'a generated script must contain business test steps');
  for(const step of steps)check(/\btestInfo\.attach\s*\(/.test(step.body)&&/\bpage\.screenshot\s*\(/.test(step.body),`business test step ${step.title} must attach its own screenshot evidence`);
}
export const SCRIPT_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'code', 'summary', 'deviations', 'missingInputs', 'explorationNotes'],
  properties: {
    status: { type: 'string', enum: SCRIPT_STATUSES },
    code: { type: 'string', maxLength: SCRIPT_MAX_CHARS },
    summary: { type: 'string', minLength: 1, maxLength: LIMITATION_MAX_CHARS },
    // What the live application actually did where it contradicts the case's expected result: the
    // spec asserts the observed behaviour with a // deviation: comment, and says so here too.
    deviations: { type: 'array', maxItems: 10, items: riskEntry('summary') },
    missingInputs: missingInputsSchema,
    explorationNotes: { type: 'string' }
  }
};

// Validates one model result against the case it was generated for, and returns the stored script.
export function formatScript(output, testCase) {
  keys(output, ['status', 'code', 'summary', 'deviations', 'missingInputs', 'explorationNotes'], 'generator output');
  check(SCRIPT_STATUSES.includes(output.status), `generator status must be one of ${SCRIPT_STATUSES.join(', ')}`);
  check(typeof output.code === 'string' && output.code.length <= SCRIPT_MAX_CHARS, `generated code must be a string of at most ${SCRIPT_MAX_CHARS} characters`);
  check(typeof output.summary === 'string' && output.summary.trim().length > 0 && [...output.summary].length <= LIMITATION_MAX_CHARS,
    `generator summary must be at most ${LIMITATION_MAX_CHARS} characters`);
  check(typeof output.explorationNotes === 'string', 'explorationNotes must be a string');
  const deviations = riskList(output.deviations ?? [], ['summary'], 'deviations');
  check(Array.isArray(output.missingInputs) && output.missingInputs.length <= 10 && output.missingInputs.every(x=>typeof x==='string'&&x.trim()&&x.length<=200), 'missingInputs must contain at most 10 nonempty strings');
  const missingInputs=[...new Set(output.missingInputs.map(x=>x.trim()))];
  const code = output.code.trim();
  if (output.status === 'generated') {
    check(code.includes('@playwright/test') && /\btest\s*\(/.test(code),
      'a generated script must be a Playwright spec importing @playwright/test and declaring a test');
    check(!/\btest\.(skip|fixme)\s*\(/.test(code), 'a generated script must not skip or fixme the case');
    validateStepEvidence(code);
    check(missingInputs.length===0, 'a generated script must not report missing inputs');
  } else {
    check(missingInputs.length>0, 'a blocked script must explain each missing input or unreachable dependency');
  }
  return { caseId: testCase.id, title: testCase.title, fileName: `${testCase.id}.spec.ts`, language: 'typescript',
    status: output.status, code: output.status === 'generated' ? code : '', summary: output.summary.trim(), deviations, missingInputs };
}

// Job result: every submitted case appears exactly once, in submission order. A job succeeds as long
// as it ran to completion — blocked scripts are a reported outcome, not a service failure — so the
// caller can store what worked and see per case why the rest did not.
export function formatResult(scripts, { explorationNotes = '', explorationRecords = {} } = {}) {
  check(Array.isArray(scripts) && scripts.length > 0, 'generator must return at least one script');
  const blocked = scripts.filter(s => s.status === 'blocked');
  return {
    scripts,
    generated: scripts.length - blocked.length,
    blocked: blocked.length,
    explorationNotes,
    explorationRecords,
    // Blocked cases, highest risk first, in the same shape the planner's limitations use so the
    // caller renders both with one component.
    limitations: riskList(blocked.map(s => ({ risk: 'high', summary: s.summary })), ['summary'], 'limitations')
  };
}
