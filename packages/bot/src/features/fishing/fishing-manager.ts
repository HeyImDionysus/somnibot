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
import { randomPick, randomFloat } from '../../utils/random.js';
import { joinProp } from '../../utils/db-helpers.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus } from '../../services/event-bus.js';
import * as auditService from '../../services/audit.js';
import type { EconomyAuditOptions } from '../../services/audit.js';
import { randomUUID } from 'node:crypto';
import {
  BRAND_KIT_COLUMNS,
  brandKitFromConfig,
  defaultBrandKit,
  resolveBrandKit,
  type BrandKit,
} from '../branding/brand-kit.js';
import { applyBrand, brandedEmbed } from '../branding/branded-embed.js';
import { voice } from '../branding/voice.js';
import { claimOccurrence } from '../../utils/occurrence-fence.js';

const log = createLogger('Fishing');

async function writeEconomyAudit(supabase: SupabaseClient, options: EconomyAuditOptions): Promise<void> {
  const correlationId = options.operationId ?? randomUUID();
  await auditService.writeAuditLog(supabase, {
    guildId: options.guildId, actorType: options.actorType ?? 'user', actorId: options.actorId,
    action: options.action, category: 'economy', targetType: options.targetType ?? 'member',
    targetId: options.targetId ?? options.actorId, details: options.details, correlationId,
    occurrenceKey: `${options.action}:${correlationId}`, success: options.success, errorMessage: options.errorMessage,
  });
}

// ── Local Types ───────────────────────────────────────────

