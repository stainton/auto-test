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
tests/**/*.spec.ts              generated tests — screenshot recorded per step
        │
        ▼  playwright-test-healer
passing tests
```

## run review

Execute `npm run review` to open the review site (http://localhost:4400; set `REVIEW_PORT` to override).

- **Requirements** — create / edit requirement docs in `docs/`.
- **Plan drafts** — review and edit the planner's output in `specs/`.
- **Approved** — click *Approve* to move a plan (+ its `.cases.md`) into `specs/approved/`, releasing it to the generator.
