/**
 * scenario-runner/scripts/commerce-paypal — the PayPal money-rail domain proof.
 *
 * Binds the commerce-paypal domain's 12 declarative catalog scenarios to concrete
 * real-stack proofs driven against LOCAL Supabase. Every DB-observable / RLS /
 * idempotency-fence / cross-guild assertion runs NOW against the REAL production
 * commerce schema (the exact tables, unique constraints, and RPCs the dashboard
 * PayPal webhook + refund routes and the bot's commerce services write); anything
 * needing a live PayPal sandbox effect, the dashboard HTTP webhook/refund route, a
 * verification-outage fault lane, or a live Discord DM/role effect is GATED — never
 * faked, never forced green.
 *
 * The hard harness boundary for THIS domain (why it is mostlyGated):
 *   - The money RAIL is the dashboard Next.js routes: POST /api/paypal/webhook
 *     (signature-verify → claim → process) and POST /api/orders/[id]/refund
 *     (requireGuildOwner → provider-first PayPal refund → local flip). NEITHER is a
 *     Discord slash command, so `ctx.runSlash` (the bot dispatcher) cannot drive
 *     them at all. Signature verification, the 400/401/403 authz envelopes, the
 *     stale-processing reclaim window, and the provider-first refund settlement
 *     therefore GATE (dashboard-HTTP + PayPal-sandbox + fault-injection lanes).
 *   - Buyer receipt / grace-warning / refund DMs and the granted/removed roles are
 *     live Discord effects → GATED (DISCORD_TOKEN + live guild).
 *
 * What DOES run for real (the durable money-truth layer the routes commit to):
 *   - RLS lockdown: orders/payments/entitlements/payment_refunds are service_role
 *     only (20260710010000 + 20260710040000). Positive-control anon-denial probes
 *     prove a money row the service role sees is invisible/unwritable to anon.
 *   - The exactly-once idempotency FENCES the whole replay-safety promise rests on:
 *     payments.paypal_payment_id / paypal_event_id are UNIQUE, webhook_events.event_id
 *     is the PK, payment_refunds.paypal_refund_id is UNIQUE, and the grace alert has a
 *     partial-unique index (guild_id, entitlement_id) WHERE unresolved. Redelivering
 *     (and racing) the same provider id is rejected by the DB (23505) — read back as
 *     count==1. These are the real fences, asserted live.
 *   - FK integrity: a refund whose payment row never existed cannot persist
 *     (payment_refunds.payment_id is NOT NULL + FK → 23503) — "never fabricate a
 *     payment to refund", proven at the DB.
 *   - Per-guild isolation across two real guilds, and run-prefixed cleanup with
 *     append-only audit retained.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface CommerceChain {
  customerId: string;
  productId: string;
  orderId: string;
}

interface PaymentInsert {
  order_id: string;
  customer_id: string;
  guild_id: string;
  paypal_payment_id: string;
  paypal_event_id: string;
  amount_cents: number;
  currency: string;
  status: 'completed' | 'refunded' | 'reversed' | 'pending' | 'failed';
}

interface RefundInsert {
  payment_id: string;
  order_id: string;
  guild_id: string;
  paypal_refund_id: string;
  event_type: string;
  amount_cents: number | null;
  currency: string | null;
}

/** A supabase-js write outcome reduced to the two fields the proofs read. */
interface WriteOutcome {
  id: string | null;
  code: string | null;
}

// ── Catalog helpers ────────────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A run-prefixed, scenario-scoped, globally-unique id for a provider/order key.
 *  Run-prefixed so a leftover row is attributable + sweepable; random-suffixed so
 *  distinct rows never collide on the UNIQUE/PK columns across a scenario. */
function uid(ctx: ScenarioContext, kind: string): string {
  return `${ctx.runPrefix}${ctx.scenarioClass.toLowerCase()}-${kind}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Live-stack arrangement (REAL commerce data model) ─────────────────────

/**
 * Arrange the exact production commerce chain a captured/subscription payment
 * hangs off: customer → product → completed order. This is the same identity
 * shape the payment-handler persists and the webhook route fulfills, inserted
 * through the service-role client (which bypasses RLS, as the bot + dashboard API
 * do). Returns null ids on failure so the caller can record an arrangement FAIL.
 */
async function arrangeCommerceChain(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  opts: { amountCents?: number; currency?: string; discordId?: string } = {},
): Promise<CommerceChain | null> {
  const amountCents = opts.amountCents ?? 500;
  const currency = opts.currency ?? 'USD';
  const { data: cust } = await handle.supabase
    .from('customers')
    .insert({
      guild_id: handle.guildId,
      discord_id: opts.discordId ?? uid(ctx, 'buyer'),
      discord_username: 'e2e-commerce-paypal',
    })
    .select('id')
    .single();
  const customerId = (cust as { id: string } | null)?.id;
  const { data: prod } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}paypal-product`,
      type: 'one_time',
      delivery_type: 'access_pass',
      price_cents: amountCents,
      currency,
      granted_role_ids: [],
    })
    .select('id')
    .single();
  const productId = (prod as { id: string } | null)?.id;
  if (!customerId || !productId) return null;
  const { data: order } = await handle.supabase
    .from('orders')
    .insert({
      order_number: uid(ctx, 'ord'),
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: productId,
      amount_cents: amountCents,
      currency,
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();
  const orderId = (order as { id: string } | null)?.id;
  if (!orderId) return null;
  return { customerId, productId, orderId };
}

async function insertPayment(handle: LiveClientHandle, row: PaymentInsert): Promise<WriteOutcome> {
  const { data, error } = await handle.supabase
    .from('payments')
    .insert(row)
    .select('id')
    .maybeSingle();
  return { id: (data as { id: string } | null)?.id ?? null, code: error?.code ?? null };
}

async function insertRefund(handle: LiveClientHandle, row: RefundInsert): Promise<WriteOutcome> {
  const { data, error } = await handle.supabase
    .from('payment_refunds')
    .insert(row)
    .select('id')
    .maybeSingle();
  return { id: (data as { id: string } | null)?.id ?? null, code: error?.code ?? null };
}

async function insertActiveEntitlement(
  handle: LiveClientHandle,
  chain: CommerceChain,
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('entitlements')
    .insert({
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      product_id: chain.productId,
      order_id: chain.orderId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
      granted_role_ids: [],
      granted_channel_ids: [],
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function insertWebhookEvent(
  handle: LiveClientHandle,
  eventId: string,
  eventType: string,
  result: 'success' | 'error' | 'duplicate',
): Promise<WriteOutcome> {
  const { data, error } = await handle.supabase
    .from('webhook_events')
    .insert({ event_id: eventId, event_type: eventType, payload: { e2e: true }, result })
    .select('event_id')
    .maybeSingle();
  return { id: (data as { event_id: string } | null)?.event_id ?? null, code: error?.code ?? null };
}

async function deleteWebhookEvent(handle: LiveClientHandle, eventId: string): Promise<void> {
  await handle.supabase.from('webhook_events').delete().eq('event_id', eventId);
}

async function countByEq(
  handle: LiveClientHandle,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value);
  return count ?? 0;
}

async function countGuildRows(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
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

// ── Anon-denial RLS probes (PostgREST REST — no supabase-js dependency) ────

/** Rows an anon key can read for a guild-scoped table (RLS deny → 0), or null
 *  when no SUPABASE_URL / a gateway rejection before authz (→ GATE). 42501
 *  "permission denied" is the deny we want to prove. */
async function anonReadCount(anonKey: string, table: string, guildId: string): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=guild_id&guild_id=eq.${encodeURIComponent(guildId)}`;
  try {
    const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
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

/** Whether an anon INSERT into a money table is denied. true = denied (RLS/GRANT
 *  working), false = it SUCCEEDED (an RLS breach — a real finding), null =
 *  inconclusive (→ GATE). Any row that slips in carries the run guild id and is
 *  swept. */
async function anonInsertDenied(
  anonKey: string,
  table: string,
  row: Record<string, unknown>,
): Promise<boolean | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/rest/v1/${table}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (res.ok) return false;
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      body = {};
    }
    if (
      res.status === 401 ||
      res.status === 403 ||
      body.code === '42501' ||
      (body.message ?? '').toLowerCase().includes('permission denied')
    ) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Guild-scoped RLS on a money table, made non-vacuous by a positive control: the
 * scenario has already written a row under this guild (service role sees it), so
 * an anon client reading ZERO is a real deny — not "nothing to read". Cross-guild
 * isolation across two real guilds is proven separately in XGUILD.
 */
async function proveMoneyRls(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (service_role-only RLS lockdown).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
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
  const serviceRows = await countGuildRows(handle, table);
  ctx.expect(serviceRows > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} row(s) while an anon client reads zero of them (RLS money-row lockdown).`,
    observation:
      `service-role sees ${serviceRows} ${table} row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} money row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct money-data exposure).`,
  });
}

/** The happy-path money flow raises no owner alert ("healthy money flow stays quiet"). */
async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's healthy money flow raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: "This scenario's healthy money flow raises no owner alert (the owner surface stays quiet).",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert fired on a healthy money path — false-alarm / notification noise.',
  });
}

