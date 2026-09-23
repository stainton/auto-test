// One process for the specialised Playwright workflows. The public routes stay
// separate (/v1/planner and /v1/generator), but browser dependencies, the job
// host and requirement-scoped exploration experience are shared.
import http from 'node:http';
import path from 'node:path';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpHandler } from '../shared/http.mjs';
import { AssetCache } from '../shared/assets.mjs';
import { runClaude } from '../runtime/claude.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';
import { validateInput as validatePlannerInput, MAX_TIMEOUT_MS } from '../planner/contract.mjs';
import { createPlannerWorker } from '../planner/worker.mjs';
import { createSimplifier, validateSimplifyInput } from '../planner/simplify.mjs';
import { createEstimator, validateEstimateInput } from '../planner/estimate.mjs';
import { validateInput as validateGeneratorInput } from '../generator/contract.mjs';
import { createGeneratorWorker } from '../generator/worker.mjs';
import { startExecutor } from '../executor/main.mjs';

const positive=(name,fallback)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1)throw new Error(`${name} must be a positive integer`);return n};
const trimNotes=notes=>String(notes||'').trim().slice(0,200000);

export class ExperienceStore {
  constructor(file) { this.file=file; this.records={}; try { this.records=JSON.parse(readFileSync(file,'utf8'))||{}; } catch {} }
  notes(ids) { return ids.map(id=>this.records[id]?.notes||'').filter(Boolean).join('\n\n'); }
  async merge(ids, notes) {
    notes=trimNotes(notes); if(!notes||!ids.length)return;
    const at=new Date().toISOString();
    for(const id of ids)this.records[id]={notes,updatedAt:at};
    await mkdir(path.dirname(this.file),{recursive:true});
    await writeFile(this.file,JSON.stringify(this.records,null,2)+'\n',{mode:0o600});
  }
}
function requirementIDs(input){return [...new Set((input.requirements||[]).map(r=>r.id).filter(Boolean))]}
export function withExperience(worker, store) {
  return async (input, context) => {
    const ids=requirementIDs(input), prior=store.notes(ids);
    const supplied=trimNotes(input.context?.explorationNotes);
    const notes=[supplied,prior].filter((value,index,all)=>value&&all.indexOf(value)===index).join('\n\n');
    const enriched=notes?{...input,context:{...input.context,explorationNotes:notes}}:input;
    const result=await worker(enriched,context);
    if(result.explorationRecords&&typeof result.explorationRecords==='object'){
      for(const [id,notes] of Object.entries(result.explorationRecords))await store.merge([id],notes);
    }else await store.merge(ids,result.explorationNotes);
    return result;
  };
}

