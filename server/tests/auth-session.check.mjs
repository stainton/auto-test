import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthSessions, authSessionsFromEnv, authStatePath, clearAuthSession, isAuthFocused, planAuthSession,
  readSavedAuthSession, stageAuthSession } from '../shared/auth-session.mjs';
import { seedSpec } from '../shared/seed.mjs';
import { createGeneratorWorker } from '../generator/worker.mjs';
import { createPlannerWorker } from '../planner/worker.mjs';
import { SYSTEM_PROMPT as GENERATOR_PROMPT } from '../generator/prompt.mjs';
import { SYSTEM_PROMPT as PLANNER_PROMPT } from '../planner/prompt.mjs';
import { SYSTEM_PROMPT as HEALER_PROMPT } from '../healer/prompt.mjs';
import { input as plannerInput, output as plannerOutput } from './fixtures.mjs';

const cookie = (name, expires = -1) => ({ name, value: 'v', domain: 'example.test', path: '/', expires, httpOnly: true, secure: false, sameSite: 'Lax' });
const session = (name = 'sid') => ({ cookies: [cookie(name)], origins: [{ origin: 'https://example.test', localStorage: [{ name: 'token', value: 't' }] }] });
const target = { baseUrl: 'https://example.test/app/home' };

test('a saved login belongs to one origin and one account and expires', () => {
  let now = 1_000_000;
  const sessions = new AuthSessions({ ttlMs: 1000, max: 2, now: () => now });
  const alice = sessions.key(target, { username: 'alice' });
  assert.notEqual(alice, sessions.key(target, { username: 'bob' }));
  assert.notEqual(alice, sessions.key({ baseUrl: 'https://staging.example.test/' }, { username: 'alice' }));
  assert.equal(alice, sessions.key({ baseUrl: 'https://example.test/other/page' }, { username: 'alice' }));
  assert.equal(sessions.key({ baseUrl: 'not a url' }, {}), '');
  sessions.put(alice, session());
  assert.deepEqual(sessions.get(alice), session());
  assert.notEqual(sessions.get(alice), sessions.get(alice), 'callers get copies, not the cached object');
  now += 1001;
  assert.equal(sessions.get(alice), undefined);
  // The oldest entry makes room once the cap is reached.
  now = 0;
  sessions.put('a', session()); sessions.put('b', session()); sessions.put('c', session());
  assert.equal(sessions.get('a'), undefined);
  assert.ok(sessions.get('c'));
});

test('a session whose cookies have all expired and that has no local storage is not reused', () => {
  const now = 2_000_000_000_000;
  const sessions = new AuthSessions({ now: () => now });
  sessions.put('k', { cookies: [cookie('old', now / 1000 - 5)], origins: [] });
  assert.equal(sessions.get('k'), undefined);
  sessions.put('k', { cookies: [cookie('old', now / 1000 - 5), cookie('live', now / 1000 + 600)], origins: [] });
  assert.deepEqual(sessions.get('k').cookies.map(c => c.name), ['live']);
});

test('tasks about login itself never get or save a session; a supplied login always wins', () => {
  for (const text of ['使用正确密码登录', '退出登录后返回登录页', 'Login with wrong password', 'logout clears session', '短信验证码校验', 'TC-AUTH-LOGIN-001', 'SSO 单点登录'])
    assert.equal(isAuthFocused(text), true, text);
  for (const text of ['新建任务并保存', '资产列表分页', 'TC-ASSET-LIST-FUNC-001', '导出报表为 CSV'])
    assert.equal(isAuthFocused(text), false, text);
  const sessions = new AuthSessions();
  const key = sessions.key(target, { username: 'alice' });
  sessions.put(key, session());
  const ordinary = planAuthSession(sessions, { target, context: { testData: { username: 'alice' } } }, ['新建任务']);
  assert.deepEqual([Boolean(ordinary.preload), ordinary.capture, ordinary.key], [true, true, key]);
  const loginCase = planAuthSession(sessions, { target, context: { testData: { username: 'alice' } } }, ['登录失败提示']);
  assert.deepEqual([loginCase.preload, loginCase.capture], [undefined, false]);
  const supplied = planAuthSession(sessions, { target: { ...target, storageState: session() }, context: {} }, ['新建任务']);
  assert.deepEqual([supplied.preload, supplied.capture], [undefined, false]);
  const other = planAuthSession(sessions, { target, context: { testData: { username: 'bob' } } }, ['新建任务']);
  assert.deepEqual([other.preload, other.capture], [undefined, true]);
  assert.deepEqual(planAuthSession(undefined, { target, context: {} }, ['新建任务']), { preload: undefined, capture: false, key: '' });
});

test('the session file is staged, read back, validated and removed', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'auth-file-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(await readSavedAuthSession(workspace), undefined);
  const file = await stageAuthSession(workspace, session());
  assert.equal(file, authStatePath(workspace));
  assert.deepEqual(await readSavedAuthSession(workspace), session());
  await writeFile(file, '{"cookies":[{"name":1}],"origins":[]}');
  assert.equal(await readSavedAuthSession(workspace), undefined, 'a malformed file is not kept');
  await writeFile(file, '{"cookies":[],"origins":[]}');
  assert.equal(await readSavedAuthSession(workspace), undefined, 'an empty session is not kept');
  await clearAuthSession(workspace);
  assert.deepEqual(await readdir(workspace), []);
});

