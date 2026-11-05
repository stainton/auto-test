import assert from 'node:assert/strict';
import { describePlaywrightAction, describePlaywrightResult } from '../shared/playwright-progress.mjs';
assert.equal(describePlaywrightAction('browser_click',{element:'新建素材按钮'}),'定位并点击控件：新建素材按钮');
assert.equal(describePlaywrightAction('browser_fill',{selector:'input[name=password]',text:'secret-value'}),'定位并填写控件：input[name=password]');
assert.equal(describePlaywrightAction('browser_snapshot',{}),'读取当前页面的控件与状态');
assert.equal(describePlaywrightAction('browser_navigate',{url:'https://test.example.com/assets'}),'打开页面：https://test.example.com/assets');
assert.equal(describePlaywrightAction('browser_navigate',{url:'https://test.example.com/assets?token=private#item'}),'打开页面：https://test.example.com/assets');
assert.equal(describePlaywrightAction('browser_run_code_unsafe',{code:"await page.getByRole('button', { name: '创建素材' }).click(); await page.getByLabel('版本').textContent();"}),
  '操作并读取控件：创建素材、版本');
assert.equal(describePlaywrightAction('browser_evaluate',{code:"const controls = [{ name: '管线', selector: '#pipeline' }, { name: '版本', selector: '#version' }];"}),
  '检查控件状态：管线、版本');
assert.equal(describePlaywrightAction('browser_run_code_unsafe',{code:"await page.getByLabel('密码').fill('secret-value');"}),
  '操作并读取控件：密码');
assert.ok(!describePlaywrightAction('browser_fill',{selector:'input[value=secret-value]',text:'secret-value'}).includes('secret-value'));
assert.equal(describePlaywrightResult('browser_evaluate',[{type:'text',text:'### Result\n[{"name":"管线","selector":"#pipeline","clippedByAncestor":false},{"name":"版本","selector":"#version","clippedByAncestor":false}]\n### Ran Playwright code\nreturn {name:"secret-value",selector:"x"};'}]),
  '批量检查控件布局：管线、版本');
assert.equal(describePlaywrightResult('browser_snapshot',[{type:'text',text:'Page URL: https://test.example.com/create?token=private\nPage Title: 创建素材'}]),
  '读取页面控件与状态：https://test.example.com/create');
console.log('playwright progress descriptions checks passed');
