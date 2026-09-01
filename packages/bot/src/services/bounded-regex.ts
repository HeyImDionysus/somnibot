import { runInNewContext } from 'node:vm';

/**
 * Maximum CPU time a single owner-configured regex may consume. The VM also
 * receives this as its wall-clock timeout, then retries only the unused CPU
 * allowance when host scheduling—not regex work—caused the first timeout.
 */
export const REGEX_VM_TIMEOUT_MS = 250;

type CpuUsage = {
  readonly user: number;
  readonly system: number;
};

type BoundedRegexOptions = {
  readonly timeoutMs?: number;
  readonly onFinalTimeout?: () => void;
};

function readThreadCpuUsage(): CpuUsage | null {
  if (typeof process.threadCpuUsage !== 'function') return null;
  return process.threadCpuUsage();
}

function usedCpuMicroseconds(start: CpuUsage, end: CpuUsage): number {
  return (end.user - start.user) + (end.system - start.system);
}

function isVmTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Script execution timed out');
}

function runRegexInVm(regex: RegExp, input: string, timeout: number): boolean {
  return Boolean(runInNewContext(
    'regex.test(input)',
    { regex, input },
    { timeout, microtaskMode: 'afterEvaluate' },
  ));
}

/**
 * Evaluates a regular expression with a strict active-CPU budget.
 *
 * `node:vm` times out against wall time, so a worker that is descheduled by a
 * busy host can time out before the regex has consumed its security budget.
 * On Node versions with per-thread CPU accounting, retry exactly once with
 * only the unused CPU allowance. A real expensive regex therefore remains
 * bounded to the same total active CPU budget and still fails closed.
 */
export function evaluateBoundedRegex(
  regex: RegExp,
  input: string,
  options: BoundedRegexOptions = {},
): boolean {
  const timeoutMs = options.timeoutMs ?? REGEX_VM_TIMEOUT_MS;
  const startCpu = readThreadCpuUsage();
  try {
    return runRegexInVm(regex, input, timeoutMs);
  } catch (error) {
    if (!isVmTimeout(error) || !startCpu) return false;

    const usedCpuUs = usedCpuMicroseconds(startCpu, readThreadCpuUsage() ?? startCpu);
    const remainingCpuUs = (timeoutMs * 1_000) - usedCpuUs;
    const retryTimeoutMs = Math.floor(remainingCpuUs / 1_000);
    if (retryTimeoutMs <= 0) {
      options.onFinalTimeout?.();
      return false;
    }

    try {
      return runRegexInVm(regex, input, retryTimeoutMs);
    } catch (retryError) {
      if (isVmTimeout(retryError)) options.onFinalTimeout?.();
      return false;
    }
  }
}
