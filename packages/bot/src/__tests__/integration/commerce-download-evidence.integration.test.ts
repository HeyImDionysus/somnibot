import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const guildId = `test-download-evidence-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();
  const seeded = await supa.from('guild').insert({
    id: guildId,
    name: 'Commerce download evidence integration test',
    owner_discord_id: '12345678901234567',
  });
  if (seeded.error) throw new Error(`Guild seed failed: ${seeded.error.message}`);
});

afterAll(async () => {
  if (supa) await supa.from('guild').delete().eq('id', guildId);
});

describe('commerce download evidence retention', () => {
  it('preserves delivery proof and its filename snapshot after the source file is deleted', async () => {
    const product = await supa.from('products').insert({
      guild_id: guildId,
      name: 'Evidence product',
      type: 'one_time',
      delivery_type: 'file',
      price_cents: 100,
      currency: 'USD',
    }).select('id').single();
    expect(product.error).toBeNull();

    const customer = await supa.from('customers').insert({
      guild_id: guildId,
      discord_id: '12345678901234568',
      discord_username: 'EvidenceCustomer',
    }).select('id').single();
    expect(customer.error).toBeNull();

    const file = await supa.from('product_files').insert({
      guild_id: guildId,
      product_id: product.data!.id,
      name: 'somnibot.zip',
      file_name: 'somnibot.zip',
    }).select('id').single();
    expect(file.error).toBeNull();

    const delivery = await supa.from('commerce_download_deliveries').insert({
      guild_id: guildId,
      customer_id: customer.data!.id,
      product_id: product.data!.id,
      file_id: file.data!.id,
      file_name_snapshot: 'somnibot.zip',
    }).select('id').single();
    expect(delivery.error).toBeNull();

    const removed = await supa.from('product_files').delete().eq('id', file.data!.id);
    expect(removed.error).toBeNull();

    const retained = await supa
      .from('commerce_download_deliveries')
      .select('file_id,file_name_snapshot')
      .eq('id', delivery.data!.id)
      .single();
    expect(retained.error).toBeNull();
    expect(retained.data).toEqual({
      file_id: null,
      file_name_snapshot: 'somnibot.zip',
    });
  });

  it('returns at most the newest delivery row for each sampled order', async () => {
    const product = await supa.from('products').insert({
      guild_id: guildId,
      name: 'Bounded evidence product',
      type: 'one_time',
      delivery_type: 'file',
      price_cents: 100,
      currency: 'USD',
    }).select('id').single();
    expect(product.error).toBeNull();

    const customer = await supa.from('customers').insert({
      guild_id: guildId,
      discord_id: '12345678901234569',
      discord_username: 'BoundedEvidenceCustomer',
    }).select('id').single();
    expect(customer.error).toBeNull();

    const order = await supa.from('orders').insert({
      order_number: `ORD-DOWNLOAD-${Date.now()}`,
      customer_id: customer.data!.id,
      guild_id: guildId,
      product_id: product.data!.id,
      amount_cents: 100,
      currency: 'USD',
      source: 'purchase',
      status: 'completed',
    }).select('id').single();
    expect(order.error).toBeNull();

    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    const deliveries = await supa.from('commerce_download_deliveries').insert([
      {
        guild_id: guildId,
        customer_id: customer.data!.id,
        product_id: product.data!.id,
        order_id: order.data!.id,
        delivered_at: older,
      },
      {
        guild_id: guildId,
        customer_id: customer.data!.id,
        product_id: product.data!.id,
        order_id: order.data!.id,
        delivered_at: newer,
      },
    ]);
    expect(deliveries.error).toBeNull();

    const latest = await supa.rpc('get_latest_commerce_download_deliveries', {
      p_guild_id: guildId,
      p_order_ids: [order.data!.id],
    });
    expect(latest.error).toBeNull();
    expect(latest.data).toHaveLength(1);
    expect(latest.data?.[0]?.order_id).toBe(order.data!.id);
    expect(Date.parse(latest.data?.[0]?.delivered_at)).toBe(Date.parse(newer));
  });
});