test('environment switches', () => {
  assert.equal(authSessionsFromEnv({ AUTH_SESSION_REUSE: '0' }), undefined);
  assert.equal(authSessionsFromEnv({}).ttlMs, 30 * 60 * 1000);
  assert.equal(authSessionsFromEnv({ AUTH_SESSION_TTL_MS: '60000' }).ttlMs, 60000);
  assert.throws(() => authSessionsFromEnv({ AUTH_SESSION_TTL_MS: '0' }), /AUTH_SESSION_TTL_MS/);
});

test('only the seed carries the session', () => {
  const plain = seedSpec({ testEntry: '/pw/index.js', name: 'generator seed', baseUrl: 'https://example.test/', replay: [] });
  const logged = seedSpec({ testEntry: '/pw/index.js', name: 'generator seed', baseUrl: 'https://example.test/', replay: [], storageStatePath: '/ws/auth/auth-state.json' });
  assert.ok(!plain.includes('storageState'));
  assert.match(logged, /test\.use\(\{ storageState: "\/ws\/auth\/auth-state\.json" \}\);\ntest\("generator seed"/);
});

// ---- the workers -----------------------------------------------------------------------------------------------
const pkg = '/runtime/node_modules/@playwright/test/package.json';
const spec = `import { test, expect } from '@playwright/test';\ntest.use({ viewport: { width: 1600, height: 900 } });\ntest('t', async ({ page }, testInfo) => { await test.step('打开页面', async () => { await page.goto('/'); await expect(page).toHaveTitle(/x/); await testInfo.attach('页面已打开', { body: await page.screenshot(), contentType: 'image/png' }); }); });`;
const generated = { status: 'generated', code: spec, summary: '已生成', deviations: [], missingInputs: [], explorationNotes: '' };
const caseOf = (id, title) => ({ id, title, priority: 'P1', precondition: '已登录', steps: '1. 打开页面', expects: '1. 页面可见' });
const setupCall = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__playwright-test__generator_setup_page' }] } });
const setupDone = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1' }] } });

async function generatorHarness(t, onRun, options = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'auth-generator-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const authSessions = new AuthSessions();
  const runs = [];
  const worker = createGeneratorWorker({ temporaryRoot, playwrightPackage: pkg, authSessions, ...options,
    runtime: async opts => {
      const project = path.join(opts.cwd, 'project');
      const run = { prompt: JSON.parse(opts.prompt), seed: await readFile(path.join(project, 'seed.spec.ts'), 'utf8'),
        config: await readFile(path.join(project, 'playwright.config.cjs'), 'utf8') };
      runs.push(run);
      opts.onMessage(setupCall()); opts.onMessage(setupDone());
      await onRun?.(run, opts, runs.length);
      return generated;
    } });
  return { worker, runs, authSessions, temporaryRoot };
}
const request = (cases, extra = {}) => ({ cases, target, context: { testData: { username: 'alice', password: 'pw' } }, ...extra });
const ctx = () => ({ signal: new AbortController().signal, emit() {} });
const saveFrom = run => run.prompt.authSession.saveTo;

test('generator: the first task logs in and saves the session, the next one starts from it, and the project config never carries it', async t => {
  const { worker, runs, authSessions, temporaryRoot } = await generatorHarness(t, async (run, opts, n) => {
    if (n === 1) { await mkdir(path.dirname(saveFrom(run)), { recursive: true }); await writeFile(saveFrom(run), JSON.stringify(session('first'))); }
  });
  await worker(request([caseOf('TC-ASSET-LIST-FUNC-001', '资产列表分页'), caseOf('TC-ASSET-LIST-FUNC-002', '资产列表排序')]), ctx());
  assert.equal(runs.length, 2);
  // First case: nothing cached yet, so the seed is plain and the model is asked to save its login.
  assert.deepEqual([runs[0].prompt.authSession.seedAuthenticated, typeof saveFrom(runs[0])], [false, 'string']);
  assert.ok(!runs[0].seed.includes('storageState'));
  // Second case: the seed carries the saved login, and the prompt says so (never the cookies themselves).
  assert.equal(runs[1].prompt.authSession.seedAuthenticated, true);
  assert.match(runs[1].seed, /test\.use\(\{ storageState: ".*auth-state\.json" \}\)/);
  assert.ok(!JSON.stringify(runs[1].prompt).includes('"first"'));
  // The project config, which test_run uses, stays clean: the generated spec has to log in by itself.
  for (const run of runs) assert.ok(!run.config.includes('storageState'), 'config must not preload a session');
  assert.deepEqual(authSessions.get(authSessions.key(target, { username: 'alice' })).cookies.map(c => c.name), ['first']);
  assert.deepEqual(await readdir(temporaryRoot), [], 'no workspace, and so no session file, is left behind');
});

test('generator: a case about login starts logged out and neither reads nor writes the cache; another account does not inherit it', async t => {
  const { worker, runs, authSessions } = await generatorHarness(t);
  authSessions.put(authSessions.key(target, { username: 'alice' }), session('cached'));
  await worker(request([caseOf('TC-LOGIN-AUTH-FUNC-001', '错误密码登录失败')]), ctx());
  assert.equal(runs[0].prompt.authSession, undefined);
  assert.ok(!runs[0].seed.includes('storageState'));
  await worker(request([caseOf('TC-ASSET-LIST-FUNC-001', '资产列表分页')], { context: { testData: { username: 'bob' } } }), ctx());
  assert.equal(runs[1].prompt.authSession.seedAuthenticated, false);
  assert.ok(!runs[1].seed.includes('storageState'));
});

test('generator: a login supplied by the caller is used as before and bypasses the cache', async t => {
  const { worker, runs } = await generatorHarness(t);
  await worker(request([caseOf('TC-ASSET-LIST-FUNC-001', '资产列表分页')], { target: { ...target, storageState: session('mine') } }), ctx());
  assert.equal(runs[0].prompt.authSession, undefined);
  assert.equal(runs[0].prompt.target.authenticationProvided, true);
  assert.ok(runs[0].config.includes('"mine"'), 'the caller-supplied state is still the browser configuration');
});

test('generator: a session saved by a case that then fails is kept, and the file never outlives the case', async t => {
  const { worker, authSessions, temporaryRoot } = await generatorHarness(t, async run => {
    await mkdir(path.dirname(saveFrom(run)), { recursive: true }); await writeFile(saveFrom(run), JSON.stringify(session('kept')));
    throw new Error('Generator exceeded its time limit');
  });
  const result = await worker(request([caseOf('TC-ASSET-LIST-FUNC-001', '资产列表分页')]), ctx());
  assert.equal(result.blocked, 1);
  assert.ok(authSessions.get(authSessions.key(target, { username: 'alice' })));
  // The failed run keeps its workspace for diagnosis; it must not hold the session.
  for (const dir of await readdir(temporaryRoot)) await assert.rejects(access(path.join(temporaryRoot, dir, 'auth')));
});

test('planner: reuses and saves a login for requirements that are not about authentication', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'auth-planner-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const authSessions = new AuthSessions();
  const runs = [];
  const worker = createPlannerWorker({ temporaryRoot, playwrightPackage: pkg, authSessions, runtime: async opts => {
    const prompt = JSON.parse(opts.prompt);
    runs.push({ prompt, seed: await readFile(path.join(opts.cwd, 'seed.spec.ts'), 'utf8'), config: await readFile(path.join(opts.cwd, 'playwright.config.cjs'), 'utf8') });
    opts.onMessage({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright-test', status: 'connected' }] });
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'mcp__playwright-test__planner_setup_page', input: {} }] } });
    opts.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Ready' }] } });
    if (runs.length === 1) { await mkdir(path.dirname(prompt.authSession.saveTo), { recursive: true }); await writeFile(prompt.authSession.saveTo, JSON.stringify(session('planned'))); }
    return plannerOutput;
  } });
  const requirement = title => ({ requirements: [{ id: 'REQ-001', title, content: '内容里提到登录也没关系，因为这不是需求本身的主题。' }] });
  const base = { ...plannerInput, context: { testData: { username: 'alice' } } };
  await worker({ ...base, ...requirement('资产管理') }, { ...ctx(), checkpoint() {} });
  await worker({ ...base, ...requirement('资产管理') }, { ...ctx(), checkpoint() {} });
  await worker({ ...base, ...requirement('用户登录与密码找回') }, { ...ctx(), checkpoint() {} });
  assert.deepEqual(runs.map(r => r.prompt.authSession?.seedAuthenticated), [false, true, undefined]);
  assert.ok(!runs[0].seed.includes('storageState') && /test\.use\(\{ storageState/.test(runs[1].seed) && !runs[2].seed.includes('storageState'));
  for (const run of runs) assert.ok(!run.config.includes('storageState'));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('prompts: trust recorded locators and re-explore only on failure; reuse the login when the task is not about it', () => {
  for (const [name, prompt] of [['generator', GENERATOR_PROMPT], ['planner', PLANNER_PROMPT], ['healer', HEALER_PROMPT]]) {
    assert.match(prompt, /authSession/, `${name} knows about the saved login`);
    assert.match(prompt, /browser_run_code_unsafe/, `${name} saves it with the code tool`);
    assert.match(prompt, /storageState\(\{ path: SAVE_TO \}\)/, name);
    assert.match(prompt, /spec|script|cases/i);
  }
  for (const prompt of [GENERATOR_PROMPT, PLANNER_PROMPT]) {
    assert.doesNotMatch(prompt, /one bounded live check/, 'the blanket re-verification rule is gone');
    assert.match(prompt, /matches a recorded\s+route/);
    for (const trigger of ['navigation fails', 'not found within the timeout', 'differs from'])
      assert.match(prompt, new RegExp(trigger));
  }
  assert.match(GENERATOR_PROMPT, /must log in by itself/);
  assert.match(HEALER_PROMPT, /still\s+log in on its own/);
});
