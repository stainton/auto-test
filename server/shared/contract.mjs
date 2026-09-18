// Contract primitives shared by the workflow services (planner, generator). Only the pieces whose
// meaning must stay identical across services live here: the browser target both of them turn into
// the same Playwright config, the risk-ranked plain-language lists a reviewer reads, and the small
// type checks those need. Each service keeps its own input/output contract in its own contract.mjs.

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function check(condition, message) { if (!condition) throw new Error(message); }
export function string(value, name, max = 200000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} must be a nonempty string (max ${max} characters)`);
  return value;
}
export function keys(value, allowed, name) {
  check(object(value), `${name} must be an object`);
  check(Object.keys(value).every(key => allowed.includes(key)), `${name} contains unsupported fields`);
}

// target describes the system under test: where it is and how an already-authenticated session
// reaches it. storageState is the exported cookies/origins object, never a local file path — the
// service must not read the caller's filesystem.
export function validateTarget(target, name = 'target') {
  keys(target, ['baseUrl', 'storageState', 'extraHTTPHeaders'], name);
  const url = new URL(string(target.baseUrl, `${name}.baseUrl`, 4096));
  check(['http:', 'https:'].includes(url.protocol), `${name}.baseUrl must be HTTP(S)`);
  if (target.storageState !== undefined) {
    const state = target.storageState;
    keys(state, ['cookies', 'origins'], `${name}.storageState`);
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
  if (target.extraHTTPHeaders !== undefined) {
    check(object(target.extraHTTPHeaders) && Object.values(target.extraHTTPHeaders).every(v => typeof v === 'string'), 'extraHTTPHeaders must contain string values');
  }
}

// Short plain-language notes a non-technical reviewer skims right after a run, each with a risk
// level. Hard caps rather than prose limits so the model cannot drift past them.
export const LIMITATION_MAX_CHARS = 40;
export const RISK_LEVELS = ['high', 'medium', 'low'];
export const riskEntry = (...fields) => ({ type: 'object', additionalProperties: false, required: ['risk', ...fields],
  properties: { risk: { type: 'string', enum: RISK_LEVELS },
    ...Object.fromEntries(fields.map(f => [f, { type: 'string', minLength: 1, maxLength: LIMITATION_MAX_CHARS }])) } });

// Validates and normalises one {risk, ...text fields} array, ordered high to low risk.
// Array.prototype.sort is stable, so equal-risk entries keep the model's order.
export function riskList(value, fields, name) {
  check(Array.isArray(value) && value.every(v => object(v) && Object.keys(v).every(k => ['risk', ...fields].includes(k)) &&
    RISK_LEVELS.includes(v.risk) && fields.every(f => typeof v[f] === 'string' && v[f].trim().length > 0 && [...v[f]].length <= LIMITATION_MAX_CHARS)),
    `${name} must be {risk: high|medium|low, ${fields.join(', ')} (max ${LIMITATION_MAX_CHARS} characters each)} entries`);
  return value.map(v => ({ risk: v.risk, ...Object.fromEntries(fields.map(f => [f, v[f].trim()])) }))
    .sort((a, b) => RISK_LEVELS.indexOf(a.risk) - RISK_LEVELS.indexOf(b.risk));
}
