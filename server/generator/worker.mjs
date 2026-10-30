import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedSpec } from '../shared/seed.mjs';
import { planAuthSession, stageAuthSession, readSavedAuthSession, clearAuthSession, authSessionNote } from '../shared/auth-session.mjs';
import { describePlaywrightAction } from '../shared/playwright-progress.mjs';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runClaude } from '../runtime/claude.mjs';
import { ServiceError } from '../shared/jobs.mjs';
import { writeTaskSettings } from '../runtime/settings.mjs';
import { restoreCheckpoint } from './checkpoint.mjs';
import { SCRIPT_OUTPUT_SCHEMA, formatScript, formatResult } from './contract.mjs';
import { SYSTEM_PROMPT, buildPrompt } from './prompt.mjs';

const require = createRequire(import.meta.url);
// Planning belongs to the planner service; the generator never saves or submits a plan.
export const EXCLUDED_TOOLS = ['planner_setup_page', 'planner_save_plan', 'planner_submit_plan'];
const STAGES = new Set(['reading_cases', 'preparing', 'exploring', 'generating', 'verifying', 'finalizing']);
const setupFailure = message => Object.assign(new Error(message), { code: 'GENERATOR_SETUP_FAILED' });
// The verdict of a geometry batch probe: null when the tool result is not one, otherwise whether it reports
// clipping. Only the "### Result" section counts: the MCP also echoes the probe's code, whose not-found
// fallback (rectInWindow: false) must not read as a finding.
export const batchProbeVerdict = content => {
  let text = (Array.isArray(content) ? content : []).filter(item => item.type === 'text').map(item => item.text).join(' ');
  if (text.includes('### Result')) text = text.split('### Result')[1].split(/\n###\s/)[0];
  text = text.replace(/\\"/g, '"');
  if (!(/\[/.test(text) && /\bname\b/.test(text) && /\bselector\b/.test(text) && /\bclippedByAncestor\b/.test(text))) return null;
  return /(?:clippedByAncestor\s*["']?\s*:\s*true|rectInWindow\s*["']?\s*:\s*false|textTruncated\s*["']?\s*:\s*true)/.test(text);
};

// One model run per case rather than one run for the whole batch: a folder-level job covers many
// cases, and a failure on the fifth case must not throw away the four specs already written. Each
// run gets its own timeout and its own small schema, and the notes it produces feed the next case.
export function createGeneratorWorker({ runtime = runClaude, command, model, settingsPath, playwrightPackage,
  temporaryRoot = tmpdir(), caseTimeoutMs = 2400000, jobTimeoutMs = 3600000, assetCache, authSessions,
  workflow = { kind: 'generator', systemPrompt: SYSTEM_PROMPT, buildPrompt } } = {}) {
  return async function generator(input, { signal, emit, retain = () => {}, checkpoint = () => {}, settings }) {
    signal.throwIfAborted();
    if (!input.resume?.workspace) await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const workspace = input.resume?.workspace ?? await mkdtemp(path.join(temporaryRoot, `${workflow.kind}-`));
    let sessionId = randomUUID();
    if (input.resume?.checkpoint) {
      try {
        if (!assetCache) throw new Error('This generator has no asset cache to receive a checkpoint');
        let archive;
        try { archive = await readFile(assetCache.path(input.resume.checkpoint)); }
        catch { throw new Error('The generator checkpoint is no longer cached on this node'); }
        await restoreCheckpoint(archive, workspace);
      } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
    }
    let completed = false;
    retain({ workspace });
    // The configuration this task was submitted with (diagnostics never include it, see shared/archive.mjs).
    const taskSettingsPath = settings ? await writeTaskSettings(workspace, settings) : settingsPath;
    const progress = emit;
    emit = event => { appendFileSync(path.join(workspace, 'progress.jsonl'), JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n', { mode: 0o600 }); progress(event); };
    try {
      emit({ stage: 'preparing', message: input.resume ? '继续上次中断的生成会话，并重新准备浏览器' : workflow.kind === 'healer' ? '准备独立脚本修复工作区' : 'Preparing an isolated browser session' });
      const packagePath = playwrightPackage ?? require.resolve('@playwright/test/package.json');
      const project=path.join(workspace,'project'),nodeModules=path.dirname(path.dirname(path.dirname(packagePath)));
      if (input.resume) {
        await rm(project, { recursive: true, force: true });
        await rm(path.join(workspace, 'claude-config'), { recursive: true, force: true });
      }
      await mkdir(project,{mode:0o700});await symlink(nodeModules,path.join(project,'node_modules'),'dir');
      const testEntry = path.join(path.dirname(packagePath), 'index.js');
      const cli = path.join(path.dirname(packagePath), 'cli.js');
      const configPath = path.join(project, 'playwright.config.cjs');
      const config = { testDir: project, testMatch: '*.spec.ts', workers: 1, retries: 0,
        timeout: 60000, outputDir: path.join(workspace, 'test-results'), reporter: [['list'], ['json', { outputFile: path.join(workspace, 'test-results', 'report.json') }]],
        use: { headless: true, browserName: 'chromium', viewport: { width: 1920, height: 1080 }, baseURL: input.target.baseUrl,
          actionTimeout: 10000, navigationTimeout: 30000, screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'off',
          ...(input.target.storageState ? { storageState: input.target.storageState } : {}),
          ...(input.target.extraHTTPHeaders ? { extraHTTPHeaders: input.target.extraHTTPHeaders } : {}) } };
      await writeFile(configPath, `module.exports = ${JSON.stringify(config)};\n`, { mode: 0o600 });
      const mcpConfig = { mcpServers: { 'playwright-test': { type: 'stdio', command: process.execPath,
        args: [cli, 'run-test-mcp-server', '--headless', '--config', configPath] } } };
      const assets = input.context?.assets ?? [];
      if (assets.length && !assetCache) throw new Error('This generator has no asset cache configured');
      const staged=[];
      for (const asset of assets) staged.push({ ...asset, path: await assetCache.stage(asset, path.join(workspace, 'assets')) });
      const promptInput=assets.length?{...input,context:{...input.context,assets:staged}}:input;

      const scripts = [];
      // Notes accumulate across the batch: what case 1 learned about the app saves case 2 an
      // exploration round, which is the dominant cost of a run.
      const mergeNotes=(...values)=>[...new Set(values.filter(Boolean).join('\n\n').split(/\n{2,}/).map(value=>value.trim()).filter(Boolean))].slice(-200).join('\n\n');
      const notesByRequirement = new Map((promptInput.requirements ?? []).map(requirement => [requirement.id, requirement.explorationNotes ?? '']));
      let batchNotes=promptInput.context?.explorationNotes ?? '';
      const total = promptInput.cases.length;
      for (const [index, testCase] of promptInput.cases.entries()) {
        signal.throwIfAborted();
        const position = `${index + 1}/${total}`;
        emit({ stage: 'generating', message: `${workflow.kind === 'healer' ? 'Repairing' : 'Generating'} ${testCase.id} (${position})`, caseId: testCase.id, caseIndex: index + 1, caseTotal: total });
        // A batch shares discoveries even when its cases reference different requirement
        // documents. Each spec remains independently generated and verified, while the
        // expensive product navigation and locator discovery happen only once per batch.
        const savedNotes = input.resume ? await readFile(path.join(workspace, 'resume-notes.json'), 'utf8').then(JSON.parse).catch(() => ({})) : {};
        const notes = mergeNotes(batchNotes, notesByRequirement.get(testCase.requirement) ?? '', savedNotes.explorationNotes);
        await workflow.prepareCase?.({ workspace, project, testCase });
        // The seed starts the exploration browser; whether it starts logged in is decided per case (a case about
        // login itself must start logged out), and only the seed carries the session, never the project config.
        const authPlan = planAuthSession(authSessions, input, [testCase.title, testCase.id]);
        const authFile = authPlan.capture ? await stageAuthSession(workspace, authPlan.preload) : undefined;
        await writeFile(path.join(project, 'seed.spec.ts'), seedSpec({ testEntry, name: 'generator seed', baseUrl: input.target.baseUrl,
          replay: input.productReplay, storageStatePath: authPlan.preload ? authFile : undefined }), { mode: 0o600 });
        const authSession = authSessionNote(authPlan, authFile);
        let output;
        try {
          if (total === 1 && workflow.kind === 'generator') checkpoint({ workspace, sessionId });
          // Keep the case timer ahead of the job timer so a batch can continue after a case times out.
          output = await runCase({ runtime, input: { ...promptInput, ...(authSession ? { authSession } : {}), context: { ...promptInput.context, explorationNotes: notes } },
            testCase, workspace, mcpConfig, signal, workflow, command, model, settingsPath: taskSettingsPath,
            caseTimeoutMs: Math.min(input.caseTimeoutMs ?? caseTimeoutMs, Math.max(1, jobTimeoutMs - 1000)), emit, position,
            sessionId: total === 1 ? sessionId : randomUUID(), resumed: Boolean(input.resume), stopOnTimeout: total === 1 && workflow.kind === 'generator' });
        } finally {
          // Keep what the model saved for the next task, then remove it: the retained failure workspace must not hold a session.
          if (authPlan.capture) { const saved = await readSavedAuthSession(workspace); if (saved) authSessions.put(authPlan.key, saved); }
          await clearAuthSession(workspace);
        }
        let script;
        try { script = formatScript(output, testCase, { requireViewport: workflow.kind !== 'healer' }); }
        catch (error) {
          // A malformed generated spec blocks only this case; later cases in the batch still run.
          const summary=caseFailureSummary(error);
          script={ caseId: testCase.id, title: testCase.title, fileName: `${testCase.id}.spec.ts`, language: 'typescript',
            status: 'blocked', code: '', summary, deviations: [], missingInputs: [String(error.message || summary).slice(0, 200)] };
        }
        scripts.push(script);
        if (typeof output.explorationNotes === 'string' && output.explorationNotes.trim()) {
          batchNotes=mergeNotes(batchNotes, output.explorationNotes);
          if(testCase.requirement)notesByRequirement.set(testCase.requirement, output.explorationNotes);
        }
        emit({ stage: 'generating', message: `${testCase.id} ${script.status === 'generated' ? 'generated' : `blocked: ${script.summary}`} (${position})`,
          caseId: testCase.id, caseIndex: index + 1, caseTotal: total, caseStatus: script.status });
      }
      signal.throwIfAborted();
      emit({ stage: 'finalizing', message: 'Validating generated specs' });
      const explorationRecords = Object.fromEntries([...notesByRequirement].filter(([, notes]) => notes.trim()));
      const result = formatResult(scripts, { explorationNotes: batchNotes, explorationRecords });
      await writeFile(path.join(workspace, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
      checkpoint(null);
      completed = !result.blocked;
      return result;
    } catch (error) {
      await writeFile(path.join(workspace, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }), { mode: 0o600 });
      if (error?.code !== 'JOB_TIMEOUT' && signal.reason?.code !== 'JOB_TIMEOUT') checkpoint(null);
      throw error;
    } finally {
      if (completed && !signal.aborted) { await rm(workspace, { recursive: true, force: true }); retain(null); }
      // The workspace stays until the dispatcher downloads it (GET .../jobs/<id>/diagnostics) and releases the job.
      else emit({ stage: 'finalizing', message: `${workflow.kind === 'healer' ? '修复' : '生成'}现场已保留，可下载诊断包（原脚本、完整错误、会话日志和调试产物）` });
    }
  };
}

// A single case. Its own AbortController bounds the run so one stuck case fails that case (recorded
// as blocked below) instead of consuming the whole job's budget; a cancelled job still aborts everything.
async function runCase({ runtime, input, testCase, workspace, mcpConfig, signal, workflow, command, model, settingsPath, caseTimeoutMs, emit, position, sessionId, resumed, stopOnTimeout }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Generating ${testCase.id} exceeded its time limit`)), caseTimeoutMs);
  timer.unref();
  const calls = new Map();
  let setupSucceeded = false, testRunSucceeded = false;
  let prompt = resumed ? JSON.stringify({ instruction: 'Continue generating the same case using the verified exploration notes in originalRequest.context.explorationNotes. Start a fresh browser with generator_setup_page; do not repeat confirmed exploration. Keep all original business assertions and return the complete structured result.', originalRequest: JSON.parse(workflow.buildPrompt(input, testCase)) }) : workflow.buildPrompt(input, testCase);
  const diagnostics = path.join(workspace, 'diagnostics', testCase.id);
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  await writeFile(path.join(diagnostics, 'session.json'), JSON.stringify({ sessionId }), { mode: 0o600 });
  let recoveryNotes = String(input.context?.explorationNotes ?? '').slice(-12000);
  const saveRecoveryNotes = () => writeFileSync(path.join(workspace, 'resume-notes.json'), JSON.stringify({ explorationNotes: recoveryNotes }), { mode: 0o600 });
  if (workflow.kind === 'generator') saveRecoveryNotes();
  const resumedAttempt = resumed ? `resume-${Date.now()}-` : '';
  let setupFailures = 0, validationRepairs = 0;
  let resizeCount = 0, resizeAllowed = false;
  try {
    // Three initialization attempts and two script-repair attempts have independent budgets.
    for (let attempt = 0; attempt < 5; attempt++) {
      controller.signal.throwIfAborted();
      const attemptDir = path.join(diagnostics, resumedAttempt + String(attempt + 1));
      await mkdir(attemptDir, { mode: 0o700 });
      try {
        setupSucceeded = false; testRunSucceeded = false;
        resizeAllowed = false; // each model attempt opens a new browser
        const output = await runtime({ cwd: workspace, prompt, sessionId, resume: attempt > 0, systemPrompt: workflow.systemPrompt,
          schema: SCRIPT_OUTPUT_SCHEMA, mcpConfig, allowedTools: ['mcp__playwright-test__*'],
          disallowedTools: EXCLUDED_TOOLS.map(t => `mcp__playwright-test__${t}`),
          signal: controller.signal, command, model, settingsPath, env: { CLAUDE_CONFIG_DIR: path.join(workspace, 'claude-config') },
          onMessage(message) {
            appendFileSync(path.join(attemptDir, 'runtime.jsonl'), JSON.stringify(message) + '\n', { mode: 0o600 });
            if (message.type === 'system' && message.subtype === 'init') {
              const server = message.mcp_servers?.find(s => s.name === 'playwright-test');
              if (!server || server.status !== 'connected') throw new Error('Playwright MCP is not connected');
            }
            const blocks = message.message?.content;
            if (!Array.isArray(blocks)) return;
            for (const block of blocks) {
              if (message.type === 'assistant' && block.type === 'tool_use' && block.name.startsWith('mcp__playwright-test__')) {
                const tool = block.name.replace('mcp__playwright-test__', '');
                if (workflow.kind === 'generator' && tool === 'browser_resize') {
                  if (!resizeAllowed || resizeCount >= 2) throw new Error('browser_resize 禁止：页面或容器过长时先滚动；只有当前视口的批量探测明确报告控件裁剪、水平窗口外或文字截断时才能放大，且每条用例最多两次');
                  resizeCount++; resizeAllowed = false;
                }
                const action=describePlaywrightAction(tool,block.input);
                calls.set(block.id, {tool,action});
                emit({ stage: toolStage(tool), message: `正在${action}（${position}）`, tool, toolStatus: 'started', caseId: testCase.id });
              }
              if (message.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
                const call = calls.get(block.tool_use_id),tool=call.tool;
                calls.delete(block.tool_use_id);
                const failed = Boolean(block.is_error);
                if (tool === 'generator_setup_page' && !failed) setupSucceeded = true;
                if (tool === 'test_run' && !failed) testRunSucceeded = true;
                // Only the latest batch probe decides: a later clean probe withdraws an earlier permission.
                if (workflow.kind === 'generator' && (tool === 'browser_evaluate' || tool === 'browser_run_code_unsafe') && !failed) {
                  const verdict = batchProbeVerdict(block.content);
                  if (verdict !== null) resizeAllowed = verdict;
                }
                emit({ stage: toolStage(tool), message: `${call.action}${failed ? '失败' : '已完成'}（${position}）`, tool, toolStatus: failed ? 'failed' : 'completed', caseId: testCase.id });
                if (workflow.kind === 'generator' && tool === 'generator_setup_page' && failed) {
                  const detail = (Array.isArray(block.content) ? block.content : []).filter(item => item.type === 'text').map(item => item.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
                  throw setupFailure(`generator_setup_page 初始化浏览器失败${detail ? `：${detail}` : ''}`);
                }
              }
              if (message.type === 'assistant' && block.type === 'text') {
                for (const line of block.text.split('\n')) {
                  const prefix = `${workflow.kind.toUpperCase()}_PROGRESS `;
                  if (!line.startsWith(prefix)) continue;
                  let progress;
                  try { progress = JSON.parse(line.slice(prefix.length)); } catch { continue; }
                  if (STAGES.has(progress.stage) && typeof progress.message === 'string')
                    emit({ stage: progress.stage, message: `${progress.message} (${position})`, caseId: testCase.id });
                  if (workflow.kind === 'generator' && typeof progress.explorationNotes === 'string' && progress.explorationNotes.length <= 12000) {
                    recoveryNotes = progress.explorationNotes;
                    saveRecoveryNotes();
                  } else if (workflow.kind === 'generator' && progress.stage === 'exploring' && typeof progress.message === 'string') {
                    recoveryNotes = `${recoveryNotes}\n${progress.message}`.slice(-12000);
                    saveRecoveryNotes();
                  }
                }
              }
            }
          }
        });
        await writeFile(path.join(attemptDir, 'output.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
        if (typeof output?.code === 'string') await writeFile(path.join(attemptDir, `${testCase.id}.spec.ts`), output.code, { mode: 0o600 });
        if (workflow.kind === 'generator' && !setupSucceeded) throw setupFailure('Generator 未成功初始化目标浏览器');
        if (workflow.kind === 'healer' && output.status !== 'blocked' && !testRunSucceeded) throw new Error('Healer did not run the original script with test_run');
        try {
          formatScript(output, testCase, { requireViewport: workflow.kind !== 'healer' });
          if (output.status === 'generated') await workflow.verifyOutput?.({ output, testCase, workspace, signal: controller.signal, emit });
        }
        catch (error) {
          await writeFile(path.join(attemptDir, 'validation-error.txt'), error.stack || error.message, { mode: 0o600 });
          if (validationRepairs === 2) throw error;
          validationRepairs++;
          emit({ stage: 'verifying', caseId: testCase.id, message: `脚本校验未通过，正在原会话修复（${validationRepairs}/2）：${error.message}` });
          prompt = JSON.stringify({ instruction: 'Continue the same case. Fix only the failure described below. Reuse the already verified viewport and batch geometry findings in the previous output and resumed session; do not resize, repeat the batch probe, or re-explore working pages and controls unless the failed step shows that they changed. Do not weaken assertions. Only actual test steps need screenshots; setup/cleanup do not. Use a local screenshot helper or inline screenshot and attach. Run the corrected spec with test_run and return the complete structured result. The browser is new: initialize generator_setup_page before debugging.', workflow: workflow.kind, validationError: error.message, previousOutput: output });
          continue;
        }
        return output;
      } catch (error) {
        if (error?.code !== 'GENERATOR_SETUP_FAILED' || ++setupFailures >= 3) throw error;
        emit({ stage: 'preparing', caseId: testCase.id, message: `浏览器初始化失败，立即重试（${setupFailures}/3）：${error.message}` });
        prompt = JSON.stringify({ instruction: 'Browser initialization failed. Immediately call generator_setup_page again with seedFile "seed.spec.ts" before inspecting configuration or exploring. browser_get_config remains available for diagnosis if initialization still fails after direct retries; it is not the first response to setup failure. Continue the same case after setup succeeds.', setupError: error.message });
        continue;
      } finally {
        // Playwright can replace its output directory on the next test run: snapshot each model attempt.
        await cp(path.join(workspace, 'project'), path.join(attemptDir, 'project'), { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
        try { await cp(path.join(workspace, 'test-results'), path.join(attemptDir, 'test-results'), { recursive: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  } catch (error) {
    // A cancelled or timed-out JOB aborts the whole run; a single case that failed on its own is
    // reported as blocked so the rest of the batch still produces specs.
    await writeFile(path.join(diagnostics, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, sessionId }), { mode: 0o600 });
    if (signal.aborted) throw signal.reason ?? error;
    if (workflow.kind === 'generator' && controller.signal.aborted) {
      const code = await readFile(path.join(workspace, 'project', `${testCase.id}.spec.ts`), 'utf8').catch(() => '');
      if (code) {
        const partial = { status: 'generated', code, summary: '生成超时，脚本待人工复核',
          deviations: [{ risk: 'medium', summary: '生成超时，脚本尚未完成验证，请人工复核' }], missingInputs: [], explorationNotes: '' };
        try {
          formatScript(partial, testCase);
          emit({ stage: 'finalizing', caseId: testCase.id, message: `${testCase.id} 超时；返回已写出且通过格式校验的脚本，需人工复核` });
          return partial;
        } catch (validationError) {
          await writeFile(path.join(diagnostics, 'timeout-spec-validation-error.txt'), validationError.message, { mode: 0o600 });
        }
      }
    }
    if (stopOnTimeout && controller.signal.aborted) throw new ServiceError(504, 'JOB_TIMEOUT', `${testCase.id} 生成超过 ${Math.round(caseTimeoutMs / 60000)} 分钟；已保存探索笔记，可继续生成`);
    const summary=caseFailureSummary(error);return { status: 'blocked', code: '', summary, deviations: [], missingInputs: [String(error.message || summary).slice(0, 200)], explorationNotes: '' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

const toolStage = tool => tool === 'generator_setup_page' ? 'preparing'
  : tool.startsWith('test_') ? 'verifying'
  : tool === 'generator_write_test' ? 'generating' : 'exploring';

// The summary is shown to a reviewer and capped at 40 characters by the contract.
function caseFailureSummary(error) {
  const text = (error?.message || '生成失败').replace(/\s+/g, ' ').trim();
  const label = `生成失败：${text}`;
  return [...label].slice(0, 40).join('');
}
