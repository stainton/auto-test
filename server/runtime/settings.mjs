import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

export function parseClaudeSettings(text) {
  let settings;
  try { settings = JSON.parse(text); }
  catch { throw new Error('Claude settings file contains invalid JSON'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Claude settings must be a JSON object');
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env) ||
      Object.values(settings.env).some(value => typeof value !== 'string')))
    throw new Error('Claude settings.env must be an object of string values');
  if (settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model.trim()))
    throw new Error('Claude settings.model must be a nonempty string');
  return settings;
}

export async function readClaudeSettings(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new Error(`Cannot read Claude settings file: ${file}`); }
  return parseClaudeSettings(text);
}

// prefix selects the calling service's environment variables (PLANNER_*, GENERATOR_*); the
// configuration shape and the CLI's own precedence are identical for every service.
export function settingsPathFor({ env = process.env, defaultSettingsPath, prefix = 'PLANNER' } = {}) {
  const file = env[`${prefix}_CLAUDE_SETTINGS`] || defaultSettingsPath;
  return file ? path.resolve(file) : undefined;
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function resolveClaudeOptions(options = {}) {
  const { env = process.env, prefix = 'PLANNER' } = options;
  let settingsPath = settingsPathFor(options);
  // A configured path must be readable; the built-in default is optional until something writes it.
  if (settingsPath && !env[`${prefix}_CLAUDE_SETTINGS`] && !await exists(settingsPath)) settingsPath = undefined;
  const settings = settingsPath ? await readClaudeSettings(settingsPath) : {};
  // Leave the CLI's settings/model precedence intact unless PLANNER_MODEL explicitly overrides it.
  const configuredModel = settings.model || settings.env?.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL;
  const model = env[`${prefix}_MODEL`] || (configuredModel ? undefined : 'haiku');
  // Authentication is resolved by Claude from this explicit file and the process environment.
  // Do not require a separate ANTHROPIC_API_KEY when a token/helper/provider is configured in settings.
  return { settingsPath, model };
}

// CaseHub stores every agent's configuration in its database and sends the current one with each
// request (contract.mjs `agentSettings`). This service is a follower: it holds no copy of its own and
// no override file — before a request runs, its configuration file is made to match what CaseHub sent,
// so that is what the next Claude CLI invocation reads. A file that drifted (hand-edited, or rebuilt
// from an older image) is replaced, by design; "落后了没关系，一切以 CaseHub 发过来的为准". An unchanged
// configuration costs one small read and writes nothing.
export function createSettingsApplier(file) {
  let appliedRevision;
  return async function applyAgentSettings(settings) {
    if (!settings) return appliedRevision;
    if (!file) throw new Error('No Claude settings path is configured for this service');
    let current;
    try { current = await readFile(file, 'utf8'); } catch { current = undefined; }
    if (current !== settings.content) {
      // Reject an unusable configuration before it reaches disk: the sender, not this service, is at fault.
      try { parseClaudeSettings(settings.content); }
      catch (error) { error.invalidSettings = true; throw error; }
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(temporary, settings.content, { mode: 0o600 });
      await rename(temporary, file);
    }
    appliedRevision = settings.revision;
    return appliedRevision;
  };
}

// Resolve again for every CLI invocation, including estimate/simplify and resumed jobs, so a
// configuration written between two invocations takes effect without a restart. In particular, never
// retain a startup-time fallback model over a newly applied model.
export function createReloadingRuntime(runtime, settingsOptions) {
  return async options => {
    options.signal?.throwIfAborted();
    const current = await resolveClaudeOptions(settingsOptions);
    options.signal?.throwIfAborted();
    return runtime({ ...options, ...current });
  };
}
