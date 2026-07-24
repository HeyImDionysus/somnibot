/**
 * MarketManager — peer-to-peer item trading with listings.
 *
 * Players list items for sale, others browse and buy.
 * Market fee (configurable %) acts as a currency sink.
 *
 * IMPORTANT: This is the FAKE economy (virtual market).
 */

import { type Guild, EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus } from '../../services/event-bus.js';
import { resolveBrandKit } from '../branding/brand-kit.js';

const log = createLogger('Market');

/**
 * V5 Audit §4.P3a — Hard cap on price_per_unit to prevent absurd listings.
 * 1 billion coins is well above any realistic wallet limit while staying
 * within safe integer range for JS (Number.MAX_SAFE_INTEGER ≈ 9e15).
 */
const MAX_PRICE_PER_UNIT = 1_000_000_000;

// ── Local Types ───────────────────────────────────────────

interface MarketConfig {
  economy_market_enabled: boolean;
  economy_market_fee_pct: number;
  economy_market_listing_days: number;
  economy_market_max_listings: number;
}

interface MarketListing {
  id: string;
  seller_id: string;
  item_id: string;
  item_name: string;
  quantity: number;
  remaining: number;
  price_per_unit: number;
  status: string;
  expires_at: string;
  created_at: string;
}

// ── Manager ───────────────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, MarketManager>();

export function registerMarketManager(mgr: MarketManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterMarketManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateMarketCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateCache();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateCache();
  }
}

export class MarketManager {
  private guild: Guild;
  private supabase: SupabaseClient;
  private valkey: Valkey;
  private configCache: MarketConfig | null = null;

  constructor(guild: Guild, supabase: SupabaseClient, valkey: Valkey) {
    this.guild = guild;
    this.supabase = supabase;
    this.valkey = valkey;
  }

  invalidateCache(): void {
    this.configCache = null;
  }

  /**
   * Read the market config (cached). `degraded` is true only when the read
   * FAILED (e.g. a database outage) — never cached, so a transient blip cannot
   * poison the manager into permanently replying "the market is not enabled"
   * (a data-shaped lie about config state the bot could not read). PGRST116
   * (no config row) is the genuine market-off default and IS cacheable.
   */
  private async getConfig(): Promise<{ config: MarketConfig; degraded: boolean }> {
    if (this.configCache) return { config: this.configCache, degraded: false };
    const { data, error } = await this.supabase
      .from('guild_config')
      .select('economy_market_enabled, economy_market_fee_pct, economy_market_listing_days, economy_market_max_listings')
      .eq('guild_id', this.guild.id)
      .single();
    const fallback: MarketConfig = {
      economy_market_enabled: false,
      economy_market_fee_pct: 5,
      economy_market_listing_days: 7,
      economy_market_max_listings: 10,
    };
    const degraded = error != null && error.code !== 'PGRST116';
    if (!degraded) this.configCache = data ?? fallback;
    return { config: data ?? fallback, degraded };
  }

  /**
   * [game-economy-shop-market DEPFAIL] Branded degradation embed for a
   * dependency outage. The brand lookup is itself outage-safe (resolveBrandKit
   * never throws; belt-and-braces .catch) with the guild name as the fallback.
   */
  private async unavailableEmbed(suffix = ''): Promise<EmbedBuilder> {
    const brandKit = await resolveBrandKit(this.supabase, this.guild.id, {
      fallbackName: this.guild.name,
    }).catch(() => null);
    const name = brandKit?.brandName ?? this.guild.name ?? 'this server';
    return new EmbedBuilder()
      .setDescription(`⚠️ ${name}'s market is temporarily unavailable — please try again in a moment.${suffix}`)
      .setColor(0xff9800);
  }

  // ── List Item ─────────────────────────────────────────

  async listItem(
    userId: string,
    itemName: string,
    quantity: number,
    pricePerUnit: number,
  ): Promise<EmbedBuilder> {
    const { config, degraded } = await this.getConfig();
    // A failed config read is an outage, not "the market is off" — degrade honestly.
    if (degraded) {
      return this.unavailableEmbed(' Nothing was listed or charged.');
    }
    if (!config.economy_market_enabled) {
      return new EmbedBuilder().setDescription('🚫 The market is not enabled.').setColor(0xff0000);
    }

    // V5 Audit §4.P3a: Reject absurd prices
    if (pricePerUnit > MAX_PRICE_PER_UNIT) {
      return new EmbedBuilder()
        .setDescription(`❌ Maximum price per unit is **${MAX_PRICE_PER_UNIT.toLocaleString()}** coins.`)
        .setColor(0xff0000);
    }

    // Check active listings count
    const { count } = await this.supabase
      .from('economy_market_listings')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id)
      .eq('seller_id', userId)
      .eq('status', 'active');

