import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import { writeEconomyAudit } from '../../services/audit.js';

type FarmingResult = {
  readonly applied?: boolean;
  readonly audit_action?: string;
  readonly affected_plot_indexes?: readonly number[];
  readonly plot_index?: number;
  readonly replayed?: boolean;
  readonly status?: string;
};

let supa: SupabaseClient;
const suffix = `${Date.now()}`;
const guildId = `test-farming-ops-${suffix}`;
const userId = `farming-user-${suffix}`;
let cropId = '';
let seedItemId = '';
let fertilizerItemId = '';

async function operation(
  operationType: 'plant' | 'water' | 'fertilize',
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ data: FarmingResult | null; error: { readonly message: string } | null }> {
  const { data, error } = await supa.rpc('economy_farming_operation_atomic', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_operation_id: operationId,
    p_operation_type: operationType,
    p_crop_id: null,
    p_item_id: null,
    p_plot_index: null,
    p_grid_size: 9,
    p_wilt_enabled: true,
    p_fertilizer_reduction_pct: 50,
    p_fail_before_plot: false,
    ...overrides,
  });
  return { data, error };
}

async function inventory(itemId: string): Promise<number> {
  const { data } = await supa
    .from('economy_inventory')
    .select('quantity')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  return Number(data?.quantity ?? 0);
}

async function auditCount(operationId: string): Promise<number> {
  const { count } = await supa
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('correlation_id', operationId);
  return count ?? 0;
}

async function recordFailureAudit(
  operationType: 'plant' | 'fertilize',
  operationId: string,
  errorMessage: string,
): Promise<void> {
  await writeEconomyAudit(supa, {
    guildId,
    actorId: userId,
    operationId,
    action: `farming.${operationType}`,
    details: { operation: operationType, reason: 'rpc_error' },
    success: false,
    errorMessage,
  });
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: guildError } = await supa.from('guild').insert({
    id: guildId,
    name: 'Farming Operation Integration Guild',
    owner_discord_id: '100000000000000401',
  });
  if (guildError) throw new Error(`guild seed failed: ${guildError.message}`);

  const { data: items, error: itemError } = await supa.from('economy_items').insert([
    { guild_id: guildId, name: 'Potato Seeds', category: 'Seed', price: 1 },
    { guild_id: guildId, name: 'Fertilizer', category: 'Farming', price: 1 },
  ]).select('id,name');
  if (itemError) throw new Error(`item seed failed: ${itemError.message}`);
  seedItemId = items?.find((item) => item.name === 'Potato Seeds')?.id ?? '';
  fertilizerItemId = items?.find((item) => item.name === 'Fertilizer')?.id ?? '';

  const { data: crop, error: cropError } = await supa.from('economy_crops').insert({
    guild_id: guildId,
    name: 'Potato',
    emoji: '🥔',
    grow_seconds: 60,
    wilt_seconds: 3600,
    sell_price: 30,
    seeds_returned: 0,
    seed_item_id: seedItemId,
  }).select('id').single();
  if (cropError) throw new Error(`crop seed failed: ${cropError.message}`);
  cropId = crop.id;
});

afterAll(async () => {
  if (!supa) return;
  await supa.from('economy_farming_operations').delete().eq('guild_id', guildId);
  await supa.from('economy_farm_plots').delete().eq('guild_id', guildId);
  await supa.from('economy_inventory').delete().eq('guild_id', guildId);
  await supa.from('economy_crops').delete().eq('guild_id', guildId);
  await supa.from('economy_items').delete().eq('guild_id', guildId);
});

