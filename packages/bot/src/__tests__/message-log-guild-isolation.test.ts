import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn(),
  resolveOwnerAlert: vi.fn().mockResolvedValue(0),
  resolveOwnerAlertWithStatus: vi.fn().mockResolvedValue({
    resolvedCount: 0,
    succeeded: true,
  }),
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { invalidateMessageLogCache, loadConfig } from '../features/message-log/index.js';

const guildConfigs = new Map([
  ['guild-a', {
    message_log_enabled: true,
    message_log_channel_id: 'log-a',
    message_log_edits_enabled: true,
    message_log_deletes_enabled: false,
    message_log_ignored_channel_ids: ['ignored-a'],
  }],
  ['guild-b', {
    message_log_enabled: false,
    message_log_channel_id: 'log-b',
    message_log_edits_enabled: false,
    message_log_deletes_enabled: true,
    message_log_ignored_channel_ids: ['ignored-b'],
  }],
]);

function guildConfigQuery() {
  let guildId = '';
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn((_column: string, value: string) => {
      guildId = value;
      return query;
    }),
    maybeSingle: vi.fn(async () => ({
      data: guildConfigs.get(guildId) ?? null,
      error: null,
    })),
  };
  return query;
}

describe('message-log guild isolation', () => {
  beforeEach(() => {
    invalidateMessageLogCache();
  });

  it('keeps each guild configuration independent inside the cache TTL', async () => {
    const from = vi.fn((table: string) => {
      if (table !== 'guild_config') throw new Error(`unexpected table: ${table}`);
      return guildConfigQuery();
    });
    const client = {
      supabase: { from },
      eventBus: { emit: vi.fn() },
    } as any;

    const guildA = await loadConfig(client, 'guild-a');
    const guildB = await loadConfig(client, 'guild-b');
    const guildAFromCache = await loadConfig(client, 'guild-a');

    expect(guildA).toMatchObject({
      message_log_enabled: true,
      message_log_channel_id: 'log-a',
      message_log_deletes_enabled: false,
      message_log_ignored_channel_ids: ['ignored-a'],
    });
    expect(guildB).toMatchObject({
      message_log_enabled: false,
      message_log_channel_id: 'log-b',
      message_log_edits_enabled: false,
      message_log_ignored_channel_ids: ['ignored-b'],
    });
    expect(guildAFromCache).toEqual(guildA);
    expect(from).toHaveBeenCalledTimes(2);
  });
});
