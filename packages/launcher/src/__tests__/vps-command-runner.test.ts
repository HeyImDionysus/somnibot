import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVpsCommandRunner } from '../main/vps-command-runner';
import { type VpsDeploymentCommand } from '../main/vps-deployment-plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

function command(
  executable: string,
  args: string[],
  overrides: Partial<VpsDeploymentCommand> = {},
): VpsDeploymentCommand {
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
    ...overrides,
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

  it('retains streamed output tails without failing on verbose commands', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 5_000, outputLimitChars: 32 });

    const result = await runner(command(process.execPath, [
      '-e',
      'process.stdout.write("x".repeat(2048) + "tail-marker")',
    ]), { index: 0, total: 1 });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('output truncated to last 32 characters');
    expect(result.output).toContain('tail-marker');
  });

  it('uses per-command timeout metadata for long-running deployment commands', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 10 });

    const result = await runner(command(process.execPath, [
      '-e',
      'setTimeout(() => process.stdout.write("slow-ok"), 100)',
    ], { executionTimeoutMs: 1_000 }), { index: 0, total: 1 });

    expect(result).toMatchObject({
      ok: true,
      output: 'slow-ok',
    });
  });

  it('reports command timeouts as retriable failures', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 50 });

    const result = await runner(command(process.execPath, [
      '-e',
      'setTimeout(() => process.stdout.write("too-late"), 1_000)',
    ]), { index: 0, total: 1 });

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.error).toContain('Command timed out after 50ms.');
  });

  it('keeps the IPC live path wired to the structured runner only when dryRun is false and VPS mode is selected', () => {
    const runnerSource = readFileSync(path.join(srcDir, 'main', 'vps-command-runner.ts'), 'utf8');
    const mainSource = readFileSync(path.join(srcDir, 'main', 'index.ts'), 'utf8');

    expect(runnerSource).toContain('spawn(command.executable, command.args');
    expect(runnerSource).toContain('shell: false');
    expect(runnerSource).not.toContain('exec(');
    expect(runnerSource).not.toContain('execFile');
    expect(mainSource).toContain("request?.dryRun === false && cfg.runtimeMode === 'vps'");
    expect(mainSource).toContain('runtimeMode: cfg.runtimeMode');
    expect(mainSource).not.toContain("runtimeMode: 'vps'");
  });
});
