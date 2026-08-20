import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const suffix = Date.now();
const guildId = `test-item-use-${suffix}`;
const userId = `item-user-${suffix}`;
const itemIds: Record<string, string> = {};

interface UseResult {
  status: 'applied' | 'rejected';
  replayed?: boolean;
  effect_type?: string;
  action_id?: string;
}

async function useItem(
  item: string,
  requestId: string,
): Promise<{ data: UseResult | null; error: { message: string } | null }> {
  return supa.rpc('economy_use_item_atomic', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_item_selector: item,
    p_request_id: requestId,
  }) as unknown as Promise<{ data: UseResult | null; error: { message: string } | null }>;
}

async function inventoryQuantity(itemId: string): Promise<number> {
  const { data } = await supa
    .from('economy_inventory')
    .select('quantity')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  return Number(data?.quantity ?? 0);
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: guildError } = await supa.from('guild').insert({
    id: guildId,
    name: 'Item Use Integration Guild',
    owner_discord_id: '100000000000000021',
  });
  if (guildError) throw new Error(`guild seed: ${guildError.message}`);

  const definitions = [
    { key: 'coins', name: 'Coin Pouch', usable: true, use_effect: { type: 'wallet_credit', amount: 250 } },
    { key: 'xp', name: 'XP Tome', usable: true, use_effect: { type: 'xp_credit', amount: 50 } },
    { key: 'role', name: 'Member Badge', usable: true, use_effect: { type: 'role_grant', role_id: '100000000000000022' } },
    { key: 'padlock', name: 'Padlock', usable: false, use_effect: { type: 'padlock' } },
  ];

  for (const definition of definitions) {
    const { data, error } = await supa.from('economy_items').insert({
      guild_id: guildId,
      name: definition.name,
      price: 0,
      active: true,
      usable: definition.usable,
      use_effect: definition.use_effect,
    }).select('id').single();
    if (error) throw new Error(`item seed: ${error.message}`);
    itemIds[definition.key] = String(data!.id);
    const { error: inventoryError } = await supa.from('economy_inventory').insert({
      guild_id: guildId,
      user_id: userId,
      item_id: data!.id,
      quantity: 2,
    });
    if (inventoryError) throw new Error(`inventory seed: ${inventoryError.message}`);
  }
});

afterAll(async () => {
  await supa.from('audit_logs').delete().eq('guild_id', guildId);
  await supa.from('bot_action_queue').delete().eq('guild_id', guildId);
  await supa.from('economy_item_use_operations').delete().eq('guild_id', guildId);
  await supa.from('economy_transactions').delete().eq('guild_id', guildId);
  await supa.from('member_levels').delete().eq('guild_id', guildId);
  await supa.from('economy_inventory').delete().eq('guild_id', guildId);
  await supa.from('economy_items').delete().eq('guild_id', guildId);
  await supa.from('economy_wallets').delete().eq('guild_id', guildId);
  await supa.from('guild').delete().eq('id', guildId);
});

describe('economy_use_item_atomic', () => {
  it('serializes duplicate coin use into one debit, one credit, and one audit', async () => {
    const [first, second] = await Promise.all([
      useItem('Coin Pouch', 'use-coins-1'),
      useItem('Coin Pouch', 'use-coins-1'),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect([first.data!.replayed, second.data!.replayed].sort()).toEqual([false, true]);
    expect(await inventoryQuantity(itemIds.coins)).toBe(1);

    const wallet = await supa.from('economy_wallets')
      .select('wallet')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();
    expect(Number(wallet.data!.wallet)).toBe(250);

    const audits = await supa.from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .eq('occurrence_key', 'economy.item_used:use-coins-1');
    expect(audits.count).toBe(1);
  });

  it('applies XP once and preserves the level calculation result for replay', async () => {
    const first = await useItem(itemIds.xp, 'use-xp-1');
    const replay = await useItem(itemIds.xp, 'use-xp-1');
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'applied', effect_type: 'xp_credit', replayed: false });
    expect(replay.data).toMatchObject({ status: 'applied', effect_type: 'xp_credit', replayed: true });
    expect(await inventoryQuantity(itemIds.xp)).toBe(1);

    const level = await supa.from('member_levels')
      .select('xp')
      .eq('guild_id', guildId)
      .eq('member_id', userId)
      .single();
    expect(Number(level.data!.xp)).toBe(50);
  });

  it('queues one durable role grant and refuses automatic tools without consuming them', async () => {
    const roleUse = await useItem('Member Badge', 'use-role-1');
    expect(roleUse.error).toBeNull();
    expect(roleUse.data).toMatchObject({ status: 'applied', effect_type: 'role_grant' });
    expect(await inventoryQuantity(itemIds.role)).toBe(1);

    const queued = await supa.from('bot_action_queue')
      .select('action, payload')
      .eq('id', roleUse.data!.action_id)
      .single();
    expect(queued.data).toMatchObject({
      action: 'bulk_role_add',
      payload: {
        member_id: userId,
        role_id: '100000000000000022',
        source: 'economy_item_use',
      },
    });

    const automatic = await useItem('Padlock', 'use-padlock-1');
    expect(automatic.error).toBeNull();
    expect(automatic.data).toMatchObject({ status: 'rejected' });
    expect(await inventoryQuantity(itemIds.padlock)).toBe(2);
  });
});
