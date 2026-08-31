import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { readdir, lstat, statfs, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseRecoveryError, type RecoveryCommand } from './database-recovery-contract.js';

export const RECOVERY_MAX_BYTES = 512 * 1024 * 1024;
export const RECOVERY_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 1024 * 1024;

export async function checkRecoveryCapacity(directory: string, additionalBytes = RECOVERY_MAX_BYTES): Promise<void> {
  const fs = await statfs(directory);
  if (fs.bavail * fs.bsize < RECOVERY_RESERVE_BYTES + additionalBytes) throw new DatabaseRecoveryError('insufficient-disk-reserve');
}

async function withinBudget(directory: string): Promise<boolean> {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const entry = await lstat(path.join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    bytes += entry.size;
  }
  const fs = await statfs(directory);
  return bytes <= RECOVERY_MAX_BYTES && fs.bavail * fs.bsize >= RECOVERY_RESERVE_BYTES;
}

function scopedEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, ...extra };
}

export async function runRecoveryCommand(command: RecoveryCommand): Promise<string> {
  const output = command.outputFile ? await openRecoveryOutput(command) : null;
  return new Promise((resolve, reject) => {
    const child = spawn(command.tool, [...command.args], {
      env: scopedEnvironment(command.env), windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: DatabaseRecoveryError | null = null;
    let closed = false;
    let checking = false;
    const stop = (code: string) => {
      if (terminalError) return;
      terminalError = new DatabaseRecoveryError(code);
      output?.destroy(terminalError);
      if (!child.pid || closed) return;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('client-timeout'), PROCESS_TIMEOUT_MS);
    const monitor = setInterval(() => {
      if (!command.directory || checking) return;
      checking = true;
      void withinBudget(command.directory).then((safe) => { if (!safe) stop('artifact-size-or-disk-limit'); })
        .catch((error: unknown) => stop(error instanceof Error ? 'artifact-storage-check-failed' : 'unexpected-storage-failure'))
        .finally(() => { checking = false; });
    }, 100);
    const acceptOutput = (chunk: Buffer, keep: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) stop('client-output-limit');
      else if (keep) chunks.push(chunk);
      else errorChunks.push(chunk);
    };
    let artifactBytes = 0;
    const writing = output ? pipeline(child.stdout, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        artifactBytes += chunk.length;
        if (artifactBytes > Math.min(command.outputLimit ?? RECOVERY_MAX_BYTES, RECOVERY_MAX_BYTES)) {
          stop('artifact-size-limit'); callback(new DatabaseRecoveryError('artifact-size-limit'));
        } else callback(null, chunk);
      },
    }), output).catch(() => { stop('artifact-write-failed'); }) : Promise.resolve();
    if (!output) child.stdout.on('data', (chunk: Buffer) => acceptOutput(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => acceptOutput(chunk, false));
    child.on('error', (error) => {
      clearTimeout(timer); clearInterval(monitor);
      output?.destroy();
      reject(new DatabaseRecoveryError('code' in error && error.code === 'ENOENT' ? 'missing-client-prerequisite' : 'client-start-failed'));
    });
    child.on('close', async (code) => {
      closed = true;
      await writing;
      clearTimeout(timer); clearInterval(monitor);
      if (terminalError) reject(terminalError);
      else if (code !== 0) {
        const errorText = Buffer.concat(errorChunks).toString('utf8');
        const refusal = ['recovery_target_identity_rejected', 'recovery_target_must_be_unused', 'recovery_validation_mismatch']
          .find((known) => errorText.includes(known));
        reject(new DatabaseRecoveryError(refusal ?? 'client-command-failed'));
      }
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

async function openRecoveryOutput(command: RecoveryCommand) {
  if (!command.outputFile || !command.directory || path.dirname(path.resolve(command.outputFile)) !== await realpath(command.directory)) {
    throw new DatabaseRecoveryError('invalid-owned-output');
  }
  const entry = await lstat(command.outputFile);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new DatabaseRecoveryError('invalid-owned-output');
  const file = await open(command.outputFile, constants.O_WRONLY | constants.O_NOFOLLOW);
  const stat = await file.stat();
  if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) {
    await file.close(); throw new DatabaseRecoveryError('invalid-owned-output');
  }
  return file.createWriteStream();
}
