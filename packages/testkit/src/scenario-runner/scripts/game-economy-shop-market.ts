/**
 * scenario-runner/scripts/game-economy-shop-market — the shop-&-market domain proof.
 *
 * Binds the shop-&-market domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven through the REAL production dispatcher against
 * LOCAL Supabase. Every DB-observable / captured-reply / audit-row / RLS assertion
 * — including the full /market list|browse|buy|cancel subcommand lifecycle — runs
 * NOW; anything needing a real Discord effect, a PayPal/dashboard lane, or a
 * fault-injection lane is GATED — never faked.
 *
 * ── Both trading surfaces are fully drivable here (since PR #331) ──
 *   • The server SHOP (/shop, /buy, /sell) is dispatched as TOP-LEVEL slash
 *     commands, so the sanctioned `ctx.runSlash` helper drives them end-to-end:
 *     their real wallet debit/credit, inventory upsert, stock decrement and
 *     economy_transactions ledger rows are asserted live.
 *   • The player MARKET (/market list|browse|buy|my-listings|cancel) is a
 *     SUBCOMMAND command. `RunSlashParams` now carries `subcommand`, so
 *     `ctx.runSlash(handle, { commandName: 'market', subcommand: 'list', ... })`
 *     builds a ChatInput interaction whose `interaction.options.getSubcommand()`
 *     returns the branch the REAL MarketManager dispatches on — the listing/browse/
 *     buy/cancel mutations, their atomic RPC effects (escrow decrement, buyer debit,
 *     seller net-of-fee credit, inventory delivery, market_buy/market_sale ledger
 *     rows) and their captured embeds are all asserted live. The market-DISABLED
 *     reply (manager never wired when economy_market_enabled is off) is still a
 *     real captured reply too.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's
 * contracted intent AND that divergence is observable here, the script records a
 * FAIL (promise / observation / impact) rather than forcing green. The headline
 * example is REPLAY: the shop /buy path carries NO idempotency key, so a
 * re-delivered /buy interaction double-charges — the catalog contracts exactly
 * one purchase, so the re-delivery proof FAILs and surfaces the finding.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface ItemRow {
  id: string;
  name: string;
  price: number;
  sell_price: number;
  stock: number | null;
  tradeable: boolean;
  active: boolean;
  guild_id: string;
}

interface InventoryRow {
  item_id: string;
  quantity: number;
  user_id: string;
  guild_id: string;
}

interface ListingRow {
  id: string;
  seller_id: string;
  item_id: string;
  status: string;
  remaining: number;
  price_per_unit: number;
  guild_id: string;
}

interface TxnRow {
  type: string;
  amount: number;
}

interface EconomyDisplay {
  currencyName: string;
  currencyEmoji: string;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function display(handle: LiveClientHandle): EconomyDisplay {
  return { currencyName: handle.economy.currencyName, currencyEmoji: handle.economy.currencyEmoji };
}

/** Arrange an exact wallet/bank via the REAL wallet initializer, then a precise set. */
async function seedWallet(
  handle: LiveClientHandle,
  userId: string,
  wallet: number,
  bank = 0,
): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet, bank })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, bank, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

/** Seed one owner-curated shop item; returns its id (or null if the insert failed). */
async function seedItem(
  handle: LiveClientHandle,
  opts: {
    name: string;
    price: number;
    sellPrice: number;
    stock?: number | null;
    tradeable?: boolean;
    category?: string;
    emoji?: string;
  },
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('economy_items')
    .insert({
      guild_id: handle.guildId,
      name: opts.name,
      description: `${opts.name} (e2e)`,
      emoji: opts.emoji ?? '📦',
      category: opts.category ?? 'Consumables',
      price: opts.price,
      sell_price: opts.sellPrice,
      stock: opts.stock ?? null,
      tradeable: opts.tradeable ?? true,
      active: true,
      sort_order: 0,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function readItem(handle: LiveClientHandle, itemId: string): Promise<ItemRow | null> {
  const { data } = await handle.supabase
    .from('economy_items')
    .select('id, name, price, sell_price, stock, tradeable, active, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('id', itemId)
    .maybeSingle();
  return (data as ItemRow | null) ?? null;
}

async function itemCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_items')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Quantity of a specific item a user owns (0 when the row is absent). */
async function inventoryQty(handle: LiveClientHandle, userId: string, itemId: string): Promise<number> {
  const { data } = await handle.supabase
    .from('economy_inventory')
    .select('quantity')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  return (data as { quantity: number } | null)?.quantity ?? 0;
}

/** Total inventory ROWS a user holds (used for oversell / cleanup counts). */
async function inventoryRowCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_inventory')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function txns(
  handle: LiveClientHandle,
  userId: string,
  type?: string,
): Promise<TxnRow[]> {
  let query = handle.supabase
    .from('economy_transactions')
    .select('type, amount')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  if (type) query = query.eq('type', type);
  const { data } = await query;
  return (data as TxnRow[] | null) ?? [];
}

/** Seed a market listing row directly (a fast arrangement shortcut when a scenario
 *  only needs an existing listing to buy/cancel against; scenarios that PROVE the
 *  listing path itself drive /market list live). Returns the listing id. */
async function seedListing(
  handle: LiveClientHandle,
  sellerId: string,
  itemId: string,
  itemName: string,
  quantity: number,
  pricePerUnit: number,
): Promise<string | null> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await handle.supabase
    .from('economy_market_listings')
    .insert({
      guild_id: handle.guildId,
      seller_id: sellerId,
      item_id: itemId,
      item_name: itemName,
      quantity,
      remaining: quantity,
      price_per_unit: pricePerUnit,
      status: 'active',
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function readListing(handle: LiveClientHandle, listingId: string): Promise<ListingRow | null> {
  const { data } = await handle.supabase
    .from('economy_market_listings')
    .select('id, seller_id, item_id, status, remaining, price_per_unit, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('id', listingId)
    .maybeSingle();
  return (data as ListingRow | null) ?? null;
}

async function listingCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_market_listings')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Active listings a seller currently holds for one item (0 when none). */
async function sellerItemListingCount(
  handle: LiveClientHandle,
  sellerId: string,
  itemId: string,
): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_market_listings')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('seller_id', sellerId)
    .eq('item_id', itemId)
    .eq('status', 'active');
  return count ?? 0;
}

interface SellerListingRow {
  id: string;
  item_id: string;
  remaining: number;
  price_per_unit: number;
  status: string;
  expires_at: string;
}

/** The seller's most-recently-created listing (the one a driven /market list made). */
async function readSellerListing(
  handle: LiveClientHandle,
  sellerId: string,
): Promise<SellerListingRow | null> {
  const { data } = await handle.supabase
    .from('economy_market_listings')
    .select('id, item_id, remaining, price_per_unit, status, expires_at')
    .eq('guild_id', handle.guildId)
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SellerListingRow | null) ?? null;
}

/** Give a member `qty` of an item via the REAL inventory upsert RPC (arrangement). */
async function giveInventory(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
  qty: number,
): Promise<void> {
  await handle.supabase.rpc('economy_upsert_inventory', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: qty,
  });
}

async function guildConfig(
  handle: LiveClientHandle,
): Promise<Record<string, unknown> | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('economy_market_enabled, economy_market_fee_pct, economy_market_listing_days, economy_market_max_listings, economy_enabled')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
 * errors, so a failed read can never masquerade as "no alert raised" — the
 * caller GATEs on null rather than recording a false-clean PASS.
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Read the last editReply/reply content string a handler produced. */
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return String((edits[edits.length - 1]!.payload as { content?: string } | undefined)?.content ?? '');
  }
  const reply = captured.find('reply');
  return String((reply?.payload as { content?: string } | undefined)?.content ?? '');
}

function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const reply = captured.find('reply');
  const payload = reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

/**
 * The last response payload a handler produced, editReply-first. The /market
 * handler defers then editReplies (deferReply → editReply), so its embeds land in
 * `editReply`, not `reply`; this reader prefers the last editReply and falls back
 * to the last reply so both lifecycles are covered.
 */
function lastPayload(captured: CapturedResponse): unknown {
  const edits = captured.allOf('editReply');
  const reply = captured.allOf('reply');
  return (edits[edits.length - 1] ?? reply[reply.length - 1])?.payload;
}

/** The embed `.data` of the last editReply/reply (undefined when none). */
function lastEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const payload = lastPayload(captured) as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

/** The description string of the last editReply/reply embed (empty when none). */
function lastEmbedDescription(captured: CapturedResponse): string {
  return String((lastEmbedData(captured) ?? {}).description ?? '');
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS deny → 0),
 * or null when no anon key / an inconclusive gateway error (→ GATE).
 */
async function anonReadCount(
  anonKey: string,
  table: string,
  guildId: string,
): Promise<number | null> {
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (SQLSTATE 42501
    // "permission denied for table" — the deny we want to prove) from a rejected
    // key before authz ran (inconclusive → GATE).
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/** Every member-facing text surface of a reply: content + embed title/description/fields/footer. */
function brandingSurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const content = replyContent(captured);
  if (content) parts.push(content);
  const embed = replyEmbedData(captured);
  if (embed) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
    const fields = embed.fields as Array<{ name?: string; value?: string }> | undefined;
    for (const f of fields ?? []) {
      if (typeof f.name === 'string') parts.push(f.name);
      if (typeof f.value === 'string') parts.push(f.value);
    }
    const footer = (embed.footer as { text?: string } | undefined)?.text;
    if (typeof footer === 'string') parts.push(footer);
  }
  return parts.join('\n');
}

/**
 * Prove the member-facing reply carries the owner-configured currency branding,
 * checked against the REAL captured reply (content + embed) — never a synthetic
 * string. When a scenario produced no inspectable reply, the currency-branding
 * assertion GATEs (nothing to check) rather than recording a hollow PASS.
 */
function proveBranding(ctx: ScenarioContext, captured: CapturedResponse, econ: EconomyDisplay): void {
  const surface = brandingSurface(captured);
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      'Member-facing shop/market surfaces show the owner-configured currency name and emoji.',
      'this scenario produced no member-facing reply/embed to inspect for currency branding',
    );
  } else {
    const hasEmoji = surface.includes(econ.currencyEmoji);
    const hasName = surface.includes(econ.currencyName);
    ctx.expect(hasEmoji || hasName, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'Member-facing shop/market surfaces show the owner-configured currency name and emoji.',
      observation:
        `reply surface "${truncate(surface)}" ${hasEmoji ? 'includes' : 'omits'} emoji "${econ.currencyEmoji}" ` +
        `and ${hasName ? 'includes' : 'omits'} name "${econ.currencyName}".`,
      impact: 'A shop/market reply did not reflect the configured currency branding (stock-bot wording leaked).',
    });
  }
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's happy path raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: "This scenario's happy path raises no owner alert.",
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch alerts carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Anon-denial probe for one guild-scoped table, made non-vacuous by a positive
 * control: `serviceCount` is the number of rows the SERVICE role already sees for
 * this guild (must be > 0), so an anon client reading ZERO is a real deny, not
 * "there was nothing to read". Handles PostgREST 42501 as the deny.
 */
