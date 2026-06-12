import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type VpsCommandRunResult, type VpsDeploymentCommandRunner } from './vps-deployment-executor.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface VpsCommandRunnerOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorExitCode(error: unknown): number | undefined {
  const maybeError = error as { code?: unknown };
  return typeof maybeError.code === 'number' ? maybeError.code : undefined;
}

function errorOutput(error: unknown): string {
  const maybeError = error as { stdout?: unknown; stderr?: unknown };
  return [maybeError.stdout, maybeError.stderr]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

function isRetriable(error: unknown): boolean {
  const maybeError = error as { code?: unknown; signal?: unknown; killed?: unknown };
  return maybeError.code === 'ETIMEDOUT'
    || maybeError.signal === 'SIGTERM'
    || maybeError.killed === true
    || errorMessage(error).toLowerCase().includes('timeout');
}

export function createVpsCommandRunner(options: VpsCommandRunnerOptions = {}): VpsDeploymentCommandRunner {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return async (command): Promise<VpsCommandRunResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(command.executable, command.args, {
        timeout,
        maxBuffer,
        shell: false,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return {
        ok: true,
        ...(output ? { output } : {}),
      };
    } catch (error) {
      const output = errorOutput(error);
      return {
        ok: false,
        error: output || errorMessage(error),
        exitCode: errorExitCode(error),
        retriable: isRetriable(error),
        ...(output ? { output } : {}),
      };
    }
  };
}
