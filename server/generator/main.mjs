// The generator pod: script generation (/v1/generator/*) and script repair (/v1/healer/*) in one process,
// separate from the planner pod. Both use the same browser runtime, asset cache and exploration experience;
// each keeps its own job store and Claude settings.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../runtime/claude.mjs';
import { checkPlaywrightRuntime } from '../runtime/preflight.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';
import { createRoutedServer } from '../shared/http.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { openExperience } from '../shared/experience.mjs';
import { createGeneratorService } from './service.mjs';
import { createHealerService, seedHealerSettings } from '../healer/service.mjs';

export async function main() {
  const host = process.env.GENERATOR_HOST ?? '0.0.0.0';
  // Job files sit directly in the data dir (the layout earlier generator images used, so an existing volume
  // keeps its tasks); healer jobs, workspaces and experience files sit in named entries beside them.
  const dataDir = process.env.GENERATOR_DATA_DIR ?? path.join(tmpdir(), 'auto-test-generator-jobs');
  // The runtime reads the same Claude configuration shape as the planner; GENERATOR_* / HEALER_* variables
  // select each workflow's own settings file, model and limits.
  const generatorSettings = { prefix: 'GENERATOR',
    defaultSettingsPath: fileURLToPath(new URL('../../build/generator/setting.json', import.meta.url)) };
  const healerSettings = { prefix: 'HEALER', defaultSettingsPath: path.join(dataDir, 'healer-settings.json') };
  await seedHealerSettings(settingsPathFor(healerSettings), settingsPathFor(generatorSettings));
  await resolveClaudeOptions(generatorSettings); await resolveClaudeOptions(healerSettings); // Fail early on an invalid file.
  const command = process.env.GENERATOR_CLAUDE_COMMAND ?? 'claude';
  const playwrightPackage = await checkPlaywrightRuntime(command);
  const assetCache = new AssetCache({ dir: process.env.GENERATOR_ASSET_DIR ?? path.join(tmpdir(), 'auto-test-generator-assets'),
    maxBytes: positive('GENERATOR_ASSET_CACHE_MB', 2048) * 1024 * 1024 });
  const shared = { command, playwrightPackage, assetCache, ...openExperience(dataDir) };
  // CaseHub stores each agent's configuration and sends it with every request; the applier rewrites the
  // settings file when the content changes and the reloading runtime re-reads it per CLI invocation.
  const generator = createGeneratorService({ ...shared, runtime: createReloadingRuntime(runClaude, generatorSettings),
    applySettings: createSettingsApplier(settingsPathFor(generatorSettings)),
    jobsDir: dataDir, workspaceRoot: path.join(dataDir, 'workspaces'), concurrency: positive('GENERATOR_CONCURRENCY', 1) });
  const healer = createHealerService({ ...shared, runtime: createReloadingRuntime(runClaude, healerSettings),
    applySettings: createSettingsApplier(settingsPathFor(healerSettings)),
    jobsDir: path.join(dataDir, 'healer-jobs'), workspaceRoot: path.join(dataDir, 'healer-workspaces') });
  const server = createRoutedServer([{ ...healer, prefix: '/v1/healer/' }, generator]);
  server.listen(positive('GENERATOR_PORT', 4502), host, () => console.log(`Generator HTTP service listening on ${host}:${server.address().port}`));
  let stopping = false;
  const shutdown = () => { if (!stopping) { stopping = true; return server.shutdown(); } };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { server, jobs: generator.jobs, healerJobs: healer.jobs };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Generator startup failed: ${error.message}`); process.exitCode = 1; });
}
