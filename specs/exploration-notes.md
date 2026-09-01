# Exploration Notes

_Shared, cumulative record of what planner runs have discovered about the application under test._
_Each `playwright-test-planner` run reads this before exploring and merges its findings back after._

_Last updated: 2026-08-31 by planner run for "REQ-TASKLITE-001 TaskLite minimal todo SPA — full coverage"_

## Application
- Base URL / entry point: http://localhost:4500 (served by `node test-site/server.mjs`). NOTE: port 4400 is the review app, not the SUT.
- Pages: `/index.html` (list/main page), `/about.html` (about page).
- Auth / seed / preconditions: none. No backend. State persisted in `localStorage` key `tasklite.tasks.v1`
  (JSON array of `{id, title, priority, completed}`). Each scenario must clear localStorage first for a fresh state.
- Filter selection is NOT persisted (in-memory only; resets to "全部" on reload).

## Environment / tooling gotcha (important for setup)
- The repo has NO `node_modules` and `@playwright/test` is not installed, so `planner_setup_page` /
  the generator's seed test fails to resolve imports.
- Fix applied this run: created shim packages under `/workspace/github.com/stainton/auto-test/node_modules/`
  for `playwright`, `playwright-core` (not needed in the end), `@playwright/test`, and `playwright/test`,
  each re-exporting from the npx-cached Playwright at
  `/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright` (v1.62.1).
  `seed.spec.ts` uses `import { test, expect } from '@playwright/test';` and now works.
- If setup fails again with "Cannot find package", recreate those shims.

## Views explored
### List page — http://localhost:4500/index.html
- Purpose: add tasks, list/toggle/edit/delete tasks, filter by status, view stats, bulk clear completed.
- Header: `<h1>TaskLite</h1>` + nav with `nav-home` ("清单") and `nav-about` ("关于"). Active link class `nav-link is-active`.
- Add form:
  - `new-task-input` (textbox, placeholder "今天要做点什么？")
  - `new-task-priority` (select; option values `high`/`medium`/`low`, labels 高/中/低; default `medium`)
  - `add-task-btn` ("添加")
  - `form-error` — hidden unless error. Empty/whitespace -> "任务内容不能为空". >120 chars -> "任务内容不能超过 120 个字符". 120 chars exactly is accepted.
  - On successful add: task appended to bottom of `task-list`, input cleared AND refocused, `form-error` hidden, `remaining-count` updated.
  - Priority select keeps last chosen value after an add within the same page session; returns to `medium` on fresh page load.
- Task list `task-list` (a `<ul>`), each `task-item` (`<li>`, `data-id` attr) contains:
  - `task-toggle` (checkbox, aria-label "标记完成")
  - `task-title` (span, title="双击编辑"). Completed: `<li>` gets class `is-completed` and `task-title` computed `text-decoration: line-through`.
  - `task-priority` (span.badge, shows 高/中/低)
  - `task-delete` (button "×", aria-label "删除任务")
  - Double-click `task-title` -> replaced by `task-title-edit` input (prefilled with current title, auto-focused).
    Save: Enter key OR blur. Cancel: Esc. Empty/whitespace content on save -> discarded, original kept.
- Filters group `过滤任务`: `filter-all` / `filter-active` / `filter-completed` (buttons). Single-select; active one gets class `is-active`. Default `filter-all`.
- Stats/bulk row: `remaining-count` text "N 项未完成" (live). `clear-completed-btn` ("清除已完成") — disabled when 0 completed; removes all completed tasks, keeps active.
- Empty state `empty-state` (`<p>`): text "暂无任务，先添加一条吧。" shown when current filtered view has 0 items (both truly empty and filter-yields-zero).
- Footer: "TaskLite — 用于自动化测试演示的静态站点".
- Navigation in/out: nav links are plain `<a href="./index.html|./about.html">` (full page loads).
- Quirks / flakiness: list re-renders on every mutation, so re-query task elements after toggle/edit/delete (stale refs). Task `id` values are timestamp-based random strings.

### About page — http://localhost:4500/about.html
- Purpose: static description of the app. Title "关于 · TaskLite".
- Content: `<h2>关于 TaskLite</h2>`, `<code>localStorage</code>` mention, `<h3>功能</h3>` + `<ul>` of 7 feature bullets, and a `返回清单` link (`<a href="./index.html">`) in the page body.
- Same header/nav/footer as list page. On this page `nav-about` has class `is-active`.
- No interactive app behavior here.

## Not yet explored (TODO for future runs)
- Responsive / mobile-viewport layout (req 4: 响应式布局) — not verified.
- Keyboard-only add (pressing Enter inside `new-task-input` instead of clicking 添加) — not verified; spec only mentions the button.
- Behavior with a large number of tasks / very long titles rendering.
- Exact toggle behavior of filter buttons re-click (clicking the already-active filter).

## Known issues / gotchas
- No `node_modules` in repo; Playwright shims were added under `node_modules/` (see Environment section).
- `form-error` text differs by cause; assert exact strings above.
- Completed styling is on the `<li>.is-completed` + `line-through` on `task-title` (not an attribute); assert via class or computed style.
- localStorage persists across navigations within a test session — always clear it as a precondition.
