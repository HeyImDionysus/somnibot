/**
 * AdventureManager — interactive story-driven adventures with choices.
 *
 * Players use Adventure Tickets, navigate scenes with Discord buttons,
 * collect loot, and face outcomes (success/death/partial).
 *
 * IMPORTANT: This is the FAKE economy (virtual adventures).
 */

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

// ── Local Types ───────────────────────────────────────────

interface AdventureConfig {
  economy_adventures_enabled: boolean;
  economy_adventure_daily_limit: number;
  economy_adventure_ticket_cost: number;
  economy_adventure_max_scenes: number;
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

let _instance: AdventureManager | null = null;

export function registerAdventureManager(mgr: AdventureManager): void {
  _instance = mgr;
}

export function invalidateAdventureCache(): void {
  _instance?.invalidateCache();
}

export function getAdventureManager(): AdventureManager | null {
  return _instance;
}

export class AdventureManager {
  private guild: Guild;
  private supabase: any;
  private valkey: any;
  private configCache: AdventureConfig | null = null;
  private adventureCache: Adventure[] | null = null;

  constructor(guild: Guild, supabase: any, valkey: any) {
    this.guild = guild;
    this.supabase = supabase;
    this.valkey = valkey;
  }

  invalidateCache(): void {
    this.configCache = null;
    this.adventureCache = null;
  }

  private async getConfig(): Promise<AdventureConfig> {
    if (this.configCache) return this.configCache;
    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_adventures_enabled, economy_adventure_daily_limit, economy_adventure_ticket_cost, economy_adventure_max_scenes')
      .eq('guild_id', this.guild.id)
      .single();
    this.configCache = data ?? {
      economy_adventures_enabled: false,
      economy_adventure_daily_limit: 3,
      economy_adventure_ticket_cost: 100,
      economy_adventure_max_scenes: 10,
    };
    return this.configCache!;
  }

  private async getAdventures(): Promise<Adventure[]> {
    if (this.adventureCache) return this.adventureCache;
    const { data } = await this.supabase
      .from('economy_adventures')
      .select('id, name, emoji, description, adventure_type, difficulty, min_scenes, max_scenes')
      .eq('guild_id', this.guild.id)
      .eq('active', true);

    if (!data || data.length === 0) {
      await this.seedDefaults();
      const { data: seeded } = await this.supabase
        .from('economy_adventures')
        .select('id, name, emoji, description, adventure_type, difficulty, min_scenes, max_scenes')
        .eq('guild_id', this.guild.id)
        .eq('active', true);
      this.adventureCache = (seeded ?? []) as Adventure[];
    } else {
      this.adventureCache = data as Adventure[];
    }
    return this.adventureCache!;
  }

  private async seedDefaults(): Promise<void> {
    for (const def of DEFAULT_ADVENTURES) {
      const { data } = await this.supabase
        .from('economy_adventures')
        .insert({
          guild_id: this.guild.id,
          name: def.name,
          emoji: def.emoji,
          description: def.description,
          adventure_type: def.adventure_type,
          difficulty: def.difficulty,
          min_scenes: def.scenes.length,
          max_scenes: def.scenes.length,
          is_default: true,
        })
        .select('id')
        .single();

      if (data) {
        const sceneRows = def.scenes.map((s, i) => ({
          adventure_id: (data as any).id,
          scene_index: i,
          text: s.text,
          choices: s.choices,
          loot: s.loot,
          is_ending: s.is_ending,
          ending_type: s.ending_type,
        }));
        await this.supabase.from('economy_adventure_scenes').insert(sceneRows);
      }
    }
  }

  // ── Start Adventure ─────────────────────────────────────

