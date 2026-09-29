// Local browser check; no model call or external application required.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVIDENCE_CAPTURE_HELPER } from '../generator/prompt.mjs';
import { validateStepEvidence } from '../generator/evidence.mjs';
const require = createRequire(import.meta.url);
const pkg = require.resolve('@playwright/test/package.json');
const dir = await mkdtemp(path.join(tmpdir(), 'generator-evidence-smoke-'));
try {
  await mkdir(path.join(dir, 'project'));
  await symlink(path.dirname(path.dirname(path.dirname(pkg))), path.join(dir, 'project', 'node_modules'), 'dir');
  const report = path.join(dir, 'report.json');
  await writeFile(path.join(dir, 'project', 'playwright.config.cjs'), `module.exports = ${JSON.stringify({
    testDir: '.', workers: 1, retries: 0, reporter: [['json', { outputFile: report }]],
    outputDir: path.join(dir, 'results'), use: { headless: true }
  })};`);
  const source = `import { test, expect } from '@playwright/test';
${EVIDENCE_CAPTURE_HELPER}
test('业务取证', async ({ page }, testInfo) => {
  await test.step('[setup] 创建页面', async () => { await page.setContent('<h1>准备完成</h1>'); });
  try {
    await test.step('成功步骤', async () => {
      await expect(page.locator('h1')).toHaveText('准备完成');
      await captureEvidence(page, testInfo, '成功步骤证据');
    });
    await test.step('失败步骤', async () => {
      try {
        await expect(page.locator('h1')).toHaveText('错误预期', { timeout: 100 });
        await captureEvidence(page, testInfo, '失败步骤正常证据');
      } catch (error) {
        await captureEvidence(page, testInfo, '失败现场').catch(e => console.warn(e.message));
        throw error;
      }
    });
  } finally { await page.setContent(''); }
});`;
  validateStepEvidence(source);
  await writeFile(path.join(dir, 'project', 'evidence.spec.ts'), source);
  let exitCode = 0;
  try { await promisify(execFile)(process.execPath, [path.join(path.dirname(pkg), 'cli.js'), 'test'], { cwd: path.join(dir, 'project'), timeout: 30000 }); }
  catch (error) { exitCode = error.code; }
  assert.equal(exitCode, 1); // Preserve the business assertion failure.
  const json = JSON.parse(await readFile(report, 'utf8'));
  const result = json.suites[0].specs[0].tests[0].results[0];
  assert.equal(result.status, 'failed');
  const screenshots = result.attachments.filter(item => item.contentType === 'image/png');
  assert.deepEqual(screenshots.map(item => item.name), ['成功步骤证据', '失败现场']);
  for (const item of screenshots) {
    const bytes = item.path ? await readFile(item.path) : Buffer.from(item.body, 'base64');
    assert.equal(bytes.subarray(1,4).toString(), 'PNG');
  }
  console.log('PASS: real browser success/failure screenshots attached; setup/cleanup have no screenshots; original failure preserved');
} finally { await rm(dir, { recursive: true, force: true }); }
