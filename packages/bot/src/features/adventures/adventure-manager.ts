/**
 * AdventureManager — interactive story-driven adventures with choices.
 *
 * Players use Adventure Tickets, navigate scenes with Discord buttons,
 * collect loot, and face outcomes (success/death/partial).
 *
 * IMPORTANT: This is the FAKE economy (virtual adventures).
 */

import { randomPick, randomChance } from '../../utils/random.js';
import {
  type Guild,
  type ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getQuestsManager } from '../quests/quests-manager.js';
import type {
  AdventureChoice,
  AdventureEndingType,
  AdventureSceneLoot,
} from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import { eventBus } from '../../services/event-bus.js';
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

const log = createLogger('Adventures');

// ── Local Types ───────────────────────────────────────────

interface AdventureConfig {
  economy_adventures_enabled: boolean;
  economy_adventure_daily_limit: number;
  economy_adventure_ticket_cost: number;
  economy_adventure_max_scenes: number;
  /** White-label brand kit projected from the same cached guild_config row. */
  brandKit: BrandKit;
}

interface Adventure {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  adventure_type: string;
  difficulty: string;
  min_scenes: number;
  max_scenes: number;
}

interface Scene {
  id: string;
  adventure_id: string;
  scene_index: number;
  text: string;
  image_url: string | null;
  choices: AdventureChoice[];
  loot: AdventureSceneLoot[];
  is_ending: boolean;
  ending_type: AdventureEndingType | null;
}

interface Session {
  id: string;
  user_id: string;
  adventure_id: string;
  current_scene_id: string | null;
  status: string;
  loot_collected: { item_name: string; qty: number }[];
  currency_collected: number;
  message_id: string | null;
  channel_id: string | null;
  scenes_traversed?: number;
}

// ── Difficulty Multipliers ────────────────────────────────

const DIFFICULTY_MULTIPLIER: Record<string, number> = {
  easy: 0.8,
  normal: 1.0,
  hard: 1.5,
  legendary: 2.5,
};

// ── Default Adventures ────────────────────────────────────

interface DefaultAdventure {
  name: string;
  emoji: string;
  description: string;
  adventure_type: string;
  difficulty: string;
  scenes: {
    text: string;
    choices: AdventureChoice[];
    loot: AdventureSceneLoot[];
    is_ending: boolean;
    ending_type: AdventureEndingType | null;
  }[];
}