  async startAdventure(
    userId: string,
    adventureType?: string,
  ): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null; sessionId: string | null }> {
    const config = await this.getConfig();
    if (!config.economy_adventures_enabled) {
      return {
        embed: new EmbedBuilder().setDescription('🚫 Adventures are not enabled.').setColor(0xff0000),
        row: null,
        sessionId: null,
      };
    }

    // Check daily limit
    const today = new Date().toISOString().slice(0, 10);
    const { count } = await this.supabase
      .from('economy_adventure_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gte('started_at', `${today}T00:00:00Z`);

    if ((count ?? 0) >= config.economy_adventure_daily_limit) {
      return {
        embed: new EmbedBuilder()
          .setDescription(`⏳ You've used all **${config.economy_adventure_daily_limit}** adventures today. Come back tomorrow!`)
          .setColor(0xffaa00),
        row: null,
        sessionId: null,
      };
    }

    // Check active session
    const { data: active } = await this.supabase
      .from('economy_adventure_sessions')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (active && active.length > 0) {
      return {
        embed: new EmbedBuilder()
          .setDescription('⚠️ You already have an active adventure! Finish it first.')
          .setColor(0xffaa00),
        row: null,
        sessionId: null,
      };
    }

    // Charge ticket cost (atomic RPC prevents race conditions / negative balances)
    if (config.economy_adventure_ticket_cost > 0) {
      const { error: debitErr } = await this.supabase.rpc('economy_subtract_balance', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_amount: config.economy_adventure_ticket_cost,
      });

      if (debitErr) {
        return {
          embed: new EmbedBuilder()
            .setDescription(`💰 Adventures cost **${config.economy_adventure_ticket_cost}** coins. You don't have enough!`)
            .setColor(0xff0000),
          row: null,
          sessionId: null,
        };
      }
    }

    // Pick adventure
    const adventures = await this.getAdventures();
    let candidates = adventures;
    if (adventureType) {
      const filtered = adventures.filter((a) => a.adventure_type === adventureType);
      if (filtered.length > 0) candidates = filtered;
    }
    const adventure = candidates[Math.floor(Math.random() * candidates.length)];

    // Get first scene
    const { data: firstScene } = await this.supabase
      .from('economy_adventure_scenes')
      .select('*')
      .eq('adventure_id', adventure.id)
      .eq('scene_index', 0)
      .single();

    if (!firstScene) {
      return {
        embed: new EmbedBuilder().setDescription('❌ Adventure has no scenes configured.').setColor(0xff0000),
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
        await this.supabase.rpc('economy_add_balance', {
          p_guild_id: this.guild.id,
          p_user_id: userId,
          p_amount: config.economy_adventure_ticket_cost,
        }).catch(() => {});
      }

      // Duplicate key → another concurrent command won the race
      const isDupe = sessErr.code === '23505' || sessErr.message?.includes('duplicate');
      return {
        embed: new EmbedBuilder()
          .setDescription(isDupe
            ? '⚠️ You already have an active adventure! Finish it first.'
            : '❌ Failed to start adventure — your coins have been refunded.')
          .setColor(isDupe ? 0xffaa00 : 0xff0000),
        row: null,
        sessionId: null,
      };
    }

    const sessionId = (session as any)?.id ?? null;

    // Build embed + buttons
    const { embed, row } = this.buildSceneEmbed(adventure, scene, sessionId, 0);
    return { embed, row, sessionId };
  }

  // ── Handle Button Choice ────────────────────────────────

