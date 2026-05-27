/**
 * Integration test: Commerce fulfillment — order lifecycle.
 *
 * V7 Audit §13.4: Tests the end-to-end flow from order creation through
 * payment capture, entitlement granting, and fulfillment queue insertion.
 * Covers: order → payment → customer totals → license key → action queue.
 *
 * NOTE: This doesn't call real PayPal APIs — it simulates the database-side
 * operations that handlePaymentCaptured() performs, then verifies each step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import { createHash, randomBytes } from 'node:crypto';

let supa!: SupabaseClient;
// guild.id is TEXT (Discord snowflake), commerce tables use UUID with defaults
const GUILD_ID = `test-commerce-${Date.now()}`;
const DISCORD_ID = '999888777666555444';

// These will be set by the seed inserts (DB generates UUIDs)
let customerId: string;
let productId: string;

beforeAll(async () => {
  supa = await requireSupabase();

  // Seed guild
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Commerce Test Guild',
    owner_discord_id: '123456789',
  });

  // Seed customer (let DB generate UUID)
  const { data: customer } = await supa.from('customers').insert({
    guild_id: GUILD_ID,
    discord_id: DISCORD_ID,
    discord_username: 'test-buyer',
    total_spent_cents: 0,
  }).select('id').single();
  customerId = customer!.id;

  // Seed product (let DB generate UUID)
  const { data: product } = await supa.from('products').insert({
    guild_id: GUILD_ID,
    name: 'Test Digital Product',
    type: 'one_time',
    delivery_type: 'access_pass',
    price_cents: 999,
    currency: 'USD',
    active: true,
    granted_role_ids: ['role-123'],
    granted_channel_ids: [],
  }).select('id').single();
  productId = product!.id;
});

afterAll(async () => {
  // Clean up in dependency order
  await supa.from('bot_action_queue').delete().eq('guild_id', GUILD_ID);
  await supa.from('license_keys').delete().eq('guild_id', GUILD_ID);
  await supa.from('payments').delete().eq('guild_id', GUILD_ID);
  await supa.from('orders').delete().eq('guild_id', GUILD_ID);
  await supa.from('products').delete().eq('id', productId);
  await supa.from('customers').delete().eq('id', customerId);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Commerce fulfillment lifecycle', () => {
  let orderId: string;
  const orderNumber = `ORD-TEST-${Date.now().toString(36).toUpperCase()}`;

  it('creates a pending order', async () => {
    const { data, error } = await supa
      .from('orders')
      .insert({
        order_number: orderNumber,
        customer_id: customerId,
        guild_id: GUILD_ID,
        product_id: productId,
        amount_cents: 999,
        currency: 'USD',
        status: 'pending',
        source: 'purchase',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.status).toBe('pending');
    expect(data!.amount_cents).toBe(999);
    orderId = data!.id;
  });

  it('marks the order as completed (simulating PAYMENT.CAPTURE.COMPLETED)', async () => {
    const { error } = await supa
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', orderId);

    expect(error).toBeNull();

    const { data } = await supa.from('orders').select('*').eq('id', orderId).single();
    expect(data!.status).toBe('completed');
  });

  it('creates a payment record', async () => {
    const captureId = `PAYPAL-CAPTURE-${randomBytes(8).toString('hex')}`;

    const { data, error } = await supa
      .from('payments')
      .insert({
        order_id: orderId,
        customer_id: customerId,
        guild_id: GUILD_ID,
        paypal_payment_id: captureId,
        amount_cents: 999,
        currency: 'USD',
        status: 'completed',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.amount_cents).toBe(999);
    expect(data!.status).toBe('completed');
  });

  it('updates customer total_spent_cents after payment', async () => {
    // In production, increment_customer_totals RPC handles this atomically.
    // Here we simulate the same outcome with a direct update to verify the
    // schema allows tracking cumulative spend per customer.
    const { error: updateErr } = await supa
      .from('customers')
      .update({ total_spent_cents: 999 })
      .eq('id', customerId);

    expect(updateErr).toBeNull();

    const { data } = await supa
      .from('customers')
      .select('total_spent_cents')
      .eq('id', customerId)
      .single();
    expect(data!.total_spent_cents).toBe(999);
  });

  it('generates and stores a license key', async () => {
    // Simulate key generation (same logic as webhook route)
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(16);
    const groups: string[] = [];
    for (let g = 0; g < 4; g++) {
      let group = '';
      for (let i = 0; i < 4; i++) {
        group += charset[bytes[g * 4 + i]! % charset.length];
      }
      groups.push(group);
    }
    const plaintext = `SMNI-${groups.join('-')}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');

    const { data, error } = await supa
      .from('license_keys')
      .insert({
        order_id: orderId,
        customer_id: customerId,
        product_id: productId,
        guild_id: GUILD_ID,
        key_hash: hash,
        key_prefix: 'SMNI',
        key_suffix: groups[3]!,
        bound_discord_id: DISCORD_ID,
        status: 'pending_activation',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.key_hash).toBe(hash);
    expect(data!.status).toBe('pending_activation');

    // Verify the key can be looked up by hash
    const { data: lookup } = await supa
      .from('license_keys')
      .select('*')
      .eq('key_hash', hash)
      .single();
    expect(lookup).not.toBeNull();
    expect(lookup!.order_id).toBe(orderId);
  });

  it('queues a fulfillment action for the bot', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'fulfill_purchase',
        action_type: 'fulfill_purchase',
        payload: {
          fulfillment_type: 'one_time_purchase',
          guild_id: GUILD_ID,
          customer_id: customerId,
          discord_id: DISCORD_ID,
          product_id: productId,
          product_name: 'Test Digital Product',
          order_id: orderId,
          order_number: orderNumber,
          amount_cents: 999,
          currency: 'USD',
          granted_role_ids: ['role-123'],
          granted_channel_ids: [],
          entitlement_type: 'one_time',
        },
        status: 'pending',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.action).toBe('fulfill_purchase');
    expect(data!.status).toBe('pending');

    // Verify the payload is intact
    const payload = data!.payload as Record<string, unknown>;
    expect(payload.discord_id).toBe(DISCORD_ID);
    expect(payload.product_name).toBe('Test Digital Product');
    expect(payload.granted_role_ids).toEqual(['role-123']);
  });

  it('verifies the full chain: order → payment → customer → key → queue', async () => {
    // Cross-reference: order is completed
    const { data: order } = await supa.from('orders').select('*').eq('id', orderId).single();
    expect(order!.status).toBe('completed');

    // Payment exists for the order
    const { data: payments } = await supa.from('payments').select('*').eq('order_id', orderId).limit(1000);
    expect(payments!.length).toBe(1);
    expect(payments![0]!.amount_cents).toBe(999);

    // Customer totals incremented
    const { data: customer } = await supa.from('customers').select('*').eq('id', customerId).single();
    expect(customer!.total_spent_cents).toBe(999);

    // License key linked to order
    const { data: keys } = await supa.from('license_keys').select('*').eq('order_id', orderId).limit(1000);
    expect(keys!.length).toBe(1);

    // Fulfillment action queued
    const { data: actions } = await supa
      .from('bot_action_queue')
      .select('*')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'fulfill_purchase')
      .limit(1000);
    expect(actions!.length).toBeGreaterThanOrEqual(1);
  });
});
