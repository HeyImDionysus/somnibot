/**
 * scenario-runner/scripts/infrastructure-license-sdk — the generated SomniBot
 * licensing contract + validation protocol domain proof.
 *
 * ── The honest harness boundary for THIS domain (why it is mostlyGated) ──
 * This domain is NOT a Discord slash-command flow. Its contracted behavior lives
 * in TWO surfaces the bot-only, local-Supabase loopback harness cannot drive:
 *   1. The self-contained SomniBot licensing contract generated for the customer's
 *      existing project. A conforming integration calls POST
 *      /api/license/{validate,heartbeat,deactivate}, caches results on a monotonic
 *      clock, and enforces the offline-grace / payment-grace stop. It touches no
 *      database; protocol conformance needs a live HTTP endpoint + real clock/network.
 *   2. The dashboard validation API (Next.js routes) — hashes the key, rate-limits
 *      per IP/key, checks guild membership, calls the atomic device-registration
 *      RPC (license_validate_device: SELECT … FOR UPDATE) and the composite
 *      license_validate_lookup RPC, and writes the license_validations audit row.
 * The harness has no HTTP-API driver and no live Discord gateway, so every protocol /
 * route / membership / rate-limit / offline-grace / owner-alert CELL is GATED with a
 * precise reason — never faked, never forced green. mostlyGated = true.
 *
 * ── What DOES run now, DB-observably, against the production license schema ──
 * The tables the generated integration protocol and routes read/write are the real,
 * inspectable substrate:
 *   - license_keys — guild-scoped, keys stored ONLY as SHA-256 hashes (key_hash +
 *     key_prefix/suffix; no plaintext column). We prove hash-only storage, the
 *     guild-scoped admin-lookup predicate, and RLS anon-denial (positive control:
 *     the service role sees the row an anon key gets 42501-denied on — the exact
 *     RLS lockdown from 20260710010000_rls_pattern_sweep_lockdown.sql).
 *   - license_sessions — the device-slot rows; UNIQUE(license_key_id,
 *     device_fingerprint) is the DB-level replay/idempotency guard we exercise
 *     (a re-validated device reuses one row / one slot). No guild_id → scoped via
 *     the parent key; anon-denied by license_key_id.
 *   - license_validations — the durable append-only attempt ledger (result + IP);
 *     we prove its schema/persistence/anon-denial substrate. (The route writing
 *     one row PER attempt, and the anonymize-over-delete retention, are GATED.)
 *   - product_license_config — the per-product config the route reads; we prove
 *     the shipped DB defaults equal the catalog defaults, that a saved config
 *     persists, and that the license_mode CHECK rejects an invalid/over-length
 *     mode (a real DB-observable validation), plus guild isolation and cleanup.
 *
 * Non-vacuity: every ctx.expect compares a REAL row/count read back from Supabase
 * (never a synthetic literal, never count>=0, never an unconditional pass); RLS
 * uses the anon-denial + service-role positive-control pattern.
 *
 * Ledger semantics (20260724110000_license_validations_forensic_ledger):
 * license_validations is a PERMANENT forensic ledger (owner decision) — deleting a
 * license key DETACHES its ledger rows (ON DELETE SET NULL), never erases them,
 * and retention only ANONYMIZES via scrub_expired_license_validations(). The
 * earlier CASCADE concern this file surfaced is thereby resolved product-side.
 * Consequence for the suite's no-residue contract: nothing cascades the seeded
 * ledger rows away anymore, and a surviving row FK-blocks the products sweep
 * (license_validations.product_id has no cascade) — so every scenario that seeds
 * a validation row deletes it explicitly (deleteSeededValidations) before the
 * guild sweep runs. That is test hygiene on synthetic rows the harness itself
 * inserted, not an exercise of the production deletion path (which stays gated).
 */
import { createHash } from 'node:crypto';

import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface LicenseKeyRow {
  id: string;
  guild_id: string;
  customer_id: string;
  product_id: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  status: string;
}

interface LicenseConfigRow {
  product_id: string;
  license_mode: string;
  max_devices: number;
  heartbeat_interval_seconds: number;
  offline_grace_period_seconds: number;
  feature_flags: string[];
  tier: string | null;
  require_discord_guild_membership: boolean;
}

interface SessionRow {
  id: string;
  license_key_id: string;
  device_fingerprint: string;
  active: boolean;
  ip_address: string | null;
}

interface ValidationRow {
  id: string;
  license_key_id: string;
  result: string;
  ip_address: string | null;
  device_fingerprint: string | null;
}

