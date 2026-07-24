/**
 * scenario-runner/scripts/commerce-product-store — the Product store domain proof.
 *
 * Binds the commerce-product-store domain's 12 declarative catalog scenarios to
 * concrete, real-stack proof scripts driven through the REAL production dispatcher
 * against LOCAL Supabase. This is a MOSTLY-GATED domain by construction: the whole
 * value chain (buy button → PayPal order/subscription → capture webhook →
 * fulfillment → receipt DM → celebration channel → gift DM) needs a Discord button
 * interaction lane, PayPal sandbox credentials, and a live Discord gateway — none
 * of which the bot-only local-Supabase harness has. Those are GATED honestly.
 *
 * What DOES run NOW against real state:
 *   - `/store` (the domain's only slash command) is driven through the real
 *     dispatcher: the storefront render, the active-only filter, the store-empty
 *     branch, and cross-guild isolation are asserted against the REAL captured
 *     reply (embed titles + buy-button custom ids) and REAL product rows.
 *   - database-RLS: anon clients read ZERO products/orders/entitlements for a guild
 *     the service role can see (owner-only RLS), and anon WRITES are refused.
 *   - replay-safety / RACE: the DB-level idempotency FENCES that back the catalog's
 *     "exactly once" promises are exercised directly — the unique index on
 *     entitlements(order_id) (one entitlement per order), payments.paypal_event_id
 *     (one payment per webhook event), and customers(discord_id, guild_id) (one
 *     customer per buyer) each reject the duplicate the replay/race would produce.
 *   - INVALID: the products.type CHECK constraint rejects an unknown product type
 *     at the database, and /store keeps serving the last valid catalog.
 *   - the two-economies wall: store activity writes commerce rows but ZERO
 *     game-economy wallet/ledger rows for the guild.
 *
 * Behavior-bug discovery: the real `/store` embed carries neither the owner
 * guild-profile brand name nor the contracted powered-by-SomniBot attribution — it
 * renders a hardcoded "Server Store" title with no footer. The catalog's branding
 * promise is asserted against that REAL captured embed and therefore FAILs (a
 * finding for the owner), never softened into a pass or a gate.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ───────────────────────────────

interface ProductRow {
  id: string;
  name: string;
  active: boolean;
  type: string;
  price_cents: number;
  guild_id: string;
}

interface OrderRow {
  id: string;
  status: string;
  guild_id: string;
  order_number: string;
}

// ── Catalog-default access ─────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

// ── /store reply extraction (deferReply → editReply) ───────────────────────

/** The payload of the LAST editReply (the /store render), falling back to reply. */
function lastReplyPayload(captured: CapturedResponse): Record<string, unknown> | undefined {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return (edits[edits.length - 1]!.payload as Record<string, unknown> | undefined) ?? undefined;
  }
  const reply = captured.find('reply');
  return (reply?.payload as Record<string, unknown> | undefined) ?? undefined;
}

/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

function replyText(captured: CapturedResponse): string {
  return payloadText(lastReplyPayload(captured));
}

interface EmbedData {
  title?: string;
  description?: string;
  fields?: Array<{ name?: string; value?: string }>;
  footer?: { text?: string };
}

/** Every rendered embed's `.data` (discord.js EmbedBuilder) in the /store reply. */
function replyEmbeds(captured: CapturedResponse): EmbedData[] {
  const payload = lastReplyPayload(captured);
  const embeds = (payload?.embeds as Array<{ data?: EmbedData }> | undefined) ?? [];
  return embeds.map((e) => e?.data).filter((d): d is EmbedData => Boolean(d));
}