async function proveAnonDenied(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  serviceCount: number,
  rowNoun: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows (guild-scoped RLS).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows (guild-scoped RLS).`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceCount > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${rowNoun} while an anon client reads zero ${table} rows.`,
    observation:
      `service-role sees ${serviceCount} ${table} row(s) for guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} row(s).`,
    impact: `A ${rowNoun} visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).`,
  });
}

// ── Gating helpers (honest boundaries) ────────────────────────────────────

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The shop/market surfaces are observed working in the live test guild (channel embeds, escrow effects).',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/message readback',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    "Re-delivering this scenario's triggers yields no duplicate debits/deliveries/listing mutations.",
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

/**
 * The dedicated append-only audit_logs correlation-id row for a market state
 * change is a genuine residual here. A driven /market buy DOES write synchronous
 * economy_transactions market_buy/market_sale ledger rows (asserted wherever a buy
 * is driven), but the anonymized audit_logs row is emitted on the eventBus and
 * persisted by AuditService's 5-second BUFFERED flush (eventBus.onAny → in-memory
 * queue → setInterval flush), so it is not synchronously observable in this
 * in-process harness; /market list and /market cancel additionally write no
 * economy_transactions ledger row at all.
 */
function gateMarketAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'discord-readback',
    'Each market state change lands exactly one append-only audit row with actor/guild/correlation-id; audit history is anonymized not deleted.',
    "the anonymized audit_logs correlation-id row is written by AuditService's 5-second buffered flush (eventBus.onAny → queue → setInterval), so it is not synchronously observable in this in-process harness (the market buy's economy_transactions ledger rows ARE asserted where a buy is driven)",
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — shop on out of the box, player market off by default. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const price = 250;
  const sell = 100;

  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}widget`, price, sellPrice: sell });
  ctx.expect(itemId !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: an owner-curated shop item exists.',
    observation: `seeded economy_items row id=${itemId ?? '(null)'}.`,
    impact: 'Could not seed the owner-curated shop item — the shop proof setup is invalid.',
  });

  // 1) /shop renders the owner-curated item with its price + currency branding.
  const shopCaptured = await ctx.runSlash(handle, { commandName: 'shop', userId: userA, displayName: 'DEF A' });
  const shopEmbed = replyEmbedData(shopCaptured);
  const shopDesc = String(shopEmbed?.description ?? '');
  ctx.expect(shopDesc.includes(`${ctx.runPrefix}widget`) && shopDesc.includes('250'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/shop lists the owner-curated items with their prices.',
    observation: `/shop embed description = "${truncate(shopDesc)}".`,
    impact: '/shop did not render the seeded owner-curated item / price.',
  });

  // 2) /buy debits EXACTLY the listed price and delivers the item.
  await seedWallet(handle, userA, 1000, 0);
  const buyCaptured = await ctx.runSlash(handle, {
    commandName: 'buy',
    userId: userA,
    options: { item: `${ctx.runPrefix}widget`, quantity: 1 },
  });
  const afterBuy = await readWallet(handle, userA);
  const ownedAfterBuy = itemId ? await inventoryQty(handle, userA, itemId) : 0;
  ctx.expect(afterBuy?.wallet === 1000 - price && ownedAfterBuy === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `/buy debits exactly the listed price (${price}) and delivers one item to the buyer's inventory.`,
    observation: `wallet ${1000}→${afterBuy?.wallet} (expected ${1000 - price}); inventory qty=${ownedAfterBuy} (expected 1).`,
    impact: '/buy did not debit the exact listed price or did not deliver the item.',
  });

  // 3) /sell returns the item's sell_price and removes it from inventory.
  await ctx.runSlash(handle, {
    commandName: 'sell',
    userId: userA,
    options: { item: `${ctx.runPrefix}widget`, quantity: 1 },
  });
  const afterSell = await readWallet(handle, userA);
  const ownedAfterSell = itemId ? await inventoryQty(handle, userA, itemId) : -1;
  ctx.expect(afterSell?.wallet === 1000 - price + sell && ownedAfterSell === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `/sell returns the item's sell_price (${sell}) to the wallet and removes it from inventory.`,
    observation: `wallet=${afterSell?.wallet} (expected ${1000 - price + sell}); inventory qty=${ownedAfterSell} (expected 0).`,
    impact: '/sell did not credit the sell_price or did not remove the sold item.',
  });

  // 4) The player market ships OFF: /market replies market-disabled AND is not
  //    even in the exposed command set (economy_market_enabled default = false).
  const marketCaptured = await ctx.runSlash(handle, { commandName: 'market', userId: userA });
  const marketReply = replyContent(marketCaptured).toLowerCase();
  const marketExposed = handle.commands.some((c) => c.name === 'market');
  const cfg = await guildConfig(handle);
  ctx.expect(
    marketReply.includes('not enabled') &&
      !marketExposed &&
      cfg?.economy_market_enabled === declaredDefault(ctx.domain, 'market-enabled'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise:
        'Out of the box the player market is OFF (catalog default market-enabled=false): /market replies with the branded market-disabled notice and the command is not wired.',
      observation:
        `/market reply="${truncate(replyContent(marketCaptured))}", market command exposed=${marketExposed}, ` +
        `guild_config.economy_market_enabled=${String(cfg?.economy_market_enabled)} (catalog default=${String(declaredDefault(ctx.domain, 'market-enabled'))}).`,
      impact: 'The player market was not off by default, or did not reply market-disabled.',
    },
  );

  // Audit: the shop actions land append-only economy_transactions ledger rows.
  const buyTxn = await txns(handle, userA, 'shop_buy');
  const sellTxn = await txns(handle, userA, 'shop_sell');
  ctx.expect(
    buyTxn.length === 1 && buyTxn[0]!.amount === -price && sellTxn.length === 1 && sellTxn[0]!.amount === sell,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each shop action lands exactly one append-only economy_transactions ledger row (shop_buy debit, shop_sell credit).',
      observation:
        `shop_buy rows=${buyTxn.length}(amount ${buyTxn[0]?.amount}), shop_sell rows=${sellTxn.length}(amount ${sellTxn[0]?.amount}).`,
      impact: 'A shop action did not produce exactly one correct ledger row.',
    },
  );

  proveBranding(ctx, buyCaptured, econ);
  await proveAnonDenied(ctx, handle, 'economy_wallets', await walletServiceCount(handle, userA), 'wallet row');
  await proveAnonDenied(ctx, handle, 'economy_items', await itemCount(handle), 'shop item');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  // The player market is OFF by default in DEF, so no market mutation is exercised
  // here (SET-A / REPLAY / RACE drive the market live); only the audit_logs lane gates.
  gateMarketAudit(ctx);
}