interface FishingConfig {
  economy_fishing_enabled: boolean;
  economy_fishing_cooldown_seconds: number;
  economy_fishing_junk_chance_pct: number;
  economy_fishing_treasure_chance_pct: number;
  economy_fishing_collection_reward_enabled: boolean;
  economy_fishing_collection_reward_coins: number;
  /** White-label brand kit projected from the same cached guild_config row. */
  brandKit: BrandKit;
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

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, FishingManager>();

export function registerFishingManager(mgr: FishingManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterFishingManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateFishingCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateCache();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateCache();
  }
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
    const { data, error } = await this.supabase
      .from('guild_config')
      .select(`economy_fishing_enabled, economy_fishing_cooldown_seconds, economy_fishing_junk_chance_pct, economy_fishing_treasure_chance_pct, economy_fishing_collection_reward_enabled, economy_fishing_collection_reward_coins, ${BRAND_KIT_COLUMNS}`)
      .eq('guild_id', this.guild.id)
      .single();
    const row = (data ?? null) as (Record<string, unknown> | null);
    const cfg: FishingConfig = {
      economy_fishing_enabled: (row?.economy_fishing_enabled as boolean | undefined) ?? true,
      economy_fishing_cooldown_seconds: (row?.economy_fishing_cooldown_seconds as number | undefined) ?? 30,
      economy_fishing_junk_chance_pct: (row?.economy_fishing_junk_chance_pct as number | undefined) ?? 15,
      economy_fishing_treasure_chance_pct: (row?.economy_fishing_treasure_chance_pct as number | undefined) ?? 5,
      economy_fishing_collection_reward_enabled: (row?.economy_fishing_collection_reward_enabled as boolean | undefined) ?? true,
      economy_fishing_collection_reward_coins: (row?.economy_fishing_collection_reward_coins as number | undefined) ?? 5000,
      brandKit: brandKitFromConfig(row, this.guild.name),
    };
    // [game-economy-fishing DEPFAIL] Never CACHE a fallback built from a
    // FAILED read (database unreachable): a transient outage would otherwise
    // pin default config until the next cache invalidation. A missing row
    // (PGRST116) is a legitimate default and may be cached.
    if (error && error.code !== 'PGRST116') {
      return cfg;
    }
    this.configCache = cfg;
    return this.configCache!;
  }

  /**
   * The guild's active species, or `null` when the READ FAILED (database
   * unreachable). A failed read must never be cached as an empty catalog —
   * that would pin "no species" past the outage and lie to every subsequent
   * /fish collection ([game-economy-fishing DEPFAIL]).
   *
   * Seeding is gated on the guild having NO species rows at all (active or
   * not): an owner who deactivated the entire catalog made a deliberate call
   * that is never overwritten with restored defaults.
   */
  private async getSpecies(): Promise<FishSpecies[] | null> {
    // A cached [] is a legitimate empty catalog (owner deactivated every
    // species) — only null means "not loaded yet".
    if (this.speciesCache !== null) return this.speciesCache;
    const { data, error } = await this.supabase
      .from('economy_fish_species')
      .select('id, name, emoji, rarity, min_weight, max_weight, base_price')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (error) {
      log.error('getSpecies read failed:', error.message);
      return null;
    }
    if (data && data.length > 0) {
      this.speciesCache = data as FishSpecies[];
      return this.speciesCache;
    }

    // No ACTIVE species — seed only when the guild has none AT ALL.
    let seededNow = false;
    try {
      seededNow = await this.seedIfCatalogEmpty();
    } catch (err) {
      // Gate read or seed write failed — never cache the fabricated empty
      // catalog ([game-economy-fishing DEPFAIL]).
      log.error('species seeding failed:', (err as Error).message);
      return null;
    }
    if (!seededNow) {
      this.speciesCache = []; // deactivate-all is respected owner state
      return this.speciesCache;
    }

    const { data: seeded, error: seededErr } = await this.supabase
      .from('economy_fish_species')
      .select('id, name, emoji, rarity, min_weight, max_weight, base_price')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);
    if (seededErr) {
      log.error('getSpecies post-seed read failed:', seededErr.message);
      return null;
    }
    this.speciesCache = (seeded ?? []) as FishSpecies[];
    return this.speciesCache;
  }

  /**
   * [game-economy-fishing DEPFAIL] The branded fishing-unavailable degradation
   * embed. The brand read is itself outage-safe (resolveBrandKit never throws
   * and is additionally .catch-guarded), falling back to the guild name.
   */
  private async unavailableEmbed(): Promise<EmbedBuilder> {
    const brandKit = await resolveBrandKit(this.supabase, this.guild.id, {
      fallbackName: this.guild.name,
    }).catch(() => null);
    const kit = brandKit ?? defaultBrandKit(this.guild.name);
    const name = brandKit?.brandName ?? this.guild.name ?? 'this server';
    return brandedEmbed(kit, {
      intent: 'warning',
      description:
        `${voice(kit.voicePreset, 'unavailable', { brand: name, feature: 'fishing pond' })}` +
        ` No ${kit.currencyName} or bait were spent and no cast cooldown was started.`,
    });
  }

  /**
   * Seed the default species when the guild has NO species rows (active or
   * not). Returns true when defaults were written. Throws when the existence
   * check or the write failed, so callers (warmup, getSpecies) can report the
   * failure instead of silently proceeding with an empty catalog.
   */
  private async seedIfCatalogEmpty(): Promise<boolean> {
    const { count, error } = await this.supabase
      .from('economy_fish_species')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id);
    if (error) {
      throw new Error(`species existence check failed: ${error.message}`);
    }
    if ((count ?? 0) > 0) return false; // owner content (even all-inactive) — never touch it
    await this.seedDefaultSpecies();
    return true;
  }

  private async seedDefaultSpecies(): Promise<void> {
    const rows = DEFAULT_SPECIES.map((s) => ({
      ...s,
      guild_id: this.guild.id,
      is_default: true,
    }));
    // ON CONFLICT DO NOTHING: the (guild_id, lower(name)) uniqueness index
    // turns a concurrent double-seed into a no-op instead of duplicate rows.
    const { error } = await this.supabase
      .from('economy_fish_species')
      .upsert(rows, { ignoreDuplicates: true });
    if (error) {
      throw new Error(`default species seed failed: ${error.message}`);
    }
  }

  // ── Check tools ───────────────────────────────────────

  async checkRod(userId: string): Promise<{ hasRod: boolean; rodName: string; unavailable?: boolean }> {
    const { data, error } = await this.supabase
      .from('economy_inventory')
      .select('id, economy_items!inner(name, category, durability)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('economy_items.category', 'Tools')
      .ilike('economy_items.name', '%fishing rod%')
      .gt('quantity', 0)
      .limit(1);

    // [game-economy-fishing DEPFAIL] A FAILED read (database unreachable) is
    // not "no rod" — surfacing it as such tells the member a data-shaped lie
    // about inventory the bot could not read. Callers degrade honestly.
    if (error) {
      log.error('checkRod read failed:', error.message);
      return { hasRod: false, rodName: '', unavailable: true };
    }
    if (!data || data.length === 0) return { hasRod: false, rodName: '' };
    return { hasRod: true, rodName: (joinProp(data[0], 'economy_items', 'name') as string) ?? 'Fishing Rod' };
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
    // Supabase !inner join returns a single object at runtime, but generated types
    // may infer an array. Cast through unknown to satisfy both.
    const raw = data[0];
    const joinedItems = Array.isArray(raw.economy_items) ? raw.economy_items[0] : raw.economy_items;
    const inv = { item_id: raw.item_id as string, quantity: raw.quantity as number, economy_items: joinedItems as { name: string } };

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

  async fish(
    userId: string,
    interactionId?: string,
  ): Promise<{ embed: EmbedBuilder; cooldownKey: string }> {
    const correlationId = interactionId?.trim() || randomUUID();
    const config = await this.getConfig();
    if (!config.economy_fishing_enabled) {
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.cast_denied', details: { reason: 'feature_disabled' }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '🚫 Fishing is not enabled.',
        }),
        cooldownKey: '',
      };
    }

    // Interaction-scoped fence, independent of the cooldown clock below. The
    // cooldown only absorbs a redelivery WITHIN its window; one arriving after
    // it elapses would re-roll the catch and credit a second payout.
    // FAIL-SAFE: paying twice is worse than refusing a legitimate cast.
    if (interactionId) {
      const claim = await claimOccurrence(
        this.valkey,
        `fishing:idem:${interactionId}`,
        { onUnavailable: 'decline' },
      );
      if (claim === 'replay') {
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: userId, operationId: correlationId,
          action: 'fishing.cast_denied', details: { reason: 'replay' }, success: false,
        });
        return {
          embed: brandedEmbed(config.brandKit, {
            intent: 'warning',
            description: '⏳ That cast was already processed.',
          }),
          cooldownKey: '',
        };
      }
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
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.cast_denied', details: { reason: 'cooldown', ttl }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'warning',
          description: `⏳ You can fish again <t:${Math.floor(Date.now() / 1000) + Math.max(1, ttl)}:R>.`,
        }),
        cooldownKey: '',
      };
    }

    // Rod check
    const { hasRod, rodName, unavailable } = await this.checkRod(userId);
    // [game-economy-fishing DEPFAIL] With the database unreachable the rod
    // read fails — release the just-claimed cast cooldown (the outage must not
    // consume the member's cast window) and degrade with the branded notice,
    // never the fabricated "You need a Fishing Rod" answer.
    if (unavailable) {
      try {
        await this.valkey.del(cdKey);
      } catch (e: unknown) {
        log.warn('failed to release cast cooldown after rod read failure:', (e as Error)?.message ?? e);
      }
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.backend_unavailable_retried', details: { operation: 'rod_read' }, success: false, actorType: 'system',
      });
      eventBus.emit('fishing.backend_unavailable_retried', this.guild.id, {
        userId, operation: 'rod_read', correlationId, occurrenceId: correlationId,
      });
      return { embed: await this.unavailableEmbed(), cooldownKey: '' };
    }
    if (!hasRod) {
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.cast_denied', details: { reason: 'missing_rod' }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '🎣 You need a **Fishing Rod** to fish! Buy one from `/shop`.',
        }),
        cooldownKey: '',
      };
    }

    // Consume bait
    const baitUsed = await this.consumeBait(userId);

    // Determine catch type
    const roll = randomFloat(100);
    const junkThreshold = config.economy_fishing_junk_chance_pct;
    const treasureThreshold = junkThreshold + config.economy_fishing_treasure_chance_pct;

    let embed: EmbedBuilder;

    if (roll < junkThreshold) {
      // Junk catch
      const junk = randomPick(JUNK_ITEMS);
      // V52-M2: check addCurrency return so failed credits are surfaced
      const paid = await this.addCurrency(userId, junk.currency, `${correlationId}:payout`);
      const catchDetails = { catchType: 'junk', name: junk.name, amount: junk.currency, paid };
      if (!paid) {
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: userId, operationId: `${correlationId}:payout`,
          action: 'fishing.catch_payout_failed', details: catchDetails, success: false,
          errorMessage: 'wallet credit failed', actorType: 'system',
        });
        eventBus.emit('fishing.catch_payout_failed', this.guild.id, {
          userId, species: junk.name, amount: junk.currency,
          correlationId: `${correlationId}:payout`, occurrenceId: `${correlationId}:payout`,
        });
      }
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.catch', details: catchDetails, success: paid,
        errorMessage: paid ? undefined : 'wallet credit failed',
      });
      eventBus.emit('fishing.catch', this.guild.id, {
        userId, species: junk.name, rarity: 'junk', price: junk.currency, paid,
        correlationId, occurrenceId: correlationId,
      });
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
      const treasure = randomPick(TREASURE_ITEMS);
      // V52-M2: check addCurrency return so failed credits are surfaced
      const paid = await this.addCurrency(userId, treasure.currency, `${correlationId}:payout`);
      const catchDetails = { catchType: 'treasure', name: treasure.name, amount: treasure.currency, paid };
      if (!paid) {
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: userId, operationId: `${correlationId}:payout`,
          action: 'fishing.catch_payout_failed', details: catchDetails, success: false,
          errorMessage: 'wallet credit failed', actorType: 'system',
        });
        eventBus.emit('fishing.catch_payout_failed', this.guild.id, {
          userId, species: treasure.name, amount: treasure.currency,
          correlationId: `${correlationId}:payout`, occurrenceId: `${correlationId}:payout`,
        });
      }
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.catch', details: catchDetails, success: paid,
        errorMessage: paid ? undefined : 'wallet credit failed',
      });
      eventBus.emit('fishing.catch', this.guild.id, {
        userId, species: treasure.name, rarity: 'treasure', price: treasure.currency, paid,
        correlationId, occurrenceId: correlationId,
      });
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
      const fishCatch = await this.rollFishCatch(userId, baitUsed, correlationId);
      // [game-economy-fishing DEPFAIL] A null roll means the species catalog
      // was unreadable (outage) — release the cast cooldown and degrade
      // honestly rather than crash or fabricate a catch.
      if (!fishCatch) {
        try {
          await this.valkey.del(cdKey);
        } catch (e: unknown) {
          log.warn('failed to release cast cooldown after species read failure:', (e as Error)?.message ?? e);
        }
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: userId, operationId: correlationId,
          action: 'fishing.backend_unavailable_retried', details: { operation: 'species_read' }, success: false, actorType: 'system',
        });
        eventBus.emit('fishing.backend_unavailable_retried', this.guild.id, {
          userId, operation: 'species_read', correlationId, occurrenceId: correlationId,
        });
        return { embed: await this.unavailableEmbed(), cooldownKey: '' };
      }
      // V52-M2: surface wallet credit failure in the embed
      const valueText = fishCatch.paid !== false
        ? `💰 Value: **${fishCatch.price.toLocaleString()}** coins`
        : '⚠️ Wallet credit failed — contact an admin.';
      // Rarity hue is SEMANTIC (the color *is* the rarity tier) — keepColor
      // preserves it while the embed still picks up the branded attribution.
      embed = applyBrand(
        new EmbedBuilder()
          .setTitle('🎣 You cast your line...')
          .setDescription(
            `${fishCatch.species.emoji} You caught a **${fishCatch.species.name}**!\n` +
            `⚖️ Weight: **${fishCatch.weight.toFixed(2)} kg**\n` +
            valueText,
          )
          .setColor(RARITY_COLORS[fishCatch.species.rarity])
          .addFields({ name: 'Rarity', value: fishCatch.species.rarity.toUpperCase(), inline: true })
          .setFooter({ text: `Using ${rodName}${baitUsed ? ` + ${baitUsed}` : ''}` }),
        config.brandKit,
        { keepColor: true },
      );

      // [game-economy-fishing] One-time collection completion bonus: only a fish
      // catch can discover a new species, so the completion check lives here.
      const completion = await this.maybePayCollectionReward(userId, correlationId);
      if (completion) {
        embed.addFields({
          name: '📖 Collection Complete!',
          value: `You've discovered every species! Bonus: 💰 **${completion.coins.toLocaleString()}** coins!`,
        });
      }
    }

    // (V48-M1) cooldown was already claimed via SET NX above

    // Quest progress
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'fish').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    return { embed, cooldownKey: cdKey };
  }

  private async rollFishCatch(userId: string, baitName: string | null, operationId?: string): Promise<FishCatch | null> {
    const correlationId = operationId?.trim() || randomUUID();
    const species = await this.getSpecies();
    // [game-economy-fishing DEPFAIL] Unreadable/empty species catalog: no roll
    // is possible — the caller degrades honestly (previously this crashed on
    // randomPick of an empty array).
    if (!species || species.length === 0) return null;

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
    let remainingWeight = randomFloat(totalWeight);
    let selectedRarity: FishRarity = 'common';
    for (const [rarity, weight] of Object.entries(weights) as [FishRarity, number][]) {
      remainingWeight -= weight;
      if (remainingWeight <= 0) {
        selectedRarity = rarity;
        break;
      }
    }

    // Pick random species of that rarity
    const candidates = species.filter((s) => s.rarity === selectedRarity);
    const picked = candidates.length > 0
      ? randomPick(candidates)
      : randomPick(species);

    // Random weight
    const weight = picked.min_weight + randomFloat(picked.max_weight - picked.min_weight);
    const weightMultiplier = weight / ((picked.min_weight + picked.max_weight) / 2);
    const price = Math.round(picked.base_price * weightMultiplier);

    // Record catch + pay. [game-economy-fishing] Insert the catch paid=false
    // FIRST and flip to true only once the credit lands, so a failed auto-sell
    // payout leaves a durable unpaid row (paid=false) that an operator — or the
    // retryUnpaidPayouts sweep — can settle exactly once. A blind re-credit is
    // no longer possible because only still-unpaid rows are ever re-credited.
    const { data: inserted, error: insertError } = await this.supabase.from('economy_fish_catches').insert({
      guild_id: this.guild.id,
      user_id: userId,
      species_id: picked.id,
      weight: parseFloat(weight.toFixed(2)),
      price_earned: price,
      paid: false,
      correlation_id: correlationId,
    }).select('id').single();

    // The partial unique index on (guild_id, correlation_id) turns a replay
    // into a read of the original catch.  Do not roll a second species or
    // issue another payout; if the original process died after the wallet
    // credit but before flipping paid=true, reuse the same economy idempotency
    // key so the retry is still a no-op at the ledger.
    if (insertError) {
      if (insertError.code !== '23505' || !correlationId) {
        log.error('Fish catch insert failed:', insertError.message);
        return null;
      }
      const { data: existing, error: readError } = await this.supabase
        .from('economy_fish_catches')
        .select('id, species_id, weight, price_earned, paid')
        .eq('guild_id', this.guild.id)
        .eq('correlation_id', correlationId)
        .maybeSingle();
      if (readError || !existing) {
        log.error('Fish catch replay read failed:', readError?.message ?? 'row not found');
        return null;
      }
      const existingSpecies = species.find((candidate) => candidate.id === existing.species_id);
      if (!existingSpecies) {
        log.error(`Fish catch replay species ${existing.species_id} is not in the active catalog`);
        return null;
      }
      const existingCatch: FishCatch = {
        species: existingSpecies,
        weight: Number(existing.weight),
        price: Number(existing.price_earned),
        paid: existing.paid !== false,
      };
      if (existingCatch.paid) return existingCatch;

      const replayPaid = await this.addCurrency(userId, existingCatch.price, correlationId);
      if (replayPaid) {
        await this.supabase.from('economy_fish_catches')
          .update({ paid: true }).eq('id', existing.id).eq('paid', false);
        existingCatch.paid = true;
      }
      return existingCatch;
    }

    const paid = await this.addCurrency(userId, price, correlationId);
    if (paid) {
      if (inserted?.id) {
        await this.supabase.from('economy_fish_catches').update({ paid: true }).eq('id', inserted.id);
      }
    } else {
      log.error(`Fish catch recorded but wallet credit failed for ${userId} — ${price} coins left unpaid (paid=false) for retry`);
      // Raise a payout-degraded owner alert so the unpaid catch is visible.
      await this.raisePayoutDegradedAlert(userId, price)
        .catch((e: unknown) => { log.warn('payout-degraded alert failed:', (e as Error)?.message ?? e); });
      // [game-economy-fishing] Audit the failed auto-sell so the unpaid catch is
      // an append-only observable event, not just a warning log.
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'fishing.catch_payout_failed', details: { species: picked.name, amount: price }, success: false, actorType: 'system',
      });
      eventBus.emit('fishing.payout_failed', this.guild.id, {
        userId,
        species: picked.name,
        amount: price,
        correlationId,
        occurrenceId: correlationId,
      });
      eventBus.emit('fishing.catch_payout_failed', this.guild.id, {
        userId, species: picked.name, amount: price, correlationId, occurrenceId: correlationId,
      });
    }

    // [game-economy-fishing] Append-only audit row for the catch state change
    // (records the catch + whether the auto-sell credit landed).
    await writeEconomyAudit(this.supabase, {
      guildId: this.guild.id, actorId: userId, operationId: correlationId,
      action: 'fishing.catch', details: { species: picked.name, rarity: picked.rarity, price, paid },
    });
    eventBus.emit('fishing.catch', this.guild.id, {
      userId,
      species: picked.name,
      rarity: picked.rarity,
      price,
      paid,
      correlationId,
      occurrenceId: correlationId,
    });

    return { species: picked, weight, price, paid };
  }

  /**
   * [game-economy-fishing] Raise a payout-degraded owner alert when a fish
   * auto-sell credit fails, so an operator knows unpaid catches exist. Best
   * effort — a failed alert never blocks the catch flow.
   */
  private async raisePayoutDegradedAlert(userId: string, amount: number): Promise<void> {
    await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType: 'fishing_payout_degraded',
      severity: 'warning',
      title: 'Fishing payout degraded',
      message: `A fishing auto-sell credit of ${amount} failed for ${userId}. The catch is recorded unpaid and will be retried.`,
      metadata: { user_id: userId, amount },
      guild: this.guild,
    });
  }

  /**
   * [game-economy-fishing] Operator/periodic retry sweep for catches whose
   * auto-sell credit failed (paid=false). Uses an atomic claim (flip false→true,
   * returning the claimed row) so only ONE worker credits a given row; on a
   * credit failure the flag is reverted to false so a later sweep retries. This
   * makes re-crediting idempotent — a row is only ever credited while unpaid.
   * Returns the number of catches successfully settled.
   */
  async retryUnpaidPayouts(limit = 100): Promise<number> {
    const { data: unpaid } = await this.supabase
      .from('economy_fish_catches')
      .select('id, user_id, price_earned, correlation_id')
      .eq('guild_id', this.guild.id)
      .eq('paid', false)
      .limit(limit);

    let settled = 0;
    for (const row of (unpaid ?? []) as Array<{ id: string; user_id: string; price_earned: number; correlation_id: string | null }>) {
      // Atomic claim: only the writer that flips false→true proceeds to credit.
      const { data: claimed } = await this.supabase
        .from('economy_fish_catches')
        .update({ paid: true })
        .eq('id', row.id)
        .eq('paid', false)
        .select('id');
      if (!claimed || claimed.length === 0) continue; // another worker took it

      const ok = await this.addCurrency(row.user_id, row.price_earned, row.correlation_id ?? `retry:${row.id}`);
      if (ok) {
        settled++;
        const operationId = `retry:${row.id}`;
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: row.user_id, operationId,
          action: 'fishing.catch_payout_retried', details: { catchId: row.id, amount: row.price_earned }, actorType: 'system',
        });
      } else {
        // Credit failed after the claim — revert so a later sweep retries.
        await this.supabase.from('economy_fish_catches')
          .update({ paid: false }).eq('id', row.id);
        const operationId = `retry:${row.id}`;
        await writeEconomyAudit(this.supabase, {
          guildId: this.guild.id, actorId: row.user_id, operationId,
          action: 'fishing.catch_payout_failed', details: { catchId: row.id, amount: row.price_earned }, success: false, actorType: 'system',
        });
      }
    }
    return settled;
  }

  // ── Sell fish from bucket ─────────────────────────────

  async sellAll(userId: string): Promise<EmbedBuilder> {
    // Fish auto-sell on catch, so /fish sell is an alias for viewing earnings
    const { data, count } = await this.supabase
      .from('economy_fish_catches')
      .select('price_earned', { count: 'exact' })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .limit(1000);

    const totalEarned = (data ?? []).reduce((sum: number, c: any) => sum + (c.price_earned ?? 0), 0);
    const kit = (await this.getConfig()).brandKit;
    return brandedEmbed(kit, {
      intent: 'info',
      title: '🐟 Fishing Summary',
      description:
        `You've caught **${count ?? 0}** fish total.\n` +
        `Total earnings: 💰 **${totalEarned.toLocaleString()}** ${kit.currencyName}.`,
    });
  }

  // ── Collection ────────────────────────────────────────

  /**
   * [game-economy-fishing] Pay the one-time collection completion bonus when a
   * member has caught every active species. The per-member fence table
   * (economy_fish_collection_rewards, PK guild_id+user_id) makes the payout
   * idempotent: the upsert with ignoreDuplicates only returns a row the first
   * time, so the bonus is credited at most once. Returns the coins paid, or null
   * when the reward is disabled, the collection is incomplete, already claimed,
   * or the credit failed (in which case the fence is rolled back so it retries).
   */
  private async maybePayCollectionReward(userId: string, operationId?: string): Promise<{ coins: number } | null> {
    const correlationId = operationId?.trim() || randomUUID();
    const config = await this.getConfig();
    if (!config.economy_fishing_collection_reward_enabled) return null;

    const species = await this.getSpecies();
    // Unreadable catalog (outage) → skip the bonus check; the fence row was
    // not claimed, so a later healthy catch re-checks ([game-economy-fishing]).
    if (!species) return null;
    const activeCount = species.length;
    if (activeCount === 0) return null;

    const { data: caught, error: caughtErr } = await this.supabase
      .from('economy_fish_catches')
      .select('species_id')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .limit(10000);
    // A failed catch-history read must not decide "collection incomplete" from
    // fabricated emptiness — but the safe outcome is the same: no payout now.
    if (caughtErr) return null;

    const activeIds = new Set(species.map((s) => s.id));
    const discovered = new Set(
      ((caught ?? []) as { species_id: string }[])
        .map((c) => c.species_id)
        .filter((id) => activeIds.has(id)),
    );
    if (discovered.size < activeCount) return null;

    // One-time fence: the primary key makes this claim idempotent under
    // concurrent catches. ignoreDuplicates → a conflict returns zero rows.
    const { data: claimedRows } = await this.supabase
      .from('economy_fish_collection_rewards')
      .upsert({ guild_id: this.guild.id, user_id: userId }, { onConflict: 'guild_id,user_id', ignoreDuplicates: true })
      .select('user_id');
    if (!claimedRows || claimedRows.length === 0) return null; // already rewarded

    const coins = config.economy_fishing_collection_reward_coins ?? 5000;
    const paid = await this.addCurrency(userId, coins, `${correlationId}:collection`);
    if (!paid) {
      // Roll back the fence so the bonus is retried; never mark rewarded-but-unpaid.
      await this.supabase.from('economy_fish_collection_rewards')
        .delete().eq('guild_id', this.guild.id).eq('user_id', userId);
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: `${correlationId}:collection`,
        action: 'fishing.collection_reward_retried', details: { amount: coins }, success: false, actorType: 'system',
      });
      eventBus.emit('fishing.collection_reward_retried', this.guild.id, {
        userId, amount: coins, correlationId: `${correlationId}:collection`, occurrenceId: `${correlationId}:collection`,
      });
      return null;
    }
    await writeEconomyAudit(this.supabase, {
      guildId: this.guild.id, actorId: userId, operationId: `${correlationId}:collection`,
      action: 'fishing.collection_reward', details: { amount: coins },
    });
    return { coins };
  }

  async getCollection(userId: string): Promise<EmbedBuilder> {
    // [game-economy-fishing DEPFAIL] With the database unreachable neither the
    // species catalog nor the catch history can be read — degrade with the
    // branded notice, never render "No species available" / "not caught yet"
    // fabricated from the failed reads.
    const species = await this.getSpecies();
    if (!species) {
      return this.unavailableEmbed();
    }
    const { data: catches, error: catchesErr } = await this.supabase
      .from('economy_fish_catches')
      .select('species_id, weight')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .limit(1000);
    if (catchesErr) {
      return this.unavailableEmbed();
    }

    const caught = new Map<string, { count: number; maxWeight: number }>();
    for (const c of (catches ?? []) as { species_id: string; weight: number }[]) {
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

    return applyBrand(
      new EmbedBuilder()
        .setTitle('📖 Fish Collection')
        .setDescription(lines.join('\n') || 'No species available.')
        .setFooter({ text: `${caught.size}/${species.length} species discovered` }),
      (await this.getConfig()).brandKit,
      { intent: 'info' },
    );
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

    return brandedEmbed((await this.getConfig()).brandKit, {
      intent: 'warning',
      title: '🏆 Fishing Leaderboard — Heaviest Catches',
      description: lines.join('\n') || 'No catches yet!',
    });
  }

  // ── Helpers ───────────────────────────────────────────

  // V52-M2: return boolean so callers can detect and surface wallet failures
  // instead of silently losing coins.
  private async addCurrency(userId: string, amount: number, idempotencyKey?: string): Promise<boolean> {
    const { error } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: amount,
      ...(idempotencyKey ? { p_idempotency_key: idempotencyKey } : {}),
    });
    if (error) {
      log.error(`economy_add_balance failed for ${userId}:`, error.message);
      return false;
    }
    return true;
  }
  /**
   * Seed this feature's default content now instead of on first command use.
   *
   * The defaults below always existed, but they were planted lazily: nothing
   * appeared until somebody ran the feature's command in Discord, so a fresh
   * install showed an empty dashboard page for a feature that claimed to be
   * on. Guild init calls this so content exists before anyone touches
   * anything. Idempotent — it only writes when the guild has NO rows at all
   * (an all-deactivated catalog is respected owner state). Throws when the
   * gate read or the seed write failed so the warmup can report degradation.
   */
  async ensureContentSeeded(): Promise<void> {
    await this.seedIfCatalogEmpty();
  }
}