interface LicenseConfigInput {
  license_mode?: string;
  max_devices?: number;
  heartbeat_interval_seconds?: number;
  offline_grace_period_seconds?: number;
  feature_flags?: string[];
  tier?: string | null;
  require_discord_guild_membership?: boolean;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

/** The SHA-256 hex the validation route stores/compares a key by (never plaintext). */
function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function seedCustomer(
  handle: LiveClientHandle,
  discordId: string,
  username: string,
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: discordId, discord_username: username })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function seedProduct(handle: LiveClientHandle, name: string): Promise<string | null> {
  const { data } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name,
      type: 'one_time',
      delivery_type: 'file',
      price_cents: 500,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function seedOrder(
  handle: LiveClientHandle,
  args: { customerId: string; productId: string; orderNumber: string },
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('orders')
    .insert({
      order_number: args.orderNumber,
      customer_id: args.customerId,
      guild_id: handle.guildId,
      product_id: args.productId,
      amount_cents: 500,
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Insert a product_license_config row. When `input` is omitted only product_id is
 * written, so the read-back reflects the SHIPPED DB column defaults — which we
 * then compare against the catalog defaults to catch drift.
 */
async function seedLicenseConfig(
  handle: LiveClientHandle,
  productId: string,
  input: LicenseConfigInput = {},
): Promise<{ error: string | null }> {
  const { error } = await handle.supabase
    .from('product_license_config')
    .insert({ product_id: productId, ...input });
  return { error: error ? error.message : null };
}

async function seedLicenseKey(
  handle: LiveClientHandle,
  args: { customerId: string; productId: string; orderId: string; keyHash: string; boundDiscordId: string; status?: string },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('license_keys')
    .insert({
      guild_id: handle.guildId,
      customer_id: args.customerId,
      product_id: args.productId,
      order_id: args.orderId,
      key_hash: args.keyHash,
      key_prefix: 'SMNI-',
      key_suffix: args.keyHash.slice(0, 4),
      bound_discord_id: args.boundDiscordId,
      status: args.status ?? 'active',
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function seedEntitlement(
  handle: LiveClientHandle,
  args: { customerId: string; productId: string; orderId: string; licenseKeyId: string },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('entitlements')
    .insert({
      customer_id: args.customerId,
      guild_id: handle.guildId,
      product_id: args.productId,
      order_id: args.orderId,
      license_key_id: args.licenseKeyId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function seedSession(
  handle: LiveClientHandle,
  args: { licenseKeyId: string; deviceFingerprint: string; deviceName?: string; ip?: string; active?: boolean },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('license_sessions')
    .insert({
      license_key_id: args.licenseKeyId,
      device_fingerprint: args.deviceFingerprint,
      device_name: args.deviceName ?? 'e2e-device',
      ip_address: args.ip ?? '203.0.113.7',
      active: args.active ?? true,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function seedValidation(
  handle: LiveClientHandle,
  args: { licenseKeyId: string; productId: string; deviceFingerprint: string; result: string; ip?: string },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('license_validations')
    .insert({
      license_key_id: args.licenseKeyId,
      product_id: args.productId,
      device_fingerprint: args.deviceFingerprint,
      result: args.result,
      ip_address: args.ip ?? '203.0.113.7',
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function readLicenseKey(handle: LiveClientHandle, keyId: string): Promise<LicenseKeyRow | null> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, guild_id, customer_id, product_id, key_hash, key_prefix, key_suffix, status')
    .eq('id', keyId)
    .maybeSingle();
  return (data as LicenseKeyRow | null) ?? null;
}

/** The guild-scoped admin lookup predicate every dashboard license route uses. */
async function readLicenseKeyScopedByGuild(
  handle: LiveClientHandle,
  keyId: string,
  guildId: string,
): Promise<LicenseKeyRow | null> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, guild_id, customer_id, product_id, key_hash, key_prefix, key_suffix, status')
    .eq('id', keyId)
    .eq('guild_id', guildId)
    .maybeSingle();
  return (data as LicenseKeyRow | null) ?? null;
}

async function readConfig(handle: LiveClientHandle, productId: string): Promise<LicenseConfigRow | null> {
  const { data } = await handle.supabase
    .from('product_license_config')
    .select('product_id, license_mode, max_devices, heartbeat_interval_seconds, offline_grace_period_seconds, feature_flags, tier, require_discord_guild_membership')
    .eq('product_id', productId)
    .maybeSingle();
  return (data as LicenseConfigRow | null) ?? null;
}

async function countActiveSessions(handle: LiveClientHandle, licenseKeyId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('license_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('license_key_id', licenseKeyId)
    .eq('active', true);
  return count ?? 0;
}

async function countSessions(handle: LiveClientHandle, licenseKeyId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('license_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('license_key_id', licenseKeyId);
  return count ?? 0;
}

async function readValidations(handle: LiveClientHandle, licenseKeyId: string): Promise<ValidationRow[]> {
  const { data } = await handle.supabase
    .from('license_validations')
    .select('id, license_key_id, result, ip_address, device_fingerprint')
    .eq('license_key_id', licenseKeyId);
  return (data as ValidationRow[] | null) ?? [];
}

/** Count the ledger rows attached to a product (survives key deletion: SET NULL). */
async function countValidationsForProduct(handle: LiveClientHandle, productId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('license_validations')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', productId);
  return count ?? 0;
}

/**
 * Remove the run's seeded license_validations rows for a product. Production
 * semantics (20260724110000): the ledger is permanent — key deletion DETACHES via
 * ON DELETE SET NULL and retention only anonymizes — so nothing cascades these
 * synthetic rows away, and a surviving row FK-blocks the products sweep
 * (license_validations.product_id → products has no cascade). Each scenario that
 * seeds a ledger row must therefore delete it before the guild sweep runs, or the
 * run-prefixed products row survives as residue.
 */
async function deleteSeededValidations(handle: LiveClientHandle, productId: string | null): Promise<void> {
  if (!productId) return;
  await handle.supabase.from('license_validations').delete().eq('product_id', productId);
}

/** license_keys ids for a guild — used to prove parent-scoping of the guild-less
 *  session/validation tables (they carry no guild_id of their own). */
async function keyIdsForGuild(handle: LiveClientHandle, guildId: string): Promise<string[]> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id')
    .eq('guild_id', guildId);
  return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors,
 * so a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Count play-money game-economy rows for the guild (the two-economies wall). */
async function gameEconomyRowCount(handle: LiveClientHandle): Promise<number | null> {
  const wallets = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (wallets.error) return null;
  const txns = await handle.supabase
    .from('economy_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (txns.error) return null;
  return (wallets.count ?? 0) + (txns.count ?? 0);
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS/GRANT deny → 0,
 * or SQLSTATE 42501 permission-denied → 0), or null when inconclusive (→ GATE).
 * `filterColumn` lets guild-less tables (license_sessions/validations) be probed by
 * their parent license_key_id, while license_keys is probed by guild_id.
 */
async function anonReadCount(
  anonKey: string,
  table: string,
  filterColumn: string,
  filterValue: string,
): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=${filterColumn}&${filterColumn}=eq.${encodeURIComponent(filterValue)}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (anon blocked from the
    // table by RLS / revoked GRANT — the deny we want) from the KEY itself being
    // rejected before authz ran (inconclusive → GATE). PostgREST surfaces the
    // former as SQLSTATE 42501 "permission denied for table" (HTTP 401/403).
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null; // non-JSON error body — inconclusive
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // the anon role is denied the table — RLS/GRANT lockdown working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove license keys are stored ONLY as SHA-256 hashes: the persisted key_hash
 * equals sha256(plaintext) and the prefix/suffix are short partials — there is no
 * full-plaintext column. Non-vacuous: it reads the real row back and would FAIL if
 * a key were ever stored in the clear.
 */
function proveHashOnlyStorage(
  ctx: ScenarioContext,
  keyRow: LicenseKeyRow | null,
  plaintext: string,
): void {
  const expectedHash = hashKey(plaintext);
  const ok =
    keyRow !== null &&
    keyRow.key_hash === expectedHash &&
    keyRow.key_hash !== plaintext &&
    keyRow.key_prefix.length <= 8 &&
    keyRow.key_suffix.length <= 8;
  ctx.expect(ok, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A license key exists in storage only as its SHA-256 hash (key_hash), never as recoverable plaintext.',
    observation:
      `key row present=${keyRow !== null}; key_hash===sha256(plaintext) is ${keyRow?.key_hash === expectedHash}; ` +
      `key_hash!==plaintext is ${keyRow?.key_hash !== plaintext}; prefix="${keyRow?.key_prefix}", suffix="${keyRow?.key_suffix}".`,
    impact: 'A license key was not stored as a bare SHA-256 hash — recoverable key material would be exposed at rest.',
  });
}

/** Anon-denial on a table with a service-role positive control (the RLS pattern). */
async function proveAnonDenied(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  args: { table: string; filterColumn: string; filterValue: string; serviceSees: boolean; promise: string; impact: string },
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      args.promise,
      `no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial on ${args.table} not exercised — service-role guild/parent scoping is still proven`,
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, args.table, args.filterColumn, args.filterValue);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      args.promise,
      `the anon REST probe on ${args.table} was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)`,
    );
    return;
  }
  ctx.expect(args.serviceSees && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: args.promise,
    observation:
      `service-role sees the ${args.table} row (${args.serviceSees}); ` +
      `an anon-key REST read returned ${anonRows} ${args.table} row(s).`,
    impact: args.impact,
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's healthy license lifecycle raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'A healthy license lifecycle (routine validation) raises no owner alert.',
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a healthy license path — a false alarm / notification noise.',
  });
}

function gateSdkProtocolBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    "Customer-facing license copy (validation-success greeting, device-limit, revoked, rate-limited) leads with the owner's brand and support path, with only subtle powered-by-SomniBot attribution on portal surfaces.",
    'those templates are surfaced by a project integration conforming to the generated SomniBot licensing protocol and by the rendered customer portal, not by any Discord bot reply — protocol-response and portal snapshots are required (no member-facing bot message exists to inspect)',
  );
}

/** The guild-membership gate + "no game currency" Discord effects need a live gateway + HTTP route. */
function gateDiscordMembership(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'Guild-membership-gated validation reflects real membership changes in the test guild (require_discord_guild_membership), and no license activity ever grants a game role or mints game currency.',
    'membership gating is evaluated inside POST /api/license/validate against the live guild; it needs the HTTP route + a live Discord gateway (DISCORD_TOKEN) — not drivable by the bot-only local-Supabase harness',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — out-of-the-box lifecycle: portal_only, 3 devices, 300s heartbeat, 24h
 * offline grace, guild membership required. Generated-contract protocol conformance
 * across validate→heartbeat→deactivate is gated; config defaults, hash-only key
 * storage, the durable validation ledger row, RLS, and the DB-level
 * single-session-per-device guard run now.
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const defMode = String(declaredDefault(ctx.domain, 'license-mode'));
  const defMax = Number(declaredDefault(ctx.domain, 'max-devices'));
  const defHb = Number(declaredDefault(ctx.domain, 'heartbeat-interval-seconds'));
  const defOffline = Number(declaredDefault(ctx.domain, 'offline-grace-period-seconds'));
  const defMembership = Boolean(declaredDefault(ctx.domain, 'require-discord-guild-membership'));

  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}def-key-plaintext`;

  // Arrange the real licensed-product identity: customer → product → DEFAULT config
  // → completed order → active license key (hashed) → linked entitlement.
  const customerId = await seedCustomer(handle, discordId, 'e2e-license-def');
  const productId = await seedProduct(handle, `${ctx.runPrefix}def-product`);
  const cfg = productId ? await seedLicenseConfig(handle, productId) : { error: 'no product' };
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}def-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const ent = customerId && productId && orderId && key.id
    ? await seedEntitlement(handle, { customerId, productId, orderId, licenseKeyId: key.id })
    : { id: null, error: 'no key' };
  const keyRow = key.id ? await readLicenseKey(handle, key.id) : null;

  const arranged = Boolean(customerId && productId && orderId && key.id && ent.id && cfg.error === null);
  ctx.expect(arranged, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a real licensed product (customer + product license config + completed order + active hashed key + entitlement) persists under the production license schema.',
    observation:
      `customer=${Boolean(customerId)}, product=${Boolean(productId)}, config err=${cfg.error ?? 'none'}, ` +
      `order=${Boolean(orderId)}, key=${Boolean(key.id)} (err=${key.error ?? 'none'}), entitlement=${Boolean(ent.id)} (err=${ent.error ?? 'none'}).`,
    impact: 'Could not arrange a licensed product against the real license schema — the DEF proof setup is invalid.',
  });

  // Shipped product_license_config DB defaults equal the catalog defaults (drift guard).
  const config = productId ? await readConfig(handle, productId) : null;
  ctx.expect(
    config !== null &&
      config.license_mode === defMode &&
      config.max_devices === defMax &&
      config.heartbeat_interval_seconds === defHb &&
      config.offline_grace_period_seconds === defOffline &&
      config.require_discord_guild_membership === defMembership &&
      Array.isArray(config.feature_flags) &&
      config.feature_flags.length === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `Out of the box the product_license_config carries the catalog defaults (mode ${defMode}, ${defMax} devices, ${defHb}s heartbeat, ${defOffline}s offline grace, membership required, no feature flags).`,
      observation:
        `config mode=${config?.license_mode}, max_devices=${config?.max_devices}, heartbeat=${config?.heartbeat_interval_seconds}, ` +
        `offline=${config?.offline_grace_period_seconds}, membership=${config?.require_discord_guild_membership}, flags=${JSON.stringify(config?.feature_flags)}.`,
      impact: 'The shipped license-config defaults diverged from the catalog contract — the out-of-the-box behavior would not match the promise.',
    },
  );

  // A validate-success device session + its durable audit-ledger row (result + IP).
  const fp = `${ctx.runPrefix}def-device-1`;
  const sess = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const val = key.id && productId ? await seedValidation(handle, { licenseKeyId: key.id, productId, deviceFingerprint: fp, result: 'valid' }) : { id: null, error: 'no key' };
  const validations = key.id ? await readValidations(handle, key.id) : [];
  const validRow = validations.find((v) => v.id === val.id) ?? null;
  ctx.expect(validRow !== null && validRow.result === 'valid' && validRow.ip_address === '203.0.113.7' && validRow.device_fingerprint === fp, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A validation attempt lands a durable license_validations ledger row carrying its result and IP (the append-only audit substrate).',
    observation:
      `license_validations row present=${validRow !== null}; result="${validRow?.result}" (expected valid), ` +
      `ip="${validRow?.ip_address}", fingerprint="${validRow?.device_fingerprint}".`,
    impact: 'The validation ledger did not durably record the attempt result + IP — the audit substrate is broken.',
  });

  // DB-level replay/idempotency: re-validating the SAME device is fenced by the
  // UNIQUE(license_key_id, device_fingerprint) index → one session / one slot.
  const dup = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const active = key.id ? await countActiveSessions(handle, key.id) : 0;
  ctx.expect(sess.id !== null && dup.id === null && dup.error !== null && active === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The same device validating twice reuses one session and one device slot (UNIQUE(license_key_id, device_fingerprint) fences the duplicate).',
    observation:
      `first session id=${sess.id ? 'created' : 'null'}; duplicate-fingerprint insert id=${dup.id ? 'created' : 'null'} ` +
      `(error=${dup.error ? 'rejected' : 'NONE'}); active sessions for the key = ${active} (expected 1).`,
    impact: 'A re-validated device created a second session row — a device slot would be double-consumed.',
  });

  // Keys are hash-only + guild-scoped-lookup + anon-denied.
  proveHashOnlyStorage(ctx, keyRow, plaintext);
  await proveAnonDenied(ctx, handle, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: handle.guildId,
    serviceSees: keyRow !== null,
    promise: 'An anon client reads zero license_keys rows for this guild while the service role reads the guild-scoped key (RLS/GRANT lockdown).',
    impact: 'A license_keys row visible to the service role was also readable with an anon key — key material exposed to unauthenticated clients.',
  });
  await proveNoOwnerAlert(ctx, handle);

  gateDiscordMembership(ctx);
  gateSdkProtocolBranding(ctx);
  ctx.gate(
    'Discord',
    'db-observable',
    'validate() returns valid with session id/tier/features, heartbeats at the directed 300s cadence, and deactivate() frees the device slot.',
    'the validate→heartbeat→deactivate lifecycle must be exercised by a project integration generated from the SomniBot licensing contract against POST /api/license/* — the harness has no HTTP-API driver, so protocol conformance cannot be exercised',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The route writes exactly one license_validations row per attempt (validate) and one on deactivate, with the caller IP resolved by the route.',
    'the per-attempt ledger write and route-resolved IP happen inside POST /api/license/{validate,deactivate}; only the ledger schema/persistence substrate is provable here, not the route attribution',
  );

  // The seeded ledger row never cascades (permanent forensic ledger — key delete
  // only DETACHES it) and would FK-block the products sweep: remove it explicitly.
  await deleteSeededValidations(handle, productId);
}

/**
 * SET-A — dashboard config takes effect: max_devices=1, heartbeat=60s. The saved
 * config persisting is DB-observable; a generated integration honoring the 60s
 * protocol cadence and the second device being refused (RPC/route enforcement)
 * are gated.
 */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}set-a-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-set-a');
  const productId = await seedProduct(handle, `${ctx.runPrefix}set-a-product`);
  const cfg = productId ? await seedLicenseConfig(handle, productId, { max_devices: 1, heartbeat_interval_seconds: 60 }) : { error: 'no product' };
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}set-a-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const keyRow = key.id ? await readLicenseKey(handle, key.id) : null;

  // The saved config PERSISTED exactly (config-takes-effect at the DB layer).
  const config = productId ? await readConfig(handle, productId) : null;
  ctx.expect(config !== null && config.max_devices === 1 && config.heartbeat_interval_seconds === 60, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'PUT-style saving max_devices=1 and heartbeat_interval_seconds=60 persists to product_license_config exactly (the config the validation route reads).',
    observation: `config err=${cfg.error ?? 'none'}; persisted max_devices=${config?.max_devices} (expected 1), heartbeat=${config?.heartbeat_interval_seconds} (expected 60).`,
    impact: 'A saved dashboard license config did not persist — the setting the route reads would be ignored.',
  });

  proveHashOnlyStorage(ctx, keyRow, plaintext);
  await proveAnonDenied(ctx, handle, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: handle.guildId,
    serviceSees: keyRow !== null,
    promise: 'An anon client reads zero license_keys rows for this guild; the owning guild reads its config-bound key (product config writable only within the owning guild).',
    impact: 'A guild license key was readable anonymously — cross-tenant key exposure.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'db-observable',
    'With max_devices=1, device one validates and a second distinct device is refused with the device-limit result (no over-allocation).',
    'the limit is enforced by the license_validate_device RPC (SELECT … FOR UPDATE + count check) called from POST /api/license/validate — the plain table INSERT does not enforce it, so the rejection needs the route/RPC (revoked from client roles) which the bot-only harness cannot invoke',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A project integration generated from the SomniBot licensing contract observes the new 60-second server-directed heartbeat spacing.',
    'heartbeat cadence is a generated-protocol conformance behavior against POST /api/license/heartbeat — it needs a conforming built integration, a live HTTP endpoint, and real time to observe spacing',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The config change and the device_limit rejection are each logged.',
    'the config-change audit row is written by the dashboard save route and the device_limit row by the validate route — neither route is drivable in this harness',
  );
  gateSdkProtocolBranding(ctx);
  gateDiscordMembership(ctx);
}

/**
 * SET-B — a second config also takes effect: max_devices=5, offline grace 3600s,
 * feature_flags + tier. Persistence + five coexisting session rows are DB-observable;
 * the 6th refusal, the shortened offline window, and getFeatures/getTier are gated.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}set-b-key`;
  const flags = [`${ctx.runPrefix}flag-pro`, `${ctx.runPrefix}flag-beta`];
  const tier = 'pro';

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-set-b');
  const productId = await seedProduct(handle, `${ctx.runPrefix}set-b-product`);
  const cfg = productId
    ? await seedLicenseConfig(handle, productId, { max_devices: 5, offline_grace_period_seconds: 3600, feature_flags: flags, tier })
    : { error: 'no product' };
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}set-b-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const keyRow = key.id ? await readLicenseKey(handle, key.id) : null;

  const config = productId ? await readConfig(handle, productId) : null;
  ctx.expect(
    config !== null &&
      config.max_devices === 5 &&
      config.offline_grace_period_seconds === 3600 &&
      config.tier === tier &&
      Array.isArray(config.feature_flags) &&
      config.feature_flags.length === 2 &&
      flags.every((f) => config.feature_flags.includes(f)),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A max_devices=5 / offline_grace=3600s / feature_flags+tier config persists exactly to product_license_config (the values the lookup RPC returns through the generated licensing protocol).',
      observation:
        `config err=${cfg.error ?? 'none'}; max_devices=${config?.max_devices} (5), offline=${config?.offline_grace_period_seconds} (3600), ` +
        `tier="${config?.tier}" (pro), flags=${JSON.stringify(config?.feature_flags)}.`,
      impact: 'The second saved license config did not persist — flags/tier/limits delivered through the generated protocol would be wrong.',
    },
  );

  // Five distinct device sessions COEXIST in the table under one key (the slot rows).
  let created = 0;
  if (key.id) {
    for (let i = 0; i < 5; i += 1) {
      const s = await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: `${ctx.runPrefix}set-b-dev-${i}` });
      if (s.id) created += 1;
    }
  }
  const active = key.id ? await countActiveSessions(handle, key.id) : 0;
  ctx.expect(created === 5 && active === 5, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Five distinct device fingerprints hold five concurrent active sessions under the one key (the slot rows the count enforcement reads).',
    observation: `sessions created=${created}, active session count for the key=${active} (expected 5).`,
    impact: 'The session table could not hold the configured five device slots.',
  });

  proveHashOnlyStorage(ctx, keyRow, plaintext);
  await proveAnonDenied(ctx, handle, {
    table: 'license_sessions',
    filterColumn: 'license_key_id',
    filterValue: key.id ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: active === 5,
    promise: 'An anon client reads zero license_sessions rows for the key while the service role reads all five (sessions scoped via the parent key, anon denied).',
    impact: 'Device-session rows were readable anonymously — device/session enumeration exposure.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'db-observable',
    'A sixth device is refused at the limit; a device offline past one hour reports offline_grace_expired instead of the default 24h.',
    'the sixth-device refusal is the license_validate_device RPC count check (route-only) and the shortened offline window is enforced by the generated integration protocol on its monotonic clock — neither is reachable from the bot-only harness',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'getFeatures() and getTier() return the configured flags and tier for the entitled customer.',
    'a conforming generated integration surfaces features/tier from the validation protocol response (config carried through license_validate_lookup) — it needs the built integration plus live route; only the stored config values are provable here',
  );
  gateSdkProtocolBranding(ctx);
  gateDiscordMembership(ctx);
}

/**
 * INVALID — invalid product license config is refused. The license_mode CHECK is a
 * real DB-observable rejection; the numeric validations (max_devices=0, negative
 * heartbeat, offline > 7 days) live in the dashboard Zod layer and are gated.
 */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const productId = await seedProduct(handle, `${ctx.runPrefix}invalid-product`);

  // Positive control: a VALID config persists first.
  const good = productId ? await seedLicenseConfig(handle, productId, { license_mode: 'portal_only', max_devices: 3 }) : { error: 'no product' };
  const before = productId ? await readConfig(handle, productId) : null;

  // An over-length / non-canonical license_mode is refused by the DB CHECK
  // constraint (license_mode IN portal_only/portal_watermark/embedded/access_pass).
  // Non-vacuous: the valid mode above DID persist, so this is a real rejection.
  const badMode = 'x'.repeat(40); // > 32 chars and not a canonical mode
  const { error: badErr } = productId
    ? await handle.supabase.from('product_license_config').update({ license_mode: badMode }).eq('product_id', productId)
    : { error: { message: 'no product' } };
  const after = productId ? await readConfig(handle, productId) : null;

  ctx.expect(
    good.error === null && before?.license_mode === 'portal_only' && badErr !== null && after?.license_mode === 'portal_only',
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'An invalid/over-length license_mode is rejected by the license_mode CHECK constraint and the previously-stored valid config is unchanged (rejected write never persists).',
      observation:
        `valid config persisted mode="${before?.license_mode}"; invalid-mode update ${badErr ? 'rejected' : 'ACCEPTED'} ` +
        `(err=${badErr ? 'present' : 'NONE'}); config after = "${after?.license_mode}" (expected still portal_only).`,
      impact: 'An invalid license_mode was accepted or the stored config was mutated by a rejected write — config validation is not enforced at the DB layer.',
    },
  );

  await proveAnonDenied(ctx, handle, {
    table: 'product_license_config',
    filterColumn: 'product_id',
    filterValue: productId ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: after !== null,
    promise: 'An anon client reads zero product_license_config rows while the service role reads the product config (RLS/GRANT lockdown).',
    impact: 'Product license config was readable anonymously — per-tenant config exposure.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'discord-readback',
    'max_devices=0, a negative heartbeat interval, or an offline grace beyond seven days are each refused with a 4xx naming the offending field; a follow-up GET shows the prior config intact.',
    'those numeric bounds have no DB CHECK constraint; they are validated by the dashboard PUT /api/license/config Zod layer — a bot-only harness cannot drive that reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Each rejected config attempt is recorded with its validation failure reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard config save route (not reachable in a bot-only harness)',
  );
  gateSdkProtocolBranding(ctx);
  gateDiscordMembership(ctx);
}

/**
 * UNAUTH — permission boundary: an unrelated guild's owner cannot read this guild's
 * key. The guild-scoped admin-lookup predicate returning not-found for the foreign
 * guild (with a positive control) is DB-observable; the HTTP 401/not-found responses
 * and the portal-token gate are route behaviors and are gated.
 */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const discordId = ctx.userId('a');
  const guildLegit = ctx.scenarioGuildId('a');
  const guildForeign = ctx.scenarioGuildId('b');
  const handle = await ctx.bootGuild({ guildId: guildLegit, economyEnabled: false });
  const foreign = await ctx.bootGuild({ guildId: guildForeign, economyEnabled: false });
  const plaintext = `${ctx.runPrefix}unauth-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-unauth');
  const productId = await seedProduct(handle, `${ctx.runPrefix}unauth-product`);
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}unauth-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };

  // The legit guild's scope resolves the key; the foreign guild's scope (the exact
  // `.eq('guild_id', callerGuild)` the admin routes apply, V47-C2) resolves NOTHING
  // despite a valid key UUID — not-found, never data.
  const seenByLegit = key.id ? await readLicenseKeyScopedByGuild(handle, key.id, guildLegit) : null;
  const seenByForeign = key.id ? await readLicenseKeyScopedByGuild(foreign, key.id, guildForeign) : null;
  ctx.expect(seenByLegit !== null && seenByLegit.guild_id === guildLegit && seenByForeign === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'An unrelated guild scoping a valid key UUID to its own guild_id reads nothing (not-found, never data), while the owning guild reads the key (guild-scoped admin lookup).',
    observation:
      `owning-guild-scoped read → ${seenByLegit ? `key under "${seenByLegit.guild_id}"` : 'nothing'}; ` +
      `foreign-guild-scoped read of the same key id → ${seenByForeign ? 'RETURNED THE KEY' : 'nothing'} (expected nothing).`,
    impact: 'A foreign guild resolved another guild\'s license key through the guild-scoped predicate — cross-guild key access.',
  });

  await proveAnonDenied(ctx, handle, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: guildLegit,
    serviceSees: seenByLegit !== null,
    promise: 'An anon client reads zero license_keys rows for the owning guild (anon and cross-guild clients cannot read keys).',
    impact: 'Keys were readable anonymously — the public boundary leaks key material.',
  });
  await proveNoOwnerAlert(ctx, handle);
  await proveNoOwnerAlert(ctx, foreign);

  ctx.gate(
    'Discord',
    'discord-readback',
    'Cross-guild GET /api/license-keys/[key], GET /api/license/sessions, and DELETE /api/license/sessions/[id] all return not-found for valid UUIDs; /api/portal/licenses without x-portal-token returns 401 with nothing leaked.',
    'those are dashboard/portal HTTP responses (requireGuildOwner + parent guild_id ownership check, and the x-portal-token hash match) — the bot-only harness cannot issue the HTTP requests to observe the 404/401 bodies',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The denied cross-guild attempts are recorded in the audit trail and repeated probing is surfaceable as suspicious.',
    'the denial audit rows are written inside the dashboard license routes; with the routes undrivable no denial row is produced to read back',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Repeated foreign-guild probing is surfaced to the legitimate owner as suspicious activity.',
    'the security/anomaly surface is fed by the live HTTP routes generating the denial signals — not reachable here',
  );
  gateSdkProtocolBranding(ctx);
}

/**
 * DEPFAIL — dependency failure fails safe. The bounded offline window, the
 * never-validated-device refusal, and the fail-closed RPC-failure 500 all need a
 * fault-injection lane plus protocol/routes; the one DB-observable fact is that an
 * already-validated device's server-side state (session + validation ledger) is
 * durable in Supabase and RLS-protected, so it is readable with no external
 * dependency in the path.
 */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}depfail-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-depfail');
  const productId = await seedProduct(handle, `${ctx.runPrefix}depfail-product`);
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}depfail-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const fp = `${ctx.runPrefix}depfail-device`;
  const sess = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const val = key.id && productId ? await seedValidation(handle, { licenseKeyId: key.id, productId, deviceFingerprint: fp, result: 'valid' }) : { id: null, error: 'no key' };

  const active = key.id ? await countActiveSessions(handle, key.id) : 0;
  const validations = key.id ? await readValidations(handle, key.id) : [];
  ctx.expect(sess.id !== null && val.id !== null && active === 1 && validations.length === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: "An already-validated device's server-side state (its active session + its validation-ledger row) is durable in Supabase and readable with no generated-integration dependency in the path — the truth the offline cache mirrors.",
    observation: `active sessions=${active} (expected 1, sess err=${sess.error ?? 'none'}); validation rows=${validations.length} (expected 1, val err=${val.error ?? 'none'}).`,
    impact: "The already-validated device's durable session/validation state was not independently readable — an outage could not fail safe for an authenticated device.",
  });

  await proveAnonDenied(ctx, handle, {
    table: 'license_sessions',
    filterColumn: 'license_key_id',
    filterValue: key.id ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: active === 1,
    promise: 'Through the outage window the session row stays anon-denied while the service role reads it (RLS holds under the fail-safe path).',
    impact: 'A session row became anon-readable — an outage would widen data exposure.',
  });

  ctx.gate(
    'Discord',
    'db-observable',
    'With the license server down, the cached device reports offline_grace until the window ends then offline_grace_expired; a never-validated device gets network_error with no entitlement.',
    'offline-grace / network_error behavior is generated-protocol conformance on a monotonic clock under a real transport failure — it needs the built customer integration plus an induced network outage, absent in the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'A server-side lookup RPC failure returns a fail-closed 500 with valid:false and writes NO partial session row.',
    'inducing a license_validate_lookup RPC error requires a fault-injection lane against POST /api/license/validate — the harness deliberately runs against a reachable DB and cannot force the RPC to error',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The outage window logs license.validation_network_error rows and the license.lookup_failed event.',
    'those rows are written by the validate route failure branches (needs the route + an outage fault lane)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner is notified of the server-side lookup failure (but not of routine customer-side network errors or rate limits).',
    'the lookup-failure owner alert is raised inside the validate route failure branch — needs the route + a fault lane to trigger it',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated failing calls during the outage do not corrupt the cache or duplicate sessions on recovery.',
    'requires the generated-protocol offline path plus an outage fault lane to replay failing calls and observe the post-recovery state',
  );
  gateSdkProtocolBranding(ctx);

  // The seeded ledger row never cascades (permanent forensic ledger — key delete
  // only DETACHES it) and would FK-block the products sweep: remove it explicitly.
  await deleteSeededValidations(handle, productId);
}

/**
 * RETRY — transient failures converge to exactly one session. The convergence
 * invariant (a re-validated fingerprint reuses one active session via the UNIQUE
 * guard) is DB-observable; the 429/Retry-After honoring and the transient-network
 * retry glue are generated-protocol/route behaviors and are gated.
 */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}retry-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-retry');
  const productId = await seedProduct(handle, `${ctx.runPrefix}retry-product`);
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}retry-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const fp = `${ctx.runPrefix}retry-device`;

  // A retried validation for the SAME fingerprint (what backoff replays) converges
  // to ONE active session — the UNIQUE(license_key_id, device_fingerprint) guard
  // fences the second insert, so the retry cannot double-occupy a device slot.
  const first = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const retry = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const active = key.id ? await countActiveSessions(handle, key.id) : 0;
  ctx.expect(first.id !== null && retry.id === null && retry.error !== null && active === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'After a transient failure, the retried validation for the same fingerprint converges to exactly one active session (no duplicate device slot).',
    observation:
      `first session id=${first.id ? 'created' : 'null'}; retry insert id=${retry.id ? 'created' : 'null'} ` +
      `(error=${retry.error ? 'fenced' : 'NONE'}); active sessions=${active} (expected 1).`,
    impact: 'A retried validation created a second session — transient-failure retries would over-allocate device slots.',
  });

  await proveAnonDenied(ctx, handle, {
    table: 'license_sessions',
    filterColumn: 'license_key_id',
    filterValue: key.id ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: active === 1,
    promise: 'The converged session stays anon-denied while the service role reads it (exactly one session row for the fingerprint).',
    impact: 'The converged session became anon-readable — session exposure after retry.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'Discord',
    'discord-readback',
    'A 429-rate-limited validate() retried too early is refused again and succeeds after the Retry-After window; a transient network fault succeeds on retry.',
    '429/Retry-After honoring and network-fault backoff span the validate route rate limiter and generated-protocol retry behavior — neither is drivable by the bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The failed, rate-limited, and successful attempts are each logged distinctly.',
    'per-attempt license_validations rows are written by the validate route; with the route undrivable the distinct attempt log cannot be produced here',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The rate-limit message states the wait plainly in the branded voice.',
    'the rate-limited template is a generated-protocol/route HTTP response surface, not a Discord bot reply — no member-facing message to inspect',
  );
}

/**
 * REPLAY — replay grants nothing twice. The DB-level guards (UNIQUE session guard,
 * idempotent deactivate, and the two-economies wall) are DB-observable; the end-to-
 * end HTTP replay of validate/heartbeat/deactivate is gated.
 */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}replay-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-replay');
  const productId = await seedProduct(handle, `${ctx.runPrefix}replay-product`);
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}replay-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const fp = `${ctx.runPrefix}replay-device`;

  // Replayed validate: the same fingerprint resolves to one session / one slot.
  const first = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const replay = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const total = key.id ? await countSessions(handle, key.id) : 0;
  ctx.expect(first.id !== null && replay.id === null && replay.error !== null && total === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A replayed validate creates no duplicate session and consumes no extra device slot (the UNIQUE guard resolves the replay to the single original row).',
    observation:
      `first session id=${first.id ? 'created' : 'null'}; replayed insert id=${replay.id ? 'created' : 'null'} ` +
      `(error=${replay.error ? 'fenced' : 'NONE'}); total session rows for the key=${total} (expected 1).`,
    impact: 'A replayed validate created a duplicate session — a device slot would be double-consumed on replay.',
  });

  // Replayed deactivate on an already-inactive session is a harmless no-op.
  let reDeactivateOk = false;
  if (first.id) {
    await handle.supabase.from('license_sessions').update({ active: false, deactivated_at: new Date().toISOString(), deactivation_reason: 'user_deactivated' }).eq('id', first.id);
    await handle.supabase.from('license_sessions').update({ active: false, deactivated_at: new Date().toISOString(), deactivation_reason: 'user_deactivated' }).eq('id', first.id);
    const stillActive = key.id ? await countActiveSessions(handle, key.id) : -1;
    const stillTotal = key.id ? await countSessions(handle, key.id) : -1;
    reDeactivateOk = stillActive === 0 && stillTotal === 1;
  }
  ctx.expect(reDeactivateOk, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A replayed deactivate on an already-inactive session is a harmless no-op — still exactly one inactive session row, zero active.',
    observation: `after two deactivations of the same session: reDeactivateOk=${reDeactivateOk} (expected exactly one row, zero active).`,
    impact: 'A replayed deactivate changed row/slot accounting — deactivation is not idempotent.',
  });

  // The two-economies wall: no license activity minted any play-money game row.
  const gameRows = await gameEconomyRowCount(handle);
  if (gameRows === null) {
    ctx.gate(
      'Discord',
      'db-observable',
      'License replays mint nothing in the play-money game economy.',
      'the economy_wallets/economy_transactions read errored, so "no game rows" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(gameRows === 0, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Replayed license actions never mint anything in the play-money game economy (the two-economies wall holds).',
      observation: `game-economy rows (economy_wallets + economy_transactions) for the guild = ${gameRows} (expected 0).`,
      impact: 'License activity created play-money game-economy rows — the two-economies wall was breached.',
    });
  }

  await proveAnonDenied(ctx, handle, {
    table: 'license_sessions',
    filterColumn: 'license_key_id',
    filterValue: key.id ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: total === 1,
    promise: 'The single replayed session stays anon-denied while the service role reads it.',
    impact: 'The replayed session became anon-readable — session exposure.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'audit',
    'audit-row',
    'Replayed requests are logged without inflating grant or status-change history (the validation log shows the replays as no-ops).',
    'per-attempt license_validations rows are written by the validate/heartbeat/deactivate routes — the end-to-end replay log is not producible without the HTTP routes',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'Replayed heartbeat only refreshes last_seen and replayed deactivate over HTTP is a no-op; key status and slot accounting stay byte-identical to a single execution.',
    'the end-to-end HTTP replay of validate/heartbeat/deactivate requires a built project integration conforming to the generated SomniBot licensing protocol — only the DB-level guards are provable here',
  );
  gateSdkProtocolBranding(ctx);
}

/**
 * RESTART — license state survives a full stack reboot because it lives in Supabase,
 * not process memory. Key + session + validation-ledger persistence across a boot,
 * and the restart-revalidation slot-reuse guard, are DB-observable; generated-
 * protocol revalidation into the existing session and heartbeat resume are gated.
 */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}restart-key`;
  const fp = `${ctx.runPrefix}restart-device`;

  // Boot #1: arrange the full licensed state, snapshot durable fields, then dispose.
  const first = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const customerId = await seedCustomer(first, discordId, 'e2e-license-restart');
  const productId = await seedProduct(first, `${ctx.runPrefix}restart-product`);
  const orderId = customerId && productId ? await seedOrder(first, { customerId, productId, orderNumber: `${ctx.runPrefix}restart-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(first, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const sess = key.id ? await seedSession(first, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const val = key.id && productId ? await seedValidation(first, { licenseKeyId: key.id, productId, deviceFingerprint: fp, result: 'valid' }) : { id: null, error: 'no key' };
  const keyBefore = key.id ? await readLicenseKey(first, key.id) : null;
  const valsBefore = key.id ? await readValidations(first, key.id) : [];
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). Everything must read back identical.
  const second = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const keyAfter = key.id ? await readLicenseKey(second, key.id) : null;
  const activeAfter = key.id ? await countActiveSessions(second, key.id) : 0;
  const valsAfter = key.id ? await readValidations(second, key.id) : [];

  ctx.expect(
    keyBefore !== null && keyAfter !== null && keyAfter.id === keyBefore.id && keyAfter.key_hash === keyBefore.key_hash && keyAfter.status === keyBefore.status && activeAfter === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the license key and its active device session read back byte-identical (state persists in Supabase across the reboot).',
      observation:
        `key id ${keyBefore?.id} → ${keyAfter?.id}, key_hash match=${keyBefore?.key_hash === keyAfter?.key_hash}, status ${keyBefore?.status} → ${keyAfter?.status}; ` +
        `active sessions after restart = ${activeAfter} (expected 1).`,
      impact: 'License key or session state did not survive a restart — a persisted row was lost or altered across boot.',
    },
  );

  ctx.expect(valsBefore.length === 1 && valsAfter.length === 1 && valsAfter[0]!.id === valsBefore[0]!.id, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Pre-restart validation-ledger history remains intact across the reboot (the audit row persists with its id).',
    observation: `validation rows before=${valsBefore.length}, after=${valsAfter.length}; id stable=${valsBefore[0]?.id === valsAfter[0]?.id} (val err=${val.error ?? 'none'}).`,
    impact: 'A validation-ledger row did not survive the restart — audit history was lost.',
  });

  // Restart-triggered revalidation does not double-occupy a slot: re-inserting the
  // same fingerprint post-restart is fenced by the UNIQUE guard → still one session.
  const reval = key.id ? await seedSession(second, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const activeReval = key.id ? await countActiveSessions(second, key.id) : 0;
  ctx.expect(reval.id === null && reval.error !== null && activeReval === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A restart-triggered revalidation of the same fingerprint reoccupies the existing session rather than consuming a fresh device slot.',
    observation: `post-restart revalidate insert id=${reval.id ? 'created' : 'null'} (error=${reval.error ? 'fenced' : 'NONE'}); active sessions=${activeReval} (expected 1).`,
    impact: 'A restart revalidation created a second session — the device slot was double-occupied across the reboot.',
  });

  await proveAnonDenied(ctx, second, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: guildId,
    serviceSees: keyAfter !== null,
    promise: 'After restart the persisted key stays guild-scoped and anon-denied (RLS protections survive the reboot).',
    impact: 'A persisted key became anon-readable after restart — protections did not survive the reboot.',
  });
  await proveNoOwnerAlert(ctx, second);

  ctx.gate(
    'Discord',
    'discord-readback',
    "After restart, a project integration conforming to the generated SomniBot licensing protocol revalidates into the same fingerprint's session and resumes the configured heartbeat cadence; admin/portal listings match pre-restart state.",
    'generated-protocol revalidation and heartbeat resume require the built customer integration against live routes, while admin/portal readback requires dashboard surfaces — none are drivable by the bot-only harness',
  );
  gateSdkProtocolBranding(ctx);

  // The seeded ledger row never cascades (permanent forensic ledger — key delete
  // only DETACHES it) and would FK-block the products sweep on BOTH of this
  // scenario's handles (same guild, swept once per handle): remove it explicitly.
  await deleteSeededValidations(second, productId);
}

/**
 * RACE — concurrency is safe at the limit. The contracted last-free-slot atomicity
 * (two DIFFERENT devices, the FOR-UPDATE device-registration RPC) is route/RPC-only
 * and gated; the DB-level dedup guard (two concurrent inserts of the SAME fingerprint
 * resolve to one row via the UNIQUE index) runs now.
 */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}race-key`;

  const customerId = await seedCustomer(handle, discordId, 'e2e-license-race');
  const productId = await seedProduct(handle, `${ctx.runPrefix}race-product`);
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}race-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const fp = `${ctx.runPrefix}race-device`;

  // Two SIMULTANEOUS registrations of the same device fingerprint — the
  // UNIQUE(license_key_id, device_fingerprint) index decides the race at the DB:
  // exactly one row lands, no duplicate/over-allocation for that device.
  const [r1, r2] = key.id
    ? await Promise.all([
        seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }),
        seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }),
      ])
    : [{ id: null, error: 'no key' }, { id: null, error: 'no key' }];
  const winners = [r1, r2].filter((r) => r.id !== null).length;
  const losers = [r1, r2].filter((r) => r.id === null && r.error !== null).length;
  const total = key.id ? await countSessions(handle, key.id) : 0;
  ctx.expect(winners === 1 && losers === 1 && total === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two concurrent registrations of the same device resolve to exactly one session row — the DB-level UNIQUE guard settles the race with no duplicate/orphan.',
    observation: `concurrent inserts → winners=${winners}, losers=${losers}; session rows for the key=${total} (expected exactly 1).`,
    impact: 'A concurrent same-device race produced a duplicate/orphaned session — the DB-level guard did not settle the race.',
  });

  await proveAnonDenied(ctx, handle, {
    table: 'license_sessions',
    filterColumn: 'license_key_id',
    filterValue: key.id ?? '00000000-0000-0000-0000-000000000000',
    serviceSees: total === 1,
    promise: 'The single raced session stays anon-denied while the service role reads it.',
    impact: 'The raced session became anon-readable — session exposure under concurrency.',
  });
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'Discord',
    'db-observable',
    'Two NEW distinct devices racing for the last free slot resolve atomically — exactly one wins the slot, the other gets the branded device-limit rejection, and the active count never exceeds max-devices at any instant.',
    'that last-free-slot atomicity is the license_validate_device RPC (SELECT … FOR UPDATE + count check) invoked from POST /api/license/validate; the RPC is revoked from client roles and the route is not drivable here, so the cross-device limit race cannot be exercised — only the same-device UNIQUE guard is provable',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Both racing attempts are logged: one success and one device_limit rejection.',
    'the per-attempt license_validations rows are written by the validate route — not producible without the HTTP route',
  );
  gateSdkProtocolBranding(ctx);
}

