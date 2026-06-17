import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      'require("node:fs").writeSync(1, process.argv[1])',
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
      'require("node:fs").writeSync(2, "runner-failed"); process.exit(7)',
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
      'require("node:fs").writeSync(1, "x".repeat(2048) + "tail-marker")',
    ]), { index: 0, total: 1 });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('output truncated to last 32 characters');
    expect(result.output).toContain('tail-marker');
  });

  it('uses per-command timeout metadata for long-running deployment commands', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 10 });

    const result = await runner(command(process.execPath, [
      '-e',
      'setTimeout(() => require("node:fs").writeSync(1, "slow-ok"), 100)',
    ], { executionTimeoutMs: 1_000 }), { index: 0, total: 1 });

    expect(result).toMatchObject({
      ok: true,
      output: 'slow-ok',
    });
  });

  it('reports command timeouts as retriable failures even when SIGTERM is ignored', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 50, timeoutKillGraceMs: 50 });

    const result = await runner(command(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)',
    ]), { index: 0, total: 1 });

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.error).toContain('Command timed out after 50ms.');
  });

  it('marks SSH transport exit code 255 as retriable', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'somnibot-vps-runner-'));
    const sshPath = path.join(tempDir, 'ssh');
    try {
      writeFileSync(sshPath, `#!${process.execPath}\nrequire("node:fs").writeSync(2, "ssh transport failed"); process.exit(255);\n`);
      chmodSync(sshPath, 0o700);

      const runner = createVpsCommandRunner({ timeoutMs: 5_000 });
      const result = await runner(command(sshPath, ['example.com', 'true']), { index: 0, total: 1 });

      expect(result).toMatchObject({
        ok: false,
        exitCode: 255,
        retriable: true,
      });
      expect(result.error).toContain('ssh transport failed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the IPC live path wired to the structured runner only when dryRun is false and VPS mode is selected', () => {
    const runnerSource = readFileSync(path.join(srcDir, 'main', 'vps-command-runner.ts'), 'utf8');
    const mainSource = readFileSync(path.join(srcDir, 'main', 'index.ts'), 'utf8');
    const requestSource = readFileSync(path.join(srcDir, 'main', 'vps-deployment-request.ts'), 'utf8');

    expect(runnerSource).toContain('spawn(command.executable, command.args');
    expect(runnerSource).toContain('shell: false');
    expect(runnerSource).not.toContain('exec(');
    expect(runnerSource).not.toContain('execFile');
    expect(mainSource).toContain('handleVpsDeploymentRunRequest');
    expect(mainSource).toContain('dialog.showMessageBox');
    expect(mainSource).toContain('activeVpsDeployment');
    expect(requestSource).toContain("request?.dryRun === false && config.runtimeMode === 'vps'");
    expect(requestSource).toContain('runtimeMode: config.runtimeMode');
    expect(requestSource).toContain('runtime.confirmApproval(plan)');
    expect(requestSource).toContain('runtime.runGate.run(execute)');
    expect(requestSource).not.toContain("runtimeMode: 'vps'");
  });
});