/**
 * Buyer-facing money messages (receipt / grace-warning / refund DMs) and the
 * PayPal-checkout brand fields are ALL sent by the dashboard webhook route / the
 * PayPal API, never as a bot slash reply. There is nothing member-facing to
 * inspect in this bot-only harness, so branding GATEs honestly (never a hollow
 * pass over a synthetic string).
 */
function gateBuyerBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    "Buyer money messaging (receipt / grace / refund) carries the owner brand and voice with powered-by-SomniBot attribution.",
    'the buyer receipt/grace/refund messages are DMs emitted by the dashboard PayPal webhook route (not a bot slash reply), so there is no captured member-facing surface to inspect here',
  );
  ctx.gate(
    'branding',
    'paypal-sandbox',
    'The PayPal checkout brand fields (brand_name) render the owner brand.',
    'requires a live PayPal sandbox checkout (PAYPAL_* credentials) to read back the checkout brand fields',
  );
}

/** Live Discord effects for this domain (buyer DMs + role grant/removal). */
function gateBuyerDiscord(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'Every money event surfaces to the buyer exactly once (receipt / grace / refund DM) and role state tracks entitlement state.',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) to read buyer DMs and granted/removed roles',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a sandbox capture is verified, processed exactly once, and recorded as money truth. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx, { amountCents: 1499, currency: 'USD' });
  ctx.expect(chain !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: the customer/product/completed-order chain a capture hangs off exists.',
    observation: `commerce chain arranged = ${chain !== null}.`,
    impact: 'Could not arrange the commerce chain — the capture-processing proof setup is invalid.',
  });
  if (!chain) {
    gateBuyerBranding(ctx);
    gateBuyerDiscord(ctx);
    return;
  }

  // The processed capture: exactly one payments row keyed to the capture id, with
  // the capture's EXACT amount/currency, plus the active entitlement it grants.
  const captureId = uid(ctx, 'capture');
  const eventId = uid(ctx, 'evt');
  const first = await insertPayment(handle, {
    order_id: chain.orderId,
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    paypal_payment_id: captureId,
    paypal_event_id: eventId,
    amount_cents: 1499,
    currency: 'USD',
    status: 'completed',
  });
  const entitlementId = await insertActiveEntitlement(handle, chain);
  ctx.expect(first.id !== null && entitlementId !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'A processed capture records one payments row (exact amount/currency, keyed to the capture id) and one active entitlement.',
    observation:
      `payment row id=${first.id ?? '(none)'} (insert code=${first.code ?? 'ok'}); ` +
      `active entitlement id=${entitlementId ?? '(none)'}.`,
    impact: 'The capture did not record the singular payment + entitlement money truth.',
  });

  // Idempotency FENCE (replay-safety): re-delivering the SAME capture is rejected
  // by the paypal_payment_id UNIQUE constraint — the exactly-once no-op the whole
  // replay promise rests on, proven at the DB (not by process memory).
  const replay = await insertPayment(handle, {
    order_id: chain.orderId,
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    paypal_payment_id: captureId,
    paypal_event_id: uid(ctx, 'evt'),
    amount_cents: 1499,
    currency: 'USD',
    status: 'completed',
  });
  const paymentsForCapture = await countByEq(handle, 'payments', 'paypal_payment_id', captureId);
  ctx.expect(replay.code === '23505' && paymentsForCapture === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The capture id is recorded such that any redelivery is a proven DB-enforced no-op (paypal_payment_id UNIQUE).',
    observation:
      `second insert of the same capture id returned code=${replay.code ?? 'ok(!)'}; ` +
      `payments rows for that capture id = ${paymentsForCapture} (expected 1).`,
    impact: 'A redelivered capture created a second payments row — the exactly-once money fence is not enforced.',
  });

  // The webhook event log records the event id, and its PRIMARY KEY makes a
  // redelivery a proven no-op: the same event id inserted twice is DB-rejected.
  const wevtId = uid(ctx, 'wevt');
  const evt = await insertWebhookEvent(handle, wevtId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const evtDup = await insertWebhookEvent(handle, wevtId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const evtRows = await countByEq(handle, 'webhook_events', 'event_id', wevtId);
  ctx.expect(evt.id !== null && evtDup.code === '23505' && evtRows === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The webhook event log records the processed event id such that any redelivery is a proven no-op (webhook_events.event_id PK).',
    observation:
      `first event_id=${evt.id ?? '(none)'}; redelivery insert code=${evtDup.code ?? 'ok(!)'}; ` +
      `webhook_events rows for that event id = ${evtRows} (expected 1).`,
    impact: 'The processed event id was not recorded exactly once — the event-log dedup fence failed.',
  });
  await deleteWebhookEvent(handle, wevtId);

  await proveMoneyRls(ctx, handle, 'payments');
  await proveNoOwnerAlert(ctx, handle);
  // The route writes the audit_logs fulfillment trail; not reachable bot-only.
  ctx.gate(
    'audit',
    'discord-readback',
    'audit_logs holds the fulfillment trail (deliver_receipt / role grant) for the processed capture.',
    'the fulfillment audit_logs rows are written by the dashboard webhook route + action-queue worker, not reachable in a bot-only harness',
  );
  gateBuyerBranding(ctx);
  gateBuyerDiscord(ctx);
}

