// Planner, generator and healer in one process, for a single-container setup or local development.
// Production deploys them as separate pods (planner/main.mjs and generator/main.mjs); every workflow is
// built from the same service module either way, so routes and contracts are identical.
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
import { createPlannerService } from '../planner/service.mjs';
import { createGeneratorService } from '../generator/service.mjs';
import { createHealerService, seedHealerSettings } from '../healer/service.mjs';

export { ExperienceStore, ProductExperienceStore, withExperience } from '../shared/experience.mjs';

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
  const {experience,productExperience}=openExperience(dataDir,{file:process.env.AUTOMATION_EXPERIENCE_FILE,productFile:process.env.AUTOMATION_PRODUCT_EXPERIENCE_FILE});
  const shared={command,playwrightPackage,assetCache,experience,productExperience};
  const runtimeFor=options=>({runtime:createReloadingRuntime(runClaude,options),applySettings:createSettingsApplier(settingsPathFor(options))});
  const planner=createPlannerService({...shared,...runtimeFor(plannerSettings),jobsDir:path.join(dataDir,'planner-jobs'),concurrency:positive('AUTOMATION_CONCURRENCY',1)});
  const generator=createGeneratorService({...shared,...runtimeFor(generatorSettings),jobsDir:path.join(dataDir,'generator-jobs'),workspaceRoot:path.join(dataDir,'generator-workspaces'),concurrency:positive('AUTOMATION_CONCURRENCY',1)});
  const healer=createHealerService({...shared,...runtimeFor(healerSettings),jobsDir:path.join(dataDir,'healer-jobs'),workspaceRoot:path.join(dataDir,'healer-workspaces')});
  const server=createRoutedServer([{...healer,prefix:'/v1/healer/'},{...generator,prefix:'/v1/generator/'},planner]);
  server.listen(positive('AUTOMATION_PORT',4501),host,()=>console.log(`Automation HTTP service listening on ${host}:${server.address().port}`));
  let stopping=false; const shutdown=()=>{if(!stopping){stopping=true;return server.shutdown();}};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  return {server,plannerJobs:planner.jobs,generatorJobs:generator.jobs,healerJobs:healer.jobs,experience,productExperience};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`Automation startup failed: ${error.message}`);process.exitCode=1});
