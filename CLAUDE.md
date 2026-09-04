# CLAUDE.md

Guidance for Claude Code when working in this repo. Committed so every machine/session
picks up the same conventions — do not rely on local Claude "memory" for anything here.

## What this project is

Requirement-driven Playwright test generation with a human review gate. A person writes a
requirement doc; the **planner** agent explores the app and drafts a test plan; a person
reviews/approves it; the **generator** agent turns the approved plan into Playwright specs;
the **healer** agent fixes failing specs.

```
docs/<requirement>.md                         person writes it (review app: + New requirement)
   │  playwright-test-planner  (explores the live app)
   ▼
specs/<name>.md  +  specs/<name>.cases.md      draft test plan + case table (test-model.md format)
   │  person reviews / edits / approves        review app: npm run review
   ▼
specs/approved/<name>.md                       generator input (generator refuses anything not here)
   │  playwright-test-generator
   ▼
specs/<plan-dir>/*.spec.ts                     generated specs — one file per scenario, one screenshot per step
   │  playwright-test-healer
   ▼
passing tests
```

The agents live in `.claude/agents/` (`playwright-test-planner`, `-generator`, `-healer`)
and are invoked as subagents during a conversation. **Their behavior is defined entirely by
those `.md` files** — they start cold and do not see this file or the main session's memory,
so any rule that must reach them belongs in the agent file, not here.

## Commands

| Command | What |
|---------|------|
| `npm run review` | Review app at http://localhost:4400 (`REVIEW_PORT` to override). Edit requirements, review plan drafts, approve. |
| `npm test` | `playwright test` — run the generated specs (config: `playwright.config.ts`). |
| `./start.sh review [port]` | Same as `npm run review` (default 4400). |
| `./start.sh test-site [port]` | Serve the demo system-under-test at http://localhost:4500. |
| `./start.sh all [rev] [site]` | Both servers together. |

- **System under test:** `test-site/` (static TaskLite todo SPA), served by `node test-site/server.mjs` on port 4500. Port 4400 is the review app, not the SUT.
- **Requirements** the planner reads: `docs/*.md`. Each carries a stable `Requirement id` (e.g. `REQ-TASKLITE-001`).
- `specs/exploration-notes.md` — shared cumulative record of what the app looks like; planner and generator both read it before exploring and merge findings back.
- `test-model.md` — the field model for the `.cases.md` test-case tables.
- `playwright.config.ts` — serial (`workers: 1`, `fullyParallel: false`) because generated
  specs can share server-side state; `retries: 0` locally (a retry re-does login + preconditions
  = wasted time); `list` + non-opening `html` reporter; `baseURL` from `BASE_URL` if set (specs
  targeting a fixed remote host define their own URL constant). `npm ci` installs
  `@playwright/test` (pinned in `package-lock.json`).

## Speed (why runs must stay cheap)

The agents run on a small model with a limited quota. Wall-clock is dominated by retry loops
and repeated setup, not token throughput, so the rules below are load-bearing, not style:
- **Trust `specs/exploration-notes.md`.** If it already gives the locator/behavior/recipe a step
  needs, use it — do not open the browser to re-confirm. Live exploration is only for genuine gaps.
- **Bound every call; nothing may hang.** `browser_run_code_unsafe` must set
  `await page.setDefaultTimeout(<ms>)` on its first line — an un-bounded one (semantic click on
  the antd ColorPicker popover/hue slider, `navigator.clipboard.readText`, a drag) hangs
  forever, it does not fail after 30s.
- **3 attempts per step.** After 3 with no concrete result, record `blocked: <what was tried>`
  and move on — never loop "switching approaches" indefinitely.
- **Do expensive setup once.** Login once → reuse `storageState`; build a shared asset corpus
  once (check-then-reuse into one folder), never per scenario. Bulk upload over a network is
  the slowest thing in a run.
- **Re-run one test (`-g "<title>"`), not the suite,** when checking a freshly generated/fixed spec.
- **One screenshot per step** (attach-only; `fullPage` only when the result is below the fold).

## Working rules for exploration (planner AND generator)

Both agents drive a live browser via the `playwright-test` MCP. When they do:

