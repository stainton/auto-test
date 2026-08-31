# Specs

Test plans and their companion test-case tables.

## Layout

| Path | What | Who writes it |
|------|------|---------------|
| `specs/<name>.md` | Test plan (draft, pending review) | `playwright-test-planner` |
| `specs/<name>.cases.md` | Test-case table in `test-model.md` format | `playwright-test-planner` |
| `specs/approved/<name>.md` | Reviewed & approved plan — **generator input** | moved here by a human via the review app |
| `specs/exploration-notes.md` | Shared, cumulative exploration record | `playwright-test-planner` |

## Workflow

1. `playwright-test-planner` explores the app and saves a **draft** plan + cases table into `specs/`.
2. A human runs the review app and reviews / edits the markdown:
   ```
   npm run review      # opens http://localhost:4400
   ```
3. When satisfied, they click **Approve**, which moves the plan (and its `.cases.md`) into `specs/approved/`.
4. Only then does `playwright-test-generator` run — it refuses any plan not under `specs/approved/`.