    if ((count ?? 0) >= config.economy_market_max_listings) {
      return new EmbedBuilder()
        .setDescription(`📋 You already have **${config.economy_market_max_listings}** active listings (max).`)
        .setColor(0xffaa00);
    }

    // Check inventory
    const { data: inv } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity, item_id, economy_items!inner(name, id, tradeable)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .ilike('economy_items.name', itemName)
      .gt('quantity', 0)
      .limit(1);

    if (!inv || inv.length === 0) {
      return new EmbedBuilder()
        .setDescription(`❌ You don't have any **${itemName}** in your inventory.`)
        .setColor(0xff0000);
    }

    const raw = inv[0];
    const joinedItems = Array.isArray(raw.economy_items) ? raw.economy_items[0] : raw.economy_items;
    const invEntry = { item_id: raw.item_id as string, quantity: raw.quantity as number, economy_items: joinedItems as { id: string; name: string; tradeable: boolean } };

    // [game-economy-shop-market] Anti-laundering wall: non-tradeable items (e.g.
    // commerce-granted goods) must never reach the player market. Reject before
    // any inventory decrement; the RPC re-checks as defense-in-depth.
    if (invEntry.economy_items?.tradeable === false) {
      return new EmbedBuilder()
        .setDescription(`🚫 **${invEntry.economy_items.name}** cannot be traded on the player market.`)
        .setColor(0xff0000);
    }

    if (invEntry.quantity < quantity) {
      return new EmbedBuilder()
        .setDescription(`❌ You only have **${invEntry.quantity}x** ${itemName} (trying to list ${quantity}).`)
        .setColor(0xff0000);
    }

    // Verify+decrement inventory AND insert the listing in ONE row-locked
    // transaction. Replaces the old decrement→insert→refund dance where a
    // failed insert plus a failed refund destroyed the seller's items.
    const expiresAt = new Date(Date.now() + config.economy_market_listing_days * 24 * 60 * 60 * 1000).toISOString();

    const { data: created, error: createErr } = await this.supabase.rpc('economy_market_atomic_create_listing', {
      p_guild_id: this.guild.id,
      p_seller_id: userId,
      p_item_id: invEntry.item_id,
      p_quantity: quantity,
      p_price_per_unit: pricePerUnit,
      p_item_name: invEntry.economy_items.name,
      p_expires_at: expiresAt,
    });

    if (createErr) {
      // The transaction rolled back server-side — nothing was decremented.
      log.error('listItem atomic create failed:', createErr.message);
      return new EmbedBuilder()
        .setDescription('❌ Failed to create listing. Your items are still in your inventory.')
        .setColor(0xff0000);
    }

    const result = created as { error?: string; listing?: MarketListing } | null;
    if (result?.error === 'not_tradeable') {
      // [game-economy-shop-market] RPC defense-in-depth refused a non-tradeable item.
      return new EmbedBuilder()
        .setDescription(`🚫 **${invEntry.economy_items.name}** cannot be traded on the player market.`)
        .setColor(0xff0000);
    }
    if (!result?.listing) {
      // Typed 'insufficient_inventory' — a concurrent listing consumed the stack
      return new EmbedBuilder()
        .setDescription(`❌ You don't have enough **${itemName}** in your inventory.`)
        .setColor(0xff0000);
    }

    // [game-economy-shop-market] Append-only audit row for the listing state change.
    eventBus.emit('market.listed', this.guild.id, {
      sellerId: userId,
      listingId: result.listing.id,
      itemName: invEntry.economy_items.name,
      quantity,
      pricePerUnit,
    });

