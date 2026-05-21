/**
 * CraftingManager — /craft and /recipes commands.
 *
 * Combines inventory materials into new items using recipes.
 * Pre-loaded with ~30 default recipes; guilds can add custom ones via dashboard.
 *
 * IMPORTANT: This is the "fake economy" — virtual items only.
 */
import { type Guild, EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';
import { getQuestsManager } from '../quests/quests-manager.js';

// ── Types ─────────────────────────────────────────────────

export interface CraftingConfig {
  economy_crafting_enabled: boolean;
  economy_crafting_cooldown_seconds: number;
}

interface RecipeInput {
  item_name: string;
  qty: number;
}

interface Recipe {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  inputs: RecipeInput[];
  output_item_id: string | null;
  output_qty: number;
  cooldown_seconds: number;
  category: string;
}

// Default recipes seeded on first use
const DEFAULT_RECIPES: Array<{
  name: string;
  emoji: string;
  description: string;
  inputs: RecipeInput[];
  output_name: string;
  output_qty: number;
  cooldown_seconds: number;
  category: string;
}> = [
  // Tools
  { name: 'Basic Pickaxe', emoji: '⛏️', description: 'A basic mining tool', inputs: [{ item_name: 'Stone', qty: 5 }, { item_name: 'Iron Ore', qty: 2 }], output_name: 'Basic Pickaxe', output_qty: 1, cooldown_seconds: 300, category: 'Tools' },
  { name: 'Basic Shovel', emoji: '🪏', description: 'A basic digging tool', inputs: [{ item_name: 'Stone', qty: 3 }, { item_name: 'Iron Ore', qty: 1 }], output_name: 'Basic Shovel', output_qty: 1, cooldown_seconds: 300, category: 'Tools' },
  { name: 'Hunting Bow', emoji: '🏹', description: 'A basic hunting weapon', inputs: [{ item_name: 'Bone Fragment', qty: 3 }, { item_name: 'Deer Hide', qty: 2 }], output_name: 'Hunting Bow', output_qty: 1, cooldown_seconds: 300, category: 'Tools' },
  { name: 'Iron Pickaxe', emoji: '⛏️', description: 'An improved mining tool', inputs: [{ item_name: 'Iron Ore', qty: 8 }, { item_name: 'Gold Nugget', qty: 2 }], output_name: 'Iron Pickaxe', output_qty: 1, cooldown_seconds: 600, category: 'Tools' },
  { name: 'Steel Shovel', emoji: '🪏', description: 'An improved digging tool', inputs: [{ item_name: 'Iron Ore', qty: 5 }, { item_name: 'Stone', qty: 10 }], output_name: 'Steel Shovel', output_qty: 1, cooldown_seconds: 600, category: 'Tools' },
  // Consumables
  { name: 'Health Potion', emoji: '❤️', description: 'Restores health', inputs: [{ item_name: 'Rabbit Meat', qty: 2 }, { item_name: 'Clay', qty: 1 }], output_name: 'Health Potion', output_qty: 1, cooldown_seconds: 60, category: 'Consumables' },
  { name: 'Fertilizer', emoji: '💩', description: 'Speeds up crop growth by 50%', inputs: [{ item_name: 'Bone Fragment', qty: 2 }, { item_name: 'Clay', qty: 3 }], output_name: 'Fertilizer', output_qty: 3, cooldown_seconds: 120, category: 'Farming' },
  { name: 'Padlock', emoji: '🔒', description: 'Protects your wallet from robbery', inputs: [{ item_name: 'Iron Ore', qty: 4 }, { item_name: 'Gold Nugget', qty: 1 }], output_name: 'Padlock', output_qty: 1, cooldown_seconds: 300, category: 'Protection' },
  // Materials
  { name: 'Gold Bar', emoji: '🥇', description: 'Refined gold', inputs: [{ item_name: 'Gold Nugget', qty: 5 }], output_name: 'Gold Bar', output_qty: 1, cooldown_seconds: 120, category: 'Materials' },
  { name: 'Iron Bar', emoji: '🔩', description: 'Refined iron', inputs: [{ item_name: 'Iron Ore', qty: 4 }], output_name: 'Iron Bar', output_qty: 1, cooldown_seconds: 60, category: 'Materials' },
  { name: 'Gemstone Ring', emoji: '💍', description: 'A valuable ring', inputs: [{ item_name: 'Gold Nugget', qty: 3 }, { item_name: 'Emerald', qty: 1 }], output_name: 'Gemstone Ring', output_qty: 1, cooldown_seconds: 300, category: 'Accessories' },
  { name: 'Diamond Pendant', emoji: '📿', description: 'A luxurious pendant', inputs: [{ item_name: 'Gold Nugget', qty: 5 }, { item_name: 'Diamond', qty: 1 }], output_name: 'Diamond Pendant', output_qty: 1, cooldown_seconds: 600, category: 'Accessories' },
];

export class CraftingManager {
  private configCache: CraftingConfig | null = null;
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

  async getConfig(): Promise<CraftingConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCacheTime < this.configCacheTTL) {
      return this.configCache;
    }

    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_crafting_enabled, economy_crafting_cooldown_seconds')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_crafting_enabled: data?.economy_crafting_enabled ?? false,
      economy_crafting_cooldown_seconds: data?.economy_crafting_cooldown_seconds ?? 60,
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  // ── Recipes ─────────────────────────────────────────────

  async listRecipes(): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_crafting_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Crafting is not enabled on this server.').setColor(0xff0000) };
    }

    let recipes = await this.getRecipes();
    if (recipes.length === 0) {
      await this.seedDefaultRecipes();
      recipes = await this.getRecipes();
    }

    // Group by category
    const groups: Record<string, Recipe[]> = {};
    for (const r of recipes) {
      if (!groups[r.category]) groups[r.category] = [];
      groups[r.category].push(r);
    }

    const embed = new EmbedBuilder()
      .setTitle('📖 Recipe Book')
      .setColor(0x8b4513)
      .setTimestamp();

    for (const [cat, items] of Object.entries(groups)) {
      const lines = items.map((r) =>
        `${r.emoji} **${r.name}** — ${r.inputs.map((i) => `${i.qty}x ${i.item_name}`).join(' + ')} → ${r.output_qty}x output`
      );
      embed.addFields({ name: cat, value: lines.join('\n').slice(0, 1024), inline: false });
    }

    if (embed.data.fields?.length === 0) {
      embed.setDescription('No recipes available.');
    }

    return { embed };
  }

  async craft(userId: string, recipeName: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_crafting_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Crafting is not enabled on this server.').setColor(0xff0000) };
    }

    // Find recipe
    let recipes = await this.getRecipes();
    if (recipes.length === 0) {
      await this.seedDefaultRecipes();
      recipes = await this.getRecipes();
    }

    const recipe = recipes.find((r) => r.name.toLowerCase() === recipeName.toLowerCase());
    if (!recipe) {
      return {
        embed: new EmbedBuilder()
          .setDescription(`❌ Recipe "**${recipeName}**" not found. Use \`/recipes\` to see available recipes.`)
          .setColor(0xff0000),
      };
    }

    // Cooldown check
    const cdKey = `economy:craft:${this.guild.id}:${userId}`;
    const lastCraft = await this.valkey.get(cdKey);
    if (lastCraft) {
      const elapsed = Date.now() - parseInt(lastCraft, 10);
      const cooldown = (recipe.cooldown_seconds || config.economy_crafting_cooldown_seconds) * 1000;
      if (elapsed < cooldown) {
        const remaining = Math.ceil((cooldown - elapsed) / 1000);
        return {
          embed: new EmbedBuilder()
            .setDescription(`⏳ You need to wait **${this.formatTime(remaining)}** before crafting again.`)
            .setColor(0xffa500),
        };
      }
    }

    // Check materials
    const inventory = await this.getInventory(userId);
    const missing: string[] = [];

    for (const input of recipe.inputs) {
      const owned = inventory.find((i) => i.item_name.toLowerCase() === input.item_name.toLowerCase());
      const have = owned?.quantity ?? 0;
      if (have < input.qty) {
        missing.push(`${input.item_name}: need ${input.qty}, have ${have}`);
      }
    }

    if (missing.length > 0) {
      return {
        embed: new EmbedBuilder()
          .setTitle('❌ Missing Materials')
          .setDescription(`You don't have enough materials to craft **${recipe.name}**:\n\n${missing.map((m) => `• ${m}`).join('\n')}`)
          .setColor(0xff0000),
      };
    }

    // Consume materials
    for (const input of recipe.inputs) {
      await this.removeFromInventory(userId, input.item_name, input.qty);
    }

    // Give output
    if (recipe.output_item_id) {
      await this.addToInventory(userId, recipe.output_item_id, recipe.output_qty);
    }

    // Set cooldown
    await this.valkey.set(cdKey, Date.now().toString(), 'EX', recipe.cooldown_seconds || config.economy_crafting_cooldown_seconds);

    // Record transaction
    await this.supabase.from('economy_transactions').insert({
      guild_id: this.guild.id,
      user_id: userId,
      type: 'craft',
      amount: 0,
      balance_after: 0,
      description: `Crafted ${recipe.output_qty}x ${recipe.name}`,
    });

    // Quest progress
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'craft').catch(() => {});

    return {
      embed: new EmbedBuilder()
        .setTitle(`${recipe.emoji} Crafted!`)
        .setDescription(
          `You crafted **${recipe.output_qty}x ${recipe.name}**!\n\n` +
          `Materials used:\n${recipe.inputs.map((i) => `• ${i.qty}x ${i.item_name}`).join('\n')}`,
        )
        .setColor(0x4caf50)
        .setTimestamp(),
    };
  }

  // ── Internal helpers ────────────────────────────────────

  private async getRecipes(): Promise<Recipe[]> {
    const { data } = await this.supabase
      .from('economy_recipes')
      .select('id, name, emoji, description, inputs, output_item_id, output_qty, cooldown_seconds, category')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .order('category')
      .order('name');

    return (data as Recipe[] | null) ?? [];
  }

  private async seedDefaultRecipes(): Promise<void> {
    const rows = DEFAULT_RECIPES.map((r) => ({
      guild_id: this.guild.id,
      name: r.name,
      emoji: r.emoji,
      description: r.description,
      inputs: JSON.stringify(r.inputs),
      output_item_id: null, // no linked item — output is tracked by name
      output_qty: r.output_qty,
      cooldown_seconds: r.cooldown_seconds,
      category: r.category,
      is_default: true,
    }));

    await this.supabase.from('economy_recipes').insert(rows);
  }

  private async getInventory(userId: string): Promise<Array<{ item_name: string; quantity: number; item_id: string }>> {
    const { data } = await this.supabase
      .from('economy_inventory')
      .select('quantity, item_id, economy_items(name)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0);

    if (!data) return [];
    return (data as any[]).map((row) => ({
      item_name: (row.economy_items as any)?.name ?? 'Unknown',
      quantity: row.quantity as number,
      item_id: row.item_id as string,
    }));
  }

  private async removeFromInventory(userId: string, itemName: string, qty: number): Promise<boolean> {
    // Resolve item_id from name, then use atomic RPC to decrement
    const { data: items } = await this.supabase
      .from('economy_inventory')
      .select('item_id, economy_items!inner(name)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0);

    if (!items) return false;

    const match = (items as any[]).find((i) =>
      ((i.economy_items as any)?.name ?? '').toLowerCase() === itemName.toLowerCase()
    );
    if (!match) return false;

    // Atomic decrement — prevents TOCTOU race on inventory quantity
    const { data: success } = await this.supabase.rpc('economy_decrement_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: match.item_id,
      p_quantity: qty,
    });
    return success === true;
  }

  private async addToInventory(userId: string, itemId: string, quantity: number): Promise<void> {
    // Atomic upsert — prevents TOCTOU race on inventory quantity
    await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: itemId,
      p_quantity: quantity,
    });
  }

  private formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
}
