import { replaySeed } from '../shared/navigation-replay.mjs';
import { describePlaywrightAction } from '../shared/playwright-progress.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runClaude } from '../runtime/claude.mjs';
import { outputSchema, formatResult } from './contract.mjs';
import { SYSTEM_PROMPT, buildPrompt, buildContinuationPrompt } from './prompt.mjs';

const require = createRequire(import.meta.url);
// Keep generator/test execution out of the planner workflow using native CLI configuration.
export const EXCLUDED_TOOLS = ['generator_setup_page', 'generator_read_log', 'generator_write_test',
  'test_list', 'test_run', 'test_debug', 'planner_save_plan', 'planner_submit_plan'];
const STAGES = new Set(['reading_requirements', 'preparing', 'exploring', 'designing', 'finalizing']);

// Exploration is the expensive part of a run, so an interrupted one (usually its time limit) is continuable
// instead of only repeatable: the workspace holds the Claude session (CLAUDE_CONFIG_DIR below), checkpoint()
// hands its location to the job store, and a later request that carries continueFrom arrives here as
// input.resume and reopens the same conversation. Nothing but that session lives in the workspace, and it is
// removed as soon as the run ends in a way nobody can continue (success, cancellation).
export function createPlannerWorker({ runtime = runClaude, command, model, settingsPath, playwrightPackage, assetCache,
  temporaryRoot = tmpdir() } = {}) {
  return async function planner(input, { signal, emit, checkpoint = () => {} }) {
    signal.throwIfAborted();
    const resumed = Boolean(input.resume);
    const workspace = input.resume?.workspace ?? await mkdtemp(path.join(temporaryRoot, 'planner-'));
    const sessionId = input.resume?.sessionId ?? randomUUID();
    checkpoint({ sessionId, workspace });
    let keepWorkspace = false;
    try {
      emit({ stage: 'preparing', message: resumed ? 'Reopening the interrupted session in a new browser' : 'Preparing an isolated browser session' });
      const packagePath = playwrightPackage ?? require.resolve('@playwright/test/package.json');
      const testEntry = path.join(path.dirname(packagePath), 'index.js');
      const cli = path.join(path.dirname(packagePath), 'cli.js');
      const configPath = path.join(workspace, 'playwright.config.cjs');
      const config = { testDir: workspace, testMatch: 'seed.spec.ts', workers: 1, retries: 0,
        timeout: 30000, outputDir: path.join(workspace, 'test-results'), reporter: [['list']],
        use: { headless: true, browserName: 'chromium', baseURL: input.target.baseUrl,
          actionTimeout: 10000, navigationTimeout: 30000, screenshot: 'off', trace: 'off', video: 'off',
          ...(input.target.storageState ? { storageState: input.target.storageState } : {}),
          ...(input.target.extraHTTPHeaders ? { extraHTTPHeaders: input.target.extraHTTPHeaders } : {}) } };
      await writeFile(configPath, `module.exports = ${JSON.stringify(config)};\n`, { mode: 0o600 });
      await writeFile(path.join(workspace, 'seed.spec.ts'),
        `const { test } = require(${JSON.stringify(testEntry)});\ntest('planner seed', async ({ page }) => { await page.goto(${JSON.stringify(input.target.baseUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{}); ${replaySeed(input.productReplay)} });\n`, { mode: 0o600 });
      const mcpConfig = { mcpServers: { 'playwright-test': { type: 'stdio', command: process.execPath,
        args: [cli, 'run-test-mcp-server', '--headless', '--config', configPath] } } };
      // Files the person attached: copied from the cache into this task's workspace (the directory the
      // browser tools may read) so the model gets a plain local path and never has to fetch anything.
      const assets = input.context?.assets ?? [];
      if (assets.length && !assetCache) throw new Error('This planner has no asset cache configured');
      const staged = [];
      for (const asset of assets) staged.push({ ...asset, path: await assetCache.stage(asset, path.join(workspace, 'assets')) });
      const promptInput = assets.length ? { ...input, context: { ...input.context, assets: staged } } : input;
      const calls = new Map();
      let setupSucceeded = false;
      const output = await runtime({ cwd: workspace, prompt: resumed ? buildContinuationPrompt(promptInput) : buildPrompt(promptInput),
        systemPrompt: SYSTEM_PROMPT,
        schema: outputSchema(input), mcpConfig, allowedTools: ['mcp__playwright-test__*'],
        disallowedTools: EXCLUDED_TOOLS.map(t => `mcp__playwright-test__${t}`),
        signal, command, model, settingsPath,
        // The conversation is persisted inside the workspace so a continuation can resume it and nothing
        // outlives the directory this worker deletes.
        sessionId, resume: resumed, env: { CLAUDE_CONFIG_DIR: path.join(workspace, 'claude-config') },
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
              const action=describePlaywrightAction(tool,block.input);
              calls.set(block.id, {tool,action});
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `正在${action}`, tool, toolStatus: 'started' });
            }
            if (message.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
              const call = calls.get(block.tool_use_id),tool=call.tool;
              calls.delete(block.tool_use_id);
              const failed = Boolean(block.is_error);
              if (tool === 'planner_setup_page' && !failed) setupSucceeded = true;
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `${call.action}${failed ? '失败' : '已完成'}`, tool, toolStatus: failed ? 'failed' : 'completed' });
            }
            if (message.type === 'assistant' && block.type === 'text') {
              for (const line of block.text.split('\n')) {
                if (!line.startsWith('PLANNER_PROGRESS ')) continue;
                let progress;
                try { progress = JSON.parse(line.slice('PLANNER_PROGRESS '.length)); } catch { continue; }
                if (STAGES.has(progress.stage) && typeof progress.message === 'string')
                  emit({ stage: progress.stage, message: progress.message });
              }
            }
          }
        }
      });
      signal.throwIfAborted();
      // A continued run may finish from what it already explored, so only a fresh run must have opened the browser.
      if (!setupSucceeded && !resumed) throw new Error('Planner did not successfully initialize the target browser');
      emit({ stage: 'finalizing', message: 'Validating test cases and formatting the draft' });
      const result = formatResult(output, input);
      checkpoint(null);
      return result;
    } catch (error) {
      // Cancelling means the person is done with this task; anything else (a time limit, a runtime or
      // contract failure) leaves a session worth continuing.
      keepWorkspace = signal.reason?.code !== 'JOB_CANCELLED';
      if (!keepWorkspace) checkpoint(null);
      throw error;
    } finally {
      if (!keepWorkspace) await rm(workspace, { recursive: true, force: true });
    }
  };
}
