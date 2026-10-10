// The planner pod: test design (/v1/planner/*) in its own process, with its own browser and job store.
// Generator/healer run in a separate pod (generator/main.mjs); exploration experience lives in CaseHub.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../runtime/claude.mjs';
import { checkPlaywrightRuntime } from '../runtime/preflight.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';
import { createRoutedServer } from '../shared/http.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { createPlannerService } from './service.mjs';

export async function main() {
  const host = process.env.PLANNER_HOST ?? '0.0.0.0';
  const settingsOptions = {
    defaultSettingsPath: fileURLToPath(new URL('../../build/planner/setting.json', import.meta.url))
  };
  await resolveClaudeOptions(settingsOptions); // Fail early on an invalid configured file.
  // CaseHub sends the configuration it stores for this agent with every request; applying it here
  // rewrites the settings file, and the reloading runtime picks it up on the next CLI invocation.
  const applySettings = createSettingsApplier(settingsPathFor(settingsOptions));
  const runtime = createReloadingRuntime(runClaude, settingsOptions);
  const command = process.env.PLANNER_CLAUDE_COMMAND ?? 'claude';
  const playwrightPackage = await checkPlaywrightRuntime(command);
  // Job files sit directly in the data dir (the layout earlier planner images used, so an existing volume
  // keeps its tasks).
  const dataDir = process.env.PLANNER_DATA_DIR ?? path.join(tmpdir(), 'auto-test-planner-jobs');
  // Files CaseHub pushes for tasks (see shared/assets.mjs); kept apart from job data so pruning one never touches the other.
  const assetCache = new AssetCache({ dir: process.env.PLANNER_ASSET_DIR ?? path.join(tmpdir(), 'auto-test-planner-assets'),
    maxBytes: positive('PLANNER_ASSET_CACHE_MB', 2048) * 1024 * 1024 });
  const planner = createPlannerService({ command, runtime, applySettings, playwrightPackage, assetCache, jobsDir: dataDir,
    concurrency: positive('PLANNER_CONCURRENCY', 1) });
  const server = createRoutedServer([planner]);
  server.listen(positive('PLANNER_PORT', 4501), host, () => console.log(`Planner HTTP service listening on ${host}:${server.address().port}`));
  let stopping = false;
  const shutdown = () => { if (!stopping) { stopping = true; return server.shutdown(); } };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { server, jobs: planner.jobs };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Planner startup failed: ${error.message}`); process.exitCode = 1; });
}
