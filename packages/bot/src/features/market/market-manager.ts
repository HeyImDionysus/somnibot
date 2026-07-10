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

  private async getConfig(): Promise<MarketConfig> {
    if (this.configCache) return this.configCache;
    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_market_enabled, economy_market_fee_pct, economy_market_listing_days, economy_market_max_listings')
      .eq('guild_id', this.guild.id)
      .single();
    this.configCache = data ?? {
      economy_market_enabled: false,
      economy_market_fee_pct: 5,
      economy_market_listing_days: 7,
      economy_market_max_listings: 10,
    };
    return this.configCache!;
  }

  // ── List Item ─────────────────────────────────────────

  async listItem(
    userId: string,
    itemName: string,
    quantity: number,
    pricePerUnit: number,
  ): Promise<EmbedBuilder> {
    const config = await this.getConfig();
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
      .select('id, quantity, item_id, economy_items!inner(name, id)')
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
    const invEntry = { item_id: raw.item_id as string, quantity: raw.quantity as number, economy_items: joinedItems as { id: string; name: string } };
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
    if (!result?.listing) {
      // Typed 'insufficient_inventory' — a concurrent listing consumed the stack
      return new EmbedBuilder()
        .setDescription(`❌ You don't have enough **${itemName}** in your inventory.`)
        .setColor(0xff0000);
    }

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

    const config = await this.getConfig();
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

    const { data, count } = await query;
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

  async buy(userId: string, listingIdPrefix: string, quantity: number = 1): Promise<EmbedBuilder> {
    const config = await this.getConfig();
    if (!config.economy_market_enabled) {
      return new EmbedBuilder().setDescription('🚫 The market is not enabled.').setColor(0xff0000);
    }

    // Find listing by ID prefix
    const { data: listings } = await this.supabase
      .from('economy_market_listings')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .gt('remaining', 0)
      .ilike('id', `${listingIdPrefix}%`)
      .limit(1);

    if (!listings || listings.length === 0) {
      return new EmbedBuilder()
        .setDescription('❌ Listing not found or no longer active.')
        .setColor(0xff0000);
    }

    const listing = listings[0] as MarketListing;

    if (listing.seller_id === userId) {
      return new EmbedBuilder()
        .setDescription("❌ You can't buy your own listing!")
        .setColor(0xff0000);
    }

    // Atomically decrement listing remaining (prevents TOCTOU — concurrent buys can't oversell)
    const { data: actualBuyQty } = await this.supabase.rpc('economy_market_buy', {
      p_listing_id: listing.id,
      p_quantity: Math.min(quantity, listing.remaining),
    });

    if (!actualBuyQty || actualBuyQty <= 0) {
      return new EmbedBuilder()
        .setDescription('❌ This listing is no longer available.')
        .setColor(0xff0000);
    }

    const buyQty = actualBuyQty as number;
    const totalCost = buyQty * listing.price_per_unit;

    // Calculate fee
    const fee = Math.floor(totalCost * config.economy_market_fee_pct / 100);
    const sellerEarnings = totalCost - fee;

    // Deduct buyer (atomic — prevents race conditions and negative balances)
    const { error: debitErr } = await this.supabase.rpc('economy_subtract_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: totalCost,
    });

    if (debitErr) {
      // Refund listing remaining since we already decremented it
      await Promise.resolve(this.supabase.rpc('economy_market_buy_revert', {
        p_listing_id: listing.id,
        p_quantity: buyQty,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      return new EmbedBuilder()
        .setDescription(`❌ You need **${totalCost.toLocaleString()}** coins but don't have enough.`)
        .setColor(0xff0000);
    }

    // V49-C5: Pay seller — if this fails, refund buyer and restore listing
    const { error: payErr } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: listing.seller_id,
      p_amount: sellerEarnings,
    });
    if (payErr) {
      log.error(`economy_add_balance failed for seller ${listing.seller_id} — refunding buyer:`, payErr.message);
      // Refund buyer
      await Promise.resolve(this.supabase.rpc('economy_add_balance', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_amount: totalCost,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      // Restore listing quantity
      await Promise.resolve(this.supabase.rpc('economy_market_buy_revert', {
        p_listing_id: listing.id,
        p_quantity: buyQty,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      return new EmbedBuilder()
        .setDescription('❌ Purchase failed — your coins have been refunded.')
        .setColor(0xff0000);
    }

    // Add item to buyer inventory — V49-C5: check error, refund if failed
    const { error: invErr } = await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: listing.item_id,
      p_quantity: buyQty,
    });
    if (invErr) {
      log.error(`inventory upsert failed for buyer ${userId} — refunding:`, invErr.message);
      // Refund buyer and claw back seller payment
      await Promise.resolve(this.supabase.rpc('economy_add_balance', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_amount: totalCost,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      await Promise.resolve(this.supabase.rpc('economy_subtract_balance', {
        p_guild_id: this.guild.id,
        p_user_id: listing.seller_id,
        p_amount: sellerEarnings,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      await Promise.resolve(this.supabase.rpc('economy_market_buy_revert', {
        p_listing_id: listing.id,
        p_quantity: buyQty,
      })).catch((e: unknown) => { log.error('Refund/revert failed:', (e as Error)?.message ?? e); });
      return new EmbedBuilder()
        .setDescription('❌ Failed to add items to your inventory — your coins have been refunded.')
        .setColor(0xff0000);
    }

    // Quest progress — market trade (buyer counts as completing a trade)
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'market_trade').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    // V5 Audit §4.2: Inform user when fewer items were purchased than requested
    const qtyNote = buyQty < quantity
      ? `\n⚠️ Only **${buyQty}** of your requested **${quantity}** were available.`
      : '';

    return new EmbedBuilder()
      .setTitle('✅ Purchase Complete!')
      .setDescription(
        `Bought **${listing.item_name}** x${buyQty}\n` +
        `💰 Cost: **${totalCost.toLocaleString()}** coins\n` +
        `💸 Fee: **${fee.toLocaleString()}** coins (${config.economy_market_fee_pct}%)` +
        qtyNote,
      )
      .setColor(0x4caf50);
  }

  // ── My Listings ───────────────────────────────────────

  async myListings(userId: string): Promise<EmbedBuilder> {
    const { data } = await this.supabase
      .from('economy_market_listings')
      .select('id, item_name, remaining, price_per_unit, status, expires_at')
      .eq('guild_id', this.guild.id)
      .eq('seller_id', userId)
      .order('created_at', { ascending: false })
      .limit(15);

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
    const { data: listings } = await this.supabase
      .from('economy_market_listings')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('seller_id', userId)
      .eq('status', 'active')
      .ilike('id', `${listingIdPrefix}%`)
      .limit(1);

    if (!listings || listings.length === 0) {
      return new EmbedBuilder()
        .setDescription('❌ Listing not found or already ended.')
        .setColor(0xff0000);
    }

    const listingId = (listings[0] as { id: string }).id;

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

    return new EmbedBuilder()
      .setTitle('🗑️ Listing Cancelled')
      .setDescription(`**${row.item_name}** x${row.remaining} returned to your inventory.`)
      .setColor(0xff9800);
  }
}
