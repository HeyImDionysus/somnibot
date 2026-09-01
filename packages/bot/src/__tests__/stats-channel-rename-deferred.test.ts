import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  isDiscordRenameRateLimit,
  recordStatsChannelMissing,
  recordStatsRenameDeferred,
  type StatsChannelConfig,
} from '../features/stats-channels/stats-manager.js';

describe('statistics channel deferred rename audit', () => {
  it('classifies Discord rename rate limits without classifying ordinary failures', () => {
    // Given Discord and non-Discord error shapes.
    const globalRateLimit = { status: 429 };
    const channelRateLimit = { code: 20028 };
    const permissionFailure = new Error('Missing Permissions');

    // When the rename errors are classified.
    const results = [globalRateLimit, channelRateLimit, permissionFailure]
      .map(isDiscordRenameRateLimit);

    // Then only rate-limit errors enter the deferred path.
    expect(results).toEqual([true, true, false]);
  });

  it('writes one occurrence-keyed rename-deferred audit row', async () => {
    // Given a rate-limited counter occurrence.
    const auditBodies: unknown[] = [];
    const supabase = createClient('https://stats.test', 'anon-key', {
      global: {
        fetch: async (_input, init) => {
          auditBodies.push(JSON.parse(String(init?.body)));
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const config: StatsChannelConfig = {
      id: 'counter-1',
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      stat_type: 'member_count',
      stat_config: {},
      name_format: 'Members: {value}',
      active: true,
      last_value: '41',
      pending_cleanup_channel_ids: null,
    };

    // When the manager defers value 42 for this refresh window.
    await recordStatsRenameDeferred(
      supabase,
      config,
      '42',
      '2026-08-23T12:00:00.000Z',
      { status: 429 },
    );

    // Then the durable audit identity is counter, value, and evaluation window.
    expect(auditBodies).toEqual([
      expect.arrayContaining([expect.objectContaining({
        action: 'stats_channels.rename_deferred',
        occurrence_key:
          'stats_channels.rename_deferred:counter-1:42:2026-08-23T12:00:00.000Z',
        success: false,
      })]),
    ]);
  });

  it('writes one occurrence-keyed missing-channel audit row', async () => {
    // Given a configured counter whose Discord channel disappeared.
    const auditBodies: unknown[] = [];
    const supabase = createClient('https://stats.test', 'anon-key', {
      global: {
        fetch: async (_input, init) => {
          auditBodies.push(JSON.parse(String(init?.body)));
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const config: StatsChannelConfig = {
      id: 'counter-1',
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      stat_type: 'member_count',
      stat_config: {},
      name_format: 'Members: {value}',
      active: true,
      last_value: '41',
      pending_cleanup_channel_ids: null,
    };

    // When the missing channel is evaluated.
    await recordStatsChannelMissing(supabase, config, 'channel-1');

    // Then the failure is durable under the catalog action and occurrence identity.
    expect(auditBodies).toEqual([
      expect.arrayContaining([expect.objectContaining({
        action: 'stats_channels.channel_missing',
        occurrence_key: 'stats_channels.channel_missing:counter-1:channel-1',
        success: false,
      })]),
    ]);
  });
});
