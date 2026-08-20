import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSavedInstallationRuntimeSecret = vi.hoisted(() => vi.fn());

vi.mock('@/lib/installation-runtime-secret', () => ({
  getSavedInstallationRuntimeSecret,
}));

describe('rate-limit saved Valkey configuration recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    getSavedInstallationRuntimeSecret.mockReset();
    vi.stubEnv('VALKEY_URL', '');
    vi.stubEnv('REDIS_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('retries a transient saved-setting read failure instead of caching the rejection forever', async () => {
    getSavedInstallationRuntimeSecret
      .mockRejectedValueOnce(new Error('settings temporarily unavailable'))
      .mockResolvedValueOnce(null);
    const { checkValkeyHealth } = await import('@/lib/api/rate-limit');

    await expect(checkValkeyHealth()).resolves.toBe(false);
    await expect(checkValkeyHealth()).resolves.toBe(false);

    expect(getSavedInstallationRuntimeSecret).toHaveBeenCalledTimes(2);
  });
});
