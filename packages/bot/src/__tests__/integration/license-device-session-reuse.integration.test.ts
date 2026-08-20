/**
 * Integration tests for the real `license_validate_device` RPC.
 *
 * An inactive device row is normally recoverable: reinstall cleanup,
 * heartbeat expiry, entitlement recovery, and seat eviction all reuse the
 * existing row. `admin_revoked` is different. It is a durable per-fingerprint
 * owner action and must remain terminal until an owner explicitly changes the
 * row. These tests run the shipped migration against real Postgres so a route
 * mock cannot accidentally "prove" SQL behavior it never executes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import {
  getAnonTestClient,
  getAuthenticatedTestClient,
  getTestDbUrl,
  requireSupabase,
} from './helpers.js';

let supa!: SupabaseClient;
let anon!: SupabaseClient;
let authenticated!: SupabaseClient;
let sql!: Sql;

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const guildId = `test-license-session-${runId}`;
const discordId = `license-session-${runId}`;

let customerId: string;
let productId: string;
let orderId: string;
let licenseKeyId: string;

const RECOVERABLE_REASONS = [
  'device_limit',
  'heartbeat_timeout',
  'user_deactivated',
  'entitlement_revoked',
] as const;

const POLICIES = ['evict_oldest', 'reject'] as const;

beforeAll(async () => {
  supa = await requireSupabase();
  anon = getAnonTestClient();
  authenticated = getAuthenticatedTestClient();
  sql = postgres(getTestDbUrl(), { max: 2 });

  const guild = await supa.from('guild').insert({
    id: guildId,
    name: 'Licence session reuse integration test',
    owner_discord_id: '111222333444555666',
  });
  if (guild.error) throw new Error(`Guild seed failed: ${guild.error.message}`);

  const customer = await supa.from('customers').insert({
    guild_id: guildId,
    discord_id: discordId,
    discord_username: 'session-reuse-test',
  }).select('id').single();
  if (customer.error) throw new Error(`Customer seed failed: ${customer.error.message}`);
  customerId = customer.data.id;

  const product = await supa.from('products').insert({
    guild_id: guildId,
    name: 'Session reuse test product',
    type: 'one_time',
    delivery_type: 'license_key',
    price_cents: 100,
    currency: 'USD',
    active: true,
  }).select('id').single();
  if (product.error) throw new Error(`Product seed failed: ${product.error.message}`);
  productId = product.data.id;

  const order = await supa.from('orders').insert({
    order_number: `ORD-SESSION-${runId}`,
    customer_id: customerId,
    guild_id: guildId,
    product_id: productId,
    amount_cents: 100,
    currency: 'USD',
    source: 'purchase',
    status: 'completed',
  }).select('id').single();
  if (order.error) throw new Error(`Order seed failed: ${order.error.message}`);
  orderId = order.data.id;

  const key = await supa.from('license_keys').insert({
    order_id: orderId,
    customer_id: customerId,
    product_id: productId,
    guild_id: guildId,
    key_hash: `session-reuse-${runId}`,
    key_prefix: 'SMNI',
    key_suffix: runId.slice(-4).toUpperCase(),
    bound_discord_id: discordId,
    status: 'active',
  }).select('id').single();
  if (key.error) throw new Error(`Licence-key seed failed: ${key.error.message}`);
  licenseKeyId = key.data.id;
});

beforeEach(async () => {
  const restored = await supa.from('license_keys').update({ status: 'active' }).eq('id', licenseKeyId);
  if (restored.error) throw new Error(`Licence-key reset failed: ${restored.error.message}`);
  const cleared = await supa.from('license_sessions').delete().eq('license_key_id', licenseKeyId);
  if (cleared.error) throw new Error(`Session cleanup failed: ${cleared.error.message}`);
});

afterAll(async () => {
  if (supa && licenseKeyId) await supa.from('license_sessions').delete().eq('license_key_id', licenseKeyId);
  if (supa && licenseKeyId) await supa.from('license_keys').delete().eq('id', licenseKeyId);
  if (supa && orderId) await supa.from('orders').delete().eq('id', orderId);
  if (supa && productId) await supa.from('products').delete().eq('id', productId);
  if (supa && customerId) await supa.from('customers').delete().eq('id', customerId);
  if (supa) await supa.from('guild').delete().eq('id', guildId);
  if (sql) await sql.end({ timeout: 5 });
});

async function seedSession(
  fingerprint: string,
  options: {
    active?: boolean;
    reason?: typeof RECOVERABLE_REASONS[number] | 'admin_revoked' | null;
    lastSeenOffsetMinutes?: number;
  } = {},
): Promise<string> {
  const active = options.active ?? true;
  const timestamp = new Date(Date.now() - (options.lastSeenOffsetMinutes ?? 0) * 60_000).toISOString();
  const inserted = await supa.from('license_sessions').insert({
    license_key_id: licenseKeyId,
    device_fingerprint: fingerprint,
    device_name: `${fingerprint}-name`,
    app_version: '1.0.0',
    ip_address: '203.0.113.10',
    active,
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    deactivated_at: active ? null : timestamp,
    deactivation_reason: active ? null : (options.reason ?? 'device_limit'),
  }).select('id').single();
  if (inserted.error) throw new Error(`Session seed failed: ${inserted.error.message}`);
  return inserted.data.id;
}

async function validateDevice(
  fingerprint: string,
  policy: typeof POLICIES[number],
  maxDevices = 3,
) {
  return supa.rpc('license_validate_device', {
    p_license_key_id: licenseKeyId,
    p_device_fingerprint: fingerprint,
    p_device_name: `${fingerprint}-new-name`,
    p_app_version: '2.0.0',
    p_ip_address: '203.0.113.99',
    p_max_devices: maxDevices,
    p_device_policy: policy,
  });
}

async function validatePendingDevice(fingerprint: string) {
  return supa.rpc('license_validate_device_atomic', {
    p_license_key_id: licenseKeyId,
    p_product_id: productId,
    p_activate_pending: true,
    p_device_fingerprint: fingerprint,
    p_device_name: `${fingerprint}-new-name`,
    p_app_version: '2.0.0',
    p_ip_address: '203.0.113.99',
    p_max_devices: 3,
    p_device_policy: 'reject',
  });
}

async function deactivateDevice(sessionId: string, client: SupabaseClient = supa) {
  return client.rpc('license_deactivate_device', {
    p_license_key_id: licenseKeyId,
    p_session_id: sessionId,
  });
}

async function sessionSnapshot() {
  const rows = await supa.from('license_sessions')
    .select('id,license_key_id,device_fingerprint,device_name,app_version,ip_address,active,first_seen_at,last_seen_at,deactivated_at,deactivation_reason')
    .eq('license_key_id', licenseKeyId)
    .order('device_fingerprint');
  if (rows.error) throw new Error(`Session read failed: ${rows.error.message}`);
  return rows.data;
}

describe('license_validate_device session reuse', () => {
  it('activates a pending key in the same transaction that grants its first session', async () => {
    const pending = await supa.from('license_keys')
      .update({ status: 'pending_activation', activated_at: null })
      .eq('id', licenseKeyId);
    expect(pending.error).toBeNull();

    const result = await validatePendingDevice('first-project-device');

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'created',
      activated: true,
      active_devices: 1,
      session_id: expect.any(String),
    });
    const key = await supa.from('license_keys').select('status,activated_at').eq('id', licenseKeyId).single();
    expect(key.error).toBeNull();
    expect(key.data).toMatchObject({ status: 'active', activated_at: expect.any(String) });
    expect(await sessionSnapshot()).toEqual([
      expect.objectContaining({
        id: result.data.session_id,
        device_fingerprint: 'first-project-device',
        active: true,
      }),
    ]);
  });

  it('repairs a pending key that already has an active matching session', async () => {
    const sessionId = await seedSession('existing-first-project-device');
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        UPDATE public.license_keys
           SET status = 'pending_activation', activated_at = NULL
         WHERE id = ${licenseKeyId}::UUID
      `;
    });

    const result = await validatePendingDevice('existing-first-project-device');

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'existing',
      activated: true,
      active_devices: 1,
      session_id: sessionId,
    });
    const key = await supa.from('license_keys').select('status,activated_at').eq('id', licenseKeyId).single();
    expect(key.error).toBeNull();
    expect(key.data).toMatchObject({ status: 'active', activated_at: expect.any(String) });
    expect(await sessionSnapshot()).toEqual([
      expect.objectContaining({
        id: sessionId,
        device_fingerprint: 'existing-first-project-device',
        active: true,
      }),
    ]);
  });

  it('leaves a pending key unchanged when its device is administrator-revoked', async () => {
    const sessionId = await seedSession('revoked-first-project-device', {
      active: false,
      reason: 'admin_revoked',
    });
    const pending = await supa.from('license_keys')
      .update({ status: 'pending_activation', activated_at: null })
      .eq('id', licenseKeyId);
    expect(pending.error).toBeNull();

    const result = await validatePendingDevice('revoked-first-project-device');

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'session_invalidated',
      activated: false,
      session_id: null,
    });
    const key = await supa.from('license_keys').select('status,activated_at').eq('id', licenseKeyId).single();
    expect(key.error).toBeNull();
    expect(key.data).toEqual({ status: 'pending_activation', activated_at: null });
    expect(await sessionSnapshot()).toEqual([
      expect.objectContaining({
        id: sessionId,
        active: false,
        deactivation_reason: 'admin_revoked',
      }),
    ]);
  });

  it.each(POLICIES)(
    'preserves an administrator-revoked fingerprint under the %s policy without evicting another seat',
    async (policy) => {
      await seedSession('revoked-device', {
        active: false,
        reason: 'admin_revoked',
        lastSeenOffsetMinutes: 60,
      });
      await seedSession('active-a', { lastSeenOffsetMinutes: 30 });
      await seedSession('active-b', { lastSeenOffsetMinutes: 20 });
      await seedSession('active-c', { lastSeenOffsetMinutes: 10 });
      const before = await sessionSnapshot();

      const result = await validateDevice('revoked-device', policy);

      expect(result.error).toBeNull();
      expect(result.data).toMatchObject({
        status: 'session_invalidated',
        session_id: null,
        deactivation_reason: 'admin_revoked',
        active_devices: 3,
        max_devices: 3,
        evicted: false,
      });
      expect(await sessionSnapshot()).toEqual(before);
    },
  );

  it.each(RECOVERABLE_REASONS)(
    'reuses the same row after the recoverable %s reason',
    async (reason) => {
      const originalId = await seedSession('returning-device', {
        active: false,
        reason,
        lastSeenOffsetMinutes: 30,
      });
      await seedSession('active-device');

      const result = await validateDevice('returning-device', 'evict_oldest');

      expect(result.error).toBeNull();
      expect(result.data).toMatchObject({
        status: 'reactivated',
        session_id: originalId,
        active_devices: 2,
        max_devices: 3,
        evicted: false,
      });
      const row = (await sessionSnapshot()).find((session) => session.id === originalId);
      expect(row).toMatchObject({
        active: true,
        deactivated_at: null,
        deactivation_reason: null,
        device_name: 'returning-device-new-name',
        app_version: '2.0.0',
        ip_address: '203.0.113.99',
      });
    },
  );

  it('still applies the reject policy to a recoverable row claiming a full seat set', async () => {
    const returningId = await seedSession('returning-device', {
      active: false,
      reason: 'device_limit',
    });
    await seedSession('active-a');
    await seedSession('active-b');
    await seedSession('active-c');

    const result = await validateDevice('returning-device', 'reject');

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'over_device_limit',
      active_devices: 3,
      max_devices: 3,
      evicted: false,
    });
    const row = (await sessionSnapshot()).find((session) => session.id === returningId);
    expect(row).toMatchObject({
      active: false,
      deactivation_reason: 'device_limit',
    });
  });

  it('linearizes a concurrent administrator revoke ahead of validation', async () => {
    const sessionId = await seedSession('race-device');
    let releaseAdmin!: () => void;
    let adminUpdated!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAdmin = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      adminUpdated = resolve;
    });

    const adminTransaction = sql.begin(async (tx) => {
      await tx`
        UPDATE public.license_sessions
           SET active = false,
               deactivated_at = clock_timestamp(),
               deactivation_reason = 'admin_revoked'
         WHERE id = ${sessionId}::uuid
      `;
      adminUpdated();
      await release;
    });

    await updated;
    let validationSettled = false;
    const validation = validateDevice('race-device', 'evict_oldest')
      .then((result) => {
        validationSettled = true;
        return result;
      });

    // The RPC must wait on the session row lock rather than reading the stale
    // pre-revoke tuple and later overwriting the administrator's update.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(validationSettled).toBe(false);

    releaseAdmin();
    await adminTransaction;
    const result = await validation;

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'session_invalidated',
      session_id: null,
      deactivation_reason: 'admin_revoked',
      evicted: false,
    });
    expect((await sessionSnapshot())[0]).toMatchObject({
      id: sessionId,
      active: false,
      deactivation_reason: 'admin_revoked',
    });
  });

  it('keeps admin revocation terminal across the client-deactivate then validate sequence', async () => {
    const sessionId = await seedSession('admin-client-sequence');
    const revoked = await supa.from('license_sessions').update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'admin_revoked',
    }).eq('id', sessionId);
    expect(revoked.error).toBeNull();

    const clientDeactivate = await deactivateDevice(sessionId);
    expect(clientDeactivate.error).toBeNull();
    expect(clientDeactivate.data).toBe(false);

    const validation = await validateDevice('admin-client-sequence', 'evict_oldest');
    expect(validation.error).toBeNull();
    expect(validation.data).toMatchObject({
      status: 'session_invalidated',
      session_id: null,
      deactivation_reason: 'admin_revoked',
    });
    expect((await sessionSnapshot())[0]).toMatchObject({
      id: sessionId,
      active: false,
      deactivation_reason: 'admin_revoked',
    });
  });

  it('deactivates an active row exactly once and cannot touch a session under another key id', async () => {
    const sessionId = await seedSession('client-idempotence');

    const first = await deactivateDevice(sessionId);
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);
    const afterFirst = (await sessionSnapshot())[0];
    expect(afterFirst).toMatchObject({
      id: sessionId,
      active: false,
      deactivation_reason: 'user_deactivated',
    });

    const replay = await deactivateDevice(sessionId);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(false);
    expect((await sessionSnapshot())[0]).toEqual(afterFirst);

    const otherSessionId = await seedSession('wrong-key-guard');
    const wrongKey = await supa.rpc('license_deactivate_device', {
      p_license_key_id: productId,
      p_session_id: otherSessionId,
    });
    expect(wrongKey.error).toBeNull();
    expect(wrongKey.data).toBe(false);
    expect((await sessionSnapshot()).find((row) => row.id === otherSessionId)).toMatchObject({
      active: true,
      deactivation_reason: null,
    });
  });

  it('linearizes client deactivation behind an in-flight administrator revoke', async () => {
    const sessionId = await seedSession('admin-client-race');
    let releaseAdmin!: () => void;
    let adminUpdated!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAdmin = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      adminUpdated = resolve;
    });

    const adminTransaction = sql.begin(async (tx) => {
      await tx`
        UPDATE public.license_sessions
           SET active = false,
               deactivated_at = clock_timestamp(),
               deactivation_reason = 'admin_revoked'
         WHERE id = ${sessionId}::uuid
      `;
      adminUpdated();
      await release;
    });

    await updated;
    let deactivationSettled = false;
    const clientDeactivate = deactivateDevice(sessionId).then((result) => {
      deactivationSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deactivationSettled).toBe(false);

    releaseAdmin();
    await adminTransaction;
    const result = await clientDeactivate;

    expect(result.error).toBeNull();
    expect(result.data).toBe(false);
    expect((await sessionSnapshot())[0]).toMatchObject({
      id: sessionId,
      active: false,
      deactivation_reason: 'admin_revoked',
    });
  });

  it('allows service-role client deactivation but denies anon and authenticated callers', async () => {
    const sessionId = await seedSession('deactivate-permissions');

    const [anonResult, authenticatedResult] = await Promise.all([
      deactivateDevice(sessionId, anon),
      deactivateDevice(sessionId, authenticated),
    ]);
    expect(anonResult.error).not.toBeNull();
    expect(authenticatedResult.error).not.toBeNull();

    const serviceResult = await deactivateDevice(sessionId);
    expect(serviceResult.error).toBeNull();
    expect(serviceResult.data).toBe(true);
    expect((await sessionSnapshot())[0]).toMatchObject({
      id: sessionId,
      active: false,
      deactivation_reason: 'user_deactivated',
    });
  });
});
