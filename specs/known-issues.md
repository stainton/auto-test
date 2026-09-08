# Known Issues & Business Notes

_Human-maintained knowledge base of business-specific hints and historically encountered bugs._
_The `playwright-test-planner` and `playwright-test-generator` agents READ this file and must take it into
account, but never write to it — unlike `exploration-notes.md` (agent-written), this file is edited by hand only._

_Last updated: 2026-09-08 by unknown_

## Business hints

Domain rules, non-obvious business logic, or product intent that a tester can't infer purely by clicking
through the UI — the kind of thing that changes whether an observed behavior should be asserted as
"correct" or flagged as a bug. Planner: fold these into scenario design and `expects`. Generator: fold
these into assertions, not just the plan's literal steps.

- 新需求在测试的时候需要同时检查飞书推送
- 每个需求需要有一个用例来覆盖测试一下继承功能(主要是新功能增加后原有的那些按钮什么的是否依然有效)

## Historical bugs / regressions

One row per bug. `status` drives how it should be treated:
- `open` — still broken. Planner should note it as a known limitation in the plan (don't invent a passing
  scenario around it); generator should not "fix" the assertion to make a test pass — assert real behavior
  and mark `// deviation:` per CLAUDE.md, or ask the human if the plan requires the fixed behavior.
- `fixed` — regression risk. Planner should consider a scenario that specifically exercises this area again;
  generator should assert the *correct behavior* column, not just a shallow happy path.
- `wontfix` — known and accepted as final behavior. Tests should assert the *actual* (accepted) behavior,
  not the originally-expected one.

| id | date | area / feature | symptom | root cause (if known) | correct behavior / workaround | status |
|----|------|-----------------|---------|------------------------|-------------------------------|--------|
| BUG-001 | 2026-09-08 | 创作区/资产区 | 从创作区入库到资产区的PSD文件没有预览图 | 创作完成后，在制作PSD的时候没有制作预览图到资产中 | 预期有预览图，暂不可规避，后续需求处理 | fixed |
| BUG-002 | 2026-09-08 | 任务中心 | 任务中心取消进行中的任务后，任务会进入到失败的tab中 | 后端实现问题 | 预期不记录到"已完成"或"失败"中 | fixed |
| BUG-003 | 2026-09-08 | 资产区 | 文件夹下载可以下载没有权限阅读的子文件夹中的内容 | 后端实现问题 | 预期下载不到没有权限阅读的东西，无法规避 | fixed |

## Notes for maintainers

- Prefer recording entries via `npm run record-issue` (`scripts/record-known-issue.mjs`) — it appends
  correctly-formatted rows/bullets and keeps the "Last updated" line current. Editing by hand is fine too,
  but keep each hint/row on a **single physical line** (long lines are fine, just don't hard-wrap them) —
  the script's insertion logic is line-based.
- Append-only: do not delete resolved entries — they're what regression coverage is for.
- Keep symptom/root-cause factual and specific enough that an agent with no other context can act on the row
  (which locator, which input, which observable difference from "expected").
- This file is a *supplement* to `specs/exploration-notes.md`, not a replacement: exploration-notes.md is
  "what the app looks like", this file is "what we know about it from experience that isn't visible by
  just looking."
