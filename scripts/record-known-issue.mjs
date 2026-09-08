// Interactive CLI to append an entry to specs/known-issues.md.
//
// Run: npm run record-issue   (or: node scripts/record-known-issue.mjs)
//
// Walks the user through recording either a business hint or a historical bug,
// confirms, then appends it to the right section of known-issues.md — never
// touching anything else in the file.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'specs', 'known-issues.md');

const HINT_HEADING = '## Business hints';
const BUG_HEADING = '## Historical bugs / regressions';
const HINT_PLACEHOLDER_PREFIX = '- `<example>`';
// Match on the literal "YYYY-MM-DD" date placeholder, not the "BUG-001" id —
// a real first entry legitimately gets assigned id BUG-001 too, so matching
// on the id would mistake a real row for the template placeholder on every
// run after the first.
const BUG_PLACEHOLDER_MARKER = '| YYYY-MM-DD |';

const rl = readline.createInterface({ input, output });
// Pull lines from a single async iterator rather than calling rl.question()
// repeatedly: with piped/redirected (non-TTY) stdin, readline can close the
// interface as soon as the input stream ends, rejecting any question() call
// still pending — the iterator already has the buffered lines queued up.
const lines = rl[Symbol.asyncIterator]();

function today() {
  return new Date().toISOString().slice(0, 10);
}

// One-line-safe: table cells and bullets both break on raw "|" / newlines.
function oneLine(s) {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

class InputClosedError extends Error {}

async function ask(question, { required = false, default: def, choices } = {}) {
  const suffix = def !== undefined ? ` [${def}]` : '';
  while (true) {
    output.write(`${question}${suffix} `);
    const { value, done } = await lines.next();
    if (done) throw new InputClosedError('输入意外结束。');
    const answer = value.trim();
    if (!answer) {
      if (def !== undefined) return def;
      if (!required) return '';
      console.log('这一项是必填的，请重新输入。');
      continue;
    }
    if (choices && !choices.includes(answer)) {
      console.log(`请输入以下选项之一：${choices.join(' / ')}`);
      continue;
    }
    return answer;
  }
}

async function chooseMode() {
  console.log('要记录什么？');
  console.log('  1) 业务提示（business hint）');
  console.log('  2) 历史缺陷（historical bug）');
  const choice = await ask('请输入 1 或 2：', { required: true, choices: ['1', '2'] });
  return choice === '1' ? 'hint' : 'bug';
}

// Return [start, end) line indices of the section body (heading line excluded,
// stops right before the next "## " heading or EOF).
function findSection(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) throw new Error(`未在 ${path.relative(ROOT, FILE)} 中找到章节：${heading}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return [start + 1, end];
}

function nextBugId(lines) {
  let max = 0;
  for (const line of lines) {
    if (line.includes(BUG_PLACEHOLDER_MARKER)) continue; // template example, not a real entry
    const m = line.match(/^\|\s*BUG-(\d+)\s*\|/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `BUG-${String(max + 1).padStart(3, '0')}`;
}

// Appends a line after the last line in `body` matching `isEntry`, or — on the
// first real write — replaces the single-line placeholder in place so the
// template example doesn't linger next to real entries.
function insertLine(body, newLine, { isPlaceholder, isEntry }) {
  const placeholderIdx = body.findIndex(isPlaceholder);
  if (placeholderIdx !== -1) {
    body[placeholderIdx] = newLine;
    return;
  }
  let lastEntry = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (isEntry(body[i])) { lastEntry = i; break; }
  }
  if (lastEntry === -1) throw new Error('未找到可插入的位置，known-issues.md 结构可能被改动过。');
  body.splice(lastEntry + 1, 0, newLine);
}

function insertHint(lines, entry) {
  const [start, end] = findSection(lines, HINT_HEADING);
  const body = lines.slice(start, end);
  insertLine(body, `- ${entry}`, {
    isPlaceholder: (l) => l.startsWith(HINT_PLACEHOLDER_PREFIX),
    isEntry: (l) => l.startsWith('- '),
  });
  lines.splice(start, end - start, ...body);
}

function insertBugRow(lines, row) {
  const [start, end] = findSection(lines, BUG_HEADING);
  const body = lines.slice(start, end);
  insertLine(body, row, {
    isPlaceholder: (l) => l.includes(BUG_PLACEHOLDER_MARKER),
    isEntry: (l) => l.startsWith('|'),
  });
  lines.splice(start, end - start, ...body);
}

function touchLastUpdated(lines, who) {
  const i = lines.findIndex((l) => l.startsWith('_Last updated:'));
  if (i !== -1) lines[i] = `_Last updated: ${today()} by ${who}_`;
}

async function main() {
  let raw;
  try {
    raw = await readFile(FILE, 'utf8');
  } catch {
    console.error(`找不到 ${path.relative(ROOT, FILE)}，请先创建该文件。`);
    process.exitCode = 1;
    return;
  }
  const lines = raw.split('\n');

  const mode = await chooseMode();
  console.log('');

  let summary;
  if (mode === 'hint') {
    const content = await ask('业务提示内容（一句话说明规则/意图）：', { required: true });
    const entry = oneLine(content);
    summary = `- ${entry}`;
    console.log('\n将追加到「Business hints」：');
    console.log(summary);
    const ok = await ask('确认写入？(y/n)', { required: true, choices: ['y', 'n'] });
    if (ok !== 'y') { console.log('已取消。'); return; }
    insertHint(lines, entry);
  } else {
    const id = nextBugId(lines);
    console.log(`分配 id：${id}`);
    const date = await ask('日期：', { default: today() });
    const area = await ask('区域 / 功能：', { required: true });
    const symptom = await ask('现象：', { required: true });
    const rootCause = await ask('根因（不确定可留空 -> "-"）：', { default: '-' });
    const workaround = await ask('正确行为 / 规避方式：', { required: true });
    const status = await ask('状态 (open / fixed / wontfix)：', {
      required: true,
      choices: ['open', 'fixed', 'wontfix'],
    });

    const cells = [id, date, area, symptom, rootCause, workaround, status].map(oneLine);
    const row = `| ${cells.join(' | ')} |`;

    console.log('\n将追加到「Historical bugs / regressions」：');
    console.log(row);
    const ok = await ask('确认写入？(y/n)', { required: true, choices: ['y', 'n'] });
    if (ok !== 'y') { console.log('已取消。'); return; }
    insertBugRow(lines, row);
  }

  const who = await ask('记录人（可留空）：', { default: 'unknown' });
  touchLastUpdated(lines, who);

  await writeFile(FILE, lines.join('\n'));
  console.log(`\n已写入 ${path.relative(ROOT, FILE)}`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