/** Every button custom id across the /store action rows. */
function replyButtonIds(captured: CapturedResponse): string[] {
  const payload = lastReplyPayload(captured);
  const rows = (payload?.components as Array<{ components?: Array<{ data?: { custom_id?: string } }> }> | undefined) ?? [];
  const ids: string[] = [];
  for (const row of rows) {
    for (const comp of row.components ?? []) {
      const id = comp?.data?.custom_id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/** Every member-facing text surface of the /store reply (for branding checks). */
function storeSurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const content = replyText(captured);
  if (content) parts.push(content);
  for (const embed of replyEmbeds(captured)) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
    for (const f of embed.fields ?? []) {
      if (typeof f.name === 'string') parts.push(f.name);
      if (typeof f.value === 'string') parts.push(f.value);
    }
    const footer = embed.footer?.text;
    if (typeof footer === 'string') parts.push(footer);
  }
  return parts.join('\n');
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Local-stack DB helpers ─────────────────────────────────────────────────

async function insertProduct(
  handle: LiveClientHandle,
  opts: {
    name: string;
    active?: boolean;
    type?: string;
    deliveryType?: string;
    priceCents?: number;
    sortOrder?: number;
  },
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('products')
    .insert({
      guild_id: handle.guildId,
      name: opts.name,
      type: opts.type ?? 'one_time',
      delivery_type: opts.deliveryType ?? 'access_pass',
      price_cents: opts.priceCents ?? 500,
      currency: 'USD',
      active: opts.active ?? true,
      sort_order: opts.sortOrder ?? 0,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function readProduct(handle: LiveClientHandle, productId: string): Promise<ProductRow | null> {
  const { data } = await handle.supabase
    .from('products')
    .select('id, name, active, type, price_cents, guild_id')
    .eq('id', productId)
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as ProductRow | null) ?? null;
}

async function countRows(handle: LiveClientHandle, table: string): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Create the full active-purchase commerce chain (customer → product → completed
 *  order → active entitlement) the two-economies wall + RLS proofs use as a
 *  positive control. The entitlements composite FK requires a COMPLETED order with
 *  the exact (id, guild_id, customer_id, product_id) identity, so a bare
 *  entitlement can never persist — this arranges the exact production data model. */
async function arrangePurchaseChain(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  discordId: string,
  label: string,
): Promise<{
  customerId: string | null;
  productId: string | null;
  orderId: string | null;
  entitlementError: string | null;
}> {
  const { data: cust } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: discordId, discord_username: `${ctx.runPrefix}${label}` })
    .select('id')
    .single();
  const customerId = (cust as { id: string } | null)?.id ?? null;

  const productId = await insertProduct(handle, { name: `${ctx.runPrefix}${label}-product`, priceCents: 500 });

  const { data: order } = await handle.supabase
    .from('orders')
    .insert({
      order_number: `${ctx.runPrefix}${label}-ord`,
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: productId,
      amount_cents: 500,
      status: 'completed',
      source: 'purchase',
    })
    .select('id')
    .single();
  const orderId = (order as { id: string } | null)?.id ?? null;

  const { error: entErr } = await handle.supabase.from('entitlements').insert({
    customer_id: customerId,
    guild_id: handle.guildId,
    product_id: productId,
    order_id: orderId,
    type: 'one_time',
    status: 'active',
    source: 'purchase',
  });
  return { customerId, productId, orderId, entitlementError: entErr ? entErr.message : null };
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
 * Anon-denial RLS READ probe via the PostgREST REST endpoint (copied from the
 * wallet-rewards proof). Returns the number of rows an anon key can read
 * (owner-only RLS → 0), or null when inconclusive (→ GATE).
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

/**
 * Anon WRITE probe: an anon key POSTing a row must be refused (owner-only RLS /
 * missing GRANT). Returns true when the write was denied (non-2xx), false when it
 * unexpectedly succeeded, or null when inconclusive (no anon key / URL / network).
 */
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
    // 2xx means the anon role actually inserted a row — RLS/GRANT failed open.
    return !res.ok;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ──────────────────────────────────────────────

/**
 * database-RLS: the service role reads this guild's product row while an anon
 * client reads ZERO products (owner_full_access is the ONLY policy — anon has no
 * auth.uid()). Made non-vacuous by the positive control: the product genuinely
 * exists under the guild.
 */
async function proveProductsRls(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  productId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero products rows (owner_full_access is the only policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'products', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero products rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readProduct(handle, productId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s product row while an anon client reads zero of them (owner-only RLS on products).',
    observation:
      `service-role sees the product under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} products row(s) for that guild.`,
    impact:
      'A product row visible to the service role was also readable with an anon key — store catalog RLS is not denying anon reads (direct data exposure).',
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's healthy path raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'A healthy store interaction raises no owner alert or DM.',
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a healthy store path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Sustained contracted failures (PayPal down, dependency failure) raise a single deduped owner alert with a remediation hint.',
    'requires a fault-injection lane plus the live owner alert/DM channel readback (DISCORD_TOKEN + live guild)',
  );
}

/**
 * The two-economies wall: store activity writes commerce rows but touches ZERO
 * game-economy wallet/ledger rows for the guild. Positive control = real commerce
 * rows (products/orders) exist; the wall = economy_wallets + economy_transactions
 * are both empty for that guild.
 */
async function proveTwoEconomiesWall(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const products = await countRows(handle, 'products');
  const orders = await countRows(handle, 'orders');
  const wallets = await countRows(handle, 'economy_wallets');
  const txns = await countRows(handle, 'economy_transactions');
  if (wallets === null || txns === null || products === null || orders === null) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'Store activity touches no game-economy currency or inventory row (two-economies wall).',
      'a commerce/economy count read errored, so the wall cannot be proven this pass (never recorded as a false-clean pass)',
    );
    return;
  }
  const commercePresent = products + orders > 0;
  ctx.expect(commercePresent && wallets === 0 && txns === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Store activity writes commerce rows but never a game-economy currency/ledger row — the two economies stay walled off.',
    observation:
      `commerce rows for the guild = ${products} product(s) + ${orders} order(s); ` +
      `game-economy rows = ${wallets} wallet(s), ${txns} ledger row(s) (both must be 0).`,
    impact:
      'The real-money store created or mutated a play-money game-economy row — the two-economies wall was breached.',
  });
}

/**
 * branding — asserted against the REAL /store embed. The catalog contracts that
 * storefront embeds carry the owner guild-profile brand name AND a subtle
 * powered-by-SomniBot attribution with no hardcoded vendor branding. The real
 * `/store` renders a hardcoded "🏪 Server Store" title, no footer, and no
 * attribution, so this FAILs — a finding, never softened.
 */
function proveStorefrontBranding(ctx: ScenarioContext, captured: CapturedResponse): void {
  const surface = storeSurface(captured);
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      'The storefront embed carries the owner brand and powered-by-SomniBot attribution.',
      'this scenario produced no member-facing storefront embed to inspect',
    );
  } else {
    const lower = surface.toLowerCase();
    const hasPoweredBy = lower.includes('powered by') || lower.includes('somnibot');
    ctx.expect(hasPoweredBy, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise:
        'Every buyer-facing storefront surface carries the subtle powered-by-SomniBot attribution (and the owner guild-profile brand, not hardcoded vendor branding).',
      observation:
        `the /store reply surface "${truncate(surface)}" carries no powered-by-SomniBot attribution ` +
        `and uses the hardcoded "Server Store" title rather than the owner guild-profile brand name.`,
      impact:
        'The storefront ships without the contracted white-label powered-by attribution and owner brand — a branding regression on the headline buyer surface.',
    });
  }
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, PayPal checkout brand_name = owner store name) matches the owner brand kit across storefront, checkout, and receipts.',
    'requires embed/PayPal-object snapshot readback against the live brand kit (DISCORD_TOKEN + live guild + PayPal sandbox)',
  );
}

/** The storefront-branding finding is surfaced once in DEF; defer here to avoid
 *  re-reporting the identical embed gap per scenario. */
function gateBrandingDeferredToDef(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'The storefront embed carries the owner brand and powered-by-SomniBot attribution.',
    'the storefront-embed branding assertion is exercised directly in DEF (same render path); deferred here to avoid duplicate findings',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate order, charge, entitlement, or grant.',
    `replay/idempotency fences are exercised directly in the ${where} scenario`,
  );
}

/** The full buyer surface (embeds, checkout links, receipts, DMs, celebrations)
 *  needs a live Discord gateway; the checkout/fulfillment itself needs PayPal. */
function gateCheckoutFulfillment(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'Clicking Buy returns a checkout-invite with a working PayPal link and, after capture, the buyer receives a receipt DM and granted roles; celebrations/gift DMs post as contracted.',
    'requires a Discord button-interaction lane + PayPal sandbox (PAYPAL_CLIENT_ID/SECRET) + a live gateway (DISCORD_TOKEN) — none present in the bot-only local-Supabase harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The checkout and entitlement.granted audit rows are written with actor, target, and product ids for the fulfilled order.',
    'requires the PayPal capture/fulfillment path to run (button + PayPal sandbox + webhook) to produce the audit trail',
  );
}

// ── The 12 scenario scripts ────────────────────────────────────────────────

