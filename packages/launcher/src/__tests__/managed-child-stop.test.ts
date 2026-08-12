import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopChildProcess } from '../main/managed-child-stop.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  killResult = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return this.killResult;
  }
}

describe('managed child shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for close after escalating from SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let resolved = false;
    const stopped = stopChildProcess(child as unknown as ChildProcess, {
      graceMs: 10,
      forceExitMs: 10,
      serviceName: 'test child',
    }).then(() => { resolved = true; });

    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(10);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(resolved).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await stopped;
    expect(resolved).toBe(true);
  });

  it('rejects when the process never closes after SIGKILL', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const stopped = stopChildProcess(child as unknown as ChildProcess, {
      graceMs: 10,
      forceExitMs: 10,
      serviceName: 'stuck child',
    });
    const assertion = expect(stopped).rejects.toThrow(/did not exit after SIGKILL/);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('rejects an asynchronous child error instead of crashing unhandled', async () => {
    const child = new FakeChild();
    const stopped = stopChildProcess(child as unknown as ChildProcess, { serviceName: 'broken child' });
    child.emit('error', new Error('access denied'));
    await expect(stopped).rejects.toThrow(/broken child shutdown failed: access denied/);
  });
});
