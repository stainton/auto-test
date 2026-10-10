// Exploration experience reused across runs of the Playwright workflows. CaseHub owns all of it: the
// per-requirement records (requirements[].explorationNotes / context.explorationNotes, returned as
// explorationNotes / explorationRecords) and the per-product record (context.productExperience, returned as
// productExperience). The services keep no copy, so planner and generator pods see the same experience.
import { replayFromNotes } from './navigation-replay.mjs';

const PRODUCT_TAG = '[产品级探索经验：先快速验证，失效时局部修复]';
const trimNotes=notes=>String(notes||'').trim().slice(0,200000);
const paragraphs=notes=>String(notes||'').split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);

// The agent is dedicated to one front-end product, but deployments often point it at several
// environments. Product experience is keyed by origin so staging facts cannot leak into another
// product or environment; the caller stores it under the origin returned here.
export function productScope(target) { try { return new URL(target?.baseUrl||'').origin; } catch { return ''; } }

// What a run learned beyond the product notes it was given. Planner/generator are asked to merge prior notes
// into their response; that echo is removed so the caller only appends genuinely new paragraphs.
export function productDelta(prior, notes) {
  notes=trimNotes(notes).split(PRODUCT_TAG).join('').trim(); if(!notes)return '';
  prior=trimNotes(prior);
  if(prior&&notes.includes(prior))notes=notes.slice(notes.lastIndexOf(prior)+prior.length).trim();
  const known=new Set(paragraphs(prior));
  return paragraphs(notes).filter(x=>!known.has(x)).join('\n\n');
}

export function withExperience(worker) {
  return async (input, context) => {
    const { productExperience: supplied, ...rest } = input.context ?? {};
    const product=trimNotes(supplied);
    const notes=[product&&`${PRODUCT_TAG}\n${product}`,trimNotes(rest.explorationNotes)].filter(Boolean).join('\n\n');
    const replay=replayFromNotes(product);
    const enriched={...input,...(replay.length?{productReplay:replay}:{}),...(input.context?{context:{...rest,...(notes?{explorationNotes:notes}:{})}}:{})};
    const result=await worker(enriched,context);
    const origin=productScope(input.target), delta=origin?productDelta(product,result.explorationNotes):'';
    return delta?{...result,productExperience:{origin,notes:delta}}:result;
  };
}
