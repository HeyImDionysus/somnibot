/**
 * MarketManager — peer-to-peer item trading with listings.
 *
 * Players list items for sale, others browse and buy.
 * Market fee (configurable %) acts as a currency sink.
 *
 * IMPORTANT: This is the FAKE economy (virtual market).
 */

import { type Guild, EmbedBuilder } from 'discord.js';
import { getQuestsManager } from '../quests/quests-manager.js';

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

let _instance: MarketManager | null = null;

export function registerMarketManager(mgr: MarketManager): void {
  _instance = mgr;
}

export function invalidateMarketCache(): void {
  _instance?.invalidateCache();
}

export class MarketManager {
  private guild: Guild;
  private supabase: any;
  private valkey: any;
  private configCache: MarketConfig | null = null;

  constructor(guild: Guild, supabase: any, valkey: any) {
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

    const invEntry = inv[0] as any;
    if (invEntry.quantity < quantity) {
      return new EmbedBuilder()
        .setDescription(`❌ You only have **${invEntry.quantity}x** ${itemName} (trying to list ${quantity}).`)
        .setColor(0xff0000);
    }

    // Remove from inventory atomically (prevents TOCTOU — listing same item twice)
    const { data: decremented } = await this.supabase.rpc('economy_decrement_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: invEntry.item_id,
      p_quantity: quantity,
    });
    if (!decremented) {
      return new EmbedBuilder()
        .setDescription(`❌ You don't have enough **${itemName}** in your inventory.`)
        .setColor(0xff0000);
    }

    // Create listing
    const expiresAt = new Date(Date.now() + config.economy_market_listing_days * 24 * 60 * 60 * 1000).toISOString();

    await this.supabase.from('economy_market_listings').insert({
      guild_id: this.guild.id,
      seller_id: userId,
      item_id: invEntry.economy_items.id,
      item_name: invEntry.economy_items.name,
      quantity,
      remaining: quantity,
      price_per_unit: pricePerUnit,
      status: 'active',
      expires_at: expiresAt,
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

  async browse(searchTerm?: string): Promise<EmbedBuilder> {
    const config = await this.getConfig();
    if (!config.economy_market_enabled) {
      return new EmbedBuilder().setDescription('🚫 The market is not enabled.').setColor(0xff0000);
    }

    let query = this.supabase
      .from('economy_market_listings')
      .select('id, seller_id, item_name, remaining, price_per_unit, expires_at')
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .gt('remaining', 0)
      .gt('expires_at', new Date().toISOString())
      .order('price_per_unit', { ascending: true })
      .limit(15);

    if (searchTerm) {
      // Escape ILIKE special chars to prevent wildcard injection
      const escaped = searchTerm.replace(/[%_\\]/g, (c) => `\\${c}`);
      query = query.ilike('item_name', `%${escaped}%`);
    }

    const { data } = await query;
    const listings = (data ?? []) as MarketListing[];

    if (listings.length === 0) {
      return new EmbedBuilder()
        .setTitle('🏪 Player Market')
        .setDescription(searchTerm ? `No listings found for "${searchTerm}".` : 'No active listings right now.')
        .setColor(0x9e9e9e);
    }

    const lines = listings.map((l, i) => {
      const shortId = l.id.slice(0, 8);
      return `\`${shortId}\` **${l.item_name}** x${l.remaining} — 💰 ${l.price_per_unit.toLocaleString()}/ea • <@${l.seller_id}>`;
    });

    return new EmbedBuilder()
      .setTitle('🏪 Player Market')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Use /market buy <id> to purchase • ${config.economy_market_fee_pct}% fee` })
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
      await this.supabase.rpc('economy_market_buy', {
        p_listing_id: listing.id,
        p_quantity: -buyQty,
      }).catch(() => {});
      return new EmbedBuilder()
        .setDescription(`❌ You need **${totalCost.toLocaleString()}** coins but don't have enough.`)
        .setColor(0xff0000);
    }

    // Pay seller (atomic — upserts wallet if needed)
    const { error: payErr } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: listing.seller_id,
      p_amount: sellerEarnings,
    });
    if (payErr) console.error(`[Market] economy_add_balance failed for seller ${listing.seller_id}:`, payErr.message);

    // Add item to buyer inventory atomically (prevents TOCTOU on quantity)
    await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: listing.item_id,
      p_quantity: buyQty,
    });

    // Quest progress — market trade (buyer counts as completing a trade)
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'market_trade').catch(() => {});

    return new EmbedBuilder()
      .setTitle('✅ Purchase Complete!')
      .setDescription(
        `Bought **${listing.item_name}** x${buyQty}\n` +
        `💰 Cost: **${totalCost.toLocaleString()}** coins\n` +
        `💸 Fee: **${fee.toLocaleString()}** coins (${config.economy_market_fee_pct}%)`,
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
    const { data: listings } = await this.supabase
      .from('economy_market_listings')
      .select('*')
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

    const listing = listings[0] as MarketListing;

    // Return items to seller inventory atomically (prevents TOCTOU on quantity)
    await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: listing.item_id,
      p_quantity: listing.remaining,
    });

    // Cancel listing
    await this.supabase
      .from('economy_market_listings')
      .update({ status: 'cancelled' })
      .eq('id', listing.id);

    return new EmbedBuilder()
      .setTitle('🗑️ Listing Cancelled')
      .setDescription(`**${listing.item_name}** x${listing.remaining} returned to your inventory.`)
      .setColor(0xff9800);
  }
}
