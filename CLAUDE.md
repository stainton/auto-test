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
tests/**/*.spec.ts                             generated specs — one screenshot per step
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
| `npm test` | `playwright test` — run the generated specs. |
| `./start.sh review [port]` | Same as `npm run review` (default 4400). |
| `./start.sh test-site [port]` | Serve the demo system-under-test at http://localhost:4500. |
| `./start.sh all [rev] [site]` | Both servers together. |

- **System under test:** `test-site/` (static TaskLite todo SPA), served by `node test-site/server.mjs` on port 4500. Port 4400 is the review app, not the SUT.
- **Requirements** the planner reads: `docs/*.md`. Each carries a stable `Requirement id` (e.g. `REQ-TASKLITE-001`).
- `specs/exploration-notes.md` — shared cumulative record of what the app looks like; planner and generator both read it before exploring and merge findings back.
- `test-model.md` — the field model for the `.cases.md` test-case tables.

## Working rules for exploration (planner AND generator)

Both agents drive a live browser via the `playwright-test` MCP. When they do:

1. **Every exploration step is a function that must return a concrete result** — a snapshot, a
   value, an observed state change. "Tried it, no response" is an unfinished step, not a result.
2. **Bound every `browser_*` call with an explicit `timeout`.** Default cap is **30s** — anything
   not finished within 30s must time out. Shorter only with a specific reason; never longer.
   Even async work is bounded this way. Nothing may hang.
3. **On failure, do not use an evasive strategy** — no skipping, no "flaky", no TODO, no
   "couldn't verify". Diagnose the root cause, switch approach, re-run the step, get its real
   result. Only after genuinely exhausting every approach may you record a limitation, stating
   exactly what was tried and why each failed.
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
  a no-op and the case runs directly. Include matching teardown so specs re-run in any order.
  Never assume a human pre-seeded the environment.
- **Ask the user for inputs you cannot synthesize** — real accounts/credentials, API tokens,
  URLs/hosts, fixture files, payment methods, external resources, real test data. Stop, list
  exactly what is needed and why, resume when provided. Do not invent placeholders or
  skip/`fixme` the step to route around a missing input.
- **Incremental & resumable.** Process a plan's scenarios one at a time; the moment a scenario's
  test works, save it with `generator_write_test` — never batch to the end. Skip scenarios whose
  spec already exists and passes. Keep a `<plan-name>.progress.md` (`done` / `pending` /
  `blocked: <need>`) beside the specs and continue from it on later runs. When stopping, report
  what's done, what remains, and what unblocks each remaining scenario.
