import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInput } from '../healer/contract.mjs';
import { createHealerWorker } from '../healer/worker.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { Jobs } from '../shared/jobs.mjs';
import { eventually } from './fixtures.mjs';

const code=`import { test, expect } from '@playwright/test';
  test('case',async({page},testInfo)=>{await test.step('验证标题',async()=>{
    await expect(page).toHaveTitle('ok');await testInfo.attach('标题', {body:await page.screenshot(),contentType:'image/png'});
  });});`;
const input={cases:[{id:'TC-1',title:'title',steps:'check title',expects:'ok',script:code,failureDetails:'locator timed out'}],target:{baseUrl:'http://example.test'}};
const output={status:'generated',code,summary:'修复标题定位',missingInputs:[],deviations:[],explorationNotes:''};
const reportRun=options=>{
  options.onMessage({type:'assistant',message:{content:[{type:'tool_use',id:'run',name:'mcp__playwright-test__test_run',input:{locations:['TC-1.spec.ts']}}]}});
  options.onMessage({type:'user',message:{content:[{type:'tool_result',tool_use_id:'run',content:'1 passed'}]}});
};
async function setup(t,runtime,verifyOutput=async()=>{}){
  const temporaryRoot=await mkdtemp(path.join(tmpdir(),'healer-test-'));
  t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  return {temporaryRoot,worker:createHealerWorker({temporaryRoot,runtime,verifyOutput,playwrightPackage:'/runtime/node_modules/@playwright/test/package.json'})};
}
test('healer requires one existing script and validates case fields',()=>{
  assert.deepEqual(validateInput(input),input);
  for(const bad of [{...input,cases:[]},{...input,cases:[...input.cases,...input.cases]},
    {...input,cases:[{...input.cases[0],script:''}]},{...input,cases:[{...input.cases[0],failureDetails:{}}]},
    {...input,cases:[{...input.cases[0],unknown:true}]}])assert.throws(()=>validateInput(bad));
});
test('stages the original source, sends failure context, verifies output and cleans successful workspace',async t=>{
  let verified=false;
  const {worker,temporaryRoot}=await setup(t,async options=>{
    const payload=JSON.parse(options.prompt);
    assert.equal(payload.existingScript,code);assert.equal(payload.failureDetails,'locator timed out');
    assert.match(options.systemPrompt,/Never skip, fixme/);
    assert.equal(await readFile(path.join(options.cwd,'project','TC-1.spec.ts'),'utf8'),code);
    reportRun(options);return output;
  },async context=>{verified=true;assert.equal(context.output.code,code)});
  const result=await worker(input,{signal:new AbortController().signal,emit:()=>{}});
  assert.equal(result.generated,1);assert.equal(verified,true);assert.deepEqual(await readdir(temporaryRoot),[]);
});
test('does not accept a repair that was never run',async t=>{
  const {worker}=await setup(t,async()=>output);
  const result=await worker(input,{signal:new AbortController().signal,emit:()=>{}});
  assert.equal(result.blocked,1);assert.match(result.scripts[0].missingInputs[0],/did not run/);
});
test('failed independent verification retries in same session then preserves diagnostics',async t=>{
  const runs=[];let retained;
  const {worker}=await setup(t,async options=>{runs.push(options);reportRun(options);return output},async()=>{throw Error('assertion still failing')});
  const result=await worker(input,{signal:new AbortController().signal,emit:()=>{},retain:value=>{retained=value}});
  assert.equal(result.blocked,1);assert.equal(runs.length,3);assert.equal(runs[0].sessionId,runs[2].sessionId);assert.equal(runs[2].resume,true);
  assert.equal(await readFile(path.join(retained.workspace,'diagnostics','TC-1','1','TC-1.spec.ts'),'utf8'),code);
});
test('healer exposes independent jobs/result/SSE lifecycle under its own HTTP prefix',async t=>{
  const {worker,temporaryRoot}=await setup(t,async options=>{reportRun(options);return output});
  const jobs=new Jobs({kind:'healer',dataDir:path.join(temporaryRoot,'jobs'),worker,completion:r=>({message:'healed',scriptsGenerated:r.generated})});
  const server=createHttpServer({jobs,validateInput,basePath:'/v1/healer',openapiPath:fileURLToPath(new URL('../healer/openapi.json',import.meta.url))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await jobs.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/v1/generator/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,404);
  const response=await fetch(base+'/v1/healer/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,202);const job=await response.json();assert.equal(job.kind,'healer');
  await eventually(()=>jobs.get(job.id).status==='succeeded');
  const result=await(await fetch(base+`/v1/healer/jobs/${job.id}/result`)).json();assert.equal(result.generated,1);
});

test('a blocked repair preserves the concrete reason even when reproduction cannot start',async t=>{
  const {worker}=await setup(t,async()=>({...output,status:'blocked',code:'',summary:'缺少测试账号',missingInputs:['测试账号未提供，无法复现登录后的失败']}));
  const result=await worker(input,{signal:new AbortController().signal,emit:()=>{}});
  assert.equal(result.blocked,1);assert.equal(result.scripts[0].missingInputs[0],'测试账号未提供，无法复现登录后的失败');
});
