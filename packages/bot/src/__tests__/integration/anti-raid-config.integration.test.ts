/**
 * Integration test: anti-raid config loading against the REAL guild_config schema.
 *
 * Regression guard for the bug where loadConfig SELECTed a non-existent column
 * (anti_raid_auto_unban), so PostgREST rejected the WHOLE query (42703) → data was
 * null → every configured anti-raid setting silently fell back to its default and
 * no guild's raid protection ever took effect. This test seeds distinctive values
 * and proves loadConfig reads them back — which only passes if every selected
 * column exists in the real schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import { loadConfig, invalidateAntiRaidCache } from '../../features/anti-raid/index.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-antiraid-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Anti-Raid Test Guild',
    owner_discord_id: '111222333',
  });
});

afterAll(async () => {
  invalidateAntiRaidCache(GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Anti-raid config loading', () => {
  it('reads back every persisted anti-raid setting (schema-match regression guard)', async () => {
    // Distinctive, non-default values so a fallback-to-defaults regression is obvious.
    const { error: cfgErr } = await supa.from('guild_config').insert({
      guild_id: GUILD_ID,
      anti_raid_enabled: true,
      anti_raid_join_threshold: 25,
      anti_raid_join_window_seconds: 30,
      anti_raid_account_age_days: 14,
      anti_raid_action: 'ban',
      anti_raid_auto_unban: false, // non-default: proves the toggle is actually read
      anti_raid_ban_delete_seconds: 3600,
      anti_raid_log_channel_id: 'log-chan-antiraid',
      mod_log_channel_id: 'mod-log-antiraid',
    });
    expect(cfgErr).toBeNull();

    invalidateAntiRaidCache(GUILD_ID);
    const config = await loadConfig(supa, GUILD_ID);

    // Every value is the PERSISTED one, not the loadConfig default — proving the
    // SELECT succeeded against the real schema (a bad column would null the row
    // and yield the defaults 10 / 10 / 7 / 'kick' / 86400 / null instead).
    expect(config.anti_raid_enabled).toBe(true);
    expect(config.anti_raid_join_threshold).toBe(25);
    expect(config.anti_raid_join_window_seconds).toBe(30);
    expect(config.anti_raid_account_age_days).toBe(14);
    expect(config.anti_raid_action).toBe('ban');
    expect(config.anti_raid_ban_delete_seconds).toBe(3600);
    expect(config.anti_raid_log_channel_id).toBe('log-chan-antiraid');
    expect(config.mod_log_channel_id).toBe('mod-log-antiraid');
    // The persisted auto-unban toggle is honored (not forced to the default).
    expect(config.anti_raid_auto_unban).toBe(false);
  });
});
