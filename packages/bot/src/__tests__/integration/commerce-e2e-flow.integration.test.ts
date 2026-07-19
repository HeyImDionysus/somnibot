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
import postgres from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';
import { createHash, randomBytes } from 'node:crypto';

let supa!: SupabaseClient;
const GUILD_ID = `test-e2e-${Date.now()}`;
const BUYER_DISCORD_ID = '111222333444555666';
const GRANTED_ROLE_ID = '111222333444555667';
const GRANTED_CHANNEL_ID = '111222333444555668';

// DB-generated UUIDs
let customerId: string;
let productId: string;
let orderId: string;
let paymentId: string;
let entitlementId: string;
let licenseKeyId: string;
let keyHash: string;
const captureId = `PAYPAL-CAP-${randomBytes(8).toString('hex')}`;
const paypalOrderId = `PAYPAL-ORDER-${randomBytes(8).toString('hex')}`;
const refundId = `PAYPAL-REFUND-${randomBytes(8).toString('hex')}`;
const orderNumber = `ORD-E2E-${Date.now().toString(36).toUpperCase()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  // Seed guild
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'E2E Commerce Test Guild',
    owner_discord_id: '000000000000000001',
  });

  // Seed customer — both counters start at 0
  const { data: customer, error: custErr } = await supa.from('customers').insert({
    guild_id: GUILD_ID,
    discord_id: BUYER_DISCORD_ID,
    discord_username: 'e2e-buyer',
    total_spent_cents: 0,
    total_orders: 0,
  }).select('id').single();
  if (custErr) throw new Error(`Customer seed failed: ${custErr.message}`);
  customerId = customer!.id;

  // Seed product — license_key delivery type (the flow generates keys)
  const { data: product, error: prodErr } = await supa.from('products').insert({
    guild_id: GUILD_ID,
    name: 'E2E Test Product',
    type: 'one_time',
    delivery_type: 'license_key',
    price_cents: 1499,
    currency: 'USD',
    active: true,
    granted_role_ids: [GRANTED_ROLE_ID],
    granted_channel_ids: [GRANTED_CHANNEL_ID],
  }).select('id').single();
  if (prodErr) throw new Error(`Product seed failed: ${prodErr.message}`);
  productId = product!.id;
});

afterAll(async () => {
  // Clean up in reverse-dependency order. audit_logs rows are immutable by
  // design (delete-protection trigger) and are intentionally left in place.
  await supa.from('bot_action_queue').delete().eq('guild_id', GUILD_ID);
  await supa.from('alerts').delete().eq('guild_id', GUILD_ID);
  await supa.from('entitlements').delete().eq('guild_id', GUILD_ID);
  await supa.from('license_keys').delete().eq('guild_id', GUILD_ID);
  const retentionOwner = postgres(getTestDbUrl(), { max: 1 });
  try {
    await retentionOwner`
      DELETE FROM public.payment_refunds WHERE guild_id = ${GUILD_ID}
    `;
  } finally {
    await retentionOwner.end({ timeout: 5 });
  }
  await supa.from('payments').delete().eq('guild_id', GUILD_ID);
  await supa.from('orders').delete().eq('guild_id', GUILD_ID);
  await supa.from('products').delete().eq('id', productId);
  await supa.from('customers').delete().eq('id', customerId);
  // The guild row stays behind deliberately: this run's immutable audit_logs
  // rows FK-reference it. GUILD_ID is unique per run, so reruns are safe.
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
      paypal_order_id: paypalOrderId,
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
    const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_product_id: productId,
    });
    expect(freeze.error).toBeNull();
    const capture = await supa.rpc('commerce_finalize_paypal_capture', {
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 1499,
      p_currency: 'USD',
    });
    expect(capture.error).toBeNull();
    const { data: payment, error } = await supa.from('payments')
      .select('id,status,paypal_resource_type')
      .eq('paypal_payment_id', captureId)
      .single();
    expect(error).toBeNull();
    expect(payment).toMatchObject({ status: 'completed', paypal_resource_type: 'capture' });
    paymentId = payment!.id;
  });

  it('Step 3: verifies the capture atomically completed its order', async () => {
    const { data, error } = await supa.from('orders')
      .select('status')
      .eq('id', orderId)
      .single();
    expect(error).toBeNull();
    expect(data!.status).toBe('completed');
  });

  it('Step 4: verifies capture finalization updated customer totals once', async () => {
    const { data: customer } = await supa.from('customers')
      .select('total_spent_cents, total_orders, first_purchase_at')
      .eq('id', customerId).single();
    expect(customer!.total_spent_cents).toBe(1499);
    expect(customer!.total_orders).toBe(1);
    expect(customer!.first_purchase_at).not.toBeNull();
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
      // Snapshots must be snowflake-shaped Discord ids (canonical-snapshot
      // contract); fake strings like 'role-e2e-premium' are not valid ids.
      granted_role_ids: [GRANTED_ROLE_ID],
      granted_channel_ids: [GRANTED_CHANNEL_ID],
    }).select().single();

    expect(error).toBeNull();
    expect(data!.status).toBe('active');
    entitlementId = data!.id;
  });

  it('Step 7: queues a fulfillment action for the bot', async () => {
    const { data, error } = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'fulfill_purchase',
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
        granted_role_ids: [GRANTED_ROLE_ID],
        granted_channel_ids: [GRANTED_CHANNEL_ID],
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

    // Customer totals match (both spend and order count)
    const { data: customer } = await supa.from('customers').select('*').eq('id', customerId).single();
    expect(customer!.total_spent_cents).toBe(1499);
    expect(customer!.total_orders).toBe(1);

    // Entitlement active, linked to all the right things
    const { data: ent } = await supa.from('entitlements').select('*').eq('id', entitlementId).single();
    expect(ent!.status).toBe('active');
    expect(ent!.order_id).toBe(orderId);
    expect(ent!.license_key_id).toBe(licenseKeyId);
    expect(ent!.product_id).toBe(productId);
    expect(ent!.granted_role_ids).toEqual([GRANTED_ROLE_ID]);

    // License key active
    const { data: key } = await supa.from('license_keys').select('*').eq('id', licenseKeyId).single();
    expect(key!.status).toBe('active');
    expect(key!.key_hash).toBe(keyHash);

    // Product uses the license_key delivery type
    const { data: prod } = await supa.from('products').select('delivery_type').eq('id', productId).single();
    expect(prod!.delivery_type).toBe('license_key');

    // Fulfillment action in queue
    const { data: actions } = await supa.from('bot_action_queue').select('*')
      .eq('guild_id', GUILD_ID).eq('action', 'fulfill_purchase').limit(100);
    expect(actions!.length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────
  // Phase 2: Refund
  // ────────────────────────────────────────────────────────────

  it('Step 9: durably records the full PayPal refund', async () => {
    const recorded = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: paymentId,
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_paypal_payment_id: captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1499,
      p_currency: 'USD',
      p_audit_details: { test_flow: 'commerce-e2e' },
    });
    expect(recorded.error).toBeNull();
    expect(recorded.data).toMatchObject({
      refund_amount_cents: 1499,
      cumulative_refunded_cents: 1499,
      full_refund: true,
      already_recorded: false,
    });
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
      payload: {
        discord_id: BUYER_DISCORD_ID,
        role_ids: [GRANTED_ROLE_ID],
        reason: 'refunded',
        order_id: orderId,
      },
      status: 'pending',
    }).select().single();

    expect(error).toBeNull();
    expect(data!.action).toBe('revoke_roles');
  });

  it('Step 13: atomically commits the refund audit and payment/order terminal marker', async () => {
    const finalized = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: paymentId,
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_paypal_payment_id: captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: {
        refund_amount_cents: 1499,
        cumulative_refunded_cents: 1499,
      },
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_status: 'refunded',
      payment_status: 'refunded',
      already_terminal: false,
      audit_recorded: true,
    });
  });

  it('Step 14: verifies full refund chain consistency', async () => {
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
    expect(payload.role_ids).toEqual([GRANTED_ROLE_ID]);

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
