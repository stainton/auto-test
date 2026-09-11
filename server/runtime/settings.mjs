import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

export async function readClaudeSettings(file) {
  let settings;
  try { settings = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Claude settings file contains invalid JSON');
    throw new Error(`Cannot read Claude settings file: ${file}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Claude settings must be a JSON object');
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env) ||
      Object.values(settings.env).some(value => typeof value !== 'string')))
    throw new Error('Claude settings.env must be an object of string values');
  if (settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim()))
    throw new Error('Claude settings.model must be a nonempty string');
  return settings;
}

export async function resolveClaudeOptions({ env = process.env, defaultSettingsPath } = {}) {
  let settingsPath = env.PLANNER_CLAUDE_SETTINGS;
  if (!settingsPath && defaultSettingsPath) {
    try { await access(defaultSettingsPath); settingsPath = defaultSettingsPath; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  settingsPath = settingsPath ? path.resolve(settingsPath) : undefined;
  const settings = settingsPath ? await readClaudeSettings(settingsPath) : {};
  // Leave the CLI's settings/model precedence intact unless PLANNER_MODEL explicitly overrides it.
  const configuredModel = settings.model || settings.env?.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL;
  const model = env.PLANNER_MODEL || (configuredModel ? undefined : 'haiku');
  // Authentication is resolved by Claude from this explicit file and the process environment.
  // Do not require a separate ANTHROPIC_API_KEY when a token/helper/provider is configured in settings.
  return { settingsPath, model };
}