/** Session ids under any of the given license keys (parent-scoping of the guild-less table). */
async function sessionIdsForKeys(handle: LiveClientHandle, keyIds: string[]): Promise<string[]> {
  if (keyIds.length === 0) return [];
  const { data } = await handle.supabase
    .from('license_sessions')
    .select('id')
    .in('license_key_id', keyIds);
  return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
}

/**
 * XGUILD — guild isolation is total. Keys are guild-scoped (distinct rows under
 * distinct guild_ids), the cross-guild admin lookup is not-found in both directions,
 * and the guild-less session table is isolated via its parent key ids — all
 * DB-observable. Per-guild rate-limit/log separation and per-guild branding are gated.
 */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const discordId = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyEnabled: false });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyEnabled: false });

  const custA = await seedCustomer(handleA, discordId, 'e2e-license-xg-a');
  const custB = await seedCustomer(handleB, discordId, 'e2e-license-xg-b');
  const prodA = await seedProduct(handleA, `${ctx.runPrefix}xg-product-a`);
  const prodB = await seedProduct(handleB, `${ctx.runPrefix}xg-product-b`);
  const orderA = custA && prodA ? await seedOrder(handleA, { customerId: custA, productId: prodA, orderNumber: `${ctx.runPrefix}xg-a-order` }) : null;
  const orderB = custB && prodB ? await seedOrder(handleB, { customerId: custB, productId: prodB, orderNumber: `${ctx.runPrefix}xg-b-order` }) : null;
  const keyA = custA && prodA && orderA ? await seedLicenseKey(handleA, { customerId: custA, productId: prodA, orderId: orderA, keyHash: hashKey(`${ctx.runPrefix}xg-key-a`), boundDiscordId: discordId }) : { id: null, error: 'na' };
  const keyB = custB && prodB && orderB ? await seedLicenseKey(handleB, { customerId: custB, productId: prodB, orderId: orderB, keyHash: hashKey(`${ctx.runPrefix}xg-key-b`), boundDiscordId: discordId }) : { id: null, error: 'na' };
  const sessA = keyA.id ? await seedSession(handleA, { licenseKeyId: keyA.id, deviceFingerprint: `${ctx.runPrefix}xg-dev-a` }) : { id: null, error: 'na' };
  const sessB = keyB.id ? await seedSession(handleB, { licenseKeyId: keyB.id, deviceFingerprint: `${ctx.runPrefix}xg-dev-b` }) : { id: null, error: 'na' };

  // Keys are guild-scoped: guild A enumerates only A's key, guild B only B's.
  const keysInA = await keyIdsForGuild(handleA, guildA);
  const keysInB = await keyIdsForGuild(handleB, guildB);
  ctx.expect(
    keyA.id !== null && keyB.id !== null &&
      keysInA.length === 1 && keysInA[0] === keyA.id &&
      keysInB.length === 1 && keysInB[0] === keyB.id &&
      keyA.id !== keyB.id,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: "Each guild enumerates only its OWN license keys: guild A sees its one key, guild B sees its own distinct key, and never the other's.",
      observation:
        `guild-A keys=${JSON.stringify(keysInA)} (expected [${keyA.id}]); guild-B keys=${JSON.stringify(keysInB)} (expected [${keyB.id}]); ` +
        `distinct=${keyA.id !== keyB.id}.`,
      impact: 'A guild enumerated another guild\'s license key — per-guild key isolation broken.',
    },
  );

  // The admin lookup is not-found in BOTH directions for a valid foreign key id.
  const bUnderA = keyB.id ? await readLicenseKeyScopedByGuild(handleA, keyB.id, guildA) : null;
  const aUnderB = keyA.id ? await readLicenseKeyScopedByGuild(handleB, keyA.id, guildB) : null;
  const aUnderA = keyA.id ? await readLicenseKeyScopedByGuild(handleA, keyA.id, guildA) : null;
  ctx.expect(aUnderA !== null && bUnderA === null && aUnderB === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Cross-guild key lookups return zero rows in both directions (owner A cannot touch guild B rows and vice versa), while each guild resolves its own key.',
    observation:
      `A's key under A's scope = ${aUnderA ? 'resolved' : 'nothing'}; ` +
      `B's key under A's scope = ${bUnderA ? 'RETURNED' : 'nothing'}; A's key under B's scope = ${aUnderB ? 'RETURNED' : 'nothing'} (both expected nothing).`,
    impact: 'A cross-guild key lookup returned the other guild\'s key — total isolation broken.',
  });

  // The guild-less session table is isolated via its parent key ids: guild A's key
  // ids reach only sessionA, never guild B's sessionB.
  const sessionsUnderA = await sessionIdsForKeys(handleA, keysInA);
  ctx.expect(
    sessA.id !== null && sessB.id !== null && sessionsUnderA.length === 1 && sessionsUnderA[0] === sessA.id && !sessionsUnderA.includes(sessB.id),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: "Sessions (which carry no guild_id) stay isolated via their parent key: guild A's key ids reach only guild A's session, never guild B's.",
      observation:
        `sessions under guild-A key ids = ${JSON.stringify(sessionsUnderA)} (expected [${sessA.id}]); ` +
        `guild-B session id=${sessB.id} present under A = ${sessB.id ? sessionsUnderA.includes(sessB.id) : 'n/a'} (expected false).`,
      impact: 'A guild-A-scoped session read reached a guild-B session — cross-guild session leakage through the parent key.',
    },
  );

  await proveAnonDenied(ctx, handleA, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: guildA,
    serviceSees: aUnderA !== null,
    promise: 'An anon client reads zero license_keys for guild A (anon and cross-guild clients cannot read keys).',
    impact: 'Guild A keys were readable anonymously — the isolation boundary leaks.',
  });
  await proveNoOwnerAlert(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB);

  ctx.gate(
    'Discord',
    'discord-readback',
    'Per-guild rate-limit counters and validation logs stay separate; each guild\'s license messages use that guild\'s own brand configuration.',
    'per-guild rate-limit state lives in the route limiter and per-guild brand kits render on generated-protocol/portal surfaces — needs the HTTP routes plus live surfaces to observe separation',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Validation logs carry the correct guild-scoped product for every attempt in each guild.',
    'the route writes license_validations per attempt with the resolved product/guild — not producible without driving the validate route',
  );
  gateSdkProtocolBranding(ctx);
}

