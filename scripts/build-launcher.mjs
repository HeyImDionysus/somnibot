#!/usr/bin/env node
/**
 * SomniBot Launcher — Build Pipeline
 *
 * Orchestrates the full build: package builds -> stage resources -> electron-builder.
 *
 * Usage:
 *   node scripts/build-launcher.mjs              # Build for current platform
 *   node scripts/build-launcher.mjs --win         # Build for Windows
 *   node scripts/build-launcher.mjs --linux       # Build for Linux
 *   node scripts/build-launcher.mjs --all         # Build for supported Windows and Linux platforms
 *   node scripts/build-launcher.mjs --dir         # Pack to directory (no installer, for testing)
 *   node scripts/build-launcher.mjs --skip-build  # Skip package builds (use existing artifacts)
 */

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync, lstatSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from './lib/pnpm.mjs';
import { assertPackagedLauncherRuntime } from './launcher-runtime-verification.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER_DIR = path.join(ROOT, 'packages', 'launcher');
const STAGING = path.join(LAUNCHER_DIR, '.resources');
const RELEASE_DIR = path.join(LAUNCHER_DIR, 'release');

/* ── Parse CLI args ────────────────────────────────────────────────── */

const args = process.argv.slice(2);
if (args.includes('--mac')) {
  console.error('macOS launcher builds are not supported for the v1 release.');
  process.exit(1);
}
const platformArg = args.find((a) =>
  ['--win', '--linux', '--all', '--dir'].includes(a),
);
const skipBuild = args.includes('--skip-build');

/* ── Helpers ───────────────────────────────────────────────────────── */

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

/* ── Dependency fixup helpers ──────────────────────────────────────── */

/**
 * Walks a node_modules directory and replaces any symlinked packages
 * with a dereferenced (real-file) copy.  This is critical because
 * electron-builder's extraResources copy does NOT follow symlinks.
 */
function dereferenceNodeModules(nmDir) {
  if (!existsSync(nmDir)) return;
  let fixed = 0;

  for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;

    const full = path.join(nmDir, entry.name);

    if (entry.name.startsWith('@') && entry.isDirectory()) {
      // Scoped package — check sub-entries
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        const subFull = path.join(full, sub.name);
        if (sub.isSymbolicLink()) {
          const real = realpathSync(subFull);
          rmSync(subFull, { recursive: true });
          cpSync(real, subFull, { recursive: true, dereference: true });
          fixed++;
        }
      }
    } else if (entry.isSymbolicLink()) {
      const real = realpathSync(full);
      rmSync(full, { recursive: true });
      cpSync(real, full, { recursive: true, dereference: true });
      fixed++;
    }
  }

  if (fixed > 0) {
    console.log(`   Dereferenced ${fixed} symlinked package(s)`);
  }
}

/** Monorepo paths to search for source packages (in priority order). */
const MONO_SEARCH = [
  path.join(ROOT, 'node_modules'),
  path.join(ROOT, 'packages', 'bot', 'node_modules'),
  path.join(ROOT, 'packages', 'dashboard', 'node_modules'),
];

/**
 * Finds a package in the pnpm virtual store (.pnpm/).
 * Searches node_modules/.pnpm/ for directories matching the package name.
 * Returns the real path to the package, or null if not found.
 */
function findInPnpmStore(pkgName) {
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;

  // pnpm store structure: .pnpm/{name}@{version}/node_modules/{name}
  // For scoped packages: .pnpm/@{scope}+{name}@{version}/node_modules/@{scope}/{name}
  try {
    for (const entry of readdirSync(pnpmDir)) {
      // Match the package name in the directory entry.
      // Scoped: @swc+helpers@1.0.0 → @swc/helpers
      // Regular: ws@8.18.0 → ws
      const storeNm = path.join(pnpmDir, entry, 'node_modules', ...pkgName.split('/'));
      if (existsSync(storeNm)) {
        return storeNm;
      }
    }
  } catch {
    // Permission error or similar — skip silently
  }
  return null;
}

/**
 * Copies a single package from the monorepo's node_modules into a target
 * node_modules dir, following pnpm symlinks (dereference: true).
 * Returns true if successfully copied, false if not found in monorepo.
 */
