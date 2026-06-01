#!/usr/bin/env node
/**
 * SomniBot Launcher — Build Pipeline
 *
 * Orchestrates the full build: turbo build → stage resources → electron-builder.
 *
 * Usage:
 *   node scripts/build-launcher.mjs              # Build for current platform
 *   node scripts/build-launcher.mjs --win         # Build for Windows
 *   node scripts/build-launcher.mjs --mac         # Build for macOS
 *   node scripts/build-launcher.mjs --linux       # Build for Linux
 *   node scripts/build-launcher.mjs --all         # Build for all platforms
 *   node scripts/build-launcher.mjs --dir         # Pack to directory (no installer, for testing)
 *   node scripts/build-launcher.mjs --skip-build  # Skip turbo build (use existing artifacts)
 */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER_DIR = path.join(ROOT, 'packages', 'launcher');
const STAGING = path.join(LAUNCHER_DIR, '.resources');

/* ── Parse CLI args ────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const platformArg = args.find((a) =>
  ['--win', '--mac', '--linux', '--all', '--dir'].includes(a),
);
const skipBuild = args.includes('--skip-build');

/* ── Helpers ───────────────────────────────────────────────────────── */

function run(cmd, opts = {}) {
  console.log(`\n\x1b[36m> ${cmd}\x1b[0m\n`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function assertExists(p, label) {
  if (!existsSync(p)) {
    console.error(`\n\x1b[31m❌ ${label} not found at:\x1b[0m ${p}`);
    console.error('   Run the build step first or check your monorepo setup.\n');
    process.exit(1);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += statSync(full).size;
  }
  return total;
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ── Dependency fixup helper ───────────────────────────────────────── */

/**
 * Ensures specific packages exist in a staged directory's node_modules.
 * pnpm deploy and Next.js standalone trace can miss transitive or
 * dynamically-loaded deps.  We use npm to install only the missing ones
 * into the flat node_modules so Node's resolver can find them at runtime.
 */
function fixStagedDeps(stagingDir, packages, label) {
  const missing = packages.filter(
    (pkg) => !existsSync(path.join(stagingDir, 'node_modules', ...pkg.split('/'))),
  );
  if (missing.length === 0) {
    console.log(`   ${label}: all transitive deps present ✓`);
    return;
  }
  console.log(`   ${label}: installing missing deps: ${missing.join(', ')}`);
  run(
    `npm install ${missing.join(' ')} --no-save --no-package-lock --ignore-scripts`,
    { cwd: stagingDir },
  );
}

/* ── Step 1: Build all packages via Turbo ──────────────────────────── */

function buildPackages() {
  if (skipBuild) {
    console.log('\n⏭  Skipping turbo build (--skip-build)\n');
    return;
  }
  console.log('\n📦 Building all packages via Turbo...\n');
  // Turbo resolves the dependency graph: shared → bot + dashboard.
  // Launcher is excluded — we build its TypeScript separately before electron-builder.
  run('pnpm turbo build --filter=@somnibot/shared --filter=@somnibot/bot --filter=@somnibot/dashboard');
}

/* ── Step 2: Stage bot ─────────────────────────────────────────────── */

function stageBot() {
  console.log('\n🤖 Staging bot...\n');

  const botDist = path.join(ROOT, 'packages', 'bot', 'dist');
  assertExists(botDist, 'Bot dist (packages/bot/dist)');

  const botStaging = path.join(STAGING, 'bot');
  if (existsSync(botStaging)) rmSync(botStaging, { recursive: true });

  // pnpm deploy creates a self-contained copy of the package with:
  //   - All production dependencies resolved (flat node_modules, no symlinks)
  //   - Workspace deps (@somnibot/shared) bundled as real packages
  //   - Native modules (@napi-rs/canvas) included for the current platform
  //   - devDependencies excluded
  run(`pnpm --filter @somnibot/bot deploy "${botStaging}" --prod`);

  // Verify the deploy produced what we expect
  assertExists(path.join(botStaging, 'dist', 'index.js'), 'Bot entry (dist/index.js)');
  assertExists(path.join(botStaging, 'node_modules'), 'Bot node_modules');

  // ── Fix transitive dependencies ──────────────────────────────────
  // pnpm deploy can miss transitive deps of scoped packages (e.g.
  // @supabase/supabase-js imports @supabase/functions-js at runtime,
  // but pnpm's strict isolation doesn't always hoist them).
  // Use npm to install any missing transitive deps into the flat layout.
  fixStagedDeps(botStaging, [
    '@supabase/auth-js',
    '@supabase/functions-js',
    '@supabase/postgrest-js',
    '@supabase/realtime-js',
    '@supabase/storage-js',
  ], 'bot');

  console.log(`   Bot staged: ${formatMB(dirSize(botStaging))}`);
  console.log('✅ Bot staged successfully');
}

/* ── Step 3: Stage dashboard ───────────────────────────────────────── */

function stageDashboard() {
  console.log('\n🖥  Staging dashboard...\n');

  const standaloneDir = path.join(ROOT, 'packages', 'dashboard', '.next', 'standalone');
  const staticDir = path.join(ROOT, 'packages', 'dashboard', '.next', 'static');
  const publicDir = path.join(ROOT, 'packages', 'dashboard', 'public');

  assertExists(standaloneDir, 'Dashboard standalone (packages/dashboard/.next/standalone)');
  assertExists(staticDir, 'Dashboard static assets (packages/dashboard/.next/static)');

  const dashStaging = path.join(STAGING, 'dashboard');
  if (existsSync(dashStaging)) rmSync(dashStaging, { recursive: true });

  // Copy standalone build.
  // With outputFileTracingRoot pointing to monorepo root, the structure is:
  //   standalone/
  //     node_modules/           ← traced root-level deps
  //     packages/
  //       dashboard/
  //         server.js           ← the entry point
  //         .next/server/       ← server-side chunks
  //       shared/dist/          ← traced workspace dep
  //     package.json
  cpSync(standaloneDir, dashStaging, { recursive: true });

  // Copy static assets — Next.js looks for .next/static/ relative to server.js dir
  const serverStaticDir = path.join(dashStaging, 'packages', 'dashboard', '.next', 'static');
  ensureDir(path.dirname(serverStaticDir));
  cpSync(staticDir, serverStaticDir, { recursive: true });

  // Copy public directory (favicon, images, etc.)
  if (existsSync(publicDir)) {
    const serverPublicDir = path.join(dashStaging, 'packages', 'dashboard', 'public');
    cpSync(publicDir, serverPublicDir, { recursive: true });
  }

  // ── Fix missing traced dependencies ────────────────────────────────
  // Next.js standalone trace misses packages loaded dynamically
  // (e.g. styled-jsx via require-hook.js). Install them into the
  // dashboard's node_modules within the staged standalone output.
  const dashPkgDir = path.join(dashStaging, 'packages', 'dashboard');
  fixStagedDeps(dashPkgDir, ['styled-jsx'], 'dashboard');

  // Verify
  assertExists(
    path.join(dashStaging, 'packages', 'dashboard', 'server.js'),
    'Dashboard server.js',
  );

  console.log(`   Dashboard staged: ${formatMB(dirSize(dashStaging))}`);
  console.log('✅ Dashboard staged successfully');
}

/* ── Step 4: Build Electron app ────────────────────────────────────── */

function buildElectron() {
  console.log('\n⚡ Building Electron app...\n');

  // Build launcher TypeScript (src/main/*.ts → dist/main/*.js)
  run('pnpm --filter @somnibot/launcher run build');

  // Determine platform flags for electron-builder
  const platformFlags =
    {
      '--win': '--win',
      '--mac': '--mac',
      '--linux': '--linux',
      '--all': '-mwl',
      '--dir': '--dir',
    }[platformArg] ?? '';

  // Run electron-builder from the launcher directory.
  // GH_TOKEN env var enables GitHub Releases publishing.
  run(`pnpm exec electron-builder ${platformFlags} --config electron-builder.yml`, {
    cwd: LAUNCHER_DIR,
  });

  console.log('✅ Electron build complete');
}

/* ── Step 5: Summary ───────────────────────────────────────────────── */

function printSummary() {
  const releaseDir = path.join(LAUNCHER_DIR, 'release');
  if (!existsSync(releaseDir)) return;

  console.log('\n📁 Output files:\n');
  const files = readdirSync(releaseDir).filter(
    (f) => !f.startsWith('.') && !f.endsWith('.blockmap'),
  );
  for (const f of files) {
    const size = statSync(path.join(releaseDir, f)).size;
    console.log(`   ${f}  (${formatMB(size)})`);
  }
  console.log(`\n   Location: packages/launcher/release/`);
  console.log('\n🎉 Build pipeline complete!\n');
}

/* ── Main ──────────────────────────────────────────────────────────── */

try {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     SomniBot Launcher — Build Pipeline       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Clean previous staging
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });

  buildPackages();
  stageBot();
  stageDashboard();
  buildElectron();
  printSummary();

  // Clean staging directory (large, not needed after build)
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
} catch (err) {
  console.error(`\n\x1b[31m❌ Build failed:\x1b[0m ${err.message}\n`);
  // Don't clean staging on failure — useful for debugging
  process.exit(1);
}
