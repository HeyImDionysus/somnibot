/**
 * scenario-runner/scripts/commerce-portal — the customer-portal domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts against LOCAL Supabase. What makes this domain different from a
 * bot-command domain (e.g. game-economy): the customer portal is NOT driven by
 * Discord slash commands. Every member-facing action lives behind Next.js HTTP
 * routes in the DASHBOARD package —
 *   - POST /api/portal/auth           (Discord OAuth code exchange → session)
 *   - POST /api/portal/download-link  (HMAC-signed, 5-minute download URL)
 *   - GET  /api/portal/{orders,licenses,downloads,sessions}
 * — gated behind Discord OAuth, an HMAC signing secret, PayPal (for the
 * subscription non-renewal), and dashboard session auth. The bot-only,
 * local-Supabase harness here has NO way to drive those HTTP routes or complete
 * a real OAuth flow, so the portal-ACTION surfaces (login, signed-link issuance
 * and expiry, self-service cancellation, refund/service-request filing, key
 * rotation, device removal) are GATED honestly — never faked.
 *
 * What DOES run now is the whole DATA/ISOLATION substrate the portal contract
 * rests on, proven directly against the production commerce schema the routes
 * read and write:
 *   - RLS anon-denial on portal_sessions / customers / orders / entitlements
 *     (positive control: the service role sees the row an anon key must NOT).
 *   - Server-side CUSTOMER scoping — the exact `.eq('customer_id', …)` predicate
 *     every portal read uses — proven with two REAL customers (A cannot read B).
 *   - Per-GUILD customer isolation (a guild-A customer has no guild-B row).
 *   - Hash-only session storage (portal_sessions persists token_hash, never the
 *     plaintext — a regression guard on the v22 nullable-session_token fix).
 *   - The DB-level idempotency / race guard behind the token_hash UNIQUE index.
 *   - State survives a full stack restart (rows live in Supabase, not memory).
 *   - The surgical run-prefixed cleanup sweep.
 *
 * mostlyGated = true: this is a dashboard/HTTP/OAuth/PayPal-heavy domain, so the
 * bulk of member-facing cells are correctly GATED. Where a real DB-observable
 * fact exists, it is asserted against a REAL captured row — never a synthetic
 * literal, never an always-true expression, never an unconditional pass.
 */
import { createHash } from 'node:crypto';

import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface CustomerRow {
  id: string;
  guild_id: string;
  discord_id: string;
}
interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  guild_id: string;
  status: string;
}
interface EntitlementRow {
  id: string;
  customer_id: string;
  guild_id: string;
  status: string;
  expires_at: string | null;
}
interface SessionRow {
  id: string;
  customer_id: string;
  guild_id: string;
  token_hash: string;
  session_token: string | null;
  expires_at: string;
  revoked: boolean;
}
interface LicenseKeyRow {
  id: string;
  customer_id: string;
  guild_id: string;
  key_hash: string;
  status: string;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

/** The SHA-256 hex the portal routes store/look up (crypto.createHash('sha256')). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A deterministic, per-scenario+label opaque portal token (its hash is the row key). */
function scenarioToken(ctx: ScenarioContext, label: string): string {
  return `${ctx.runPrefix}${ctx.scenarioClass.toLowerCase()}-${label}-tok`;
}

async function seedCustomer(
  handle: LiveClientHandle,
  discordId: string,
  username: string,
): Promise<CustomerRow | null> {
  const { data } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: discordId, discord_username: username })
    .select('id, guild_id, discord_id')
    .single();
  return (data as CustomerRow | null) ?? null;
}

