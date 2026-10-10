// Exploration experience reused across runs of the Playwright workflows. Each
// deployment (the combined automation process, or the separate planner and
// generator pods) keeps its own files under its data directory; CaseHub also
// stores the per-requirement records and sends them back with each request, so a
// planner discovery still reaches the generator when they run in different pods.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { replayFromNotes } from './navigation-replay.mjs';

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
// The agent is dedicated to one front-end product, but deployments often point it
// at several environments. Scope reusable navigation/locator experience by origin
// so staging facts cannot leak into another product or environment.
export class ProductExperienceStore extends ExperienceStore {
  scope(target) { try { return new URL(target?.baseUrl||'').origin; } catch { return ''; } }
  entry(target) { const key=this.scope(target); return key?this.records[key]:undefined; }
  notesFor(target) { return this.entry(target)?.notes||''; }
  replayFor(target) { return this.entry(target)?.replay||[]; }
  async mergeFor(target, notes) {
    const key=this.scope(target); notes=trimNotes(notes); if(!key||!notes)return;
    const old=this.records[key]||{}, oldNotes=old.notes||'';
    // Generator/planner are asked to merge prior notes in their response. Remove
    // that echoed prefix before storing, otherwise every run would duplicate the
    // whole product map.
    notes=notes.replace(/^\[产品级探索经验：先快速验证，失效时局部修复\]\s*/,'');
    if(oldNotes&&notes.includes(oldNotes))notes=notes.slice(notes.lastIndexOf(oldNotes)+oldNotes.length).trim();
    const chunks=[oldNotes,notes].filter(Boolean);
    // Keep the useful history bounded. The agent receives its own latest findings
    // first, while old entries stay available until the product genuinely changes.
    const merged=[...new Set(chunks.join('\n\n').split(/\n{2,}/).map(x=>x.trim()).filter(Boolean))].slice(-200).join('\n\n').slice(-200000);
    this.records[key]={...old,notes:merged,replay:replayFromNotes(merged),updatedAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),uses:(old.uses||0)+1};
    await mkdir(path.dirname(this.file),{recursive:true});
    await writeFile(this.file,JSON.stringify(this.records,null,2)+'\n',{mode:0o600});
  }
}
// Both stores of one process, at their conventional names under dataDir; the
// overrides keep AUTOMATION_*_FILE working for the combined service.
export function openExperience(dataDir, { file, productFile } = {}) {
  return {
    experience: new ExperienceStore(file ?? path.join(dataDir, 'exploration-experience.json')),
    productExperience: new ProductExperienceStore(productFile ?? path.join(dataDir, 'product-exploration-experience.json'))
  };
}
function requirementIDs(input){return [...new Set((input.requirements||[]).map(r=>r.id).filter(Boolean))]}
export function withExperience(worker, store, productStore) {
  return async (input, context) => {
    const ids=requirementIDs(input), prior=store.notes(ids);
    const supplied=trimNotes(input.context?.explorationNotes);
    const product=productStore?.notesFor(input.target)||'';
    const notes=[product&&`[产品级探索经验：先快速验证，失效时局部修复]\n${product}`,supplied,prior].filter((value,index,all)=>value&&all.indexOf(value)===index).join('\n\n');
    const enriched={...input,...(productStore?.replayFor(input.target).length?{productReplay:productStore.replayFor(input.target)}:{}),...(notes?{context:{...input.context,explorationNotes:notes}}:{})};
    const result=await worker(enriched,context);
    if(result.explorationRecords&&typeof result.explorationRecords==='object'){
      for(const [id,notes] of Object.entries(result.explorationRecords))await store.merge([id],notes);
    }else await store.merge(ids,result.explorationNotes);
    await productStore?.mergeFor(input.target,result.explorationNotes);
    return result;
  };
}
