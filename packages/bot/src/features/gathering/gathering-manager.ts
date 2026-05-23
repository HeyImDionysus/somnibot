/**
 * GatheringManager — /hunt, /dig, /mine commands.
 *
 * Uses loot tables with weighted random selection. Tool durability is consumed
 * per use; better tool tiers unlock rarer drops. Cooldowns are enforced via Valkey.
 *
 * IMPORTANT: This is the "fake economy" — virtual items only.
 */
import { type Guild, EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';
import type { LootSourceType, LootRarity } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Gathering');

// ── Types ─────────────────────────────────────────────────

export interface GatheringConfig {
  economy_gathering_enabled: boolean;
  economy_gathering_cooldown_seconds: number;
}

interface LootEntry {
  id: string;
  item_name: string;
  emoji: string;
  rarity: LootRarity;
  min_qty: number;
  max_qty: number;
  weight: number;
  tool_tier: number;
  sell_value: number;
  gives_item_id: string | null;
}

interface GatherResult {
  item_name: string;
  emoji: string;
  rarity: LootRarity;
  quantity: number;
  sell_value: number;
  gives_item_id: string | null;
}

const RARITY_COLORS: Record<LootRarity, number> = {
  common: 0x9e9e9e,
  uncommon: 0x4caf50,
  rare: 0x2196f3,
  epic: 0x9c27b0,
  legendary: 0xff9800,
};

const RARITY_LABELS: Record<LootRarity, string> = {
  common: '⬜ Common',
  uncommon: '🟩 Uncommon',
  rare: '🟦 Rare',
  epic: '🟪 Epic',
  legendary: '🟧 Legendary',
};

const SOURCE_CONFIG: Record<LootSourceType, { verb: string; pastVerb: string; toolEffect: string; emoji: string }> = {
  hunt: { verb: 'hunting', pastVerb: 'hunted', toolEffect: 'hunting_rifle', emoji: '🏹' },
  dig:  { verb: 'digging', pastVerb: 'dug up', toolEffect: 'shovel', emoji: '⛏️' },
  mine: { verb: 'mining', pastVerb: 'mined', toolEffect: 'pickaxe', emoji: '⛏️' },
};

const FLAVOR_TEXT: Record<LootSourceType, string[]> = {
  hunt: [
    'You ventured deep into the wilderness…',
    'You stalked your prey through the underbrush…',
    'You set up camp and waited patiently…',
    'You tracked footprints through the forest…',
  ],
  dig: [
    'You started digging at a promising site…',
    'Your shovel struck something buried…',
    'You excavated carefully through layers of soil…',
    'You noticed disturbed earth and began digging…',
  ],
  mine: [
    'You descended into the mineshaft…',
    'Your pickaxe rang against the rock face…',
    'You followed a glittering vein deeper…',
    'You cleared rubble to reveal fresh ore…',
  ],
};

// Default loot tables seeded when gathering is first enabled
const DEFAULT_LOOT: Record<LootSourceType, Array<Omit<LootEntry, 'id'>>> = {
  hunt: [
    { item_name: 'Rabbit Meat', emoji: '🥩', rarity: 'common', min_qty: 1, max_qty: 3, weight: 40, tool_tier: 0, sell_value: 15, gives_item_id: null },
    { item_name: 'Deer Hide', emoji: '🦌', rarity: 'common', min_qty: 1, max_qty: 2, weight: 30, tool_tier: 0, sell_value: 25, gives_item_id: null },
    { item_name: 'Bone Fragment', emoji: '🦴', rarity: 'uncommon', min_qty: 1, max_qty: 2, weight: 20, tool_tier: 0, sell_value: 40, gives_item_id: null },
    { item_name: 'Wolf Fang', emoji: '🐺', rarity: 'rare', min_qty: 1, max_qty: 1, weight: 8, tool_tier: 1, sell_value: 120, gives_item_id: null },
    { item_name: 'Phoenix Feather', emoji: '🔥', rarity: 'epic', min_qty: 1, max_qty: 1, weight: 2, tool_tier: 2, sell_value: 500, gives_item_id: null },
  ],
  dig: [
    { item_name: 'Clay', emoji: '🧱', rarity: 'common', min_qty: 1, max_qty: 5, weight: 35, tool_tier: 0, sell_value: 8, gives_item_id: null },
    { item_name: 'Fossil Fragment', emoji: '🦕', rarity: 'common', min_qty: 1, max_qty: 2, weight: 25, tool_tier: 0, sell_value: 20, gives_item_id: null },
    { item_name: 'Old Coin', emoji: '🪙', rarity: 'uncommon', min_qty: 1, max_qty: 3, weight: 20, tool_tier: 0, sell_value: 35, gives_item_id: null },
    { item_name: 'Amethyst Shard', emoji: '💎', rarity: 'rare', min_qty: 1, max_qty: 1, weight: 12, tool_tier: 1, sell_value: 100, gives_item_id: null },
    { item_name: 'Ancient Artifact', emoji: '🏺', rarity: 'epic', min_qty: 1, max_qty: 1, weight: 5, tool_tier: 2, sell_value: 400, gives_item_id: null },
    { item_name: 'Dragon Scale', emoji: '🐉', rarity: 'legendary', min_qty: 1, max_qty: 1, weight: 1, tool_tier: 3, sell_value: 2000, gives_item_id: null },
  ],
  mine: [
    { item_name: 'Stone', emoji: '🪨', rarity: 'common', min_qty: 2, max_qty: 6, weight: 35, tool_tier: 0, sell_value: 5, gives_item_id: null },
    { item_name: 'Iron Ore', emoji: '⛓️', rarity: 'common', min_qty: 1, max_qty: 3, weight: 25, tool_tier: 0, sell_value: 18, gives_item_id: null },
    { item_name: 'Gold Nugget', emoji: '✨', rarity: 'uncommon', min_qty: 1, max_qty: 2, weight: 20, tool_tier: 0, sell_value: 50, gives_item_id: null },
    { item_name: 'Emerald', emoji: '💚', rarity: 'rare', min_qty: 1, max_qty: 1, weight: 10, tool_tier: 1, sell_value: 150, gives_item_id: null },
    { item_name: 'Diamond', emoji: '💎', rarity: 'epic', min_qty: 1, max_qty: 1, weight: 5, tool_tier: 2, sell_value: 600, gives_item_id: null },
    { item_name: 'Void Crystal', emoji: '🔮', rarity: 'legendary', min_qty: 1, max_qty: 1, weight: 1, tool_tier: 3, sell_value: 2500, gives_item_id: null },
  ],
};

export class GatheringManager {
  private configCache: GatheringConfig | null = null;
  private configCacheTTL = 30_000;
  private configCacheTime = 0;

  constructor(
    private guild: Guild,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase client
    private supabase: any,
    private valkey: Valkey,
  ) {}

  // ── Config ──────────────────────────────────────────────

  invalidateConfig(): void {
    this.configCache = null;
    this.configCacheTime = 0;
  }

  async getConfig(): Promise<GatheringConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCacheTime < this.configCacheTTL) {
      return this.configCache;
    }

    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_gathering_enabled, economy_gathering_cooldown_seconds')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_gathering_enabled: data?.economy_gathering_enabled ?? false,
      economy_gathering_cooldown_seconds: data?.economy_gathering_cooldown_seconds ?? 300,
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  // ── Gather ──────────────────────────────────────────────

  async gather(
    userId: string,
    sourceType: LootSourceType,
  ): Promise<{ embed: EmbedBuilder; result: GatherResult | null; error?: string }> {
    const config = await this.getConfig();
    if (!config.economy_gathering_enabled) {
      return {
        embed: new EmbedBuilder().setDescription('❌ Gathering is not enabled on this server.').setColor(0xff0000),
        result: null,
        error: 'disabled',
      };
    }

    // V49-M2: Atomic cooldown via SET PX NX — prevents two concurrent
    // gather commands from both bypassing the cooldown.
    const cdKey = `economy:gather:${this.guild.id}:${userId}:${sourceType}`;
    const cooldownMs = config.economy_gathering_cooldown_seconds * 1000;
    const lockResult = await this.valkey.set(cdKey, '1', 'PX', cooldownMs, 'NX');
    if (lockResult !== 'OK') {
      const ttl = await this.valkey.pttl(cdKey);
      const remaining = Math.ceil(Math.max(ttl, 0) / 1000);
      return {
        embed: new EmbedBuilder()
          .setDescription(`⏳ You need to wait **${this.formatCooldown(remaining)}** before ${SOURCE_CONFIG[sourceType].verb} again.`)
          .setColor(0xffa500),
        result: null,
        error: 'cooldown',
      };
    }

    // Tool check — find required tool in inventory
    const toolEffect = SOURCE_CONFIG[sourceType].toolEffect;
    const toolResult = await this.checkTool(userId, toolEffect);
    const toolTier = toolResult.tier;

    // Get loot table for this source type
    let lootTable = await this.getLootTable(sourceType);
    if (lootTable.length === 0) {
      // Seed defaults
      await this.seedDefaultLoot(sourceType);
      lootTable = await this.getLootTable(sourceType);
    }

    // Filter by tool tier
    const available = lootTable.filter((e: LootEntry) => e.tool_tier <= toolTier);
    if (available.length === 0) {
      return {
        embed: new EmbedBuilder()
          .setDescription(`❌ No loot available for your current tool tier. Try upgrading your ${toolEffect.replace('_', ' ')}!`)
          .setColor(0xff0000),
        result: null,
        error: 'no_loot',
      };
    }

    // Weighted random selection
    const picked = this.weightedRandom(available);
    const quantity = this.randomInt(picked.min_qty, picked.max_qty);
    const totalValue = picked.sell_value * quantity;

    // V53-C4: Consume tool durability — fail-closed if decrement fails
    // (prevents infinite free resource extraction)
    if (toolResult.inventoryId) {
      const durabilityOk = await this.consumeDurability(toolResult.inventoryId);
      if (!durabilityOk) {
        return {
          embed: new EmbedBuilder()
            .setDescription('❌ Failed to consume tool durability — gathering cancelled. Try again.')
            .setColor(0xff0000),
          result: null,
          error: 'durability_failed',
        };
      }
    }

    // Cooldown already set at the top via SET PX NX (V49-M2).

    // Give loot to inventory or add currency
    if (picked.gives_item_id) {
      // V53-C3: check inventory upsert — surface error if it fails
      const lootAdded = await this.addToInventory(userId, picked.gives_item_id, quantity);
      if (!lootAdded) {
        return {
          embed: new EmbedBuilder()
            .setDescription('❌ Failed to add loot to your inventory. Please try again or contact an admin.')
            .setColor(0xff0000),
          result: null,
          error: 'inventory_upsert_failed',
        };
      }
    } else {
      // V52-M1: check addToWallet return — if credit fails, tell the user
      // instead of silently swallowing the error (coins would be lost).
      const credited = await this.addToWallet(userId, totalValue);
      if (!credited) {
        return {
          embed: new EmbedBuilder()
            .setDescription('❌ Wallet credit failed — please try again or contact an admin.')
            .setColor(0xff0000),
          result: null,
          error: 'wallet_credit_failed',
        };
      }
    }

    // Record transaction (fetch real balance for accurate audit trail)
    const { data: gatherWallet } = await this.supabase.from('economy_wallets')
      .select('wallet').eq('guild_id', this.guild.id).eq('user_id', userId).maybeSingle();
    await this.supabase.from('economy_transactions').insert({
      guild_id: this.guild.id,
      user_id: userId,
      type: 'gather',
      amount: totalValue,
      balance_after: (gatherWallet as any)?.wallet ?? 0,
      description: `${SOURCE_CONFIG[sourceType].pastVerb} ${quantity}x ${picked.item_name}`,
    });

    const flavor = FLAVOR_TEXT[sourceType][Math.floor(Math.random() * FLAVOR_TEXT[sourceType].length)];
    const embed = new EmbedBuilder()
      .setTitle(`${SOURCE_CONFIG[sourceType].emoji} ${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} Results`)
      .setDescription(
        `${flavor}\n\n` +
        `${picked.emoji} **${picked.item_name}** × ${quantity}\n` +
        `${RARITY_LABELS[picked.rarity]}\n\n` +
        (picked.gives_item_id
          ? `Added to your inventory!`
          : `💰 Sold for **${totalValue.toLocaleString()}** coins`) +
        (toolResult.durabilityLeft !== null
          ? `\n🔧 Tool durability: **${Math.max(0, toolResult.durabilityLeft - 1)}** uses left`
          : ''),
      )
      .setColor(RARITY_COLORS[picked.rarity])
      .setTimestamp();

    // Quest progress
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'gather').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    return {
      embed,
      result: { item_name: picked.item_name, emoji: picked.emoji, rarity: picked.rarity, quantity, sell_value: totalValue, gives_item_id: picked.gives_item_id },
    };
  }

  // ── Internal helpers ────────────────────────────────────

  private async getLootTable(sourceType: LootSourceType): Promise<LootEntry[]> {
    const { data } = await this.supabase
      .from('economy_loot_tables')
      .select('id, item_name, emoji, rarity, min_qty, max_qty, weight, tool_tier, sell_value, gives_item_id')
      .eq('guild_id', this.guild.id)
      .eq('source_type', sourceType)
      .eq('active', true);

    return (data as LootEntry[] | null) ?? [];
  }

  private async seedDefaultLoot(sourceType: LootSourceType): Promise<void> {
    const defaults = DEFAULT_LOOT[sourceType];
    if (!defaults) return;

    const rows = defaults.map((d) => ({
      guild_id: this.guild.id,
      source_type: sourceType,
      ...d,
    }));

    await this.supabase.from('economy_loot_tables').insert(rows);
  }

  private async checkTool(userId: string, toolEffect: string): Promise<{ tier: number; inventoryId: string | null; durabilityLeft: number | null }> {
    // Find items in inventory that have this tool effect
    const { data: items } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity, durability_remaining, item_id, economy_items!inner(use_effect, category)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0);

    if (!items || items.length === 0) {
      return { tier: 0, inventoryId: null, durabilityLeft: null }; // bare hands
    }

    // Find items with matching tool effect
    let bestTier = 0;
    let bestInvId: string | null = null;
    let bestDurability: number | null = null;

    for (const inv of items as any[]) {
      const effect = inv.economy_items?.use_effect;
      if (!effect || typeof effect !== 'object') continue;
      if ((effect as Record<string, unknown>).type !== toolEffect) continue;

      const tier = ((effect as Record<string, unknown>).tier as number) ?? 1;
      if (tier > bestTier) {
        bestTier = tier;
        bestInvId = inv.id as string;
        bestDurability = inv.durability_remaining as number | null;
      }
    }

    return { tier: bestTier, inventoryId: bestInvId, durabilityLeft: bestDurability };
  }

  private async consumeDurability(inventoryId: string): Promise<boolean> {
    // Atomic durability decrement — prevents TOCTOU race
    const { data: stillExists } = await this.supabase.rpc('economy_decrement_durability', {
      p_inventory_id: inventoryId,
    });
    return stillExists === true;
  }

  private async addToInventory(userId: string, itemId: string, quantity: number): Promise<boolean> {
    // V53-C3: check upsert result — callers must handle failure
    const { error } = await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: itemId,
      p_quantity: quantity,
    });
    if (error) {
      log.error('addToInventory failed:', error.message);
      return false;
    }
    return true;
  }

  private async addToWallet(userId: string, amount: number): Promise<boolean> {
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

  private weightedRandom(entries: LootEntry[]): LootEntry {
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private formatCooldown(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
}
