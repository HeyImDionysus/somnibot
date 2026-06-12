import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVpsCommandRunner } from '../main/vps-command-runner';
import { type VpsDeploymentCommand } from '../main/vps-deployment-plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

function command(executable: string, args: string[]): VpsDeploymentCommand {
  return {
    id: 'fixture',
    label: 'Fixture command',
    executable,
    args,
    redactedArgs: args,
    redactedDisplay: [executable, ...args].join(' '),
    changesRemote: false,
    approvalRequired: false,
    commandCategory: 'probe',
  };
}

describe('VPS command runner', () => {
  it('executes structured command arrays with shell disabled', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 5_000 });

    const result = await runner(command(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      'runner-ok',
    ]), { index: 0, total: 1 });

    expect(result).toMatchObject({
      ok: true,
      output: 'runner-ok',
    });
  });

  it('returns failure output and exit code without throwing', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 5_000 });

    const result = await runner(command(process.execPath, [
      '-e',
      'process.stderr.write("runner-failed"); process.exit(7)',
    ]), { index: 0, total: 1 });

    expect(result).toMatchObject({
      ok: false,
      error: 'runner-failed',
      exitCode: 7,
    });
  });

  it('keeps the IPC live path wired to the structured runner only when dryRun is false', () => {
    const runnerSource = readFileSync(path.join(srcDir, 'main', 'vps-command-runner.ts'), 'utf8');
    const mainSource = readFileSync(path.join(srcDir, 'main', 'index.ts'), 'utf8');

    expect(runnerSource).toContain('execFile');
    expect(runnerSource).toContain('shell: false');
    expect(runnerSource).not.toContain('spawn(');
    expect(runnerSource).not.toContain('exec(');
    expect(mainSource).toContain('request?.dryRun === false ? { commandRunner: createVpsCommandRunner() } : {}');
  });
});
