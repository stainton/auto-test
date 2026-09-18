import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpServer } from '../shared/http.mjs';
import { validateInput, MAX_TIMEOUT_MS } from './contract.mjs';
import { resolveClaudeOptions } from '../runtime/settings.mjs';
import { createPlannerWorker } from './worker.mjs';
import { createSimplifier, validateSimplifyInput } from './simplify.mjs';
import { createEstimator, validateEstimateInput } from './estimate.mjs';

function positive(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
export async function main() {
  const host = process.env.PLANNER_HOST ?? '0.0.0.0';
  const claudeOptions = await resolveClaudeOptions({
    defaultSettingsPath: fileURLToPath(new URL('../../build/planner/setting.json', import.meta.url))
  });
  const command = process.env.PLANNER_CLAUDE_COMMAND ?? 'claude';
  execFileSync(command, ['--version'], { timeout: 10000, stdio: 'ignore' });
  const require = createRequire(import.meta.url);
  const playwrightPackage = require.resolve('@playwright/test/package.json');
  await access(path.join(path.dirname(playwrightPackage), 'cli.js'));
  const { chromium } = require('playwright');
  await access(chromium.executablePath());
  const jobs = new Jobs({
    worker: createPlannerWorker({ command, ...claudeOptions, playwrightPackage }),
    dataDir: process.env.PLANNER_DATA_DIR ?? path.join(tmpdir(), 'auto-test-planner-jobs'),
    concurrency: positive('PLANNER_CONCURRENCY', 1), timeoutMs: positive('PLANNER_TIMEOUT_MS', 900000),
    // A request may raise or lower its own limit; the deployment keeps the last word through
    // PLANNER_MAX_TIMEOUT_MS, so one caller cannot occupy the single browser slot indefinitely.
    timeoutFor: input => input.timeoutMs && Math.min(input.timeoutMs, positive('PLANNER_MAX_TIMEOUT_MS', MAX_TIMEOUT_MS)),
    maxJobs: positive('PLANNER_MAX_JOBS', 100), retentionMs: positive('PLANNER_RETENTION_MS', 86400000),
    // Nothing continues a job once it has aged out of the store, so its session goes with it.
    discard: state => { if (state?.workspace) rmSync(state.workspace, { recursive: true, force: true }); }
  });
  // A request may continue an interrupted task instead of re-exploring from scratch: it repeats the whole
  // request and names that task, and the run reopens its session. The claim happens here, not in the
  // contract, because only the job store knows whether that session is still there to continue.
  const validatePlannerInput = payload => {
    const input = validateInput(payload);
    if (input.continueFrom === undefined) return input;
    const resume = jobs.claimContinuation(input.continueFrom);
    if (!existsSync(resume.workspace)) throw new ServiceError(409, 'NOT_CONTINUABLE',
      'The interrupted session is no longer on this server; start a new design task');
    delete input.continueFrom;
    return { ...input, resume };
  };
  const simplify = createSimplifier({ command, ...claudeOptions });
  const estimate = createEstimator({ command, ...claudeOptions });
  const server = createHttpServer({ jobs, validateInput: validatePlannerInput, validateSimplifyInput, simplify,
    simplifyTimeoutMs: positive('PLANNER_SIMPLIFY_TIMEOUT_MS', 60000),
    validateEstimateInput, estimate, estimateTimeoutMs: positive('PLANNER_ESTIMATE_TIMEOUT_MS', 120000),
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  server.listen(positive('PLANNER_PORT', 4501), host, () => console.log(`Planner HTTP service listening on ${host}:${server.address().port}`));
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
  main().catch(error => { console.error(`Planner startup failed: ${error.message}`); process.exitCode = 1; });
}
