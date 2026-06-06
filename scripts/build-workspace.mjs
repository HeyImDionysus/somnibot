#!/usr/bin/env node
/**
 * Build every workspace package without relying on Turbo's package-manager
 * binary lookup. This keeps `corepack pnpm build` working on machines that
 * have Corepack enabled but no global pnpm shim on PATH.
 */

import { runPnpm } from './lib/pnpm.mjs';

const buildTargets = [
  '@somnibot/shared',
  '@somnibot/bot',
  '@somnibot/dashboard',
  '@somnibot/license-sdk',
  '@somnibot/launcher',
];

for (const target of buildTargets) {
  runPnpm(['--filter', target, 'build']);
}
