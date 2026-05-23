/**
 * FishingManager — handles fishing mechanics, catches, collections.
 *
 * Requires a Fishing Rod (tool with durability). Bait shifts rarity odds.
 * Fish have randomized weight → heavier = more valuable.
 * Junk catches: old boot, seaweed, treasure chest (random items+currency).
 *
 * IMPORTANT: This is the FAKE economy (virtual fishing).
 */

import { type Guild, EmbedBuilder } from 'discord.js';
import type { FishRarity } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const log = createLogger('Fishing');

// ── Local Types ───────────────────────────────────────────

interface FishingConfig {
  economy_fishing_enabled: boolean;
  economy_fishing_cooldown_seconds: number;
  economy_fishing_junk_chance_pct: number;
  economy_fishing_treasure_chance_pct: number;
}

interface FishSpecies {
  id: string;
  name: string;
  emoji: string;
  rarity: FishRarity;
  min_weight: number;
  max_weight: number;
  base_price: number;
}

interface FishCatch {
  species: FishSpecies;
  weight: number;
  price: number;
  paid?: boolean; // V52-M2: tracks whether wallet credit succeeded
}

interface JunkCatch {
  type: 'junk' | 'treasure';
  name: string;
  emoji: string;
  currency: number;
  items: { name: string; qty: number }[];
}

// ── Rarity Config ─────────────────────────────────────────

const RARITY_WEIGHTS: Record<FishRarity, number> = {
  common: 50,
  uncommon: 30,
  rare: 15,
  epic: 4,
  legendary: 1,
};

const RARITY_COLORS: Record<FishRarity, number> = {
  common: 0x9e9e9e,
  uncommon: 0x4caf50,
  rare: 0x2196f3,
  epic: 0x9c27b0,
  legendary: 0xff9800,
};

const BAIT_RARITY_BOOST: Record<string, Partial<Record<FishRarity, number>>> = {
  'Basic Bait': { uncommon: 10 },
  'Quality Bait': { uncommon: 15, rare: 10 },
  'Premium Bait': { rare: 20, epic: 10 },
  'Legendary Bait': { epic: 20, legendary: 10 },
};

const JUNK_ITEMS = [
  { name: 'Old Boot', emoji: '👢', currency: 2 },
  { name: 'Seaweed', emoji: '🌿', currency: 1 },
  { name: 'Tin Can', emoji: '🥫', currency: 1 },
  { name: 'Driftwood', emoji: '🪵', currency: 3 },
  { name: 'Soggy Newspaper', emoji: '📰', currency: 1 },
];

const TREASURE_ITEMS = [
  { name: 'Ancient Coin', emoji: '🪙', currency: 50, items: [{ name: 'Ancient Coin', qty: 1 }] },
  { name: 'Pearl', emoji: '🫧', currency: 100, items: [{ name: 'Pearl', qty: 1 }] },
  { name: 'Golden Ring', emoji: '💍', currency: 200, items: [{ name: 'Golden Ring', qty: 1 }] },
];

const DEFAULT_SPECIES: Omit<FishSpecies, 'id'>[] = [
  { name: 'Sardine', emoji: '🐟', rarity: 'common', min_weight: 0.1, max_weight: 0.5, base_price: 5 },
  { name: 'Bass', emoji: '🐟', rarity: 'common', min_weight: 1.0, max_weight: 4.0, base_price: 15 },
  { name: 'Trout', emoji: '🐟', rarity: 'common', min_weight: 0.5, max_weight: 3.0, base_price: 12 },
  { name: 'Salmon', emoji: '🐠', rarity: 'uncommon', min_weight: 2.0, max_weight: 8.0, base_price: 30 },
  { name: 'Catfish', emoji: '🐠', rarity: 'uncommon', min_weight: 3.0, max_weight: 12.0, base_price: 35 },
  { name: 'Tuna', emoji: '🐠', rarity: 'uncommon', min_weight: 5.0, max_weight: 20.0, base_price: 50 },
  { name: 'Swordfish', emoji: '🐡', rarity: 'rare', min_weight: 20.0, max_weight: 80.0, base_price: 120 },
  { name: 'Octopus', emoji: '🐙', rarity: 'rare', min_weight: 5.0, max_weight: 25.0, base_price: 100 },
  { name: 'Electric Eel', emoji: '🐍', rarity: 'epic', min_weight: 10.0, max_weight: 40.0, base_price: 300 },
  { name: 'Giant Squid', emoji: '🦑', rarity: 'epic', min_weight: 50.0, max_weight: 200.0, base_price: 500 },
  { name: 'Golden Koi', emoji: '✨', rarity: 'legendary', min_weight: 2.0, max_weight: 10.0, base_price: 1000 },
  { name: 'Leviathan Fry', emoji: '🐉', rarity: 'legendary', min_weight: 0.5, max_weight: 5.0, base_price: 2000 },
];

