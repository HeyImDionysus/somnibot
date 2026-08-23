#!/usr/bin/env node

import { runPnpm } from './lib/pnpm.mjs';

const TASKS = {
  lint: [
    ['--filter', '@somnibot/shared', 'build'],
    ['--filter', '@somnibot/dashboard', 'lint'],
  ],
  'type-check': [
    ['--filter', '@somnibot/shared', 'build'],
    ['--filter', '@somnibot/e2e', 'build'],
    ['--filter', '@somnibot/testkit', 'type-check'],
    ['--filter', '@somnibot/bot', 'type-check'],
    ['--filter', '@somnibot/dashboard', 'type-check'],
    ['--filter', '@somnibot/launcher', 'exec', 'tsc', '--noEmit'],
    ['--filter', '@somnibot/launcher', 'exec', 'tsc', '-p', 'tsconfig.preload.json', '--noEmit'],
  ],
};

const taskName = process.argv[2];
const task = TASKS[taskName];

if (!task) {
  const names = Object.keys(TASKS).join(', ');
  console.error(`Unknown workspace task "${taskName ?? ''}". Expected one of: ${names}.`);
  process.exit(1);
}

for (const args of task) {
  runPnpm(args);
}