/** DEF — out of the box, /store lists every ACTIVE product with buy buttons. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const storeEnabledDefault = declaredDefault(ctx.domain, 'store-enabled');
  const handle = await ctx.bootGuild({ label: 'a' });

  // Arrange one active product (buyable) and one INACTIVE product (must not show).
  const activeName = `${ctx.runPrefix}active-pass`;
  const inactiveName = `${ctx.runPrefix}inactive-pass`;
  const activeId = await insertProduct(handle, { name: activeName, priceCents: 500, sortOrder: 0 });
  const inactiveId = await insertProduct(handle, { name: inactiveName, priceCents: 700, active: false, sortOrder: 1 });

  ctx.expect(Boolean(activeId && inactiveId), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Test arrangement: an active and an inactive product exist (store-enabled default is ${JSON.stringify(storeEnabledDefault)}).`,
    observation: `active product id=${activeId ?? '(null)'}, inactive product id=${inactiveId ?? '(null)'}.`,
    impact: 'Could not arrange the storefront baseline products — the DEF proof setup is invalid.',
  });

  // Drive the REAL /store through the dispatcher.
  const captured = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a'), displayName: 'DEF Buyer' });

  const embedTitles = replyEmbeds(captured).map((e) => e.title ?? '');
  const buttonIds = replyButtonIds(captured);
  const surface = storeSurface(captured);

  // 1) The active product renders with its real name + a buy button bound to its id.
  ctx.expect(
    embedTitles.includes(activeName) && buttonIds.includes(`store:buy:${activeId}`) && surface.includes('$5.00'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: '/store lists the active product with its name, $5.00 price, and a Buy button whose custom id binds the product.',
      observation:
        `embed titles=${JSON.stringify(embedTitles)}; buy buttons=${JSON.stringify(buttonIds)}; ` +
        `expected title "${activeName}" and button "store:buy:${activeId}".`,
      impact: 'The storefront did not render the active product with a correctly-bound Buy button.',
    },
  );

  // 2) The inactive product is EXCLUDED (server-side active filter).
  ctx.expect(!embedTitles.includes(inactiveName) && !buttonIds.includes(`store:buy:${inactiveId}`), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'An inactive product never appears in /store (only active products are buyable).',
    observation:
      `inactive title present=${embedTitles.includes(inactiveName)}, ` +
      `inactive buy button present=${buttonIds.includes(`store:buy:${inactiveId}`)} (both expected false).`,
    impact: 'An inactive/deactivated product leaked into the storefront — a member could attempt to buy an unavailable product.',
  });

  await proveProductsRls(ctx, handle, activeId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  proveStorefrontBranding(ctx, captured);
  gateCheckoutFulfillment(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard config (stackable repeat policy + public celebration). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const discordId = ctx.userId('a');

  // Arrange TWO completed orders + two stacked entitlements for one buyer/product
  // (the shape a stackable second purchase produces). Used ONLY as a positive
  // control for RLS / the two-economies wall — the stacking BEHAVIOR itself is
  // driven by the dashboard config + capture webhook and is GATED below.
  const first = await arrangePurchaseChain(ctx, handle, discordId, 'seta1');
  let secondEntitlementError: string | null = null;
  if (first.customerId && first.productId) {
    const { data: order2 } = await handle.supabase
      .from('orders')
      .insert({
        order_number: `${ctx.runPrefix}seta2-ord`,
        customer_id: first.customerId,
        guild_id: handle.guildId,
        product_id: first.productId,
        amount_cents: 500,
        status: 'completed',
        source: 'purchase',
      })
      .select('id')
      .single();
    const order2Id = (order2 as { id: string } | null)?.id ?? null;
    const { error: ent2Err } = await handle.supabase.from('entitlements').insert({
      customer_id: first.customerId,
      guild_id: handle.guildId,
      product_id: first.productId,
      order_id: order2Id,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
    });
    secondEntitlementError = ent2Err ? ent2Err.message : null;
  }
  const { count: entCount } = await handle.supabase
    .from('entitlements')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('customer_id', first.customerId ?? '')
    .eq('product_id', first.productId ?? '');
  ctx.expect(first.entitlementError === null && secondEntitlementError === null && (entCount ?? 0) === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: two distinct completed orders each carry their own stacked entitlement for the buyer-product pair.',
    observation:
      `entitlement rows for buyer/product=${entCount ?? 0} (expected 2); ` +
      `errors: first=${first.entitlementError ?? 'none'}, second=${secondEntitlementError ?? 'none'}.`,
    impact: 'Could not arrange the stacked-entitlement positive control — the SET-A RLS/wall proof setup is invalid.',
  });

  await proveProductsRls(ctx, handle, first.productId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The stackable-policy behavior, the celebration channel post, the config-change
  // audit, and its branding all live on the dashboard config + capture-webhook +
  // Discord channel lanes — none reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With repeat-purchase-policy=stackable + public celebration enabled, a second purchase succeeds and posts a celebration naming only buyer + product (no order number/amount/payment detail).',
    'requires the dashboard store-config lane + PayPal capture webhook + a live celebration channel readback',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The policy/celebration config change and both entitlement grants each have distinct audit rows tying them to the dashboard actor.',
    'the config-change and grant audit rows are written by the dashboard save + capture-webhook paths (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'Celebration messages speak in the owner’s configured playful voice/brand with the subtle powered-by attribution.',
    'requires a live celebration channel message readback (DISCORD_TOKEN + live guild)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — free product ($0) one-claim + gift through the same fulfillment path. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // A free product is a $0 product; the storefront still lists it. Render it live.
  const freeName = `${ctx.runPrefix}free-badge`;
  const freeId = await insertProduct(handle, { name: freeName, priceCents: 0, deliveryType: 'access_pass' });
  const captured = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a'), displayName: 'SET-B Claimer' });
  const titles = replyEmbeds(captured).map((e) => e.title ?? '');
  ctx.expect(titles.includes(freeName) && replyButtonIds(captured).includes(`store:buy:${freeId}`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A free ($0) product renders in /store like any active product.',
    observation: `embed titles=${JSON.stringify(titles)}; expected the free product "${freeName}" with its buy button.`,
    impact: 'A free product did not render in the storefront.',
  });

  // Arrange a completed $0 order + claim entitlement (the shape a completed free
  // claim produces) as the positive control for RLS / the two-economies wall.
  const { data: cust } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: ctx.userId('a'), discord_username: `${ctx.runPrefix}claimer` })
    .select('id')
    .single();
  const customerId = (cust as { id: string } | null)?.id ?? null;
  const { data: order } = await handle.supabase
    .from('orders')
    .insert({
      order_number: `${ctx.runPrefix}setb-claim`,
      customer_id: customerId,
      guild_id: handle.guildId,
      product_id: freeId,
      amount_cents: 0,
      status: 'completed',
      source: 'purchase',
    })
    .select('id, status, amount_cents')
    .single();
  const claimOrder = order as { id: string; status: string; amount_cents: number } | null;
  ctx.expect(claimOrder?.status === 'completed' && claimOrder?.amount_cents === 0, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A free claim is recorded as a completed, auditable $0 order.',
    observation: `claim order status=${claimOrder?.status} (expected completed), amount_cents=${claimOrder?.amount_cents} (expected 0).`,
    impact: 'The free claim did not persist as a completed $0 order — the $0 order audit trail is missing.',
  });

  await proveProductsRls(ctx, handle, freeId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  // The one-claim enforcement, the re-claim refusal, and the gift fulfillment to a
  // recipient (with gift DM) run through the claim handler + capture webhook +
  // recipient DM lanes, none reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The claim returns a free-claim-receipt, a second claim is refused ephemerally, and a gift purchase lands a gift-received DM on the recipient’s account.',
    'requires the free-claim handler + gift fulfillment + recipient DM lanes (Discord interaction/DM readback)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** INVALID — an unknown product type is rejected atomically; catalog unchanged. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Baseline valid product renders the storefront.
  const validName = `${ctx.runPrefix}valid-pass`;
  const validId = await insertProduct(handle, { name: validName, priceCents: 500 });
  const before = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
  const beforeTitles = replyEmbeds(before).map((e) => e.title ?? '');

  const { count: countBefore } = await handle.supabase
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);

  // Attempt an UNKNOWN product type — the products.type CHECK constraint
  // (type IN ('one_time','subscription')) rejects it at the database. This is the
  // atomic-rejection guarantee that a malformed product never persists.
  const { error: badTypeErr } = await handle.supabase.from('products').insert({
    guild_id: handle.guildId,
    name: `${ctx.runPrefix}phantom`,
    type: 'game_currency', // not a valid product type
    delivery_type: 'access_pass',
    price_cents: 100,
    currency: 'USD',
    active: true,
  });

  const { count: countAfter } = await handle.supabase
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);

  ctx.expect(badTypeErr !== null && (countBefore ?? 0) === (countAfter ?? -1), {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A product with an unknown/unsupported type is rejected atomically (DB CHECK) and never persists.',
    observation:
      `unknown-type insert rejected=${badTypeErr !== null} (error: ${badTypeErr?.message ?? 'NONE — it persisted!'}); ` +
      `products count ${countBefore ?? 0} → ${countAfter ?? 0} (must be unchanged).`,
    impact: 'A malformed product persisted despite an unknown type — the atomic-rejection guarantee is broken.',
  });

  // The storefront still serves the last valid catalog after the rejected insert.
  const after = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
  const afterTitles = replyEmbeds(after).map((e) => e.title ?? '');
  ctx.expect(
    beforeTitles.includes(validName) && afterTitles.includes(validName) && !afterTitles.includes(`${ctx.runPrefix}phantom`),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: '/store renders the identical valid catalog before and after the rejected submission, with no phantom product.',
      observation:
        `before titles include valid=${beforeTitles.includes(validName)}; after titles include valid=${afterTitles.includes(validName)}, ` +
        `phantom present=${afterTitles.includes(`${ctx.runPrefix}phantom`)}.`,
      impact: 'A rejected product submission disturbed the storefront (phantom product or dropped valid catalog).',
    },
  );

  await proveProductsRls(ctx, handle, validId!);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  // Negative price and the play-money-currency-grant wall are enforced in the
  // dashboard Zod + commerce-income-wall layer (the products table has no price
  // CHECK, and grant-target validation lives on the API), so a bot-only harness
  // cannot drive those reject paths.
  ctx.gate(
    'audit',
    'discord-readback',
    'A negative price and a play-money game-currency grant attempt are each rejected with a field-level validation error + a refused-admin-action audit row.',
    'these rejections live in the dashboard Zod + commerce-income-wall layer (products.price_cents has no DB CHECK); not reachable in a bot-only harness',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** UNAUTH — store management is denied to non-admins; anon direct writes blocked. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Positive control: the service role CAN write a product.
  const baselineId = await insertProduct(handle, { name: `${ctx.runPrefix}owned-pass`, priceCents: 500 });
  const { count: countBefore } = await handle.supabase
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);

  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'An anon Supabase client cannot INSERT a product for the guild (owner-only RLS / no anon GRANT).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-write denial was not exercised',
    );
  } else {
    const denied = await anonInsertDenied(anonKey, 'products', {
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}anon-injected`,
      type: 'one_time',
      delivery_type: 'access_pass',
      price_cents: 1,
      currency: 'USD',
      active: true,
    });
    const { count: countAfter } = await handle.supabase
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId);
    if (denied === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'An anon Supabase client cannot INSERT a product for the guild.',
        'the anon REST write probe was inconclusive (no SUPABASE_URL or a network error)',
      );
    } else {
      ctx.expect(denied === true && (countBefore ?? 0) === (countAfter ?? -1), {
        assertionClass: 'database-RLS',
        channel: 'db-rls',
        promise: 'An anon client’s direct product INSERT is refused by RLS and writes no row; the products table is byte-identical.',
        observation:
          `anon insert refused=${denied}; products count ${countBefore ?? 0} → ${countAfter ?? 0} (must be unchanged).`,
        impact: 'A non-owner anon client could write products directly — store management RLS failed open.',
      });
    }
  }

  await proveProductsRls(ctx, handle, baselineId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  // The dashboard-API 403 (non-admin session), the refused-action audit rows, and
  // the security-view aggregation live on the authenticated dashboard lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin authenticated session calling POST/PATCH /api/store/products receives 403 with no row written and a clean branded error envelope.',
    'requires the authenticated dashboard-session lane (requireGuildOwner) — not reachable in a bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each denied management attempt is logged as an undeleted permission-refusal row with the caller identity; repeats surface in the security view.',
    'the refused-admin-action audit rows are written by the dashboard API path (not reachable in a bot-only harness)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** DEPFAIL — with a dependency unreachable, the store fails safe. The Supabase
 *  leg is driven through the REAL fault proxy (ctx.faults severs the actual
 *  network path run-one-domain routed the stack through): /store is driven
 *  inside the severed window and must degrade honestly — the branded
 *  store-unavailable notice, never a data-shaped "store is empty" lie, with
 *  NO buy/payment button exposed, zero money rows from the window, and clean
 *  recovery. The PayPal-token legs (Buy-click copy, checkout dependency-failure
 *  audit, deduped owner alert, Buy-hammering) stay honestly gated — the proxy
 *  severs Supabase, not PayPal, and Buy is a button behind PayPal credentials. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await ctx.bootGuild({ label: 'a' });
    const productName = `${ctx.runPrefix}depfail-pass`;
    const productId = await insertProduct(handle, { name: productName, priceCents: 500 });
    ctx.expect(Boolean(productId), {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Test arrangement: an active product exists so the outage window degrades a REAL storefront, not an empty one.',
      observation: `product id=${productId ?? '(null)'}.`,
      impact: 'Could not arrange the storefront product — the DEPFAIL outage proof setup is invalid.',
    });

    // ── Outage window: a REAL severed network path (ECONNREFUSED). Hammer the
    //    storefront twice inside the window (repeat attempts queue nothing). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let severedSurface = '';
    let severedButtons: string[] = [];
    let secondSurface = '';
    try {
      const severedCap = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
      severedSurface = storeSurface(severedCap);
      severedButtons = replyButtonIds(severedCap);
      const hammeredCap = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
      secondSurface = storeSurface(hammeredCap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) FAIL-SAFE: every severed-window drive replied; nothing crashed.
    ctx.expect(threw === null && severedSurface.trim().length > 0 && secondSurface.trim().length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'With database access severed, /store still replies (fail-safe) on every attempt instead of crashing the interaction pipeline.',
      observation: `during the outage window /store ${threw === null ? `replied ${JSON.stringify(truncate(severedSurface, 140))} then ${JSON.stringify(truncate(secondSurface, 80))}` : `THREW ${truncate(threw, 140)}`}.`,
      impact: 'A database outage crashed the storefront command pipeline instead of degrading to a reply.',
    });

    // (2) The degradation is the branded unavailable notice: never the
    //     data-shaped "store is empty" lie, never a raw provider error, and —
    //     per the catalog — NO buy button / payment link is exposed while the
    //     dependency is down.
    const looksUnavailable = /unavailable|try again|temporar|later|degraded|issue|problem/i.test(severedSurface);
    const dataShapedLie = /store is empty/i.test(severedSurface) || /store is empty/i.test(secondSurface);
    const rawProviderError = /ECONNREFUSED|fetch failed|AggregateError|ENOTFOUND/i.test(severedSurface);
    ctx.expect(looksUnavailable && !dataShapedLie && !rawProviderError && severedButtons.length === 0, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'The outage-window /store reply is the calm branded store-unavailable notice — never a fabricated "store is empty" answer, a raw provider error, or a reply exposing a buy/payment button.',
      observation:
        `outage-window reply ${JSON.stringify(truncate(severedSurface, 160))} — looksUnavailable=${looksUnavailable}, ` +
        `dataShapedLie=${dataShapedLie}, rawProviderError=${rawProviderError}, buy buttons exposed=${severedButtons.length} (expected 0).`,
      impact: 'During a database outage the storefront lied about the catalog, leaked a raw provider error, or exposed a buy button against an unreadable store.',
    });

    // (3) ZERO money rows from the outage window + the catalog row survives
    //     byte-identically: a severed dependency can NEVER half-apply a
    //     purchase (no order, no payment, no entitlement exists to fire later).
    const orders = await countRows(handle, 'orders');
    const payments = await countRows(handle, 'payments');
    const entitlements = await countRows(handle, 'entitlements');
    const productAfter = await readProduct(handle, productId ?? '');
    ctx.expect(
      orders === 0 && payments === 0 && entitlements === 0 &&
        productAfter?.name === productName && productAfter?.price_cents === 500 && productAfter?.active === true,
      {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise: 'The hammered outage window leaves ZERO orders/payments/entitlements rows (no queued or deferred charge can fire later) and the product row is byte-identical after restore.',
        observation:
          `post-restore rows for the guild: orders=${orders}, payments=${payments}, entitlements=${entitlements} (all expected 0); ` +
          `product name=${productAfter?.name}/price=${productAfter?.price_cents}/active=${productAfter?.active} (expected ${productName}/500/true).`,
        impact: 'A severed-dependency window created or mutated money rows, or corrupted the catalog — a real-money half-apply hazard.',
      },
    );

    // (4) RECOVERY: the very next /store serves the real storefront again,
    //     buy button included — recovery starts from a clean slate.
    const recovered = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
    const recoveredTitles = replyEmbeds(recovered).map((e) => e.title ?? '');
    const recoveredButtons = replyButtonIds(recovered);
    ctx.expect(recoveredTitles.includes(productName) && recoveredButtons.includes(`store:buy:${productId}`), {
      assertionClass: 'replay-safety',
      channel: 'captured-reply',
      promise: 'After restoration the very next /store serves the real product with its buy button — recovery starts from a clean slate with no lingering degradation.',
      observation: `post-restore /store embed titles=${JSON.stringify(recoveredTitles)}; buy buttons=${JSON.stringify(recoveredButtons)}.`,
      impact: 'The storefront did not recover after the outage ended.',
    });

    await proveProductsRls(ctx, handle, productId ?? '');
    await proveTwoEconomiesWall(ctx, handle);
    await proveNoOwnerAlert(ctx, handle); // an outage BLIP raises no alert (dedup fires only when sustained)
    gateBrandingDeferredToDef(ctx);
  } else {
    ctx.gate(
      'Discord',
      'captured-reply',
      'With the database severed, /store fails safe with the branded store-unavailable reply, exposing no buy button.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The outage-window /store reply is the calm branded unavailable notice, never a data-shaped "store is empty" lie or a raw provider error.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-observable',
      'A severed-dependency window leaves zero orders/payments/entitlements rows and the catalog byte-identical.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'captured-reply',
      'After restoration the next /store serves the real storefront again.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }

  // The PayPal-token outage itself (Buy click → payment-service-unavailable
  // copy, dependency-failure audit, deduped owner alert, Buy-hammering) cannot
  // be modeled by severing Supabase — the proxy does not touch PayPal's
  // network path, and Buy is a button lane behind PayPal credentials.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With the PayPal token endpoint unreachable, clicking Buy replies with the payment-service-unavailable copy and no link button; a later healthy attempt shows the normal checkout-invite.',
    'requires a Discord button lane + a PayPal-token-outage fault-injection lane',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The failed checkout attempt leaves zero orders/payments/entitlements rows; exactly one set exists after a clean recovery attempt.',
    'requires the PayPal-outage fault lane + the button checkout path to run',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The dependency failure is recorded as a commerce.checkout dependency-failure audit row with the failing stage, followed by the recovery’s normal trail.',
    'requires the PayPal-outage fault lane to reach the checkout dependency-failure branch',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Sustained PayPal unavailability raises a single deduped dashboard alert, not one per failed click.',
    'requires the PayPal-outage fault lane + owner alert channel readback',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The failure copy is calm, owner-voiced, and never surfaces raw provider errors to the buyer.',
    'requires the PayPal-outage fault lane to reach the unavailable-copy branch',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Hammering Buy during the outage creates no queued/deferred charge that could fire later; recovery starts clean.',
    'requires the PayPal-outage fault lane + the button checkout path',
  );
}

/** RETRY — a transient /store query failure recovers on the next invocation.
 *  The contracted transient IS a one-off products-query (Supabase) failure, so
 *  a between-ops sever through the REAL fault proxy models it faithfully:
 *  sever → the /store read fails and degrades honestly → restore → the retried
 *  /store converges to the full storefront with nothing written. The checkout
 *  tail (Buy → PayPal order/link/fulfillment) stays gated on the PayPal lane. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const productId = await insertProduct(handle, { name: `${ctx.runPrefix}retry-pass`, priceCents: 500 });

  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    // ── The induced transient: one severed /store attempt (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let failedSurface = '';
    try {
      const failedCap = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
      failedSurface = storeSurface(failedCap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();
    const ordersAfterFault = await countRows(handle, 'orders');
    ctx.expect(
      threw === null &&
        /unavailable|try again|temporar|later|degraded|issue|problem/i.test(failedSurface) &&
        !/store is empty/i.test(failedSurface) &&
        ordersAfterFault === 0,
      {
        assertionClass: 'Discord',
        channel: 'db-observable',
        promise: 'The one-off products-query failure makes /store degrade once with the branded store-unavailable reply — not an "empty store" lie — and writes no rows.',
        observation:
          `severed-window /store ${threw === null ? `replied ${JSON.stringify(truncate(failedSurface, 140))}` : `THREW ${truncate(threw, 140)}`}; ` +
          `orders rows after the failed attempt=${ordersAfterFault ?? '(read error)'} (expected 0).`,
        impact: 'The transient query failure crashed /store, fabricated an empty storefront, or wrote rows.',
      },
    );
  } else {
    ctx.gate(
      'Discord',
      'captured-reply',
      'A one-off products-query failure makes /store degrade once with the branded store-unavailable reply, writing no rows.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }

  // The RECOVERED steady state: the retried /store renders the full storefront.
  const recovered = await ctx.runSlash(handle, { commandName: 'store', userId: ctx.userId('a') });
  const titles = replyEmbeds(recovered).map((e) => e.title ?? '');
  ctx.expect(titles.includes(`${ctx.runPrefix}retry-pass`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'After a transient blip, the next /store renders the full storefront (the recovered state).',
    observation: `recovered /store embed titles=${JSON.stringify(titles)} (expected the retry product).`,
    impact: 'The storefront did not render on the (recovered) retry invocation.',
  });

  await proveProductsRls(ctx, handle, productId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  ctx.gate(
    'Discord',
    'db-observable',
    'The retried checkout completes with exactly one order/link/fulfillment.',
    'the checkout tail runs Buy → PayPal (button lane + PayPal sandbox); the transient store-query half is exercised on the fault lane above',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Both the transient failure and the successful retry are audited so the recovery timeline reconstructs.',
    'requires the transient-fault lane to produce the commerce.store.load_failed audit row',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** REPLAY — money & grants are idempotent: the DB-level fences reject duplicates. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const discordId = ctx.userId('a');

  // Establish a real fulfilled purchase chain (customer → product → completed order
  // → active entitlement). The entitlement occupies the unique
  // idx_entitlements_order_id slot for its order.
  const chain = await arrangePurchaseChain(ctx, handle, discordId, 'replay');
  ctx.expect(chain.entitlementError === null && Boolean(chain.orderId), {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Test arrangement: one fulfilled purchase (completed order + one active entitlement) exists.',
    observation: `orderId=${chain.orderId ?? '(null)'}; entitlement error=${chain.entitlementError ?? 'none'}.`,
    impact: 'Could not arrange the fulfilled-purchase baseline — the REPLAY idempotency proof setup is invalid.',
  });

  // (a) Fulfillment replay fence: a SECOND entitlement for the SAME order_id is
  //     rejected by the unique index (one entitlement per order).
  const { error: dupEntErr } = await handle.supabase.from('entitlements').insert({
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    product_id: chain.productId,
    order_id: chain.orderId,
    type: 'one_time',
    status: 'active',
    source: 'purchase',
  });
  const { count: entCount } = await handle.supabase
    .from('entitlements')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('order_id', chain.orderId ?? '');
  ctx.expect(dupEntErr !== null && (entCount ?? 0) === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Replaying fulfillment never double-grants: a second entitlement for the same order is rejected (unique idx_entitlements_order_id).',
    observation:
      `duplicate-entitlement insert rejected=${dupEntErr !== null} (error: ${dupEntErr?.message ?? 'NONE — it double-granted!'}); ` +
      `entitlements for the order=${entCount ?? 0} (expected exactly 1).`,
    impact: 'A replayed fulfillment created a second entitlement for one order — the exactly-once grant fence failed.',
  });

  // (b) Webhook replay fence: a SECOND payment with the SAME paypal_event_id is
  //     rejected (payments.paypal_event_id UNIQUE) — the capture webhook dedupe key.
  const eventId = `${ctx.runPrefix}evt-1`;
  const paymentRow = {
    order_id: chain.orderId,
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    paypal_event_id: eventId,
    amount_cents: 500,
    status: 'completed',
    // payments_resource_type_required CHECK: every new payment row must carry
    // its PayPal resource type (capture vs sale). Without it the FIRST insert
    // fails and this probe records a FALSE "double-recorded" finding — the
    // paypal_event_id UNIQUE fence itself is fine.
    paypal_resource_type: 'capture',
  };
  const { error: pay1Err } = await handle.supabase.from('payments').insert(paymentRow);
  const { error: pay2Err } = await handle.supabase.from('payments').insert(paymentRow);
  const { count: payCount } = await handle.supabase
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('paypal_event_id', eventId);
  ctx.expect(pay1Err === null && pay2Err !== null && (payCount ?? 0) === 1, {
    assertionClass: 'replay-safety',
    channel: 'audit-row',
    promise: 'Replaying the capture webhook never double-charges: a second payment with the same PayPal event id is rejected (unique paypal_event_id).',
    observation:
      `first payment ok=${pay1Err === null}, replayed payment rejected=${pay2Err !== null} ` +
      `(error: ${pay2Err?.message ?? 'NONE — it double-recorded!'}); payments for the event=${payCount ?? 0} (expected 1).`,
    impact: 'A replayed capture webhook recorded a second payment — the money-row idempotency fence failed.',
  });

  // (c) Buy-click replay fence: a second customer for the same (discord_id, guild_id)
  //     is rejected (UNIQUE), so a re-clicked Buy reuses one customer identity.
  const { error: dupCustErr } = await handle.supabase
    .from('customers')
    .insert({ guild_id: handle.guildId, discord_id: discordId, discord_username: `${ctx.runPrefix}dup` });
  ctx.expect(dupCustErr !== null, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A re-clicked Buy reuses one buyer identity: a second customer for the same (discord_id, guild_id) is rejected (UNIQUE).',
    observation: `duplicate-customer insert rejected=${dupCustErr !== null} (error: ${dupCustErr?.message ?? 'NONE — a duplicate customer persisted!'}).`,
    impact: 'A replayed buy click created a duplicate customer row — buyer identity is not deduped.',
  });

  await proveProductsRls(ctx, handle, chain.productId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'End-to-end webhook/buy/claim replays leave role assignments and receipt-DM counts exactly unchanged.',
    'requires the capture-webhook + button + DM lanes (Discord readback + PayPal sandbox) to replay the full fulfillment',
  );
}

/** RESTART — a pending order + its identity survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const discordId = ctx.userId('a');

  // Boot #1: arrange a pending order (the state a checkout commits before the
  // payment link is exposed), snapshot it, then shut the stack down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const { data: cust } = await first.supabase
    .from('customers')
    .insert({ guild_id: guildId, discord_id: discordId, discord_username: `${ctx.runPrefix}restart` })
    .select('id')
    .single();
  const customerId = (cust as { id: string } | null)?.id ?? null;
  const productId = await insertProduct(first, { name: `${ctx.runPrefix}restart-pass`, priceCents: 500 });
  const orderNumber = `${ctx.runPrefix}restart-ord`;
  await first.supabase.from('orders').insert({
    order_number: orderNumber,
    customer_id: customerId,
    guild_id: guildId,
    product_id: productId,
    paypal_order_id: `${ctx.runPrefix}ppo`,
    amount_cents: 500,
    status: 'pending',
    source: 'purchase',
  });
  const { data: snap } = await first.supabase
    .from('orders')
    .select('id, status, guild_id, order_number')
    .eq('guild_id', guildId)
    .eq('order_number', orderNumber)
    .maybeSingle();
  const snapshot = snap as OrderRow | null;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The pending order lives in Supabase, so it
  // must come back byte-identical and still pending (fulfillment has not arrived).
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const { data: after } = await second.supabase
    .from('orders')
    .select('id, status, guild_id, order_number')
    .eq('guild_id', guildId)
    .eq('order_number', orderNumber)
    .maybeSingle();
  const afterRestart = after as OrderRow | null;
  ctx.expect(
    afterRestart !== null &&
      afterRestart.id === snapshot?.id &&
      afterRestart.status === 'pending' &&
      afterRestart.order_number === orderNumber,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After a full stack restart, the pending order + its identity are unchanged and still pending (not yet fulfilled).',
      observation:
        `pre-restart order id=${snapshot?.id}/status=${snapshot?.status}; ` +
        `post-restart id=${afterRestart?.id}/status=${afterRestart?.status} (expected identical + pending).`,
      impact: 'Checkout state did not survive a restart — the pending order or its identity was lost/altered.',
    },
  );

  // /store renders on first invocation after boot.
  const store = await ctx.runSlash(second, { commandName: 'store', userId: discordId });
  ctx.expect(replyEmbeds(store).map((e) => e.title ?? '').includes(`${ctx.runPrefix}restart-pass`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /store renders the storefront on first invocation.',
    observation: `post-restart /store embed titles=${JSON.stringify(replyEmbeds(store).map((e) => e.title ?? ''))}.`,
    impact: 'Post-restart /store failed to render the storefront.',
  });

  await proveProductsRls(ctx, second, productId!);
  await proveTwoEconomiesWall(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateBrandingDeferredToDef(ctx);

  // The capture webhook fulfilling the frozen snapshot AFTER reboot (one entitlement,
  // roles, receipt DM) needs the PayPal + Discord lanes.
  ctx.gate(
    'audit',
    'discord-readback',
    'A capture arriving after the restart fulfills exactly one entitlement from the frozen grant snapshot, with a seamless before/after audit trail and no double grant.',
    'requires the PayPal capture webhook + fulfillment + Discord readback lanes',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** RACE — concurrent grants resolve to exactly one via database-level uniqueness. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const discordId = ctx.userId('a');

  const chain = await arrangePurchaseChain(ctx, handle, discordId, 'race');
  ctx.expect(chain.entitlementError === null && Boolean(chain.orderId && chain.customerId && chain.productId), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: a completed order + one entitlement exist for the raced buyer/product.',
    observation: `orderId=${chain.orderId ?? '(null)'}; entitlement error=${chain.entitlementError ?? 'none'}.`,
    impact: 'Could not arrange the race baseline — the RACE proof setup is invalid.',
  });

  // (a) Two SIMULTANEOUS second-fulfillment inserts for the SAME order_id: the
  //     unique index (one entitlement per order) admits exactly one; the DB, not
  //     bot memory, is the arbiter. (One entitlement already exists on the order,
  //     so both racers must be rejected — net entitlements for the order stays 1.)
  const raceEntitlement = () =>
    handle.supabase.from('entitlements').insert({
      customer_id: chain.customerId,
      guild_id: handle.guildId,
      product_id: chain.productId,
      order_id: chain.orderId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
    });
  const [r1, r2] = await Promise.all([raceEntitlement(), raceEntitlement()]);
  const rejected = [r1.error, r2.error].filter((e) => e !== null).length;
  const { count: entCount } = await handle.supabase
    .from('entitlements')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('order_id', chain.orderId ?? '');
  ctx.expect(rejected === 2 && (entCount ?? 0) === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Concurrent duplicate fulfillments never over-grant: database uniqueness (idx_entitlements_order_id) keeps exactly one entitlement per order.',
    observation:
      `both concurrent duplicate inserts rejected=${rejected}/2; entitlements for the order=${entCount ?? 0} (expected exactly 1).`,
    impact: 'A concurrent fulfillment race produced a duplicate entitlement — DB-level single-grant uniqueness failed.',
  });

  // (b) Two SIMULTANEOUS get-or-create customers for the same (discord_id,
  //     guild_id): exactly one row survives (the UNIQUE constraint the buy handler
  //     relies on so racing buy clicks share one buyer identity).
  const otherDiscordId = ctx.userId('b');
  const raceCustomer = () =>
    handle.supabase
      .from('customers')
      .insert({ guild_id: handle.guildId, discord_id: otherDiscordId, discord_username: `${ctx.runPrefix}race-b` });
  const [c1, c2] = await Promise.all([raceCustomer(), raceCustomer()]);
  const custRejected = [c1.error, c2.error].filter((e) => e !== null).length;
  const { count: custCount } = await handle.supabase
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', otherDiscordId);
  ctx.expect(custRejected === 1 && (custCount ?? 0) === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two concurrent first-touch buy clicks create exactly one customer identity (UNIQUE(discord_id, guild_id)).',
    observation:
      `one of two concurrent customer inserts rejected=${custRejected === 1}; customers for the buyer=${custCount ?? 0} (expected exactly 1).`,
    impact: 'A first-touch race created duplicate customer rows — buyer identity is not race-safe.',
  });

  await proveProductsRls(ctx, handle, chain.productId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  // The two-parallel-buy-clicks Discord experience (one checkout success, one
  // branded already-owned refusal) and the free-claim race need the button + DM lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Two parallel buy interactions resolve to one checkout success and one branded already-owned refusal; neither hangs nor double-replies.',
    'requires the Discord button-interaction lane (+ PayPal for the winning checkout)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Both racing attempts are audited with their outcomes, and the winning grant appears exactly once.',
    'requires the button checkout/claim path to produce the racing audit rows',
  );
}

/** XGUILD — guild isolation is absolute: guild B never sees guild A's store. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA });
  const handleB = await ctx.bootGuild({ guildId: guildB });
  const discordId = ctx.userId('a');

  // Guild A gets a product + a fulfilled purchase chain; guild B gets nothing.
  const productName = `${ctx.runPrefix}xg-pass`;
  const productId = await insertProduct(handleA, { name: productName, priceCents: 500 });
  const chainA = await arrangePurchaseChain(ctx, handleA, discordId, 'xg');

  // Guild A renders its catalog; guild B shows store-empty.
  const storeA = await ctx.runSlash(handleA, { commandName: 'store', userId: discordId });
  const storeB = await ctx.runSlash(handleB, { commandName: 'store', userId: discordId });
  const titlesA = replyEmbeds(storeA).map((e) => e.title ?? '');
  const emptyB = replyText(storeB).toLowerCase();
  ctx.expect(titlesA.includes(productName) && emptyB.includes('empty'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/store in guild A renders guild A’s catalog while /store in guild B replies store-empty (no cross-guild product leaks).',
    observation: `guild A titles=${JSON.stringify(titlesA)}; guild B reply="${truncate(replyText(storeB))}".`,
    impact: 'A guild B member saw guild A’s products, or guild A’s catalog failed to render — guild isolation broken.',
  });

  // DB isolation: guild-B-scoped reads of products/orders/entitlements return ZERO;
  // guild-A-scoped reads return the real rows.
  const bProducts = await countRows(handleB, 'products');
  const bOrders = await countRows(handleB, 'orders');
  const bEntitlements = await countRows(handleB, 'entitlements');
  const aProducts = await countRows(handleA, 'products');
  ctx.expect(
    bProducts === 0 && bOrders === 0 && bEntitlements === 0 && (aProducts ?? 0) >= 1 && chainA.entitlementError === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'All run rows carry guild A’s id: guild-B-scoped queries return zero store rows while guild A holds the real product/order/entitlement.',
      observation:
        `guild B: products=${bProducts}, orders=${bOrders}, entitlements=${bEntitlements} (all expected 0); ` +
        `guild A products=${aProducts ?? 0} (>=1), guild A entitlement arranged=${chainA.entitlementError === null}.`,
      impact: 'A guild-scoped store query returned another guild’s rows — cross-guild commerce leakage.',
    },
  );

  await proveProductsRls(ctx, handleA, productId!);
  await proveTwoEconomiesWall(ctx, handleA);
  // Guild B receives no owner alert from guild A activity.
  await proveNoOwnerAlert(ctx, handleB);
  // Guild B renders the store-empty reply (no product embed); the storefront-brand
  // finding is surfaced in DEF.
  gateBrandingDeferredToDef(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Replaying guild A’s fulfillment webhook cannot grant anything in guild B — the custom id’s guild binding is enforced.',
    'requires the PayPal webhook + custom-id guild-binding lane to replay across guilds',
  );
}

/** CLEANUP — the sweep removes run-prefixed operational rows; audit rows remain. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const discordId = ctx.userId('a');

  // Create a full run-prefixed operational footprint + an append-only audit row.
  const chain = await arrangePurchaseChain(ctx, handle, discordId, 'cleanup');
  await handle.supabase.from('payments').insert({
    order_id: chain.orderId,
    customer_id: chain.customerId,
    guild_id: handle.guildId,
    paypal_event_id: `${ctx.runPrefix}cleanup-evt`,
    amount_cents: 500,
    status: 'completed',
    // Required by the payments_resource_type_required CHECK (see REPLAY); the
    // silent failure here left the ops baseline at 4 rows (< 5) and produced
    // the false "could not establish a run-prefixed baseline" finding.
    paypal_resource_type: 'capture',
  });
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'system',
    actor_id: 'commerce',
    action: 'entitlement.granted',
    target_type: 'entitlement',
    target_id: chain.orderId,
    details: { productId: chain.productId },
  });

  const opsBefore =
    (await countRows(handle, 'products') ?? 0) +
    (await countRows(handle, 'orders') ?? 0) +
    (await countRows(handle, 'entitlements') ?? 0) +
    (await countRows(handle, 'payments') ?? 0) +
    (await countRows(handle, 'customers') ?? 0);
  const { count: auditBefore } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  ctx.expect(opsBefore >= 5 && (auditBefore ?? 0) >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed commerce operational rows + an append-only audit row (pre-cleanup baseline).',
    observation: `pre-cleanup: operational rows=${opsBefore}, audit rows=${auditBefore ?? 0}.`,
    impact: 'The cleanup scenario could not establish a run-prefixed baseline.',
  });

  // Off-theme classes proven while rows still exist.
  await proveProductsRls(ctx, handle, chain.productId!);
  await proveTwoEconomiesWall(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandingDeferredToDef(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO operational rows
  // remain — while the append-only audit row is RETAINED (anonymize-over-delete).
  await ctx.sweepGuildRows(handle);
  const opsAfter =
    (await countRows(handle, 'products') ?? 0) +
    (await countRows(handle, 'orders') ?? 0) +
    (await countRows(handle, 'entitlements') ?? 0) +
    (await countRows(handle, 'payments') ?? 0) +
    (await countRows(handle, 'customers') ?? 0);
  ctx.expect(opsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The sweep deletes every run-prefixed product, order, entitlement, payment, and customer row; a final count finds zero.',
    observation: `post-sweep operational rows=${opsAfter} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed commerce rows behind — the suite leaves residue.',
  });

  const { count: auditAfter } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  ctx.expect((auditAfter ?? 0) >= (auditBefore ?? 0) && (auditAfter ?? 0) >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Audit rows are retained (anonymized-not-deleted) across the operational-row sweep.',
    observation: `audit rows before=${auditBefore ?? 0}, after sweep=${auditAfter ?? 0} (must not shrink; >=1).`,
    impact: 'The sweep deleted append-only audit history — the retention contract was violated.',
  });

  // The second sweep is a pure no-op (idempotent cleanup) — errors on nothing.
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

  // Discord message/role removal and PayPal sandbox catalog-object cleanup are
  // separate credentialed lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Run-created store messages, celebration posts, and granted test roles are gone from the guild after the sweep.',
    'requires a live Discord channel/role readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner surface shows no lingering test orders or alerts after the sweep, and any changed branding config is restored.',
    'requires the dashboard orders/alerts view + PayPal sandbox catalog cleanup readback',
  );
}

// ── DomainProof export ──────────────────────────────────────────────────────

/**
 * The product-store domain proof. `guildScopedTables` lists every guild_id-scoped
 * operational table this domain writes in child→parent FK order (so FK-constrained
 * rows are removed before their parents, then guild_config + guild by the runner).
 * audit_logs is deliberately EXCLUDED — audit history is retained, not swept (the
 * CLEANUP scenario proves that retention).
 */
export const commerceProductStoreProof: DomainProof = {
  domainId: 'commerce-product-store',
  guildScopedTables: [
    'entitlements',
    'license_keys',
    'payments',
    'orders',
    'plans',
    'promotions',
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
