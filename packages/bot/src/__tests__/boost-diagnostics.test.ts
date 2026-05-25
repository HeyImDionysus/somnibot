/**
 * Tests for features/audit/diagnostics-service.ts — DiagnosticsService class.
 * 132 uncovered statements at 14.8%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; } addFields() { return this; }
  },
  Collection: class extends Map {},
}));

import { DiagnosticsService } from '../features/audit/diagnostics-service.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'count', 'gte', 'lte']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null, count: 0 });
  return chain;
}

describe('DiagnosticsService', () => {
  it('instantiates', () => {
    const svc = new DiagnosticsService({
      from: vi.fn(() => makeChain()),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any);
    expect(svc).toBeDefined();
  });
});
