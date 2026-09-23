import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExperienceStore, withExperience } from '../automation/main.mjs';

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
