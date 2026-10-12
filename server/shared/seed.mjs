import { replaySeed } from './navigation-replay.mjs';

// The seed spec is what generator_setup_page / planner_setup_page run to put a browser on the target page.
// storageStatePath, when given, applies to this seed only (test.use): the exploration browser starts logged
// in, while the project's Playwright config — and so every test_run of a generated spec — stays clean and the
// spec has to log in by itself.
export function seedSpec({ testEntry, name, baseUrl, replay, storageStatePath }) {
  const json = JSON.stringify;
  return `const { test } = require(${json(testEntry)});\n${storageStatePath ? `test.use({ storageState: ${json(storageStatePath)} });\n` : ''}` +
    `test(${json(name)}, async ({ page }) => { await page.goto(${json(baseUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 }); ` +
    `await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{}); ${replaySeed(replay)} });\n`;
}