const DEFAULT_ADVENTURES: DefaultAdventure[] = [
  {
    name: 'The Dark Dungeon',
    emoji: '🏰',
    description: 'Descend into a forgotten dungeon filled with traps and treasure.',
    adventure_type: 'dungeon',
    difficulty: 'normal',
    scenes: [
      {
        text: '🏰 You stand at the entrance of a dark dungeon. Cobwebs cover the archway and a cold draft blows from within. Two passages lead forward.',
        choices: [
          { label: 'Take the left passage', emoji: '⬅️', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null },
          { label: 'Take the right passage', emoji: '➡️', next_scene_index: 2, loot: [], currency: 0, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '⬅️ The left passage opens into a room with a locked chest. A rusty lever sits on the wall.',
        choices: [
          { label: 'Pull the lever', emoji: '🔧', next_scene_index: 3, loot: [{ item_name: 'Iron Ingot', qty: 2, chance_pct: 80 }], currency: 50, damage_pct: 0, requires_item: null },
          { label: 'Try to pick the lock', emoji: '🔑', next_scene_index: 4, loot: [], currency: 0, damage_pct: 20, requires_item: null },
        ],
        loot: [{ item_name: 'Torch', qty: 1, chance_pct: 100 }],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '➡️ The right passage slopes downward. You hear growling echoes. Bones are scattered across the floor.',
        choices: [
          { label: 'Sneak forward', emoji: '🤫', next_scene_index: 4, loot: [], currency: 100, damage_pct: 0, requires_item: null },
          { label: 'Charge in boldly', emoji: '⚔️', next_scene_index: 5, loot: [], currency: 0, damage_pct: 30, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🔧 The lever opens a hidden compartment! Gold coins spill out and you find crafting materials.',
        choices: [],
        loot: [{ item_name: 'Gold Nugget', qty: 3, chance_pct: 60 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '🤫 You manage to sneak past the creature and discover a hidden vault filled with ancient relics!',
        choices: [],
        loot: [{ item_name: 'Ancient Relic', qty: 1, chance_pct: 50 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '💀 The creature overpowers you! You barely escape with your life, dropping all your collected items.',
        choices: [],
        loot: [],
        is_ending: true,
        ending_type: 'death',
      },
    ],
  },
  {
    name: 'Enchanted Forest',
    emoji: '🌲',
    description: 'Explore a mystical forest where every path leads to wonder—or danger.',
    adventure_type: 'forest',
    difficulty: 'easy',
    scenes: [
      {
        text: '🌲 You enter a sun-dappled forest clearing. A fairy hovers nearby, offering guidance. A dark path leads deeper into the woods.',
        choices: [
          { label: 'Follow the fairy', emoji: '🧚', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null },
          { label: 'Take the dark path', emoji: '🌑', next_scene_index: 2, loot: [], currency: 0, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🧚 The fairy leads you to a grove of glowing mushrooms. "Take what you need," she says. The mushrooms look magical.',
        choices: [
          { label: 'Harvest carefully', emoji: '🍄', next_scene_index: 3, loot: [{ item_name: 'Magic Mushroom', qty: 3, chance_pct: 90 }], currency: 30, damage_pct: 0, requires_item: null },
          { label: 'Take them all!', emoji: '💰', next_scene_index: 4, loot: [{ item_name: 'Magic Mushroom', qty: 8, chance_pct: 100 }], currency: 0, damage_pct: 50, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🌑 The dark path winds deeper. You stumble upon a sleeping dragon curled around a treasure hoard.',
        choices: [
          { label: 'Sneak past and grab treasure', emoji: '🤫', next_scene_index: 3, loot: [{ item_name: 'Dragon Scale', qty: 1, chance_pct: 40 }], currency: 200, damage_pct: 0, requires_item: null },
          { label: 'Wake the dragon', emoji: '🐉', next_scene_index: 4, loot: [], currency: 0, damage_pct: 60, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '✨ You emerge from the forest with your prizes! The fairy waves goodbye as sunlight breaks through.',
        choices: [],
        loot: [{ item_name: 'Forest Crystal', qty: 1, chance_pct: 30 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '💀 Greed got the better of you... you flee the forest empty-handed, losing everything you brought.',
        choices: [],
        loot: [],
        is_ending: true,
        ending_type: 'death',
      },
    ],
  },
  {
    name: 'Deep Sea Dive',
    emoji: '🌊',
    description: 'Dive beneath the waves to discover sunken treasures and sea monsters.',
    adventure_type: 'ocean',
    difficulty: 'normal',
    scenes: [
      {
        text: '🌊 You dive beneath the waves. A sunken ship lies ahead, and a glowing cave pulses with light to your left.',
        choices: [
          { label: 'Explore the shipwreck', emoji: '🚢', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null },
          { label: 'Enter the glowing cave', emoji: '✨', next_scene_index: 2, loot: [], currency: 0, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: "🚢 Inside the ship you find a captain's chest, but a giant eel guards it.",
        choices: [
          { label: 'Distract the eel', emoji: '🐟', next_scene_index: 3, loot: [{ item_name: 'Pearl', qty: 2, chance_pct: 70 }], currency: 150, damage_pct: 0, requires_item: null },
          { label: 'Fight the eel', emoji: '⚔️', next_scene_index: 4, loot: [{ item_name: 'Eel Fang', qty: 1, chance_pct: 60 }], currency: 75, damage_pct: 40, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '✨ The cave is home to a mermaid who offers you a gift in exchange for a story.',
        choices: [
          { label: 'Tell a tale', emoji: '📖', next_scene_index: 3, loot: [{ item_name: 'Trident Shard', qty: 1, chance_pct: 50 }], currency: 100, damage_pct: 0, requires_item: null },
          { label: 'Steal her treasure', emoji: '💎', next_scene_index: 4, loot: [{ item_name: 'Mermaid Tear', qty: 1, chance_pct: 80 }], currency: 300, damage_pct: 50, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🎉 You surface with your treasures! The sun glints off your newfound riches.',
        choices: [],
        loot: [{ item_name: 'Coral Fragment', qty: 2, chance_pct: 60 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '💀 The depths claim their toll... you barely make it back to the surface, but your pockets are empty.',
        choices: [],
        loot: [],
        is_ending: true,
        ending_type: 'death',
      },
    ],
  },
  {
    name: 'Space Station Omega',
    emoji: '🚀',
    description: 'Board an abandoned space station to salvage alien technology.',
    adventure_type: 'space',
    difficulty: 'hard',
    scenes: [
      {
        text: '🚀 You dock at Space Station Omega. The lights flicker. Two corridors branch from the airlock: Engineering and the Command Bridge.',
        choices: [
          { label: 'Go to Engineering', emoji: '⚙️', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null },
          { label: 'Head to the Bridge', emoji: '🖥️', next_scene_index: 2, loot: [], currency: 0, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '⚙️ Engineering is filled with sparking wires. An alien device hums on a workbench. The reactor core glows dangerously.',
        choices: [
          { label: 'Salvage the device', emoji: '🔧', next_scene_index: 3, loot: [{ item_name: 'Alien Tech', qty: 1, chance_pct: 70 }], currency: 200, damage_pct: 0, requires_item: null },
          { label: 'Overload the reactor', emoji: '☢️', next_scene_index: 4, loot: [{ item_name: 'Reactor Core', qty: 1, chance_pct: 30 }], currency: 500, damage_pct: 60, requires_item: null },
        ],
        loot: [{ item_name: 'Scrap Metal', qty: 3, chance_pct: 100 }],
        is_ending: false,
        ending_type: null,
      },
      {
        text: "🖥️ The Bridge's main screen flickers on: 'INTRUDER DETECTED.' Defense turrets whir to life.",
        choices: [
          { label: 'Hack the system', emoji: '💻', next_scene_index: 3, loot: [{ item_name: 'Data Chip', qty: 2, chance_pct: 80 }], currency: 300, damage_pct: 0, requires_item: null },
          { label: 'Dodge and grab', emoji: '🏃', next_scene_index: 5, loot: [], currency: 100, damage_pct: 40, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🎉 Mission complete! You escape the station with valuable salvage as it crumbles behind you.',
        choices: [],
        loot: [{ item_name: 'Star Fragment', qty: 1, chance_pct: 40 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '💀 The reactor explodes! You eject in an escape pod but lose everything in the blast.',
        choices: [],
        loot: [],
        is_ending: true,
        ending_type: 'death',
      },
      {
        text: '⚠️ You escape with minor injuries and a few scraps. Not great, not terrible.',
        choices: [],
        loot: [{ item_name: 'Scrap Metal', qty: 1, chance_pct: 100 }],
        is_ending: true,
        ending_type: 'partial',
      },
    ],
  },
  {
    name: 'Mountain Expedition',
    emoji: '⛰️',
    description: 'Scale a treacherous mountain to reach the legendary summit shrine.',
    adventure_type: 'mountain',
    difficulty: 'normal',
    scenes: [
      {
        text: '⛰️ The mountain towers above. A well-worn trail leads upward, while a narrow cliffside path promises a shortcut.',
        choices: [
          { label: 'Take the trail', emoji: '🥾', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null },
          { label: 'Risk the cliffside', emoji: '🧗', next_scene_index: 2, loot: [], currency: 0, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🥾 Halfway up the trail, you find a mountain hermit selling supplies. A cave entrance is nearby.',
        choices: [
          { label: 'Trade with the hermit', emoji: '🧙', next_scene_index: 3, loot: [{ item_name: 'Healing Herb', qty: 2, chance_pct: 90 }], currency: 20, damage_pct: 0, requires_item: null },
          { label: 'Explore the cave', emoji: '🕳️', next_scene_index: 4, loot: [{ item_name: 'Crystal Geode', qty: 1, chance_pct: 60 }], currency: 80, damage_pct: 15, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🧗 The cliffside path is harrowing! One wrong step and... but the view is incredible. You see a hidden ledge with a chest.',
        choices: [
          { label: 'Reach for the chest', emoji: '📦', next_scene_index: 3, loot: [{ item_name: 'Mountain Gem', qty: 1, chance_pct: 50 }], currency: 150, damage_pct: 20, requires_item: null },
          { label: 'Keep climbing', emoji: '⬆️', next_scene_index: 4, loot: [], currency: 50, damage_pct: 0, requires_item: null },
        ],
        loot: [],
        is_ending: false,
        ending_type: null,
      },
      {
        text: '🏔️ You reach the summit shrine! A brilliant light fills the air and the mountain rewards your perseverance.',
        choices: [],
        loot: [{ item_name: 'Summit Stone', qty: 1, chance_pct: 45 }],
        is_ending: true,
        ending_type: 'success',
      },
      {
        text: '🌨️ A sudden blizzard forces you to shelter. You survive, but lose some supplies along the way.',
        choices: [],
        loot: [{ item_name: 'Frost Crystal', qty: 1, chance_pct: 70 }],
        is_ending: true,
        ending_type: 'partial',
      },
    ],
  },
];

// ── Manager ───────────────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, AdventureManager>();

export function registerAdventureManager(mgr: AdventureManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterAdventureManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateAdventureCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateCache();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateCache();
  }
}

export function getAdventureManager(guildId?: string): AdventureManager | null {
  if (guildId) return _managers.get(guildId) ?? null;
  // Fallback: return first registered (single-guild compat)
  return _managers.values().next().value ?? null;
}

export class AdventureManager {
  private guild: Guild;
  private supabase: SupabaseClient;
  private valkey: Valkey;
  private configCache: AdventureConfig | null = null;
  private adventureCache: Adventure[] | null = null;

  constructor(guild: Guild, supabase: SupabaseClient, valkey: Valkey) {
    this.guild = guild;
    this.supabase = supabase;
    this.valkey = valkey;
  }

  invalidateCache(): void {
    this.configCache = null;
    this.adventureCache = null;
  }

  /**
   * [game-economy-adventures DEPFAIL] Outage-aware config read. A FAILED read
   * (database unreachable) is NOT "adventures disabled" — the disabled
   * fallback fabricated from a failed read told members a data-shaped lie AND
   * was cached, pinning adventures off long after the outage ended. A failed
   * read is never cached and surfaces `unavailable` so callers degrade
   * honestly. A missing row (PGRST116) keeps the legitimate default.
   */
  private async getConfigChecked(): Promise<{ config: AdventureConfig; unavailable: boolean }> {
    if (this.configCache) return { config: this.configCache, unavailable: false };
    const { data, error } = await this.supabase
      .from('guild_config')
      .select(`economy_adventures_enabled, economy_adventure_daily_limit, economy_adventure_ticket_cost, economy_adventure_max_scenes, ${BRAND_KIT_COLUMNS}`)
      .eq('guild_id', this.guild.id)
      .single();
    const row = (data ?? null) as (Record<string, unknown> | null);
    const config: AdventureConfig = {
      economy_adventures_enabled: (row?.economy_adventures_enabled as boolean | undefined) ?? false,
      economy_adventure_daily_limit: (row?.economy_adventure_daily_limit as number | undefined) ?? 3,
      economy_adventure_ticket_cost: (row?.economy_adventure_ticket_cost as number | undefined) ?? 100,
      economy_adventure_max_scenes: (row?.economy_adventure_max_scenes as number | undefined) ?? 10,
      brandKit: brandKitFromConfig(row, this.guild.name),
    };
    if (error && error.code !== 'PGRST116') {
      return { config, unavailable: true };
    }
    this.configCache = config;
    return { config, unavailable: false };
  }

  private async getConfig(): Promise<AdventureConfig> {
    return (await this.getConfigChecked()).config;
  }

  /**
   * The guild's active adventures, or `null` when the READ FAILED (database
   * unreachable). A failed read is never cached — caching the fabricated
   * empty list would break every post-outage start
   * ([game-economy-adventures DEPFAIL]).
   *
   * Seeding is gated on the guild having NO adventure rows at all (active or
   * not): an owner who deactivated the entire catalog made a deliberate call
   * that is never overwritten with restored defaults.
   */
  private async getAdventures(): Promise<Adventure[] | null> {
    // A cached [] is a legitimate empty catalog (owner deactivated every
    // adventure) — only null means "not loaded yet".
    if (this.adventureCache !== null) return this.adventureCache;
    const { data, error } = await this.supabase
      .from('economy_adventures')
      .select('id, name, emoji, description, adventure_type, difficulty, min_scenes, max_scenes')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);

    if (error) {
      log.error('getAdventures read failed:', error.message);
      return null;
    }
    if (data && data.length > 0) {
      this.adventureCache = data as Adventure[];
      return this.adventureCache;
    }

    // No ACTIVE adventures — seed only when the guild has none AT ALL.
    let seededNow = false;
    try {
      seededNow = await this.seedIfCatalogEmpty();
    } catch (err) {
      // Gate read or seed write failed — never cache the fabricated empty
      // catalog ([game-economy-adventures DEPFAIL]).
      log.error('adventure seeding failed:', (err as Error).message);
      return null;
    }
    if (!seededNow) {
      this.adventureCache = []; // deactivate-all is respected owner state
      return this.adventureCache;
    }

    const { data: seeded, error: seededErr } = await this.supabase
      .from('economy_adventures')
      .select('id, name, emoji, description, adventure_type, difficulty, min_scenes, max_scenes')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .limit(1000);
    if (seededErr) {
      log.error('getAdventures post-seed read failed:', seededErr.message);
      return null;
    }
    this.adventureCache = (seeded ?? []) as Adventure[];
    return this.adventureCache;
  }

  /**
   * [game-economy-adventures DEPFAIL] The branded adventures-unavailable
   * degradation embed. The brand read is itself outage-safe (resolveBrandKit
   * never throws and is additionally .catch-guarded), falling back to the
   * guild name.
   */
  private async unavailableEmbed(detail: string): Promise<EmbedBuilder> {
    const brandKit = await resolveBrandKit(this.supabase, this.guild.id, {
      fallbackName: this.guild.name,
    }).catch(() => null);
    const kit = brandKit ?? defaultBrandKit(this.guild.name);
    const name = brandKit?.brandName ?? this.guild.name ?? 'this server';
    return brandedEmbed(kit, {
      intent: 'warning',
      description:
        `${voice(kit.voicePreset, 'unavailable', { brand: name, feature: 'adventures' })} ${detail}`,
    });
  }

  /** Best-effort ticket refund for start paths that abort after the debit. */
  private async refundTicket(userId: string, ticketCost: number): Promise<void> {
    if (ticketCost <= 0) return;
    await Promise.resolve(this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: ticketCost,
    })).catch((e: unknown) => { log.warn('ticket refund failed:', (e as Error)?.message ?? e); });
  }

  /**
   * Seed the default adventures when the guild has NO adventure rows (active
   * or not). Returns true when defaults were written. Throws when the
   * existence check or any write failed, so callers (warmup, getAdventures)
   * can report the failure instead of silently proceeding.
   */
  private async seedIfCatalogEmpty(): Promise<boolean> {
    const { count, error } = await this.supabase
      .from('economy_adventures')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id);
    if (error) {
      throw new Error(`adventure existence check failed: ${error.message}`);
    }
    if ((count ?? 0) > 0) return false; // owner content (even all-inactive) — never touch it
    await this.seedDefaults();
    return true;
  }

  private async seedDefaults(): Promise<void> {
    for (const def of DEFAULT_ADVENTURES) {
      // ON CONFLICT DO NOTHING: the (guild_id, lower(name)) uniqueness index
      // turns a concurrent double-seed into a no-op (no row returned) instead
      // of a duplicate adventure with a second scene set.
      const { data, error } = await this.supabase
        .from('economy_adventures')
        .upsert({
          guild_id: this.guild.id,
          name: def.name,
          emoji: def.emoji,
          description: def.description,
          adventure_type: def.adventure_type,
          difficulty: def.difficulty,
          min_scenes: def.scenes.length,
          max_scenes: def.scenes.length,
          is_default: true,
        }, { ignoreDuplicates: true })
        .select('id')
        .maybeSingle();
      if (error) {
        throw new Error(`default adventure "${def.name}" seed failed: ${error.message}`);
      }
      if (!data) continue; // lost a seed race — the other writer plants the scenes

      const sceneRows = def.scenes.map((s, i) => ({
        adventure_id: (data as Record<string, unknown>).id as string,
        scene_index: i,
        text: s.text,
        choices: s.choices,
        loot: s.loot,
        is_ending: s.is_ending,
        ending_type: s.ending_type,
      }));
      const { error: scenesErr } = await this.supabase
        .from('economy_adventure_scenes')
        .insert(sceneRows);
      if (scenesErr) {
        throw new Error(`scenes for default adventure "${def.name}" failed: ${scenesErr.message}`);
      }
    }
  }

  // ── Start Adventure ─────────────────────────────────────

  async startAdventure(
    userId: string,
    adventureType?: string,
    interactionId?: string,
  ): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null; sessionId: string | null }> {
    // [game-economy-adventures DEPFAIL] Check the READ ERROR first: with the
    // database unreachable the config read fails — degrade with the branded
    // adventures-unavailable notice instead of the fabricated "not enabled"
    // answer (and never cache the fabricated fallback).
    const { config, unavailable: configUnavailable } = await this.getConfigChecked();
    if (configUnavailable) {
      return {
        embed: await this.unavailableEmbed('No ticket was charged.'),
        row: null,
        sessionId: null,
      };
    }
    if (!config.economy_adventures_enabled) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '🚫 Adventures are not enabled.',
        }),
        row: null,
        sessionId: null,
      };
    }

    // Check daily limit. [game-economy-adventures DEPFAIL] A failed count read
    // is not "0 runs today" — abort before any charge rather than proceed on
    // fabricated state.
    const today = new Date().toISOString().slice(0, 10);
    const { count, error: limitErr } = await this.supabase
      .from('economy_adventure_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gte('started_at', `${today}T00:00:00Z`);

    if (limitErr) {
      return {
        embed: await this.unavailableEmbed('No ticket was charged.'),
        row: null,
        sessionId: null,
      };
    }

    if ((count ?? 0) >= config.economy_adventure_daily_limit) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'warning',
          description: `⏳ You've used all **${config.economy_adventure_daily_limit}** adventures today. Come back tomorrow!`,
        }),
        row: null,
        sessionId: null,
      };
    }

    // Check active session. Same rule: a failed read is not "no active run".
    const { data: active, error: activeErr } = await this.supabase
      .from('economy_adventure_sessions')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (activeErr) {
      return {
        embed: await this.unavailableEmbed('No ticket was charged.'),
        row: null,
        sessionId: null,
      };
    }

    if (active && active.length > 0) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'warning',
          description: '⚠️ You already have an active adventure! Finish it first.',
        }),
        row: null,
        sessionId: null,
      };
    }

    // Interaction-scoped fence, claimed BEFORE the ticket is charged. A
    // redelivered /adventure would otherwise debit a second ticket and open a
    // second session. FAIL-SAFE: charging twice is worse than refusing.
    if (interactionId) {
      const claim = await claimOccurrence(
        this.valkey,
        `economy:adventure:idem:${interactionId}`,
        { onUnavailable: 'decline' },
      );
      if (claim === 'replay') {
        return {
          embed: brandedEmbed(config.brandKit, {
            intent: 'warning',
            description: '⏳ That adventure was already started.',
          }),
          row: null,
          sessionId: null,
        };
      }
    }

    // Charge ticket cost (atomic RPC prevents race conditions / negative balances)
    if (config.economy_adventure_ticket_cost > 0) {
      const { error: debitErr } = await this.supabase.rpc('economy_subtract_balance', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_amount: config.economy_adventure_ticket_cost,
      });

      if (debitErr) {
        // [game-economy-adventures DEPFAIL] Only a genuine insufficient-funds
        // rejection may say "you don't have enough" — a network/RPC failure is
        // an outage and must degrade honestly (no debit landed; nothing moved).
        if (!/insufficient/i.test(debitErr.message ?? '')) {
          return {
            embed: await this.unavailableEmbed('No ticket was charged.'),
            row: null,
            sessionId: null,
          };
        }
        return {
          embed: brandedEmbed(config.brandKit, {
            intent: 'danger',
            description: `💰 Adventures cost **${config.economy_adventure_ticket_cost}** ${config.brandKit.currencyName}. You don't have enough!`,
          }),
          row: null,
          sessionId: null,
        };
      }
    }

    // Pick adventure. [game-economy-adventures DEPFAIL] An unreadable (or
    // empty) catalog after the debit refunds the ticket — previously
    // randomPick on the fabricated empty list crashed the start.
    const adventures = await this.getAdventures();
    if (!adventures || adventures.length === 0) {
      await this.refundTicket(userId, config.economy_adventure_ticket_cost);
      return {
        embed: await this.unavailableEmbed('Your ticket has been refunded.'),
        row: null,
        sessionId: null,
      };
    }
    let candidates = adventures;
    if (adventureType) {
      const filtered = adventures.filter((a) => a.adventure_type === adventureType);
      if (filtered.length > 0) candidates = filtered;
    }
    const adventure = randomPick(candidates);

    // Get first scene (maybeSingle so a READ ERROR is distinguishable from a
    // genuinely missing scene row).
    const { data: firstScene, error: sceneErr } = await this.supabase
      .from('economy_adventure_scenes')
      .select('*')
      .eq('adventure_id', adventure.id)
      .eq('scene_index', 0)
      .maybeSingle();

    if (sceneErr) {
      await this.refundTicket(userId, config.economy_adventure_ticket_cost);
      return {
        embed: await this.unavailableEmbed('Your ticket has been refunded.'),
        row: null,
        sessionId: null,
      };
    }

    if (!firstScene) {
      // V49-L4-adjacent: refund the already-charged ticket — a misconfigured
      // adventure must not eat the member's play coins.
      await this.refundTicket(userId, config.economy_adventure_ticket_cost);
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '❌ Adventure has no scenes configured. Your ticket has been refunded.',
        }),
        row: null,
        sessionId: null,
      };
    }

    const scene = firstScene as Scene;

    // V49-C6: Create session — catch 23505 (unique violation) from the
    // partial unique index `uniq_active_adventure_session_per_user`.
    // Two concurrent /adventure commands can both pass the active-session
    // check above, but only one INSERT succeeds.
    const { data: session, error: sessErr } = await this.supabase
      .from('economy_adventure_sessions')
      .insert({
        guild_id: this.guild.id,
        user_id: userId,
        adventure_id: adventure.id,
        current_scene_id: scene.id,
        status: 'active',
        loot_collected: [],
        currency_collected: 0,
        items_brought: [],
      })
      .select('id')
      .single();

    if (sessErr) {
      // V49-L4: Refund ticket cost on session creation failure
      if (config.economy_adventure_ticket_cost > 0) {
        await Promise.resolve(this.supabase.rpc('economy_add_balance', {
          p_guild_id: this.guild.id,
          p_user_id: userId,
          p_amount: config.economy_adventure_ticket_cost,
        })).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
      }

      // Duplicate key → another concurrent command won the race
      const isDupe = sessErr.code === '23505' || sessErr.message?.includes('duplicate');
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: isDupe ? 'warning' : 'danger',
          description: isDupe
            ? '⚠️ You already have an active adventure! Finish it first.'
            : `❌ Failed to start adventure — your ${config.brandKit.currencyName} have been refunded.`,
        }),
        row: null,
        sessionId: null,
      };
    }

    const sessionId = (session as Record<string, unknown> | null)?.id as string | null;

    // [game-economy-adventures] Append-only audit row for the adventure start
    // state change (ticket charged, session opened).
    eventBus.emit('adventure.started', this.guild.id, {
      userId,
      adventureId: adventure.id,
      adventureName: adventure.name,
      ticketCost: config.economy_adventure_ticket_cost,
      sessionId,
    });

    // Build embed + buttons
    const { embed, row } = this.buildSceneEmbed(adventure, scene, sessionId, 0, config.brandKit);
    return { embed, row, sessionId };
  }

  // ── Handle Button Choice ────────────────────────────────

  async handleChoice(
    interaction: ButtonInteraction,
    sessionId: string,
    choiceIndex: number,
  ): Promise<void> {
    // Brand kit off the same cached config row the start path uses.
    const kit = (await this.getConfig()).brandKit;
    const { data: session } = await this.supabase
      .from('economy_adventure_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!session || (session as Record<string, unknown>).status !== 'active') {
      await interaction.reply({ content: '❌ This adventure has ended.', ephemeral: true });
      return;
    }

    const sess = session as Session;
    if (sess.user_id !== interaction.user.id) {
      await interaction.reply({ content: '❌ This is not your adventure!', ephemeral: true });
      return;
    }

    // Get current scene
    const { data: currentScene } = await this.supabase
      .from('economy_adventure_scenes')
      .select('*')
      .eq('id', sess.current_scene_id)
      .single();

    if (!currentScene) {
      await interaction.reply({ content: '❌ Scene not found.', ephemeral: true });
      return;
    }

    const scene = currentScene as Scene;
    const choice = scene.choices[choiceIndex];
    if (!choice) {
      await interaction.reply({ content: '❌ Invalid choice.', ephemeral: true });
      return;
    }

    // Process choice rewards
    const lootCollected = [...sess.loot_collected];
    let currencyCollected = sess.currency_collected;

    // Add currency from choice
    if (choice.currency > 0) {
      currencyCollected += choice.currency;
    }

    // Roll loot from choice
    for (const loot of choice.loot) {
      if (randomChance(loot.chance_pct)) {
        const existing = lootCollected.find((l) => l.item_name === loot.item_name);
        if (existing) existing.qty += loot.qty;
        else lootCollected.push({ item_name: loot.item_name, qty: loot.qty });
      }
    }

    // Navigate to next scene
    if (choice.next_scene_index === null) {
      // End adventure — same as ending scene
      await this.endSession(sess, 'completed', lootCollected, currencyCollected);
      const embed = brandedEmbed(kit, {
        intent: 'primary',
        title: '🏁 Adventure Complete!',
        description: this.buildRewardsSummary(lootCollected, currencyCollected),
      });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    const { data: nextScene } = await this.supabase
      .from('economy_adventure_scenes')
      .select('*')
      .eq('adventure_id', sess.adventure_id)
      .eq('scene_index', choice.next_scene_index)
      .single();

    if (!nextScene) {
      await this.endSession(sess, 'completed', lootCollected, currencyCollected);
      const embed = brandedEmbed(kit, {
        intent: 'primary',
        title: '🏁 Adventure Complete!',
        description: this.buildRewardsSummary(lootCollected, currencyCollected),
      });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    const next = nextScene as Scene;

    // Roll scene loot
    for (const loot of next.loot) {
      if (randomChance(loot.chance_pct)) {
        const existing = lootCollected.find((l) => l.item_name === loot.item_name);
        if (existing) existing.qty += loot.qty;
        else lootCollected.push({ item_name: loot.item_name, qty: loot.qty });
      }
    }

    // Count this scene against the configured cap. Once a run has traversed
    // economy_adventure_max_scenes scenes it is forced to an ending regardless
    // of the scene graph, so looping / overlong custom adventures always resolve
    // (adventure-max-scenes: "upper bound on scenes an adventure may traverse
    // before it is forced to an ending").
    const config = await this.getConfig();
    const scenesTraversed = (sess.scenes_traversed ?? 1) + 1;
    const capReached = scenesTraversed >= config.economy_adventure_max_scenes;

    // Update session
    await this.supabase
      .from('economy_adventure_sessions')
      .update({
        current_scene_id: next.id,
        loot_collected: lootCollected,
        currency_collected: currencyCollected,
        scenes_traversed: scenesTraversed,
      })
      .eq('id', sessionId);

    if (next.is_ending || capReached) {
      // A scene flagged as an ending resolves with its own ending_type; a run
      // forced to stop by the scene cap resolves as a success with what it has
      // collected (the member is not penalised for the owner's length bound).
      const endType: AdventureEndingType = next.is_ending ? (next.ending_type ?? 'success') : 'success';
      const finalLoot = endType === 'death' ? [] : endType === 'partial' ? lootCollected.slice(0, Math.ceil(lootCollected.length / 2)) : lootCollected;
      const finalCurrency = endType === 'death' ? 0 : endType === 'partial' ? Math.floor(currencyCollected / 2) : currencyCollected;

      await this.endSession(sess, endType === 'death' ? 'failed' : 'completed', finalLoot, finalCurrency);

      const color = endType === 'success' ? 0x4caf50 : endType === 'death' ? 0xf44336 : 0xff9800;
      const title = next.is_ending
        ? (endType === 'success' ? '🎉 Adventure Complete!' : endType === 'death' ? '💀 Adventure Failed!' : '⚠️ Partial Success')
        : '🏁 Journey\'s End';
      const capNote = next.is_ending ? '' : `\n\n_Your journey reached its end after ${config.economy_adventure_max_scenes} scenes._`;

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(next.text + capNote + '\n\n' + this.buildRewardsSummary(finalLoot, finalCurrency))
        .setColor(color);

      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    // Show next scene
    const { data: advData } = await this.supabase
      .from('economy_adventures')
      .select('name, emoji')
      .eq('id', sess.adventure_id)
      .single();

    const adv = advData as Adventure;
    const { embed, row } = this.buildSceneEmbed(adv, next, sessionId, lootCollected.length, kit);

    const updatePayload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } = { embeds: [embed], components: [] };
    if (row) updatePayload.components = [row];
    await interaction.update(updatePayload);
  }

  // ── Helpers ─────────────────────────────────────────────

  private buildSceneEmbed(
    adventure: Adventure,
    scene: Scene,
    sessionId: string | null,
    lootCount: number,
    kit: BrandKit,
  ): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null } {
    const embed = applyBrand(
      new EmbedBuilder()
        .setTitle(`${adventure.emoji} ${adventure.name}`)
        .setDescription(scene.text)
        .setFooter({ text: `Scene ${scene.scene_index + 1} • Items collected: ${lootCount}` }),
      kit,
      { intent: 'primary' },
    );

    if (scene.choices.length === 0) {
      return { embed, row: null };
    }

    const row = new ActionRowBuilder<ButtonBuilder>();
    scene.choices.forEach((choice, i) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`adventure:${sessionId}:${i}`)
          .setLabel(choice.label)
          .setEmoji(choice.emoji)
          .setStyle(ButtonStyle.Primary),
      );
    });

    return { embed, row };
  }

  private buildRewardsSummary(loot: { item_name: string; qty: number }[], currency: number): string {
    const lines: string[] = [];
    if (currency > 0) lines.push(`💰 **${currency.toLocaleString()}** coins`);
    for (const item of loot) {
      lines.push(`📦 **${item.item_name}** x${item.qty}`);
    }
    return lines.length > 0 ? '**Rewards:**\n' + lines.join('\n') : 'No rewards earned.';
  }

  private async endSession(
    session: Session,
    status: string,
    loot: { item_name: string; qty: number }[],
    currency: number,
  ): Promise<void> {
    // Update session
    await this.supabase
      .from('economy_adventure_sessions')
      .update({
        status,
        loot_collected: loot,
        currency_collected: currency,
        ended_at: new Date().toISOString(),
      })
      .eq('id', session.id);

    // V49-C7: Pay currency — check error and mark session as payout_failed
    // instead of silently swallowing. A failed payout should not disappear.
    if (currency > 0) {
      const { error: payErr } = await this.supabase.rpc('economy_add_balance', {
        p_guild_id: this.guild.id,
        p_user_id: session.user_id,
        p_amount: currency,
      });
      if (payErr) {
        log.error('endSession payout failed:', payErr.message);
        // Mark the session so admins can identify failed payouts and retry
        await this.supabase
          .from('economy_adventure_sessions')
          .update({ status: 'payout_failed' })
          .eq('id', session.id);
        // [game-economy-adventures] Owner alert + audit on the payout-failure
        // branch so the stranded (payout_failed) session is operator-visible.
        await this.raisePayoutFailedAlert(session.user_id, session.id, currency)
          .catch((e: unknown) => { log.warn('adventure payout alert failed:', (e as Error)?.message ?? e); });
        eventBus.emit('adventure.payout_failed', this.guild.id, {
          userId: session.user_id,
          sessionId: session.id,
          amount: currency,
        });
      }
    }

    // V53-C7: Add loot items — track failures and mark session accordingly
    let lootFailed = false;
    for (const item of loot) {
      const { data: found } = await this.supabase
        .from('economy_items')
        .select('id')
        .eq('guild_id', this.guild.id)
        .ilike('name', item.item_name)
        .limit(1);

      if (found && found.length > 0) {
        const { error: lootErr } = await this.supabase.rpc('economy_upsert_inventory', {
          p_guild_id: this.guild.id,
          p_user_id: session.user_id,
          p_item_id: (found[0] as Record<string, unknown>).id as string,
          p_quantity: item.qty,
        });
        if (lootErr) {
          log.error('loot upsert failed:', lootErr.message);
          lootFailed = true;
        }
      }
    }

    // Mark session with loot_failed so reconciliation / owner can investigate
    if (lootFailed) {
      await Promise.resolve(this.supabase.from('economy_adventure_sessions')
        .update({ loot_failed: true })
        .eq('id', session.id))
        .catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
    }

    // Quest progress — count completed adventures
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, session.user_id, 'adventure').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    // [game-economy-adventures] Append-only audit row for the adventure end
    // state change (economy movement: currency + loot delivered).
    eventBus.emit('adventure.completed', this.guild.id, {
      userId: session.user_id,
      sessionId: session.id,
      status,
      currency,
      lootCount: loot.length,
    });
  }

  /**
   * [game-economy-adventures] Raise a payout-failed owner alert so an operator
   * knows a finished adventure could not credit its coin reward (the session is
   * marked payout_failed for retry). Best effort — never blocks the flow.
   */
  private async raisePayoutFailedAlert(userId: string, sessionId: string, amount: number): Promise<void> {
    await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType: 'adventure_payout_failed',
      severity: 'warning',
      title: 'Adventure payout failed',
      message: `An adventure reward of ${amount} could not be credited to ${userId}. The session is marked payout_failed for retry.`,
      metadata: { user_id: userId, session_id: sessionId, amount },
      guild: this.guild,
    });
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
