/**
 * Integration proof for durable fishing catch correlation and replay safety.
 *
 * This intentionally calls the manager's catch boundary twice with the same
 * operation id. The first call writes the catch and idempotent wallet ledger;
 * the second call must read the unique correlation row and leave both counts
 * unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import { FishingManager } from '../../features/fishing/fishing-manager.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-fishing-correlation-${Date.now()}`;
const USER_ID = 'fishing-correlation-user';
const CORRELATION_ID = 'fishing-correlation-roundtrip-1';
let speciesId = '';

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({ id: GUILD_ID, name: 'Fishing Correlation Test', owner_discord_id: '1' });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID, economy_fishing_enabled: true });
  const { data: species, error: speciesError } = await supa.from('economy_fish_species').insert({
    guild_id: GUILD_ID,
    name: 'Correlation Cod',
    emoji: '🐟',
    rarity: 'common',
    min_weight: 1,
    max_weight: 1,
    base_price: 10,
    active: true,
  }).select('id').single();
  if (speciesError || !species) throw speciesError ?? new Error('failed to seed fishing species');
  speciesId = species.id;
  const { error: walletError } = await supa.rpc('economy_get_or_create_wallet', {
    p_guild_id: GUILD_ID,
    p_user_id: USER_ID,
  });
  if (walletError) throw walletError;
});

afterAll(async () => {
  await supa.from('economy_fish_catches').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_transactions').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_fish_species').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('fishing catch correlation', () => {
  it('round-trips correlation_id and makes a replay a durable no-op', async () => {
    const manager = new FishingManager({ id: GUILD_ID } as unknown as Guild, supa, {} as any);
    const first = await (manager as any).rollFishCatch(USER_ID, null, CORRELATION_ID);
    expect(first).toMatchObject({ species: { id: speciesId }, price: 10, paid: true });

    const { data: row } = await supa
      .from('economy_fish_catches')
      .select('correlation_id, paid')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_ID)
      .single();
    expect(row).toEqual({ correlation_id: CORRELATION_ID, paid: true });

    const snapshot = async () => {
      const { count: catchCount } = await supa
        .from('economy_fish_catches')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', GUILD_ID)
        .eq('correlation_id', CORRELATION_ID);
      const { count: ledgerCount } = await supa
        .from('economy_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', GUILD_ID)
        .eq('idempotency_key', CORRELATION_ID);
      return { catchCount, ledgerCount };
    };
    const beforeReplay = await snapshot();
    expect(beforeReplay).toEqual({ catchCount: 1, ledgerCount: 1 });

    const replay = await (manager as any).rollFishCatch(USER_ID, null, CORRELATION_ID);
    expect(replay).toMatchObject({ species: { id: speciesId }, price: 10, paid: true });
    expect(await snapshot()).toEqual(beforeReplay);
  });
});
