import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createGeneratorWorker } from '../generator/worker.mjs';
import { SYSTEM_PROMPT, buildPrompt } from './prompt.mjs';
const require = createRequire(import.meta.url);

// Verify the exact returned source, independently of the model's claim or MCP's text report.
export async function verifyRepair({ output, testCase, workspace, signal, emit }, playwrightPackage) {
  signal.throwIfAborted();
  if (output.deviations?.length) throw new Error('Healer 不得修改业务预期来适应产品缺陷，请报告受阻原因');
  const project = path.join(workspace, 'project'), fileName = `${testCase.id}.spec.ts`;
  await writeFile(path.join(project, fileName), output.code, { mode: 0o600 });
  emit({ stage: 'verifying', caseId: testCase.id, message: '正在独立执行修复后的脚本，确认业务断言通过' });
  const cli = path.join(path.dirname(playwrightPackage || require.resolve('@playwright/test/package.json')), 'cli.js');
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', fileName, '--config', path.join(project, 'playwright.config.cjs')],
      { cwd: project, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', timer;
    const kill = sig => { try { if (child.pid) process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
    const abort = () => { kill('SIGTERM'); timer ??= setTimeout(() => kill('SIGKILL'), 1000); timer.unref(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', value => { log = (log + value).slice(-100000); });
    child.stderr.on('data', value => { log = (log + value).slice(-100000); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); kill('SIGKILL'); resolve({ code, log }); });
  });
  await mkdir(path.join(workspace, 'test-results'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, 'test-results', 'verification.log'), run.log, { mode: 0o600 });
  signal.throwIfAborted();
  if (run.code !== 0) throw new Error(`修复脚本独立验证失败：${run.log.slice(-6000)}`);
  const report = JSON.parse(await readFile(path.join(workspace, 'test-results', 'report.json'), 'utf8'));
  if (!report.stats?.expected || report.stats.unexpected || report.stats.skipped || report.stats.flaky)
    throw new Error('修复脚本必须实际通过全部测试，不能跳过或用重试掩盖失败');
}

export function createHealerWorker(options = {}) {
  return createGeneratorWorker({ ...options, workflow: {
    kind: 'healer', systemPrompt: SYSTEM_PROMPT, buildPrompt,
    prepareCase: ({ project, testCase }) => writeFile(path.join(project, `${testCase.id}.spec.ts`), testCase.script, { mode: 0o600 }),
    verifyOutput: options.verifyOutput || (context => verifyRepair(context, options.playwrightPackage))
  } });
}
