// @ts-nocheck
/**
 * Tests for services/reconciliation.ts — runReconciliation and scheduleReconciliation.
 * 113 uncovered statements at 37.2%.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  Collection: class extends Map {},
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { runReconciliation, scheduleReconciliation } from '../services/reconciliation.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'neq', 'gt', 'gte', 'lt', 'lte']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test',
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue(new Map()),
    },
    roles: { cache: new Map() },
    channels: { cache: new Map() },
  } as any;
}

describe('reconciliation', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runReconciliation runs without errors', async () => {
    const result = await runReconciliation(makeGuild(), makeSupa());
    expect(result).toBeDefined();
  });

  it('scheduleReconciliation returns a control handle', () => {
    vi.useFakeTimers();
    const handle = scheduleReconciliation(makeGuild(), makeSupa(), 60);
    expect(handle).toBeDefined();
    vi.useRealTimers();
  });
});
