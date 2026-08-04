import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPackagedLauncherRuntime } from './launcher-runtime-verification.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'somnibot-runtime-'));
  const bot = path.join(root, 'resources', 'bot');
  const dashboard = path.join(root, 'resources', 'dashboard', 'packages', 'dashboard');
  mkdirSync(path.join(bot, 'dist'), { recursive: true });
  mkdirSync(path.join(bot, 'node_modules', '@somnibot', 'shared'), { recursive: true });
  mkdirSync(path.join(dashboard, 'node_modules', 'next'), { recursive: true });
  writeFileSync(path.join(bot, 'dist', 'index.js'), '');
  writeFileSync(path.join(bot, 'node_modules', '@somnibot', 'shared', 'package.json'), '{}');
  writeFileSync(path.join(dashboard, 'server.js'), '');
  writeFileSync(path.join(dashboard, 'node_modules', 'next', 'package.json'), '{}');
  return root;
}

test('accepts a self-contained bot and dashboard runtime', () => {
  assert.doesNotThrow(() => assertPackagedLauncherRuntime(fixture()));
});

test('rejects dashboard dependencies that remain build-machine symlinks', () => {
  const root = fixture();
  const next = path.join(root, 'resources', 'dashboard', 'packages', 'dashboard', 'node_modules', 'next');
  const target = path.join(root, 'target-next');
  mkdirSync(target);
  writeFileSync(path.join(target, 'package.json'), '{}');
  // Replace the fixture directory with a symlink to model Next standalone's
  // absolute workspace links after electron-builder copies resources.
  rmSync(next, { recursive: true });
  symlinkSync(target, next, 'junction');
  assert.throws(() => assertPackagedLauncherRuntime(root), /remains a symlink/);
});