describe('economy_farming_operation_atomic', () => {
  it('applies and replays plant exactly once under concurrent delivery', async () => {
    await supa.from('economy_inventory').upsert({
      guild_id: guildId, user_id: userId, item_id: seedItemId, quantity: 2,
    });
    const args = { p_crop_id: cropId, p_item_id: seedItemId };
    const [first, duplicate] = await Promise.all([
      operation('plant', 'plant-race', args),
      operation('plant', 'plant-race', args),
    ]);

    expect(first.error).toBeNull();
    expect(duplicate.error).toBeNull();
    expect([first.data?.replayed, duplicate.data?.replayed].sort()).toEqual([false, true]);
    expect(first.data).toMatchObject({ status: 'planted', applied: true, plot_index: 0 });
    expect(await inventory(seedItemId)).toBe(1);
    const { count } = await supa.from('economy_farm_plots').select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId).eq('user_id', userId);
    expect(count).toBe(1);
    expect(await auditCount('plant-race')).toBe(1);
  });

  it('waters the intended plot set once and replays the same indexes', async () => {
    await supa.from('economy_farm_plots').insert({
      guild_id: guildId, user_id: userId, plot_index: 1, crop_id: cropId,
      planted_at: new Date().toISOString(), watered_at: null, fertilized: false, harvested: false,
    });
    const [first, duplicate] = await Promise.all([
      operation('water', 'water-race'),
      operation('water', 'water-race'),
    ]);

    expect(first.error).toBeNull();
    expect(duplicate.error).toBeNull();
    expect([first.data?.replayed, duplicate.data?.replayed].sort()).toEqual([false, true]);
    expect(first.data).toMatchObject({ status: 'watered', affected_plot_indexes: [0, 1] });
    expect(duplicate.data).toMatchObject({ status: 'watered', affected_plot_indexes: [0, 1] });
    const { count } = await supa.from('economy_farm_plots').select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId).eq('user_id', userId).not('watered_at', 'is', null);
    expect(count).toBe(2);
    expect(await auditCount('water-race')).toBe(1);
  });

  it('fertilizes and consumes one item once under duplicate delivery', async () => {
    await supa.from('economy_inventory').upsert({
      guild_id: guildId, user_id: userId, item_id: fertilizerItemId, quantity: 2,
    });
    const args = { p_item_id: fertilizerItemId, p_plot_index: 1 };
    const [first, duplicate] = await Promise.all([
      operation('fertilize', 'fertilize-race', args),
      operation('fertilize', 'fertilize-race', args),
    ]);

    expect(first.error).toBeNull();
    expect(duplicate.error).toBeNull();
    expect([first.data?.replayed, duplicate.data?.replayed].sort()).toEqual([false, true]);
    expect(first.data).toMatchObject({ status: 'fertilized', plot_index: 1 });
    expect(duplicate.data).toMatchObject({ status: 'fertilized', plot_index: 1 });
    expect(await inventory(fertilizerItemId)).toBe(1);
    expect(await auditCount('fertilize-race')).toBe(1);
  });

  it('records deterministic inventory failures without mutating plots', async () => {
    await supa.from('economy_inventory').delete().eq('guild_id', guildId).eq('user_id', userId);
    const plant = await operation('plant', 'plant-no-seed', { p_crop_id: cropId, p_item_id: seedItemId });
    const fertilize = await operation('fertilize', 'fertilize-no-item', {
      p_item_id: fertilizerItemId, p_plot_index: 0,
    });

    expect(plant.data).toMatchObject({ status: 'missing_inventory', applied: false });
    expect(fertilize.data).toMatchObject({ status: 'missing_inventory', applied: false });
    expect(await auditCount('plant-no-seed')).toBe(1);
    expect(await auditCount('fertilize-no-item')).toBe(1);
  });

  it('rolls inventory and plots back when the pre-plot fault hook fires', async () => {
    await supa.from('economy_inventory').upsert([
      { guild_id: guildId, user_id: userId, item_id: seedItemId, quantity: 1 },
      { guild_id: guildId, user_id: userId, item_id: fertilizerItemId, quantity: 1 },
    ]);
    const plant = await operation('plant', 'plant-fault', {
      p_crop_id: cropId, p_item_id: seedItemId, p_fail_before_plot: true,
    });
    const fertilize = await operation('fertilize', 'fertilize-fault', {
      p_item_id: fertilizerItemId, p_plot_index: 0, p_fail_before_plot: true,
    });

    expect(plant.error?.message).toContain('farming operation fault before plot mutation');
    expect(fertilize.error?.message).toContain('farming operation fault before plot mutation');
    const plantError = plant.error?.message ?? 'missing plant fault message';
    const fertilizeError = fertilize.error?.message ?? 'missing fertilize fault message';
    await Promise.all([
      recordFailureAudit('plant', 'plant-fault', plantError),
      recordFailureAudit('plant', 'plant-fault', plantError),
      recordFailureAudit('fertilize', 'fertilize-fault', fertilizeError),
      recordFailureAudit('fertilize', 'fertilize-fault', fertilizeError),
    ]);
    expect(await inventory(seedItemId)).toBe(1);
    expect(await inventory(fertilizerItemId)).toBe(1);
    expect(await auditCount('plant-fault')).toBe(1);
    expect(await auditCount('fertilize-fault')).toBe(1);

    const { data: failureAudits } = await supa
      .from('audit_logs')
      .select('action,success,error_message,occurrence_key')
      .eq('guild_id', guildId)
      .in('correlation_id', ['plant-fault', 'fertilize-fault']);
    expect(failureAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'farming.plant', success: false,
        occurrence_key: 'farming.plant:plant-fault',
      }),
      expect.objectContaining({
        action: 'farming.fertilize', success: false,
        occurrence_key: 'farming.fertilize:fertilize-fault',
      }),
    ]));
  });
});