/** Private row counter across guild_id tables (kept local; mirrors the runner's). */
async function countGuildRows(handle: LiveClientHandle, tables: readonly string[]): Promise<number> {
  let total = 0;
  for (const table of tables) {
    try {
      const { count } = await handle.supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', handle.guildId);
      total += count ?? 0;
    } catch {
      /* best-effort */
    }
  }
  return total;
}

/**
 * CLEANUP — run-prefixed license resources sweep to zero, and the sweep is
 * idempotent. Guild-less sessions/config cascade from their parents; the seeded
 * license_validations ledger rows do NOT (permanent forensic ledger,
 * 20260724110000: key deletion detaches via SET NULL) — the scenario removes its
 * own synthetic ledger rows explicitly before the sweep so the products delete is
 * not FK-blocked. The production anonymize-over-delete retention path stays GATED.
 */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const plaintext = `${ctx.runPrefix}cleanup-key`;

  // Full run-prefixed footprint: customer, product, config, order, key, entitlement,
  // session, validation ledger row.
  const customerId = await seedCustomer(handle, discordId, 'e2e-license-cleanup');
  const productId = await seedProduct(handle, `${ctx.runPrefix}cleanup-product`);
  const cfg = productId ? await seedLicenseConfig(handle, productId) : { error: 'no product' };
  const orderId = customerId && productId ? await seedOrder(handle, { customerId, productId, orderNumber: `${ctx.runPrefix}cleanup-order` }) : null;
  const key = customerId && productId && orderId
    ? await seedLicenseKey(handle, { customerId, productId, orderId, keyHash: hashKey(plaintext), boundDiscordId: discordId })
    : { id: null, error: 'arrange failed' };
  const ent = customerId && productId && orderId && key.id ? await seedEntitlement(handle, { customerId, productId, orderId, licenseKeyId: key.id }) : { id: null, error: 'no key' };
  const fp = `${ctx.runPrefix}cleanup-device`;
  const sess = key.id ? await seedSession(handle, { licenseKeyId: key.id, deviceFingerprint: fp }) : { id: null, error: 'no key' };
  const val = key.id && productId ? await seedValidation(handle, { licenseKeyId: key.id, productId, deviceFingerprint: fp, result: 'valid' }) : { id: null, error: 'no key' };

  const guildTables = ['entitlements', 'license_keys', 'orders', 'products', 'customers'];
  const before = await countGuildRows(handle, guildTables);
  const sessionsBefore = key.id ? await countSessions(handle, key.id) : 0;
  const validationsBefore = key.id ? (await readValidations(handle, key.id)).length : 0;
  ctx.expect(before >= 5 && sessionsBefore === 1 && validationsBefore === 1 && cfg.error === null && ent.id !== null, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed license resources across customers/products/config/orders/keys/entitlements/sessions/validations (pre-cleanup baseline).',
    observation: `pre-cleanup guild rows=${before} (expected >=5); sessions=${sessionsBefore}, validations=${validationsBefore}, config err=${cfg.error ?? 'none'}, entitlement=${ent.id !== null}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed license rows.',
  });

  // Off-theme classes while the rows still exist.
  proveHashOnlyStorage(ctx, key.id ? await readLicenseKey(handle, key.id) : null, plaintext);
  await proveAnonDenied(ctx, handle, {
    table: 'license_keys',
    filterColumn: 'guild_id',
    filterValue: handle.guildId,
    serviceSees: key.id !== null,
    promise: 'Before cleanup the key is service-visible and anon-denied (RLS unaffected by the pending sweep).',
    impact: 'A key was anon-readable — RLS exposure.',
  });
  await proveNoOwnerAlert(ctx, handle);

  // Cleanup pass: the seeded ledger row must go FIRST — it never cascades
  // (key deletion only detaches it via SET NULL) and its product_id FK would
  // block the products delete — then the sweep (the same one teardown uses)
  // → zero run-prefixed rows; guild-less sessions/config cascade away with
  // their parent key/product.
  const keyId = key.id;
  const prodId = productId;
  await deleteSeededValidations(handle, prodId);
  await ctx.sweepGuildRows(handle);
  const afterGuild = await countGuildRows(handle, guildTables);
  const sessionsAfter = keyId ? await countSessions(handle, keyId) : 0;
  const validationsAfter = prodId ? await countValidationsForProduct(handle, prodId) : -1;
  const configAfter = prodId ? await readConfig(handle, prodId) : null;
  ctx.expect(afterGuild === 0 && sessionsAfter === 0 && validationsAfter === 0 && configAfter === null, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The cleanup pass removes every run-prefixed license row: the seeded validation-ledger rows are deleted explicitly (they never cascade — permanent forensic ledger), then the sweep deletes the guild-scoped rows and the guild-less sessions/config cascade away with their parent key/product.',
    observation: `post-sweep guild rows=${afterGuild}; sessions=${sessionsAfter}, ledger rows for the run product=${validationsAfter}, config present=${configAfter !== null} (all expected 0/absent).`,
    impact: 'The cleanup sweep left run-prefixed license rows behind — the suite leaves residue in the disposable database.',
  });

  // A second sweep is an error-free no-op (idempotent teardown).
  await ctx.sweepGuildRows(handle);
  const afterSecond = await countGuildRows(handle, guildTables);
  ctx.expect(afterSecond === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A second cleanup pass is an error-free no-op (still zero run-prefixed license rows).',
    observation: `after a second sweep, guild rows = ${afterSecond}.`,
    impact: 'A second cleanup pass changed state or left residue — teardown is not idempotent.',
  });

  ctx.gate(
    'audit',
    'audit-row',
    'Validation-log audit rows for the run persist (anonymized, not deleted) under the anonymize-over-delete retention.',
    'the production retention path (20260724110000: key deletion DETACHES ledger rows via ON DELETE SET NULL; PII anonymized by the scrub_expired_license_validations daily cron, never deleted) is a cron behavior with a 60-day floor — not exercisable in a single harness run; the suite deleting its own synthetic seeded ledger rows above is test hygiene, not that path',
  );
  gateDiscordMembership(ctx);
  gateSdkProtocolBranding(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The generated SomniBot licensing contract + validation protocol domain proof.
 * guildScopedTables are child→parent
 * so FK-constrained rows are removed before their parents (guild_config + guild are
 * always swept in addition by the runner). product_license_config and
 * license_sessions are intentionally OMITTED: they carry no guild_id and cascade
 * from products / license_keys (deleting the parent removes them).
 * license_validations carries no guild_id EITHER and does NOT cascade
 * (20260724110000: permanent forensic ledger — key deletion detaches via SET
 * NULL), so each scenario that seeds a ledger row deletes it explicitly via
 * deleteSeededValidations before the sweep; otherwise the surviving row's
 * product_id FK blocks the products delete and leaves run-prefixed residue.
 * audit_logs is likewise omitted so the sweep never touches the audit trail.
 */
export const infrastructureLicenseSdkProof: DomainProof = {
  domainId: 'infrastructure-license-sdk',
  guildScopedTables: [
    'entitlements',
    'license_keys',
    'orders',
    'products',
    'customers',
    'alerts',
  ],
  scripts: {
    DEF,
    'SET-A': SET_A,
    'SET-B': SET_B,
    INVALID,
    UNAUTH,
    DEPFAIL,
    RETRY,
    REPLAY,
    RESTART,
    RACE,
    XGUILD,
    CLEANUP,
  },
};