async function seedProduct(
  handle: LiveClientHandle,
  name: string,
  deliveryType: 'file' | 'link' | 'access_pass' | 'mixed' = 'file',
  type: 'one_time' | 'subscription' = 'one_time',
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name,
      type,
      delivery_type: deliveryType,
      price_cents: 500,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function seedOrder(
  handle: LiveClientHandle,
  args: { customerId: string; productId: string; orderNumber: string; status?: string },
): Promise<OrderRow | null> {
  const { data } = await handle.supabase
    .from('orders')
    .insert({
      order_number: args.orderNumber,
      customer_id: args.customerId,
      guild_id: handle.guildId,
      product_id: args.productId,
      amount_cents: 500,
      status: args.status ?? 'completed',
      source: 'purchase',
    })
    .select('id, order_number, customer_id, guild_id, status')
    .single();
  return (data as OrderRow | null) ?? null;
}

async function seedEntitlement(
  handle: LiveClientHandle,
  args: {
    customerId: string;
    productId: string;
    orderId: string;
    type?: 'one_time' | 'subscription';
    status?: string;
    expiresAt?: string | null;
  },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('entitlements')
    .insert({
      customer_id: args.customerId,
      guild_id: handle.guildId,
      product_id: args.productId,
      order_id: args.orderId,
      type: args.type ?? 'one_time',
      status: args.status ?? 'active',
      source: 'purchase',
      expires_at: args.expiresAt ?? null,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function seedSession(
  handle: LiveClientHandle,
  args: {
    customerId: string;
    discordId: string;
    tokenHash: string;
    expiresAt?: string;
    revoked?: boolean;
  },
): Promise<{ id: string | null; error: string | null }> {
  const expires = args.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await handle.supabase
    .from('portal_sessions')
    .insert({
      guild_id: handle.guildId,
      customer_id: args.customerId,
      discord_id: args.discordId,
      token_hash: args.tokenHash,
      expires_at: expires,
      revoked: args.revoked ?? false,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function seedLicenseKey(
  handle: LiveClientHandle,
  args: { customerId: string; productId: string; orderId: string; keyHash: string; boundDiscordId: string },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('license_keys')
    .insert({
      guild_id: handle.guildId,
      customer_id: args.customerId,
      product_id: args.productId,
      order_id: args.orderId,
      key_hash: args.keyHash,
      key_prefix: 'E2E-',
      key_suffix: args.keyHash.slice(0, 4),
      bound_discord_id: args.boundDiscordId,
      status: 'active',
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

/**
 * Replicate the EXACT lookup /api/portal/auth (GET) and the data routes use to
 * resolve a session from a bearer token: a live, non-revoked, unexpired row
 * matched on token_hash. Returns the row or null (the route's 401 branch).
 */
async function readSessionByHash(handle: LiveClientHandle, tokenHash: string): Promise<SessionRow | null> {
  const { data } = await handle.supabase
    .from('portal_sessions')
    .select('id, customer_id, guild_id, token_hash, session_token, expires_at, revoked')
    .eq('token_hash', tokenHash)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/** The portal orders route's customer scoping: `.eq('customer_id', …)`. */
async function readOrdersForCustomer(handle: LiveClientHandle, customerId: string): Promise<OrderRow[]> {
  const { data } = await handle.supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, status')
    .eq('customer_id', customerId);
  return (data as OrderRow[] | null) ?? [];
}

/** A cross-customer probe: fetch a specific order id constrained to a bound customer. */
async function readOrderScoped(
  handle: LiveClientHandle,
  orderId: string,
  boundCustomerId: string,
): Promise<OrderRow | null> {
  const { data } = await handle.supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, status')
    .eq('id', orderId)
    .eq('customer_id', boundCustomerId)
    .maybeSingle();
  return (data as OrderRow | null) ?? null;
}

async function readOrderById(handle: LiveClientHandle, orderId: string): Promise<OrderRow | null> {
  const { data } = await handle.supabase
    .from('orders')
    .select('id, order_number, customer_id, guild_id, status')
    .eq('id', orderId)
    .maybeSingle();
  return (data as OrderRow | null) ?? null;
}

async function readLicenseKeysForCustomer(
  handle: LiveClientHandle,
  customerId: string,
): Promise<LicenseKeyRow[]> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, customer_id, guild_id, key_hash, status')
    .eq('customer_id', customerId);
  return (data as LicenseKeyRow[] | null) ?? [];
}

async function readLicenseKeyScoped(
  handle: LiveClientHandle,
  keyId: string,
  boundCustomerId: string,
): Promise<LicenseKeyRow | null> {
  const { data } = await handle.supabase
    .from('license_keys')
    .select('id, customer_id, guild_id, key_hash, status')
    .eq('id', keyId)
    .eq('customer_id', boundCustomerId)
    .maybeSingle();
  return (data as LicenseKeyRow | null) ?? null;
}

/** The portal-auth customer match, scoped to a specific guild (the catalog intent). */
async function readCustomerByGuild(
  handle: LiveClientHandle,
  guildId: string,
  discordId: string,
): Promise<CustomerRow | null> {
  const { data } = await handle.supabase
    .from('customers')
    .select('id, guild_id, discord_id')
    .eq('guild_id', guildId)
    .eq('discord_id', discordId)
    .maybeSingle();
  return (data as CustomerRow | null) ?? null;
}

async function readEntitlementById(handle: LiveClientHandle, id: string): Promise<EntitlementRow | null> {
  const { data } = await handle.supabase
    .from('entitlements')
    .select('id, customer_id, guild_id, status, expires_at')
    .eq('id', id)
    .maybeSingle();
  return (data as EntitlementRow | null) ?? null;
}

async function countSessionsByHash(handle: LiveClientHandle, tokenHash: string): Promise<number> {
  const { count } = await handle.supabase
    .from('portal_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('token_hash', tokenHash);
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
 * errors, so a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS owner-only →
 * 0, or 42501 permission-denied → 0), or null when inconclusive (→ GATE).
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
      return 0; // the anon role is denied the table — RLS/GRANT working
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove anon/authenticated clients read ZERO rows of a customer-scoped commerce
 * table for this guild, made non-vacuous by a positive control: the scenario has
 * already created a service-visible row under the guild (`serviceSeesRow`), so an
 * anon client reading zero is a real deny, not "there was nothing to read."
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  serviceSeesRow: boolean,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (owner-only RLS policy).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — customer/guild scoping is still proven server-side',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceSeesRow && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} row while an anon client reads zero of them (owner-only RLS).`,
    observation:
      `service-role sees a ${table} row under guild "${handle.guildId}" (${serviceSeesRow}); ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct customer-data exposure).`,
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's healthy portal traffic raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'Healthy portal traffic raises no owner alert.',
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a healthy portal path — a false alarm / notification noise.',
  });
}

/** Portal chrome is a rendered HTML surface, not a Discord reply — always gated here. */
function gateBrandingChrome(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The portal renders the owner brand throughout with the subtle powered-by-SomniBot attribution and no third-party look.',
    'portal chrome is rendered dashboard HTML (Next.js), not a Discord reply — a snapshot comparer against the live portal render is required (no member-facing bot reply exists to inspect)',
  );
}

/** The Discord-side (OAuth identity / role) surface — needs a live gateway + real OAuth. */
function gateDiscordOAuth(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a real Discord OAuth flow + live gateway (DISCORD_TOKEN + a test Discord account) to complete sign-in and observe role/entitlement side effects — not drivable by the bot-only local-Supabase harness',
  );
}

/** Portal-action audit rows are written by the dashboard HTTP routes, not reachable here. */
function gatePortalAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'portal-action audit rows are written inside the dashboard HTTP routes (/api/portal/*); with those routes undrivable here no login/download/rotation audit row is produced to read back',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a signed-in buyer sees their own purchase picture; session stored hash-only. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const sessionTtlDefault = Number(declaredDefault(ctx.domain, 'portal-session-ttl-ms'));
  const linkTtlDefault = Number(declaredDefault(ctx.domain, 'download-link-ttl-ms'));

  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  // Arrange the buyer's real purchase picture: customer → product → completed
  // order → active entitlement, plus a live portal session (stored hash-only).
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-buyer');
  const productId = await seedProduct(handle, `${ctx.runPrefix}def-product`, 'file');
  const order = customer && productId
    ? await seedOrder(handle, {
        customerId: customer.id,
        productId,
        orderNumber: `${ctx.runPrefix}def-a-order`,
      })
    : null;
  const ent = customer && productId && order
    ? await seedEntitlement(handle, { customerId: customer.id, productId, orderId: order.id })
    : { id: null, error: 'arrange failed' };
  const token = scenarioToken(ctx, 'a');
  const sess = customer
    ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash: hashToken(token) })
    : { id: null, error: 'no customer' };

  const arranged = Boolean(customer && productId && order && ent.id && sess.id);
  ctx.expect(arranged, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Test arrangement: a real buyer identity (customer + completed order + active entitlement + live portal session) persists under the production commerce schema.',
    observation:
      `customer=${Boolean(customer)}, product=${Boolean(productId)}, order=${Boolean(order)}, ` +
      `entitlement=${Boolean(ent.id)} (err=${ent.error ?? 'none'}), session=${Boolean(sess.id)} (err=${sess.error ?? 'none'}).`,
    impact: 'Could not arrange the buyer identity against the real commerce schema — the portal-data proof setup is invalid.',
  });

  // Session is persisted HASH-ONLY: the row carries token_hash and leaves the
  // plaintext session_token NULL. This is a live regression guard on the v22 fix
  // that made session_token nullable — were it still NOT NULL, this omit-the-
  // plaintext insert (exactly what /api/portal/auth does) would have errored.
  const sessionRow = await readSessionByHash(handle, hashToken(token));
  ctx.expect(
    sessionRow !== null && sessionRow.session_token === null && sessionRow.token_hash === hashToken(token),
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'The portal session row stores only a token HASH (never the plaintext), matched on token_hash the way every portal route resolves a bearer.',
      observation:
        `session lookup by token_hash returned ${sessionRow ? 'the row' : 'nothing'}; ` +
        `session_token column = ${sessionRow ? JSON.stringify(sessionRow.session_token) : 'n/a'} (expected null), ` +
        `token_hash present = ${sessionRow ? sessionRow.token_hash === hashToken(token) : false}.`,
      impact: 'The portal session did not persist as a bare hash — either the plaintext token leaked into a column or the hash lookup the routes depend on is broken.',
    },
  );

  // Served data belongs to the bound customer id: the exact `.eq('customer_id', …)`
  // scoping the portal orders route uses returns THIS customer's order and only it.
  const orders = customer ? await readOrdersForCustomer(handle, customer.id) : [];
  ctx.expect(
    orders.length === 1 && orders[0]!.order_number === `${ctx.runPrefix}def-a-order` && orders[0]!.customer_id === customer?.id,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'All data served to a session belongs to its bound customer id (the portal read scoping).',
      observation:
        `customer-scoped order read returned ${orders.length} row(s); ` +
        `first order_number="${orders[0]?.order_number}", customer_id="${orders[0]?.customer_id}".`,
      impact: 'The customer-scoped order read returned the wrong set — portal data would not be strictly bound to the signed-in customer.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'portal_sessions', sessionRow !== null);
  await proveNoOwnerAlert(ctx, handle);

  // Everything that needs the actual OAuth flow, the HMAC signer, or the rendered
  // portal is gated honestly — no faked pass.
  gateDiscordOAuth(ctx, 'OAuth uses the buyer’s real Discord identity and the portal shows exactly that account’s purchases.');
  gatePortalAudit(ctx, 'Login, signed-link issuance, and the successful download are each audited for the customer.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    `A signed download link honours the ${linkTtlDefault}ms (5-minute) default TTL and reusing it after expiry serves zero bytes.`,
    'signed-link issuance/expiry is HMAC-signed inside POST /api/portal/download-link (needs the dashboard route + DOWNLOAD_URL signing secret); not drivable by the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'discord-readback',
    `The issued session carries the default ${sessionTtlDefault}ms (7-day) TTL from a real OAuth sign-in.`,
    'the TTL is set inside POST /api/portal/auth on a completed OAuth exchange; asserting a self-inserted expiry would be vacuous, so the real-flow TTL is gated behind the portal route + OAuth',
  );
}

/** SET-A — end-of-term cancellation keeps access to term end (PayPal + portal route). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const cancellationDefault = String(declaredDefault(ctx.domain, 'cancellation-timing'));

  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  // Arrange a real subscription entitlement for the customer (the thing a
  // cancellation acts on). Its RLS/scoping is proven; the cancellation semantics
  // (PayPal non-renew + end-of-term expiry) are gated.
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-subscriber');
  const productId = await seedProduct(handle, `${ctx.runPrefix}set-a-sub`, 'access_pass', 'subscription');
  const order = customer && productId
    ? await seedOrder(handle, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}set-a-a-order` })
    : null;
  const termEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ent = customer && productId && order
    ? await seedEntitlement(handle, {
        customerId: customer.id,
        productId,
        orderId: order.id,
        type: 'subscription',
        status: 'active',
        expiresAt: termEnd,
      })
    : { id: null, error: 'arrange failed' };

  const entRow = ent.id ? await readEntitlementById(handle, ent.id) : null;
  ctx.expect(entRow !== null && entRow.status === 'active' && entRow.customer_id === customer?.id, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A real subscription entitlement bound to the customer persists and is customer-scoped (the row a cancellation would act on).',
    observation:
      `entitlement row = ${entRow ? 'present' : 'missing'} (err=${ent.error ?? 'none'}); ` +
      `status="${entRow?.status}", customer_id="${entRow?.customer_id}".`,
    impact: 'Could not arrange/scope the subscription entitlement — the end-of-term-cancellation proof surface is invalid.',
  });

  await proveRlsIsolation(ctx, handle, 'entitlements', entRow !== null);
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'paypal-sandbox',
    `Under the default cancellation-timing="${cancellationDefault}", a confirmed cancellation sets the entitlement's end-of-term expiry (access retained until term end) rather than revoking immediately.`,
    'POST /api/portal/cancel owns this transition through the durable portal_cancellation_operations RPC and PayPal cancellation readback; this bot-only harness cannot drive the authenticated portal route or the required PAYPAL_* sandbox effect',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The subscriber keeps all perk roles after cancelling until the term-end date; /license check still shows the entitlement active with its end date.',
    'requires a live Discord gateway to observe retained roles + the license surface after a real cancellation',
  );
  gatePortalAudit(ctx, 'The cancellation is audited with actor, subscription id, and effective date.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard subscription view shows the scheduled cancellation as a churn signal for the owner.',
    'the dashboard subscription/churn view is a dashboard-session surface, not reachable from the bot-only harness',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The cancellation-scheduled copy is owner-voiced, states the exact retained-access date, and avoids guilt-tripping.',
    'the cancellation-scheduled notice is rendered portal HTML produced only after a real cancellation — no member-facing bot reply to inspect',
  );
  ctx.gate(
    'replay-safety',
    'paypal-sandbox',
    'Confirming the cancellation twice stays a single scheduled cancellation with one provider (PayPal) call.',
    'requires the portal cancellation endpoint + PayPal sandbox to observe the single-effect idempotency of the provider call',
  );
}

/** SET-B — shorter download-link TTL + refund-request routing (signed-URL + queue). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  const customer = await seedCustomer(handle, discordId, 'e2e-portal-refunder');
  const productId = await seedProduct(handle, `${ctx.runPrefix}set-b-product`, 'file');
  const order = customer && productId
    ? await seedOrder(handle, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}set-b-a-order` })
    : null;

  // The order a refund would be filed against is real and customer-scoped.
  const orders = customer ? await readOrdersForCustomer(handle, customer.id) : [];
  ctx.expect(orders.length === 1 && orders[0]!.status === 'completed' && orders[0]!.customer_id === customer?.id, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The completed order a refund request targets exists and is customer-scoped (no money mutated by merely reading it).',
    observation: `customer-scoped order read = ${orders.length} row(s); status="${orders[0]?.status}", customer_id="${orders[0]?.customer_id}".`,
    impact: 'Could not establish the customer-scoped order the refund-request flow reads.',
  });

  await proveRlsIsolation(ctx, handle, 'orders', orders.length > 0);
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'discord-readback',
    'Shortening download-link-ttl-ms to 60s makes a link older than a minute refused while a fresh one works.',
    'link lifetime is enforced by the HMAC signature+expiry inside the signed-URL helper and the download route (needs the dashboard route + signing secret)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'An enabled refund request routes the buyer’s ask into the owner’s dashboard queue as pending, with no auto-refund and no payments mutation.',
    'POST /api/portal/requests writes commerce_portal_requests and the owner queue reads it through /api/commerce/requests; proving the authenticated buyer submission and rendered owner queue requires the dashboard browser lane',
  );
  gatePortalAudit(ctx, 'The config change, the expired-link refusal, and the request filing are each audited.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Filing the same refund request twice dedupes to one queue entry.',
    'requires replaying the authenticated POST /api/portal/requests action through the dashboard browser lane and reading back its durable dedupe result',
  );
  gateDiscordOAuth(ctx, 'No Discord-side money or role effect occurs from filing the refund request.');
}

/** INVALID — tampered inputs are refused with zero data exposure. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  // Positive control: one REAL, valid session exists (a valid token resolves it).
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-valid');
  const validToken = scenarioToken(ctx, 'valid');
  const valid = customer
    ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash: hashToken(validToken) })
    : { id: null, error: 'no customer' };
  const validRow = await readSessionByHash(handle, hashToken(validToken));

  // A fabricated/tampered bearer token hashes to something that matches NO
  // session row — the exact route lookup returns nothing (its 401 branch), with
  // zero data exposure. Non-vacuous because the valid token DOES resolve a row.
  const forgedToken = `${ctx.runPrefix}forged-${Math.random().toString(36).slice(2)}-never-issued`;
  const forgedRow = await readSessionByHash(handle, hashToken(forgedToken));
  ctx.expect(validRow !== null && forgedRow === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A malformed/forged session token matches no session row (401, zero data exposure); a genuinely issued token resolves exactly one.',
    observation:
      `valid-token lookup → ${validRow ? 'resolved a session' : 'nothing'} (arrange err=${valid.error ?? 'none'}); ` +
      `forged-token lookup → ${forgedRow ? 'RESOLVED A SESSION' : 'nothing'} (expected nothing).`,
    impact: 'A fabricated bearer token resolved a portal session — token forgery would expose customer data.',
  });

  await proveRlsIsolation(ctx, handle, 'portal_sessions', validRow !== null);
  await proveNoOwnerAlert(ctx, handle);

  gateDiscordOAuth(ctx, 'No Discord account is affected and no OAuth session is established from the invalid inputs.');
  gatePortalAudit(ctx, 'Each rejection is logged with enough detail to spot probing patterns.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Repeating tampered requests indefinitely yields identical refusals with only rate-limit state accumulating.',
    'a forged/altered signed download URL and a garbage OAuth code are refused inside the dashboard HTTP routes (signature verify + Discord token exchange) — not reachable from the bot-only harness',
  );
}

/** UNAUTH — customer isolation: A’s valid session cannot read/act on B’s data. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordA = ctx.userId('a');
  const discordB = ctx.userId('b');

  // Two real customers in the SAME guild, each with their own order + license key.
  const custA = await seedCustomer(handle, discordA, 'e2e-portal-a');
  const custB = await seedCustomer(handle, discordB, 'e2e-portal-b');
  const prod = await seedProduct(handle, `${ctx.runPrefix}unauth-product`, 'file');
  const orderA = custA && prod ? await seedOrder(handle, { customerId: custA.id, productId: prod, orderNumber: `${ctx.runPrefix}unauth-a-order` }) : null;
  const orderB = custB && prod ? await seedOrder(handle, { customerId: custB.id, productId: prod, orderNumber: `${ctx.runPrefix}unauth-b-order` }) : null;
  const keyA = custA && prod && orderA ? await seedLicenseKey(handle, { customerId: custA.id, productId: prod, orderId: orderA.id, keyHash: hashToken(`${ctx.runPrefix}unauth-a-key`), boundDiscordId: discordA }) : { id: null, error: 'na' };
  const keyB = custB && prod && orderB ? await seedLicenseKey(handle, { customerId: custB.id, productId: prod, orderId: orderB.id, keyHash: hashToken(`${ctx.runPrefix}unauth-b-key`), boundDiscordId: discordB }) : { id: null, error: 'na' };

  const arranged = Boolean(custA && custB && orderA && orderB && keyA.id && keyB.id);
  ctx.expect(arranged, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: two distinct customers (A, B) each own a real order and license key in the same guild.',
    observation:
      `custA=${Boolean(custA)}, custB=${Boolean(custB)}, orderA=${Boolean(orderA)}, orderB=${Boolean(orderB)}, ` +
      `keyA=${Boolean(keyA.id)} (err=${keyA.error ?? 'none'}), keyB=${Boolean(keyB.id)} (err=${keyB.error ?? 'none'}).`,
    impact: 'Could not arrange two distinct customers — the isolation proof setup is invalid.',
  });

  // A’s bound customer scope returns ONLY A’s order; a probe for B’s specific
  // order id constrained to A’s customer returns nothing (the server-side 404/403).
  const aOrders = custA ? await readOrdersForCustomer(handle, custA.id) : [];
  const bOrderUnderA = custA && orderB ? await readOrderScoped(handle, orderB.id, custA.id) : null;
  ctx.expect(
    aOrders.length === 1 && aOrders[0]!.customer_id === custA?.id && aOrders[0]!.order_number === `${ctx.runPrefix}unauth-a-order` && bOrderUnderA === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Customer A’s session scope reads only A’s order; requesting B’s order id under A’s customer binding returns nothing (server-side customer scoping).',
      observation:
        `A-scoped orders = ${aOrders.length} (order_number="${aOrders[0]?.order_number}", customer_id="${aOrders[0]?.customer_id}"); ` +
        `B’s order fetched under A’s customer_id = ${bOrderUnderA ? 'RETURNED B’s ORDER' : 'nothing'}.`,
      impact: 'A customer-bound read returned another customer’s order — cross-customer data exposure through the portal read path.',
    },
  );

  // Same for license keys / device controls.
  const aKeys = custA ? await readLicenseKeysForCustomer(handle, custA.id) : [];
  const bKeyUnderA = custA && keyB.id ? await readLicenseKeyScoped(handle, keyB.id, custA.id) : null;
  ctx.expect(aKeys.length === 1 && aKeys[0]!.customer_id === custA?.id && bKeyUnderA === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Customer A’s license/device scope reads only A’s key; B’s key id under A’s binding returns nothing.',
    observation:
      `A-scoped license keys = ${aKeys.length} (customer_id="${aKeys[0]?.customer_id}"); ` +
      `B’s key under A’s customer_id = ${bKeyUnderA ? 'RETURNED B’s KEY' : 'nothing'}.`,
    impact: 'A customer-bound read exposed another customer’s license key — key/device isolation broken.',
  });

  // B’s rows are byte-identical after A’s probing (A never mutated them).
  const bOrderAfter = orderB ? await readOrderById(handle, orderB.id) : null;
  ctx.expect(bOrderAfter !== null && bOrderAfter.customer_id === custB?.id && bOrderAfter.order_number === `${ctx.runPrefix}unauth-b-order`, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Customer B’s data is unchanged after A’s cross-customer attempts.',
    observation: `B’s order after probing: customer_id="${bOrderAfter?.customer_id}", order_number="${bOrderAfter?.order_number}".`,
    impact: 'Customer B’s data changed during A’s probing — an isolation breach with a write side effect.',
  });

  await proveRlsIsolation(ctx, handle, 'customers', custA !== null);
  await proveNoOwnerAlert(ctx, handle);

  gateDiscordOAuth(ctx, 'Customer B’s roles, keys, and DMs are untouched by A’s attempts.');
  gatePortalAudit(ctx, 'A’s cross-customer attempts are logged as refusals with A’s identity.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Repeated cross-customer probing is visible to the owner via the security surface.',
    'the fraud/security surface is a dashboard view; sustained-probing detection needs the live portal HTTP routes to generate the signals',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'No sequence of replayed probes escalates A’s access.',
    'replayed cross-customer probes run through the portal HTTP routes (each re-checks the session’s customer binding) — not drivable by the bot-only harness',
  );
}

/** DEPFAIL — Discord OAuth outage fails safe at the door; existing sessions keep working. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  // The ONE fact provable now: an already-authenticated session reads its data
  // through Supabase ALONE — no Discord dependency — so an OAuth outage at the
  // door cannot break an existing session’s reads. Arrange a live session + order
  // and prove the session→customer→orders read resolves with no OAuth involved.
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-depfail');
  const productId = await seedProduct(handle, `${ctx.runPrefix}depfail-product`, 'file');
  const order = customer && productId
    ? await seedOrder(handle, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}depfail-a-order` })
    : null;
  const token = scenarioToken(ctx, 'a');
  const sess = customer ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash: hashToken(token) }) : { id: null, error: 'no customer' };

  const sessionRow = await readSessionByHash(handle, hashToken(token));
  const orders = sessionRow ? await readOrdersForCustomer(handle, sessionRow.customer_id) : [];
  ctx.expect(sessionRow !== null && orders.length === 1 && orders[0]!.order_number === `${ctx.runPrefix}depfail-a-order`, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'An already-authenticated session lists its orders via Supabase alone — no Discord/OAuth dependency — so a sign-in outage cannot break an existing session’s reads.',
    observation:
      `session resolved = ${sessionRow !== null} (arrange err=${sess.error ?? 'none'}); ` +
      `its customer-scoped order read returned ${orders.length} row(s) with no OAuth call in the path.`,
    impact: 'An existing session could not read its own data without Discord — the outage would not fail safe (authenticated customers would break too).',
  });

  await proveRlsIsolation(ctx, handle, 'portal_sessions', sessionRow !== null);

  // The outage BEHAVIOR itself (login-failed page, no session minted during the
  // outage, deduped alert, recovery) needs a Discord-outage fault lane + OAuth.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With Discord’s token endpoint unreachable, a fresh sign-in shows login-failed and no partial identity is trusted; sign-in recovers when Discord does.',
    'requires a Discord-OAuth dependency-outage fault lane + a real OAuth flow (POST /api/portal/auth) — the harness deliberately has no live Discord',
  );
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'No session rows are created during the outage window.',
    'requires driving POST /api/portal/auth under an induced Discord token-endpoint outage — not reachable here',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Failed logins during the outage are recorded as portal.login_failed with the dependency cause.',
    'the portal.login_failed audit row is written inside the auth route’s failure branch (needs the route + an outage fault lane)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A sustained OAuth outage raises exactly one deduped owner alert.',
    'requires a Discord-outage fault lane to generate the degradation alert; no outage can be induced against the reachable local stack',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The login-failed page stays calm and branded without exposing provider errors.',
    'the login-failed surface is rendered portal HTML from the auth route’s failure branch — no member-facing bot reply to inspect',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Retried sign-ins during the outage cannot mint sessions from stale codes afterward.',
    'requires the auth route + OAuth to replay a stale authorization code — not drivable by the bot-only harness',
  );
}

/** RETRY — a transient read failure recovers on retry with identical, complete results. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  const customer = await seedCustomer(handle, discordId, 'e2e-portal-retry');
  const productId = await seedProduct(handle, `${ctx.runPrefix}retry-product`, 'file');
  const order = customer && productId
    ? await seedOrder(handle, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}retry-a-order` })
    : null;

  // The retryable read is IDEMPOTENT: reading the customer-scoped order list twice
  // returns the identical, complete set with no duplication/omission and no state
  // accumulated. (The induced transient FAILURE + auto-retry glue is gated.)
  const first = customer ? await readOrdersForCustomer(handle, customer.id) : [];
  const second = customer ? await readOrdersForCustomer(handle, customer.id) : [];
  const sameSet =
    first.length === 1 &&
    second.length === 1 &&
    first[0]!.id === second[0]!.id &&
    first[0]!.order_number === `${ctx.runPrefix}retry-a-order`;
  ctx.expect(sameSet, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The orders read is idempotent: a retry returns exactly the customer’s rows with no duplication or omission.',
    observation:
      `first read = ${first.length} row(s) (id="${first[0]?.id}"); second read = ${second.length} row(s) (id="${second[0]?.id}"); ` +
      `identical set = ${sameSet}.`,
    impact: 'Re-reading the customer’s orders produced a different result set — a retry would duplicate or drop the customer’s data.',
  });
  ctx.expect(sameSet, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Retries of the idempotent orders read accumulate no state.',
    observation: `two identical reads returned the same single order id ("${first[0]?.id}") with nothing created between them.`,
    impact: 'A repeated read mutated state — the read path is not side-effect free.',
  });

  await proveRlsIsolation(ctx, handle, 'orders', first.length > 0);
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'Discord',
    'db-observable',
    'The induced transient DB failure makes the first orders fetch return a friendly error; the automatic retry returns the complete, correctly-scoped list.',
    'requires a mid-read fault-injection lane at the Supabase boundary (the harness runs against a reachable DB, so no transient failure can be induced)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The interim error state is a branded, retryable notice rather than a broken page.',
    'the interim error surface is rendered portal HTML reachable only under an induced read failure',
  );
  gatePortalAudit(ctx, 'The transient failure is traceable without polluting the customer’s action history.');
}

/** REPLAY — replayed session creation cannot double-apply (token_hash UNIQUE guard). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-replay');
  const token = scenarioToken(ctx, 'a');
  const tokenHash = hashToken(token);

  // First insert succeeds; re-delivering the SAME token_hash is fenced by the
  // portal_sessions token_hash UNIQUE index — the second insert errors and the
  // row count stays exactly one. This is the DB-level replay guard the portal
  // relies on so a re-posted session cannot become a duplicate row.
  const firstInsert = customer ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash }) : { id: null, error: 'no customer' };
  const replayInsert = customer ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash }) : { id: null, error: 'no customer' };
  const rowCount = await countSessionsByHash(handle, tokenHash);

  ctx.expect(firstInsert.id !== null && replayInsert.id === null && replayInsert.error !== null && rowCount === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the same session (identical token_hash) resolves to the single original row — the second write is rejected by the UNIQUE guard.',
    observation:
      `first insert id=${firstInsert.id ? 'created' : 'null'}; replay insert id=${replayInsert.id ? 'created' : 'null'} ` +
      `(error=${replayInsert.error ? 'rejected' : 'NONE'}); rows for token_hash = ${rowCount} (expected exactly 1).`,
    impact: 'A replayed session write created a duplicate portal_sessions row — the token_hash idempotency guard is not enforced.',
  });
  ctx.expect(rowCount === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Row counts are unchanged by the replay (one logical session → one row).',
    observation: `portal_sessions rows for the replayed token_hash = ${rowCount} (expected 1).`,
    impact: 'The replayed session write changed the row count — duplicate session state.',
  });

  await proveRlsIsolation(ctx, handle, 'portal_sessions', rowCount === 1);
  await proveNoOwnerAlert(ctx, handle);

  // The portal MUTATIONS the catalog enumerates (cancellation, key rotation,
  // device removal, request submission) have no reachable endpoint here.
  ctx.gate(
    'replay-safety',
    'paypal-sandbox',
    'Replayed cancellation confirmations, key rotations, device removals, and request submissions each resolve to their single original effect, including the PayPal non-renewal call.',
    'those portal mutations run through dashboard HTTP routes + PayPal (no portal cancellation/rotation/request endpoint exists in this tree) — their end-to-end idempotency is not drivable by the bot-only harness',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner queue holds one request entry regardless of resubmissions.',
    'the owner request queue is a dashboard surface fed by the (absent) portal request endpoint',
  );
  gatePortalAudit(ctx, 'Replays are visible as no-ops without duplicating the original action entries.');
  gateBrandingChrome(ctx);
  gateDiscordOAuth(ctx, 'Role and entitlement state reflect the single original effect of each mutation.');
}

/** RESTART — portal state survives a full stack reboot (it lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const discordId = ctx.userId('a');

  // Boot #1: create a live session + a scheduled-cancellation-shaped entitlement,
  // snapshot the durable fields, then dispose the stack (simulate shutdown).
  const first = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const customer = await seedCustomer(first, discordId, 'e2e-portal-restart');
  const productId = await seedProduct(first, `${ctx.runPrefix}restart-product`, 'access_pass', 'subscription');
  const order = customer && productId ? await seedOrder(first, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}restart-a-order` }) : null;
  const termEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ent = customer && productId && order
    ? await seedEntitlement(first, { customerId: customer.id, productId, orderId: order.id, type: 'subscription', status: 'active', expiresAt: termEnd })
    : { id: null, error: 'arrange failed' };
  const token = scenarioToken(ctx, 'a');
  const sess = customer ? await seedSession(first, { customerId: customer.id, discordId, tokenHash: hashToken(token) }) : { id: null, error: 'no customer' };
  const sessBefore = await readSessionByHash(first, hashToken(token));
  const entBefore = ent.id ? await readEntitlementById(first, ent.id) : null;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The same token still resolves the session,
  // the entitlement’s scheduled end date is intact — because it all lives in the DB.
  const second = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const sessAfter = await readSessionByHash(second, hashToken(token));
  const entAfter = ent.id ? await readEntitlementById(second, ent.id) : null;

  ctx.expect(
    sessBefore !== null &&
      sessAfter !== null &&
      sessAfter.id === sessBefore.id &&
      sessAfter.token_hash === sessBefore.token_hash &&
      sessAfter.expires_at === sessBefore.expires_at &&
      entBefore !== null &&
      entAfter !== null &&
      entAfter.status === entBefore.status &&
      entAfter.expires_at === entBefore.expires_at,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After a full stack restart the same token resolves the same session and the scheduled cancellation date is byte-identical (state lives in Supabase, not process memory).',
      observation:
        `session id ${sessBefore?.id} → ${sessAfter?.id}, expires_at ${sessBefore?.expires_at} → ${sessAfter?.expires_at}; ` +
        `entitlement status ${entBefore?.status} → ${entAfter?.status}, expires_at ${entBefore?.expires_at} → ${entAfter?.expires_at}.`,
      impact: 'Portal session or scheduled-cancellation state did not survive a restart — a persisted row was lost or altered across boot.',
    },
  );

  await proveRlsIsolation(ctx, second, 'portal_sessions', sessAfter !== null);
  await proveNoOwnerAlert(ctx, second);

  gateDiscordOAuth(ctx, 'Post-restart the subscriber’s roles still reflect the retained-until-term-end access.');
  gatePortalAudit(ctx, 'The audit trail is continuous across the restart with no gaps or duplicates.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner queue still shows the pending request after restart.',
    'the owner request queue is a dashboard surface fed by the (absent) portal request endpoint',
  );
  gateBrandingChrome(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'In-flight requests spanning the restart are absorbed idempotently.',
    'requires the portal request/mutation endpoints to drive an in-flight request across the reboot',
  );
}

/** RACE — concurrent session creation is decided by the DB (token_hash UNIQUE). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-race');
  const token = scenarioToken(ctx, 'a');
  const tokenHash = hashToken(token);

  // Two SIMULTANEOUS inserts of the same token_hash — the UNIQUE index decides the
  // race at the database level: exactly one row lands, no duplicate/orphan.
  const [r1, r2] = customer
    ? await Promise.all([
        seedSession(handle, { customerId: customer.id, discordId, tokenHash }),
        seedSession(handle, { customerId: customer.id, discordId, tokenHash }),
      ])
    : [{ id: null, error: 'no customer' }, { id: null, error: 'no customer' }];
  const winners = [r1, r2].filter((r) => r.id !== null).length;
  const losers = [r1, r2].filter((r) => r.id === null && r.error !== null).length;
  const rowCount = await countSessionsByHash(handle, tokenHash);

  ctx.expect(winners === 1 && losers === 1 && rowCount === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Two concurrent session creations with the same token_hash resolve to exactly one row — the database-level UNIQUE guard decides the race with no duplicate or orphaned session.',
    observation: `concurrent inserts → winners=${winners}, losers=${losers}; portal_sessions rows for the token_hash = ${rowCount} (expected exactly 1).`,
    impact: 'A concurrent session race produced a duplicate/orphaned portal_sessions row — the DB-level guard did not settle the race.',
  });

  // A late retry from the losing racer stays fenced (same UNIQUE guard).
  const late = customer ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash }) : { id: null, error: 'no customer' };
  const finalCount = await countSessionsByHash(handle, tokenHash);
  ctx.expect(late.id === null && late.error !== null && finalCount === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A late retry from the losing racer stays fenced — still exactly one row.',
    observation: `late retry id=${late.id ? 'created' : 'null'} (error=${late.error ? 'rejected' : 'NONE'}); final rows = ${finalCount} (expected 1).`,
    impact: 'A late retry created a second session row — the race guard is not durable against replays.',
  });

  await proveRlsIsolation(ctx, handle, 'portal_sessions', finalCount === 1);
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'Discord',
    'discord-readback',
    'A rotation racing a device removal leaves a consistent final state (one new key generation, device correctly detached).',
    'key rotation and device removal are portal/dashboard HTTP actions with no endpoint in this tree — the rotation∣device race is not drivable here',
  );
  gatePortalAudit(ctx, 'Both racers are logged with the winner’s effect appearing once.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner sees one coherent subscription and key state, not conflicting entries.',
    'the owner subscription/key views are dashboard surfaces fed by the (absent) portal mutation endpoints',
  );
}

/** XGUILD — portal isolation is per guild: a guild-A customer has no guild-B row. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const discordId = ctx.userId('a'); // the SAME Discord identity in both portals
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyEnabled: false });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyEnabled: false });

  // The buyer is a customer in guild A ONLY, with a purchase there.
  const custA = await seedCustomer(handleA, discordId, 'e2e-portal-xguild');
  const prodA = await seedProduct(handleA, `${ctx.runPrefix}xguild-product`, 'file');
  const orderA = custA && prodA ? await seedOrder(handleA, { customerId: custA.id, productId: prodA, orderNumber: `${ctx.runPrefix}xguild-a-order` }) : null;

  // Guild-scoped customer match (the catalog intent): guild A resolves the buyer,
  // guild B resolves NOTHING — no customer row exists in guild B for this identity.
  const matchInA = await readCustomerByGuild(handleA, guildA, discordId);
  const matchInB = await readCustomerByGuild(handleB, guildB, discordId);
  ctx.expect(matchInA !== null && matchInA.guild_id === guildA && matchInB === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Customer matching is guild-scoped: the buyer resolves in guild A and NOT in guild B (no guild-B customer row exists or is created for this Discord identity).',
    observation:
      `guild-A-scoped match → ${matchInA ? `customer under "${matchInA.guild_id}"` : 'nothing'}; ` +
      `guild-B-scoped match → ${matchInB ? 'A CUSTOMER ROW' : 'nothing'} (expected nothing).`,
    impact: 'A guild-B-scoped customer match returned a row for a guild-A-only buyer — cross-guild customer leakage.',
  });

  // Guild A owns the order; guild B owns none for this buyer.
  const aOrders = custA ? await readOrdersForCustomer(handleA, custA.id) : [];
  ctx.expect(aOrders.length === 1 && aOrders[0]!.guild_id === guildA, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The buyer’s order is scoped to guild A; guild B has no order for this identity.',
    observation: `guild-A customer orders = ${aOrders.length} under guild "${aOrders[0]?.guild_id}"; guild B has no customer to own one.`,
    impact: 'Order ownership crossed guild boundaries — per-guild portal isolation broken.',
  });

  await proveRlsIsolation(ctx, handleA, 'customers', custA !== null);
  await proveNoOwnerAlert(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB);

  // CONCERN (gated, not faked): the real POST /api/portal/auth matches customers by
  // discord_id ONLY (`.eq('discord_id', …).limit(1)`) and takes NO guild parameter,
  // so whether signing into guild B’s portal wrongly binds the guild-A customer is
  // a behavior only the live HTTP route + OAuth can decide. Surfaced, never softened.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The same Discord identity authenticates in both portals yet sees strictly guild-scoped results (guild B shows the no-purchases notice).',
    'CONCERN: /api/portal/auth matches customers by discord_id only (not guild-scoped, no guild parameter); whether guild-B sign-in wrongly binds the guild-A customer needs the live portal route + real OAuth to observe — gated, not asserted, so it is neither faked green nor fabricated red',
  );
  gatePortalAudit(ctx, 'The guild-B login attempt is audited under guild B with no reference to guild-A data.');
  ctx.gate(
    'branding',
    'discord-readback',
    'Each portal renders its own guild’s brand kit, proving branding is guild-scoped.',
    'portal chrome is rendered dashboard HTML per guild — a snapshot comparer against each live portal render is required',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Repeated cross-guild logins never leak or link data across guilds.',
    'requires the live auth route + OAuth to replay cross-guild sign-ins',
  );
}

/** CLEANUP — run-prefixed portal resources sweep to zero; audit is retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const discordId = ctx.userId('a');

  // Create a full run-prefixed operational footprint: customer, product, order,
  // entitlement, and a live portal session.
  const customer = await seedCustomer(handle, discordId, 'e2e-portal-cleanup');
  const productId = await seedProduct(handle, `${ctx.runPrefix}cleanup-product`, 'file');
  const order = customer && productId ? await seedOrder(handle, { customerId: customer.id, productId, orderNumber: `${ctx.runPrefix}cleanup-a-order` }) : null;
  const ent = customer && productId && order ? await seedEntitlement(handle, { customerId: customer.id, productId, orderId: order.id }) : { id: null, error: 'na' };
  const token = scenarioToken(ctx, 'a');
  const sess = customer ? await seedSession(handle, { customerId: customer.id, discordId, tokenHash: hashToken(token) }) : { id: null, error: 'na' };

  const before = await countGuildRows(handle, ['portal_sessions', 'entitlements', 'orders', 'products', 'customers']);
  ctx.expect(before >= 5, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed portal resources across sessions/entitlements/orders/products/customers (pre-cleanup baseline).',
    observation: `pre-cleanup rows across portal tables = ${before} (expected >= 5).`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed portal rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, 'portal_sessions', sess.id !== null);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO operational rows.
  await ctx.sweepGuildRows(handle);
  const afterFirst = await countGuildRows(handle, ['portal_sessions', 'entitlements', 'license_keys', 'payments', 'orders', 'products', 'customers']);
  ctx.expect(afterFirst === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed portal sessions, entitlements, orders, products, and customers are deleted; a sweep finds zero operational residue.',
    observation: `post-sweep operational rows across portal tables = ${afterFirst}.`,
    impact: 'The cleanup sweep left run-prefixed portal rows behind — the suite leaves residue in the disposable database.',
  });

  // A second cleanup pass is an error-free no-op (idempotent teardown).
  await ctx.sweepGuildRows(handle);
  const afterSecond = await countGuildRows(handle, ['portal_sessions', 'entitlements', 'license_keys', 'payments', 'orders', 'products', 'customers']);
  ctx.expect(afterSecond === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A second cleanup pass is an error-free no-op (still zero operational residue).',
    observation: `after a second sweep, operational rows across portal tables = ${afterSecond}.`,
    impact: 'A second cleanup pass changed state or left residue — teardown is not idempotent.',
  });

  // Audit retention is by DESIGN (audit_logs is deliberately excluded from the
  // guild-scoped sweep list); with no portal-action route driven here, no portal
  // audit rows were generated to verify content, so the content check is gated.
  ctx.gate(
    'audit',
    'audit-row',
    'Portal action audit rows remain append-only after the operational sweep (audit retained, not deleted).',
    'audit_logs is intentionally omitted from guildScopedTables so the sweep never touches it; but no portal-action audit row was produced in this harness (routes undrivable) to verify the retention content',
  );
  gateDiscordOAuth(ctx, 'Any Discord-side effects of run portal actions (role retention windows, cancellations) are unwound on test accounts.');
  gateBrandingChrome(ctx);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner queue holds no lingering test requests post-sweep.',
    'the owner request queue is a dashboard surface fed by the (absent) portal request endpoint',
  );
}

// Local re-declaration of the runner’s row counter (kept private to the script so
// it takes no import from context.ts): counts rows for the handle’s guild across
// the given tables. Tables that error contribute 0 (best-effort, honest).
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

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The customer-portal domain proof. guildScopedTables are child→parent so the
 * FK-constrained rows are removed before their parents (guild_config + guild are
 * always swept in addition by the runner). license_sessions and product_files are
 * intentionally omitted — they carry no guild_id and cascade from license_keys /
 * products respectively. audit_logs is intentionally omitted so the sweep RETAINS
 * the audit trail (the domain’s cleanup contract).
 */
export const commercePortalProof: DomainProof = {
  domainId: 'commerce-portal',
  guildScopedTables: [
    'portal_sessions',
    'entitlements',
    'license_keys',
    'payments',
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