1. **Every exploration step is a function that must return a concrete result** — a snapshot, a
   value, an observed state change. "Tried it, no response" is an unfinished step, not a result.
2. **Bound every `browser_*` call with an explicit `timeout`** — ~10s for a local SUT, a sane
   ceiling for a remote one. Never rely on the default. `browser_run_code_unsafe` (and anything
   the MCP does not time out itself — drags, `navigator.clipboard.*`) must bound itself:
   `run_code_unsafe`'s first line is `await page.setDefaultTimeout(<ms>)`. An un-bounded one
   hangs forever, it does not fail after 30s.
3. **On failure, do not use an evasive strategy** — no skipping, no "flaky", no TODO, no
   "couldn't verify". Diagnose the root cause, switch approach, re-run the step — **at most 3
   attempts**. After 3 with no concrete result, record a limitation stating exactly what was
   tried and why each failed, then move on. Do not keep inventing approaches past that budget.
4. **Slider / drag interactions** (色相 hue sliders, `<input type="range">`, drag-and-drop,
   canvas draws) are the top hang risk. Drive them via `browser_evaluate` (set the value +
   dispatch `input`/`change`, or replay the pointer path yourself) instead of a raw
   `browser_drag`. In generated specs, use `page.fill` on ranges / a bounded action, never an
   unbounded `dragTo` that can stall the suite.
5. **Record findings into `specs/exploration-notes.md` incrementally**, not just at the end, so
   an interrupted run isn't wasted and the next run resumes instead of re-exploring.

## Working rules for the generator

- **Human-review gate:** only generate from plans under `specs/approved/`. If asked to generate
  from a plan still in `specs/`, stop and tell the user to approve it in the review app. Never
  move/promote a plan into `specs/approved/` yourself.
- **Preconditions are constructed by the test itself.** Generated specs must be self-sufficient
  and idempotent: a setup phase checks whether the precondition holds and, if not, builds it
  (seed `localStorage`/API/UI, create records, log in, navigate); if it already holds, setup is
  a no-op and the case runs directly. Never assume a human pre-seeded the environment.
- **Two teardown modes, chosen from `exploration-notes.md` ⚠️ Hazards:**
  - *Delete what you created* — default, when the SUT has no destructive-action limits.
  - *No-delete / check-then-reuse* — when a **server-side rate limit on deletes** or a
    **shared account / persistent fixture area** is recorded. Build fixtures by check-then-reuse
    into one fixed named location, assert on **baseline + delta** not absolute counts, and
    **don't delete in teardown**. Idempotency comes from the check, not cleanup.
- **Do the expensive setup once.** Login once → `storageState`; shared corpus once (not per
  scenario). Login/nav helpers wait for a real post-redirect marker, never `page.url()` right
  after `goto`. Fixture dirs come from the env var the requirement names (`AVAILABLE_RESOURCES`
  etc.) — never a hardcoded absolute path; prefer in-spec synthesis for simple assets.
- **Ask the user for inputs you cannot synthesize** — real accounts/credentials, API tokens,
  URLs/hosts, fixture files, payment methods, external resources, real test data. Stop, list
  exactly what is needed and why, resume when provided. Do not invent placeholders or
  skip/`fixme` the step to route around a missing input.
- **Incremental & resumable.** One spec file per scenario under `specs/<plan-dir>/` (never one
  growing monolith — `generator_write_test` re-emits the whole file each save); shared helpers
  in a co-located `_helpers.ts`. Save each the moment it works. Skip scenarios whose spec
  exists and passes. Keep `<plan-name>.progress.md` as a `| scenario | status |` table
  (`pending` / `done` / `done (deviation: …)` / `blocked: <need>`) and continue from it.
- **Live behaviour wins over the plan.** When the app disagrees with a plan `expect:`, assert
  what the app does, add a `// deviation:` comment, mark `done (deviation: …)`, and correct
  `exploration-notes.md`. Don't `fixme` over a deviation.
- **Verify one test, not the suite.** Before `done`, run only that test (`-g "<title>"`).
  Give a failing spec at most 3 fix-and-rerun cycles, then mark it `blocked` for the healer.
- **Hashed CSS-module classes** → `[class*="_x_"]`. **Infinite-scroll lists** → scroll to a
  stable count before counting/selecting.
