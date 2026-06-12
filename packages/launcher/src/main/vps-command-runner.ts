import { spawn } from 'node:child_process';
import path from 'node:path';
import { type VpsCommandRunResult, type VpsDeploymentCommandRunner } from './vps-deployment-executor.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_CHARS = 1024 * 1024;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 5_000;

export interface VpsCommandRunnerOptions {
  timeoutMs?: number;
  outputLimitChars?: number;
  timeoutKillGraceMs?: number;
}

function appendOutput(current: string, chunk: Buffer | string, limitChars: number): {
  output: string;
  truncated: boolean;
} {
  const next = current + chunk.toString();
  if (next.length <= limitChars) {
    return { output: next, truncated: false };
  }

  return {
    output: next.slice(next.length - limitChars),
    truncated: true,
  };
}

function formatOutput(output: string, truncated: boolean, limitChars: number): string {
  if (!output) return '';
  if (!truncated) return output;
  return `[output truncated to last ${limitChars} characters]\n${output}`;
}

function isSshExecutable(executable: string): boolean {
  return path.basename(executable).toLowerCase() === 'ssh';
}

export function createVpsCommandRunner(options: VpsCommandRunnerOptions = {}): VpsDeploymentCommandRunner {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitChars = Math.max(1, options.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS);
  const timeoutKillGraceMs = Math.max(1, options.timeoutKillGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS);

  return async (command): Promise<VpsCommandRunResult> => {
    const timeout = command.executionTimeoutMs ?? defaultTimeout;
    return new Promise((resolve) => {
      let output = '';
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timeoutKillHandle: ReturnType<typeof setTimeout> | undefined;

      const child = spawn(command.executable, command.args, {
        shell: false,
        windowsHide: true,
      });

      const settle = (result: VpsCommandRunResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (timeoutKillHandle) {
          clearTimeout(timeoutKillHandle);
        }
        resolve(result);
      };

      const timeoutResult = (): VpsCommandRunResult => {
        const retainedOutput = formatOutput(output, outputTruncated, outputLimitChars);
        return {
          ok: false,
          error: `Command timed out after ${timeout}ms.${retainedOutput ? `\n${retainedOutput}` : ''}`,
          retriable: true,
          ...(retainedOutput ? { output: retainedOutput } : {}),
        };
      };

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        timeoutKillHandle = setTimeout(() => {
          child.kill('SIGKILL');
          settle(timeoutResult());
        }, timeoutKillGraceMs);
      }, timeout);

      const recordOutput = (chunk: Buffer | string): void => {
        const next = appendOutput(output, chunk, outputLimitChars);
        output = next.output;
        outputTruncated = outputTruncated || next.truncated;
      };

      child.stdout?.on('data', recordOutput);
      child.stderr?.on('data', recordOutput);

      child.on('error', (error) => {
        settle({
          ok: false,
          error: error.message,
          retriable: false,
        });
      });

      child.on('close', (code, signal) => {
        const retainedOutput = formatOutput(output, outputTruncated, outputLimitChars);
        if (timedOut) {
          settle(timeoutResult());
          return;
        }

        if (code === 0) {
          settle({
            ok: true,
            ...(retainedOutput ? { output: retainedOutput } : {}),
          });
          return;
        }

        const failure = signal
          ? `Command exited with signal ${signal}.`
          : `Command exited with code ${code ?? 'unknown'}.`;
        settle({
          ok: false,
          error: retainedOutput || failure,
          exitCode: typeof code === 'number' ? code : undefined,
          retriable: signal !== null || (isSshExecutable(command.executable) && code === 255),
          ...(retainedOutput ? { output: retainedOutput } : {}),
        });
      });
    });
  };
}
