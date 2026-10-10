// The generator's job store and HTTP routes, built once and mounted either by its own process
// (generator/main.mjs, the generator pod) or alongside the other workflows (automation/main.mjs).
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpHandler } from '../shared/http.mjs';
import { requireCachedAssets } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { withExperience } from '../shared/experience.mjs';
import { validateInput } from './contract.mjs';
import { createGeneratorWorker } from './worker.mjs';

export function createGeneratorService({ command, runtime, applySettings, playwrightPackage, assetCache, jobsDir,
  workspaceRoot, concurrency, experience, productExperience }) {
  let worker = createGeneratorWorker({ command, runtime, playwrightPackage, assetCache, temporaryRoot: workspaceRoot,
    caseTimeoutMs: positive('GENERATOR_CASE_TIMEOUT_MS', 3600000) });
  if (experience) worker = withExperience(worker, experience, productExperience);
  const jobs = new Jobs({
    kind: 'generator', label: 'Generator',
    started: { stage: 'reading_cases', message: 'Reading the submitted test cases and context' },
    completion: result => ({ message: `Generated ${result.generated} of ${result.scripts.length} scripts`,
      scriptsGenerated: result.generated, scriptsBlocked: result.blocked }),
    worker, dataDir: jobsDir,
    discard: state => { if (state?.workspace) rmSync(state.workspace, { recursive: true, force: true }); },
    concurrency, timeoutMs: positive('GENERATOR_TIMEOUT_MS', 3600000),
    maxJobs: positive('GENERATOR_MAX_JOBS', 100), retentionMs: positive('GENERATOR_RETENTION_MS', 86400000)
  });
  const validate = async payload => { const input = validateInput(payload); await requireCachedAssets(assetCache, input); return input; };
  const handler = createHttpHandler({ jobs, validateInput: validate, applySettings, assetCache, basePath: '/v1/generator',
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  return { jobs, handler };
}