  async handleChoice(
    interaction: ButtonInteraction,
    sessionId: string,
    choiceIndex: number,
  ): Promise<void> {
    const { data: session } = await this.supabase
      .from('economy_adventure_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!session || (session as any).status !== 'active') {
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
      if (Math.random() * 100 < loot.chance_pct) {
        const existing = lootCollected.find((l) => l.item_name === loot.item_name);
        if (existing) existing.qty += loot.qty;
        else lootCollected.push({ item_name: loot.item_name, qty: loot.qty });
      }
    }

    // Navigate to next scene
    if (choice.next_scene_index === null) {
      // End adventure — same as ending scene
      await this.endSession(sess, 'completed', lootCollected, currencyCollected);
      const embed = new EmbedBuilder()
        .setTitle('🏁 Adventure Complete!')
        .setDescription(this.buildRewardsSummary(lootCollected, currencyCollected))
        .setColor(0x4caf50);
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
      const embed = new EmbedBuilder()
        .setTitle('🏁 Adventure Complete!')
        .setDescription(this.buildRewardsSummary(lootCollected, currencyCollected))
        .setColor(0x4caf50);
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    const next = nextScene as Scene;

    // Roll scene loot
    for (const loot of next.loot) {
      if (Math.random() * 100 < loot.chance_pct) {
        const existing = lootCollected.find((l) => l.item_name === loot.item_name);
        if (existing) existing.qty += loot.qty;
        else lootCollected.push({ item_name: loot.item_name, qty: loot.qty });
      }
    }

    // Update session
    await this.supabase
      .from('economy_adventure_sessions')
      .update({
        current_scene_id: next.id,
        loot_collected: lootCollected,
        currency_collected: currencyCollected,
      })
      .eq('id', sessionId);

    if (next.is_ending) {
      // End adventure
      const endType = next.ending_type ?? 'success';
      const finalLoot = endType === 'death' ? [] : endType === 'partial' ? lootCollected.slice(0, Math.ceil(lootCollected.length / 2)) : lootCollected;
      const finalCurrency = endType === 'death' ? 0 : endType === 'partial' ? Math.floor(currencyCollected / 2) : currencyCollected;

      await this.endSession(sess, endType === 'death' ? 'failed' : 'completed', finalLoot, finalCurrency);

      const color = endType === 'success' ? 0x4caf50 : endType === 'death' ? 0xf44336 : 0xff9800;
      const title = endType === 'success' ? '🎉 Adventure Complete!' : endType === 'death' ? '💀 Adventure Failed!' : '⚠️ Partial Success';

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(next.text + '\n\n' + this.buildRewardsSummary(finalLoot, finalCurrency))
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
    const { embed, row } = this.buildSceneEmbed(adv, next, sessionId, lootCollected.length);

    const updatePayload: any = { embeds: [embed], components: [] as any[] };
    if (row) updatePayload.components = [row];
    await interaction.update(updatePayload);
  }

  // ── Helpers ─────────────────────────────────────────────

  private buildSceneEmbed(
    adventure: Adventure,
    scene: Scene,
    sessionId: string | null,
    lootCount: number,
  ): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null } {
    const embed = new EmbedBuilder()
      .setTitle(`${adventure.emoji} ${adventure.name}`)
      .setDescription(scene.text)
      .setColor(0x7c4dff)
      .setFooter({ text: `Scene ${scene.scene_index + 1} • Items collected: ${lootCount}` });

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
        console.error('[Adventures] endSession payout failed:', payErr.message);
        // Mark the session so admins can identify failed payouts and retry
        await this.supabase
          .from('economy_adventure_sessions')
          .update({ status: 'payout_failed' })
          .eq('id', session.id);
      }
    }

    // V53-L1: Add loot items to inventory — track failures so they can be
    // surfaced rather than silently dropped. Previously .catch() logged
    // but the user never knew their item was lost.
    const failedLoot: string[] = [];
    for (const item of loot) {
      const { data: found } = await this.supabase
        .from('economy_items')
        .select('id')
        .eq('guild_id', this.guild.id)
        .ilike('name', item.item_name)
        .limit(1);

      if (found && found.length > 0) {
        const { error: upsertErr } = await this.supabase.rpc('economy_upsert_inventory', {
          p_guild_id: this.guild.id,
          p_user_id: session.user_id,
          p_item_id: (found[0] as any).id,
          p_quantity: item.qty,
        });
        if (upsertErr) {
          console.error(`[Adventures] loot upsert failed for ${item.item_name}:`, upsertErr.message);
          failedLoot.push(`${item.qty}x ${item.item_name}`);
        }
      }
    }
    // If any loot failed, mark session so it can be retried/investigated
    if (failedLoot.length > 0) {
      await this.supabase
        .from('economy_adventure_sessions')
        .update({
          status: status === 'payout_failed' ? 'payout_failed' : 'loot_failed',
          metadata: { failed_loot: failedLoot },
        })
        .eq('id', session.id);
    }

    // Quest progress — count completed adventures
    getQuestsManager()?.trackProgress(this.guild.id, session.user_id, 'adventure').catch(() => {});
  }
}
