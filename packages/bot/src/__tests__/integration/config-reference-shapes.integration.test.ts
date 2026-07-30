import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const guildId = `test-config-shapes-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  const inserted = await supa.from('guild').insert({
    id: guildId,
    name: 'Config reference shape integration test',
    owner_discord_id: '12345678901234567',
  });
  if (inserted.error) throw new Error(`Guild seed failed: ${inserted.error.message}`);

  const config = await supa.from('guild_config').upsert(
    { guild_id: guildId },
    { onConflict: 'guild_id' },
  );
  if (config.error) throw new Error(`Config seed failed: ${config.error.message}`);
});

afterAll(async () => {
  if (supa) await supa.from('guild').delete().eq('id', guildId);
});

describe('guild configuration reference shapes', () => {
  it('accepts canonical snowflakes and rejects impossible scalar references', async () => {
    const accepted = await supa.from('guild_config').update({
      welcome_channel_id: '12345678901234567',
      dj_role_id: '22345678901234567',
    }).eq('guild_id', guildId);
    expect(accepted.error).toBeNull();

    const rejected = await supa.from('guild_config').update({
      welcome_channel_id: 'not-a-channel',
    }).eq('guild_id', guildId);
    expect(rejected.error?.code).toBe('23514');
  });

  it('rejects invalid reference arrays without partially storing them', async () => {
    const rejected = await supa.from('guild_config').update({
      welcome_auto_roles: ['12345678901234567', 'not-a-role'],
    }).eq('guild_id', guildId);
    expect(rejected.error?.code).toBe('23514');

    const row = await supa.from('guild_config')
      .select('welcome_auto_roles')
      .eq('guild_id', guildId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data?.welcome_auto_roles).toEqual([]);
  });

  it('accepts Unicode/custom emoji and rejects plain text', async () => {
    const unicode = await supa.from('guild_config').update({
      starboard_emoji: '⭐',
    }).eq('guild_id', guildId);
    expect(unicode.error).toBeNull();

    const custom = await supa.from('guild_config').update({
      starboard_emoji: '<:party_blob:12345678901234567>',
    }).eq('guild_id', guildId);
    expect(custom.error).toBeNull();

    const rejected = await supa.from('guild_config').update({
      starboard_emoji: 'star',
    }).eq('guild_id', guildId);
    expect(rejected.error?.code).toBe('23514');

    const embedded = await supa.from('guild_config').update({
      starboard_emoji: 'stars 😀 please',
    }).eq('guild_id', guildId);
    expect(embedded.error?.code).toBe('23514');
  });

  it('accepts web card backgrounds and rejects non-web schemes', async () => {
    const accepted = await supa.from('guild_config').update({
      welcome_card_background: 'https://cdn.example/welcome.png',
      rank_card_background: 'http://assets.example/rank.jpg',
    }).eq('guild_id', guildId);
    expect(accepted.error).toBeNull();

    const rejected = await supa.from('guild_config').update({
      rank_card_background: 'data:image/png;base64,abc',
    }).eq('guild_id', guildId);
    expect(rejected.error?.code).toBe('23514');
  });
});