/** SET-A — dashboard config takes live effect: market enabled, fee 10 / days 3 / max 5. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: {
      economy_market_enabled: true,
      economy_market_fee_pct: 10,
      economy_market_listing_days: 3,
      economy_market_max_listings: 5,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const price = 300;

  // Config-takes-effect, DB-observable: the saved market settings persisted…
  const cfg = await guildConfig(handle);
  ctx.expect(
    cfg?.economy_market_enabled === true &&
      cfg?.economy_market_fee_pct === 10 &&
      cfg?.economy_market_listing_days === 3 &&
      cfg?.economy_market_max_listings === 5,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'The dashboard save persists live: economy_market_enabled=true, fee=10%, listing-days=3, max-listings=5.',
      observation:
        `guild_config: enabled=${String(cfg?.economy_market_enabled)}, fee=${String(cfg?.economy_market_fee_pct)}, ` +
        `days=${String(cfg?.economy_market_listing_days)}, max=${String(cfg?.economy_market_max_listings)}.`,
      impact: 'A saved market configuration did not persist as written.',
    },
  );

  // …AND takes live dispatch-level effect: the REAL initGuildFeatures now wires
  // the market command (it is absent when the flag is off — see DEF/SET-B).
  const marketExposed = handle.commands.some((c) => c.name === 'market');
  ctx.expect(marketExposed, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Enabling economy_market_enabled wires the /market command live (no restart) via the real per-guild init.',
    observation: `after boot with economy_market_enabled=true, /market exposed by initGuildFeatures = ${marketExposed}.`,
    impact: 'The market enable flag did not take live effect — the command stayed unwired.',
  });

  // Shop still works under the new config (real debit + ledger).
  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}relic`, price, sellPrice: 120 });
  await seedWallet(handle, userA, 1000, 0);
  const buyCaptured = await ctx.runSlash(handle, {
    commandName: 'buy',
    userId: userA,
    options: { item: `${ctx.runPrefix}relic`, quantity: 1 },
  });
  const afterBuy = await readWallet(handle, userA);
  const owned = itemId ? await inventoryQty(handle, userA, itemId) : 0;
  ctx.expect(afterBuy?.wallet === 1000 - price && owned === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The server shop keeps working under the new market config: /buy debits the listed price and delivers.',
    observation: `wallet 1000→${afterBuy?.wallet} (expected ${1000 - price}); inventory qty=${owned}.`,
    impact: 'Enabling/adjusting the market disrupted the server shop path.',
  });
  const buyTxn = await txns(handle, userA, 'shop_buy');
  ctx.expect(buyTxn.length === 1 && buyTxn[0]!.amount === -price, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The shop purchase under the new config records one shop_buy ledger row.',
    observation: `shop_buy rows=${buyTxn.length}, amount=${buyTxn[0]?.amount} (expected ${-price}).`,
    impact: 'The shop purchase did not produce its ledger row.',
  });

  // ── The full player-market lifecycle, driven live via /market subcommands ──
  // Fresh seller/buyer (not userA) so the shop path above never interferes.
  const seller = ctx.userId('seller');
  const buyer = ctx.userId('buyer');
  const marketItemId = await seedItem(handle, { name: `${ctx.runPrefix}gem`, price: 0, sellPrice: 0, tradeable: true });
  if (marketItemId) await giveInventory(handle, seller, marketItemId, 5);
  await seedWallet(handle, seller, 0, 0);
  await seedWallet(handle, buyer, 5000, 0);

  // 1) /market list escrows 3 of the seller's 5 gems into a 3-day listing at 100/ea.
  const listCap = await ctx.runSlash(handle, {
    commandName: 'market',
    userId: seller,
    subcommand: 'list',
    options: { item: `${ctx.runPrefix}gem`, quantity: 3, price: 100 },
  });
  const listing = await readSellerListing(handle, seller);
  const sellerInvAfterList = marketItemId ? await inventoryQty(handle, seller, marketItemId) : -1;
  const listDesc = lastEmbedDescription(listCap);
  const expiresMs = listing ? new Date(listing.expires_at).getTime() - Date.now() : 0;
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const expiryOk = Math.abs(expiresMs - threeDaysMs) < 12 * 60 * 60 * 1000; // within ±12h of 3 days
  ctx.expect(
    listing?.status === 'active' &&
      listing?.remaining === 3 &&
      listing?.price_per_unit === 100 &&
      sellerInvAfterList === 2 &&
      expiryOk &&
      String(lastEmbedData(listCap)?.title ?? '').includes('Listed'),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A /market list creates a listing at the listed price, escrows the quantity out of inventory, and sets the configured listing-days=3 expiry.',
      observation:
        `listing status=${listing?.status}/remaining=${listing?.remaining}/price=${listing?.price_per_unit}, ` +
        `seller inventory 5→${sellerInvAfterList} (expected 2), expires in ~${Math.round(expiresMs / 3.6e6)}h (expected ~72h), ` +
        `reply="${truncate(listDesc)}".`,
      impact: 'The /market list path did not escrow the item into a correctly-priced, 3-day listing.',
    },
  );

  // 2) /market browse surfaces the freshly-listed item.
  const browseCap = await ctx.runSlash(handle, { commandName: 'market', userId: buyer, subcommand: 'browse', options: {} });
  const browseDesc = lastEmbedDescription(browseCap);
  ctx.expect(browseDesc.includes(`${ctx.runPrefix}gem`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/market browse lists the active player-market listing.',
    observation: `/market browse embed = "${truncate(browseDesc)}".`,
    impact: '/market browse did not surface the active listing.',
  });

  // 3) /market buy of 2 units deducts EXACTLY the 10% fee, crediting the seller the remainder.
  //    total = 100*2 = 200, fee = floor(200 * 10%) = 20, seller earns 180.
  const buyReq = `${ctx.runPrefix}mkt-buy-int`;
  const buyCap = await ctx.runSlash(handle, {
    commandName: 'market',
    userId: buyer,
    subcommand: 'buy',
    interactionId: buyReq,
    options: { listing: (listing?.id ?? '').slice(0, 8), quantity: 2 },
  });
  const buyerWallet = await readWallet(handle, buyer);
  const sellerWallet = await readWallet(handle, seller);
  const listingAfterBuy = await readSellerListing(handle, seller);
  const buyerOwned = marketItemId ? await inventoryQty(handle, buyer, marketItemId) : 0;
  const buyDesc = lastEmbedDescription(buyCap);
  ctx.expect(
    buyerWallet?.wallet === 5000 - 200 &&
      sellerWallet?.wallet === 180 &&
      listingAfterBuy?.remaining === 1 &&
      buyerOwned === 2 &&
      String(lastEmbedData(buyCap)?.title ?? '').includes('Purchase'),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A /market buy debits the buyer the full price and credits the seller the price net of exactly the 10% market fee; the listing decrements and the buyer receives the items.',
      observation:
        `buyer wallet 5000→${buyerWallet?.wallet} (expected 4800), seller wallet 0→${sellerWallet?.wallet} ` +
        `(expected 180 = 200−20 fee), listing remaining=${listingAfterBuy?.remaining} (expected 1), ` +
        `buyer inventory=${buyerOwned} (expected 2), reply="${truncate(buyDesc)}".`,
      impact: 'The /market buy did not move money net-of-fee, decrement the listing, or deliver the items.',
    },
  );

  // Market ledger: the settle wrote one market_buy (buyer debit) + one market_sale (seller credit).
  const mktBuyTxn = await txns(handle, buyer, 'market_buy');
  const mktSaleTxn = await txns(handle, seller, 'market_sale');
  ctx.expect(
    mktBuyTxn.length === 1 && mktBuyTxn[0]!.amount === -200 && mktSaleTxn.length === 1 && mktSaleTxn[0]!.amount === 180,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'A market purchase lands exactly one market_buy ledger row (buyer debit) and one market_sale row (seller net-of-fee credit).',
      observation:
        `market_buy rows=${mktBuyTxn.length}(amount ${mktBuyTxn[0]?.amount}), market_sale rows=${mktSaleTxn.length}(amount ${mktSaleTxn[0]?.amount}).`,
      impact: 'A market purchase did not produce exactly one correct buyer/seller ledger row pair.',
    },
  );

  // 4) Re-deliver the SAME /market buy interaction id: the idempotency key (request_id
  //    on the market_buy ledger row) makes it a proven no-op — one debit, one credit.
  await ctx.runSlash(handle, {
    commandName: 'market',
    userId: buyer,
    subcommand: 'buy',
    interactionId: buyReq,
    options: { listing: (listing?.id ?? '').slice(0, 8), quantity: 2 },
  });
  const buyerWalletReplay = await readWallet(handle, buyer);
  const sellerWalletReplay = await readWallet(handle, seller);
  const listingReplay = await readSellerListing(handle, seller);
  const buyerOwnedReplay = marketItemId ? await inventoryQty(handle, buyer, marketItemId) : 0;
  const mktBuyReplay = await txns(handle, buyer, 'market_buy');
  ctx.expect(
    buyerWalletReplay?.wallet === 4800 &&
      sellerWalletReplay?.wallet === 180 &&
      listingReplay?.remaining === 1 &&
      buyerOwnedReplay === 2 &&
      mktBuyReplay.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A re-delivered /market buy applies exactly one debit / one net-of-fee seller credit under its idempotency key (no double settlement).',
      observation:
        `after TWO deliveries of one /market buy interaction id: buyer wallet=${buyerWalletReplay?.wallet} (expects 4800), ` +
        `seller wallet=${sellerWalletReplay?.wallet} (expects 180), listing remaining=${listingReplay?.remaining} (expects 1), ` +
        `buyer inventory=${buyerOwnedReplay} (expects 2), market_buy ledger rows=${mktBuyReplay.length} (expects 1).`,
      impact: 'A re-delivered /market buy double-settled — the interaction-id idempotency key did not hold.',
    },
  );

  proveBranding(ctx, buyCaptured, econ);
  await proveAnonDenied(ctx, handle, 'economy_wallets', await walletServiceCount(handle, userA), 'wallet row');
  await proveAnonDenied(ctx, handle, 'economy_market_listings', await listingCount(handle), "member's market listing");
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateMarketAudit(ctx);
}

/** SET-B — the two surfaces toggle independently: market OFF, shop ON (and shop's master switch). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: false },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const price = 150;

  // Market disabled → branded market-disabled reply + command unwired.
  const marketCaptured = await ctx.runSlash(handle, { commandName: 'market', userId: userA });
  const marketExposed = handle.commands.some((c) => c.name === 'market');
  ctx.expect(replyContent(marketCaptured).toLowerCase().includes('not enabled') && !marketExposed, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With the player market disabled, /market returns the branded market-disabled refusal and stays unwired.',
    observation: `/market reply="${truncate(replyContent(marketCaptured))}", market exposed=${marketExposed}.`,
    impact: 'The market-disabled toggle did not refuse /market.',
  });

  // …while the server shop KEEPS working: /buy and /sell move coins + inventory.
  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}charm`, price, sellPrice: 60 });
  await seedWallet(handle, userA, 500, 0);
  const buyCaptured = await ctx.runSlash(handle, {
    commandName: 'buy',
    userId: userA,
    options: { item: `${ctx.runPrefix}charm`, quantity: 1 },
  });
  const afterBuy = await readWallet(handle, userA);
  await ctx.runSlash(handle, { commandName: 'sell', userId: userA, options: { item: `${ctx.runPrefix}charm`, quantity: 1 } });
  const afterSell = await readWallet(handle, userA);
  const ownedAfterSell = itemId ? await inventoryQty(handle, userA, itemId) : -1;
  ctx.expect(afterBuy?.wallet === 500 - price && afterSell?.wallet === 500 - price + 60 && ownedAfterSell === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With the market off, the server shop still works: /buy debits and /sell credits correctly.',
    observation:
      `after /buy wallet=${afterBuy?.wallet} (expected ${500 - price}); after /sell wallet=${afterSell?.wallet} ` +
      `(expected ${500 - price + 60}); inventory qty=${ownedAfterSell}.`,
    impact: 'Disabling the market disrupted the independent server shop surface.',
  });

  // The shop's own master switch (economy_enabled) toggles independently: with the
  // economy off, /shop returns the disabled reply (a SEPARATE booted guild proves it).
  const shopOff = await ctx.bootGuild({ label: 'b', economyEnabled: false });
  const shopOffCaptured = await ctx.runSlash(shopOff, { commandName: 'shop', userId: userA });
  ctx.expect(replyContent(shopOffCaptured).toLowerCase().includes('not enabled'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The shop master switch is independent: with economy_enabled off, /shop returns the disabled reply.',
    observation: `economy-off /shop reply="${truncate(replyContent(shopOffCaptured))}".`,
    impact: 'The shop economy master switch did not gate /shop.',
  });

  const buyTxn = await txns(handle, userA, 'shop_buy');
  const sellTxn = await txns(handle, userA, 'shop_sell');
  ctx.expect(buyTxn.length === 1 && sellTxn.length === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Shop actions under the market-off config still record their ledger rows.',
    observation: `shop_buy=${buyTxn.length}, shop_sell=${sellTxn.length}.`,
    impact: 'A shop action under market-off did not record its ledger row.',
  });

  proveBranding(ctx, buyCaptured, econ);
  await proveAnonDenied(ctx, handle, 'economy_wallets', await walletServiceCount(handle, userA), 'wallet row');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  gateMarketAudit(ctx);
}

/** INVALID — anti-laundering wall + a rejected invalid config never persists. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: true, economy_market_fee_pct: 5 },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  // Arrange a commerce-granted, NON-tradeable item the member holds — the exact
  // item the anti-laundering wall must bar from the player market.
  const commerceItemId = await seedItem(handle, {
    name: `${ctx.runPrefix}commerce-skin`,
    price: 0,
    sellPrice: 0,
    tradeable: false,
    category: 'Cosmetics',
  });
  if (commerceItemId) {
    await handle.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: handle.guildId,
      p_user_id: userA,
      p_item_id: commerceItemId,
      p_quantity: 1,
    });
  }
  const heldBefore = commerceItemId ? await inventoryQty(handle, userA, commerceItemId) : 0;
  ctx.expect(commerceItemId !== null && heldBefore === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: the member holds a commerce-granted, non-tradeable item.',
    observation: `non-tradeable item id=${commerceItemId ?? '(null)'}, held qty=${heldBefore}.`,
    impact: 'Could not arrange the non-tradeable commerce item — the anti-laundering proof setup is invalid.',
  });

  // A rejected invalid config never persists: guild_config keeps its VALID fee=5
  // byte-for-byte (validation lives in the dashboard Zod layer; guild_config has
  // no negative-fee CHECK, so the reject path is not reachable in a bot-only run).
  const cfg = await guildConfig(handle);
  ctx.expect(cfg?.economy_market_fee_pct === 5, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid market fee (a rejected negative-fee save never persists).',
    observation: `guild_config.economy_market_fee_pct=${String(cfg?.economy_market_fee_pct)} (expected 5).`,
    impact: 'A valid market configuration was not retained.',
  });

  // Behavior unchanged on the next command: /shop still renders normally.
  const shopCaptured = await ctx.runSlash(handle, { commandName: 'shop', userId: userA });
  ctx.expect(Boolean(replyEmbedData(shopCaptured)) || replyContent(shopCaptured).length > 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged after a rejected config attempt: /shop still responds.',
    observation: `/shop ${replyEmbedData(shopCaptured) ? 'rendered its embed' : `replied "${truncate(replyContent(shopCaptured))}"`}.`,
    impact: 'A rejected config attempt disturbed live bot behavior.',
  });

  // The anti-laundering wall, driven live: a /market list on the commerce-granted,
  // NON-tradeable item is refused (MarketManager.listItem rejects tradeable=false
  // before any decrement, and economy_market_atomic_create_listing re-checks as
  // defense-in-depth), the item stays in inventory, and no listing row is created.
  const listRejectCap = await ctx.runSlash(handle, {
    commandName: 'market',
    userId: userA,
    subcommand: 'list',
    options: { item: `${ctx.runPrefix}commerce-skin`, quantity: 1, price: 100 },
  });
  const heldAfter = commerceItemId ? await inventoryQty(handle, userA, commerceItemId) : -1;
  const rejectDesc = lastEmbedDescription(listRejectCap);
  const listingsAfter = await listingCount(handle);
  ctx.expect(
    rejectDesc.toLowerCase().includes('cannot be traded') && heldAfter === 1 && listingsAfter === 0,
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise:
        'A /market list on a commerce-granted, non-tradeable item is refused (branded), the item stays in inventory, and no listing row is created.',
      observation:
        `/market list reply="${truncate(rejectDesc)}" (expected a "cannot be traded" refusal), ` +
        `item held after=${heldAfter} (expected 1 unchanged), market listings=${listingsAfter} (expected 0).`,
      impact: 'The anti-laundering wall did not refuse a non-tradeable item, or the refusal moved/listed the item.',
    },
  );

  // The blocked listing writes NO economy_transactions ledger row (rejected before
  // any RPC/eventBus emit) — the DB-observable half of "no listing/config-change row"
  // is proven above (listingsAfter === 0). The anonymized audit_logs correlation-id
  // row + the dashboard rejected-config lane remain a genuine residual.
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the blocked commerce-item listing and the rejected market config with their reasons; no listing row and no config-change audit row is written.',
    "the no-listing-row half is proven live (listingCount stays 0); the anonymized audit_logs correlation-id row is AuditService's 5s-buffered flush and the rejected-config audit is a dashboard-lane row — neither is synchronously observable here",
  );

  proveBranding(ctx, shopCaptured, econ);
  await proveAnonDenied(ctx, handle, 'economy_items', await itemCount(handle), 'shop item');
  await proveAnonDenied(ctx, handle, 'economy_inventory', await inventoryRowCount(handle, userA), 'inventory row');
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — a member cannot cancel another's listing, convert a commerce grant, or save as non-admin. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: true },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');

  // Arrange member-A's active listing (the row member-B must NOT be able to cancel).
  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}blade`, price: 100, sellPrice: 40 });
  const listingId = itemId ? await seedListing(handle, userA, itemId, `${ctx.runPrefix}blade`, 3, 100) : null;
  const listingBefore = listingId ? await readListing(handle, listingId) : null;
  ctx.expect(listingBefore?.seller_id === userA && listingBefore?.status === 'active' && listingBefore?.remaining === 3, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: "Test arrangement: member-A owns an active listing keyed to A's seller id.",
    observation: `listing seller=${listingBefore?.seller_id} (expected ${userA}), status=${listingBefore?.status}, remaining=${listingBefore?.remaining}.`,
    impact: "Could not arrange member-A's listing — the authorization proof setup is invalid.",
  });

  // Driven live: member-B's /market cancel against member-A's listing is refused
  // (the bot resolves the listing under `seller_id = invoker`, so B never matches
  // A's row) and A's listing is byte-identical afterward.
  const userB = ctx.userId('b');
  const cancelCap = await ctx.runSlash(handle, {
    commandName: 'market',
    userId: userB,
    subcommand: 'cancel',
    options: { listing: (listingId ?? '').slice(0, 8) },
  });
  const listingAfterCancel = listingId ? await readListing(handle, listingId) : null;
  const cancelDesc = lastEmbedDescription(cancelCap);
  ctx.expect(
    cancelDesc.toLowerCase().includes('not found') &&
      listingAfterCancel?.seller_id === userA &&
      listingAfterCancel?.status === 'active' &&
      listingAfterCancel?.remaining === 3,
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: "member-B's /market cancel against member-A's listing is refused and A's listing is byte-identical afterward.",
      observation:
        `/market cancel (by B) reply="${truncate(cancelDesc)}" (expected "not found"); ` +
        `A's listing after: seller=${listingAfterCancel?.seller_id}/status=${listingAfterCancel?.status}/remaining=${listingAfterCancel?.remaining} ` +
        `(expected ${userA}/active/3).`,
      impact: "A member-B cancel mutated or ended member-A's listing — cross-member authorization on cancel is broken.",
    },
  );

  // Driven live: a member holding a commerce-granted (non-tradeable) item is refused
  // (branded) when trying to /market list it, and it never reaches the market.
  const boundItemId = await seedItem(handle, {
    name: `${ctx.runPrefix}bound-relic`,
    price: 0,
    sellPrice: 0,
    tradeable: false,
    category: 'Cosmetics',
  });
  if (boundItemId) await giveInventory(handle, userA, boundItemId, 1);
  const boundListCap = await ctx.runSlash(handle, {
    commandName: 'market',
    userId: userA,
    subcommand: 'list',
    options: { item: `${ctx.runPrefix}bound-relic`, quantity: 1, price: 100 },
  });
  const boundHeldAfter = boundItemId ? await inventoryQty(handle, userA, boundItemId) : -1;
  const boundListings = boundItemId ? await sellerItemListingCount(handle, userA, boundItemId) : -1;
  const boundDesc = lastEmbedDescription(boundListCap);
  ctx.expect(
    boundDesc.toLowerCase().includes('cannot be traded') && boundHeldAfter === 1 && boundListings === 0,
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A member holding a commerce-granted (non-tradeable) item is refused (branded) when trying to /market list it.',
      observation:
        `/market list (non-tradeable) reply="${truncate(boundDesc)}" (expected "cannot be traded"); ` +
        `item held after=${boundHeldAfter} (expected 1), listings for it=${boundListings} (expected 0).`,
      impact: 'A commerce-granted non-tradeable item could be listed on the player market — the anti-laundering wall is not enforced.',
    },
  );

  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save shop or market settings (authorization error).',
    'requires the dashboard session-auth lane (RBAC) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'An audit row records the denied cancel, the blocked commerce-item listing, and the denied config save, each with reason permission-denied.',
    "the denied cancel + blocked-listing paths return early (no economy_transactions row); the anonymized audit_logs correlation-id row is AuditService's 5s-buffered flush and the denied-config audit is a dashboard-lane row — none synchronously observable here",
  );

  // RLS is the DB-observable spine of this scenario: A's listing is service-role
  // visible yet an anon client reads zero of it.
  await proveAnonDenied(ctx, handle, 'economy_market_listings', await listingCount(handle), "member's market listing");

  // Drive /shop for a real branded surface (member-facing, in scope).
  const shopCaptured = await ctx.runSlash(handle, { commandName: 'shop', userId: userA });
  proveBranding(ctx, shopCaptured, econ);
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /shop, /buy and /market reply with the branded market-unavailable message and no coins or items move.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'After restoration a fresh /buy debits exactly once and delivers the item.',
    'requires the outage fault lane to reach the degraded → restored transition',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate debit or delivery survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded market-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the market-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Shop/market rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a market purchase whose seller-payout/delivery step fails converges safely. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The refund/claw-back branch triggers only when the seller credit or buyer
  // inventory-delivery step FAILS mid-purchase. The /market buy path is now fully
  // drivable via ctx.runSlash (see SET-A / REPLAY / RACE), but economy_market_settle_buy
  // settles the whole purchase in ONE atomic transaction, so its partial-failure /
  // refund branch cannot be reached without a mid-RPC fault-injection lane. GATE the
  // fault-dependent proof honestly; never fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'After the injected payout fault, the buyer is refunded once and the listing remaining is restored; a clean retry buys exactly once (one debit, one net-of-fee seller credit, one item).',
    'requires a mid-purchase fault-injection lane inside the atomic economy_market_settle_buy transaction to reach the refund/claw-back branch (the /market buy command itself is drivable)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The refund and the subsequent successful purchase each apply under their own idempotency key (debit, refund, debit — never a double).',
    'requires the mid-settle fault-injection lane to reach the refund branch (idempotency of the clean /market buy is proven directly in SET-A / REPLAY)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The ledger shows the buyer debit, the refund, then the successful purchase — never a double debit or double seller payout.',
    'requires the mid-settle fault-injection lane to produce the refund ledger row',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The buyer sees the branded purchase-refunded confirmation.',
    'requires the mid-settle fault-injection lane to reach the refund branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The refund touches only the buyer’s guild-scoped wallet.',
    'requires the mid-settle fault-injection lane to reach the refund branch',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'No spurious owner alert is raised for a self-healing refund.',
    'requires the mid-/market-buy fault-injection lane plus owner alert channel readback',
  );
}

/** REPLAY — re-delivering a shop /buy double-charges (idempotency gap, FAIL finding);
 *  a re-delivered /market buy is idempotent (driven live in a market-enabled sibling guild). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const price = 200;

  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}potion`, price, sellPrice: 50 });
  await seedWallet(handle, userA, 1000, 0);

  // Re-deliver the SAME shop /buy interaction id twice. The catalog contracts
  // exactly-one-purchase on replay; the bot's shop /buy path (EconomyManager.buyItem)
  // carries NO idempotency key, so a re-delivery applies TWICE — an observed
  // divergence recorded as a FAIL finding (never softened to a pass).
  const buyId = `${ctx.runPrefix}shop-buy-int`;
  const buyOpts = { item: `${ctx.runPrefix}potion`, quantity: 1 };
  const first = await ctx.runSlash(handle, { commandName: 'buy', userId: userA, options: buyOpts, interactionId: buyId });
  await ctx.runSlash(handle, { commandName: 'buy', userId: userA, options: buyOpts, interactionId: buyId });
  const afterReplay = await readWallet(handle, userA);
  const owned = itemId ? await inventoryQty(handle, userA, itemId) : 0;
  const buyTxn = await txns(handle, userA, 'shop_buy');
  ctx.expect(afterReplay?.wallet === 1000 - price && owned === 1 && buyTxn.length === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering a shop /buy interaction leaves exactly one purchase (one debit, one item, one ledger row).',
    observation:
      `after TWO deliveries of one /buy interaction id: wallet=${afterReplay?.wallet} (exactly-once expects ${1000 - price}), ` +
      `inventory qty=${owned} (expects 1), shop_buy ledger rows=${buyTxn.length} (expects 1).`,
    impact:
      'A re-delivered identical shop /buy double-charged and double-delivered — EconomyManager.buyItem has no persisted idempotency key on the interaction id (a money-path idempotency gap).',
  });

  // The market-buy replay leg, driven live in a market-enabled sibling guild.
  // economy_market_settle_buy is keyed on the interaction id (request_id anchored to
  // the buyer's market_buy ledger row), so a re-delivered /market buy is a proven
  // no-op — unlike the shop /buy above, which has the idempotency gap.
  const mkt = await ctx.bootGuild({
    label: 'm',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: true, economy_market_fee_pct: 10 },
  });
  const mSeller = ctx.userId('mseller');
  const mBuyer = ctx.userId('mbuyer');
  const mItemId = await seedItem(mkt, { name: `${ctx.runPrefix}mkt-potion`, price: 0, sellPrice: 0, tradeable: true });
  const mListingId = mItemId ? await seedListing(mkt, mSeller, mItemId, `${ctx.runPrefix}mkt-potion`, 2, 100) : null;
  await seedWallet(mkt, mSeller, 0, 0);
  await seedWallet(mkt, mBuyer, 1000, 0);

  const mktBuyId = `${ctx.runPrefix}mkt-buy-int`;
  const mktBuyOpts = { listing: (mListingId ?? '').slice(0, 8), quantity: 1 };
  await ctx.runSlash(mkt, { commandName: 'market', userId: mBuyer, subcommand: 'buy', options: mktBuyOpts, interactionId: mktBuyId });
  await ctx.runSlash(mkt, { commandName: 'market', userId: mBuyer, subcommand: 'buy', options: mktBuyOpts, interactionId: mktBuyId });
  const mBuyerWallet = await readWallet(mkt, mBuyer);
  const mSellerWallet = await readWallet(mkt, mSeller);
  const mListingAfter = mListingId ? await readListing(mkt, mListingId) : null;
  const mBuyerOwned = mItemId ? await inventoryQty(mkt, mBuyer, mItemId) : 0;
  const mBuyTxn = await txns(mkt, mBuyer, 'market_buy');
  const mSaleTxn = await txns(mkt, mSeller, 'market_sale');
  // total = 100, fee = floor(100 * 10%) = 10, seller earns 90.
  ctx.expect(
    mBuyerWallet?.wallet === 900 &&
      mSellerWallet?.wallet === 90 &&
      mListingAfter?.remaining === 1 &&
      mBuyerOwned === 1 &&
      mBuyTxn.length === 1 &&
      mSaleTxn.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Re-delivering a /market buy leaves exactly one market sale (one buyer debit, one net-of-fee seller credit, one listing decrement, one delivery).',
      observation:
        `after TWO deliveries of one /market buy interaction id: buyer wallet=${mBuyerWallet?.wallet} (expects 900), ` +
        `seller wallet=${mSellerWallet?.wallet} (expects 90), listing remaining=${mListingAfter?.remaining} (expects 1), ` +
        `buyer inventory=${mBuyerOwned} (expects 1), market_buy rows=${mBuyTxn.length}/market_sale rows=${mSaleTxn.length} (expects 1/1).`,
      impact: 'A re-delivered /market buy double-settled — the request-id idempotency key on economy_market_settle_buy did not hold.',
    },
  );
  ctx.expect(mBuyTxn.length === 1 && mSaleTxn.length === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A replayed market buy writes exactly one set of ledger effects (one market_buy, one market_sale).',
    observation: `after the replay: market_buy rows=${mBuyTxn.length}, market_sale rows=${mSaleTxn.length} (expected 1/1).`,
    impact: 'A replayed market buy wrote duplicate ledger rows — the idempotent settle did not dedupe.',
  });

  proveBranding(ctx, first, econ);
  await proveAnonDenied(ctx, handle, 'economy_wallets', await walletServiceCount(handle, userA), 'wallet row');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
}

/** RESTART — shop + market state survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const price = 250;

  // Boot #1: seed shop item + wallet + an escrowed market listing, buy once, snapshot.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
  });
  const itemId = await seedItem(first, { name: `${ctx.runPrefix}amulet`, price, sellPrice: 80 });
  await seedWallet(first, userA, 1000, 0);
  const listingId = itemId ? await seedListing(first, userA, itemId, `${ctx.runPrefix}amulet`, 2, 500) : null;
  await ctx.runSlash(first, { commandName: 'buy', userId: userA, options: { item: `${ctx.runPrefix}amulet`, quantity: 1 } });
  const walletSnap = await readWallet(first, userA);
  const invSnap = itemId ? await inventoryQty(first, userA, itemId) : 0;
  const listingSnap = listingId ? await readListing(first, listingId) : null;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). All state lives in Supabase, so it persists.
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
  });
  const shopCaptured = await ctx.runSlash(second, { commandName: 'shop', userId: userA });
  const walletAfter = await readWallet(second, userA);
  const invAfter = itemId ? await inventoryQty(second, userA, itemId) : -1;
  ctx.expect(
    walletAfter?.wallet === walletSnap?.wallet && walletAfter?.wallet === 1000 - price && invAfter === invSnap && invAfter === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, wallet + inventory match the pre-restart snapshot exactly.',
      observation:
        `pre-restart wallet=${walletSnap?.wallet}/inv=${invSnap}; post-restart wallet=${walletAfter?.wallet}/inv=${invAfter} ` +
        `(expected ${1000 - price}/1).`,
      impact: 'Shop wallet/inventory state did not survive the restart.',
    },
  );
  ctx.expect(Boolean(replyEmbedData(shopCaptured)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /shop renders normally.',
    observation: `/shop ${replyEmbedData(shopCaptured) ? 'rendered its embed' : 'produced no embed'}.`,
    impact: 'Post-restart /shop failed to render.',
  });

  // Escrowed listing quantity + status persist across the restart (no double-settle
  // / double-expire): the seeded listing row is byte-identical after the reboot.
  const listingAfter = listingId ? await readListing(second, listingId) : null;
  ctx.expect(
    listingAfter?.status === listingSnap?.status && listingAfter?.remaining === listingSnap?.remaining && listingAfter?.remaining === 2,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Escrowed market listing quantity + status persist across the restart (no double-settle/expire).',
      observation:
        `pre-restart listing status=${listingSnap?.status}/remaining=${listingSnap?.remaining}; ` +
        `post-restart status=${listingAfter?.status}/remaining=${listingAfter?.remaining} (expected active/2).`,
      impact: 'A market listing did not survive the restart intact — a settle/expire fired across the reboot.',
    },
  );

  const buyTxn = await txns(second, userA, 'shop_buy');
  ctx.expect(buyTxn.length === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The pre-restart shop purchase ledger row persists across the restart.',
    observation: `shop_buy ledger rows after restart = ${buyTxn.length} (expected 1).`,
    impact: 'A ledger row did not survive the restart.',
  });

  proveBranding(ctx, shopCaptured, display(second));
  await proveAnonDenied(ctx, second, 'economy_market_listings', await listingCount(second), 'market listing');
  await proveNoOwnerAlert(ctx, second);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrent shop buys of the last unit settle exactly once (no oversell). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: true },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const price = 100;

  // One-unit stock; two DIFFERENT buyers race for it. economy_decrement_stock is
  // atomic (FOR UPDATE), so exactly one purchase completes and the other is refunded.
  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}lastone`, price, sellPrice: 30, stock: 1 });
  await seedWallet(handle, userA, 1000, 0);
  await seedWallet(handle, userB, 1000, 0);
  const [c1, c2] = await Promise.all([
    ctx.runSlash(handle, { commandName: 'buy', userId: userA, options: { item: `${ctx.runPrefix}lastone`, quantity: 1 } }),
    ctx.runSlash(handle, { commandName: 'buy', userId: userB, options: { item: `${ctx.runPrefix}lastone`, quantity: 1 } }),
  ]);
  const stockAfter = itemId ? (await readItem(handle, itemId))?.stock : null;
  const ownedA = itemId ? await inventoryQty(handle, userA, itemId) : 0;
  const ownedB = itemId ? await inventoryQty(handle, userB, itemId) : 0;
  const buyTxns = [...(await txns(handle, userA, 'shop_buy')), ...(await txns(handle, userB, 'shop_buy'))];
  ctx.expect(stockAfter === 0 && ownedA + ownedB === 1 && buyTxns.length === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous buys of a one-unit item settle exactly once (no oversell): final stock 0, one item delivered, one ledger row.',
    observation:
      `final stock=${String(stockAfter)} (expected 0); items delivered A=${ownedA}+B=${ownedB} (expected sum 1); ` +
      `shop_buy ledger rows=${buyTxns.length} (expected 1).`,
    impact: 'A concurrent last-unit purchase oversold (stock decrement was not atomic) — coins/items were created from a race.',
  });
  ctx.expect(Boolean(replyEmbedData(c1) || replyContent(c1) || replyEmbedData(c2) || replyContent(c2)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Both concurrent /buy calls reply (one purchase-complete, one sold-out refusal).',
    observation: 'at least one concurrent /buy produced a reply surface.',
    impact: 'A concurrent /buy produced no reply.',
  });

  // ── Concurrent /market buy of a listing's last unit settles exactly once ──
  // A one-unit listing; two DIFFERENT buyers race. economy_market_settle_buy locks
  // the listing FOR UPDATE, so exactly one buyer wins and the other sees "unavailable".
  const mSeller = ctx.userId('mseller');
  const mBuyer1 = ctx.userId('mb1');
  const mBuyer2 = ctx.userId('mb2');
  const lastItemId = await seedItem(handle, { name: `${ctx.runPrefix}mlast`, price: 0, sellPrice: 0, tradeable: true });
  const lastListingId = lastItemId ? await seedListing(handle, mSeller, lastItemId, `${ctx.runPrefix}mlast`, 1, price) : null;
  await seedWallet(handle, mSeller, 0, 0);
  await seedWallet(handle, mBuyer1, 1000, 0);
  await seedWallet(handle, mBuyer2, 1000, 0);
  const [mc1, mc2] = await Promise.all([
    ctx.runSlash(handle, { commandName: 'market', userId: mBuyer1, subcommand: 'buy', options: { listing: (lastListingId ?? '').slice(0, 8), quantity: 1 } }),
    ctx.runSlash(handle, { commandName: 'market', userId: mBuyer2, subcommand: 'buy', options: { listing: (lastListingId ?? '').slice(0, 8), quantity: 1 } }),
  ]);
  const lastListingAfter = lastListingId ? await readListing(handle, lastListingId) : null;
  const mOwned1 = lastItemId ? await inventoryQty(handle, mBuyer1, lastItemId) : 0;
  const mOwned2 = lastItemId ? await inventoryQty(handle, mBuyer2, lastItemId) : 0;
  const mSaleTxns = await txns(handle, mSeller, 'market_sale');
  ctx.expect(
    lastListingAfter?.remaining === 0 &&
      lastListingAfter?.status === 'sold' &&
      mOwned1 + mOwned2 === 1 &&
      mSaleTxns.length === 1 &&
      Boolean(lastEmbedDescription(mc1) || lastEmbedDescription(mc2)),
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: "Two simultaneous /market buy of a listing's last unit settle exactly once (no oversell): the listing empties to sold, one buyer receives the item, one market_sale row.",
      observation:
        `listing remaining=${lastListingAfter?.remaining}/status=${lastListingAfter?.status} (expected 0/sold); ` +
        `items delivered B1=${mOwned1}+B2=${mOwned2} (expected sum 1); market_sale rows=${mSaleTxns.length} (expected 1).`,
      impact: 'A concurrent last-unit /market buy oversold — the FOR UPDATE listing lock did not serialize the race.',
    },
  );

  // ── Two simultaneous /market list of one stack cannot oversell ──
  // The seller holds ONE unit; two concurrent /market list of quantity 1 race.
  // economy_market_atomic_create_listing locks the inventory row FOR UPDATE, so only
  // one listing is created and the loser sees insufficient inventory.
  const stackSeller = ctx.userId('stackseller');
  const stackItemId = await seedItem(handle, { name: `${ctx.runPrefix}mstack`, price: 0, sellPrice: 0, tradeable: true });
  if (stackItemId) await giveInventory(handle, stackSeller, stackItemId, 1);
  await Promise.all([
    ctx.runSlash(handle, { commandName: 'market', userId: stackSeller, subcommand: 'list', options: { item: `${ctx.runPrefix}mstack`, quantity: 1, price } }),
    ctx.runSlash(handle, { commandName: 'market', userId: stackSeller, subcommand: 'list', options: { item: `${ctx.runPrefix}mstack`, quantity: 1, price } }),
  ]);
  const stackListings = stackItemId ? await sellerItemListingCount(handle, stackSeller, stackItemId) : -1;
  const stackInv = stackItemId ? await inventoryQty(handle, stackSeller, stackItemId) : -1;
  ctx.expect(stackListings === 1 && stackInv === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two simultaneous /market list of a one-unit stack create exactly one listing (no oversell of escrowed items).',
    observation: `active listings for the stack=${stackListings} (expected 1); seller inventory after=${stackInv} (expected 0).`,
    impact: 'A concurrent double-list escrowed the same unit twice — the FOR UPDATE inventory lock did not serialize the listings.',
  });

  gateMarketAudit(ctx);

  proveBranding(ctx, replyContent(c1) || replyEmbedData(c1) ? c1 : c2, econ);
  await proveAnonDenied(ctx, handle, 'economy_items', await itemCount(handle), 'shop item');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
}

/** XGUILD — shop + market are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0, currencyName: 'Doubloons', currencyEmoji: '🔶', guildConfigOverrides: { economy_market_enabled: true } });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0, currencyName: 'Doubloons', currencyEmoji: '🔶', guildConfigOverrides: { economy_market_enabled: true } });

  // Guild A: seed item + wallet + a listing, snapshot. Guild B: independent item + wallet.
  const itemA = await seedItem(handleA, { name: `${ctx.runPrefix}aitem`, price: 100, sellPrice: 40 });
  await seedWallet(handleA, userA, 700, 0);
  if (itemA) await seedListing(handleA, userA, itemA, `${ctx.runPrefix}aitem`, 2, 250);
  const walletASnap = await readWallet(handleA, userA);

  const itemB = await seedItem(handleB, { name: `${ctx.runPrefix}bitem`, price: 150, sellPrice: 50 });
  await seedWallet(handleB, userA, 1000, 0);

  // Same member buys in guild B — guild A's wallet/inventory must be untouched.
  await ctx.runSlash(handleB, { commandName: 'buy', userId: userA, options: { item: `${ctx.runPrefix}bitem`, quantity: 1 } });
  const walletAAfter = await readWallet(handleA, userA);
  const walletBAfter = await readWallet(handleB, userA);
  const ownedAInB = itemB ? await inventoryQty(handleB, userA, itemB) : 0;
  const ownedAInA = itemA ? await inventoryQty(handleA, userA, itemA) : 0;
  ctx.expect(
    walletAAfter?.wallet === walletASnap?.wallet && walletAAfter?.wallet === 700 && walletBAfter?.wallet === 1000 - 150 && ownedAInB === 1 && ownedAInA === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: "Buying in a second guild never touches the first guild's wallet or inventory; each guild's economy evolves independently.",
      observation:
        `guild A wallet=${walletAAfter?.wallet} (unchanged at 700), A-inventory-in-A=${ownedAInA} (expected 0); ` +
        `guild B wallet=${walletBAfter?.wallet} (expected ${1000 - 150}), item-in-B=${ownedAInB} (expected 1).`,
      impact: "Cross-guild activity mutated another guild's wallet/inventory — per-guild isolation broken.",
    },
  );

  // Per-guild LEDGER scoping: guild B's purchase wrote a shop_buy row under B; A has none.
  const txnsInA = await txns(handleA, userA, 'shop_buy');
  const txnsInB = await txns(handleB, userA, 'shop_buy');
  ctx.expect(txnsInB.length === 1 && txnsInA.length === 0, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: "Each guild keeps its own ledger: guild B's purchase row does not appear under guild A.",
    observation: `shop_buy ledger rows: guild B=${txnsInB.length} (expected 1), guild A=${txnsInA.length} (expected 0).`,
    impact: 'A shop ledger row crossed guilds — per-guild ledger scoping broken.',
  });

  // Each guild scope reads its OWN market listing / item rows and never the other's.
  const { data: aListings } = await handleA.supabase
    .from('economy_market_listings')
    .select('id, seller_id, guild_id')
    .eq('guild_id', guildA);
  const { data: bListings } = await handleB.supabase
    .from('economy_market_listings')
    .select('id, seller_id, guild_id')
    .eq('guild_id', guildB);
  const aRows = (aListings as Array<{ guild_id: string }> | null) ?? [];
  const bRows = (bListings as Array<{ guild_id: string }> | null) ?? [];
  ctx.expect(aRows.length === 1 && aRows.every((r) => r.guild_id === guildA) && bRows.length === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: "A guild-B scope reads zero of guild A's listings and vice versa (distinct guild_id partitions).",
    observation: `guild-A-scoped listings=${aRows.length} (all under A=${aRows.every((r) => r.guild_id === guildA)}); guild-B-scoped listings=${bRows.length}.`,
    impact: 'A guild-scoped read returned another guild’s market listing — cross-guild leakage.',
  });
  await proveAnonDenied(ctx, handleA, 'economy_market_listings', aRows.length, 'market listing');

  const shopB = await ctx.runSlash(handleB, { commandName: 'shop', userId: userA });
  proveBranding(ctx, shopB, display(handleB));
  await proveNoOwnerAlert(ctx, handleA);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    currencyName: 'Doubloons',
    currencyEmoji: '🔶',
    guildConfigOverrides: { economy_market_enabled: true },
  });
  const userA = ctx.userId('a');
  const price = 120;

  // Create run-prefixed shop rows (item, wallet, inventory, ledger) + a market listing.
  const itemId = await seedItem(handle, { name: `${ctx.runPrefix}trinket`, price, sellPrice: 40 });
  await seedWallet(handle, userA, 500, 0);
  const cleanupBuy = await ctx.runSlash(handle, { commandName: 'buy', userId: userA, options: { item: `${ctx.runPrefix}trinket`, quantity: 1 } });
  if (itemId) await seedListing(handle, userA, itemId, `${ctx.runPrefix}trinket`, 1, 300);

  const itemsBefore = await itemCount(handle);
  const invBefore = await inventoryRowCount(handle, userA);
  const listingsBefore = await listingCount(handle);
  const txnsBefore = (await txns(handle, userA)).length;
  ctx.expect(itemsBefore >= 1 && invBefore >= 1 && listingsBefore >= 1 && txnsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed shop item, inventory, listing and ledger rows (pre-cleanup baseline).',
    observation: `pre-cleanup: items=${itemsBefore}, inventory=${invBefore}, listings=${listingsBefore}, transactions=${txnsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveAnonDenied(ctx, handle, 'economy_market_listings', listingsBefore, 'market listing');
  await proveAnonDenied(ctx, handle, 'economy_wallets', await walletServiceCount(handle, userA), 'wallet row');
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, cleanupBuy, display(handle));

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const itemsAfter = await itemCount(handle);
  const invAfter = await inventoryRowCount(handle, userA);
  const listingsAfter = await listingCount(handle);
  const txnsAfter = (await txns(handle, userA)).length;
  ctx.expect(itemsAfter === 0 && invAfter === 0 && listingsAfter === 0 && txnsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed shop items, inventory, listings and ledger rows are deleted; a final sweep finds zero run-prefixed shop/market resources.',
    observation: `post-sweep: items=${itemsAfter}, inventory=${invAfter}, listings=${listingsAfter}, transactions=${txnsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed embeds, and the audit_logs "anonymized-not-
  // deleted" history, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed shop items, market listings, or purchase/sale embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (the economy operational ledger is the DB-observable evidence here)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── local helper used by several scenarios ─────────────────────────────────

/** Service-role visible wallet-row count for a user (the positive control for the
 *  economy_wallets anon-denial probe: >0 means "there was really a row to hide"). */
async function walletServiceCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The shop-&-market domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before their parents/guild),
 * plus the 12 scenario scripts.
 */
export const gameEconomyShopMarketProof: DomainProof = {
  domainId: 'game-economy-shop-market',
  guildScopedTables: [
    // child → parent: listings + inventory reference economy_items (ON DELETE
    // CASCADE); economy_items is deleted after them.
    'economy_market_listings',
    'economy_inventory',
    'economy_transactions',
    'economy_wallets',
    'economy_items',
    'bot_action_queue',
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
