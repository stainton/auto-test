// The organizer's job store and HTTP routes (/v1/organizer/*). It is mounted in the planner's process
// (planner/main.mjs, the planner pod) and in the combined automation service, sharing their browser runtime and the
// planner's agent configuration, but it is its own task kind: the planner designs cases, the organizer only
// restructures existing ones. Temporary (功能 AM): remove this directory and its two mount points to drop it.
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpHandler } from '../shared/http.mjs';
import { positive } from '../shared/env.mjs';
import { withExperience } from '../shared/experience.mjs';
import { exportCheckpoint } from '../planner/checkpoint.mjs';
import { validateInput, MAX_TIMEOUT_MS } from './contract.mjs';
import { createOrganizerWorker } from './worker.mjs';

export function createOrganizerService({ command, runtime, applySettings, playwrightPackage, assetCache, workspaceRoot,
  concurrency, authSessions }) {
  // Jobs live in memory, so a workspace left by an earlier process belongs to no job any more.
  rmSync(workspaceRoot, { recursive: true, force: true });
  const worker = withExperience(createOrganizerWorker({ command, runtime, playwrightPackage, assetCache, authSessions, temporaryRoot: workspaceRoot }));
  const jobs = new Jobs({
    kind: 'organizer', label: 'Organizer',
    started: { stage: 'reading_requirements', message: 'Reading the submitted cases and products' },
    completion: result => ({ message: `Classified ${result.assignments.length} cases`,
      casesClassified: result.assignments.length, casesUnassigned: result.unassigned.length }),
    worker, concurrency, timeoutMs: positive('ORGANIZER_TIMEOUT_MS', 3600000),
    timeoutFor: input => input.timeoutMs && Math.min(input.timeoutMs, positive('ORGANIZER_MAX_TIMEOUT_MS', MAX_TIMEOUT_MS)),
    maxJobs: positive('ORGANIZER_MAX_JOBS', 100), retentionMs: positive('ORGANIZER_RETENTION_MS', 86400000),
    maxRetained: positive('ORGANIZER_MAX_RETAINED', 200),
    discard: state => { if (state?.workspace) rmSync(state.workspace, { recursive: true, force: true }); }
  });
  // An interrupted run can be continued exactly like a planner run (see planner/service.mjs).
  const validate = async payload => {
    const input = validateInput(payload);
    if (input.continueFrom === undefined) return input;
    if (typeof input.continueFrom === 'object') {
      const { checkpoint } = input.continueFrom;
      if (!assetCache || !await assetCache.has(checkpoint)) throw new ServiceError(409, 'CHECKPOINT_NOT_CACHED',
        'Push the checkpoint to this node (PUT /v1/organizer/assets/<sha256>) before continuing from it');
      delete input.continueFrom;
      return { ...input, resume: { checkpoint } };
    }
    const resume = jobs.claimContinuation(input.continueFrom);
    if (!existsSync(resume.workspace)) throw new ServiceError(409, 'NOT_CONTINUABLE', 'The interrupted session is no longer on this server; start a new task');
    delete input.continueFrom;
    return { ...input, resume };
  };
  const handler = createHttpHandler({ jobs, applySettings, assetCache, validateInput: validate, exportCheckpoint, basePath: '/v1/organizer',
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  return { jobs, handler, prefix: '/v1/organizer/' };
}
