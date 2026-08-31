import { afterEach, describe, expect, it, vi } from 'vitest';

const { runInNewContextMock } = vi.hoisted(() => ({
  runInNewContextMock: vi.fn(),
}));

vi.mock('node:vm', () => ({
  runInNewContext: runInNewContextMock,
}));

import { evaluateBoundedRegex } from '../services/bounded-regex.js';

afterEach(() => {
  vi.restoreAllMocks();
  runInNewContextMock.mockReset();
});

describe('evaluateBoundedRegex', () => {
  it('retries a VM timeout caused without exhausting this worker thread CPU budget', () => {
    const timeout = new Error('Script execution timed out after 250ms');
    runInNewContextMock
      .mockImplementationOnce(() => {
        throw timeout;
      })
      .mockReturnValueOnce(true);

    const threadCpuUsageSpy = vi.spyOn(process, 'threadCpuUsage')
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValueOnce({ user: 1_000, system: 0 })
      .mockReturnValueOnce({ user: 1_000, system: 0 })
      .mockReturnValueOnce({ user: 2_000, system: 0 });

    try {
      expect(evaluateBoundedRegex(/\\d+/, 'order 123')).toBe(true);
      expect(runInNewContextMock).toHaveBeenCalledTimes(2);
      expect(runInNewContextMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 249 });
    } finally {
      threadCpuUsageSpy.mockRestore();
      runInNewContextMock.mockReset();
    }
  });

  it('does not retry once the VM timeout consumed the active CPU budget', () => {
    const timeout = new Error('Script execution timed out after 250ms');
    const onFinalTimeout = vi.fn();
    runInNewContextMock.mockImplementationOnce(() => {
      throw timeout;
    });

    const threadCpuUsageSpy = vi.spyOn(process, 'threadCpuUsage')
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValueOnce({ user: 250_000, system: 0 });

    try {
      expect(evaluateBoundedRegex(/(a+)+/, 'a'.repeat(2_000), { onFinalTimeout })).toBe(false);
      expect(runInNewContextMock).toHaveBeenCalledTimes(1);
      expect(onFinalTimeout).toHaveBeenCalledOnce();
    } finally {
      threadCpuUsageSpy.mockRestore();
      runInNewContextMock.mockReset();
    }
  });

  it('uses the owner-configured VM timeout as the active CPU cap', () => {
    runInNewContextMock.mockReturnValueOnce(false);
    try {
      expect(evaluateBoundedRegex(/word/, 'message', { timeoutMs: 50 })).toBe(false);
      expect(runInNewContextMock).toHaveBeenCalledWith(
        'regex.test(input)',
        expect.any(Object),
        expect.objectContaining({ timeout: 50 }),
      );
    } finally {
      runInNewContextMock.mockReset();
    }
  });
});