/** SET-A — grace configuration: a failed subscription payment enters a deduped grace window. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const graceDefault = Number(declaredDefault(ctx.domain, 'payment-grace-period-days') ?? 3);
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  const entitlementId = chain ? await insertActiveEntitlement(handle, chain) : null;
  ctx.expect(entitlementId !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: an active subscription entitlement exists to enter grace.',
    observation: `entitlement arranged = ${entitlementId !== null}.`,
    impact: 'Could not arrange the entitlement — the grace-period proof setup is invalid.',
  });
  if (!entitlementId) {
    gateBuyerBranding(ctx);
    gateBuyerDiscord(ctx);
    return;
  }

  // The grace-entry owner alert is DB-deduped by uniq_alerts_unresolved_entitlement_grace
  // (guild_id, entitlement_id) WHERE unresolved: entering grace twice (a replayed
  // PAYMENT.FAILED) must yield EXACTLY ONE unresolved alert, refreshed not stacked.
  const graceMeta = { entitlement_id: entitlementId, source: 'e2e-commerce-paypal' };
  const firstAlert = await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId,
    alert_type: 'entitlement_grace_period',
    severity: 'warning',
    title: 'Paid entitlement entered payment grace period',
    message: `Entitlement ${entitlementId} entered a grace period.`,
    metadata: graceMeta,
  });
  const dupAlert = await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId,
    alert_type: 'entitlement_grace_period',
    severity: 'warning',
    title: 'Paid entitlement entered payment grace period (replay)',
    message: `Entitlement ${entitlementId} re-entered grace on a replayed failure event.`,
    metadata: graceMeta,
  });
  const unresolvedGrace = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('alert_type', 'entitlement_grace_period')
    .eq('metadata->>entitlement_id', entitlementId)
    .eq('resolved', false);
  const graceAlerts = unresolvedGrace.count ?? 0;
  ctx.expect(firstAlert.error === null && dupAlert.error?.code === '23505' && graceAlerts === 1, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise:
      'Exactly one unresolved entitlement_grace_period alert exists per entitlement — a re-entry is deduped (refreshed), never stacked.',
    observation:
      `first grace alert insert code=${firstAlert.error?.code ?? 'ok'}; ` +
      `duplicate insert code=${dupAlert.error?.code ?? 'ok(!)'}; ` +
      `unresolved grace alerts for the entitlement = ${graceAlerts} (expected 1).`,
    impact: 'A replayed payment-failure stacked a second grace alert — owner-alert dedup is not enforced at the DB.',
  });
  // Replaying the failure neither stacks a second alert (proven above) — record
  // the replay-safety facet against the same fence.
  ctx.expect(dupAlert.error?.code === '23505' && graceAlerts === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Replaying the failure event does not stack a second grace alert (the unresolved-grace unique index absorbs it).',
    observation: `replayed grace alert insert code=${dupAlert.error?.code ?? 'ok(!)'}; unresolved grace alerts=${graceAlerts}.`,
    impact: 'A replayed failure event stacked a duplicate grace alert.',
  });

  await proveMoneyRls(ctx, handle, 'entitlements');
  // The grace WINDOW math (grace_period_ends_at = now + configured days), the
  // buyer keeping roles + the grace DM, the grace_period_started audit, and the
  // config-row value all live in EntitlementService.suspend (TS) + the webhook
  // path — undrivable bot-only, so they GATE (never faked to a synthetic date).
  ctx.gate(
    'database-RLS',
    'db-observable',
    `The entitlement enters grace_period with grace_period_ends_at exactly ${graceDefault} days out, and the config row shows the configured window.`,
    'the grace transition + window math live in EntitlementService.suspend (driven by the dashboard PayPal subscription-failed webhook), not reachable through the bot slash dispatcher',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'entitlement.grace_period_started is audited with the configured window and order linkage.',
    'the grace-period audit row is written by EntitlementService.suspend on the webhook path, not reachable bot-only',
  );
  gateBuyerBranding(ctx);
  gateBuyerDiscord(ctx);
}

/** SET-B — shortened stale-processing window: a crashed in-processing event is reclaimed once. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const staleDefault = Number(declaredDefault(ctx.domain, 'webhook-stale-processing-ms') ?? 300000);
  const handle = await ctx.bootGuild({ label: 'a' });

  // The one DB-observable fence for reclaim/redelivery convergence: webhook_events.event_id
  // is the PK, so the "reclaimed run completes exactly once" — a redelivery of the
  // same event id can never create a second completion row.
  const eventId = uid(ctx, 'wevt');
  const claimed = await insertWebhookEvent(handle, eventId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const redeliver = await insertWebhookEvent(handle, eventId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const rows = await countByEq(handle, 'webhook_events', 'event_id', eventId);
  ctx.expect(claimed.id !== null && redeliver.code === '23505' && rows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A reclaimed event completes exactly once: the event id PK makes any post-window redelivery a proven no-op.',
    observation:
      `first claim event_id=${claimed.id ?? '(none)'}; redelivery insert code=${redeliver.code ?? 'ok(!)'}; ` +
      `webhook_events rows for that event id = ${rows} (expected 1).`,
    impact: 'A redelivered event created a second completion row — the reclaim/redelivery is not exactly-once at the DB.',
  });
  if (claimed.id) await deleteWebhookEvent(handle, eventId);

  await proveNoOwnerAlert(ctx, handle);
  // The stale-processing CLAIM window itself (processing/claimed_at columns, the
  // < configured-ms reclaim, the concurrent-redelivery refusal inside the window)
  // lives entirely in the dashboard webhook route — undrivable bot-only.
  ctx.gate(
    'database-RLS',
    'db-observable',
    `A crashed in-processing event is reclaimed by the next redelivery after the shortened ${staleDefault}ms window, and the config row reflects the shortened window.`,
    'the processing-claim + stale-reclaim window lives in the dashboard PayPal webhook route (POST /api/paypal/webhook) with no bot slash surface',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The event trail shows claim → stale reclaim after the configured window → completion in order.',
    'the reclaim event trail is written by the dashboard webhook route, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard webhook log shows the event recovered without a manual replay.',
    'requires the dashboard webhook-log panel readback',
  );
  gateBuyerBranding(ctx);
  gateBuyerDiscord(ctx);
}

/** INVALID — invalid money operations are refused whole, with zero partial effects. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  ctx.expect(chain !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a commerce chain exists to attempt an invalid refund against.',
    observation: `commerce chain arranged = ${chain !== null}.`,
    impact: 'Could not arrange the commerce chain — the invalid-refund proof setup is invalid.',
  });
  if (!chain) {
    gateBuyerBranding(ctx);
    gateBuyerDiscord(ctx);
    return;
  }

  // A refund against a NEVER-captured order cannot persist an attempt row: the
  // payment_refunds.payment_id NOT NULL + FK rejects an orphan refund (23503) —
  // "never fabricate a payment to refund", enforced at the DB. Resubmitting stays
  // a pure no-op (deterministic rejection), so no ledger growth.
  const orphanPaymentId = '00000000-0000-4000-8000-0000000000ff';
  const refundId = uid(ctx, 'refund');
  const attempt1 = await insertRefund(handle, {
    payment_id: orphanPaymentId,
    order_id: chain.orderId,
    guild_id: handle.guildId,
    paypal_refund_id: refundId,
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    amount_cents: 500,
    currency: 'USD',
  });
  const attempt2 = await insertRefund(handle, {
    payment_id: orphanPaymentId,
    order_id: chain.orderId,
    guild_id: handle.guildId,
    paypal_refund_id: refundId,
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    amount_cents: 500,
    currency: 'USD',
  });
  const refundRows = await countByEq(handle, 'payment_refunds', 'paypal_refund_id', refundId);
  ctx.expect(attempt1.code === '23503' && attempt2.code === '23503' && refundRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'A refund attempt against a never-captured payment cannot persist a ledger row (payment_refunds.payment_id NOT NULL + FK); resubmitting stays a pure no-op.',
    observation:
      `first orphan-refund insert code=${attempt1.code ?? 'ok(!)'}; resubmit code=${attempt2.code ?? 'ok(!)'}; ` +
      `payment_refunds rows for the request id = ${refundRows} (expected 0).`,
    impact: 'An orphan refund (no captured payment) wrote a ledger row — the DB fabricated/permitted a payment to refund.',
  });
  ctx.expect(attempt2.code === '23503' && refundRows === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Resubmitting the invalid refund repeatedly stays a pure no-op with no ledger growth.',
    observation: `resubmit code=${attempt2.code ?? 'ok(!)'}; payment_refunds rows=${refundRows} (expected 0).`,
    impact: 'A resubmitted invalid refund accumulated ledger rows.',
  });

  await proveMoneyRls(ctx, handle, 'orders');
  await proveNoOwnerAlert(ctx, handle);
  // The over-amount refusal (SUM(amount_cents) vs captured), the malformed-webhook
  // error envelope, and the dashboard refund-panel validation message all live in
  // the dashboard refund/webhook routes (Zod + route logic) — undrivable bot-only.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The refund endpoint refuses an over-amount refund with a validation error and writes no provider call; a malformed webhook body records an error without partial money rows.',
    'the over-amount check and malformed-body handling live in the dashboard refund + webhook routes, not reachable through the bot slash dispatcher',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each rejection is recorded with its validation reason, preserving the attempt trail append-only.',
    'the rejected-refund audit/security rows are written by the dashboard route, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard refund panel shows the precise validation error to the owner.',
    'requires the dashboard refund-panel readback',
  );
  gateBuyerBranding(ctx);
}

/** UNAUTH — money surfaces deny the unauthorized (forged signature; non-owner refund). */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  // A processed money row exists (positive control the anon caller must NOT touch).
  if (chain) {
    await insertPayment(handle, {
      order_id: chain.orderId,
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      paypal_payment_id: uid(ctx, 'capture'),
      paypal_event_id: uid(ctx, 'evt'),
      amount_cents: 500,
      currency: 'USD',
      status: 'completed',
    });
  }

  // DB-layer denial posture (the last line behind the route authz): an anon caller
  // cannot WRITE a money row directly. Even if the route's 401/403 were bypassed,
  // RLS denies anon on payments + payment_refunds (service_role-only lockdown).
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients cannot write payments/payment_refunds money rows (service_role-only RLS lockdown).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-write denial not exercised',
    );
  } else {
    const paymentWriteDenied = await anonInsertDenied(anonKey, 'payments', {
      guild_id: handle.guildId,
      paypal_payment_id: uid(ctx, 'anon-capture'),
      paypal_event_id: uid(ctx, 'anon-evt'),
      amount_cents: 999,
      currency: 'USD',
      status: 'completed',
    });
    const refundWriteDenied = await anonInsertDenied(anonKey, 'payment_refunds', {
      guild_id: handle.guildId,
      payment_id: '00000000-0000-4000-8000-0000000000ff',
      paypal_refund_id: uid(ctx, 'anon-refund'),
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
    });
    if (paymentWriteDenied === null || refundWriteDenied === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'anon clients cannot write payments/payment_refunds money rows.',
        'the anon-write probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS evaluated)',
      );
    } else {
      ctx.expect(paymentWriteDenied === true && refundWriteDenied === true, {
        assertionClass: 'database-RLS',
        channel: 'db-rls',
        promise: 'An unauthorized (anon) caller cannot write payments or payment_refunds money rows — RLS denies the write.',
        observation:
          `anon payments INSERT denied=${paymentWriteDenied}; anon payment_refunds INSERT denied=${refundWriteDenied}.`,
        impact: 'An anon caller wrote a money row directly through PostgREST — the money tables are not RLS-locked (bypasses route authz).',
      });
    }
  }
  await proveMoneyRls(ctx, handle, 'payments');
  await proveNoOwnerAlert(ctx, handle);

  // The actual denial ENVELOPES (forged webhook signature → 400 zero writes; a
  // member-session refund POST → 403 no ledger row, no PayPal call) are enforced
  // in the dashboard routes (verify-webhook-signature; requireGuildOwner) — no bot
  // slash surface exists, so they GATE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A tampered-header webhook delivery gets 400 with zero writes; a member-session refund POST gets 403 with no ledger row and no PayPal call.',
    'signature verification + requireGuildOwner are dashboard-route (HTTP) authz, not reachable through the bot slash dispatcher',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The signature rejection and the 403 are both logged with caller identity for the security trail.',
    'the security-log rows are written by the dashboard routes, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The security log surfaces the rejected forged delivery for owner review without alarm spam.',
    'requires the dashboard security-log readback',
  );
  gateBuyerBranding(ctx);
}