    return new EmbedBuilder()
      .setTitle('📦 Item Listed!')
      .setDescription(
        `**${invEntry.economy_items.name}** x${quantity}\n` +
        `💰 Price: **${pricePerUnit.toLocaleString()}** coins each\n` +
        `📅 Expires: <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>\n` +
        `💸 Market fee: **${config.economy_market_fee_pct}%** on sale`,
      )
      .setColor(0x4caf50);
  }

  // ── Browse ────────────────────────────────────────────

  async browse(opts?: string | {
    search?: string;
    sort?: 'price_asc' | 'price_desc' | 'newest' | 'name';
    minPrice?: number;
    maxPrice?: number;
    page?: number;
  }): Promise<EmbedBuilder> {
    // Backwards compat: accept plain string
    const options = typeof opts === 'string' ? { search: opts } : (opts ?? {});
    const { search: searchTerm, sort = 'price_asc', minPrice, maxPrice, page = 0 } = options;
    const PAGE_SIZE = 15;

    const { config, degraded } = await this.getConfig();
    // A failed config read is an outage, not "the market is off" — degrade honestly.
    if (degraded) {
      return this.unavailableEmbed();
    }
    if (!config.economy_market_enabled) {
      return new EmbedBuilder().setDescription('🚫 The market is not enabled.').setColor(0xff0000);
    }

    // V53 Phase 3 (3.5): Enhanced market search with filtering, sorting, pagination
    let query = this.supabase
      .from('economy_market_listings')
      .select('id, seller_id, item_name, remaining, price_per_unit, expires_at', { count: 'exact' })
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .gt('remaining', 0)
      .gt('expires_at', new Date().toISOString())
      .limit(1000);

    if (searchTerm) {
      // Escape ILIKE special chars to prevent wildcard injection
      const escaped = searchTerm.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.ilike('item_name', `%${escaped}%`);
    }

    if (minPrice !== undefined) {
      query = query.gte('price_per_unit', minPrice);
    }
    if (maxPrice !== undefined) {
      query = query.lte('price_per_unit', maxPrice);
    }

    // Sort
    switch (sort) {
      case 'price_desc':
        query = query.order('price_per_unit', { ascending: false });
        break;
      case 'newest':
        query = query.order('created_at', { ascending: false });
        break;
      case 'name':
        query = query.order('item_name', { ascending: true });
        break;
      case 'price_asc':
      default:
        query = query.order('price_per_unit', { ascending: true });
        break;
    }

    query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, count, error: browseErr } = await query;
    // A FAILED listings read is not "no active listings": that empty-state reply
    // is a data-shaped lie about listings the bot could not read. Degrade.
    if (browseErr) {
      return this.unavailableEmbed();
    }
    const listings = (data ?? []) as MarketListing[];
    const totalListings = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalListings / PAGE_SIZE));

    if (listings.length === 0) {
      return new EmbedBuilder()
        .setTitle('🏪 Player Market')
        .setDescription(searchTerm ? `No listings found for "${searchTerm}".` : 'No active listings right now.')
        .setColor(0x9e9e9e);
    }

    const lines = listings.map((l) => {
      const shortId = l.id.slice(0, 8);
      return `\`${shortId}\` **${l.item_name}** x${l.remaining} — 💰 ${l.price_per_unit.toLocaleString()}/ea • <@${l.seller_id}>`;
    });

    // Build filter summary
    const filters: string[] = [];
    if (searchTerm) filters.push(`🔍 "${searchTerm}"`);
    if (minPrice !== undefined) filters.push(`Min: 💰${minPrice.toLocaleString()}`);
    if (maxPrice !== undefined) filters.push(`Max: 💰${maxPrice.toLocaleString()}`);
    const filterLine = filters.length > 0 ? `*Filters: ${filters.join(' • ')}*\n\n` : '';

    return new EmbedBuilder()
      .setTitle('🏪 Player Market')
      .setDescription(`${filterLine}${lines.join('\n')}`)
      .setFooter({
        text: `Page ${page + 1}/${totalPages} • ${totalListings} listing${totalListings !== 1 ? 's' : ''} • /market buy <id> • ${config.economy_market_fee_pct}% fee`,
      })
      .setColor(0x2196f3);
  }

  // ── Buy ───────────────────────────────────────────────

  async buy(userId: string, listingIdPrefix: string, quantity: number = 1, requestId?: string): Promise<EmbedBuilder> {
    const { config, degraded } = await this.getConfig();
    // A failed config read is an outage, not "the market is off" — degrade
    // honestly and never press a settlement against an unreachable database.
    if (degraded) {
      return this.unavailableEmbed(' Nothing was charged.');
    }
    if (!config.economy_market_enabled) {
      return new EmbedBuilder().setDescription('🚫 The market is not enabled.').setColor(0xff0000);
    }

    // A redelivered /market buy must not settle twice — require the interaction id.
    if (!requestId) {
      log.error('MarketManager.buy called without a requestId (idempotency key)');
      return new EmbedBuilder().setDescription('❌ Could not process the purchase right now — please try again.').setColor(0xff0000);
    }

    // Find listing by ID prefix. Listing ids are uuids and the browse view shows a
    // short prefix, so resolve in JS: a Postgres uuid column has NO ILIKE operator,
    // so the old `.ilike('id', prefix%)` errored (42883 uuid ~~* unknown) → the
    // query returned null and a /market buy could NEVER find its listing.
    const { data: listings, error: listingsErr } = await this.supabase
      .from('economy_market_listings')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .gt('remaining', 0)
      .limit(1000);

    // A FAILED listings read is not "listing not found" — degrade honestly
    // before any settlement is attempted (nothing was charged).
    if (listingsErr) {
      return this.unavailableEmbed(' Nothing was charged.');
    }

    const prefix = listingIdPrefix.toLowerCase();
    const listing = (listings ?? []).find(
      (l) => String((l as MarketListing).id).toLowerCase().startsWith(prefix),
    ) as MarketListing | undefined;

    if (!listing) {
      return new EmbedBuilder()
        .setDescription('❌ Listing not found or no longer active.')
        .setColor(0xff0000);
    }

    if (listing.seller_id === userId) {
      return new EmbedBuilder()
        .setDescription("❌ You can't buy your own listing!")
        .setColor(0xff0000);
    }

    // Atomic + idempotent settlement keyed on the interaction id: decrement the
    // listing, debit the buyer, credit the seller net of fee, deliver inventory,
    // and write the ledger — all in ONE transaction. A redelivered /market buy is
    // a proven no-op (previously the four separate RPCs each double-applied).
    const { data, error } = await this.supabase.rpc('economy_market_settle_buy', {
      p_guild_id: this.guild.id,
      p_listing_id: listing.id,
      p_buyer_id: userId,
      p_quantity: quantity,
      p_fee_pct: config.economy_market_fee_pct,
      p_request_id: requestId,
    });

    if (error || !data || typeof data !== 'object') {
      log.error('economy_market_settle_buy failed', { detail: error?.message });
      return new EmbedBuilder()
        .setDescription('❌ Could not process the purchase right now — please try again.')
        .setColor(0xff0000);
    }

    const result = data as {
      status?: string; replayed?: boolean; item_name?: string; quantity?: number;
      requested_qty?: number; total_cost?: number; fee?: number;
    };

    switch (result.status) {
      case 'listing_unavailable':
        return new EmbedBuilder().setDescription('❌ This listing is no longer available.').setColor(0xff0000);
      case 'own_listing':
        return new EmbedBuilder().setDescription("❌ You can't buy your own listing!").setColor(0xff0000);
      case 'insufficient_funds':
        return new EmbedBuilder()
          .setDescription(`❌ You need **${(result.total_cost ?? 0).toLocaleString()}** coins but don't have enough.`)
          .setColor(0xff0000);
      case 'purchased':
        break;
      default:
        return new EmbedBuilder()
          .setDescription('❌ Could not process the purchase right now — please try again.')
          .setColor(0xff0000);
    }

    const buyQty = result.quantity ?? quantity;
    const totalCost = result.total_cost ?? 0;
    const fee = result.fee ?? 0;

    // Quest progress — only on a genuinely new (non-replayed) trade.
    if (!result.replayed) {
      getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'market_trade').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      // [game-economy-shop-market] Append-only audit row for the buy state change
      // (only a genuinely-new, non-replayed settlement moves money/inventory).
      eventBus.emit('market.bought', this.guild.id, {
        buyerId: userId,
        sellerId: listing.seller_id,
        listingId: listing.id,
        itemName: result.item_name ?? listing.item_name,
        quantity: buyQty,
        totalCost,
        fee,
      });
    }

    // V5 Audit §4.2: Inform user when fewer items were purchased than requested
    const qtyNote = buyQty < (result.requested_qty ?? quantity)
      ? `\n⚠️ Only **${buyQty}** of your requested **${quantity}** were available.`
      : '';

    return new EmbedBuilder()
      .setTitle('✅ Purchase Complete!')
      .setDescription(
        `Bought **${result.item_name ?? listing.item_name}** x${buyQty}\n` +
        `💰 Cost: **${totalCost.toLocaleString()}** coins\n` +
        `💸 Fee: **${fee.toLocaleString()}** coins (${config.economy_market_fee_pct}%)` +
        qtyNote,
      )
      .setColor(0x4caf50);
  }

  // ── My Listings ───────────────────────────────────────

  async myListings(userId: string): Promise<EmbedBuilder> {
    const { data, error: myErr } = await this.supabase
      .from('economy_market_listings')
      .select('id, item_name, remaining, price_per_unit, status, expires_at')
      .eq('guild_id', this.guild.id)
      .eq('seller_id', userId)
      .order('created_at', { ascending: false })
      .limit(15);

    // A FAILED read is not "you don't have any listings" — degrade honestly.
    if (myErr) {
      return this.unavailableEmbed();
    }

    const listings = (data ?? []) as MarketListing[];

    if (listings.length === 0) {
      return new EmbedBuilder()
        .setTitle('📋 My Listings')
        .setDescription("You don't have any listings.")
        .setColor(0x9e9e9e);
    }

    const lines = listings.map((l) => {
      const shortId = l.id.slice(0, 8);
      const statusEmoji = l.status === 'active' ? '🟢' : l.status === 'sold' ? '✅' : '❌';
      return `${statusEmoji} \`${shortId}\` **${l.item_name}** x${l.remaining} — 💰 ${l.price_per_unit.toLocaleString()}/ea`;
    });

    return new EmbedBuilder()
      .setTitle('📋 My Listings')
      .setDescription(lines.join('\n'))
      .setColor(0x2196f3);
  }

  // ── Cancel Listing ────────────────────────────────────

  async cancelListing(userId: string, listingIdPrefix: string): Promise<EmbedBuilder> {
    // V49-C3: Look up the listing ID first, then use atomic cancel RPC.
    // The RPC flips status to 'cancelled' only if still 'active', preventing
    // concurrent cancels from both returning items (duplication).
    // Resolve the short id prefix in JS, exactly like /market buy: a Postgres
    // uuid column has NO ILIKE operator, so the old `.ilike('id', prefix%)`
    // errored (42883 uuid ~~* unknown) and a member could NEVER cancel their
    // own listing — the failed query surfaced as "listing not found" and the
    // items stayed locked in the market. The seller_id + status filters stay in
    // SQL, so a member still only ever sees their OWN active listings here.
    const { data: listings, error: cancelReadErr } = await this.supabase
      .from('economy_market_listings')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('seller_id', userId)
      .eq('status', 'active')
      .limit(1000);

    // A FAILED read is not "listing not found" — degrade honestly.
    if (cancelReadErr) {
      return this.unavailableEmbed(' Your listing was not touched.');
    }

    const cancelPrefix = listingIdPrefix.toLowerCase();
    const match = (listings ?? []).find(
      (l) => String((l as { id: string }).id).toLowerCase().startsWith(cancelPrefix),
    ) as { id: string } | undefined;

    if (!match) {
      return new EmbedBuilder()
        .setDescription('❌ Listing not found or already ended.')
        .setColor(0xff0000);
    }

    const listingId = match.id;

    // Atomic cancel — returns the listing only if it was actually cancelled
    const { data: cancelled } = await this.supabase.rpc('economy_market_atomic_cancel', {
      p_listing_id: listingId,
      p_seller_id: userId,
    });

    if (!cancelled || !Array.isArray(cancelled) || cancelled.length === 0) {
      return new EmbedBuilder()
        .setDescription('❌ Listing not found or already ended.')
        .setColor(0xff0000);
    }

    const row = cancelled[0] as { id: string; item_id: string; item_name: string; remaining: number };

    // V53-C6: Return items — check upsert, surface error if it fails
    const { error: returnErr } = await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: row.item_id,
      p_quantity: row.remaining,
    });
    if (returnErr) {
      log.error('cancelListing inventory return failed:', returnErr.message);

      // V53-M4: Queue a reconciliation entry so the item return can be retried
      // automatically, rather than requiring manual admin intervention.
      await this.supabase.from('bot_action_queue').insert({
        guild_id: this.guild.id,
        action: 'market_item_reconcile',
        payload: {
          user_id: userId,
          item_id: row.item_id,
          item_name: row.item_name,
          quantity: row.remaining,
          listing_id: row.id,
          reason: 'cancel_listing_return_failed',
          original_error: returnErr.message,
        },
        status: 'pending',
      }).then(({ error }: { error: { message: string } | null }) => {
        if (error) log.error('Failed to queue reconciliation:', error.message);
      });

      return new EmbedBuilder()
        .setTitle('⚠️ Listing Cancelled — Item Return Queued')
        .setDescription(
          `Your listing was cancelled but **${row.item_name}** x${row.remaining} could not be returned immediately. It has been queued for automatic retry.`,
        )
        .setColor(0xff9800);
    }

    // [game-economy-shop-market] Append-only audit row for the cancel state change.
    eventBus.emit('market.cancelled', this.guild.id, {
      sellerId: userId,
      listingId: row.id,
      itemName: row.item_name,
      quantity: row.remaining,
    });

    return new EmbedBuilder()
      .setTitle('🗑️ Listing Cancelled')
      .setDescription(`**${row.item_name}** x${row.remaining} returned to your inventory.`)
      .setColor(0xff9800);
  }
}
