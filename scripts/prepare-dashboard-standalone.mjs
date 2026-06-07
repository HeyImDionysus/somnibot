#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const dashboardDir = join(root, 'packages', 'dashboard');
const standaloneDir = join(dashboardDir, '.next', 'standalone');
const staticSrc = join(dashboardDir, '.next', 'static');
const publicSrc = join(dashboardDir, 'public');
const runtimeDashboardDir = join(standaloneDir, 'packages', 'dashboard');
const runtimeStaticDir = join(runtimeDashboardDir, '.next', 'static');
const runtimePublicDir = join(runtimeDashboardDir, 'public');

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(
      `Missing ${label}: ${path}\nRun pnpm build before starting the production dashboard.`,
    );
    process.exit(1);
  }
}

requireDirectory(standaloneDir, 'dashboard standalone output');
requireDirectory(runtimeDashboardDir, 'dashboard standalone server directory');
requireDirectory(staticSrc, 'dashboard static assets');

mkdirSync(join(runtimeDashboardDir, '.next'), { recursive: true });
cpSync(staticSrc, runtimeStaticDir, { recursive: true });

if (existsSync(publicSrc)) {
  cpSync(publicSrc, runtimePublicDir, { recursive: true });
}

console.log('Dashboard standalone runtime assets ready.');
