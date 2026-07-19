#!/usr/bin/env node
/**
 * Tertiary gate for @somnibot/testkit isolation (see packages/testkit/src/guard.ts).
 *
 * @somnibot/testkit drives the REAL production interaction router and makes
 * REAL Discord + Supabase mutations. It must NEVER be reachable from a
 * production build. This check fails CI if:
 *   1. any production package declares @somnibot/testkit as a (non-dev)
 *      dependency, or
 *   2. any shipped source file (outside test dirs / e2e harness) imports it.
 *
 * The runtime guard is defense-in-depth; this keeps the import edge from ever
 * existing in the first place.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTKIT = '@somnibot/testkit';
const errors = [];

// 1. No production package may declare testkit as a runtime dependency.
const pkgDir = join(repoRoot, 'packages');
for (const pkg of readdirSync(pkgDir)) {
  const manifestPath = join(pkgDir, pkg, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    continue;
  }
  if (manifest.name === TESTKIT) continue;
  const deps = manifest.dependencies ?? {};
  if (TESTKIT in deps) {
    errors.push(`${manifest.name} declares ${TESTKIT} as a runtime dependency (must be devDependency of harness tooling only)`);
  }
}

// 2. No shipped source file may import testkit. Scan non-test source under
//    every package except testkit itself and the e2e harness tooling.
const IMPORT_RE = new RegExp(`from ['"]${TESTKIT.replace('/', '\\/')}(?:/[^'"]*)?['"]|require\\(['"]${TESTKIT.replace('/', '\\/')}`, 'm');
function isTestPath(p) {
  return /(?:^|[\\/])__tests__[\\/]/.test(p) || /\.(?:test|spec|e2e)\.[tj]sx?$/.test(p);
}
function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else if (/\.[tj]sx?$/.test(entry)) onFile(full);
  }
}
for (const pkg of readdirSync(pkgDir)) {
  // testkit itself and the e2e harness package are allowed to reference it.
  if (pkg === 'testkit' || pkg === 'e2e') continue;
  const srcDir = join(pkgDir, pkg, 'src');
  try {
    statSync(srcDir);
  } catch {
    continue;
  }
  walk(srcDir, (file) => {
    if (isTestPath(file)) return; // tests may import the harness
    const text = readFileSync(file, 'utf-8');
    if (IMPORT_RE.test(text)) {
      errors.push(`${relative(repoRoot, file)} imports ${TESTKIT} from shipped source`);
    }
  });
}

if (errors.length > 0) {
  console.error(`❌ testkit isolation violated (${errors.length}):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log(`✅ ${TESTKIT} is isolated: no production dependency or shipped-source import edge.`);
