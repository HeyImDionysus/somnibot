/**
 * Gate audit — extract every ctx.gate() reason from the scenario scripts.
 *
 * A gate is only acceptable when the step genuinely cannot be driven without a
 * human (clicking a real Discord modal, paying with a real card). Everything
 * else is a assertion waiting to be written, so this groups the reasons to make
 * the difference visible instead of leaving 1300+ calls indistinguishable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'packages/testkit/src/scenario-runner/scripts';
const BACKSLASH = String.fromCharCode(92);

/** Split an argument list on top-level commas, respecting quotes and nesting. */
function splitArgs(args) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  let prev = '';
  for (const c of args) {
    if (quote) {
      cur += c;
      if (c === quote && prev !== BACKSLASH) quote = null;
      prev = prev === BACKSLASH ? '' : c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; prev = c; continue; }
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; prev = c; continue; }
    cur += c;
    prev = c;
  }
  parts.push(cur.trim());
  return parts;
}

const byReason = new Map();
const byFile = new Map();
let total = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(path.join(DIR, file), 'utf8');
  let i = 0;
  let fileCount = 0;
  while ((i = src.indexOf('ctx.gate(', i)) !== -1) {
    let depth = 0;
    let j = i + 'ctx.gate'.length;
    let raw = '';
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) break; }
      raw += c;
    }
    const parts = splitArgs(raw.slice(1));
    const reason = (parts[3] ?? '(no reason given)').replace(/\s+/g, ' ');
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    total += 1;
    fileCount += 1;
    i = j;
  }
  if (fileCount) byFile.set(file, fileCount);
}

console.log(`TOTAL ${total} gates, ${byReason.size} distinct reasons, ${byFile.size} files\n`);
console.log('=== TOP REASONS ===');
[...byReason.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 45)
  .forEach(([r, c]) => console.log(String(c).padStart(5), r.slice(0, 110)));

console.log('\n=== TOP FILES ===');
[...byFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([f, c]) => console.log(String(c).padStart(5), f));
