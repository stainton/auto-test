# test-case-design

Requirement-driven Playwright test generation with a human review gate.
Input a requirements document to obtain designed test cases, review them, then generate tests.

## Pipeline

```
docs/<requirement>.md          write requirements        (review app: + New requirement)
        │
        ▼  playwright-test-planner
specs/<name>.md + specs/<name>.cases.md   draft test plan + case table (test-model.md format)
        │
        ▼  human review / edit / approve  (review app)
specs/approved/<name>.md        generator input
        │
        ▼  playwright-test-generator  (refuses anything not under specs/approved/)
specs/<plan-dir>/*.spec.ts      generated tests — one file per scenario, screenshot per step
        │
        ▼  playwright-test-healer
passing tests
```

## run review

Execute `npm run review` to open the review site (http://localhost:4400; set `REVIEW_PORT` to override).

- **Requirements** — create / edit requirement docs in `docs/`.
- **Plan drafts** — review and edit the planner's output in `specs/`.
- **Approved** — click *Approve* to move a plan (+ its `.cases.md`) into `specs/approved/`, releasing it to the generator.

## HTTP services

The same three roles are also available as standalone HTTP services under `server/`, for callers that
drive the workflow from their own UI instead of this repository's files (CaseHub does):

| Service | Port | Purpose |
| --- | --- | --- |
| [planner](server/planner/README.md) | 4501 | requirements in, reviewed-ready test case drafts out |
| [generator](server/generator/README.md) | 4502 | reviewed test cases in, one Playwright spec per case out |
| [general-agent](server/general-agent/README.md) | 4503 | general structured Claude CLI generation, without Playwright or MCP |

They are separate processes with separate configuration, images and manifests, and each can run
alone. They do not touch `docs/`, `specs/`, `.claude/agents/` or the file-based flow above — the human
review gate is `specs/approved/` here, and the calling application there. See [server/README.md](server/README.md).
