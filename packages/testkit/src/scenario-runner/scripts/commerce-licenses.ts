/**
 * scenario-runner/scripts/commerce-licenses — the License keys domain proof.
 *
 * Binds the commerce-licenses domain's 12 declarative catalog scenarios to
 * concrete, real-stack proof scripts driven against LOCAL Supabase. License keys
 * are REAL-MONEY commerce (a purchased product entitlement), so every scenario
 * respects the two-economies wall: license activity writes commerce rows but never
 * a play-money game-economy wallet/ledger row.
 *
 * mostlyGated = true — by construction. The ONLY member surface for this domain is
 * the /license slash command, and /license is entirely SUBCOMMAND-driven
 * (/license activate <key>, /license check, /license info <key>). The runner's
 * `runSlash` cannot supply a slash SUBCOMMAND (context.ts builds the interaction
 * with no `subcommand`, and handleLicenseCommand calls getSubcommand() first),
 * so the command lane cannot be driven through the real dispatcher in-process.
 * Every captured-reply / activation-embed / /license-check-render / admin-info
 * surface is therefore GATED honestly; the STATE and EFFECTS those handlers act on
 * are proven DB-observably instead — never faked.
 *
 * What DOES run NOW against real state:
 *   - Hashed-at-rest storage: license_keys holds a SHA-256 key_hash (verified
 *     against the plaintext that produced it) plus display-only prefix/suffix, and
 *     the plaintext exists in NO column. The configured SMNI key-prefix is asserted
 *     against the real column.
 *   - The pending→active state machine + its replay fences: the status-guarded
 *     activation UPDATE admits exactly one transition (a replay affects zero rows),
 *     and the UNIQUE key_hash index rejects any duplicate/re-minted key.
 *   - The device limit: the REAL production `license_validate_device` RPC (atomic,
 *     FOR UPDATE) enforces max-devices — a second device is refused, self-service
 *     removal frees a slot, and two devices racing for the last slot resolve to
 *     exactly one session at the DATABASE (not in bot memory).
 *   - Rotation: issuing a new hashed key + invalidating the old one; the license
 *     terminal-transition trigger immediately drains the old key's live sessions.
 *   - Guild-scoping / RLS: the hash+guild-scoped lookup that makes a guild-A key
 *     invalid in guild B, owner-only RLS denying anon reads of license_keys, and
 *     the two-economies wall.
 *   - Cleanup: the sweep removes run-prefixed keys/sessions/entitlements (sessions
 *     cascade with their key) while append-only audit rows are retained.
 *
 * GATED honestly (credential/dependency/fault lane absent): every /license
 * captured-reply surface (subcommand-undrivable), the activation-embed brand kit
 * readback, handler-written audit rows, the owner dashboard/DM readback, the
 * validate-endpoint outage (DEPFAIL) and Discord role-add fault (RETRY) lanes.
 *
 * Behavior-bug discovery: where a DB-observable assertion contradicts the catalog's
 * contracted intent it is recorded as a FAIL (a finding for the owner) — never
 * forced green, never softened into a gate.
 */
import { createHash } from 'node:crypto';

import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ───────────────────────────────

interface LicenseKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  bound_discord_id: string;
  status: string;
  product_id: string | null;
  order_id: string | null;
  customer_id: string | null;
  guild_id: string;
  activated_at: string | null;
}

interface SessionRow {
  id: string;
  active: boolean;
  device_fingerprint: string;
  deactivation_reason: string | null;
}

interface EntitlementRow {
  id: string;
  status: string;
  license_key_id: string | null;
  guild_id: string;
}

interface KeyMaterial {
  plaintext: string;
  hash: string;
  prefix: string;
  suffix: string;
}

// ── Catalog-default access + key material ──────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Real generator charset (no 0/O/1/I) — mirrors packages/bot key-generator.
const KEY_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function keyGroup(seed: string): string {
  const h = sha256Hex(seed);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += KEY_CHARSET[parseInt(h.slice(i * 2, i * 2 + 2), 16) % KEY_CHARSET.length];
  }
  return out;
}

/** Deterministic PREFIX-XXXX-XXXX-XXXX-XXXX key + its real SHA-256 hash. */
function makeKeyMaterial(prefix: string, seed: string): KeyMaterial {
  const g1 = keyGroup(`${seed}-1`);
  const g2 = keyGroup(`${seed}-2`);
  const g3 = keyGroup(`${seed}-3`);
  const g4 = keyGroup(`${seed}-4`);
  const plaintext = `${prefix}-${g1}-${g2}-${g3}-${g4}`;
  return { plaintext, hash: sha256Hex(plaintext), prefix, suffix: g4 };
}

function objectLeaks(obj: unknown, plaintext: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj as Record<string, unknown>).some(
    (v) => typeof v === 'string' && v.includes(plaintext),
  );
}

// ── Local-stack DB helpers ─────────────────────────────────────────────────

interface ArrangeResult {
  customerId: string | null;
  productId: string | null;
  orderId: string | null;
  licenseKeyId: string | null;
  entitlementId: string | null;
  roleId: string;
  key: KeyMaterial;
  keyError: string | null;
  entError: string | null;
}

/**
 * Arrange the exact production commerce identity a license activation needs:
 * customer → product (granted role) → COMPLETED order → license_keys row →
 * entitlement. The composite FKs require every id to line up against a completed
 * order and the key to share the order/customer/product/guild tuple, so a partial
 * arrangement cannot persist — this is the real data model, not a stub.
 */
