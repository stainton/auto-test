import path from 'node:path';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Fail at startup, not on the first job, when the Claude CLI, the Playwright test runner or its
// Chromium build is missing from the image. Returns the @playwright/test package.json the workers use.
export async function checkPlaywrightRuntime(command) {
  execFileSync(command, ['--version'], { timeout: 10000, stdio: 'ignore' });
  const require = createRequire(import.meta.url);
  const playwrightPackage = require.resolve('@playwright/test/package.json');
  await access(path.join(path.dirname(playwrightPackage), 'cli.js'));
  const { chromium } = require('playwright');
  await access(chromium.executablePath());
  return playwrightPackage;
}