function copyPkgFromMonorepo(pkgName, targetNodeModules) {
  // 1. Search flat node_modules directories first (covers hoisted & workspace deps)
  for (const searchRoot of MONO_SEARCH) {
    const src = path.join(searchRoot, ...pkgName.split('/'));
    if (existsSync(src)) {
      const dest = path.join(targetNodeModules, ...pkgName.split('/'));
      ensureDir(path.dirname(dest));
      cpSync(src, dest, { recursive: true, dereference: true });
      return true;
    }
  }

  // 2. Fallback: search pnpm virtual store (.pnpm/)
  const storeSrc = findInPnpmStore(pkgName);
  if (storeSrc) {
    const dest = path.join(targetNodeModules, ...pkgName.split('/'));
    ensureDir(path.dirname(dest));
    cpSync(storeSrc, dest, { recursive: true, dereference: true });
    return true;
  }

  return false;
}

/**
 * Lists all package names in a node_modules directory (including scoped).
 */
function listInstalledPackages(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) return [];
  const pkgs = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      // Scoped package — read sub-entries
      const scopeDir = path.join(nodeModulesDir, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) pkgs.push(`${entry.name}/${sub.name}`);
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      pkgs.push(entry.name);
    }
  }
  return pkgs;
}

/**
 * Reads a package.json and returns its production dependency names
 * (dependencies + peerDependencies, excluding optional peers).
 */
function getRequiredDeps(pkgJsonPath) {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    const peers = Object.keys(pkg.peerDependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    const optionalPeers = new Set(
      Object.entries(pkg.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional)
        .map(([name]) => name),
    );
    const requiredPeers = peers.filter((p) => !optionalPeers.has(p));
    // Include optionalDependencies so platform-specific native bindings
    // (e.g. @napi-rs/canvas-win32-x64-msvc) are detected and copied.
    // Packages that don't exist in the monorepo for the current platform
    // will be silently skipped by copyPkgFromMonorepo.
    return [...new Set([...deps, ...requiredPeers, ...optional])];
  } catch {
    return [];
  }
}

/**
 * Scans ALL packages in a staged node_modules, collects their declared
 * dependencies + non-optional peerDependencies, and copies any that are
 * missing from the monorepo's node_modules.
 *
 * Also installs any explicitly listed "extras" (for packages that are
 * loaded dynamically and don't appear in any package.json deps list).
 *
 * Repeats until no new packages are added (transitive closure).
 */
function fixAllMissingDeps(stagingDir, extras, label) {
  const nm = path.join(stagingDir, 'node_modules');
  if (!existsSync(nm)) return;

  let totalCopied = 0;
  let pass = 0;

  // First pass: ensure extras are present.
  // ALWAYS overwrite extras — they may have been partially traced by
  // Next.js standalone (directory exists but files are incomplete).
  for (const pkg of extras) {
    const dest = path.join(nm, ...pkg.split('/'));
    if (existsSync(dest)) {
      // Remove partial copy so we get the full package from monorepo
      rmSync(dest, { recursive: true, force: true });
    }
    if (copyPkgFromMonorepo(pkg, nm)) {
      console.log(`     ✓ ${pkg} (extra)`);
      totalCopied++;
    } else {
      console.warn(`     ⚠ ${pkg} not found in monorepo (skipping)`);
    }
  }

  // Iterative scan: resolve transitive closure
  while (true) {
    pass++;
    const installed = listInstalledPackages(nm);
    const needed = new Set();

    for (const pkg of installed) {
      const pkgJson = path.join(nm, ...pkg.split('/'), 'package.json');
      for (const dep of getRequiredDeps(pkgJson)) {
        if (!existsSync(path.join(nm, ...dep.split('/')))) {
          needed.add(dep);
        }
      }
    }

    if (needed.size === 0) break;

    let copiedThisPass = 0;
    for (const dep of needed) {
      if (copyPkgFromMonorepo(dep, nm)) {
        console.log(`     ✓ ${dep}`);
        copiedThisPass++;
        totalCopied++;
      }
      // If not found in monorepo, it may be an optional/platform dep — skip silently
    }

    // Safety: if we couldn't copy anything new, stop to avoid infinite loop
    if (copiedThisPass === 0) break;
  }

  if (totalCopied === 0) {
    console.log(`   ${label}: all dependencies present ✓`);
  } else {
    console.log(`   ${label}: copied ${totalCopied} missing deps (${pass} pass${pass > 1 ? 'es' : ''})`);
  }
}

/* ── Step 1: Build all packages ────────────────────────────────────── */