export async function main() {
  const host=process.env.AUTOMATION_HOST??'0.0.0.0';
  const dataDir=process.env.AUTOMATION_DATA_DIR??path.join(tmpdir(),'auto-test-automation');
  const defaultSettingsPath=fileURLToPath(new URL('../../build/automation/setting.json',import.meta.url));
  const plannerSettings={defaultSettingsPath};
  const generatorSettings={prefix:'GENERATOR',defaultSettingsPath};
  await resolveClaudeOptions(plannerSettings); await resolveClaudeOptions(generatorSettings);
  const plannerRuntime=createReloadingRuntime(runClaude,plannerSettings);
  const generatorRuntime=createReloadingRuntime(runClaude,generatorSettings);
  const plannerApply=createSettingsApplier(settingsPathFor(plannerSettings));
  const generatorApply=createSettingsApplier(settingsPathFor(generatorSettings));
  const command=process.env.AUTOMATION_CLAUDE_COMMAND??process.env.PLANNER_CLAUDE_COMMAND??'claude';
  execFileSync(command,['--version'],{timeout:10000,stdio:'ignore'});
  const require=createRequire(import.meta.url), playwrightPackage=require.resolve('@playwright/test/package.json');
  await access(path.join(path.dirname(playwrightPackage),'cli.js'));
  const {chromium}=require('playwright'); await access(chromium.executablePath());
  const assetCache=new AssetCache({dir:process.env.AUTOMATION_ASSET_DIR??path.join(dataDir,'assets'),maxBytes:positive('AUTOMATION_ASSET_CACHE_MB',2048)*1024*1024});
  const experience=new ExperienceStore(process.env.AUTOMATION_EXPERIENCE_FILE??path.join(dataDir,'exploration-experience.json'));
  let plannerJobs;
  const plannerWorker=withExperience(createPlannerWorker({command,runtime:plannerRuntime,playwrightPackage,assetCache}),experience);
  plannerJobs=new Jobs({worker:plannerWorker,dataDir:path.join(dataDir,'planner-jobs'),concurrency:positive('AUTOMATION_CONCURRENCY',1),timeoutMs:positive('PLANNER_TIMEOUT_MS',900000),timeoutFor:input=>input.timeoutMs&&Math.min(input.timeoutMs,positive('PLANNER_MAX_TIMEOUT_MS',MAX_TIMEOUT_MS)),maxJobs:positive('PLANNER_MAX_JOBS',100),retentionMs:positive('PLANNER_RETENTION_MS',86400000),discard:state=>{if(state?.workspace)rmSync(state.workspace,{recursive:true,force:true})}});
  const validatePlanner=async payload=>{
    const input=validatePlannerInput(payload);
    for(const asset of input.context?.assets??[])if(!await assetCache.has(asset.sha256))throw new ServiceError(409,'ASSET_NOT_CACHED',`Asset ${asset.name} has not been uploaded to this service`);
    if(input.continueFrom===undefined)return input;
    const resume=plannerJobs.claimContinuation(input.continueFrom);
    if(!existsSync(resume.workspace))throw new ServiceError(409,'NOT_CONTINUABLE','The interrupted session is no longer on this server; start a new design task');
    delete input.continueFrom; return {...input,resume};
  };
  const generatorWorker=withExperience(createGeneratorWorker({command,runtime:generatorRuntime,playwrightPackage,assetCache,caseTimeoutMs:positive('GENERATOR_CASE_TIMEOUT_MS',600000)}),experience);
  const generatorJobs=new Jobs({kind:'generator',label:'Generator',started:{stage:'reading_cases',message:'Reading the submitted test cases and context'},completion:result=>({message:`Generated ${result.generated} of ${result.scripts.length} scripts`,scriptsGenerated:result.generated,scriptsBlocked:result.blocked}),worker:generatorWorker,dataDir:path.join(dataDir,'generator-jobs'),concurrency:positive('AUTOMATION_CONCURRENCY',1),timeoutMs:positive('GENERATOR_TIMEOUT_MS',3600000),maxJobs:positive('GENERATOR_MAX_JOBS',100),retentionMs:positive('GENERATOR_RETENTION_MS',86400000)});
  const plannerHandler=createHttpHandler({jobs:plannerJobs,applySettings:plannerApply,assetCache,validateInput:validatePlanner,validateSimplifyInput,simplify:createSimplifier({command,runtime:plannerRuntime}),simplifyTimeoutMs:positive('PLANNER_SIMPLIFY_TIMEOUT_MS',60000),validateEstimateInput,estimate:createEstimator({command,runtime:plannerRuntime}),estimateTimeoutMs:positive('PLANNER_ESTIMATE_TIMEOUT_MS',120000),openapiPath:fileURLToPath(new URL('../planner/openapi.json',import.meta.url))});
  const validateGenerator=async payload=>{const input=validateGeneratorInput(payload);for(const asset of input.context?.assets??[])if(!await assetCache.has(asset.sha256))throw new ServiceError(409,'ASSET_NOT_CACHED',`Asset ${asset.name} has not been uploaded to this service`);return input;};
  const generatorHandler=createHttpHandler({jobs:generatorJobs,applySettings:generatorApply,assetCache,validateInput:validateGenerator,basePath:'/v1/generator',openapiPath:fileURLToPath(new URL('../generator/openapi.json',import.meta.url))});
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://automation.local').pathname;
    if(req.method==='GET'&&(pathname==='/healthz'||pathname==='/readyz')){const ready=!plannerJobs.closing&&!generatorJobs.closing;res.writeHead(ready?200:503,{'Content-Type':'application/json'});return res.end(JSON.stringify({status:ready?'ready':'unavailable'}));}
    return pathname.startsWith('/v1/generator/')?generatorHandler(req,res):plannerHandler(req,res);
  });
  server.requestTimeout=600000; server.listen(positive('AUTOMATION_PORT',4501),host,()=>console.log(`Automation HTTP service listening on ${host}:${server.address().port}`));
  const executor=await startExecutor({host,port:positive('EXECUTOR_PORT',4504),dataDir:path.join(dataDir,'executor')});
  let stopping=false; const shutdown=async()=>{if(stopping)return;stopping=true;server.close();executor.server.close();await Promise.all([plannerJobs.close(),generatorJobs.close(),executor.jobs.close()]);plannerHandler.closeStreams();generatorHandler.closeStreams();executor.server.closeStreams();server.closeAllConnections();executor.server.closeAllConnections();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  return {server,plannerJobs,generatorJobs,executor,experience};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`Automation startup failed: ${error.message}`);process.exitCode=1});