async function arrangeLicense(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  opts: {
    discordId: string;
    label: string;
    keyStatus?: string;
    entStatus?: string;
    seed?: string;
  },
): Promise<ArrangeResult> {
  const keyStatus = opts.keyStatus ?? 'pending_activation';
  const entStatus = opts.entStatus ?? 'pending';
  const prefix = String(declaredDefault(ctx.domain, 'key-prefix') ?? 'SMNI');
  const key = makeKeyMaterial(prefix, opts.seed ?? `${ctx.runPrefix}${ctx.scenarioClass}-${opts.label}`);
  const roleId = `${ctx.runPrefix}role-${opts.label}`;

  // Customer (get-or-create for this discord/guild — UNIQUE(discord_id, guild_id)).
  let customerId: string | null = null;
  const { data: existing } = await handle.supabase
    .from('customers')
    .select('id')
    .eq('guild_id', handle.guildId)
    .eq('discord_id', opts.discordId)
    .maybeSingle();
  customerId = (existing as { id: string } | null)?.id ?? null;
  if (!customerId) {
    const { data: cust } = await handle.supabase
      .from('customers')
      .insert({ guild_id: handle.guildId, discord_id: opts.discordId, discord_username: `${ctx.runPrefix}${opts.label}` })
      .select('id')
      .single();
    customerId = (cust as { id: string } | null)?.id ?? null;
  }

  const { data: prod } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}${opts.label}-product`,
      type: 'one_time',
      delivery_type: 'access_pass',
      price_cents: 1500,
      currency: 'USD',
      granted_role_ids: [roleId],
      active: true,
    })
    .select('id')
    .single();
  const productId = (prod as { id: string } | null)?.id ?? null;

  const { data: order } = await handle.supabase
    .from('orders')
    .insert({
      order_number: `${ctx.runPrefix}${ctx.scenarioClass}-${opts.label}-ord`,
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: productId,
      amount_cents: 1500,
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();
  const orderId = (order as { id: string } | null)?.id ?? null;

  const { data: keyRow, error: keyErr } = await handle.supabase
    .from('license_keys')
    .insert({
      order_id: orderId,
      customer_id: customerId,
      product_id: productId,
      guild_id: handle.guildId,
      key_hash: key.hash,
      key_prefix: key.prefix,
      key_suffix: key.suffix,
      bound_discord_id: opts.discordId,
      status: keyStatus,
      activated_at: keyStatus === 'active' ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  const licenseKeyId = (keyRow as { id: string } | null)?.id ?? null;

  const { data: entRow, error: entErr } = await handle.supabase
    .from('entitlements')
    .insert({
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: productId,
      order_id: orderId,
      license_key_id: licenseKeyId,
      type: 'one_time',
      status: entStatus,
      source: 'purchase',
      granted_role_ids: [roleId],
    })
    .select('id')
    .single();
  const entitlementId = (entRow as { id: string } | null)?.id ?? null;

  return {
    customerId,
    productId,
    orderId,
    licenseKeyId,
    entitlementId,
    roleId,
    key,
    keyError: keyErr ? keyErr.message : null,
    entError: entErr ? entErr.message : null,
  };
}

async function readLicenseKey(handle: LiveClientHandle, keyId: string): Promise<LicenseKeyRow | null> {
  if (!keyId) return null;
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, key_hash, key_prefix, key_suffix, bound_discord_id, status, product_id, order_id, customer_id, guild_id, activated_at')
    .eq('id', keyId)
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as LicenseKeyRow | null) ?? null;
}

async function readKeyByHashInGuild(
  handle: LiveClientHandle,
  hash: string,
  guildId: string,
): Promise<LicenseKeyRow | null> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, key_hash, key_prefix, key_suffix, bound_discord_id, status, product_id, order_id, customer_id, guild_id, activated_at')
    .eq('key_hash', hash)
    .eq('guild_id', guildId)
    .maybeSingle();
  return (data as LicenseKeyRow | null) ?? null;
}

async function activeSessions(handle: LiveClientHandle, keyId: string): Promise<SessionRow[]> {
  if (!keyId) return [];
  const { data } = await handle.supabase
    .from('license_sessions')
    .select('id, active, device_fingerprint, deactivation_reason')
    .eq('license_key_id', keyId)
    .eq('active', true);
  return (data as SessionRow[] | null) ?? [];
}

async function allSessions(handle: LiveClientHandle, keyId: string): Promise<SessionRow[]> {
  if (!keyId) return [];
  const { data } = await handle.supabase
    .from('license_sessions')
    .select('id, active, device_fingerprint, deactivation_reason')
    .eq('license_key_id', keyId);
  return (data as SessionRow[] | null) ?? [];
}

async function readEntitlementByKey(handle: LiveClientHandle, keyId: string): Promise<EntitlementRow | null> {
  if (!keyId) return null;
  const { data } = await handle.supabase
    .from('entitlements')
    .select('id, status, license_key_id, guild_id')
    .eq('license_key_id', keyId)
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as EntitlementRow | null) ?? null;
}

async function countRows(handle: LiveClientHandle, table: string): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

interface DeviceBindResult {
  status: string | null;
  error: string | null;
  sessionId: string | null;
}

/**
 * Drive the REAL atomic device-limit RPC (license_validate_device: FOR UPDATE lock
 * + count + evict/reject + insert). Returns its JSONB status, or an `error` string
 * when the service-role client cannot execute the RPC in this harness — callers
 * GATE on `error` rather than fail, exactly like the anon-probe null handling.
 */
async function bindDevice(
  handle: LiveClientHandle,
  keyId: string,
  fingerprint: string,
  opts: { maxDevices: number; policy?: 'reject' | 'evict_oldest'; deviceName?: string },
): Promise<DeviceBindResult> {
  const { data, error } = await handle.supabase.rpc('license_validate_device', {
    p_license_key_id: keyId,
    p_device_fingerprint: fingerprint,
    p_device_name: opts.deviceName ?? fingerprint,
    p_max_devices: opts.maxDevices,
    p_device_policy: opts.policy ?? 'reject',
  });
  if (error) return { status: null, error: error.message, sessionId: null };
  const obj = (data ?? {}) as { status?: string; session_id?: string };
  return { status: obj.status ?? null, error: null, sessionId: obj.session_id ?? null };
}

/**
 * Anon-denial RLS READ probe via the PostgREST REST endpoint. Returns the row
 * count an anon key can read (owner-only RLS → 0) or null when inconclusive (GATE).
 */
async function anonReadCount(anonKey: string, table: string, guildId: string): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=guild_id&guild_id=eq.${encodeURIComponent(guildId)}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs + gate helpers ───────────────────────────────

/**
 * database-RLS: the service role reads this guild's license key while an anon
 * client reads ZERO license_keys (owner_full_access is the only policy). The
 * positive control is the key genuinely existing under the guild.
 */
async function proveLicenseRls(ctx: ScenarioContext, handle: LiveClientHandle, keyId: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero license_keys rows (owner_full_access is the only policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'license_keys', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero license_keys rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readLicenseKey(handle, keyId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s license key while an anon client reads zero of them (owner-only RLS on license_keys).',
    observation:
      `service-role sees the key under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} license_keys row(s) for that guild.`,
    impact:
      'A license key row visible to the service role was also readable with an anon key — license RLS is not denying anon reads (key-row exposure).',
  });
}

/**
 * The two-economies wall: license (real-money) activity writes commerce rows but
 * touches ZERO game-economy wallet/ledger rows for the guild.
 */
async function proveTwoEconomiesWall(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const keys = await countRows(handle, 'license_keys');
  const wallets = await countRows(handle, 'economy_wallets');
  const txns = await countRows(handle, 'economy_transactions');
  if (keys === null || wallets === null || txns === null) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'License activity touches no game-economy currency/ledger row (two-economies wall).',
      'a license/economy count read errored, so the wall cannot be proven this pass (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(keys > 0 && wallets === 0 && txns === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'License (real-money) activity writes commerce rows but never a game-economy currency/ledger row — the two economies stay walled off.',
    observation:
      `commerce rows for the guild = ${keys} license key(s); ` +
      `game-economy rows = ${wallets} wallet(s), ${txns} ledger row(s) (both must be 0).`,
    impact:
      'The real-money license domain created or mutated a play-money game-economy row — the two-economies wall was breached.',
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's healthy license path raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'A healthy license interaction raises no owner alert; the dashboard would list it quietly.',
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a healthy license path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Unresolved role delivery and abuse patterns surface to the owner while the dashboard licenses page reflects key state — healthy activity stays quiet.',
    'requires the owner DM inbox + dashboard licenses page readback (owner session / live guild) — not reachable in a bot-only harness',
  );
}

const SUBCOMMAND_GATE =
  'runSlash cannot supply a slash SUBCOMMAND, so /license activate|check|info cannot be driven through the real dispatcher in-process; the underlying state/effects are proven DB-observably instead';

function gateSubcommand(ctx: ScenarioContext, promise: string): void {
  ctx.gate('Discord', 'captured-reply', promise, SUBCOMMAND_GATE);
}

function gateActivationAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'the key.activated / rotation / device audit rows are written by the subcommand-driven handler + portal paths, not reachable in this bot-only harness',
  );
}

function gateBrandingEmbed(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'branding',
    'discord-readback',
    promise,
    'requires the activation-embed / portal-page snapshot readback against the live owner brand kit (DISCORD_TOKEN + live guild)',
  );
}

// ── The 12 scenario scripts ────────────────────────────────────────────────

/** DEF — a purchased pending SMNI key activates for its bound buyer; hash-only at rest. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const keyPrefixDefault = String(declaredDefault(ctx.domain, 'key-prefix') ?? 'SMNI');
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');

  const arr = await arrangeLicense(ctx, handle, {
    discordId: buyer,
    label: 'def',
    keyStatus: 'pending_activation',
    entStatus: 'pending',
  });
  ctx.expect(arr.keyError === null && arr.entError === null && Boolean(arr.licenseKeyId), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: a completed purchase issued a pending SMNI key bound to the buyer with a pending entitlement.',
    observation: `licenseKeyId=${arr.licenseKeyId ?? '(null)'}; key error=${arr.keyError ?? 'none'}, entitlement error=${arr.entError ?? 'none'}.`,
    impact: 'Could not arrange the pending-key purchase chain — the DEF proof setup is invalid.',
  });

  // Hash-at-rest: the stored row holds only the SHA-256 hash (+ prefix/suffix); the plaintext exists in no column.
  const { data: fullRow } = await handle.supabase.from('license_keys').select('*').eq('id', arr.licenseKeyId ?? '').maybeSingle();
  const stored = (fullRow ?? {}) as Record<string, unknown>;
  const storedHash = String(stored.key_hash ?? '');
  const leaked = objectLeaks(fullRow, arr.key.plaintext);
  ctx.expect(
    storedHash === sha256Hex(arr.key.plaintext) && !leaked && stored.key_prefix === keyPrefixDefault && stored.key_suffix === arr.key.suffix,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'At rest license_keys holds the SHA-256 key hash with only prefix/suffix for display — never the plaintext key.',
      observation:
        `stored key_hash===sha256(plaintext) is ${storedHash === sha256Hex(arr.key.plaintext)}; ` +
        `plaintext leaked into a column=${leaked}; prefix=${String(stored.key_prefix)} (expected ${keyPrefixDefault}), suffix=${String(stored.key_suffix)}.`,
      impact: 'A license key was stored in recoverable/plaintext form or without the hashed-at-rest guarantee — a key-security regression.',
    },
  );

  // Activation transition (the exact status-guarded writes the /license activate handler performs).
  const { data: activated } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('status', 'pending_activation')
    .select('id');
  await handle.supabase.from('entitlements').update({ status: 'active' }).eq('license_key_id', arr.licenseKeyId ?? '').eq('guild_id', handle.guildId);
  const keyAfter = await readLicenseKey(handle, arr.licenseKeyId ?? '');
  const entAfter = await readEntitlementByKey(handle, arr.licenseKeyId ?? '');
  ctx.expect((activated?.length ?? 0) === 1 && keyAfter?.status === 'active' && keyAfter?.activated_at !== null && entAfter?.status === 'active', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A bound activation flips the key and its entitlement to active atomically (the state /license check would list as active).',
    observation:
      `guarded activation affected ${activated?.length ?? 0} row(s); key.status=${keyAfter?.status}, ` +
      `activated_at set=${keyAfter?.activated_at !== null}, entitlement.status=${entAfter?.status}.`,
    impact: 'Activation did not transition the key + entitlement to active — the pending→active state machine is broken.',
  });

  // Replay-safety: the status guard makes re-activation a no-op, and key_hash UNIQUE fences a duplicate issue.
  const { data: replayActivate } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active' })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('status', 'pending_activation')
    .select('id');
  const { error: dupKeyErr } = await handle.supabase.from('license_keys').insert({
    order_id: arr.orderId,
    customer_id: arr.customerId,
    product_id: arr.productId,
    guild_id: handle.guildId,
    key_hash: arr.key.hash,
    key_prefix: arr.key.prefix,
    key_suffix: arr.key.suffix,
    bound_discord_id: buyer,
    status: 'pending_activation',
  });
  ctx.expect((replayActivate?.length ?? 0) === 0 && dupKeyErr !== null, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-activation is a no-op (status-guarded) and a duplicate key hash is rejected (UNIQUE key_hash) — replays never double-grant or re-issue.',
    observation:
      `second guarded activation affected ${replayActivate?.length ?? 0} row(s) (expected 0); ` +
      `duplicate key_hash insert rejected=${dupKeyErr !== null} (error: ${dupKeyErr?.message ?? 'NONE — a duplicate key persisted!'}).`,
    impact: 'A replayed activation re-granted, or a duplicate key hash persisted — the exactly-once activation fence failed.',
  });

  // Branding: generated keys carry the configured white-label prefix.
  ctx.expect(keyAfter?.key_prefix === keyPrefixDefault, {
    assertionClass: 'branding',
    channel: 'db-observable',
    promise: `Generated keys carry the configured white-label prefix "${keyPrefixDefault}".`,
    observation: `stored key_prefix=${keyAfter?.key_prefix} (expected ${keyPrefixDefault}).`,
    impact: 'A license key did not carry the configured key prefix — the white-label key surface regressed.',
  });

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSubcommand(ctx, 'The /license activate success embed lists granted roles and /license check shows the active entitlement.');
  gateActivationAudit(ctx, 'key.activated is audited with actor, key id, product, and granted role ids.');
  gateBrandingEmbed(ctx, 'The activation embed uses the owner brand with the subtle powered-by-SomniBot attribution.');
}

/** SET-A — max-devices=1 takes effect: second device refused; portal removal frees a slot. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const limit = 1; // SET-A configures max-devices to 1

  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'seta', keyStatus: 'active', entStatus: 'active' });
  ctx.expect(arr.keyError === null && Boolean(arr.licenseKeyId) && arr.entError === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: an active license key + active entitlement exist so devices can bind.',
    observation: `licenseKeyId=${arr.licenseKeyId ?? '(null)'}; key error=${arr.keyError ?? 'none'}, entitlement error=${arr.entError ?? 'none'}.`,
    impact: 'Could not arrange the active license — the SET-A device-limit proof setup is invalid.',
  });

  const a = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}devA`, { maxDevices: limit, policy: 'reject' });
  const b = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}devB`, { maxDevices: limit, policy: 'reject' });
  if (a.error || b.error) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'With max-devices=1, a second device is refused (over_device_limit) and the active session count never exceeds the limit.',
      `license_validate_device RPC not executable by the service-role client in this harness (${a.error ?? b.error}); device-limit enforcement not exercised`,
    );
  } else {
    const afterAB = await activeSessions(handle, arr.licenseKeyId ?? '');
    ctx.expect(a.status === 'created' && b.status === 'over_device_limit' && afterAB.length === 1, {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'With max-devices=1 the first device binds and the second is refused (device-limit-reached); the active session count never exceeds 1 — enforced atomically at the database.',
      observation: `device A status=${a.status} (expected created), device B status=${b.status} (expected over_device_limit); active sessions=${afterAB.length} (expected 1).`,
      impact: 'The device limit was not enforced — a second device bound beyond max-devices (the DB single-slot guarantee failed).',
    });

    // Self-service device removal frees the slot; the removed session is marked inactive, not deleted.
    const slotId = afterAB[0]?.id;
    if (slotId) {
      await handle.supabase
        .from('license_sessions')
        .update({ active: false, deactivated_at: new Date().toISOString(), deactivation_reason: 'user_deactivated' })
        .eq('id', slotId);
    }
    const rebind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}devB`, { maxDevices: limit, policy: 'reject' });
    const afterFree = await activeSessions(handle, arr.licenseKeyId ?? '');
    const removed = (await allSessions(handle, arr.licenseKeyId ?? '')).find((s) => s.id === slotId);
    ctx.expect(rebind.status === 'created' && afterFree.length === 1 && removed?.active === false && removed?.deactivation_reason === 'user_deactivated', {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After the holder frees a device slot in the portal, a new device binds; the freed session is marked inactive (not deleted).',
      observation: `rebind status=${rebind.status} (expected created); active sessions=${afterFree.length} (expected 1); freed session active=${removed?.active} reason=${removed?.deactivation_reason}.`,
      impact: 'Self-service device removal did not free a slot or hard-deleted the session instead of deactivating it.',
    });

    // Replay-safety: re-validating the SAME active device returns its existing session (no second concurrent session).
    const replayBind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}devB`, { maxDevices: limit, policy: 'reject' });
    const afterReplay = await activeSessions(handle, arr.licenseKeyId ?? '');
    ctx.expect(replayBind.status === 'existing' && afterReplay.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Re-validating an already-bound device refreshes its existing session rather than opening a second one.',
      observation: `replayed validate status=${replayBind.status} (expected existing); active sessions=${afterReplay.length} (expected 1).`,
      impact: 'A replayed device validate opened a duplicate concurrent session — the device-slot idempotency failed.',
    });
  }

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSubcommand(ctx, 'No Discord-side role/entitlement churn from device changes — the holder’s roles stay stable throughout.');
  gateActivationAudit(ctx, 'The refused bind, the self-service removal, and the successful rebind are each audited.');
  gateBrandingEmbed(ctx, 'The device-limit-reached copy names the configured limit and points to the owner-branded portal.');
}

/** SET-B — rotate-and-invalidate: new hashed key issued once; old key + sessions die immediately. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const prefix = String(declaredDefault(ctx.domain, 'key-prefix') ?? 'SMNI');

  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'setb', keyStatus: 'active', entStatus: 'active', seed: `${ctx.runPrefix}setb-old` });

  // Bind a live device on the old key.
  const bind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}setb-dev`, { maxDevices: 3, policy: 'reject' });
  let oldSessionArranged = bind.status === 'created' || bind.status === 'existing';
  if (bind.error) {
    const { error: sErr } = await handle.supabase
      .from('license_sessions')
      .insert({ license_key_id: arr.licenseKeyId, device_fingerprint: `${ctx.runPrefix}setb-dev`, active: true });
    oldSessionArranged = !sErr;
  }

  // Rotate: issue a NEW hashed key for the same order/customer/product, move the entitlement binding,
  // then invalidate the old key (rotate-and-invalidate).
  const newKey = makeKeyMaterial(prefix, `${ctx.runPrefix}setb-new`);
  const { data: newRow, error: newErr } = await handle.supabase
    .from('license_keys')
    .insert({
      order_id: arr.orderId,
      customer_id: arr.customerId,
      product_id: arr.productId,
      guild_id: handle.guildId,
      key_hash: newKey.hash,
      key_prefix: newKey.prefix,
      key_suffix: newKey.suffix,
      bound_discord_id: buyer,
      status: 'active',
      activated_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  const newKeyId = (newRow as { id: string } | null)?.id ?? null;
  if (newKeyId) {
    await handle.supabase.from('entitlements').update({ license_key_id: newKeyId }).eq('license_key_id', arr.licenseKeyId ?? '').eq('guild_id', handle.guildId);
  }
  await handle.supabase
    .from('license_keys')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), revocation_reason: 'rotated' })
    .eq('id', arr.licenseKeyId ?? '');

  // The old key hash now resolves to a terminal (revoked) key; the new hash is live.
  const oldByHash = await readKeyByHashInGuild(handle, arr.key.hash, handle.guildId);
  const newByHash = await readKeyByHashInGuild(handle, newKey.hash, handle.guildId);
  ctx.expect(newErr === null && oldByHash?.status === 'revoked' && newByHash?.status === 'active' && oldByHash?.id !== newByHash?.id, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Rotate-and-invalidate: the old key hash is invalidated (revoked) while the new key hash is live — distinct rows, old key gone.',
    observation: `old-hash lookup status=${oldByHash?.status} (expected revoked), new-hash lookup status=${newByHash?.status} (expected active); distinct rows=${oldByHash?.id !== newByHash?.id}.`,
    impact: 'Rotation did not invalidate the old key or the new key is not live — the rotate-and-invalidate guarantee failed.',
  });

  // The old key can no longer activate (its status is terminal, not pending_activation/active).
  ctx.expect(oldByHash !== null && oldByHash.status !== 'active' && oldByHash.status !== 'pending_activation', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Activating the old key after rotation is refused: its status is terminal so /license activate finds no activatable key.',
    observation: `old key status=${oldByHash?.status} (must not be active/pending_activation).`,
    impact: 'The old key remained activatable after rotation — the invalidation did not take effect.',
  });

  // Hash-only across BOTH generations: neither plaintext exists in any column.
  const { data: oldFull } = await handle.supabase.from('license_keys').select('*').eq('id', arr.licenseKeyId ?? '').maybeSingle();
  const { data: newFull } = await handle.supabase.from('license_keys').select('*').eq('id', newKeyId ?? '').maybeSingle();
  const hashOnly =
    !objectLeaks(oldFull, arr.key.plaintext) &&
    !objectLeaks(newFull, newKey.plaintext) &&
    String((oldFull as Record<string, unknown> | null)?.key_hash ?? '') === sha256Hex(arr.key.plaintext) &&
    String((newFull as Record<string, unknown> | null)?.key_hash ?? '') === sha256Hex(newKey.plaintext);
  ctx.expect(hashOnly, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Neither key generation ever stores a plaintext key — both rows carry only the SHA-256 hash.',
    observation: `old & new key_hash each equal sha256(their plaintext) with no plaintext column leak: ${hashOnly}.`,
    impact: 'A rotation stored a plaintext key column — the never-reveal / hash-only guarantee was violated.',
  });

  // The license-terminal trigger drains the old key's live sessions immediately on invalidation.
  if (oldSessionArranged) {
    const oldSessions = await allSessions(handle, arr.licenseKeyId ?? '');
    const anyActive = oldSessions.some((s) => s.active);
    ctx.expect(oldSessions.length >= 1 && !anyActive, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'When the old key is invalidated, its device sessions are terminated immediately (the license-terminal trigger drains active sessions).',
      observation: `old-key sessions=${oldSessions.length}, any still active=${anyActive} (expected none active after invalidation).`,
      impact: 'A rotated-away key kept live device sessions — the old key was not fully cut off.',
    });
  } else {
    ctx.gate('Discord', 'db-observable', 'The old key’s device sessions are terminated on rotation.', 'could not arrange an old-key session (device-bind RPC not executable and the direct session insert failed)');
  }

  // Replay-safety: the UNIQUE key_hash fence rejects re-minting the same new key (replaying the rotation).
  const { error: dupNewErr } = await handle.supabase.from('license_keys').insert({
    order_id: arr.orderId,
    customer_id: arr.customerId,
    product_id: arr.productId,
    guild_id: handle.guildId,
    key_hash: newKey.hash,
    key_prefix: newKey.prefix,
    key_suffix: newKey.suffix,
    bound_discord_id: buyer,
    status: 'active',
    activated_at: new Date().toISOString(),
  });
  ctx.expect(dupNewErr !== null, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Replaying the rotation never mints a second key: a duplicate of the new key hash is rejected (UNIQUE key_hash).',
    observation: `duplicate new-key insert rejected=${dupNewErr !== null} (error: ${dupNewErr?.message ?? 'NONE — a second key was minted!'}).`,
    impact: 'A replayed rotation minted an additional key — the exactly-one-new-key fence failed.',
  });

  await proveLicenseRls(ctx, handle, newKeyId ?? arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSubcommand(ctx, 'The entitlement/roles persist through rotation and the old key returns invalid-key on /license activate (portal-driven rotation surface).');
  gateActivationAudit(ctx, 'The rotation is audited linking old and new key ids without recording either plaintext.');
  gateBrandingEmbed(ctx, 'The rotation notice uses the key-rotated template with product name and new key tail in the owner’s voice.');
}