function buildPackages() {
  if (skipBuild) {
    console.log('\n⏭  Skipping package builds (--skip-build)\n');
    return;
  }
  console.log('\n📦 Building launcher runtime packages...\n');
  // Keep this path compatible with machines that use Corepack without a
  // global pnpm shim. Turbo requires a discoverable pnpm binary, so the
  // launcher build invokes package builds directly.
  runPnpm(['--filter', '@somnibot/shared', 'build']);
  runPnpm(['--filter', '@somnibot/bot', 'build']);
  runPnpm(['--filter', '@somnibot/dashboard', 'build']);
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
  runPnpm(['--filter', '@somnibot/bot', 'deploy', botStaging, '--prod']);

  // Verify the deploy produced what we expect
  assertExists(path.join(botStaging, 'dist', 'index.js'), 'Bot entry (dist/index.js)');
  assertExists(path.join(botStaging, 'node_modules'), 'Bot node_modules');

  // ── Dereference any remaining symlinks ─────────────────────────
  // pnpm deploy --prod is *supposed* to produce a flat layout without
  // symlinks, but some versions still leave symlinks pointing into the
  // pnpm store.  electron-builder's extraResources copy does NOT follow
  // symlinks by default, so we re-copy the entire node_modules with
  // dereference:true to ensure everything is a real file.
  dereferenceNodeModules(path.join(botStaging, 'node_modules'));

  // ── Materialize direct, transitive, and peer dependencies ────────
  // On Windows, pnpm deploy can leave only its hidden .pnpm virtual store
  // in the deployment root. electron-builder does not copy that hidden
  // store through extraResources, so an apparently successful installer
  // can contain no usable bot node_modules at all. Seed every direct
  // production dependency as a real top-level directory, then walk the
  // resulting packages to materialize the transitive closure.
  const botPackageJson = path.join(botStaging, 'package.json');
  const botDirectDependencies = getRequiredDeps(botPackageJson);
  fixAllMissingDeps(botStaging, botDirectDependencies, 'bot');

  for (const dependency of botDirectDependencies) {
    assertExists(
      path.join(botStaging, 'node_modules', ...dependency.split('/'), 'package.json'),
      `Bot runtime dependency (${dependency})`,
    );
  }

  // electron-builder applies its node_modules exclusions even inside a
  // generic extraResources tree. Keep the materialized packages under a
  // neutral staging name and map that directory explicitly back to the
  // runtime's required bot/node_modules destination in electron-builder.yml.
  const stagedNodeModules = path.join(botStaging, 'node_modules');
  const stagedRuntimeModules = path.join(botStaging, 'runtime_modules');
  // The flat real-package copies above are authoritative. pnpm's virtual
  // store and command shims are build-time implementation details; their
  // internal links become invalid after the neutral-directory rename.
  rmSync(path.join(stagedNodeModules, '.pnpm'), { recursive: true, force: true });
  rmSync(path.join(stagedNodeModules, '.bin'), { recursive: true, force: true });
  if (existsSync(stagedRuntimeModules)) {
    rmSync(stagedRuntimeModules, { recursive: true, force: true });
  }
  renameSync(stagedNodeModules, stagedRuntimeModules);

  // ── Copy Supabase migrations alongside bot ─────────────────────
  // The migration-runner looks for migrations via process.resourcesPath.
  // Stage them at .resources/supabase/migrations/ so electron-builder
  // picks them up as extraResources.
  const migrationsSource = path.join(ROOT, 'packages', 'supabase', 'migrations');
  const migrationsStaging = path.join(STAGING, 'supabase', 'migrations');
  if (existsSync(migrationsSource)) {
    mkdirSync(migrationsStaging, { recursive: true });
    cpSync(migrationsSource, migrationsStaging, { recursive: true });
    console.log(`   Migrations staged: ${readdirSync(migrationsStaging).length} files`);
  } else {
    console.warn('⚠ packages/supabase/migrations not found — skipping migration staging');
  }

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
  cpSync(standaloneDir, dashStaging, { recursive: true, dereference: true });

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
  // (e.g. styled-jsx via require-hook.js, @swc/helpers via SWC runtime).
  // Scan all installed packages and copy any missing deps from the monorepo.
  // "extras" are packages that aren't declared in any dep list but are
  // loaded dynamically at runtime.
  const dashPkgDir = path.join(dashStaging, 'packages', 'dashboard');
  // Next standalone emits absolute symlinks into the build workspace. They
  // resolve during staging but break once the runtime is moved into an
  // AppImage, so materialize every dashboard dependency before packaging.
  dereferenceNodeModules(path.join(dashPkgDir, 'node_modules'));
  fixAllMissingDeps(dashPkgDir, ['styled-jsx', '@swc/helpers'], 'dashboard');

  // Also fix root-level node_modules (standalone has two: root + per-package)
  fixAllMissingDeps(dashStaging, [], 'dashboard-root');

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

  // Release metadata must describe only artifacts produced by this invocation.
  // In particular, never let an older launcher version survive into checksum,
  // updater-manifest, or upload discovery.
  rmSync(RELEASE_DIR, { recursive: true, force: true });

  // Build launcher TypeScript (src/main/*.ts → dist/main/*.js)
  runPnpm(['--filter', '@somnibot/launcher', 'run', 'build']);

  const configuredReleaseSha = process.env.RELEASE_SHA?.trim()
    || process.env.SOMNIBOT_RELEASE_SHA?.trim()
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/i.test(configuredReleaseSha)) {
    throw new Error('Launcher packaging requires an exact 40-character release commit SHA.');
  }
  writeFileSync(
    path.join(LAUNCHER_DIR, 'dist', 'main', 'release-source.json'),
    `${JSON.stringify({ repositoryRef: configuredReleaseSha.toLowerCase() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`   Embedded immutable VPS source SHA: ${configuredReleaseSha.toLowerCase()}`);

  // Determine platform flags for electron-builder
  const platformFlags =
    {
      '--win': '--win',
      '--linux': '--linux',
      '--all': '--win --linux',
      '--dir': '--dir',
    }[platformArg] ?? '';

  // Run electron-builder from the launcher directory.
  // GH_TOKEN env var enables GitHub Releases publishing.
  runPnpm(['exec', 'electron-builder', ...platformFlags.split(' ').filter(Boolean), '--config', 'electron-builder.yml'], {
    cwd: LAUNCHER_DIR,
  });

  console.log('✅ Electron build complete');
}

function verifyPackagedBotRuntime() {
  const unpackedRoots = ['win-unpacked', 'linux-unpacked']
    .map((name) => path.join(RELEASE_DIR, name))
    .filter((candidate) => existsSync(candidate));

  if (unpackedRoots.length === 0) {
    throw new Error('Launcher packaging did not leave an unpacked runtime for smoke verification.');
  }

  for (const unpackedRoot of unpackedRoots) {
    const botRoot = path.join(unpackedRoot, 'resources', 'bot');
    const botEntry = path.join(botRoot, 'dist', 'index.js');
    assertPackagedLauncherRuntime(unpackedRoot);
    assertExists(botEntry, 'Packaged bot entry');
    assertExists(
      path.join(botRoot, 'node_modules', '@somnibot', 'shared', 'package.json'),
      'Packaged @somnibot/shared runtime dependency',
    );

    const smokeEnv = { ...process.env };
    for (const key of [
      'DISCORD_TOKEN',
      'DISCORD_APPLICATION_ID',
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
    ]) {
      delete smokeEnv[key];
    }

    const smoke = spawnSync(process.execPath, [botEntry], {
      cwd: botRoot,
      env: smokeEnv,
      encoding: 'utf8',
      timeout: 15_000,
    });
    const output = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`;
    if (smoke.error || /ERR_MODULE_NOT_FOUND|Cannot find package/.test(output)) {
      throw new Error(`Packaged bot module-resolution smoke failed: ${smoke.error?.message ?? output.trim()}`);
    }
    if (!output.includes('[Boot]') || !output.includes('Invalid environment configuration')) {
      throw new Error('Packaged bot did not reach its expected isolated configuration gate.');
    }
  }

  console.log('✅ Packaged bot runtime dependencies verified');
}

/* ── Step 5: Summary ───────────────────────────────────────────────── */

function printSummary() {
  if (!existsSync(RELEASE_DIR)) return;

  console.log('\n📁 Output files:\n');
  const files = readdirSync(RELEASE_DIR).filter(
    (f) => !f.startsWith('.') && !f.endsWith('.blockmap'),
  );
  for (const f of files) {
    const size = statSync(path.join(RELEASE_DIR, f)).size;
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
  verifyPackagedBotRuntime();
  printSummary();

  // Clean staging directory (large, not needed after build)
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
} catch (err) {
  console.error(`\n\x1b[31m❌ Build failed:\x1b[0m ${err.message}\n`);
  // Don't clean staging on failure — useful for debugging
  process.exit(1);
}