// ── Manager ───────────────────────────────────────────────

let _instance: FishingManager | null = null;

export function registerFishingManager(mgr: FishingManager): void {
  _instance = mgr;
}

export function invalidateFishingCache(): void {
  _instance?.invalidateCache();
}

export class FishingManager {
  private guild: Guild;
  private supabase: SupabaseClient;
  private valkey: any;
  private configCache: FishingConfig | null = null;
  private speciesCache: FishSpecies[] | null = null;

  constructor(guild: Guild, supabase: SupabaseClient, valkey: any) {
    this.guild = guild;
    this.supabase = supabase;
    this.valkey = valkey;
  }

  invalidateCache(): void {
    this.configCache = null;
    this.speciesCache = null;
  }

  private async getConfig(): Promise<FishingConfig> {
    if (this.configCache) return this.configCache;
    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_fishing_enabled, economy_fishing_cooldown_seconds, economy_fishing_junk_chance_pct, economy_fishing_treasure_chance_pct')
      .eq('guild_id', this.guild.id)
      .single();
    this.configCache = data ?? {
      economy_fishing_enabled: false,
      economy_fishing_cooldown_seconds: 30,
      economy_fishing_junk_chance_pct: 15,
      economy_fishing_treasure_chance_pct: 5,
    };
    return this.configCache!;
  }

  private async getSpecies(): Promise<FishSpecies[]> {
    if (this.speciesCache) return this.speciesCache;
    const { data } = await this.supabase
      .from('economy_fish_species')
      .select('id, name, emoji, rarity, min_weight, max_weight, base_price')
      .eq('guild_id', this.guild.id)
      .eq('active', true);

    if (!data || data.length === 0) {
      await this.seedDefaultSpecies();
      const { data: seeded } = await this.supabase
        .from('economy_fish_species')
        .select('id, name, emoji, rarity, min_weight, max_weight, base_price')
        .eq('guild_id', this.guild.id)
        .eq('active', true);
      this.speciesCache = (seeded ?? []) as FishSpecies[];
    } else {
      this.speciesCache = data as FishSpecies[];
    }
    return this.speciesCache!;
  }

  private async seedDefaultSpecies(): Promise<void> {
    const rows = DEFAULT_SPECIES.map((s) => ({
      ...s,
      guild_id: this.guild.id,
      is_default: true,
    }));
    await this.supabase.from('economy_fish_species').insert(rows);
  }

  // ── Check tools ───────────────────────────────────────

  async checkRod(userId: string): Promise<{ hasRod: boolean; rodName: string }> {
    const { data } = await this.supabase
      .from('economy_inventory')
      .select('id, economy_items!inner(name, category, durability)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('economy_items.category', 'Tools')
      .ilike('economy_items.name', '%fishing rod%')
      .gt('quantity', 0)
      .limit(1);

    if (!data || data.length === 0) return { hasRod: false, rodName: '' };
    return { hasRod: true, rodName: (data[0] as any).economy_items.name };
  }

  private async consumeBait(userId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity, item_id, economy_items!inner(name, category)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('economy_items.category', 'Bait')
      .gt('quantity', 0)
      .order('economy_items(name)')
      .limit(1);

    if (!data || data.length === 0) return null;
    const inv = data[0] as any;

    // V47-M1: atomic decrement that RETURNS BOOLEAN. If a concurrent
    // /fish call already consumed the last bait, the RPC returns false
    // and we MUST NOT award fish on this call. Previous code ignored
    // the return value and could yield 2 catches from 1 bait.
    const { data: consumed } = await this.supabase.rpc('economy_decrement_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: inv.item_id,
      p_quantity: 1,
    });
    if (consumed !== true) return null;
    return inv.economy_items.name;
  }

  // ── Fish! ─────────────────────────────────────────────

