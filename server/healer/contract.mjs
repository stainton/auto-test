import { validateInput as validateGeneration, SCRIPT_MAX_CHARS } from '../generator/contract.mjs';
import { check } from '../shared/contract.mjs';

export function validateInput(input) {
  check(Array.isArray(input?.cases) && input.cases.length === 1, 'healer accepts exactly one existing script');
  const { script, failureDetails, ...testCase } = input.cases[0];
  const normalized = validateGeneration({ ...input, cases: [testCase] });
  check(typeof script === 'string' && script.trim().length > 0 && script.length <= SCRIPT_MAX_CHARS,
    'case.script must contain the existing script (max 120000 characters)');
  check(failureDetails === undefined || typeof failureDetails === 'string' && failureDetails.length <= 100000,
    'case.failureDetails must be text (max 100000 characters)');
  normalized.cases[0] = { ...normalized.cases[0], script, failureDetails: failureDetails || '' };
  return normalized;
}
