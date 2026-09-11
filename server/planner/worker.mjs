import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../runtime/claude.mjs';
import { OUTPUT_SCHEMA, formatResult } from './contract.mjs';
import { SYSTEM_PROMPT, buildPrompt } from './prompt.mjs';

const require = createRequire(import.meta.url);
export const TOOL_NAMES = ['planner_setup_page', 'browser_click', 'browser_close', 'browser_console_messages',
  'browser_drag', 'browser_evaluate', 'browser_handle_dialog', 'browser_hover', 'browser_navigate',
  'browser_navigate_back', 'browser_network_requests', 'browser_press_key', 'browser_select_option',
  'browser_snapshot', 'browser_take_screenshot', 'browser_type', 'browser_wait_for'];
const STAGES = new Set(['reading_requirements', 'preparing', 'exploring', 'designing', 'finalizing']);

function redactProgress(message, input) {
  const values = [];
  function collect(value) {
    if (typeof value === 'string' && value.length >= 3) values.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(input.target.storageState); collect(input.target.extraHTTPHeaders); collect(input.context?.testData);
  for (const value of values.sort((a, b) => b.length - a.length)) message = message.split(value).join('[redacted]');
  return message.slice(0, 1000);
}

export function createPlannerWorker({ runtime = runClaude, command, model, settingsPath, playwrightPackage,
  temporaryRoot = tmpdir() } = {}) {
  return async function planner(input, { signal, emit }) {
    signal.throwIfAborted();
    const workspace = await mkdtemp(path.join(temporaryRoot, 'planner-'));
    try {
      emit({ stage: 'preparing', message: 'Preparing an isolated browser session' });
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
        `const { test } = require(${JSON.stringify(testEntry)});\ntest('planner seed', async ({ page }) => { await page.goto(${JSON.stringify(input.target.baseUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 }); });\n`, { mode: 0o600 });
      const mcpConfig = { mcpServers: { 'playwright-test': { type: 'stdio', command: process.execPath,
        args: [fileURLToPath(new URL('../runtime/mcp-filter.mjs', import.meta.url)), JSON.stringify(TOOL_NAMES),
          process.execPath, cli, 'run-test-mcp-server', '--headless', '--config', configPath] } } };
      const calls = new Map();
      let setupSucceeded = false;
      const output = await runtime({ cwd: workspace, prompt: buildPrompt(input), systemPrompt: SYSTEM_PROMPT,
        schema: OUTPUT_SCHEMA, mcpConfig, allowedTools: TOOL_NAMES.map(t => `mcp__playwright-test__${t}`),
        signal, command, model, settingsPath,
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
              if (!TOOL_NAMES.includes(tool)) throw new Error('Unexpected planner tool');
              calls.set(block.id, tool);
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `Running ${tool}`, tool, toolStatus: 'started' });
            }
            if (message.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
              const tool = calls.get(block.tool_use_id);
              calls.delete(block.tool_use_id);
              const failed = Boolean(block.is_error);
              if (tool === 'planner_setup_page' && !failed) setupSucceeded = true;
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `${tool} ${failed ? 'failed' : 'completed'}`, tool, toolStatus: failed ? 'failed' : 'completed' });
            }
            if (message.type === 'assistant' && block.type === 'text') {
              for (const line of block.text.split('\n')) {
                if (!line.startsWith('PLANNER_PROGRESS ')) continue;
                let progress;
                try { progress = JSON.parse(line.slice('PLANNER_PROGRESS '.length)); } catch { continue; }
                if (STAGES.has(progress.stage) && typeof progress.message === 'string')
                  emit({ stage: progress.stage, message: redactProgress(progress.message, input) });
              }
            }
          }
        }
      });
      signal.throwIfAborted();
      if (!setupSucceeded) throw new Error('Planner did not successfully initialize the target browser');
      emit({ stage: 'finalizing', message: 'Validating test cases and formatting the draft' });
      return formatResult(output, input);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
}
