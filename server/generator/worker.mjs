import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { replaySeed } from '../shared/navigation-replay.mjs';
import { describePlaywrightAction } from '../shared/playwright-progress.mjs';
import { mkdtemp, writeFile, rm, mkdir, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runClaude } from '../runtime/claude.mjs';
import { SCRIPT_OUTPUT_SCHEMA, formatScript, formatResult } from './contract.mjs';
import { SYSTEM_PROMPT, buildPrompt } from './prompt.mjs';

const require = createRequire(import.meta.url);
// Planning belongs to the planner service; the generator never saves or submits a plan.
export const EXCLUDED_TOOLS = ['planner_setup_page', 'planner_save_plan', 'planner_submit_plan'];
const STAGES = new Set(['reading_cases', 'preparing', 'exploring', 'generating', 'verifying', 'finalizing']);

// One model run per case rather than one run for the whole batch: a folder-level job covers many
// cases, and a failure on the fifth case must not throw away the four specs already written. Each
// run gets its own timeout and its own small schema, and the notes it produces feed the next case.
export function createGeneratorWorker({ runtime = runClaude, command, model, settingsPath, playwrightPackage,
  temporaryRoot = tmpdir(), caseTimeoutMs = 3600000, assetCache,
  workflow = { kind: 'generator', systemPrompt: SYSTEM_PROMPT, buildPrompt } } = {}) {
  return async function generator(input, { signal, emit, retain = () => {} }) {
    signal.throwIfAborted();
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(path.join(temporaryRoot, `${workflow.kind}-`));
    let completed = false;
    retain({ workspace });
    const progress = emit;
    emit = event => { appendFileSync(path.join(workspace, 'progress.jsonl'), JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n', { mode: 0o600 }); progress(event); };
    try {
      emit({ stage: 'preparing', message: workflow.kind === 'healer' ? '准备独立脚本修复工作区' : 'Preparing an isolated browser session' });
      const packagePath = playwrightPackage ?? require.resolve('@playwright/test/package.json');
      const project=path.join(workspace,'project'),nodeModules=path.dirname(path.dirname(path.dirname(packagePath)));await mkdir(project,{mode:0o700});await symlink(nodeModules,path.join(project,'node_modules'),'dir');
      const testEntry = path.join(path.dirname(packagePath), 'index.js');
      const cli = path.join(path.dirname(packagePath), 'cli.js');
      const configPath = path.join(project, 'playwright.config.cjs');
      const config = { testDir: project, testMatch: '*.spec.ts', workers: 1, retries: 0,
        timeout: 60000, outputDir: path.join(workspace, 'test-results'), reporter: [['list'], ['json', { outputFile: path.join(workspace, 'test-results', 'report.json') }]],
        use: { headless: true, browserName: 'chromium', baseURL: input.target.baseUrl,
          actionTimeout: 10000, navigationTimeout: 30000, screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'off',
          ...(input.target.storageState ? { storageState: input.target.storageState } : {}),
          ...(input.target.extraHTTPHeaders ? { extraHTTPHeaders: input.target.extraHTTPHeaders } : {}) } };
      await writeFile(configPath, `module.exports = ${JSON.stringify(config)};\n`, { mode: 0o600 });
      await writeFile(path.join(project, 'seed.spec.ts'),
        `const { test } = require(${JSON.stringify(testEntry)});\ntest('generator seed', async ({ page }) => { await page.goto(${JSON.stringify(input.target.baseUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{}); ${replaySeed(input.productReplay)} });\n`, { mode: 0o600 });
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
        const notes = mergeNotes(batchNotes, notesByRequirement.get(testCase.requirement) ?? '');
        await workflow.prepareCase?.({ workspace, project, testCase });
        const output = await runCase({ runtime, input: { ...promptInput, context: { ...promptInput.context, explorationNotes: notes } },
          testCase, workspace, mcpConfig, signal, workflow, command, model, settingsPath, caseTimeoutMs:input.caseTimeoutMs??caseTimeoutMs, emit, position });
        let script;
        try { script = formatScript(output, testCase); }
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
      completed = !result.blocked;
      return result;
    } catch (error) {
      await writeFile(path.join(workspace, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }), { mode: 0o600 });
      throw error;
    } finally {
      if (completed && !signal.aborted) { await rm(workspace, { recursive: true, force: true }); retain(null); }
      else emit({ stage: 'finalizing', message: `${workflow.kind === 'healer' ? '修复' : '生成'}现场已保留：${workspace}（原脚本、完整错误、会话日志和调试产物）` });
    }
  };
}

// A single case. Its own AbortController bounds the run so one stuck case fails that case (recorded
// as blocked below) instead of consuming the whole job's budget; a cancelled job still aborts everything.
async function runCase({ runtime, input, testCase, workspace, mcpConfig, signal, workflow, command, model, settingsPath, caseTimeoutMs, emit, position }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Generating ${testCase.id} exceeded its time limit`)), caseTimeoutMs);
  timer.unref();
  const calls = new Map();
  let setupSucceeded = false, testRunSucceeded = false;
  const sessionId = randomUUID();
  let prompt = workflow.buildPrompt(input, testCase);
  const diagnostics = path.join(workspace, 'diagnostics', testCase.id);
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  await writeFile(path.join(diagnostics, 'session.json'), JSON.stringify({ sessionId }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      controller.signal.throwIfAborted();
      const attemptDir = path.join(diagnostics, String(attempt + 1));
      await mkdir(attemptDir, { mode: 0o700 });
      try {
        setupSucceeded = false; testRunSucceeded = false;
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
                emit({ stage: toolStage(tool), message: `${call.action}${failed ? '失败' : '已完成'}（${position}）`, tool, toolStatus: failed ? 'failed' : 'completed', caseId: testCase.id });
              }
              if (message.type === 'assistant' && block.type === 'text') {
                for (const line of block.text.split('\n')) {
                  const prefix = `${workflow.kind.toUpperCase()}_PROGRESS `;
                  if (!line.startsWith(prefix)) continue;
                  let progress;
                  try { progress = JSON.parse(line.slice(prefix.length)); } catch { continue; }
                  if (STAGES.has(progress.stage) && typeof progress.message === 'string')
                    emit({ stage: progress.stage, message: `${progress.message} (${position})`, caseId: testCase.id });
                }
              }
            }
          }
        });
        await writeFile(path.join(attemptDir, 'output.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
        if (typeof output?.code === 'string') await writeFile(path.join(attemptDir, `${testCase.id}.spec.ts`), output.code, { mode: 0o600 });
        if (!(workflow.kind === 'healer' ? output.status === 'blocked' || testRunSucceeded : setupSucceeded)) throw new Error(workflow.kind === 'healer' ? 'Healer did not run the original script with test_run' : 'Generator did not successfully initialize the target browser');
        try {
          formatScript(output, testCase);
          if (output.status === 'generated') await workflow.verifyOutput?.({ output, testCase, workspace, signal: controller.signal, emit });
        }
        catch (error) {
          await writeFile(path.join(attemptDir, 'validation-error.txt'), error.stack || error.message, { mode: 0o600 });
          if (attempt === 2) throw error;
          emit({ stage: 'verifying', caseId: testCase.id, message: `脚本校验未通过，正在原会话修复（${attempt + 1}/2）：${error.message}` });
          prompt = JSON.stringify({ instruction: 'Continue the same case. Fix the returned source using the validation error below. Do not re-explore working flows or weaken assertions. Only actual test steps need screenshots; setup/cleanup do not. Use a local screenshot helper or inline screenshot and attach. Run the corrected spec with test_run and return the complete structured result. The browser is new: initialize generator_setup_page before debugging.', workflow: workflow.kind, validationError: error.message, previousOutput: output });
          continue;
        }
        return output;
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
