/**
 * Tests for features/discord-native/forum-tickets.ts — ForumTicketService.
 * 130 uncovered statements at 13.9%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    addFields() { return this; } setFooter() { return this; } setTimestamp() { return this; }
  },
  PermissionFlagsBits: { ManageThreads: 1n },
  ChannelType: { GuildForum: 15 },
  Collection: class extends Map {},
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { ForumTicketService } from '../features/discord-native/forum-tickets.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

describe('ForumTicketService', () => {
  it('has required methods', () => {
    const svc = new ForumTicketService({} as any, {} as any);
    expect(typeof svc.createForumTicket).toBe('function');
  });

  it('instantiates', () => {
    const svc = new ForumTicketService(
      { id: 'guild-1' } as any,
      { from: vi.fn(() => makeChain()), rpc: vi.fn(async () => ({ data: null, error: null })) } as any,
    );
    expect(svc).toBeDefined();
  });
});
