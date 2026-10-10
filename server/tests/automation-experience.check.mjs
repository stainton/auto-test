import test from 'node:test';
import assert from 'node:assert/strict';
import { withExperience, productDelta, productScope } from '../shared/experience.mjs';

test('product experience from the request is injected before requirement notes and drives the replay seed', async () => {
  let seen;
  const worker=withExperience(async input=>{seen=input;return {explorationNotes:''};});
  const result=await worker({target:{baseUrl:'https://app.example.test/a'},context:{explorationNotes:'需求字段',productExperience:'稳定菜单 locator\nREPLAY: goto /assets',instructions:'x'}},{});
  assert.match(seen.context.explorationNotes,/^\[产品级探索经验[^\n]*\n稳定菜单 locator/);
  assert.match(seen.context.explorationNotes,/需求字段$/);
  assert.equal(seen.context.productExperience,undefined);
  assert.equal(seen.context.instructions,'x');
  assert.deepEqual(seen.productReplay,[{action:'goto',url:'/assets'}]);
  assert.equal(result.productExperience,undefined);
});

test('only newly learned paragraphs are returned, keyed by the target origin', async () => {
  const prior='稳定菜单 locator\n\n登录入口 /login';
  const worker=withExperience(async input=>({explorationNotes:`${input.context.explorationNotes}\n\n修复后的素材弹窗 locator`}));
  const result=await worker({target:{baseUrl:'https://app.example.test/assets'},context:{productExperience:prior}},{});
  assert.deepEqual(result.productExperience,{origin:'https://app.example.test',notes:'修复后的素材弹窗 locator'});
  assert.equal(productDelta(prior,'登录入口 /login\n\n稳定菜单 locator'),'');
});

test('a run without prior experience reports everything it learned; a run with nothing new reports nothing', async () => {
  const learned=await withExperience(async()=>({explorationNotes:'新建按钮 getByRole'}))({target:{baseUrl:'https://app.example.test'}},{});
  assert.deepEqual(learned.productExperience,{origin:'https://app.example.test',notes:'新建按钮 getByRole'});
  const quiet=await withExperience(async()=>({explorationNotes:''}))({target:{baseUrl:'https://app.example.test'}},{});
  assert.equal('productExperience' in quiet,false);
  assert.equal(productScope({baseUrl:'not a url'}),'');
});
