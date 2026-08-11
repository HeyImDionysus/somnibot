import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32';

function canRun(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    shell,
  });
  return result.status === 0;
}

export function resolvePnpmCommand() {
  if (canRun('corepack', ['pnpm', '--version'])) {
    return { command: 'corepack', prefix: ['pnpm'] };
  }

  if (canRun('pnpm')) {
    return { command: 'pnpm', prefix: [] };
  }

  throw new Error('pnpm is not available. Install Node.js 22+ and run: corepack enable');
}

export function runPnpm(args, options = {}) {
  const { command, prefix } = resolvePnpmCommand();
  const finalArgs = [...prefix, ...args];
  console.log(`\n\x1b[36m> ${[command, ...finalArgs].join(' ')}\x1b[0m\n`);

  const result = spawnSync(command, finalArgs, {
    stdio: 'inherit',
    shell,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