  async fish(userId: string): Promise<{ embed: EmbedBuilder; cooldownKey: string }> {
    const config = await this.getConfig();
    if (!config.economy_fishing_enabled) {
      return {
        embed: new EmbedBuilder().setDescription('🚫 Fishing is not enabled.').setColor(0xff0000),
        cooldownKey: '',
      };
    }

    // V48-M1: atomic SET NX cooldown claim. Without this, two concurrent
    // /fish invocations from the same user both bypass the check before
    // either writes the cooldown, doubling the catch (and the bait spend
    // race that V47-M1 already locked down).
    const cdKey = `fishing:${this.guild.id}:${userId}`;
    const claimed = await this.valkey.set(
      cdKey,
      '1',
      'EX',
      config.economy_fishing_cooldown_seconds,
      'NX',
    );
    if (!claimed) {
      const ttl = await this.valkey.ttl(cdKey);
      return {
        embed: new EmbedBuilder()
          .setDescription(`⏳ You can fish again <t:${Math.floor(Date.now() / 1000) + Math.max(1, ttl)}:R>.`)
          .setColor(0xffaa00),
        cooldownKey: '',
      };
    }

    // Rod check
    const { hasRod, rodName } = await this.checkRod(userId);
    if (!hasRod) {
      return {
        embed: new EmbedBuilder()
          .setDescription('🎣 You need a **Fishing Rod** to fish! Buy one from `/shop`.')
          .setColor(0xff0000),
        cooldownKey: '',
      };
    }

    // Consume bait
    const baitUsed = await this.consumeBait(userId);

    // Determine catch type
    const roll = Math.random() * 100;
    const junkThreshold = config.economy_fishing_junk_chance_pct;
    const treasureThreshold = junkThreshold + config.economy_fishing_treasure_chance_pct;

    let embed: EmbedBuilder;

    if (roll < junkThreshold) {
      // Junk catch
      const junk = JUNK_ITEMS[Math.floor(Math.random() * JUNK_ITEMS.length)];
      // V52-M2: check addCurrency return so failed credits are surfaced
      const paid = await this.addCurrency(userId, junk.currency);
      embed = new EmbedBuilder()
        .setTitle('🎣 You cast your line...')
        .setDescription(
          `${junk.emoji} You caught **${junk.name}**!\n` +
          (paid ? `You sold it for 💰 **${junk.currency}**.` : '⚠️ Wallet credit failed — contact an admin.'),
        )
        .setColor(paid ? 0x607d8b : 0xff0000)
        .setFooter({ text: `Using ${rodName}${baitUsed ? ` + ${baitUsed}` : ''}` });
    } else if (roll < treasureThreshold) {
      // Treasure catch
      const treasure = TREASURE_ITEMS[Math.floor(Math.random() * TREASURE_ITEMS.length)];
      // V52-M2: check addCurrency return so failed credits are surfaced
      const paid = await this.addCurrency(userId, treasure.currency);
      embed = new EmbedBuilder()
        .setTitle('🎣 You cast your line...')
        .setDescription(
          `🎁 You found a **Treasure Chest**!\n` +
          `${treasure.emoji} Inside: **${treasure.name}**` +
          (paid ? ` + 💰 **${treasure.currency}**!` : ' ⚠️ Wallet credit failed — contact an admin.'),
        )
        .setColor(paid ? 0xffd700 : 0xff0000)
        .setFooter({ text: `Using ${rodName}${baitUsed ? ` + ${baitUsed}` : ''}` });
    } else {
      // Fish catch
      const fishCatch = await this.rollFishCatch(userId, baitUsed);
      // V52-M2: surface wallet credit failure in the embed
      const valueText = fishCatch.paid !== false
        ? `💰 Value: **${fishCatch.price.toLocaleString()}** coins`
        : '⚠️ Wallet credit failed — contact an admin.';
      embed = new EmbedBuilder()
        .setTitle('🎣 You cast your line...')
        .setDescription(
          `${fishCatch.species.emoji} You caught a **${fishCatch.species.name}**!\n` +
          `⚖️ Weight: **${fishCatch.weight.toFixed(2)} kg**\n` +
          valueText,
        )
        .setColor(RARITY_COLORS[fishCatch.species.rarity])
        .addFields({ name: 'Rarity', value: fishCatch.species.rarity.toUpperCase(), inline: true })
        .setFooter({ text: `Using ${rodName}${baitUsed ? ` + ${baitUsed}` : ''}` });
    }

    // (V48-M1) cooldown was already claimed via SET NX above

    // Quest progress
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'fish').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    return { embed, cooldownKey: cdKey };
  }

  private async rollFishCatch(userId: string, baitName: string | null): Promise<FishCatch> {
    const species = await this.getSpecies();

    // Build weight map with bait bonus
    const weights = { ...RARITY_WEIGHTS };
    if (baitName && BAIT_RARITY_BOOST[baitName]) {
      const boost = BAIT_RARITY_BOOST[baitName];
      for (const [rarity, bonus] of Object.entries(boost)) {
        weights[rarity as FishRarity] += bonus;
      }
    }

    // Weighted random rarity
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let roll = Math.random() * totalWeight;
    let selectedRarity: FishRarity = 'common';
    for (const [rarity, weight] of Object.entries(weights) as [FishRarity, number][]) {
      roll -= weight;
      if (roll <= 0) {
        selectedRarity = rarity;
        break;
      }
    }

    // Pick random species of that rarity
    const candidates = species.filter((s) => s.rarity === selectedRarity);
    const picked = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : species[Math.floor(Math.random() * species.length)];

    // Random weight
    const weight = picked.min_weight + Math.random() * (picked.max_weight - picked.min_weight);
    const weightMultiplier = weight / ((picked.min_weight + picked.max_weight) / 2);
    const price = Math.round(picked.base_price * weightMultiplier);

    // Record catch + pay
    await this.supabase.from('economy_fish_catches').insert({
      guild_id: this.guild.id,
      user_id: userId,
      species_id: picked.id,
      weight: parseFloat(weight.toFixed(2)),
      price_earned: price,
    });
    // V52-M2: check addCurrency and flag failed payout on the catch record
    const paid = await this.addCurrency(userId, price);
    if (!paid) {
      log.error(`Fish catch recorded but wallet credit failed for ${userId} — ${price} coins lost`);
    }

    return { species: picked, weight, price, paid };
  }

  // ── Sell fish from bucket ─────────────────────────────

  async sellAll(userId: string): Promise<EmbedBuilder> {
    // Fish auto-sell on catch, so /fish sell is an alias for viewing earnings
    const { data, count } = await this.supabase
      .from('economy_fish_catches')
      .select('price_earned', { count: 'exact' })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId);

    const totalEarned = (data ?? []).reduce((sum: number, c: any) => sum + (c.price_earned ?? 0), 0);
    return new EmbedBuilder()
      .setTitle('🐟 Fishing Summary')
      .setDescription(
        `You've caught **${count ?? 0}** fish total.\n` +
        `Total earnings: 💰 **${totalEarned.toLocaleString()}** coins.`,
      )
      .setColor(0x2196f3);
  }

  // ── Collection ────────────────────────────────────────

  async getCollection(userId: string): Promise<EmbedBuilder> {
    const species = await this.getSpecies();
    const { data: catches } = await this.supabase
      .from('economy_fish_catches')
      .select('species_id, weight')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId);

    const caught = new Map<string, { count: number; maxWeight: number }>();
    for (const c of (catches ?? []) as any[]) {
      const entry = caught.get(c.species_id) ?? { count: 0, maxWeight: 0 };
      entry.count++;
      entry.maxWeight = Math.max(entry.maxWeight, c.weight);
      caught.set(c.species_id, entry);
    }

    const lines = species.map((s) => {
      const entry = caught.get(s.id);
      if (entry) {
        return `${s.emoji} **${s.name}** (${s.rarity}) — caught ${entry.count}x, best: ${entry.maxWeight.toFixed(2)} kg`;
      }
      return `❓ **???** (${s.rarity}) — not caught yet`;
    });

    return new EmbedBuilder()
      .setTitle('📖 Fish Collection')
      .setDescription(lines.join('\n') || 'No species available.')
      .setFooter({ text: `${caught.size}/${species.length} species discovered` })
      .setColor(0x00bcd4);
  }

  // ── Leaderboard ───────────────────────────────────────

  async getLeaderboard(): Promise<EmbedBuilder> {
    const { data } = await this.supabase
      .from('economy_fish_catches')
      .select('user_id, weight, economy_fish_species!inner(name, emoji)')
      .eq('guild_id', this.guild.id)
      .order('weight', { ascending: false })
      .limit(10);

    const lines = (data ?? []).map((c: any, i: number) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      return `${medal} <@${c.user_id}> — ${c.economy_fish_species.emoji} **${c.economy_fish_species.name}** (${c.weight.toFixed(2)} kg)`;
    });

    return new EmbedBuilder()
      .setTitle('🏆 Fishing Leaderboard — Heaviest Catches')
      .setDescription(lines.join('\n') || 'No catches yet!')
      .setColor(0xffc107);
  }

  // ── Helpers ───────────────────────────────────────────

  // V52-M2: return boolean so callers can detect and surface wallet failures
  // instead of silently losing coins.
  private async addCurrency(userId: string, amount: number): Promise<boolean> {
    const { error } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: amount,
    });
    if (error) {
      log.error(`economy_add_balance failed for ${userId}:`, error.message);
      return false;
    }
    return true;
  }
}
