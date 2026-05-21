/**
 * FarmingManager — /farm plant, /farm water, /farm harvest, /farm sell, /farm view.
 *
 * 3×3 grid (configurable) of farm plots. Buy seeds from shop, plant, water,
 * wait for growth, harvest. Crops wilt if not harvested in time.
 * Fertilizer (crafted or bought) cuts grow time by configured %.
 *
 * IMPORTANT: This is the "fake economy" — virtual crops only.
 */
import { type Guild, EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';

// ── Types ─────────────────────────────────────────────────

export interface FarmingConfig {
  economy_farming_enabled: boolean;
  economy_farm_grid_size: number;
  economy_farming_wilt_enabled: boolean;
  economy_fertilizer_time_reduction_pct: number;
}

interface Crop {
  id: string;
  name: string;
  emoji: string;
  grow_seconds: number;
  wilt_seconds: number;
  sell_price: number;
  seeds_returned: number;
}

interface Plot {
  id: string;
  plot_index: number;
  crop_id: string | null;
  planted_at: string | null;
  watered_at: string | null;
  fertilized: boolean;
  harvested: boolean;
}

type PlotStatus = 'empty' | 'planted' | 'growing' | 'ready' | 'wilted';

const PLOT_ICONS: Record<PlotStatus, string> = {
  empty: '⬛',
  planted: '🟫',
  growing: '🌱',
  ready: '🌾',
  wilted: '🥀',
};

// Default crops seeded on first use
const DEFAULT_CROPS = [
  { name: 'Potato', emoji: '🥔', grow_seconds: 7200, wilt_seconds: 86400, sell_price: 30, seeds_returned: 1, category: 'Vegetable', sort_order: 0 },
  { name: 'Corn', emoji: '🌽', grow_seconds: 28800, wilt_seconds: 86400, sell_price: 80, seeds_returned: 2, category: 'Vegetable', sort_order: 1 },
  { name: 'Tomato', emoji: '🍅', grow_seconds: 43200, wilt_seconds: 72000, sell_price: 120, seeds_returned: 1, category: 'Vegetable', sort_order: 2 },
  { name: 'Pumpkin', emoji: '🎃', grow_seconds: 86400, wilt_seconds: 172800, sell_price: 300, seeds_returned: 1, category: 'Vegetable', sort_order: 3 },
  { name: 'Golden Apple', emoji: '🍎', grow_seconds: 172800, wilt_seconds: 259200, sell_price: 1000, seeds_returned: 0, category: 'Fruit', sort_order: 4 },
];

export class FarmingManager {
  private configCache: FarmingConfig | null = null;
  private configCacheTTL = 30_000;
  private configCacheTime = 0;

  constructor(
    private guild: Guild,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase client
    private supabase: any,
    private valkey: Valkey,
  ) {}

  invalidateConfig(): void {
    this.configCache = null;
    this.configCacheTime = 0;
  }

  async getConfig(): Promise<FarmingConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCacheTime < this.configCacheTTL) {
      return this.configCache;
    }

    const { data } = await this.supabase
      .from('guild_config')
      .select('economy_farming_enabled, economy_farm_grid_size, economy_farming_wilt_enabled, economy_fertilizer_time_reduction_pct')
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_farming_enabled: data?.economy_farming_enabled ?? false,
      economy_farm_grid_size: data?.economy_farm_grid_size ?? 9,
      economy_farming_wilt_enabled: data?.economy_farming_wilt_enabled ?? true,
      economy_fertilizer_time_reduction_pct: data?.economy_fertilizer_time_reduction_pct ?? 50,
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  // ── View ────────────────────────────────────────────────

  async viewFarm(userId: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Farming is not enabled on this server.').setColor(0xff0000) };
    }

    const plots = await this.getPlots(userId);
    const crops = await this.getCrops();
    const cropMap = new Map(crops.map((c) => [c.id, c]));

    // Build grid
    const gridSize = Math.ceil(Math.sqrt(config.economy_farm_grid_size));
    const lines: string[] = [];
    const statusLines: string[] = [];

    for (let row = 0; row < gridSize; row++) {
      const rowIcons: string[] = [];
      for (let col = 0; col < gridSize; col++) {
        const idx = row * gridSize + col;
        if (idx >= config.economy_farm_grid_size) {
          rowIcons.push('  ');
          continue;
        }
        const plot = plots.find((p) => p.plot_index === idx);
        const status = this.getPlotStatus(plot, cropMap, config);
        rowIcons.push(PLOT_ICONS[status]);
      }
      lines.push(rowIcons.join(' '));
    }

    // Status details for planted plots
    for (const plot of plots) {
      if (!plot.crop_id || plot.harvested) continue;
      const crop = cropMap.get(plot.crop_id);
      if (!crop) continue;
      const status = this.getPlotStatus(plot, cropMap, config);
      const timeInfo = this.getTimeInfo(plot, crop, config);
      statusLines.push(`Plot ${plot.plot_index + 1}: ${crop.emoji} ${crop.name} — ${status === 'ready' ? '✅ Ready!' : status === 'wilted' ? '🥀 Wilted!' : timeInfo}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('🌾 Your Farm')
      .setDescription(
        lines.join('\n') +
        '\n\n' +
        (statusLines.length > 0 ? statusLines.join('\n') : '_All plots empty — use `/farm plant <crop>` to get started!_'),
      )
      .setColor(0x4caf50)
      .setFooter({ text: `${plots.filter((p) => p.crop_id && !p.harvested).length}/${config.economy_farm_grid_size} plots in use` })
      .setTimestamp();

    return { embed };
  }

  // ── Plant ───────────────────────────────────────────────

  async plant(userId: string, cropName: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Farming is not enabled on this server.').setColor(0xff0000) };
    }

    let crops = await this.getCrops();
    if (crops.length === 0) {
      await this.seedDefaultCrops();
      crops = await this.getCrops();
    }

    const crop = crops.find((c) => c.name.toLowerCase() === cropName.toLowerCase());
    if (!crop) {
      const available = crops.map((c) => `${c.emoji} ${c.name}`).join(', ');
      return {
        embed: new EmbedBuilder()
          .setDescription(`❌ Unknown crop "**${cropName}**".\n\nAvailable: ${available}`)
          .setColor(0xff0000),
      };
    }

    // Find empty plot
    const plots = await this.getPlots(userId);
    const cropMap = new Map(crops.map((c) => [c.id, c]));
    const emptyIndex = this.findEmptyPlot(plots, config, cropMap);

    if (emptyIndex === -1) {
      return {
        embed: new EmbedBuilder()
          .setDescription('❌ All your farm plots are occupied! Harvest or wait for crops to wilt.')
          .setColor(0xff0000),
      };
    }

    // Check if user has seeds (check inventory for seed item, or allow free planting if no seed_item_id)
    if (crop.seed_item_id) {
      const hasSeed = await this.checkAndConsumeSeed(userId, crop.seed_item_id);
      if (!hasSeed) {
        return {
          embed: new EmbedBuilder()
            .setDescription(`❌ You don't have any **${crop.name} Seeds**! Buy them from the shop.`)
            .setColor(0xff0000),
        };
      }
    }

    // Plant
    await this.supabase.from('economy_farm_plots').upsert({
      guild_id: this.guild.id,
      user_id: userId,
      plot_index: emptyIndex,
      crop_id: crop.id,
      planted_at: new Date().toISOString(),
      watered_at: null,
      fertilized: false,
      harvested: false,
    }, { onConflict: 'guild_id,user_id,plot_index' });

    return {
      embed: new EmbedBuilder()
        .setTitle(`${crop.emoji} Planted!`)
        .setDescription(
          `You planted **${crop.name}** in plot ${emptyIndex + 1}.\n\n` +
          `⏱️ Growth time: **${this.formatTime(crop.grow_seconds)}**\n` +
          `💧 Water with \`/farm water\` to keep it healthy!\n` +
          `🌿 Use fertilizer to cut grow time by ${config.economy_fertilizer_time_reduction_pct}%`,
        )
        .setColor(0x4caf50)
        .setTimestamp(),
    };
  }

  // ── Water ───────────────────────────────────────────────

  async water(userId: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Farming is not enabled on this server.').setColor(0xff0000) };
    }

    const plots = await this.getPlots(userId);
    const needsWater = plots.filter((p) => p.crop_id && !p.harvested && !p.watered_at);

    if (needsWater.length === 0) {
      const growing = plots.filter((p) => p.crop_id && !p.harvested);
      if (growing.length === 0) {
        return { embed: new EmbedBuilder().setDescription('❌ You have no crops planted!').setColor(0xff0000) };
      }
      return { embed: new EmbedBuilder().setDescription('💧 All your crops are already watered!').setColor(0x2196f3) };
    }

    // Water all unwatered plots
    const now = new Date().toISOString();
    for (const plot of needsWater) {
      await this.supabase.from('economy_farm_plots')
        .update({ watered_at: now })
        .eq('id', plot.id);
    }

    return {
      embed: new EmbedBuilder()
        .setTitle('💧 Watered!')
        .setDescription(`You watered **${needsWater.length}** plot${needsWater.length > 1 ? 's' : ''}. Your crops are growing!`)
        .setColor(0x2196f3)
        .setTimestamp(),
    };
  }

  // ── Harvest ─────────────────────────────────────────────

  async harvest(userId: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Farming is not enabled on this server.').setColor(0xff0000) };
    }

    const plots = await this.getPlots(userId);
    const crops = await this.getCrops();
    const cropMap = new Map(crops.map((c) => [c.id, c]));

    const readyPlots = plots.filter((p) => {
      const status = this.getPlotStatus(p, cropMap, config);
      return status === 'ready';
    });

    if (readyPlots.length === 0) {
      return { embed: new EmbedBuilder().setDescription('❌ No crops ready to harvest!').setColor(0xff0000) };
    }

    // Harvest all ready crops
    const harvested: Array<{ crop: Crop; plot: Plot }> = [];
    for (const plot of readyPlots) {
      const crop = cropMap.get(plot.crop_id!);
      if (!crop) continue;
      harvested.push({ crop, plot });

      // Mark harvested
      await this.supabase.from('economy_farm_plots')
        .update({ harvested: true })
        .eq('id', plot.id);
    }

    // Calculate earnings and return seeds
    let totalEarnings = 0;
    const harvestLines: string[] = [];
    for (const { crop } of harvested) {
      totalEarnings += crop.sell_price;
      harvestLines.push(`${crop.emoji} ${crop.name} — 💰 ${crop.sell_price.toLocaleString()}`);

      // Return seeds to inventory if configured
      if (crop.seeds_returned > 0 && crop.seed_item_id) {
        await this.addToInventory(userId, crop.seed_item_id, crop.seeds_returned);
      }
    }

    // Add earnings to wallet
    await this.addToWallet(userId, totalEarnings);

    // Record transaction
    await this.supabase.from('economy_transactions').insert({
      guild_id: this.guild.id,
      user_id: userId,
      type: 'farm_harvest',
      amount: totalEarnings,
      balance_after: 0,
      description: `Harvested ${harvested.length} crops`,
    });

    return {
      embed: new EmbedBuilder()
        .setTitle('🌾 Harvest Complete!')
        .setDescription(
          harvestLines.join('\n') +
          `\n\n💰 Total earnings: **${totalEarnings.toLocaleString()}** coins`,
        )
        .setColor(0x4caf50)
        .setTimestamp(),
    };
  }

  // ── Fertilize ───────────────────────────────────────────

  async fertilize(userId: string, plotNum: number): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return { embed: new EmbedBuilder().setDescription('❌ Farming is not enabled on this server.').setColor(0xff0000) };
    }

    const plotIndex = plotNum - 1;
    if (plotIndex < 0 || plotIndex >= config.economy_farm_grid_size) {
      return { embed: new EmbedBuilder().setDescription(`❌ Invalid plot number. Use 1-${config.economy_farm_grid_size}.`).setColor(0xff0000) };
    }

    const plots = await this.getPlots(userId);
    const plot = plots.find((p) => p.plot_index === plotIndex);

    if (!plot || !plot.crop_id || plot.harvested) {
      return { embed: new EmbedBuilder().setDescription('❌ That plot is empty!').setColor(0xff0000) };
    }

    if (plot.fertilized) {
      return { embed: new EmbedBuilder().setDescription('❌ That plot is already fertilized!').setColor(0xffa500) };
    }

    // Check for fertilizer in inventory
    const hasFertilizer = await this.checkAndConsumeFertilizer(userId);
    if (!hasFertilizer) {
      return {
        embed: new EmbedBuilder()
          .setDescription('❌ You don\'t have any **Fertilizer**! Craft it or buy from the shop.')
          .setColor(0xff0000),
      };
    }

    await this.supabase.from('economy_farm_plots')
      .update({ fertilized: true })
      .eq('id', plot.id);

    return {
      embed: new EmbedBuilder()
        .setTitle('🌿 Fertilized!')
        .setDescription(`Plot ${plotNum} has been fertilized! Growth time reduced by **${config.economy_fertilizer_time_reduction_pct}%**.`)
        .setColor(0x4caf50)
        .setTimestamp(),
    };
  }

  // ── Helpers ─────────────────────────────────────────────

  private async getPlots(userId: string): Promise<Plot[]> {
    const { data } = await this.supabase
      .from('economy_farm_plots')
      .select('id, plot_index, crop_id, planted_at, watered_at, fertilized, harvested')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .order('plot_index');

    return (data as Plot[] | null) ?? [];
  }

  private async getCrops(): Promise<Crop[]> {
    const { data } = await this.supabase
      .from('economy_crops')
      .select('id, name, emoji, grow_seconds, wilt_seconds, sell_price, seeds_returned, seed_item_id')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .order('sort_order');

    return (data as Crop[] | null) ?? [];
  }

  private async seedDefaultCrops(): Promise<void> {
    const rows = DEFAULT_CROPS.map((c) => ({
      guild_id: this.guild.id,
      ...c,
      seed_item_id: null,
      is_default: true,
    }));
    await this.supabase.from('economy_crops').insert(rows);
  }

  private getPlotStatus(plot: Plot | undefined, cropMap: Map<string, Crop>, config: FarmingConfig): PlotStatus {
    if (!plot || !plot.crop_id || plot.harvested) return 'empty';

    const crop = cropMap.get(plot.crop_id);
    if (!crop || !plot.planted_at) return 'empty';

    const plantedMs = new Date(plot.planted_at).getTime();
    const now = Date.now();
    const elapsed = now - plantedMs;

    let growTime = crop.grow_seconds * 1000;
    if (plot.fertilized) {
      growTime *= (1 - config.economy_fertilizer_time_reduction_pct / 100);
    }

    if (!plot.watered_at) return 'planted'; // needs watering
    if (elapsed < growTime) return 'growing';
    if (config.economy_farming_wilt_enabled && elapsed > growTime + crop.wilt_seconds * 1000) return 'wilted';
    return 'ready';
  }

  private getTimeInfo(plot: Plot, crop: Crop, config: FarmingConfig): string {
    if (!plot.planted_at) return '';

    const plantedMs = new Date(plot.planted_at).getTime();
    const now = Date.now();
    const elapsed = now - plantedMs;

    let growTime = crop.grow_seconds * 1000;
    if (plot.fertilized) {
      growTime *= (1 - config.economy_fertilizer_time_reduction_pct / 100);
    }

    if (!plot.watered_at) return '💧 Needs water!';

    const remaining = Math.max(0, growTime - elapsed);
    if (remaining > 0) {
      return `⏱️ ${this.formatTime(Math.ceil(remaining / 1000))} left`;
    }
    return '✅ Ready!';
  }

  private findEmptyPlot(plots: Plot[], config: FarmingConfig, cropMap: Map<string, Crop>): number {
    for (let i = 0; i < config.economy_farm_grid_size; i++) {
      const plot = plots.find((p) => p.plot_index === i);
      const status = this.getPlotStatus(plot, cropMap, config);
      if (status === 'empty' || status === 'wilted') return i;
    }
    return -1;
  }

  private async checkAndConsumeSeed(userId: string, seedItemId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('item_id', seedItemId)
      .gt('quantity', 0)
      .maybeSingle();

    if (!data) return false;

    const newQty = (data.quantity as number) - 1;
    if (newQty <= 0) {
      await this.supabase.from('economy_inventory').delete().eq('id', data.id);
    } else {
      await this.supabase.from('economy_inventory')
        .update({ quantity: newQty })
        .eq('id', data.id);
    }
    return true;
  }

  private async checkAndConsumeFertilizer(userId: string): Promise<boolean> {
    // Find fertilizer item by name
    const { data: items } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity, economy_items!inner(name)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0);

    if (!items) return false;

    const fert = (items as any[]).find((i) =>
      ((i.economy_items as any)?.name ?? '').toLowerCase() === 'fertilizer'
    );
    if (!fert) return false;

    const newQty = (fert.quantity as number) - 1;
    if (newQty <= 0) {
      await this.supabase.from('economy_inventory').delete().eq('id', fert.id);
    } else {
      await this.supabase.from('economy_inventory')
        .update({ quantity: newQty })
        .eq('id', fert.id);
    }
    return true;
  }

  private async addToInventory(userId: string, itemId: string, quantity: number): Promise<void> {
    const { data: existing } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .maybeSingle();

    if (existing) {
      await this.supabase.from('economy_inventory')
        .update({ quantity: (existing.quantity as number) + quantity, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await this.supabase.from('economy_inventory').insert({
        guild_id: this.guild.id,
        user_id: userId,
        item_id: itemId,
        quantity,
      });
    }
  }

  private async addToWallet(userId: string, amount: number): Promise<void> {
    const { data: wallet } = await this.supabase
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (wallet) {
      await this.supabase.from('economy_wallets')
        .update({ wallet: (wallet.wallet as number) + amount, updated_at: new Date().toISOString() })
        .eq('guild_id', this.guild.id)
        .eq('user_id', userId);
    } else {
      await this.supabase.from('economy_wallets').insert({
        guild_id: this.guild.id,
        user_id: userId,
        wallet: amount,
        bank: 0,
      });
    }
  }

  private formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      return `${m}m`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
}
