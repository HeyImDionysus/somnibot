/**
 * GatheringManager — /hunt, /dig, /mine commands.
 *
 * Uses loot tables with weighted random selection. Tool durability is consumed
 * per use; better tool tiers unlock rarer drops. Cooldowns are enforced via Valkey.
 *
 * IMPORTANT: This is the "fake economy" — virtual items only.
 */
import { randomPick, randomFloat, randomIntRange } from '../../utils/random.js';
import { walletBalance } from '../../utils/db-helpers.js';
import { type Guild, EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';
import type { LootSourceType, LootRarity } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus } from '../../services/event-bus.js';
import { resolveBrandKit } from '../branding/brand-kit.js';

const log = createLogger('Gathering');

// ── Types ─────────────────────────────────────────────────

export interface GatheringConfig {
  economy_gathering_enabled: boolean;
  economy_gathering_cooldown_seconds: number;
  currency_name: string;
  currency_emoji: string;
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
    private supabase: SupabaseClient,
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
      .select('economy_gathering_enabled, economy_gathering_cooldown_seconds, currency_name, currency_emoji')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_gathering_enabled: data?.economy_gathering_enabled ?? true,
      economy_gathering_cooldown_seconds: data?.economy_gathering_cooldown_seconds ?? 300,
      // White-label branding: mirror economy-manager's fallbacks so an owner who
      // renamed their currency is honored on gather payouts too.
      currency_name: data?.currency_name ?? 'Coins',
      currency_emoji: data?.currency_emoji ?? '🪙',
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  // ── Gather ──────────────────────────────────────────────

  async gather(
    userId: string,
    sourceType: LootSourceType,
    interactionId?: string,
  ): Promise<{ embed: EmbedBuilder; result: GatherResult | null; error?: string }> {
    const config = await this.getConfig();
    if (!config.economy_gathering_enabled) {
      return {
        embed: new EmbedBuilder().setDescription('❌ Gathering is not enabled on this server.').setColor(0xff0000),
        result: null,
        error: 'disabled',
      };
    }

    // Interaction-scoped idempotency fence — independent of the cooldown clock.
    // The cooldown key only absorbs a redelivered interaction WITHIN its window;
    // an interaction re-delivered after the cooldown elapses would otherwise
    // re-roll and re-credit. This fence keys on the interaction id (TTL well
    // beyond a Discord interaction token's ~15m lifetime) so a replay pays once.
    if (interactionId) {
      const idemKey = `economy:gather:idem:${interactionId}`;
      const idemResult = await this.valkey.set(idemKey, '1', 'PX', 900_000, 'NX');
      if (idemResult !== 'OK') {
        return {
          embed: new EmbedBuilder()
            .setDescription('⏳ That gather was already processed.')
            .setColor(0xffa500),
          result: null,
          error: 'duplicate',
        };
      }
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

    // Guard an unrecognized source type (slash choices are constrained to
    // hunt/dig/mine, but never crash on an unexpected value).
    const sourceConfig = SOURCE_CONFIG[sourceType];
    if (!sourceConfig) {
      return {
        embed: new EmbedBuilder()
          .setDescription('❌ Unknown gathering activity. Try `hunt`, `dig`, or `mine`.')
          .setColor(0xff0000),
        result: null,
        error: 'invalid_source',
      };
    }

    // Tool check — find required tool in inventory.
    // [game-economy-gathering DEPFAIL] A FAILED inventory read (database
    // unreachable) is not "bare hands" — release the just-claimed cooldown +
    // idempotency fence (the outage must not consume the member's gather
    // window) and degrade with the branded notice.
    const toolEffect = sourceConfig.toolEffect;
    const toolResult = await this.checkTool(userId, toolEffect);
    if (toolResult.unavailable) {
      await this.releaseGatherClaims(cdKey, interactionId);
      return {
        embed: await this.unavailableEmbed(),
        result: null,
        error: 'dependency_unavailable',
      };
    }
    const toolTier = toolResult.tier;

    // Get loot table for this source type.
    // [game-economy-gathering DEPFAIL] Same rule: a failed loot-table read
    // must NOT surface as "No loot available for your current tool tier".
    let lootTable = await this.getLootTable(sourceType);
    if (lootTable === null) {
      await this.releaseGatherClaims(cdKey, interactionId);
      return {
        embed: await this.unavailableEmbed(),
        result: null,
        error: 'dependency_unavailable',
      };
    }
    if (lootTable.length === 0) {
      // Seeds only when the guild has NO loot rows for this source at all —
      // an owner who deactivated the whole table is respected (never
      // auto-restored).
      try {
        await this.seedIfTableEmpty(sourceType);
      } catch (err) {
        log.warn('lazy loot seeding failed:', (err as Error).message);
      }
      lootTable = (await this.getLootTable(sourceType)) ?? [];
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
        // [game-economy-gathering] Owner alert + audit when a gather payout fails
        // AFTER the roll (durability consumed, cooldown set) so the lost credit is
        // operator-visible.
        await this.raiseGatherPayoutAlert(userId, totalValue, sourceType)
          .catch((e: unknown) => { log.warn('gathering payout alert failed:', (e as Error)?.message ?? e); });
        eventBus.emit('gather.payout_failed', this.guild.id, {
          userId,
          sourceType,
          amount: totalValue,
        });
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
      balance_after: walletBalance(gatherWallet),
      description: `${SOURCE_CONFIG[sourceType].pastVerb} ${quantity}x ${picked.item_name}`,
    });

    const flavor = randomPick(FLAVOR_TEXT[sourceType]);
    const embed = new EmbedBuilder()
      .setTitle(`${SOURCE_CONFIG[sourceType].emoji} ${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} Results`)
      .setDescription(
        `${flavor}\n\n` +
        `${picked.emoji} **${picked.item_name}** × ${quantity}\n` +
        `${RARITY_LABELS[picked.rarity]}\n\n` +
        (picked.gives_item_id
          ? `Added to your inventory!`
          : `${config.currency_emoji} Sold for **${totalValue.toLocaleString()} ${config.currency_name}**`) +
        (toolResult.durabilityLeft !== null
          ? `\n🔧 Tool durability: **${Math.max(0, toolResult.durabilityLeft - 1)}** uses left`
          : ''),
      )
      .setColor(RARITY_COLORS[picked.rarity])
      .setTimestamp();

    // Quest progress
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'gather').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    // [game-economy-gathering] Append-only audit row for the gather state change
    // (loot granted to inventory or sold for currency).
    eventBus.emit('gather.completed', this.guild.id, {
      userId,
      sourceType,
      itemName: picked.item_name,
      quantity,
      value: totalValue,
    });

