/**
 * Integration test: Full end-to-end commerce flow.
 *
 * V8 Audit §13.P3b — Tests the complete purchase → refund lifecycle:
 *
 *   PayPal webhook (simulated)
 *     → order created
 *       → payment recorded
 *         → customer totals incremented (RPC)
 *           → entitlement granted
 *             → license key generated
 *               → fulfillment action queued
 *
 *   Then the refund path:
 *
 *   PayPal refund webhook (simulated)
 *     → payment marked refunded
 *       → order marked refunded
 *         → entitlement expired
 *           → license key revoked
 *             → role-revocation action queued
 *
 * Unlike commerce-fulfillment.integration.test.ts which tests individual
 * steps in isolation, this test exercises the full chain as a single flow,
 * verifying cross-table consistency after each major step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';
import { createHash, randomBytes } from 'node:crypto';

let supa!: SupabaseClient;
const GUILD_ID = `test-e2e-${Date.now()}`;
const BUYER_DISCORD_ID = '111222333444555666';

// DB-generated UUIDs
let customerId: string;
let productId: string;
let orderId: string;
let paymentId: string;
let entitlementId: string;
let licenseKeyId: string;
let keyHash: string;
const captureId = `PAYPAL-CAP-${randomBytes(8).toString('hex')}`;
const orderNumber = `ORD-E2E-${Date.now().toString(36).toUpperCase()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  // Seed guild
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'E2E Commerce Test Guild',
    owner_discord_id: '000000000000000001',
  });

  // Seed customer
  const { data: customer } = await supa.from('customers').insert({
    guild_id: GUILD_ID,
    discord_id: BUYER_DISCORD_ID,
    discord_username: 'e2e-buyer',
    total_spent_cents: 0,
    total_orders: 0,
  }).select('id').single();
  customerId = customer!.id;

  // Seed product (one-time digital with role grant + license key delivery)
  const { data: product } = await supa.from('products').insert({
    guild_id: GUILD_ID,
    name: 'E2E Test Product',
    type: 'one_time',
    delivery_type: 'license_key',
    price_cents: 1499,
    currency: 'USD',
    active: true,
    granted_role_ids: ['role-e2e-premium'],
    granted_channel_ids: ['chan-e2e-vip'],
  }).select('id').single();
  productId = product!.id;
});

afterAll(async () => {
  // Clean up in reverse-dependency order
  await supa.from('bot_action_queue').delete().eq('guild_id', GUILD_ID);
  await supa.from('entitlements').delete().eq('guild_id', GUILD_ID);
  await supa.from('license_keys').delete().eq('guild_id', GUILD_ID);
  await supa.from('payments').delete().eq('guild_id', GUILD_ID);
  await supa.from('orders').delete().eq('guild_id', GUILD_ID);
  await supa.from('products').delete().eq('id', productId);
  await supa.from('customers').delete().eq('id', customerId);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('E2E commerce flow: purchase → fulfillment → refund', () => {
  // ────────────────────────────────────────────────────────────
  // Phase 1: Purchase
  // ────────────────────────────────────────────────────────────

  it('Step 1: creates a pending order (checkout initiated)', async () => {
    const { data, error } = await supa.from('orders').insert({
      order_number: orderNumber,
      customer_id: customerId,
      guild_id: GUILD_ID,
      product_id: productId,
      amount_cents: 1499,
      currency: 'USD',
      status: 'pending',
      source: 'purchase',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.status).toBe('pending');
    orderId = data!.id;
  });

  it('Step 2: records the PayPal payment capture', async () => {
    const { data, error } = await supa.from('payments').insert({
      order_id: orderId,
      customer_id: customerId,
      guild_id: GUILD_ID,
      paypal_payment_id: captureId,
      amount_cents: 1499,
      currency: 'USD',
      status: 'completed',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.status).toBe('completed');
    paymentId = data!.id;
  });

  it('Step 3: marks the order as completed', async () => {
    const { error } = await supa.from('orders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', orderId);

    expect(error).toBeNull();
  });

  it('Step 4: increments customer totals via RPC', async () => {
    const { error } = await supa.rpc('increment_customer_totals', {
      p_customer_id: customerId,
      p_amount_cents: 1499,
    });

    expect(error).toBeNull();

    const { data: customer } = await supa.from('customers')
      .select('total_spent_cents, total_orders')
      .eq('id', customerId).single();
    expect(customer!.total_spent_cents).toBe(1499);
    expect(customer!.total_orders).toBe(1);
  });

  it('Step 5: generates a license key (hash-only storage)', async () => {
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
    keyHash = createHash('sha256').update(plaintext).digest('hex');

    const { data, error } = await supa.from('license_keys').insert({
      order_id: orderId,
      customer_id: customerId,
      product_id: productId,
      guild_id: GUILD_ID,
      key_hash: keyHash,
      key_prefix: 'SMNI',
      key_suffix: groups[3]!,
      bound_discord_id: BUYER_DISCORD_ID,
      status: 'active',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.key_hash).toBe(keyHash);
    expect(data!.status).toBe('active');
    licenseKeyId = data!.id;
  });

  it('Step 6: creates an active entitlement', async () => {
    const { data, error } = await supa.from('entitlements').insert({
      customer_id: customerId,
      guild_id: GUILD_ID,
      product_id: productId,
      order_id: orderId,
      license_key_id: licenseKeyId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
      granted_role_ids: ['role-e2e-premium'],
      granted_channel_ids: ['chan-e2e-vip'],
    }).select().single();

    expect(error).toBeNull();
    expect(data!.status).toBe('active');
    entitlementId = data!.id;
  });

  it('Step 7: queues a fulfillment action for the bot', async () => {
    const { data, error } = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'fulfill_purchase',
      action_type: 'fulfill_purchase',
      payload: {
        fulfillment_type: 'one_time_purchase',
        guild_id: GUILD_ID,
        customer_id: customerId,
        discord_id: BUYER_DISCORD_ID,
        product_id: productId,
        product_name: 'E2E Test Product',
        order_id: orderId,
        order_number: orderNumber,
        amount_cents: 1499,
        currency: 'USD',
        granted_role_ids: ['role-e2e-premium'],
        granted_channel_ids: ['chan-e2e-vip'],
        entitlement_type: 'one_time',
        license_key_id: licenseKeyId,
      },
      status: 'pending',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.action).toBe('fulfill_purchase');
  });

  it('Step 8: verifies full purchase chain consistency', async () => {
    // Order completed
    const { data: order } = await supa.from('orders').select('*').eq('id', orderId).single();
    expect(order!.status).toBe('completed');
    expect(order!.amount_cents).toBe(1499);

    // Payment recorded
    const { data: payment } = await supa.from('payments').select('*').eq('id', paymentId).single();
    expect(payment!.status).toBe('completed');
    expect(payment!.paypal_payment_id).toBe(captureId);

    // Customer totals match
    const { data: customer } = await supa.from('customers').select('*').eq('id', customerId).single();
    expect(customer!.total_spent_cents).toBe(1499);

    // Entitlement active, linked to all the right things
    const { data: ent } = await supa.from('entitlements').select('*').eq('id', entitlementId).single();
    expect(ent!.status).toBe('active');
    expect(ent!.order_id).toBe(orderId);
    expect(ent!.license_key_id).toBe(licenseKeyId);
    expect(ent!.product_id).toBe(productId);
    expect(ent!.granted_role_ids).toEqual(['role-e2e-premium']);

    // License key active
    const { data: key } = await supa.from('license_keys').select('*').eq('id', licenseKeyId).single();
    expect(key!.status).toBe('active');
    expect(key!.key_hash).toBe(keyHash);

    // Fulfillment action in queue
    const { data: actions } = await supa.from('bot_action_queue').select('*')
      .eq('guild_id', GUILD_ID).eq('action', 'fulfill_purchase').limit(100);
    expect(actions!.length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────
  // Phase 2: Refund
  // ────────────────────────────────────────────────────────────

  it('Step 9: processes a refund — payment + order marked refunded', async () => {
    // Mark payment refunded
    const { error: payErr } = await supa.from('payments')
      .update({ status: 'refunded' })
      .eq('id', paymentId);
    expect(payErr).toBeNull();

    // Mark order refunded
    const { error: ordErr } = await supa.from('orders')
      .update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('id', orderId);
    expect(ordErr).toBeNull();
  });

  it('Step 10: expires the entitlement', async () => {
    const { error } = await supa.from('entitlements').update({
      status: 'expired',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', entitlementId);

    expect(error).toBeNull();
  });

  it('Step 11: revokes the license key', async () => {
    const { error } = await supa.from('license_keys').update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revocation_reason: 'refunded',
      updated_at: new Date().toISOString(),
    }).eq('id', licenseKeyId);

    expect(error).toBeNull();
  });

  it('Step 12: queues role revocation for the bot', async () => {
    const { data, error } = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      action_type: 'revoke_roles',
      payload: {
        discord_id: BUYER_DISCORD_ID,
        role_ids: ['role-e2e-premium'],
        reason: 'refunded',
        order_id: orderId,
      },
      status: 'pending',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.action).toBe('revoke_roles');
  });

  it('Step 13: verifies full refund chain consistency', async () => {
    // Order refunded
    const { data: order } = await supa.from('orders').select('*').eq('id', orderId).single();
    expect(order!.status).toBe('refunded');

    // Payment refunded
    const { data: payment } = await supa.from('payments').select('*').eq('id', paymentId).single();
    expect(payment!.status).toBe('refunded');

    // Entitlement expired
    const { data: ent } = await supa.from('entitlements').select('*').eq('id', entitlementId).single();
    expect(ent!.status).toBe('expired');
    expect(ent!.cancelled_at).not.toBeNull();

    // License key revoked
    const { data: key } = await supa.from('license_keys').select('*').eq('id', licenseKeyId).single();
    expect(key!.status).toBe('revoked');
    expect(key!.revocation_reason).toBe('refunded');

    // Revoke-roles action queued
    const { data: revokeActions } = await supa.from('bot_action_queue').select('*')
      .eq('guild_id', GUILD_ID).eq('action', 'revoke_roles').limit(100);
    expect(revokeActions!.length).toBeGreaterThanOrEqual(1);
    const payload = revokeActions![0]!.payload as Record<string, unknown>;
    expect(payload.discord_id).toBe(BUYER_DISCORD_ID);
    expect(payload.role_ids).toEqual(['role-e2e-premium']);

    // No active entitlements remain
    const { data: activeEnts } = await supa.from('entitlements').select('id')
      .eq('guild_id', GUILD_ID).in('status', ['active', 'pending', 'grace_period']).limit(100);
    expect(activeEnts!.length).toBe(0);

    // No active license keys remain
    const { data: activeKeys } = await supa.from('license_keys').select('id')
      .eq('guild_id', GUILD_ID).eq('status', 'active').limit(100);
    expect(activeKeys!.length).toBe(0);
  });
});
