import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { validateInput } from './contract.mjs';
import { runClaude } from '../runtime/claude.mjs';
import { resolveClaudeOptions, createReloadingRuntime, createSettingsApplier, settingsPathFor } from '../runtime/settings.mjs';
import { createGeneratorWorker } from './worker.mjs';

function positive(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
export async function main() {
  const host = process.env.GENERATOR_HOST ?? '0.0.0.0';
  // The runtime reads the same Claude configuration shape as the planner; GENERATOR_* variables
  // select this service's own settings file, model and limits.
  const settingsOptions = { prefix: 'GENERATOR',
    defaultSettingsPath: fileURLToPath(new URL('../../build/generator/setting.json', import.meta.url))
  };
  await resolveClaudeOptions(settingsOptions); // Fail early on an invalid configured file.
  // CaseHub stores this agent's configuration and sends it with every request; the applier rewrites the
  // settings file when the revision changes and the reloading runtime re-reads it per CLI invocation.
  const applySettings = createSettingsApplier(settingsPathFor(settingsOptions));
  const runtime = createReloadingRuntime(runClaude, settingsOptions);
  const command = process.env.GENERATOR_CLAUDE_COMMAND ?? 'claude';
  execFileSync(command, ['--version'], { timeout: 10000, stdio: 'ignore' });
  const require = createRequire(import.meta.url);
  const playwrightPackage = require.resolve('@playwright/test/package.json');
  await access(path.join(path.dirname(playwrightPackage), 'cli.js'));
  const { chromium } = require('playwright');
  await access(chromium.executablePath());
  const jobs = new Jobs({
    kind: 'generator', label: 'Generator',
    started: { stage: 'reading_cases', message: 'Reading the submitted test cases and context' },
    completion: result => ({ message: `Generated ${result.generated} of ${result.scripts.length} scripts`,
      scriptsGenerated: result.generated, scriptsBlocked: result.blocked }),
    worker: createGeneratorWorker({ command, runtime, playwrightPackage,
      caseTimeoutMs: positive('GENERATOR_CASE_TIMEOUT_MS', 3600000) }),
    dataDir: process.env.GENERATOR_DATA_DIR ?? path.join(tmpdir(), 'auto-test-generator-jobs'),
    concurrency: positive('GENERATOR_CONCURRENCY', 1), timeoutMs: positive('GENERATOR_TIMEOUT_MS', 3600000),
    maxJobs: positive('GENERATOR_MAX_JOBS', 100), retentionMs: positive('GENERATOR_RETENTION_MS', 86400000)
  });
  const server = createHttpServer({ jobs, validateInput, applySettings, basePath: '/v1/generator',
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  server.listen(positive('GENERATOR_PORT', 4502), host, () => console.log(`Generator HTTP service listening on ${host}:${server.address().port}`));
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    await jobs.close();
    server.closeStreams();
    server.closeAllConnections();
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { server, jobs };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Generator startup failed: ${error.message}`); process.exitCode = 1; });
}
