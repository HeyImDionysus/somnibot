import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('streams protected input over stdin without adding it to command arguments', async () => {
    const runner = createVpsCommandRunner({ timeoutMs: 5_000 });
    const protectedInput = 'PAYPAL_CLIENT_SECRET=stdin-only-secret\n';
    const fixture = command(process.execPath, [
      '-e',
      'process.stdin.setEncoding("utf8"); let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(String(value.length)))',
    ], { sensitiveStdin: protectedInput });

    const result = await runner(fixture, { index: 0, total: 1 });

    expect(result).toMatchObject({ ok: true, output: String(protectedInput.length) });
    expect(fixture.args.join(' ')).not.toContain('stdin-only-secret');
    expect(JSON.stringify(result)).not.toContain('stdin-only-secret');
  });

  it('streams a protected binary snapshot file over stdin without retaining its contents', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'somnibot-vps-input-'));
    const snapshotPath = path.join(tempDir, 'snapshot.rdb');
    const snapshot = Buffer.concat([Buffer.from('REDIS0011'), Buffer.from([0, 1, 2, 255])]);
    try {
      writeFileSync(snapshotPath, snapshot);
      const runner = createVpsCommandRunner({ timeoutMs: 5_000 });
      const fixture = command(process.execPath, [
        '-e',
        'const chunks=[]; process.stdin.on("data", chunk => chunks.push(chunk)); process.stdin.on("end", () => process.stdout.write(String(Buffer.concat(chunks).length)))',
      ], { sensitiveStdinFile: snapshotPath });

      const result = await runner(fixture, { index: 0, total: 1 });

      expect(result).toMatchObject({ ok: true, output: String(snapshot.length) });
      expect(JSON.stringify(result)).not.toContain(snapshot.toString('base64'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('streams protected binary stdout directly to a private file without logging it', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'somnibot-vps-output-'));
    const snapshotPath = path.join(tempDir, 'snapshot.rdb');
    const snapshot = Buffer.concat([Buffer.from('REDIS0011'), Buffer.from([0, 1, 2, 255])]);
    try {
      const runner = createVpsCommandRunner({ timeoutMs: 5_000 });
      const fixture = command(process.execPath, [
        '-e',
        'require("node:fs").writeSync(1, Buffer.from(process.argv[1], "base64")); require("node:fs").writeSync(2, "snapshot-exported")',
        snapshot.toString('base64'),
      ], { sensitiveStdoutFile: snapshotPath });

      const result = await runner(fixture, { index: 0, total: 1 });

      expect(result).toMatchObject({ ok: true, output: 'snapshot-exported' });
      expect(readFileSync(snapshotPath)).toEqual(snapshot);
      expect(JSON.stringify(result)).not.toContain(snapshot.toString('base64'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    // Keep the default short enough to prove command metadata wins, while
    // allowing Windows under a parallel coverage/test load enough time to
    // start a fresh Node child before its 100ms fixture timer runs.
    ], { executionTimeoutMs: 5_000 }), { index: 0, total: 1 });

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
    // The runner only treats exit 255 as retriable when the executable is named
    // `ssh`, and the deployment plan always passes that bare name (never a path)
    // so the OS resolves it from PATH. Mirror that exactly: drop a stand-in
    // binary on PATH and spawn it by name. The previous fixture used a `#!`
    // script, which Windows — the launcher's own platform — cannot execute, so
    // the spawn failed outright and the assertion covered nothing there.
    const sshPath = path.join(tempDir, process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    const originalPath = process.env.PATH;
    try {
      try {
        linkSync(process.execPath, sshPath);
      } catch {
        copyFileSync(process.execPath, sshPath);
      }
      chmodSync(sshPath, 0o700);
      process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;

      const runner = createVpsCommandRunner({ timeoutMs: 5_000 });
      const result = await runner(command('ssh', [
        '-e',
        'require("node:fs").writeSync(2, "ssh transport failed"); process.exit(255)',
      ]), { index: 0, total: 1 });

      expect(result).toMatchObject({
        ok: false,
        exitCode: 255,
        retriable: true,
      });
      expect(result.error).toContain('ssh transport failed');
    } finally {
      process.env.PATH = originalPath;
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
