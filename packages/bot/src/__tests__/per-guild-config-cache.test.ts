/**
 * Regression guard: the starboard and message-log config caches must be keyed by
 * guildId. Both used to be a single module-global entry, so within the 60s TTL the
 * first guild to load config served its config to every other guild in the process
 * (cross-guild config bleed / silently-dropped forensic logs).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SomniClient } from '../client.js';
import { loadConfig as loadStarboardConfig, invalidateStarboardCache } from '../features/starboard/index.js';
import { loadConfig as loadMessageLogConfig, invalidateMessageLogCache } from '../features/message-log/index.js';

/** A guild_config query mock that returns a different row per guild_id filter. */
function makeSupabase(rowByGuild: Record<string, Record<string, unknown>>): SupabaseClient {
  let currentGuild = '';
  const chain: Record<string, unknown> = {
    from: () => chain,
    select: () => chain,
    eq: (col: string, val: string) => {
      if (col === 'guild_id') currentGuild = val;
      return chain;
    },
    maybeSingle: async () => ({ data: rowByGuild[currentGuild] ?? null, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

describe('per-guild config cache isolation', () => {
  beforeEach(() => {
    invalidateStarboardCache();
    invalidateMessageLogCache();
  });

  it('starboard loadConfig returns each guild its OWN config within the TTL', async () => {
    const supa = makeSupabase({
      A: { starboard_enabled: true, starboard_channel_id: 'chan-A', starboard_threshold: 3, starboard_emoji: '⭐', starboard_self_star: false },
      B: { starboard_enabled: true, starboard_channel_id: 'chan-B', starboard_threshold: 5, starboard_emoji: '🌟', starboard_self_star: true },
    });

    const a = await loadStarboardConfig(supa, 'A'); // populates cache for A
    const b = await loadStarboardConfig(supa, 'B'); // must NOT return A's cached config

    expect(a.starboard_channel_id).toBe('chan-A');
    expect(a.starboard_threshold).toBe(3);
    expect(b.starboard_channel_id).toBe('chan-B'); // pre-fix: was 'chan-A'
    expect(b.starboard_threshold).toBe(5);
    expect(b.starboard_emoji).toBe('🌟');
  });

  it('message-log loadConfig returns each guild its OWN config within the TTL', async () => {
    const supa = makeSupabase({
      A: { message_log_enabled: true, message_log_channel_id: 'log-A' },
      B: { message_log_enabled: false, message_log_channel_id: null },
    });
    const client = { supabase: supa } as unknown as SomniClient;

    const a = await loadMessageLogConfig(client, 'A'); // enabled → log-A
    const b = await loadMessageLogConfig(client, 'B'); // disabled → must not inherit A

    expect(a.message_log_enabled).toBe(true);
    expect(a.message_log_channel_id).toBe('log-A');
    expect(b.message_log_enabled).toBe(false); // pre-fix: inherited A's true/log-A
    expect(b.message_log_channel_id).toBeNull();
  });

  it('per-guild invalidation drops only the named guild', async () => {
    const supa = makeSupabase({
      A: { starboard_enabled: true, starboard_channel_id: 'chan-A1', starboard_threshold: 3, starboard_emoji: '⭐', starboard_self_star: false },
      B: { starboard_enabled: true, starboard_channel_id: 'chan-B1', starboard_threshold: 5, starboard_emoji: '⭐', starboard_self_star: false },
    });
    await loadStarboardConfig(supa, 'A');
    await loadStarboardConfig(supa, 'B');

    // Change A's underlying row, invalidate only A.
    const supa2 = makeSupabase({
      A: { starboard_enabled: true, starboard_channel_id: 'chan-A2', starboard_threshold: 9, starboard_emoji: '⭐', starboard_self_star: false },
      B: { starboard_enabled: true, starboard_channel_id: 'chan-B1', starboard_threshold: 5, starboard_emoji: '⭐', starboard_self_star: false },
    });
    invalidateStarboardCache('A');

    const a = await loadStarboardConfig(supa2, 'A'); // re-fetched → new value
    const b = await loadStarboardConfig(supa2, 'B'); // still cached → old value
    expect(a.starboard_channel_id).toBe('chan-A2');
    expect(b.starboard_channel_id).toBe('chan-B1');
  });
});
