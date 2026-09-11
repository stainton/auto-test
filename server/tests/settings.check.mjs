import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, resolveClaudeOptions } from '../runtime/settings.mjs';
import { installSettings } from '../../build/planner/install-settings.mjs';

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'planner-settings-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('build installs supplied setting.json as settings.json, preserving Claude options', async t => {
  const dir = await directory(t);
  const supplied = { model: 'custom-model', env: { ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_BASE_URL: 'https://gateway.example.test' }, permissions: { deny: ['Bash'] } };
  await writeFile(path.join(dir, 'setting.json'), JSON.stringify(supplied));
  const destination = path.join(dir, 'image/config/claude/settings.json');
  await installSettings(dir, destination);
  assert.deepEqual(JSON.parse(await readFile(destination)), supplied);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await resolveClaudeOptions({ env: { PLANNER_CLAUDE_SETTINGS: destination } }), { settingsPath: destination, model: undefined });
});

test('model override is explicit; configured model and model environment are not overwritten', async t => {
  const dir = await directory(t), settingsPath = path.join(dir, 'setting.json');
  await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'gateway-model' } }));
  assert.equal((await resolveClaudeOptions({ env: {}, defaultSettingsPath: settingsPath })).model, undefined);
  assert.equal((await resolveClaudeOptions({ env: { PLANNER_MODEL: 'override' }, defaultSettingsPath: settingsPath })).model, 'override');
  assert.equal((await resolveClaudeOptions({ env: { ANTHROPIC_MODEL: 'environment-model' } })).model, undefined);
  assert.equal((await resolveClaudeOptions({ env: {} })).model, 'haiku');
});

test('optional absent input installs empty configuration; missing explicit file and invalid JSON fail safely', async t => {
  const dir = await directory(t), destination = path.join(dir, 'settings.json');
  await installSettings(dir, destination);
  assert.deepEqual(await readClaudeSettings(destination), {});
  await assert.rejects(resolveClaudeOptions({ env: { PLANNER_CLAUDE_SETTINGS: path.join(dir, 'missing.json') } }), /Cannot read/);
  await writeFile(path.join(dir, 'setting.json'), '{ "private": "secret-value",');
  await assert.rejects(installSettings(dir, destination), error => /invalid JSON/.test(error.message) && !error.message.includes('secret-value'));
  assert.deepEqual(await readClaudeSettings(destination), {});
});
