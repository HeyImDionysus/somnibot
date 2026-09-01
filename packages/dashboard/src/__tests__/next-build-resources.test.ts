import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: () => { throw new Error('No root environment in this fixture'); } }));

afterEach(() => {
  vi.resetModules();
});

it('caps build worker pools independently of host logical CPU count', async () => {
  // Given a build configuration loaded without reading credentials from disk.
  const { default: config } = await import('../../next.config.js');

  // When Next determines each build worker pool size.
  const workers = config.experimental?.cpus;

  // Then high-core workstations and shared VPS hosts keep a two-worker ceiling.
  expect(workers).toBe(2);
  expect(config.experimental?.memoryBasedWorkersCount).not.toBe(true);
});
