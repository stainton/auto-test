// Planner, generator and healer in one process, for a single-container setup or local development.
// Production deploys them as separate pods (planner/main.mjs and generator/main.mjs); every workflow is
// built from the same service module either way, so routes and contracts are identical. Exploration
// experience lives in CaseHub and arrives with each request.
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../runtime/claude.mjs';
import { checkPlaywrightRuntime } from '../runtime/preflight.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';
import { createRoutedServer, stopOnSignals } from '../shared/http.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { authSessionsFromEnv } from '../shared/auth-session.mjs';
import { createPlannerService } from '../planner/service.mjs';
import { createGeneratorService } from '../generator/service.mjs';
import { createHealerService, seedHealerSettings } from '../healer/service.mjs';

export async function main() {
  const host=process.env.AUTOMATION_HOST??'0.0.0.0';
  const dataDir=process.env.AUTOMATION_DATA_DIR??path.join(tmpdir(),'auto-test-automation');
  const defaultSettingsPath=fileURLToPath(new URL('../../build/automation/setting.json',import.meta.url));
  const plannerSettings={defaultSettingsPath};
  const generatorSettings={prefix:'GENERATOR',defaultSettingsPath};
  const healerSettings={prefix:'HEALER',defaultSettingsPath:path.join(dataDir,'healer-settings.json')};
  await seedHealerSettings(settingsPathFor(healerSettings),settingsPathFor(generatorSettings));
  for(const options of [healerSettings,plannerSettings,generatorSettings])await resolveClaudeOptions(options);
  const command=process.env.AUTOMATION_CLAUDE_COMMAND??process.env.PLANNER_CLAUDE_COMMAND??'claude';
  const playwrightPackage=await checkPlaywrightRuntime(command);
  const assetCache=new AssetCache({dir:process.env.AUTOMATION_ASSET_DIR??path.join(dataDir,'assets'),maxBytes:positive('AUTOMATION_ASSET_CACHE_MB',2048)*1024*1024});
  const shared={command,playwrightPackage,assetCache,authSessions:authSessionsFromEnv()};
  const runtimeFor=options=>({runtime:createReloadingRuntime(runClaude,options),applySettings:createSettingsApplier(settingsPathFor(options))});
  // Jobs live in memory; dataDir only holds task workspaces (cleared on start), the asset cache and the healer's settings.
  const planner=createPlannerService({...shared,...runtimeFor(plannerSettings),workspaceRoot:path.join(dataDir,'planner-workspaces'),concurrency:positive('AUTOMATION_CONCURRENCY',1)});
  const generator=createGeneratorService({...shared,...runtimeFor(generatorSettings),workspaceRoot:path.join(dataDir,'generator-workspaces'),concurrency:positive('AUTOMATION_CONCURRENCY',1)});
  const healer=createHealerService({...shared,...runtimeFor(healerSettings),workspaceRoot:path.join(dataDir,'healer-workspaces')});
  const server=createRoutedServer([{...healer,prefix:'/v1/healer/'},{...generator,prefix:'/v1/generator/'},planner]);
  server.listen(positive('AUTOMATION_PORT',4501),host,()=>console.log(`Automation HTTP service listening on ${host}:${server.address().port}`));
  stopOnSignals(server,{label:'Automation',drainTimeoutMs:positive('AUTOMATION_DRAIN_TIMEOUT_MS',3600000),holdMs:positive('AUTOMATION_DRAIN_HOLD_MS',60000)});
  return {server,plannerJobs:planner.jobs,generatorJobs:generator.jobs,healerJobs:healer.jobs};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`Automation startup failed: ${error.message}`);process.exitCode=1});
