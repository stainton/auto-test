// Reusing a login across tasks. Logging in through the UI is slow and says nothing about most cases, so the
// first task that logs in saves the session (cookies + localStorage) and later tasks against the same origin
// and account start from it. Deliberately conservative:
//  - memory only, with a TTL: a session is a credential, so it is never written to job data or the PVC and
//    a restart simply means one more login;
//  - exploration only: it reaches the seed spec, never the Playwright project config, so a generated spec is
//    still run from a clean browser and must log in by itself;
//  - never for a task about login itself (see isAuthFocused), which has to start logged out.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateStorageState } from './contract.mjs';

export const AUTH_DIR = 'auth';
export const AUTH_STATE_FILE = 'auth-state.json';
// Words that make a task about authentication rather than something done while logged in. Over-matching only
// costs the optimisation (the task logs in the ordinary way), under-matching would hand a login test a
// session it should not have, so this errs on the wide side.
const AUTH_FOCUS = /登录|登入|登出|注销|认证|鉴权|密码|验证码|会话|令牌|单点|log[ -]?(in|out)|sign[ -]?(in|out|up)|auth|password|passcode|session|token|credential|sso/i;
export const isAuthFocused = (...texts) => AUTH_FOCUS.test(texts.filter(Boolean).join(' '));

export class AuthSessions {
  constructor({ ttlMs = 30 * 60 * 1000, max = 20, now = Date.now } = {}) { Object.assign(this, { ttlMs, max, now, entries: new Map() }); }
  // One session per origin and account: another test account must not inherit this one's login.
  key(target, testData) {
    let origin;
    try { origin = new URL(target?.baseUrl ?? '').origin; } catch { return ''; }
    return `${origin}|${createHash('sha256').update(String(testData?.username ?? '')).digest('hex').slice(0, 16)}`;
  }
  get(key) {
    const entry = key && this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    const state = structuredClone(entry.state), seconds = this.now() / 1000;
    state.cookies = state.cookies.filter(cookie => cookie.expires < 0 || cookie.expires > seconds);
    if (!state.cookies.length && !state.origins.some(origin => origin.localStorage.length)) { this.entries.delete(key); return undefined; }
    return state;
  }
  put(key, state) {
    if (!key) return;
    this.entries.delete(key);
    this.entries.set(key, { state, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }
  drop(key) { this.entries.delete(key); }
}

// AUTH_SESSION_REUSE=0 turns the feature off; AUTH_SESSION_TTL_MS (default 30 minutes) bounds how long a saved
// login is reused, which should stay below the target's own session lifetime.
export function authSessionsFromEnv(env = process.env) {
  if (env.AUTH_SESSION_REUSE === '0') return undefined;
  const ttlMs = Number(env.AUTH_SESSION_TTL_MS ?? 30 * 60 * 1000);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('AUTH_SESSION_TTL_MS must be a positive integer');
  return new AuthSessions({ ttlMs });
}

// What to do about the login for one task. A session the caller supplied always wins (no cache involved);
// otherwise reuse and capture both depend on the task not being about authentication.
export function planAuthSession(authSessions, input, texts) {
  const provided = Boolean(input.target.storageState || input.target.extraHTTPHeaders);
  if (!authSessions || provided || isAuthFocused(...texts)) return { preload: undefined, capture: false, key: '' };
  const key = authSessions.key(input.target, input.context?.testData);
  return { key, preload: authSessions.get(key), capture: Boolean(key) };
}

// The file both directions use: the seed loads it, and the model is told to save the session to it.
export const authStatePath = workspace => path.join(workspace, AUTH_DIR, AUTH_STATE_FILE);
export async function stageAuthSession(workspace, state) {
  const file = authStatePath(workspace);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (state) await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  return file;
}
// A session the model saved while it worked; anything unreadable or malformed is simply not kept.
export async function readSavedAuthSession(workspace) {
  try {
    const state = JSON.parse(await readFile(authStatePath(workspace), 'utf8'));
    validateStorageState(state);
    return state.cookies.length || state.origins.some(origin => origin.localStorage.length) ? state : undefined;
  } catch { return undefined; }
}
export const clearAuthSession = workspace => rm(path.join(workspace, AUTH_DIR), { recursive: true, force: true });
// What the prompt says about it; never the session itself.
export const authSessionNote = (plan, file) => plan.capture ? { seedAuthenticated: Boolean(plan.preload), saveTo: file } : undefined;