    return {
      embed,
      result: { item_name: picked.item_name, emoji: picked.emoji, rarity: picked.rarity, quantity, sell_value: totalValue, gives_item_id: picked.gives_item_id },
    };
  }

  // ── Internal helpers ────────────────────────────────────

  /**
   * The guild's loot table for a source, or `null` when the READ FAILED
   * (database unreachable) — a failed read is not an empty loot table
   * ([game-economy-gathering DEPFAIL]).
   */
  private async getLootTable(sourceType: LootSourceType): Promise<LootEntry[] | null> {
    const { data, error } = await this.supabase
      .from('economy_loot_tables')
      .select('id, item_name, emoji, rarity, min_qty, max_qty, weight, tool_tier, sell_value, gives_item_id')
      .eq('guild_id', this.guild.id)
      .eq('source_type', sourceType)
      .eq('active', true)
      .limit(1000);

    if (error) {
      log.error('getLootTable read failed:', error.message);
      return null;
    }
    return (data as LootEntry[] | null) ?? [];
  }

  /**
   * [game-economy-gathering DEPFAIL] Best-effort release of the cooldown and
   * interaction-idempotency claims when a gather aborts on a dependency
   * outage, so the outage never consumes the member's gather window.
   */
  private async releaseGatherClaims(cdKey: string, interactionId?: string): Promise<void> {
    try {
      await this.valkey.del(cdKey);
      if (interactionId) {
        await this.valkey.del(`economy:gather:idem:${interactionId}`);
      }
    } catch (e: unknown) {
      log.warn('failed to release gather claims after dependency outage:', (e as Error)?.message ?? e);
    }
  }

  /**
   * [game-economy-gathering DEPFAIL] The branded gathering-unavailable
   * degradation embed. The brand read is itself outage-safe (resolveBrandKit
   * never throws and is additionally .catch-guarded), falling back to the
   * guild name.
   */
  private async unavailableEmbed(): Promise<EmbedBuilder> {
    const brandKit = await resolveBrandKit(this.supabase, this.guild.id, {
      fallbackName: this.guild.name,
    }).catch(() => null);
    const name = brandKit?.brandName ?? this.guild.name ?? 'this server';
    return new EmbedBuilder()
      .setDescription(`⚠️ ${name}'s gathering grounds are temporarily unavailable — please try again in a moment. No cooldown was started and nothing was spent.`)
      .setColor(0xffa500);
  }

  /**
   * Seed the default loot for a source when the guild has NO loot rows for it
   * (active or not). Returns true when defaults were written. Throws when the
   * existence check or the write failed, so callers can report the failure.
   */
  private async seedIfTableEmpty(sourceType: LootSourceType): Promise<boolean> {
    const { count, error } = await this.supabase
      .from('economy_loot_tables')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id)
      .eq('source_type', sourceType);
    if (error) {
      throw new Error(`loot existence check for ${sourceType} failed: ${error.message}`);
    }
    if ((count ?? 0) > 0) return false; // owner content (even all-inactive) — never touch it
    await this.seedDefaultLoot(sourceType);
    return true;
  }

  private async seedDefaultLoot(sourceType: LootSourceType): Promise<void> {
    const defaults = DEFAULT_LOOT[sourceType];
    if (!defaults) return;

    const rows = defaults.map((d) => ({
      guild_id: this.guild.id,
      source_type: sourceType,
      ...d,
    }));

    // ON CONFLICT DO NOTHING: the (guild_id, source_type, lower(item_name),
    // tool_tier) uniqueness index turns a concurrent double-seed into a no-op.
    const { error } = await this.supabase
      .from('economy_loot_tables')
      .upsert(rows, { ignoreDuplicates: true });
    if (error) {
      throw new Error(`default loot seed for ${sourceType} failed: ${error.message}`);
    }
  }

  private async checkTool(userId: string, toolEffect: string): Promise<{ tier: number; inventoryId: string | null; durabilityLeft: number | null; unavailable?: boolean }> {
    // Find items in inventory that have this tool effect
    const { data: items, error } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity, durability_remaining, item_id, economy_items!inner(use_effect, category)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0)
      .limit(1000);

    // [game-economy-gathering DEPFAIL] A FAILED read is not "bare hands" —
    // callers degrade honestly instead of rolling from fabricated state.
    if (error) {
      log.error('checkTool read failed:', error.message);
      return { tier: 0, inventoryId: null, durabilityLeft: null, unavailable: true };
    }
    if (!items || items.length === 0) {
      return { tier: 0, inventoryId: null, durabilityLeft: null }; // bare hands
    }

    // Find items with matching tool effect
    let bestTier = 0;
    let bestInvId: string | null = null;
    let bestDurability: number | null = null;

    for (const inv of items as { id: string; durability_remaining: number | null; economy_items: { use_effect?: { type: string; tier?: number } } }[]) {
      const effect = inv.economy_items?.use_effect;
      if (!effect || typeof effect !== 'object') continue;
      if (effect.type !== toolEffect) continue;

      const tier = effect.tier ?? 1;
      if (tier > bestTier) {
        bestTier = tier;
        bestInvId = inv.id;
        bestDurability = inv.durability_remaining;
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

  /**
   * [game-economy-gathering] Raise a payout-degraded owner alert when a gather
   * sell credit fails after the roll, so an operator knows the member rolled loot
   * but the currency credit was lost. Best effort — never blocks the flow.
   */
  private async raiseGatherPayoutAlert(userId: string, amount: number, sourceType: LootSourceType): Promise<void> {
    await this.supabase.from('alerts').insert({
      guild_id: this.guild.id,
      alert_type: 'gathering_payout_failed',
      severity: 'warning',
      title: 'Gathering payout failed',
      message: `A ${sourceType} payout of ${amount} failed to credit ${userId} after the roll.`,
      metadata: { user_id: userId, amount, source_type: sourceType },
    });
  }

  private weightedRandom(entries: LootEntry[]): LootEntry {
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = randomFloat(totalWeight);
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  private randomInt(min: number, max: number): number {
    return randomIntRange(min, max);
  }

  private formatCooldown(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  /**
   * Seed this feature's default content now instead of on first command use.
   *
   * The defaults below always existed, but they were planted lazily: nothing
   * appeared until somebody ran the feature's command in Discord, so a fresh
   * install showed an empty dashboard page for a feature that claimed to be
   * on. Guild init calls this so content exists before anyone touches
   * anything. Idempotent — each source only writes when the guild has NO
   * loot rows for it at all (an all-deactivated table is respected owner
   * state). Throws when any source failed (after attempting all of them) so
   * the warmup can report degradation.
   */
  async ensureContentSeeded(): Promise<void> {
    const sources: LootSourceType[] = ['hunt', 'dig', 'mine'];
    const failed: string[] = [];
    for (const source of sources) {
      try {
        await this.seedIfTableEmpty(source);
      } catch (err) {
        log.error(`loot seeding failed for ${source}:`, (err as Error).message);
        failed.push(source);
      }
    }
    if (failed.length > 0) {
      throw new Error(`loot table seeding failed for: ${failed.join(', ')}`);
    }
  }
}
