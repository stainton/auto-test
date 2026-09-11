import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlannerWorker } from '../planner/worker.mjs';
import { input, output } from './fixtures.mjs';

async function setup(t, runtime) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'planner-worker-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, worker: createPlannerWorker({ runtime, temporaryRoot, playwrightPackage: '/runtime/node_modules/@playwright/test/package.json' }) };
}
function browserSetup(options) {
  options.onMessage({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright-test', status: 'connected' }] });
  options.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'setup-1', name: 'mcp__playwright-test__planner_setup_page', input: { seedFile: 'seed.spec.ts' } }] } });
  options.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'setup-1', content: 'Ready' }] } });
}

test('uses caller input, isolated config, direct MCP tools, progress and strict structured output', async t => {
  const events = [];
  const { worker, temporaryRoot } = await setup(t, async options => {
    const prompt = JSON.parse(options.prompt);
    assert.deepEqual(prompt.requirements, input.requirements);
    assert.equal(prompt.context.explorationNotes, input.context.explorationNotes);
    assert.equal(prompt.target.storageState, undefined);
    assert.deepEqual(options.allowedTools, ['mcp__playwright-test__*']);
    assert.ok(options.disallowedTools.includes('mcp__playwright-test__generator_write_test'));
    assert.ok(options.mcpConfig.mcpServers['playwright-test'].args.includes('run-test-mcp-server'));
    assert.ok(!options.mcpConfig.mcpServers['playwright-test'].args.some(arg => arg.includes('mcp-filter')));
    const config = await readFile(path.join(options.cwd, 'playwright.config.cjs'), 'utf8');
    assert.match(config, /example.test\/login/);
    assert.match(config, /"headless":true/);
    assert.match(await readFile(path.join(options.cwd, 'seed.spec.ts'), 'utf8'), /page.goto/);
    browserSetup(options);
    options.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'PLANNER_PROGRESS {"stage":"exploring","message":"super-secret-password"}\nPLANNER_PROGRESS invalid' }] } });
    return output;
  });
  const result = await worker(input, { signal: new AbortController().signal, emit: event => events.push(event) });
  assert.equal(result.cases[0].request, 'REQ-001');
  assert.ok(events.some(e => e.toolStatus === 'completed'));
  assert.ok(events.some(e => e.message === 'super-secret-password'));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('rejects fabricated completion without successful browser setup and cleans failed workspaces', async t => {
  const { worker, temporaryRoot } = await setup(t, async () => output);
  await assert.rejects(worker(input, { signal: new AbortController().signal, emit() {} }), /initialize/);
  assert.deepEqual(await readdir(temporaryRoot), []);
});
