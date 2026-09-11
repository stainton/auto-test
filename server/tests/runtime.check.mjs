import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaude } from '../runtime/claude.mjs';
import { OUTPUT_SCHEMA } from '../planner/contract.mjs';
import { output, eventually } from './fixtures.mjs';

async function setup(t, script) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'planner-runtime-test-'));
  const command = path.join(cwd, 'fake-claude');
  await writeFile(command, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, command, prompt: 'caller-supplied-input', systemPrompt: 'planner', schema: OUTPUT_SCHEMA,
    mcpConfig: { mcpServers: {} }, allowedTools: ['mcp__playwright-test__planner_setup_page'], signal: new AbortController().signal, onMessage() {} };
}

test('executes a real subprocess with isolated settings and reads stdin/streamed structured output', async t => {
  const options = await setup(t, `
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', x => prompt += x);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({prompt, args: process.argv.slice(2)}));
  process.stdout.write(JSON.stringify({type:'result', subtype:'success', is_error:false, structured_output: ${JSON.stringify(output)}}) + '\\n');
});`);
  options.settingsPath = path.join(options.cwd, 'settings.json');
  await writeFile(options.settingsPath, '{}');
  assert.deepEqual(await runClaude(options), output);
  const invocation = JSON.parse(await readFile(path.join(options.cwd, 'invocation.json')));
  assert.equal(invocation.prompt, options.prompt);
  assert.ok(invocation.args.includes('--bare'));
  assert.equal(invocation.args[invocation.args.indexOf('--settings') + 1], options.settingsPath);
  assert.ok(!invocation.args.includes('--model'));
  assert.ok(invocation.args.includes('--strict-mcp-config'));
  assert.ok(invocation.args.includes('--no-session-persistence'));
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
});

test('cancellation terminates the subprocess and rejects instead of returning late output', async t => {
  const options = await setup(t, `require('node:fs').writeFileSync('pid', String(process.pid)); process.stdin.resume(); setInterval(() => {}, 100);`);
  const controller = new AbortController(); options.signal = controller.signal;
  const promise = runClaude(options);
  const rejected = assert.rejects(promise, /cancelled/);
  const pid = await eventually(async () => {
    try { return Number(await readFile(path.join(options.cwd, 'pid'), 'utf8')); } catch { return false; }
  });
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('invalid or oversized streams fail and terminate the runtime', async t => {
  for (const [script, options, pattern] of [
    [`process.stdout.write('invalid-json\\n'); setInterval(() => {}, 100);`, {}, /Invalid planner/],
    [`process.stdout.write('a'.repeat(2000)); setInterval(() => {}, 100);`, { maxOutputBytes: 100 }, /exceeded/],
    [`process.stdout.write(JSON.stringify({type:'result',subtype:'success'}));`, {}, /no structured/]
  ]) await assert.rejects(runClaude({ ...await setup(t, script), ...options }), pattern);
});