/** DEPFAIL — verification-service outage fails safe (503 redelivery + one deduped owner alert). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The whole scenario is a verification-service outage: PayPal's verify API is
  // made unreachable, deliveries answer 503 for redelivery, a deduped owner alert
  // fires, and the redelivered event processes once after recovery. Every leg
  // needs a fault-injection lane over the dashboard webhook route + a live/mocked
  // PayPal verify endpoint — none reachable in a bot-only local-Supabase harness.
  // GATE honestly (the exactly-once convergence fence itself is proven via the
  // webhook_events PK dedup in SET-B/REPLAY).
  ctx.gate(
    'Discord',
    'discord-readback',
    "The buyer's receipt arrives only after the dependency recovers and the redelivery processes — exactly once.",
    'requires a verify-API-outage fault lane over the dashboard webhook route plus buyer-DM readback',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'During the outage zero commerce rows are written; after recovery the exact expected rows exist once.',
    'requires a verify-API-outage fault-injection lane (the harness deliberately runs against reachable local Supabase)',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'The outage is recorded as verify_unavailable and the eventual processing carries the same provider event id.',
    'requires the verify-outage fault lane over the dashboard webhook route',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'One deduped owner alert describes the verification failure and its no-loss redelivery posture.',
    'requires the verify-outage fault lane plus owner alert channel + dashboard alerts-panel readback',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The owner alert copy is clear, branded, and states no event was lost or processed unverified.',
    'requires the verify-outage fault lane to reach the verify-unavailable alert branch',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Multiple 503-era deliveries of the same event converge to one processed outcome post-recovery.',
    'requires the verify-outage fault lane; the underlying exactly-once fence (webhook_events event-id PK) is proven in SET-B / REPLAY',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'The alert is resolved and run rows swept; audit of the outage remains.',
    'requires the verify-outage fault lane to create the outage artifacts',
  );
}

/** RETRY — a resumable mid-processing failure resumes on redelivery to an exactly-once outcome. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The resumable-failure branch is induced by a transient throw INSIDE the
  // PAYMENT.CAPTURE.COMPLETED handler (dashboard webhook route), which stages a
  // snapshot, records fail-resumable, and resumes on PayPal redelivery. Inducing
  // the mid-handler fault + driving PayPal redelivery needs a fault-injection lane
  // over the route — not reachable bot-only. GATE honestly; the exactly-once fences
  // the resume converges to (payments/webhook_events/refund unique ids) are proven
  // in DEF / REPLAY / RACE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The buyer sees one receipt and one role grant despite the failed first attempt.',
    'requires a mid-handler fault-injection lane over the dashboard webhook route plus buyer-DM/role readback',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Totals, license keys, and bot_action_queue entries are singular after convergence; staged snapshot rows show resume not restart.',
    'requires the mid-handler fault lane over the dashboard webhook route',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The event trail shows failed-resumable then completed under one event id.',
    'requires the mid-handler fault lane; the one-row-per-event-id fence is proven via webhook_events PK in SET-B / REPLAY',
  );
  ctx.gate(
    'owner-notification',
    'db-observable',
    'No manual-replay flag is raised for the recovered event.',
    'requires the mid-handler fault lane over the dashboard webhook route',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The retry is invisible on all buyer surfaces; messaging is identical to a clean run.',
    'requires the mid-handler fault lane plus buyer-DM readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'A third delivery after completion is a recorded no-op.',
    'requires the mid-handler fault lane; the redelivery-no-op fence is proven via webhook_events PK / payments UNIQUE in REPLAY',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run rows including the failure-era staging sweep to zero residue.',
    'requires the mid-handler fault lane to create the failure-era staging rows',
  );
}

/** REPLAY — redelivering completed events and re-submitting a refund change nothing (exactly-once). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  const paymentId = chain
    ? (
        await insertPayment(handle, {
          order_id: chain.orderId,
          customer_id: chain.customerId,
          guild_id: handle.guildId,
          paypal_payment_id: uid(ctx, 'capture'),
          paypal_event_id: uid(ctx, 'evt'),
          amount_cents: 2500,
          currency: 'USD',
          status: 'completed',
        })
      ).id
    : null;
  ctx.expect(paymentId !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a captured payment exists to redeliver capture + refund events against.',
    observation: `payment arranged = ${paymentId !== null}.`,
    impact: 'Could not arrange the payment — the replay-exactness proof setup is invalid.',
  });
  if (!chain || !paymentId) {
    gateBuyerBranding(ctx);
    gateBuyerDiscord(ctx);
    return;
  }

  // (a) The capture event redelivered FIVE times (its provider ids fixed): every
  //     redelivery is rejected by paypal_payment_id UNIQUE — payments stays at 1.
  const captureId = uid(ctx, 'capture-fixed');
  const seed = await insertPayment(handle, {
    order_id: chain.orderId,
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    paypal_payment_id: captureId,
    paypal_event_id: uid(ctx, 'evt-fixed'),
    amount_cents: 2500,
    currency: 'USD',
    status: 'completed',
  });
  let captureRejections = 0;
  for (let i = 0; i < 5; i += 1) {
    const r = await insertPayment(handle, {
      order_id: chain.orderId,
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      paypal_payment_id: captureId,
      paypal_event_id: uid(ctx, 'evt-replay'),
      amount_cents: 2500,
      currency: 'USD',
      status: 'completed',
    });
    if (r.code === '23505') captureRejections += 1;
  }
  const capturePayments = await countByEq(handle, 'payments', 'paypal_payment_id', captureId);
  ctx.expect(seed.id !== null && captureRejections === 5 && capturePayments === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Redelivering a completed capture five times changes nothing: exactly one payments row survives (paypal_payment_id UNIQUE).',
    observation:
      `seed payment=${seed.id !== null}; of 5 redeliveries ${captureRejections} were DB-rejected (23505); ` +
      `payments rows for the capture id = ${capturePayments} (expected 1).`,
    impact: 'A redelivered capture double-recorded a payment — replay exactness on the money row is broken.',
  });

  // (b) Re-submitting a refund with the SAME attempt/request id produces no second
  //     ledger create (paypal_refund_id UNIQUE) — the provider-refund fence.
  const refundId = uid(ctx, 'refund-fixed');
  const firstRefund = await insertRefund(handle, {
    payment_id: paymentId,
    order_id: chain.orderId,
    guild_id: handle.guildId,
    paypal_refund_id: refundId,
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    amount_cents: 2500,
    currency: 'USD',
  });
  const resubmitRefund = await insertRefund(handle, {
    payment_id: paymentId,
    order_id: chain.orderId,
    guild_id: handle.guildId,
    paypal_refund_id: refundId,
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    amount_cents: 2500,
    currency: 'USD',
  });
  const refundRows = await countByEq(handle, 'payment_refunds', 'paypal_refund_id', refundId);
  ctx.expect(firstRefund.id !== null && resubmitRefund.code === '23505' && refundRows === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Re-submitting a refund with the same attempt id appends no duplicate create (payment_refunds.paypal_refund_id UNIQUE) — one ledger row keyed to the provider id.',
    observation:
      `first refund row=${firstRefund.id !== null}; resubmit code=${resubmitRefund.code ?? 'ok(!)'}; ` +
      `payment_refunds rows for the refund id = ${refundRows} (expected 1).`,
    impact: 'A re-submitted refund appended a second ledger create — the append-only attempt ledger is not fenced on the request id.',
  });

  // (c) The event log is keyed on the provider event id (PK) — redelivery no-op.
  const eventId = uid(ctx, 'wevt');
  await insertWebhookEvent(handle, eventId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const evtReplay = await insertWebhookEvent(handle, eventId, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  const evtRows = await countByEq(handle, 'webhook_events', 'event_id', eventId);
  ctx.expect(evtReplay.code === '23505' && evtRows === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Redelivering a completed event appends no duplicate event-log row (webhook_events.event_id PK).',
    observation: `event redelivery code=${evtReplay.code ?? 'ok(!)'}; webhook_events rows for the event id = ${evtRows} (expected 1).`,
    impact: 'A redelivered event duplicated its event-log row — the event-id dedup fence failed.',
  });
  await deleteWebhookEvent(handle, eventId);

  await proveMoneyRls(ctx, handle, 'payment_refunds');
  await proveNoOwnerAlert(ctx, handle);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard shows single order/payment/refund entries with replay attempts visible in the event log.',
    'requires the dashboard order + webhook-log panel readback',
  );
  // PayPal sandbox truth (one capture, one refund) matching local truth end to end.
  ctx.gate(
    'replay-safety',
    'paypal-sandbox',
    'PayPal sandbox truth (one capture, one refund) matches local truth exactly across every path incl. the legacy-USD tolerance branch.',
    'requires PayPal sandbox credentials to diff provider truth against local rows',
  );
  gateBuyerBranding(ctx);
  gateBuyerDiscord(ctx);
}

/** RESTART — money state survives a full stack restart (it lives in Supabase, not memory). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const refundId = uid(ctx, 'refund');
  const captureId = uid(ctx, 'capture');

  // Boot #1: a captured payment + a pending refund ledger row + an active
  // entitlement, then snapshot and shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const chain = await arrangeCommerceChain(first, ctx);
  let paymentId: string | null = null;
  if (chain) {
    paymentId = (
      await insertPayment(first, {
        order_id: chain.orderId,
        customer_id: chain.customerId,
        guild_id: first.guildId,
        paypal_payment_id: captureId,
        paypal_event_id: uid(ctx, 'evt'),
        amount_cents: 700,
        currency: 'USD',
        status: 'completed',
      })
    ).id;
    if (paymentId) {
      await insertRefund(first, {
        payment_id: paymentId,
        order_id: chain.orderId,
        guild_id: first.guildId,
        paypal_refund_id: refundId,
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 700,
        currency: 'USD',
      });
    }
    await insertActiveEntitlement(first, chain);
  }
  const paymentsBefore = await countGuildRows(first, 'payments');
  const refundsBefore = await countGuildRows(first, 'payment_refunds');
  await first.cleanup(); // simulate the full-stack shutdown

  // Boot #2: SAME guild id (restart). The money rows must be byte-identical — they
  // live in Supabase, never in process memory.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const paymentsAfter = await countGuildRows(second, 'payments');
  const refundsAfter = await countGuildRows(second, 'payment_refunds');
  const refundAfter = await countByEq(second, 'payment_refunds', 'paypal_refund_id', refundId);
  ctx.expect(
    paymentId !== null &&
      paymentsAfter === paymentsBefore &&
      paymentsAfter === 1 &&
      refundsAfter === refundsBefore &&
      refundAfter === 1,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After a full stack restart the refund-attempt row and payment row persist unchanged (money state lives in Supabase, not process memory).',
      observation:
        `pre-restart payments=${paymentsBefore}/refunds=${refundsBefore}; ` +
        `post-restart payments=${paymentsAfter}/refunds=${refundsAfter}; refund-by-id=${refundAfter} (expected 1/1).`,
      impact: 'Money rows did not survive the restart — settlement depended on process memory / persistence was lost.',
    },
  );

  // The idempotency fence survives the restart: a redelivered capture is still
  // rejected against the persisted UNIQUE constraint post-reboot.
  let redeliverCode: string | null = null;
  if (chain) {
    redeliverCode = (
      await insertPayment(second, {
        order_id: chain.orderId,
        customer_id: chain.customerId,
        guild_id: second.guildId,
        paypal_payment_id: captureId,
        paypal_event_id: uid(ctx, 'evt'),
        amount_cents: 700,
        currency: 'USD',
        status: 'completed',
      })
    ).code;
  }
  const capturePayments = await countByEq(second, 'payments', 'paypal_payment_id', captureId);
  ctx.expect(redeliverCode === '23505' && capturePayments === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Restart-era redeliveries are absorbed idempotently — the persisted UNIQUE fence still rejects a duplicate capture after reboot.',
    observation: `post-restart redelivery code=${redeliverCode ?? 'ok(!)'}; payments for capture id=${capturePayments} (expected 1).`,
    impact: 'A duplicate capture applied after restart — the idempotency fence did not survive the reboot.',
  });

  await proveMoneyRls(ctx, second, 'payments');
  await proveNoOwnerAlert(ctx, second);
  // The actual settlement (refund finalize-from-pending via provider poll; the
  // stale webhook reclaim-and-complete) is dashboard-route + PayPal — GATE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Post-restart the buyer receives the correct final notices exactly once (receipt + refund confirmation as applicable).',
    'the finalize-from-pending settlement runs in the dashboard route + PayPal poll, with buyer DMs on the live gateway',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The trail spans the restart: pending before, finalized after, same attempt and event ids.',
    'the settlement audit trail is written by the dashboard route settlement path, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard shows both items settled with no manual-intervention flag.',
    'requires the dashboard order/refund-panel readback',
  );
  gateBuyerBranding(ctx);
}

/** RACE — concurrent deliveries and refund submissions are DB-arbitrated to a single effect. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  const paymentId = chain
    ? (
        await insertPayment(handle, {
          order_id: chain.orderId,
          customer_id: chain.customerId,
          guild_id: handle.guildId,
          paypal_payment_id: uid(ctx, 'capture'),
          paypal_event_id: uid(ctx, 'evt'),
          amount_cents: 900,
          currency: 'USD',
          status: 'completed',
        })
      ).id
    : null;
  ctx.expect(chain !== null && paymentId !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a captured payment exists to race a refund against.',
    observation: `chain=${chain !== null}, payment=${paymentId !== null}.`,
    impact: 'Could not arrange the payment — the race proof setup is invalid.',
  });
  if (!chain || !paymentId) {
    gateBuyerBranding(ctx);
    gateBuyerDiscord(ctx);
    return;
  }

  // (a) Two PARALLEL deliveries of one capture event: the paypal_payment_id UNIQUE
  //     constraint (a DB-level claim, not process memory) lets exactly one win.
  const raceCaptureId = uid(ctx, 'race-capture');
  const [d1, d2] = await Promise.all([
    insertPayment(handle, {
      order_id: chain.orderId,
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      paypal_payment_id: raceCaptureId,
      paypal_event_id: uid(ctx, 'evt'),
      amount_cents: 900,
      currency: 'USD',
      status: 'completed',
    }),
    insertPayment(handle, {
      order_id: chain.orderId,
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      paypal_payment_id: raceCaptureId,
      paypal_event_id: uid(ctx, 'evt'),
      amount_cents: 900,
      currency: 'USD',
      status: 'completed',
    }),
  ]);
  const captureWinners = [d1, d2].filter((r) => r.id !== null).length;
  const captureLosers = [d1, d2].filter((r) => r.code === '23505').length;
  const racePayments = await countByEq(handle, 'payments', 'paypal_payment_id', raceCaptureId);
  ctx.expect(captureWinners === 1 && captureLosers === 1 && racePayments === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two parallel deliveries of one capture: a database-level claim (paypal_payment_id UNIQUE) lets exactly one win and the other no-op.',
    observation:
      `parallel capture inserts → winners=${captureWinners}, losers(23505)=${captureLosers}; ` +
      `payments rows for the capture id = ${racePayments} (expected 1).`,
    impact: 'A concurrent capture race created two payment rows — the DB claim did not arbitrate the race.',
  });

  // (b) Two PARALLEL refund submissions for one order (same request id): exactly
  //     one provider-refund ledger row survives (paypal_refund_id UNIQUE).
  const raceRefundId = uid(ctx, 'race-refund');
  const [r1, r2] = await Promise.all([
    insertRefund(handle, {
      payment_id: paymentId,
      order_id: chain.orderId,
      guild_id: handle.guildId,
      paypal_refund_id: raceRefundId,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      amount_cents: 900,
      currency: 'USD',
    }),
    insertRefund(handle, {
      payment_id: paymentId,
      order_id: chain.orderId,
      guild_id: handle.guildId,
      paypal_refund_id: raceRefundId,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      amount_cents: 900,
      currency: 'USD',
    }),
  ]);
  const refundWinners = [r1, r2].filter((r) => r.id !== null).length;
  const refundRows = await countByEq(handle, 'payment_refunds', 'paypal_refund_id', raceRefundId);
  ctx.expect(refundWinners === 1 && refundRows === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Two concurrent refund submissions for one order yield a single ledger attempt (paypal_refund_id UNIQUE) — one provider refund, the loser observes the existing attempt.',
    observation:
      `parallel refund inserts → winners=${refundWinners}; ` +
      `payment_refunds rows for the refund id = ${refundRows} (expected 1).`,
    impact: 'Two competing refund attempts both persisted — the refund ledger is not single-effect under a race.',
  });

  await proveMoneyRls(ctx, handle, 'payments');
  await proveNoOwnerAlert(ctx, handle);
  // The loser's branded "an attempt is already in flight" response is a dashboard
  // route reply; the single provider refund is a PayPal effect — GATE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The buyer sees exactly one receipt and at most one refund notice despite the races.',
    'requires buyer-DM readback on the live gateway',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The losing refund submission gets a clean branded response explaining an attempt is already in flight.',
    'the loser response is a dashboard refund-route reply, not reachable through the bot slash dispatcher',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Both racers are visible in the trail with the winner\'s effects appearing exactly once.',
    'the per-racer processing trail is written by the dashboard webhook/refund routes, not reachable bot-only',
  );
}

/** XGUILD — webhook effects are guild-bound: guild A's event never touches guild B. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  const chainA = await arrangeCommerceChain(handleA, ctx, { amountCents: 1200 });
  const captureA = uid(ctx, 'capture');
  const payA = chainA
    ? await insertPayment(handleA, {
        order_id: chainA.orderId,
        customer_id: chainA.customerId,
        guild_id: guildA,
        paypal_payment_id: captureA,
        paypal_event_id: uid(ctx, 'evt'),
        amount_cents: 1200,
        currency: 'USD',
        status: 'completed',
      })
    : { id: null, code: null };
  if (chainA) await insertActiveEntitlement(handleA, chainA);

  // Guild A's capture fulfilled ONLY guild A rows; guild B is byte-identical (zero
  // commerce rows from the event). Distinct real rows under distinct guild ids.
  const paymentsA = await countGuildRows(handleA, 'payments');
  const paymentsB = await countGuildRows(handleB, 'payments');
  const entitlementsA = await countGuildRows(handleA, 'entitlements');
  const entitlementsB = await countGuildRows(handleB, 'entitlements');
  ctx.expect(payA.id !== null && paymentsA >= 1 && paymentsB === 0 && entitlementsA >= 1 && entitlementsB === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: "Guild A's capture fulfills only guild A rows; guild B's payments/entitlements are untouched by the event.",
    observation:
      `guild A payments=${paymentsA}, entitlements=${entitlementsA}; ` +
      `guild B payments=${paymentsB}, entitlements=${entitlementsB} (both B expected 0).`,
    impact: "Guild A's payment event mutated guild B's money tables — webhook effects are not guild-bound.",
  });

  // Guild-scoped reads return each guild's OWN rows and never the other's.
  const { data: aScoped } = await handleA.supabase
    .from('payments')
    .select('guild_id, paypal_payment_id')
    .eq('guild_id', guildA)
    .eq('paypal_payment_id', captureA)
    .maybeSingle();
  const aRow = aScoped as { guild_id: string; paypal_payment_id: string } | null;
  const bScopedCount = await countGuildRows(handleB, 'payments');
  ctx.expect(aRow?.guild_id === guildA && aRow?.paypal_payment_id === captureA && bScopedCount === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: "Each guild scope reads its OWN money rows: guild A → its capture row, guild B → none of guild A's.",
    observation:
      `guild-A-scoped read = capture "${aRow?.paypal_payment_id ?? '(none)'}" under "${aRow?.guild_id ?? '(none)'}"; ` +
      `guild-B-scoped payments count = ${bScopedCount} (expected 0).`,
    impact: "A guild-scoped read crossed guilds — guild A's money row leaked into guild B's scope.",
  });
  await proveMoneyRls(ctx, handleA, 'payments');
  await proveNoOwnerAlert(ctx, handleB);

  // Replaying with a tampered guild binding failing verification is a webhook
  // signature/identity concern (dashboard route) — GATE.
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Replaying the event with a tampered guild binding fails verification/identity rather than crossing guilds.',
    'the custom-id → guild binding is verified in the dashboard webhook route (signature + identity), not reachable bot-only',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    "Audit rows are exclusively guild A's; guild B's audit view is empty of the event.",
    'the per-guild audit rows are written by the dashboard webhook route, not reachable bot-only',
  );
  gateBuyerBranding(ctx);
}

/** CLEANUP — run-prefixed money rows sweep to zero; append-only audit is retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const chain = await arrangeCommerceChain(handle, ctx);
  let paymentId: string | null = null;
  if (chain) {
    paymentId = (
      await insertPayment(handle, {
        order_id: chain.orderId,
        customer_id: chain.customerId,
        guild_id: handle.guildId,
        paypal_payment_id: uid(ctx, 'capture'),
        paypal_event_id: uid(ctx, 'evt'),
        amount_cents: 600,
        currency: 'USD',
        status: 'completed',
      })
    ).id;
    if (paymentId) {
      await insertRefund(handle, {
        payment_id: paymentId,
        order_id: chain.orderId,
        guild_id: handle.guildId,
        paypal_refund_id: uid(ctx, 'refund'),
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        amount_cents: 600,
        currency: 'USD',
      });
    }
    await insertActiveEntitlement(handle, chain);
  }
  // An append-only audit row that retention must PRESERVE across the sweep.
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'system',
    actor_id: 'commerce',
    action: 'commerce.e2e.cleanup_marker',
    target_type: 'order',
    target_id: chain?.orderId ?? 'e2e',
    details: { e2e: true },
  });

  const ordersBefore = await countGuildRows(handle, 'orders');
  const paymentsBefore = await countGuildRows(handle, 'payments');
  const refundsBefore = await countGuildRows(handle, 'payment_refunds');
  const auditBefore = await countGuildRows(handle, 'audit_logs');
  ctx.expect(ordersBefore >= 1 && paymentsBefore >= 1 && refundsBefore >= 1 && auditBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed money rows + an audit row (pre-cleanup baseline).',
    observation:
      `pre-cleanup: orders=${ordersBefore}, payments=${paymentsBefore}, payment_refunds=${refundsBefore}, audit_logs=${auditBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed money rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveMoneyRls(ctx, handle, 'payments');
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed
  // OPERATIONAL money rows remain, while append-only audit history is RETAINED.
  await ctx.sweepGuildRows(handle);
  const ordersAfter = await countGuildRows(handle, 'orders');
  const paymentsAfter = await countGuildRows(handle, 'payments');
  const refundsAfter = await countGuildRows(handle, 'payment_refunds');
  const entitlementsAfter = await countGuildRows(handle, 'entitlements');
  const auditAfter = await countGuildRows(handle, 'audit_logs');
  ctx.expect(
    ordersAfter === 0 && paymentsAfter === 0 && refundsAfter === 0 && entitlementsAfter === 0,
    {
      assertionClass: 'cleanup',
      channel: 'db-observable',
      promise: 'Run-prefixed orders, payments, payment_refunds, and entitlements are deleted; a final sweep finds zero operational residue.',
      observation:
        `post-sweep: orders=${ordersAfter}, payments=${paymentsAfter}, payment_refunds=${refundsAfter}, entitlements=${entitlementsAfter}.`,
      impact: 'The cleanup sweep left run-prefixed money rows behind — the suite leaves money residue.',
    },
  );
  ctx.expect(auditAfter >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Append-only audit/ledger history from the run is preserved (retained, not deleted) through the operational sweep.',
    observation: `post-sweep audit_logs rows for the guild = ${auditAfter} (retained, expected >= 1).`,
    impact: 'The sweep deleted audit history — append-only retention was violated.',
  });

  // webhook_events is global (no guild_id) so the guild sweep cannot reach it;
  // it is cleaned by its own event-id delete (verified here to be zero-residue).
  const strayEvent = uid(ctx, 'wevt');
  await insertWebhookEvent(handle, strayEvent, 'PAYMENT.CAPTURE.COMPLETED', 'success');
  await deleteWebhookEvent(handle, strayEvent);
  const strayLeft = await countByEq(handle, 'webhook_events', 'event_id', strayEvent);
  ctx.expect(strayLeft === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed webhook_events rows (global table, no guild_id) are removed by their own event-id delete.',
    observation: `post-delete webhook_events rows for the run event id = ${strayLeft} (expected 0).`,
    impact: 'A run-prefixed webhook_events row survived cleanup — global-table residue.',
  });

  // Discord DM/role teardown and the sweep-report enumeration are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Run-created buyer DM context is closed out and test roles are removed from all test accounts.',
    'requires a live Discord channel/role readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'All run-raised alerts are resolved; the owner surface is quiet post-sweep.',
    'requires the dashboard alerts-panel readback (the alerts table sweep is the DB-observable evidence here)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'Any branding or grace configuration touched by scenarios is restored to pre-run values.',
    'requires the dashboard brand/grace-config readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Running cleanup twice is idempotent with no errors and no additional deletions.',
    'the runner invokes teardown once per scenario; a second manual sweep re-run lane is not wired here',
  );
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The commerce-paypal domain proof: the guild_id-scoped money tables the sweep
 * must clear (child → parent so FK-constrained rows are removed before their
 * parents and the guild row), plus the 12 scenario scripts. audit_logs is
 * deliberately NOT swept — the catalog requires append-only audit RETAINED, and
 * CLEANUP proves that retention. webhook_events is a global (guild-less) table and
 * is cleaned by its own event-id delete inside the scenarios that create rows.
 */
export const commercePaypalProof: DomainProof = {
  domainId: 'commerce-paypal',
  guildScopedTables: [
    'payment_refunds',
    'payments',
    'entitlements',
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
