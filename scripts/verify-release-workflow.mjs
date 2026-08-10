#!/usr/bin/env node
/**
 * Release-policy regression check.
 *
 * This intentionally checks the repository's release policy without requiring
 * a GitHub Actions runner or signing certificate. Artifact checksums remain
 * mandatory; Authenticode is recorded when present and unsigned artifacts are
 * an explicit supported release state.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

const releaseWorkflow = read('.github/workflows/release.yml');
const builderConfig = read('packages/launcher/electron-builder.yml');
const buildScript = read('scripts/build-launcher.mjs');
const fleetChild = read('packages/testkit/run-one-domain.mjs');
const rootPackage = JSON.parse(read('package.json'));
const npmrc = read('.npmrc');

assert.match(releaseWorkflow, /- 'v1\.0\.0'/, 'release trigger must be limited to v1.0.0');
assert.match(releaseWorkflow, /Only the approved v1\.0\.0 launcher release may be published\./);
assert.match(releaseWorkflow, /fetch-depth: 0/, 'tag validation requires complete repository history');
assert.match(releaseWorkflow, /TAG_SHA.*MAIN_SHA/, 'tag SHA must be compared with main');
assert.match(releaseWorkflow, /actions\/workflows\/ci\.yml\/runs/, 'green main CI must be checked');
assert.match(releaseWorkflow, /Record Windows Authenticode status \(optional\)/);
assert.match(releaseWorkflow, /windowsSigningRequired = \$false/);
assert.match(releaseWorkflow, /Verify checksum and optional Authenticode status after download/);
assert.match(releaseWorkflow, /Validate packaged release contract/);
assert.match(releaseWorkflow, /verify-linux-appimage:/);
assert.match(releaseWorkflow, /Verify checksum, version, updater metadata, and provenance after download/);
assert.match(releaseWorkflow, /Downloaded Windows provenance is not bound to the validated release candidate/);
assert.match(releaseWorkflow, /Downloaded Linux provenance is not bound to the validated release candidate/);
assert.match(releaseWorkflow, /Embedded release source SHA does not match the validated main tag/);
assert.match(releaseWorkflow, /Stale launcher 0\.1\.0 output survived into the release directory/);
assert.doesNotMatch(releaseWorkflow, /WINDOWS_CODESIGN_PFX_BASE64|signtool sign/, 'release must not require a signing certificate');
assert.match(releaseWorkflow, /SHA256SUMS-\$\{\{ matrix\.artifact \}\}/);
assert.match(releaseWorkflow, /provenance-\$\{\{ matrix\.artifact \}\}\.json/);
assert.doesNotMatch(releaseWorkflow, /macos-latest|\.dmg|--mac/, 'release workflow must not publish macOS');
assert.match(builderConfig, /target: nsis/);
assert.match(builderConfig, /target: AppImage/);
assert.match(
  builderConfig,
  /^  artifactName: "\$\{productName\}-Setup-\$\{version\}\.\$\{ext\}"$/m,
  'Windows installer and updater metadata must share one filesystem-safe filename',
);
assert.match(
  builderConfig,
  /^  artifactName: "\$\{productName\}-\$\{version\}\.\$\{ext\}"$/m,
  'Linux release metadata must advertise the exact AppImage filename',
);
assert.match(
  buildScript,
  /rmSync\(RELEASE_DIR, \{ recursive: true, force: true \}\)/,
  'launcher packaging must remove stale generated release outputs before building',
);
assert.match(
  builderConfig,
  /from: \.resources\/bot\/runtime_modules[\s\S]*to: bot\/node_modules/,
  'bot runtime dependencies must be mapped explicitly into packaged node_modules',
);
assert.match(
  buildScript,
  /verifyPackagedBotRuntime\(\)/,
  'launcher packaging must smoke-test the final unpacked bot runtime',
);
assert.match(
  buildScript,
  /Packaged @somnibot\/shared runtime dependency/,
  'packaged runtime smoke must require the bot workspace dependency',
);
assert.match(
  buildScript,
  /'SUPABASE_SECRET_KEY',[\s\S]*'SUPABASE_SERVICE_ROLE_KEY'/,
  'packaged runtime smoke must clear canonical and legacy Supabase secret-key names',
);
assert.match(
  fleetChild,
  /SOMNIBOT_E2E_SUPABASE_SERVICE_ROLE_KEY/g,
  'local fleet credentials may only use the explicit loopback-E2E override',
);
assert.doesNotMatch(
  fleetChild,
  /SUPABASE_SECRET_KEY:\s*process\.env\.SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY:\s*process\.env\.SUPABASE_SERVICE_ROLE_KEY/,
  'local fleet must never inherit ambient launcher or customer Supabase credentials',
);
assert.match(
  builderConfig,
  /^executableName: SomniBot$/m,
  'scoped package names must not leak into Windows or Linux executable paths',
);
assert.match(
  builderConfig,
  /^  name: somnibot-launcher$/m,
  'packaged metadata must use a filesystem-safe unscoped name',
);
assert.match(
  builderConfig,
  /^  syncDesktopName: true$/m,
  'Linux window association must use the declared desktop name',
);
assert.doesNotMatch(builderConfig, /^mac:/m, 'electron-builder must not define a macOS target');
assert.doesNotMatch(buildScript, /'--mac': '--mac'/, 'build script must not expose a macOS target');
assert.match(buildScript, /macOS launcher builds are not supported for the v1 release\./);
assert.equal(rootPackage.scripts['launcher:build:mac'], undefined, 'root package scripts must not expose a macOS build');

const virtualStoreLength = npmrc.match(/^\s*virtual-store-dir-max-length\s*=\s*(\d+)\s*$/m);
assert.ok(virtualStoreLength, 'pnpm virtual-store-dir-max-length must be pinned in the repository');
assert.ok(
  Number(virtualStoreLength[1]) <= 60,
  'pnpm virtual-store-dir-max-length must stay at or below 60 for Windows NSIS paths',
);

console.log('Release workflow policy checks passed.');
