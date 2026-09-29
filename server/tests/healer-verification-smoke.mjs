// Real browser verification of the final healer result, without a paid model call.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHealerWorker } from '../healer/worker.mjs';
const root=await mkdtemp(path.join(tmpdir(),'healer-verification-'));
const source=expected=>`import {test,expect} from '@playwright/test';
 test('healer verification',async({page},testInfo)=>{
  await page.setContent('<h1>ready</h1>');
  await test.step('验证页面标题',async()=>{
   try{await expect(page.locator('h1')).toHaveText('${expected}',{timeout:100});}
   finally{await testInfo.attach('标题截图',{body:await page.screenshot(),contentType:'image/png'});}
  });
 });`;
const result=code=>({status:'generated',code,summary:'修复完成',deviations:[],missingInputs:[],explorationNotes:''});
const input={cases:[{id:'HEAL-1',title:'heal',steps:'check',expects:'ready',script:source('wrong')}],target:{baseUrl:'http://example.test'}};
try {
 for(const pass of [true,false]){
  let retained;
  const worker=createHealerWorker({temporaryRoot:root,runtime:async options=>{
   options.onMessage({type:'assistant',message:{content:[{type:'tool_use',id:'run',name:'mcp__playwright-test__test_run'}]}});
   options.onMessage({type:'user',message:{content:[{type:'tool_result',tool_use_id:'run'}]}});
   return result(source(pass?'ready':'wrong'));
  }});
  const outcome=await worker(input,{signal:new AbortController().signal,emit:()=>{},retain:r=>{retained=r}});
  if(pass){assert.equal(outcome.generated,1);assert.deepEqual(await readdir(root),[]);}
  else{
   assert.equal(outcome.blocked,1);
   const report=JSON.parse(await readFile(path.join(retained.workspace,'test-results','report.json'),'utf8'));
   assert.equal(report.stats.unexpected,1);
   assert.ok(report.suites[0].specs[0].tests[0].results[0].attachments.some(a=>a.contentType==='image/png'));
  }
 }
 console.log('PASS: healer accepts truly passing returned code; rejects model-claimed success when assertions fail and preserves screenshots/report');
}finally{await rm(root,{recursive:true,force:true})}
