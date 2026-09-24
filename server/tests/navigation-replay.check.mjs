import assert from 'node:assert/strict';
import { replayFromNotes, replaySeed } from '../shared/navigation-replay.mjs';
const steps=replayFromNotes('入口\nREPLAY: goto /assets\nREPLAY: click button | 上传素材\nREPLAY: click button | 删除');
assert.deepEqual(steps.slice(0,2),[{action:'goto',url:'/assets'},{action:'click',role:'button',name:'上传素材'}]);
const seed=replaySeed(steps);
assert.match(seed,/page\.goto/);assert.match(seed,/getByRole/);assert.match(seed,/waitForLoadState/);assert.doesNotMatch(seed,/删除/);
console.log('navigation replay checks passed');
