import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

/**
 * Assert that the unpacked launcher contains the self-contained bot and
 * dashboard runtimes.  In particular, dashboard dependencies must be real
 * files: Next's standalone output can contain absolute build-machine symlinks
 * which are unusable after packaging.
 */
export function assertPackagedLauncherRuntime(unpackedRoot) {
  const botRoot = path.join(unpackedRoot, 'resources', 'bot');
  const dashboardRoot = path.join(unpackedRoot, 'resources', 'dashboard');
  const requiredFiles = [
    path.join(botRoot, 'dist', 'index.js'),
    path.join(botRoot, 'node_modules', '@somnibot', 'shared', 'package.json'),
    path.join(dashboardRoot, 'packages', 'dashboard', 'server.js'),
    path.join(dashboardRoot, 'packages', 'dashboard', 'node_modules', 'next', 'package.json'),
  ];

  for (const file of requiredFiles) {
    if (!existsSync(file)) {
      throw new Error(`Packaged launcher runtime file is missing: ${file}`);
    }
  }

  const dashboardNext = path.join(
    dashboardRoot,
    'packages',
    'dashboard',
    'node_modules',
    'next',
  );
  if (lstatSync(dashboardNext).isSymbolicLink()) {
    throw new Error(`Packaged dashboard dependency remains a symlink: ${dashboardNext}`);
  }
}
