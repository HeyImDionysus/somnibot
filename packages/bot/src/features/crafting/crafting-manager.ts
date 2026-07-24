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
import { walletBalance, joinProp } from '../../utils/db-helpers.js';
import { createLogger } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus } from '../../services/event-bus.js';
import { resolveBrandKit } from '../branding/brand-kit.js';

const log = createLogger('Crafting');

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
    private supabase: SupabaseClient,
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
      economy_crafting_enabled: data?.economy_crafting_enabled ?? true,
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

    // [game-economy-crafting DEPFAIL] Check the READ ERROR first: a failed
    // recipe read (database unreachable) must NOT render as an empty recipe
    // book — that is a data-shaped lie about state the bot could not read.
    let recipes = await this.getRecipes();
    if (recipes === null) {
      return { embed: await this.unavailableEmbed() };
    }
    if (recipes.length === 0) {
      await this.seedDefaultRecipes();
      recipes = (await this.getRecipes()) ?? [];
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

    // Find recipe. [game-economy-crafting DEPFAIL] A failed recipe read
    // (database unreachable) must NOT surface as "Recipe not found" — degrade
    // honestly BEFORE the cooldown lock so no cooldown is wrongly claimed.
    let recipes = await this.getRecipes();
    if (recipes === null) {
      return { embed: await this.unavailableEmbed() };
    }
    if (recipes.length === 0) {
      await this.seedDefaultRecipes();
      recipes = (await this.getRecipes()) ?? [];
    }

    const recipe = recipes.find((r) => r.name.toLowerCase() === recipeName.toLowerCase());
    if (!recipe) {
      return {
        embed: new EmbedBuilder()
          .setDescription(`❌ Recipe "**${recipeName}**" not found. Use \`/recipes\` to see available recipes.`)
          .setColor(0xff0000),
      };
    }

    // V49-M1: Atomic cooldown via SET PX NX — prevents two concurrent
    // craft calls from both bypassing the cooldown check.
    const cooldownMs = (recipe.cooldown_seconds || config.economy_crafting_cooldown_seconds) * 1000;
    const cdKey = `economy:craft:${this.guild.id}:${userId}`;
    const lockResult = await this.valkey.set(cdKey, '1', 'PX', cooldownMs, 'NX');
    if (lockResult !== 'OK') {
      const ttl = await this.valkey.pttl(cdKey);
      const remaining = Math.ceil(Math.max(ttl, 0) / 1000);
      return {
        embed: new EmbedBuilder()
          .setDescription(`⏳ You need to wait **${this.formatTime(remaining)}** before crafting again.`)
          .setColor(0xffa500),
      };
    }

    // Check materials. [game-economy-crafting DEPFAIL] A failed inventory read
    // must NOT surface as "missing materials" (a data-shaped lie); release the
    // just-claimed cooldown and degrade honestly.
    const inventory = await this.getInventory(userId);
    if (inventory === null) {
      try {
        await this.valkey.del(cdKey);
      } catch (e: unknown) {
        log.warn('failed to release craft cooldown after inventory read failure:', (e as Error)?.message ?? e);
      }
      return { embed: await this.unavailableEmbed() };
    }
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

    // Consume materials — check each decrement succeeds (prevents free crafts from TOCTOU)
    const consumed: { itemName: string; qty: number; itemId: string }[] = [];
    for (const input of recipe.inputs) {
      const result = await this.removeFromInventory(userId, input.item_name, input.qty);
      if (!result.success) {
        // Refund already-consumed materials
        for (const c of consumed) {
          await Promise.resolve(this.supabase.rpc('economy_upsert_inventory', {
            p_guild_id: this.guild.id,
            p_user_id: userId,
            p_item_id: c.itemId,
            p_quantity: c.qty,
          })).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
        }
        return {
          embed: new EmbedBuilder()
            .setDescription(`❌ Failed to consume **${input.item_name}** — another action used it first. Try again.`)
            .setColor(0xff0000),
        };
      }
      consumed.push({ itemName: input.item_name, qty: input.qty, itemId: result.itemId });
    }

    // Give output — guard against misconfigured recipes with no output
    if (!recipe.output_item_id) {
      return {
        embed: new EmbedBuilder()
          .setDescription('❌ This recipe has no output item configured. Contact an admin to fix it.')
          .setColor(0xff0000),
      };
    }
    // V53-C1: check inventory upsert — refund consumed materials on failure
    const added = await this.addToInventory(userId, recipe.output_item_id, recipe.output_qty);
    if (!added) {
      // Refund all consumed materials (best-effort)
      for (const c of consumed) {
        await Promise.resolve(this.supabase.rpc('economy_upsert_inventory', {
          p_guild_id: this.guild.id,
          p_user_id: userId,
          p_item_id: c.itemId,
          p_quantity: c.qty,
        })).catch((e: unknown) => { log.warn('Operation failed:', (e as Error)?.message ?? e); });
      }
      // [game-economy-crafting] Owner alert + audit on the degradation branch
      // (output-grant RPC failed after materials were consumed then refunded).
      await this.raiseCraftDegradedAlert(userId, recipe.name)
        .catch((e: unknown) => { log.warn('crafting degraded alert failed:', (e as Error)?.message ?? e); });
      eventBus.emit('craft.failed', this.guild.id, {
        userId,
        recipeName: recipe.name,
        reason: 'output_grant_failed',
      });
      return {
        embed: new EmbedBuilder()
          .setDescription('❌ Failed to add crafted item to your inventory. Your materials have been refunded.')
          .setColor(0xff0000),
      };
    }

    // Cooldown already set at the top via SET PX NX (V49-M1).

    // Record transaction (fetch real balance for accurate audit trail)
    const { data: craftWallet } = await this.supabase.from('economy_wallets')
      .select('wallet').eq('guild_id', this.guild.id).eq('user_id', userId).maybeSingle();
    await this.supabase.from('economy_transactions').insert({
      guild_id: this.guild.id,
      user_id: userId,
      type: 'craft',
      amount: 0,
      balance_after: walletBalance(craftWallet),
      description: `Crafted ${recipe.output_qty}x ${recipe.name}`,
    });

    // Quest progress
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'craft').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    // [game-economy-crafting] Append-only audit row for the successful craft
    // state change (materials consumed → output granted).
    eventBus.emit('craft.completed', this.guild.id, {
      userId,
      recipeName: recipe.name,
      outputQty: recipe.output_qty,
    });

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

  /**
   * The guild's active recipes, or `null` when the READ FAILED (database
   * unreachable) — callers must degrade honestly rather than treat a failed
   * read as an empty recipe book ([game-economy-crafting DEPFAIL]).
   */
  private async getRecipes(): Promise<Recipe[] | null> {
    const { data, error } = await this.supabase
      .from('economy_recipes')
      .select('id, name, emoji, description, inputs, output_item_id, output_qty, cooldown_seconds, category')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .order('category')
      .order('name')
      .limit(1000);

    if (error) {
      log.error('getRecipes read failed:', error.message);
      return null;
    }
    return (data as Recipe[] | null) ?? [];
  }

  /**
   * [game-economy-crafting DEPFAIL] The branded crafting-unavailable
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
      .setDescription(`⚠️ ${name}'s crafting workshop is temporarily unavailable — please try again in a moment. No materials were consumed.`)
      .setColor(0xffa500);
  }

  // V49-L1: seedDefaultRecipes now creates output items in economy_items
  // (if they don't already exist) and links them via output_item_id.
  // Previously all default recipes had output_item_id: null, making them
  // impossible to craft (the craft() function rejects null output_item_id).
  private async seedDefaultRecipes(): Promise<void> {
    const rows: Array<Record<string, unknown>> = [];

    for (const r of DEFAULT_RECIPES) {
      // Resolve or create the output item
      let itemId: string | null = null;

      // Check if the item already exists for this guild
      const { data: existing } = await this.supabase
        .from('economy_items')
        .select('id')
        .eq('guild_id', this.guild.id)
        .ilike('name', r.output_name)
        .limit(1);

      if (existing && existing.length > 0) {
        itemId = (existing[0] as { id: string }).id;
      } else {
        // Create the output item
        const { data: created } = await this.supabase
          .from('economy_items')
          .insert({
            guild_id: this.guild.id,
            name: r.output_name,
            emoji: r.emoji,
            description: r.description,
            category: r.category,
            price: 0,
            sell_price: 0,
            usable: false,
            tradeable: true,
            active: true,
          })
          .select('id')
          .single();

        itemId = (created as { id: string } | null)?.id ?? null;
      }

      rows.push({
        guild_id: this.guild.id,
        name: r.name,
        emoji: r.emoji,
        description: r.description,
        // economy_recipes.inputs is jsonb — pass the array directly. Stringifying
        // it first double-encodes into a jsonb STRING scalar, so getRecipes()
        // reads back a JS string and every `.inputs.map(...)` / `for..of` throws,
        // breaking /recipes render and /craft from first use.
        inputs: r.inputs,
        output_item_id: itemId,
        output_qty: r.output_qty,
        cooldown_seconds: r.cooldown_seconds,
        category: r.category,
        is_default: true,
      });
    }

    await this.supabase.from('economy_recipes').insert(rows);
  }

  /**
   * A member's inventory, or `null` when the READ FAILED (database
   * unreachable) — a failed read is not an empty inventory
   * ([game-economy-crafting DEPFAIL]).
   */
  private async getInventory(userId: string): Promise<Array<{ item_name: string; quantity: number; item_id: string }> | null> {
    const { data, error } = await this.supabase
      .from('economy_inventory')
      .select('quantity, item_id, economy_items(name)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0)
      .limit(1000);

    if (error) {
      log.error('getInventory read failed:', error.message);
      return null;
    }
    if (!data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      item_name: (joinProp(row, 'economy_items', 'name') as string) ?? 'Unknown',
      quantity: row.quantity as number,
      item_id: row.item_id as string,
    }));
  }

  private async removeFromInventory(userId: string, itemName: string, qty: number): Promise<{ success: boolean; itemId: string }> {
    // Resolve item_id from name, then use atomic RPC to decrement
    const { data: items } = await this.supabase
      .from('economy_inventory')
      .select('item_id, economy_items!inner(name)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0)
      .limit(1000);

    if (!items) return { success: false, itemId: '' };

    const match = (items as Record<string, unknown>[]).find((i) =>
      ((joinProp(i, 'economy_items', 'name') as string) ?? '').toLowerCase() === itemName.toLowerCase()
    );
    if (!match) return { success: false, itemId: '' };

    // Atomic decrement — prevents TOCTOU race on inventory quantity
    const { data: success } = await this.supabase.rpc('economy_decrement_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: match.item_id,
      p_quantity: qty,
    });
    return { success: success === true, itemId: match.item_id as string };
  }

  private async addToInventory(userId: string, itemId: string, quantity: number): Promise<boolean> {
    // V53-C1: check upsert result — caller must handle failure (e.g. refund materials)
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

  /**
   * [game-economy-crafting] Raise a degradation owner alert when the output-grant
   * RPC fails after materials were consumed (and then refunded). Best effort —
   * a failed alert never blocks the craft flow.
   */
  private async raiseCraftDegradedAlert(userId: string, recipeName: string): Promise<void> {
    await this.supabase.from('alerts').insert({
      guild_id: this.guild.id,
      alert_type: 'crafting_degraded',
      severity: 'warning',
      title: 'Crafting degraded',
      message: `Crafting "${recipeName}" failed to grant its output for ${userId}; materials were refunded.`,
      metadata: { user_id: userId, recipe_name: recipeName },
    });
  }

  private formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
}
