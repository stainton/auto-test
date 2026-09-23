import assert from 'node:assert/strict';
import { embedArtifacts } from '../executor/main.mjs';

const png='data:image/png;base64,cG5n';
const jpeg='data:image/jpeg;base64,anBlZw==';
const output=embedArtifacts('## 关键步骤\n\n{{image:login.png}}',[{name:'login.png',data:png},{name:'detail.jpg',data:jpeg}]);
assert.ok(output.includes(`![login.png](${png})`));
assert.ok(output.includes(`![detail.jpg](${jpeg})`));
assert.ok(!output.includes('{{image:login.png}}'));
console.log('executor embedded-artifact checks passed');
