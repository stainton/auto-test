// The healer's job store and HTTP routes. It repairs scripts with the generator's browser runtime, so it is
// mounted in the generator pod (generator/main.mjs) or in the combined automation process.
import path from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Jobs } from '../shared/jobs.mjs';
import { createHttpHandler } from '../shared/http.mjs';
import { requireCachedAssets } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { withExperience } from '../shared/experience.mjs';
import { validateInput } from './contract.mjs';
import { createHealerWorker } from './worker.mjs';

// The healer keeps a settings file of its own (CaseHub configures it separately), seeded on first start from
// the generator's so a fresh deployment works without a second setting.json.
export async function seedHealerSettings(healerFile, generatorFile) {
  if (existsSync(healerFile)) return;
  await mkdir(path.dirname(healerFile), { recursive: true });
  await writeFile(healerFile, generatorFile && existsSync(generatorFile) ? readFileSync(generatorFile) : '{}', { mode: 0o600 });
}

export function createHealerService({ command, runtime, applySettings, playwrightPackage, assetCache, jobsDir,
  workspaceRoot, experience, productExperience }) {
  let worker = createHealerWorker({ command, runtime, playwrightPackage, assetCache, temporaryRoot: workspaceRoot,
    caseTimeoutMs: positive('HEALER_CASE_TIMEOUT_MS', 3600000) });
  if (experience) worker = withExperience(worker, experience, productExperience);
  const jobs = new Jobs({
    kind: 'healer', label: 'Healer',
    started: { stage: 'reading_cases', message: 'Reading the existing script and failure details' },
    completion: result => ({ message: `Repaired ${result.generated} scripts`, scriptsGenerated: result.generated, scriptsBlocked: result.blocked }),
    worker, dataDir: jobsDir,
    discard: state => { if (state?.workspace) rmSync(state.workspace, { recursive: true, force: true }); },
    concurrency: positive('HEALER_CONCURRENCY', 1), timeoutMs: positive('HEALER_TIMEOUT_MS', 3600000),
    maxJobs: positive('HEALER_MAX_JOBS', 100), retentionMs: positive('HEALER_RETENTION_MS', 86400000)
  });
  const validate = async payload => { const input = validateInput(payload); await requireCachedAssets(assetCache, input); return input; };
  const handler = createHttpHandler({ jobs, validateInput: validate, applySettings, assetCache, basePath: '/v1/healer',
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  return { jobs, handler };
}
