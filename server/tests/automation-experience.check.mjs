import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExperienceStore, ProductExperienceStore, withExperience } from '../automation/main.mjs';

test('shared exploration experience is keyed by requirement and returned with each workflow result', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'automation-experience-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'experience.json'),store=new ExperienceStore(file),seen=[];
  const worker=withExperience(async input=>{seen.push(input.context.explorationNotes);return {explorationNotes:`${input.context.explorationNotes}\nnew locator`};},store);
  await worker({requirements:[{id:'REQ-LOGIN'}],context:{explorationNotes:'login form'}},{});
  await worker({requirements:[{id:'REQ-LOGIN'}],context:{}},{});
  await worker({requirements:[{id:'REQ-PAY'}],context:{}},{});
  assert.equal(seen[1],'login form\nnew locator');
  assert.equal(seen[2]??'','');
  assert.match(await readFile(file,'utf8'),/REQ-LOGIN/);
});


test('product experience is shared by origin, isolated between products and persists verification metadata', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'automation-product-experience-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const product=new ProductExperienceStore(path.join(dir,'product.json'));
  await product.mergeFor({baseUrl:'https://app.example.test/login'},'登录入口 /login\n新建按钮 getByRole');
  assert.match(product.notesFor({baseUrl:'https://app.example.test/assets'}),/登录入口/);
  assert.equal(product.notesFor({baseUrl:'https://other.example.test'}),'');
  assert.equal(product.entry({baseUrl:'https://app.example.test'}).uses,1);
  assert.match(await readFile(path.join(dir,'product.json'),'utf8'),/verifiedAt/);
});

test('workflow injects product experience before requirement experience and writes discoveries back', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'automation-product-worker-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const requirement=new ExperienceStore(path.join(dir,'requirement.json')), product=new ProductExperienceStore(path.join(dir,'product.json'));
  await product.mergeFor({baseUrl:'https://app.example.test'},'稳定菜单 locator');
  let seen=''; const worker=withExperience(async input=>{seen=input.context.explorationNotes;return {explorationNotes:'修复后的素材弹窗 locator'};},requirement,product);
  await worker({target:{baseUrl:'https://app.example.test/a'},requirements:[{id:'REQ-1'}],context:{explorationNotes:'需求字段'}},{});
  assert.match(seen,/产品级探索经验/);assert.match(seen,/稳定菜单/);assert.match(seen,/需求字段/);
  assert.match(product.notesFor({baseUrl:'https://app.example.test'}),/修复后的素材弹窗/);
  await product.mergeFor({baseUrl:'https://app.example.test'},`[产品级探索经验：先快速验证，失效时局部修复]\n${product.notesFor({baseUrl:'https://app.example.test'})}\n新的下拉框 locator`);
  assert.equal((product.notesFor({baseUrl:'https://app.example.test'}).match(/修复后的素材弹窗/g)||[]).length,1);
  assert.match(product.notesFor({baseUrl:'https://app.example.test'}),/新的下拉框 locator/);
});
