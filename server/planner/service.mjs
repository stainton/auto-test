// The planner's job store and HTTP routes, built once and mounted either by its own process
// (planner/main.mjs, the planner pod) or alongside the other workflows (automation/main.mjs).
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Jobs, ServiceError } from '../shared/jobs.mjs';
import { createHttpHandler } from '../shared/http.mjs';
import { requireCachedAssets } from '../shared/assets.mjs';
import { positive } from '../shared/env.mjs';
import { withExperience } from '../shared/experience.mjs';
import { validateInput, MAX_TIMEOUT_MS } from './contract.mjs';
import { createPlannerWorker } from './worker.mjs';
import { exportCheckpoint } from './checkpoint.mjs';
import { createSimplifier, validateSimplifyInput } from './simplify.mjs';
import { createEstimator, validateEstimateInput } from './estimate.mjs';

export function createPlannerService({ command, runtime, applySettings, playwrightPackage, assetCache, workspaceRoot,
  concurrency, authSessions }) {
  // Jobs live in memory, so a workspace left by an earlier process belongs to no job any more.
  rmSync(workspaceRoot, { recursive: true, force: true });
  const worker = withExperience(createPlannerWorker({ command, runtime, playwrightPackage, assetCache, authSessions, temporaryRoot: workspaceRoot }));
  const jobs = new Jobs({
    worker, concurrency, timeoutMs: positive('PLANNER_TIMEOUT_MS', 900000),
    // An organize run (organize.mjs, temporary) classifies cases instead of designing them, so its result has no cases.
    completion: result => result.mode === 'organize'
      ? { message: `Classified ${result.assignments.length} cases`, casesClassified: result.assignments.length, casesUnassigned: result.unassigned.length }
      : { message: 'Draft test cases ready for review', casesGenerated: result.cases.length },
    // A request may raise or lower its own limit; the deployment keeps the last word through
    // PLANNER_MAX_TIMEOUT_MS, so one caller cannot occupy the single browser slot indefinitely.
    timeoutFor: input => input.timeoutMs && Math.min(input.timeoutMs, positive('PLANNER_MAX_TIMEOUT_MS', MAX_TIMEOUT_MS)),
    maxJobs: positive('PLANNER_MAX_JOBS', 100), retentionMs: positive('PLANNER_RETENTION_MS', 86400000),
    maxRetained: positive('PLANNER_MAX_RETAINED', 200),
    // Nothing continues a job once it is released or aged out of the store, so its session goes with it.
    discard: state => { if (state?.workspace) rmSync(state.workspace, { recursive: true, force: true }); }
  });
  // A request may continue an interrupted task instead of re-exploring from scratch: it repeats the whole
  // request and names that task, and the run reopens its session. The claim happens here, not in the
  // contract, because only this node knows whether that session (or the pushed checkpoint) is here.
  const validatePlannerInput = async payload => {
    const input = validateInput(payload);
    await requireCachedAssets(assetCache, input);
    if (input.continueFrom === undefined) return input;
    if (typeof input.continueFrom === 'object') {
      const { checkpoint } = input.continueFrom;
      if (!assetCache || !await assetCache.has(checkpoint)) throw new ServiceError(409, 'CHECKPOINT_NOT_CACHED',
        'Push the checkpoint to this node (PUT /v1/planner/assets/<sha256>) before continuing from it');
      delete input.continueFrom;
      return { ...input, resume: { checkpoint } };
    }
    const resume = jobs.claimContinuation(input.continueFrom);
    if (!existsSync(resume.workspace)) throw new ServiceError(409, 'NOT_CONTINUABLE',
      'The interrupted session is no longer on this server; start a new design task');
    delete input.continueFrom;
    return { ...input, resume };
  };
  const handler = createHttpHandler({ jobs, applySettings, assetCache, validateInput: validatePlannerInput, exportCheckpoint,
    validateSimplifyInput, simplify: createSimplifier({ command, runtime }), simplifyTimeoutMs: positive('PLANNER_SIMPLIFY_TIMEOUT_MS', 60000),
    validateEstimateInput, estimate: createEstimator({ command, runtime }), estimateTimeoutMs: positive('PLANNER_ESTIMATE_TIMEOUT_MS', 120000),
    openapiPath: fileURLToPath(new URL('./openapi.json', import.meta.url)) });
  return { jobs, handler };
}
