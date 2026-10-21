// The organizer's worker: one isolated browser and one Claude session per task, like the planner's (planner/worker.mjs),
// but it classifies the existing cases it is given instead of designing new ones (see contract.mjs). An interrupted
// run is continuable the same way: the workspace keeps the Claude session, checkpoint() hands its location to the job
// store, and a request with continueFrom arrives here as input.resume.
import { seedSpec } from '../shared/seed.mjs';
import { planAuthSession, stageAuthSession, readSavedAuthSession, clearAuthSession, authSessionNote } from '../shared/auth-session.mjs';
import { describePlaywrightAction } from '../shared/playwright-progress.mjs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runClaude } from '../runtime/claude.mjs';
import { writeTaskSettings } from '../runtime/settings.mjs';
import { restoreCheckpoint } from '../planner/checkpoint.mjs';
import { SYSTEM_PROMPT, buildPrompt, buildContinuationPrompt, outputSchema, formatResult } from './contract.mjs';

const require = createRequire(import.meta.url);
// Exploration only: no test generation, running, or plan saving.
export const EXCLUDED_TOOLS = ['generator_setup_page', 'generator_read_log', 'generator_write_test',
  'test_list', 'test_run', 'test_debug', 'planner_save_plan', 'planner_submit_plan'];
const STAGES = new Set(['reading_requirements', 'preparing', 'exploring', 'designing', 'finalizing']);

export function createOrganizerWorker({ runtime = runClaude, command, model, settingsPath, playwrightPackage, assetCache, authSessions,
  temporaryRoot = tmpdir() } = {}) {
  return async function organizer(input, { signal, emit, checkpoint = () => {}, settings }) {
    signal.throwIfAborted();
    const resumed = Boolean(input.resume);
    if (!input.resume?.workspace) await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const workspace = input.resume?.workspace ?? await mkdtemp(path.join(temporaryRoot, 'organizer-'));
    let sessionId = input.resume?.sessionId ?? randomUUID();
    if (input.resume?.checkpoint) {
      try {
        if (!assetCache) throw new Error('This organizer has no asset cache to receive a checkpoint');
        let archive;
        try { archive = await readFile(assetCache.path(input.resume.checkpoint)); }
        catch { throw new Error('The checkpoint is no longer cached on this node; push it again and resubmit'); }
        ({ sessionId } = await restoreCheckpoint(archive, workspace));
      } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
    }
    checkpoint({ sessionId, workspace });
    const taskSettingsPath = settings ? await writeTaskSettings(workspace, settings) : settingsPath;
    let keepWorkspace = false, authFile, plan;
    try {
      emit({ stage: 'preparing', message: resumed ? 'Reopening the interrupted session in a new browser' : 'Preparing an isolated browser session' });
      const packagePath = playwrightPackage ?? require.resolve('@playwright/test/package.json');
      const testEntry = path.join(path.dirname(packagePath), 'index.js');
      const cli = path.join(path.dirname(packagePath), 'cli.js');
      const configPath = path.join(workspace, 'playwright.config.cjs');
      const config = { testDir: workspace, testMatch: 'seed.spec.ts', workers: 1, retries: 0,
        timeout: 30000, outputDir: path.join(workspace, 'test-results'), reporter: [['list']],
        use: { headless: true, browserName: 'chromium', viewport: { width: 1920, height: 1080 }, baseURL: input.target.baseUrl,
          actionTimeout: 10000, navigationTimeout: 30000, screenshot: 'off', trace: 'off', video: 'off',
          ...(input.target.storageState ? { storageState: input.target.storageState } : {}),
          ...(input.target.extraHTTPHeaders ? { extraHTTPHeaders: input.target.extraHTTPHeaders } : {}) } };
      await writeFile(configPath, `module.exports = ${JSON.stringify(config)};\n`, { mode: 0o600 });
      // Reuse a login an earlier task saved for this target and account (shared/auth-session.mjs).
      plan = planAuthSession(authSessions, input, input.products.map(p => p.name));
      authFile = plan.capture ? await stageAuthSession(workspace, plan.preload) : undefined;
      await writeFile(path.join(workspace, 'seed.spec.ts'), seedSpec({ testEntry, name: 'organizer seed', baseUrl: input.target.baseUrl,
        replay: input.productReplay, storageStatePath: plan.preload ? authFile : undefined }), { mode: 0o600 });
      const authSession = authSessionNote(plan, authFile);
      const mcpConfig = { mcpServers: { 'playwright-test': { type: 'stdio', command: process.execPath,
        args: [cli, 'run-test-mcp-server', '--headless', '--config', configPath] } } };
      const promptInput = { ...input, ...(authSession ? { authSession } : {}) };
      const calls = new Map();
      let setupSucceeded = false;
      const output = await runtime({ cwd: workspace, prompt: resumed ? buildContinuationPrompt(promptInput) : buildPrompt(promptInput),
        systemPrompt: SYSTEM_PROMPT, schema: outputSchema(input), mcpConfig, allowedTools: ['mcp__playwright-test__*'],
        disallowedTools: EXCLUDED_TOOLS.map(t => `mcp__playwright-test__${t}`),
        signal, command, model, settingsPath: taskSettingsPath,
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
              const action = describePlaywrightAction(tool, block.input);
              calls.set(block.id, { tool, action });
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `正在${action}`, tool, toolStatus: 'started' });
            }
            if (message.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
              const { tool, action } = calls.get(block.tool_use_id);
              calls.delete(block.tool_use_id);
              const failed = Boolean(block.is_error);
              if (tool === 'planner_setup_page' && !failed) setupSucceeded = true;
              emit({ stage: tool === 'planner_setup_page' ? 'preparing' : 'exploring', message: `${action}${failed ? '失败' : '已完成'}`, tool, toolStatus: failed ? 'failed' : 'completed' });
            }
            if (message.type === 'assistant' && block.type === 'text') {
              for (const line of block.text.split('\n')) {
                if (!line.startsWith('PLANNER_PROGRESS ')) continue;
                let progress;
                try { progress = JSON.parse(line.slice('PLANNER_PROGRESS '.length)); } catch { continue; }
                if (STAGES.has(progress.stage) && typeof progress.message === 'string') emit({ stage: progress.stage, message: progress.message });
              }
            }
          }
        }
      });
      signal.throwIfAborted();
      if (!setupSucceeded && !resumed) throw new Error('Organizer did not successfully initialize the target browser');
      emit({ stage: 'finalizing', message: 'Validating the case classification' });
      const result = formatResult(output, input);
      checkpoint(null);
      return result;
    } catch (error) {
      keepWorkspace = signal.reason?.code !== 'JOB_CANCELLED';
      if (!keepWorkspace) checkpoint(null);
      throw error;
    } finally {
      if (plan?.capture) { const saved = await readSavedAuthSession(workspace); if (saved) authSessions.put(plan.key, saved); }
      await clearAuthSession(workspace);
      if (!keepWorkspace) await rm(workspace, { recursive: true, force: true });
    }
  };
}
