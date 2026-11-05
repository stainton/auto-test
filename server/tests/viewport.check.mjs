import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_VIEWPORT, assertFixedViewportTool } from '../shared/viewport.mjs';

test('browser agents use a fixed viewport and reject both resize tool and code paths', () => {
  assert.deepEqual(FIXED_VIEWPORT, { width: 2560, height: 1440 });
  assert.throws(() => assertFixedViewportTool('browser_resize'), /resize 禁止/);
  assert.throws(() => assertFixedViewportTool('browser_run_code_unsafe', { code: 'await page.setViewportSize({ width: 3200, height: 1800 })' }), /resize 禁止/);
  assert.throws(() => assertFixedViewportTool('browser_evaluate', { expression: 'window.resizeTo(3200, 1800)' }), /resize 禁止/);
  assert.doesNotThrow(() => assertFixedViewportTool('browser_run_code_unsafe', { code: 'await page.getByRole("button", { name: "提交" }).scrollIntoViewIfNeeded()' }));
});