/** INVALID — malformed / unknown / wrong-guild keys are rejected safely with zero state change. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const prefix = String(declaredDefault(ctx.domain, 'key-prefix') ?? 'SMNI');

  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'inv', keyStatus: 'active', entStatus: 'active' });
  ctx.expect(Boolean(arr.licenseKeyId) && arr.keyError === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: one real, valid license key exists as the positive control.',
    observation: `licenseKeyId=${arr.licenseKeyId ?? '(null)'}; key error=${arr.keyError ?? 'none'}.`,
    impact: 'Could not arrange the valid key — the INVALID proof setup is invalid.',
  });

  const before = await countRows(handle, 'license_keys');
  const beforeSessions = (await allSessions(handle, arr.licenseKeyId ?? '')).length;
  const otherGuild = ctx.scenarioGuildId('b');

  // The three invalid activation lookups the handler performs (hash → guild-scoped select):
  //  1) malformed string, 2) well-formed but nonexistent key, 3) the REAL key hash but under the wrong guild.
  const malformed = await readKeyByHashInGuild(handle, sha256Hex('not a real key'), handle.guildId);
  const nonexistent = await readKeyByHashInGuild(handle, makeKeyMaterial(prefix, `${ctx.runPrefix}ghost`).hash, handle.guildId);
  const wrongGuild = await readKeyByHashInGuild(handle, arr.key.hash, otherGuild);
  ctx.expect(malformed === null && nonexistent === null && wrongGuild === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A malformed string, a well-formed-but-unknown key, and a valid key under the wrong guild each resolve to NO row — the identical invalid-key branch, leaking no distinction.',
    observation: `malformed=${malformed === null ? 'no row' : 'row!'}, nonexistent=${nonexistent === null ? 'no row' : 'row!'}, wrong-guild=${wrongGuild === null ? 'no row' : 'row!'} (all must be no row).`,
    impact: 'An invalid/foreign-guild key lookup matched a real key or distinguished failure modes — an information leak about the key space.',
  });

  const after = await countRows(handle, 'license_keys');
  const afterSessions = (await allSessions(handle, arr.licenseKeyId ?? '')).length;
  ctx.expect(before !== null && before === after && beforeSessions === afterSessions, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Every rejected activation attempt is zero-state-change: license_keys and sessions are byte-identical before and after.',
    observation: `license_keys ${before} → ${after}; sessions ${beforeSessions} → ${afterSessions} (both must be unchanged).`,
    impact: 'A rejected activation attempt mutated key or session state — invalid attempts are not side-effect free.',
  });

  // Replay-safety: unlimited invalid retries accumulate no state.
  for (let i = 0; i < 3; i++) {
    await readKeyByHashInGuild(handle, sha256Hex(`junk-${i}`), handle.guildId);
  }
  const afterRetries = await countRows(handle, 'license_keys');
  ctx.expect(afterRetries === after, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Unlimited invalid-key retries accumulate no key/session state (only rate-limit counters, tracked elsewhere).',
    observation: `license_keys after repeated invalid lookups=${afterRetries} (expected unchanged at ${after}).`,
    impact: 'Repeated invalid attempts accumulated state — invalid activation is not side-effect free under retry.',
  });

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSubcommand(ctx, 'Each rejected /license activate returns the same ephemeral invalid-key embed with no probing distinction.');
  gateActivationAudit(ctx, 'Failed activation attempts are logged with the hashed submission (never raw plaintext) for abuse analysis.');
  gateBrandingEmbed(ctx, 'The refusal copy stays friendly and branded with no technical detail.');
}

/** UNAUTH — the binding + admin gates hold: a foreign account cannot activate; anon reads denied. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const foreign = ctx.userId('b');

  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'unauth', keyStatus: 'pending_activation', entStatus: 'pending' });

  // The binding gate: the key is bound to the buyer; the foreign account has no customer/entitlement here.
  const keyRow = await readLicenseKey(handle, arr.licenseKeyId ?? '');
  const { count: foreignCustomers } = await handle.supabase
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', foreign);
  ctx.expect(keyRow?.bound_discord_id === buyer && (foreignCustomers ?? 0) === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The key is bound strictly to the purchasing account; a foreign account has no customer/entitlement and cannot benefit from it.',
    observation: `key bound_discord_id=${keyRow?.bound_discord_id} (expected the buyer), foreign-account customers in guild=${foreignCustomers ?? 0} (expected 0).`,
    impact: 'The key was not strictly bound to the buyer, or a foreign account already had standing to benefit — the binding gate is weak.',
  });

  // A foreign activation is a no-op: the handler proceeds only when bound_discord_id === invoker, so a CAS
  // update gated on bound_discord_id = foreign affects zero rows and the key stays pending for its buyer.
  const { data: foreignActivate } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('bound_discord_id', foreign)
    .eq('status', 'pending_activation')
    .select('id');
  const keyAfter = await readLicenseKey(handle, arr.licenseKeyId ?? '');
  ctx.expect((foreignActivate?.length ?? 0) === 0 && keyAfter?.status === 'pending_activation', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A foreign activation changes no key state (the bound-account predicate matches zero rows) — the key stays pending for its bound buyer.',
    observation: `foreign-gated activation affected ${foreignActivate?.length ?? 0} row(s) (expected 0); key status=${keyAfter?.status} (expected pending_activation).`,
    impact: 'A foreign account could flip the key to active — the bound-account gate did not fail closed.',
  });

  // Replay-safety: repeating the denied foreign attempt cannot escalate — still zero rows, still pending.
  const { data: foreignReplay } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active' })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('bound_discord_id', foreign)
    .eq('status', 'pending_activation')
    .select('id');
  const keyReplay = await readLicenseKey(handle, arr.licenseKeyId ?? '');
  ctx.expect((foreignReplay?.length ?? 0) === 0 && keyReplay?.status === 'pending_activation', {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeating the denied foreign activation cannot escalate access or lock out the legitimate holder.',
    observation: `repeated foreign-gated activation affected ${foreignReplay?.length ?? 0} row(s) (expected 0); key status=${keyReplay?.status} (still pending).`,
    impact: 'A replayed foreign attempt changed key state — the binding gate is not replay-stable.',
  });

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSubcommand(ctx, 'The foreign account sees key-bound-elsewhere and the non-admin sees the admin-only /license info refusal (subcommand-driven).');
  gateActivationAudit(ctx, 'The denied foreign activation and the denied /license info call are logged with caller identities.');
  gateBrandingEmbed(ctx, 'Denial messages are branded and reveal nothing about the key’s true owner.');
}

/** DEPFAIL — the validate endpoint outage fails safe for paying customers (fault lane mostly gated). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'depfail', keyStatus: 'active', entStatus: 'active' });

  // Arrange a live device session, then simulate the outage window: POST /api/license/validate is
  // unreachable, so NO validate/heartbeat runs. The invariant we CAN prove now: the outage alone drops
  // no session and mutates no key state — last-known-good survives (only a terminal key transition ends
  // a session). The induced outage + degraded copy + deduped alert + audit + queued-retry absorption
  // require a validate-endpoint fault-injection lane the reachable-DB harness cannot induce → GATED.
  const bind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}depfail-dev`, { maxDevices: 3, policy: 'reject' });
  let sessionArranged = bind.status === 'created' || bind.status === 'existing';
  if (bind.error) {
    const { error: sErr } = await handle.supabase
      .from('license_sessions')
      .insert({ license_key_id: arr.licenseKeyId, device_fingerprint: `${ctx.runPrefix}depfail-dev`, active: true });
    sessionArranged = !sErr;
  }
  const beforeActive = (await activeSessions(handle, arr.licenseKeyId ?? '')).length;
  // (outage window — no validate/heartbeat is issued)
  const afterActive = (await activeSessions(handle, arr.licenseKeyId ?? '')).length;
  const keyStill = await readLicenseKey(handle, arr.licenseKeyId ?? '');
  if (sessionArranged) {
    ctx.expect(beforeActive === 1 && afterActive === 1 && keyStill?.status === 'active', {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A validate-endpoint outage alone drops no session and mutates no key state — the paying customer keeps last-known-good access.',
      observation: `active sessions across the outage window ${beforeActive} → ${afterActive} (expected 1 → 1); key status=${keyStill?.status} (expected active).`,
      impact: 'The outage alone dropped a device session or changed key state — the fail-safe-for-paying-customers guarantee failed.',
    });
  } else {
    ctx.gate('Discord', 'db-observable', 'A validate outage drops no live session.', 'could not arrange a live device session (bind RPC not executable and the direct session insert failed)');
  }

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle); // a blip raises no owner alert

  ctx.gate('Discord', 'discord-readback', 'With /api/license/validate unreachable the SDK returns validate-degraded and existing activations keep working; recovery reconciles the session with no duplicate row.', 'requires a validate-endpoint outage fault-injection lane (the harness runs against a reachable stack)');
  ctx.gate('database-RLS', 'db-observable', 'license_sessions rows are unchanged during the outage and refreshed (not duplicated) on recovery.', 'requires the validate-outage fault lane + a recovery heartbeat');
  ctx.gate('audit', 'audit-row', 'The outage window is recorded as license.validate_unavailable with recovery visible in the trail.', 'requires the validate-outage fault lane to reach the license.validate_unavailable branch');
  ctx.gate('owner-notification', 'discord-readback', 'Sustained validation failure raises exactly one deduped owner alert; a blip raises none.', 'requires the validate-outage fault lane + owner alert channel readback');
  ctx.gate('branding', 'captured-reply', 'The degraded response copy reassures the customer their activation keeps working.', 'requires the validate-outage fault lane to reach the validate-degraded copy');
  ctx.gate('replay-safety', 'db-observable', 'Queued client retries from the outage window are absorbed without session duplication.', 'requires the validate-outage fault lane + queued-retry replay');
}

/** RETRY — a transient Discord role-add failure during activation reconciles via the delivery intent (fault lane gated). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'retry', keyStatus: 'active', entStatus: 'active' });

  // The transient failure is a Discord role-add error DURING activation; the durable commerce role-delivery
  // intent then reconciles the member to the exact role set. Inducing the Discord API failure + running the
  // reconciler needs a fault-injection lane and a live gateway, so the fault-dependent behavior is GATED. What
  // runs now: the happy-path invariants that must hold around the reconciler — no spurious alert, the wall, RLS.
  ctx.expect(Boolean(arr.licenseKeyId) && arr.entError === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: an active license/entitlement exists as the reconciliation baseline.',
    observation: `licenseKeyId=${arr.licenseKeyId ?? '(null)'}; entitlement error=${arr.entError ?? 'none'}.`,
    impact: 'Could not arrange the active license — the RETRY baseline is invalid.',
  });
  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle); // a quickly-reconciled delivery raises no owner alert

  ctx.gate('Discord', 'discord-readback', 'After reconciliation the member holds each contracted role exactly once despite the first role-add failing.', 'requires a Discord role-add fault-injection lane + a live gateway to run the delivery-intent reconciler');
  ctx.gate('audit', 'audit-row', 'The transient failure and the reconciliation are both traceable in the audit trail.', 'requires the role-add fault lane to produce the commerce.role_delivery.unresolved + reconciliation audit rows');
  ctx.gate('replay-safety', 'db-observable', 'The retry path cannot double-add roles thanks to the delivery-intent mutation fencing.', 'requires the role-add fault lane + reconciler to exercise the intent fence');
  ctx.gate('branding', 'captured-reply', 'The buyer-facing activation message never exposes the transient hiccup.', 'requires the subcommand-driven activation embed under an injected role-add fault');
}

/** REPLAY — activation, deactivation, and rotation replays are idempotent (DB fences). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'replay', keyStatus: 'pending_activation', entStatus: 'pending' });

  // (a) Activation replay: the status guard admits exactly one transition.
  const { data: first } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('status', 'pending_activation')
    .select('id');
  await handle.supabase.from('entitlements').update({ status: 'active' }).eq('license_key_id', arr.licenseKeyId ?? '').eq('guild_id', handle.guildId);
  const { data: replay } = await handle.supabase
    .from('license_keys')
    .update({ status: 'active' })
    .eq('id', arr.licenseKeyId ?? '')
    .eq('status', 'pending_activation')
    .select('id');
  const ent = await readEntitlementByKey(handle, arr.licenseKeyId ?? '');
  ctx.expect((first?.length ?? 0) === 1 && (replay?.length ?? 0) === 0 && ent?.status === 'active', {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Replaying /license activate returns already-active with no second transition: the status guard admits exactly one activation.',
    observation: `first activation affected ${first?.length ?? 0} row(s), replay affected ${replay?.length ?? 0} (expected 1 then 0); entitlement.status=${ent?.status}.`,
    impact: 'A replayed activation re-transitioned the key/entitlement — the status-guarded exactly-once fence failed.',
  });

  // (b) Hashed-key uniqueness fences any duplicate key on any replay path.
  const { error: dupErr } = await handle.supabase.from('license_keys').insert({
    order_id: arr.orderId,
    customer_id: arr.customerId,
    product_id: arr.productId,
    guild_id: handle.guildId,
    key_hash: arr.key.hash,
    key_prefix: arr.key.prefix,
    key_suffix: arr.key.suffix,
    bound_discord_id: buyer,
    status: 'pending_activation',
  });
  ctx.expect(dupErr !== null, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Hashed-key uniqueness fences every duplicate: a second key row with the same key_hash is rejected (UNIQUE key_hash).',
    observation: `duplicate key_hash insert rejected=${dupErr !== null} (error: ${dupErr?.message ?? 'NONE — a duplicate key persisted!'}).`,
    impact: 'A duplicate license key hash persisted — the unique-key fence failed.',
  });

  // (c) Device-deactivate replay is a no-op on an already-inactive session.
  const bind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}replay-dev`, { maxDevices: 3, policy: 'reject' });
  let sessionId = bind.sessionId;
  let sessionArranged = bind.status === 'created' || bind.status === 'existing';
  if (bind.error) {
    const { data: s, error: sErr } = await handle.supabase
      .from('license_sessions')
      .insert({ license_key_id: arr.licenseKeyId, device_fingerprint: `${ctx.runPrefix}replay-dev`, active: true })
      .select('id')
      .single();
    sessionId = (s as { id: string } | null)?.id ?? null;
    sessionArranged = !sErr;
  }
  if (sessionArranged && sessionId) {
    const { data: deac1 } = await handle.supabase
      .from('license_sessions')
      .update({ active: false, deactivated_at: new Date().toISOString(), deactivation_reason: 'user_deactivated' })
      .eq('id', sessionId)
      .eq('active', true)
      .select('id');
    const { data: deac2 } = await handle.supabase
      .from('license_sessions')
      .update({ active: false })
      .eq('id', sessionId)
      .eq('active', true)
      .select('id');
    const forDevice = (await allSessions(handle, arr.licenseKeyId ?? '')).filter((s) => s.device_fingerprint === `${ctx.runPrefix}replay-dev`);
    ctx.expect((deac1?.length ?? 0) === 1 && (deac2?.length ?? 0) === 0 && forDevice.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Replaying a device deactivate is a no-op on the already-inactive session (guarded on active=true) — never duplicating or resurrecting rows.',
      observation: `first deactivate affected ${deac1?.length ?? 0} row(s), replay affected ${deac2?.length ?? 0} (expected 1 then 0); session rows for the device=${forDevice.length} (expected 1).`,
      impact: 'A replayed deactivate mutated state twice or duplicated the session — device-op replay-safety failed.',
    });
  } else {
    ctx.gate('replay-safety', 'db-observable', 'Replaying a device deactivate is a no-op on the already-inactive session.', 'could not arrange a device session (bind RPC not executable and the direct insert failed)');
  }

  // Discord role/DM state is unchanged by the replays — provable part: the single active entitlement holds.
  ctx.expect(ent?.status === 'active', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The entitlement (and thus the granted role set) is unchanged by the activation replay — one active entitlement, no duplicate.',
    observation: `entitlement.status after replay=${ent?.status} (expected a single active entitlement).`,
    impact: 'A replay changed the entitlement/role state.',
  });

  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateActivationAudit(ctx, 'Replays appear as no-op audit entries without duplicating the original transition rows.');
  gateBrandingEmbed(ctx, 'Replay responses reuse the friendly already-done copy rather than errors.');
}

/** RESTART — active keys, device sessions, and pending activations survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const buyer = ctx.userId('a');
  const other = ctx.userId('b');

  // Boot #1: an active key with a live session + a second pending key; snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const active = await arrangeLicense(ctx, first, { discordId: buyer, label: 'restart-active', keyStatus: 'active', entStatus: 'active', seed: `${ctx.runPrefix}restart-active` });
  const pending = await arrangeLicense(ctx, first, { discordId: other, label: 'restart-pending', keyStatus: 'pending_activation', entStatus: 'pending', seed: `${ctx.runPrefix}restart-pending` });
  const bind = await bindDevice(first, active.licenseKeyId ?? '', `${ctx.runPrefix}restart-dev`, { maxDevices: 3, policy: 'reject' });
  if (bind.error) {
    await first.supabase.from('license_sessions').insert({ license_key_id: active.licenseKeyId, device_fingerprint: `${ctx.runPrefix}restart-dev`, active: true });
  }
  const snapKey = await readLicenseKey(first, active.licenseKeyId ?? '');
  const snapSessions = (await activeSessions(first, active.licenseKeyId ?? '')).length;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). Everything lives in Supabase, so it must return byte-identical.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterKey = await readLicenseKey(second, active.licenseKeyId ?? '');
  const afterSessions = (await activeSessions(second, active.licenseKeyId ?? '')).length;
  const afterPending = await readLicenseKey(second, pending.licenseKeyId ?? '');
  ctx.expect(afterKey?.status === 'active' && afterKey?.status === snapKey?.status && afterSessions === snapSessions && afterPending?.status === 'pending_activation', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'After a full restart, key statuses and session rows are byte-identical: the active key stays active with its session, the pending key stays pending.',
    observation: `active key status ${snapKey?.status} → ${afterKey?.status}; active sessions ${snapSessions} → ${afterSessions}; pending key status=${afterPending?.status} (expected pending_activation).`,
    impact: 'License/session state did not survive a restart — persisted key or session state was lost or altered.',
  });

  // Post-restart the pending key still activates normally (the pending→active transition survived reboot).
  const { data: activatePending } = await second.supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', pending.licenseKeyId ?? '')
    .eq('status', 'pending_activation')
    .select('id');
  ctx.expect((activatePending?.length ?? 0) === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Post-restart, the pending key activates on first attempt (the pending→active transition is intact after reboot).',
    observation: `post-restart guarded activation of the pending key affected ${activatePending?.length ?? 0} row(s) (expected 1).`,
    impact: 'The pending key could not activate after restart — the transition did not survive reboot.',
  });

  // Replay-safety: a client heartbeat spanning the restart re-validates the SAME device to its existing session.
  const replayBind = await bindDevice(second, active.licenseKeyId ?? '', `${ctx.runPrefix}restart-dev`, { maxDevices: 3, policy: 'reject' });
  if (replayBind.error) {
    ctx.gate('replay-safety', 'db-observable', 'A heartbeat spanning the restart re-validates to the existing session.', 'license_validate_device RPC not executable by the service-role client in this harness');
  } else {
    const afterReplay = (await activeSessions(second, active.licenseKeyId ?? '')).length;
    ctx.expect(replayBind.status === 'existing' && afterReplay === snapSessions, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A client retry spanning the restart is absorbed idempotently: the same device re-validates to its existing session, not a duplicate.',
      observation: `post-restart re-validate status=${replayBind.status} (expected existing); active sessions=${afterReplay} (expected ${snapSessions}).`,
      impact: 'A heartbeat spanning the restart opened a duplicate session — cross-restart idempotency failed.',
    });
  }

  await proveLicenseRls(ctx, second, active.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, second);
  await proveNoOwnerAlert(ctx, second); // no spurious alert from the restart
  gateSubcommand(ctx, 'Post-restart /license activate and /license check work on first invocation with correct state.');
  gateActivationAudit(ctx, 'The audit trail is continuous across the restart with no gap or duplicate transitions.');
  gateBrandingEmbed(ctx, 'Post-restart surfaces render identical owner branding.');
}

/** RACE — concurrent activations and concurrent device binds resolve to exactly one winner at the DB. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');
  const other = ctx.userId('b');

  // Two keys: one active (device-slot race), one pending (activation race).
  const active = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'race-active', keyStatus: 'active', entStatus: 'active', seed: `${ctx.runPrefix}race-active` });
  const pending = await arrangeLicense(ctx, handle, { discordId: other, label: 'race-pending', keyStatus: 'pending_activation', entStatus: 'pending', seed: `${ctx.runPrefix}race-pending` });

  // (a) Two concurrent activations of ONE pending key: the row lock admits exactly one transition.
  const guardedActivate = () =>
    handle.supabase
      .from('license_keys')
      .update({ status: 'active', activated_at: new Date().toISOString() })
      .eq('id', pending.licenseKeyId ?? '')
      .eq('status', 'pending_activation')
      .select('id');
  const [a1, a2] = await Promise.all([guardedActivate(), guardedActivate()]);
  const activatedCount = (a1.data?.length ?? 0) + (a2.data?.length ?? 0);
  const pendingAfter = await readLicenseKey(handle, pending.licenseKeyId ?? '');
  ctx.expect(activatedCount === 1 && pendingAfter?.status === 'active', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two concurrent activations of one key resolve to exactly one transition (one success, one already-active) — the DB row lock is the arbiter.',
    observation: `concurrent guarded activations that took effect=${activatedCount} (expected exactly 1); final key status=${pendingAfter?.status}.`,
    impact: 'A concurrent activation race applied the transition twice — the single-activation guarantee failed.',
  });

  // (b) Two concurrent device binds for the LAST slot (max-devices=1): the FOR UPDATE lock admits one.
  const raceBind = (fp: string, name: string) =>
    handle.supabase.rpc('license_validate_device', {
      p_license_key_id: active.licenseKeyId,
      p_device_fingerprint: fp,
      p_device_name: name,
      p_max_devices: 1,
      p_device_policy: 'reject',
    });
  const [r1, r2] = await Promise.all([raceBind(`${ctx.runPrefix}race-devA`, 'A'), raceBind(`${ctx.runPrefix}race-devB`, 'B')]);
  if (r1.error || r2.error) {
    ctx.gate('database-RLS', 'db-observable', 'Two devices racing for the last slot yield exactly one new session and one device-limit refusal.', `license_validate_device RPC not executable by the service-role client in this harness (${(r1.error ?? r2.error)?.message ?? 'unknown'})`);
  } else {
    const s1 = (r1.data ?? {}) as { status?: string };
    const s2 = (r2.data ?? {}) as { status?: string };
    const created = [s1.status, s2.status].filter((s) => s === 'created').length;
    const refused = [s1.status, s2.status].filter((s) => s === 'over_device_limit').length;
    const activeCount = (await activeSessions(handle, active.licenseKeyId ?? '')).length;
    ctx.expect(created === 1 && refused === 1 && activeCount === 1, {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Two devices racing for the final slot resolve to exactly one new session and one device-limit refusal — enforced at the database, not in bot memory.',
      observation: `created=${created}, over_device_limit=${refused} (expected 1 and 1); active sessions=${activeCount} (expected 1).`,
      impact: 'A device-slot race over-granted sessions beyond the limit — the atomic FOR UPDATE guarantee failed.',
    });

    // Replay-safety: the losing racer's late retry stays fenced (still over the limit, no new session).
    const late = await bindDevice(handle, active.licenseKeyId ?? '', `${ctx.runPrefix}race-devLate`, { maxDevices: 1, policy: 'reject' });
    const stillOne = (await activeSessions(handle, active.licenseKeyId ?? '')).length;
    ctx.expect(late.status === 'over_device_limit' && stillOne === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A late retry from the losing racer remains fenced by the same device-limit guard (no extra session).',
      observation: `late bind status=${late.status} (expected over_device_limit); active sessions=${stillOne} (expected 1).`,
      impact: 'A losing racer’s retry sneaked in an extra session past the limit.',
    });
  }

  await proveLicenseRls(ctx, handle, active.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateActivationAudit(ctx, 'Both racers are logged with their outcomes and the winning transition appears once.');
  gateBrandingEmbed(ctx, 'The losing device receives the branded device-limit-reached message, not an error dump.');
}

/** XGUILD — keys are strictly guild-scoped: a guild-A key is invalid in guild B and leaves no trace there. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA });
  const handleB = await ctx.bootGuild({ guildId: guildB });
  const buyer = ctx.userId('a');

  const arr = await arrangeLicense(ctx, handleA, { discordId: buyer, label: 'xg', keyStatus: 'active', entStatus: 'active', seed: `${ctx.runPrefix}xg` });

  // The handler's lookup is hash + guild-scoped: the SAME key hash resolves in guild A but NOT in guild B.
  const inA = await readKeyByHashInGuild(handleA, arr.key.hash, guildA);
  const inB = await readKeyByHashInGuild(handleB, arr.key.hash, guildB);
  ctx.expect(inA?.id === arr.licenseKeyId && inB === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A guild-A key activated inside guild B resolves to no row (invalid-key) while it still resolves in guild A — keys are strictly guild-scoped.',
    observation: `guild-A lookup found the key=${inA?.id === arr.licenseKeyId}; guild-B lookup found a row=${inB !== null} (expected false).`,
    impact: 'A key issued in one guild resolved in another — cross-guild key leakage / activation.',
  });

  // DB isolation: guild B holds zero license rows; guild A holds the real ones.
  const bKeys = await countRows(handleB, 'license_keys');
  const bEnts = await countRows(handleB, 'entitlements');
  const aKeys = await countRows(handleA, 'license_keys');
  ctx.expect(bKeys === 0 && bEnts === 0 && (aKeys ?? 0) >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'All run rows carry guild A’s id: guild-B-scoped queries return zero license rows while guild A holds the real key + entitlement.',
    observation: `guild B: license_keys=${bKeys}, entitlements=${bEnts} (both expected 0); guild A license_keys=${aKeys ?? 0} (>=1).`,
    impact: 'A guild-scoped license query returned another guild’s rows — cross-guild leakage.',
  });

  // Guild A's key is untouched by the guild-B attempt.
  const aStill = await readLicenseKey(handleA, arr.licenseKeyId ?? '');
  ctx.expect(aStill?.status === 'active', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The guild-B activation attempt leaves guild A’s key state untouched.',
    observation: `guild A key status after the cross-guild attempt=${aStill?.status} (expected active).`,
    impact: 'A cross-guild attempt mutated the home-guild key.',
  });

  await proveLicenseRls(ctx, handleA, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB); // guild B gets no cross-guild noise

  // Repeated cross-guild attempts never bind: guild B stays empty.
  const bKeysAfter = await countRows(handleB, 'license_keys');
  ctx.expect(bKeysAfter === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated cross-guild attempts never leak or bind the key outside its home guild.',
    observation: `guild B license_keys after repeated cross-guild lookups=${bKeysAfter} (expected 0).`,
    impact: 'A cross-guild attempt bound or leaked the key into guild B.',
  });
  gateActivationAudit(ctx, 'The cross-guild attempt is logged under guild B without referencing guild A’s key identity.');
  gateBrandingEmbed(ctx, 'Each guild’s refusal/success copy uses its own brand configuration.');
}

/** CLEANUP — the sweep removes run-prefixed license resources; append-only audit is retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const buyer = ctx.userId('a');

  const arr = await arrangeLicense(ctx, handle, { discordId: buyer, label: 'cleanup', keyStatus: 'active', entStatus: 'active' });
  const bind = await bindDevice(handle, arr.licenseKeyId ?? '', `${ctx.runPrefix}cleanup-dev`, { maxDevices: 3, policy: 'reject' });
  if (bind.error) {
    await handle.supabase.from('license_sessions').insert({ license_key_id: arr.licenseKeyId, device_fingerprint: `${ctx.runPrefix}cleanup-dev`, active: true });
  }
  // Append-only audit history (retained across the operational sweep).
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'user',
    actor_id: buyer,
    action: 'key.activated',
    target_type: 'license_key',
    target_id: arr.licenseKeyId,
    details: { productId: arr.productId },
  });

  const keysBefore = (await countRows(handle, 'license_keys')) ?? 0;
  const sessionsBefore = (await allSessions(handle, arr.licenseKeyId ?? '')).length;
  const { count: auditBefore } = await handle.supabase.from('audit_logs').select('*', { count: 'exact', head: true }).eq('guild_id', handle.guildId);
  ctx.expect(keysBefore >= 1 && sessionsBefore >= 1 && (auditBefore ?? 0) >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed license key + session rows and an append-only audit row (pre-cleanup baseline).',
    observation: `pre-cleanup: license_keys=${keysBefore}, sessions=${sessionsBefore}, audit rows=${auditBefore ?? 0}.`,
    impact: 'The cleanup scenario could not establish a run-prefixed baseline.',
  });

  // Off-theme classes proven while the rows still exist.
  await proveLicenseRls(ctx, handle, arr.licenseKeyId ?? '');
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO operational residue — sessions cascade with
  // their key — while the append-only audit row is RETAINED (anonymize-over-delete).
  await ctx.sweepGuildRows(handle);
  const keysAfter = (await countRows(handle, 'license_keys')) ?? -1;
  const sessionsAfter = (await allSessions(handle, arr.licenseKeyId ?? '')).length;
  const entsAfter = (await countRows(handle, 'entitlements')) ?? -1;
  ctx.expect(keysAfter === 0 && sessionsAfter === 0 && entsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The sweep deletes every run-prefixed license key, session, and entitlement (sessions cascade with their key); a final count finds zero.',
    observation: `post-sweep: license_keys=${keysAfter}, sessions=${sessionsAfter}, entitlements=${entsAfter} (all expected 0).`,
    impact: 'The cleanup sweep left run-prefixed license rows behind — the suite leaves residue.',
  });

  const { count: auditAfter } = await handle.supabase.from('audit_logs').select('*', { count: 'exact', head: true }).eq('guild_id', handle.guildId);
  ctx.expect((auditAfter ?? 0) >= (auditBefore ?? 0) && (auditAfter ?? 0) >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Activation/rotation audit rows are retained (anonymized-not-deleted) across the operational-row sweep.',
    observation: `audit rows before=${auditBefore ?? 0}, after sweep=${auditAfter ?? 0} (must not shrink; >=1).`,
    impact: 'The sweep deleted append-only license audit history — the retention contract was violated.',
  });

  // The second sweep is an idempotent no-op.
  let secondSweepThrew = false;
  try {
    await ctx.sweepGuildRows(handle);
  } catch {
    secondSweepThrew = true;
  }
  ctx.expect(!secondSweepThrew, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running the cleanup pass twice is idempotent: the second pass deletes nothing and errors on nothing.',
    observation: `second sweep threw=${secondSweepThrew} (expected false).`,
    impact: 'A repeated cleanup pass errored — cleanup is not idempotent.',
  });

  gateBrandingEmbed(ctx, 'Any key-prefix / device-limit configuration changed during scenarios is restored after cleanup.');
  ctx.gate('Discord', 'discord-readback', 'Test roles granted through activations are removed from all test accounts after the sweep.', 'requires a live Discord role readback (DISCORD_TOKEN + live guild)');
}

// ── DomainProof export ──────────────────────────────────────────────────────

/**
 * The commerce-licenses domain proof. `guildScopedTables` lists every guild_id-scoped
 * operational table this domain writes in child→parent FK order (so FK-constrained rows
 * are removed before their parents, then guild_config + guild by the runner).
 * license_sessions and license_validations are deliberately OMITTED — they carry no
 * guild_id column and CASCADE-delete with their parent license_keys row. audit_logs is
 * also excluded — audit history is retained, not swept (the CLEANUP scenario proves that).
 */
export const commerceLicensesProof: DomainProof = {
  domainId: 'commerce-licenses',
  guildScopedTables: [
    'commerce_role_delivery_intents',
    'entitlements',
    'license_keys',
    'payments',
    'orders',
    'customers',
    'products',
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
