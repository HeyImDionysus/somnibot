#!/usr/bin/env node
/**
 * Release-policy regression check.
 *
 * This intentionally checks the repository's release policy without requiring
 * a GitHub Actions runner or signing certificate. Artifact and signature
 * verification remain mandatory workflow jobs.
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
const rootPackage = JSON.parse(read('package.json'));

assert.match(releaseWorkflow, /- 'v1\.0\.0'/, 'release trigger must be limited to v1.0.0');
assert.match(releaseWorkflow, /Only the approved v1\.0\.0 launcher release may be published\./);
assert.match(releaseWorkflow, /fetch-depth: 0/, 'tag validation requires complete repository history');
assert.match(releaseWorkflow, /TAG_SHA.*MAIN_SHA/, 'tag SHA must be compared with main');
assert.match(releaseWorkflow, /actions\/workflows\/ci\.yml\/runs/, 'green main CI must be checked');
assert.match(releaseWorkflow, /WINDOWS_CODESIGN_PFX_BASE64/, 'Windows signing certificate must be required');
assert.match(releaseWorkflow, /signtool sign/, 'Windows installer must be Authenticode signed');
assert.match(releaseWorkflow, /Verify checksum and Authenticode signature after download/);
assert.match(releaseWorkflow, /SHA256SUMS-\$\{\{ matrix\.artifact \}\}/);
assert.match(releaseWorkflow, /provenance-\$\{\{ matrix\.artifact \}\}\.json/);
assert.doesNotMatch(releaseWorkflow, /macos-latest|\.dmg|--mac/, 'release workflow must not publish macOS');
assert.match(builderConfig, /target: nsis/);
assert.match(builderConfig, /target: AppImage/);
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

console.log('Release workflow policy checks passed.');
