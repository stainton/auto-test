import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  temporaryRoot = tmpdir(), caseTimeoutMs = 600000, assetCache } = {}) {
  return async function generator(input, { signal, emit }) {
    signal.throwIfAborted();
    const workspace = await mkdtemp(path.join(temporaryRoot, 'generator-'));
    try {
      emit({ stage: 'preparing', message: 'Preparing an isolated browser session' });
      const packagePath = playwrightPackage ?? require.resolve('@playwright/test/package.json');
      const testEntry = path.join(path.dirname(packagePath), 'index.js');
      const cli = path.join(path.dirname(packagePath), 'cli.js');
      const configPath = path.join(workspace, 'playwright.config.cjs');
      const config = { testDir: workspace, testMatch: '*.spec.ts', workers: 1, retries: 0,
        timeout: 60000, outputDir: path.join(workspace, 'test-results'), reporter: [['list']],
        use: { headless: true, browserName: 'chromium', baseURL: input.target.baseUrl,
          actionTimeout: 10000, navigationTimeout: 30000, screenshot: 'off', trace: 'off', video: 'off',
          ...(input.target.storageState ? { storageState: input.target.storageState } : {}),
          ...(input.target.extraHTTPHeaders ? { extraHTTPHeaders: input.target.extraHTTPHeaders } : {}) } };
      await writeFile(configPath, `module.exports = ${JSON.stringify(config)};\n`, { mode: 0o600 });
      await writeFile(path.join(workspace, 'seed.spec.ts'),
        `const { test } = require(${JSON.stringify(testEntry)});\ntest('generator seed', async ({ page }) => { await page.goto(${JSON.stringify(input.target.baseUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 }); });\n`, { mode: 0o600 });
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
      const notesByRequirement = new Map((promptInput.requirements ?? []).map(requirement => [requirement.id, requirement.explorationNotes ?? promptInput.context?.explorationNotes ?? '']));
      const total = promptInput.cases.length;
      for (const [index, testCase] of promptInput.cases.entries()) {
        signal.throwIfAborted();
        const position = `${index + 1}/${total}`;
        emit({ stage: 'generating', message: `Generating ${testCase.id} (${position})`, caseId: testCase.id, caseIndex: index + 1, caseTotal: total });
        const notes = notesByRequirement.get(testCase.requirement) ?? promptInput.context?.explorationNotes ?? '';
        const output = await runCase({ runtime, input: { ...promptInput, context: { ...promptInput.context, explorationNotes: notes } },
          testCase, workspace, mcpConfig, signal, command, model, settingsPath, caseTimeoutMs, emit, position });
        const script = formatScript(output, testCase);
        scripts.push(script);
        if (typeof output.explorationNotes === 'string' && output.explorationNotes.trim() && testCase.requirement) notesByRequirement.set(testCase.requirement, output.explorationNotes);
        emit({ stage: 'generating', message: `${testCase.id} ${script.status === 'generated' ? 'generated' : `blocked: ${script.summary}`} (${position})`,
          caseId: testCase.id, caseIndex: index + 1, caseTotal: total, caseStatus: script.status });
      }
      signal.throwIfAborted();
      emit({ stage: 'finalizing', message: 'Validating generated specs' });
      const explorationRecords = Object.fromEntries([...notesByRequirement].filter(([, notes]) => notes.trim()));
      return formatResult(scripts, { explorationNotes: Object.values(explorationRecords).join('\n\n'), explorationRecords });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

// A single case. Its own AbortController bounds the run so one stuck case fails that case (recorded
// as blocked below) instead of consuming the whole job's budget; a cancelled job still aborts everything.
async function runCase({ runtime, input, testCase, workspace, mcpConfig, signal, command, model, settingsPath, caseTimeoutMs, emit, position }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Generating ${testCase.id} exceeded its time limit`)), caseTimeoutMs);
  timer.unref();
  const calls = new Map();
  let setupSucceeded = false;
  try {
    const output = await runtime({ cwd: workspace, prompt: buildPrompt(input, testCase), systemPrompt: SYSTEM_PROMPT,
      schema: SCRIPT_OUTPUT_SCHEMA, mcpConfig, allowedTools: ['mcp__playwright-test__*'],
      disallowedTools: EXCLUDED_TOOLS.map(t => `mcp__playwright-test__${t}`),
      signal: controller.signal, command, model, settingsPath, env: { CLAUDE_CONFIG_DIR: path.join(workspace, 'claude-config') },
      onMessage(message) {
        if (message.type === 'system' && message.subtype === 'init') {
          const server = message.mcp_servers?.find(s => s.name === 'playwright-test');
          if (!server || server.status !== 'connected') throw new Error('Playwright MCP is not connected');
        }
        const blocks = message.message?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          if (message.type === 'assistant' && block.type === 'tool_use' && block.name.startsWith('mcp__playwright-test__')) {
            const tool = block.name.replace('mcp__playwright-test__', '');
            calls.set(block.id, tool);
            emit({ stage: toolStage(tool), message: `Running ${tool}`, tool, toolStatus: 'started', caseId: testCase.id });
          }
          if (message.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
            const tool = calls.get(block.tool_use_id);
            calls.delete(block.tool_use_id);
            const failed = Boolean(block.is_error);
            if (tool === 'generator_setup_page' && !failed) setupSucceeded = true;
            emit({ stage: toolStage(tool), message: `${tool} ${failed ? 'failed' : 'completed'}`, tool, toolStatus: failed ? 'failed' : 'completed', caseId: testCase.id });
          }
          if (message.type === 'assistant' && block.type === 'text') {
            for (const line of block.text.split('\n')) {
              if (!line.startsWith('GENERATOR_PROGRESS ')) continue;
              let progress;
              try { progress = JSON.parse(line.slice('GENERATOR_PROGRESS '.length)); } catch { continue; }
              if (STAGES.has(progress.stage) && typeof progress.message === 'string')
                emit({ stage: progress.stage, message: `${progress.message} (${position})`, caseId: testCase.id });
            }
          }
        }
      }
    });
    if (!setupSucceeded) throw new Error('Generator did not successfully initialize the target browser');
    return output;
  } catch (error) {
    // A cancelled or timed-out JOB aborts the whole run; a single case that failed on its own is
    // reported as blocked so the rest of the batch still produces specs.
    if (signal.aborted) throw signal.reason ?? error;
    const summary=caseFailureSummary(error);return { status: 'blocked', code: '', summary, deviations: [], missingInputs: [summary], explorationNotes: '' };
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
