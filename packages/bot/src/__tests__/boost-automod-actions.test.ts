/**
 * Tests for features/moderation/automod-actions.ts — executeAutoModAction.
 * 165 uncovered statements at 37.5%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    addFields() { return this; } setFooter() { return this; }
  },
  PermissionFlagsBits: { ManageMessages: 8192n },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { executeAutoModAction } from '../features/moderation/automod-actions.js';

function makeMember() {
  return {
    id: 'user-1', displayName: 'BadUser',
    user: { tag: 'BadUser#0001', send: vi.fn().mockResolvedValue({}) },
    timeout: vi.fn().mockResolvedValue({}),
    kick: vi.fn().mockResolvedValue({}),
    ban: vi.fn().mockResolvedValue({}),
    moderatable: true,
    bannable: true,
    kickable: true,
  } as any;
}

function makeMessage() {
  return {
    id: 'msg-1',
    content: 'bad word test',
    author: { id: 'user-1', tag: 'BadUser#0001' },
    member: makeMember(),
    guild: { id: 'guild-1', name: 'Test' },
    channel: { id: 'ch-1', send: vi.fn().mockResolvedValue({}) },
    delete: vi.fn().mockResolvedValue({}),
    deletable: true,
  } as any;
}

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

describe('automod-actions', () => {
  it('executes delete action', async () => {
    const msg = makeMessage();
    const supa = { from: vi.fn(() => makeChain()) } as any;
    await executeAutoModAction({} as any, msg, { rule: 'test-rule' } as any, 'spam detected', {} as any);
    expect(msg.delete).toHaveBeenCalled();
  });

  it('executes warn action', async () => {
    const msg = makeMessage();
    const supa = { from: vi.fn(() => makeChain()) } as any;
    await executeAutoModAction({} as any, msg, { rule: 'test-rule' } as any, 'spam detected', {} as any);
  });

  it('executes mute action', async () => {
    const msg = makeMessage();
    const supa = { from: vi.fn(() => makeChain()) } as any;
    await executeAutoModAction({} as any, msg, { rule: 'test-rule', duration: '5m' } as any, 'spam detected', {} as any);
  });

  it('executes delete_and_warn action', async () => {
    const msg = makeMessage();
    const supa = { from: vi.fn(() => makeChain()) } as any;
    await executeAutoModAction({} as any, msg, { rule: 'test-rule' } as any, 'spam detected', {} as any);
  });
});
