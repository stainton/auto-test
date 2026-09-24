import assert from 'node:assert/strict';
import { embedArtifacts, fallbackReport } from '../executor/main.mjs';

const png='data:image/png;base64,cG5n';
const jpeg='data:image/jpeg;base64,anBlZw==';
const output=embedArtifacts('## 关键步骤\n\n{{image:login.png}}',[{name:'login.png',data:png},{name:'detail.jpg',data:jpeg}]);
assert.ok(output.includes(`![login.png](${png})`));
assert.ok(output.includes(`![detail.jpg](${jpeg})`));
assert.ok(!output.includes('{{image:login.png}}'));
console.log('executor embedded-artifact checks passed');

const fallback=fallbackReport({title:'登录校验',passed:false,output:'expect banner to be visible',artifacts:[{name:'登录失败提示',data:png},{name:'账号状态',data:jpeg}]});
const embeddedFallback=embedArtifacts(fallback,[{name:'登录失败提示',data:png},{name:'账号状态',data:jpeg}]);
assert.match(embeddedFallback,/AI 整理不可用/);
assert.match(embeddedFallback,/1\. 登录失败提示/);
assert.match(embeddedFallback,/2\. 账号状态/);
assert.match(embeddedFallback,/expect banner to be visible/);
assert.ok(!embeddedFallback.includes('{{image:'));
console.log('executor fallback-report checks passed');
