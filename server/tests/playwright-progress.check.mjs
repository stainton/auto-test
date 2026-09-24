import assert from 'node:assert/strict';
import { describePlaywrightAction } from '../shared/playwright-progress.mjs';
assert.equal(describePlaywrightAction('browser_click',{element:'新建素材按钮'}),'定位并点击控件：新建素材按钮');
assert.equal(describePlaywrightAction('browser_fill',{selector:'input[name=password]',text:'secret-value'}),'定位并填写控件：input[name=password]');
assert.equal(describePlaywrightAction('browser_snapshot',{}),'读取当前页面的控件与状态');
assert.equal(describePlaywrightAction('browser_navigate',{url:'https://test.example.com/assets'}),'打开页面：https://test.example.com/assets');
console.log('playwright progress descriptions checks passed');
