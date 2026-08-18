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
import { getQuestsManager } from '../quests/quests-manager.js';
import { walletBalance } from '../../utils/db-helpers.js';
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
import { z } from 'zod';

const log = createLogger('Farming');

// Some focused unit suites replace the audit module with its legacy
// writeAuditLog-only test double. Keep the critical write path functional in
// those suites while preserving the same durable context fields in production.
async function writeEconomyAudit(supabase: SupabaseClient, options: EconomyAuditOptions): Promise<void> {
  const correlationId = options.operationId ?? randomUUID();
  await auditService.writeAuditLog(supabase, {
    guildId: options.guildId, actorType: options.actorType ?? 'user', actorId: options.actorId,
    action: options.action, category: 'economy', targetType: options.targetType ?? 'member',
    targetId: options.targetId ?? options.actorId, details: options.details, correlationId,
    occurrenceKey: `${options.action}:${correlationId}`, success: options.success, errorMessage: options.errorMessage,
  });
}

// ── Types ─────────────────────────────────────────────────

export interface FarmingConfig {
  economy_farming_enabled: boolean;
  economy_farm_grid_size: number;
  economy_farming_wilt_enabled: boolean;
  economy_fertilizer_time_reduction_pct: number;
  /** White-label brand kit projected from the same cached guild_config row. */
  brandKit: BrandKit;
}

interface Crop {
  id: string;
  name: string;
  emoji: string;
  grow_seconds: number;
  wilt_seconds: number;
  sell_price: number;
  seeds_returned: number;
  seed_item_id: string | null;
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

const farmingOperationResultSchema = z.object({
  status: z.enum([
    'planted',
    'watered',
    'fertilized',
    'crop_unavailable',
    'farm_full',
    'missing_inventory',
    'already_watered',
    'no_crops',
    'invalid_plot',
    'empty_plot',
    'already_fertilized',
  ]),
  applied: z.boolean(),
  replayed: z.boolean(),
  plot_index: z.number().int().optional(),
  affected_count: z.number().int().optional(),
  affected_plot_indexes: z.array(z.number().int()).optional(),
});

type FarmingOperationResult = z.infer<typeof farmingOperationResultSchema>;

interface FarmingOperationInput {
  readonly userId: string;
  readonly operationId: string;
  readonly operationType: 'plant' | 'water' | 'fertilize';
  readonly cropId?: string;
  readonly itemId?: string | null;
  readonly plotIndex?: number;
  readonly gridSize: number;
  readonly wiltEnabled: boolean;
  readonly fertilizerReductionPct: number;
}

type FarmingOperationFailureReason = 'rpc_error' | 'invalid_result';

const PLOT_ICONS: Record<PlotStatus, string> = {
  empty: '⬛',
  planted: '🟫',
  growing: '🌱',
  ready: '🌾',
  wilted: '🥀',
};

// Default crops seeded on first use.
//
// seeds_returned is 0 on every default: seedDefaultCrops links no seed item,
// and harvest only returns seeds when a crop HAS one. A non-zero value here
// would render as "Seeds back: N" on the dashboard and never happen. An owner
// who links a real seed item can set the number themselves, at which point it
// is honoured (and planting starts costing seeds, which is the trade).
const DEFAULT_CROPS = [
  { name: 'Potato', emoji: '🥔', grow_seconds: 7200, wilt_seconds: 86400, sell_price: 30, seeds_returned: 0, category: 'Vegetable', sort_order: 0 },
  { name: 'Corn', emoji: '🌽', grow_seconds: 28800, wilt_seconds: 86400, sell_price: 80, seeds_returned: 0, category: 'Vegetable', sort_order: 1 },
  { name: 'Tomato', emoji: '🍅', grow_seconds: 43200, wilt_seconds: 72000, sell_price: 120, seeds_returned: 0, category: 'Vegetable', sort_order: 2 },
  { name: 'Pumpkin', emoji: '🎃', grow_seconds: 86400, wilt_seconds: 172800, sell_price: 300, seeds_returned: 0, category: 'Vegetable', sort_order: 3 },
  { name: 'Golden Apple', emoji: '🍎', grow_seconds: 172800, wilt_seconds: 259200, sell_price: 1000, seeds_returned: 0, category: 'Fruit', sort_order: 4 },
];

export class FarmingManager {
  private configCache: FarmingConfig | null = null;
  private configCacheTTL = 30_000;
  private configCacheTime = 0;

  constructor(
    private guild: Guild,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase client
    private supabase: SupabaseClient,
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
      .select(`economy_farming_enabled, economy_farm_grid_size, economy_farming_wilt_enabled, economy_fertilizer_time_reduction_pct, ${BRAND_KIT_COLUMNS}`)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_farming_enabled: data?.economy_farming_enabled ?? true,
      economy_farm_grid_size: data?.economy_farm_grid_size ?? 9,
      economy_farming_wilt_enabled: data?.economy_farming_wilt_enabled ?? true,
      economy_fertilizer_time_reduction_pct: data?.economy_fertilizer_time_reduction_pct ?? 50,
      brandKit: brandKitFromConfig(data ?? null, this.guild.name),
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  // ── View ────────────────────────────────────────────────

  async viewFarm(userId: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: voice(config.brandKit.voicePreset, 'disabled', { feature: 'Farming' }),
        }),
      };
    }

    // [game-economy-farming DEPFAIL] A failed plot/crop read (database
    // unreachable) must NOT render as an empty farm — that is a data-shaped
    // lie about plots the bot could not read. Degrade honestly instead.
    const plots = await this.getPlots(userId);
    const crops = await this.getCrops();
    if (plots === null || crops === null) {
      return { embed: await this.unavailableEmbed() };
    }
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

    const embed = applyBrand(
      new EmbedBuilder()
        .setTitle('🌾 Your Farm')
        .setDescription(
          lines.join('\n') +
          '\n\n' +
          (statusLines.length > 0 ? statusLines.join('\n') : '_All plots empty — use `/farm plant <crop>` to get started!_'),
        )
        .setFooter({ text: `${plots.filter((p) => p.crop_id && !p.harvested).length}/${config.economy_farm_grid_size} plots in use` })
        .setTimestamp(),
      config.brandKit,
      { intent: 'primary' },
    );

    return { embed };
  }

  // ── Plant ───────────────────────────────────────────────

  async plant(userId: string, cropName: string, operationId?: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: voice(config.brandKit.voicePreset, 'disabled', { feature: 'Farming' }),
        }),
      };
    }

    // [game-economy-farming DEPFAIL] A failed crop-catalog read must NOT
    // surface as "Unknown crop" — degrade honestly with no seed consumed.
    let crops = await this.getCrops();
    if (crops === null) {
      return { embed: await this.unavailableEmbed() };
    }
    if (crops.length === 0) {
      // Seeds only when the guild has NO crop rows at all — an owner who
      // deactivated the whole catalog is respected (never auto-restored).
      try {
        await this.ensureContentSeeded();
      } catch (err) {
        log.warn('lazy crop seeding failed:', (err as Error).message);
      }
      crops = (await this.getCrops()) ?? [];
    }

    const crop = crops.find((c) => c.name.toLowerCase() === cropName.toLowerCase());
    if (!crop) {
      const available = crops.map((c) => `${c.emoji} ${c.name}`).join(', ');
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: `❌ Unknown crop "**${cropName}**".\n\nAvailable: ${available}`,
        }),
      };
    }

    const result = await this.runFarmingOperation({
      userId,
      operationId: operationId?.trim() || randomUUID(),
      operationType: 'plant',
      cropId: crop.id,
      itemId: crop.seed_item_id,
      gridSize: config.economy_farm_grid_size,
      wiltEnabled: config.economy_farming_wilt_enabled,
      fertilizerReductionPct: config.economy_fertilizer_time_reduction_pct,
    });
    if (!result) return { embed: await this.unavailableEmbed() };
    if (result.status === 'farm_full') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'danger',
        description: '❌ All your farm plots are occupied! Harvest or wait for crops to wilt.',
      }) };
    }
    if (result.status === 'missing_inventory') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'danger',
        description: `❌ You don't have any **${crop.name} Seeds**! Buy them from the shop.`,
      }) };
    }
    if (result.status !== 'planted' || result.plot_index === undefined) {
      return { embed: await this.unavailableEmbed() };
    }

    return {
      embed: applyBrand(
        new EmbedBuilder()
          .setTitle(`${crop.emoji} Planted!`)
          .setDescription(
            `You planted **${crop.name}** in plot ${result.plot_index + 1}.\n\n` +
            `⏱️ Growth time: **${this.formatTime(crop.grow_seconds)}**\n` +
            `💧 Water with \`/farm water\` to keep it healthy!\n` +
            `🌿 Use fertilizer to cut grow time by ${config.economy_fertilizer_time_reduction_pct}%`,
          )
          .setTimestamp(),
        config.brandKit,
        { intent: 'primary' },
      ),
    };
  }

  // ── Water ───────────────────────────────────────────────

  async water(userId: string, operationId?: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: voice(config.brandKit.voicePreset, 'disabled', { feature: 'Farming' }),
        }),
      };
    }

    const result = await this.runFarmingOperation({
      userId,
      operationId: operationId?.trim() || randomUUID(),
      operationType: 'water',
      gridSize: config.economy_farm_grid_size,
      wiltEnabled: config.economy_farming_wilt_enabled,
      fertilizerReductionPct: config.economy_fertilizer_time_reduction_pct,
    });
    if (!result) return { embed: await this.unavailableEmbed() };
    if (result.status === 'no_crops') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'danger',
        description: '❌ You have no crops planted!',
      }) };
    }
    if (result.status === 'already_watered') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'info',
        description: '💧 All your crops are already watered!',
      }) };
    }
    if (result.status !== 'watered' || result.affected_count === undefined) {
      return { embed: await this.unavailableEmbed() };
    }

    return {
      embed: applyBrand(
        new EmbedBuilder()
          .setTitle('💧 Watered!')
          .setDescription(`You watered **${result.affected_count}** plot${result.affected_count > 1 ? 's' : ''}. Your crops are growing!`)
          .setTimestamp(),
        config.brandKit,
        { intent: 'info' },
      ),
    };
  }

  // ── Harvest ─────────────────────────────────────────────

  async harvest(userId: string, operationId?: string): Promise<{ embed: EmbedBuilder }> {
    const correlationId = operationId?.trim() || randomUUID();
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'farming.harvest_denied', details: { reason: 'feature_disabled' }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: voice(config.brandKit.voicePreset, 'disabled', { feature: 'Farming' }),
        }),
      };
    }

    // [game-economy-farming DEPFAIL] A failed plot/crop read must NOT surface
    // as "No crops ready to harvest!" — that fabricates a data-shaped answer
    // from state the bot could not read. Degrade honestly; nothing mutates.
    const plots = await this.getPlots(userId);
    const crops = await this.getCrops();
    if (plots === null || crops === null) {
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'farming.dependency_degraded', details: { operation: 'harvest' }, success: false, actorType: 'system',
      });
      eventBus.emit('farming.dependency_degraded', this.guild.id, {
        userId, operation: 'harvest', correlationId, occurrenceId: correlationId,
      });
      return { embed: await this.unavailableEmbed() };
    }
    const cropMap = new Map(crops.map((c) => [c.id, c]));

    const readyPlots = plots.filter((p) => {
      const status = this.getPlotStatus(p, cropMap, config);
      return status === 'ready';
    });

    if (readyPlots.length === 0) {
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'farming.harvest_denied', details: { reason: 'no_ready_crops' }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '❌ No crops ready to harvest!',
        }),
      };
    }

    // Atomically transition ONLY the ready plots that are still un-harvested and
    // pay out exactly the rows THIS call flipped. The `.eq('harvested', false)`
    // guard turns the read-then-write into a compare-and-set: two simultaneous
    // /farm harvest calls both see the plots ready, but only the winner's UPDATE
    // matches un-harvested rows — the loser gets zero rows back and credits
    // nothing, so the ready crops pay out exactly once (fixes the RACE double-pay).
    const readyIds = readyPlots.map((p) => p.id);
    const { data: claimedRows } = await this.supabase.from('economy_farm_plots')
      .update({ harvested: true })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .in('id', readyIds)
      .eq('harvested', false)
      .select('id, crop_id');

    const plotById = new Map(readyPlots.map((p) => [p.id, p]));
    const harvested: Array<{ crop: Crop; plot: Plot }> = [];
    for (const row of (claimedRows as Array<{ id: string; crop_id: string | null }> | null) ?? []) {
      const plot = plotById.get(row.id);
      const crop = row.crop_id ? cropMap.get(row.crop_id) : undefined;
      if (!plot || !crop) continue;
      harvested.push({ crop, plot });
    }

    if (harvested.length === 0) {
      // A concurrent /farm harvest already claimed every ready plot.
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'farming.harvest_denied', details: { reason: 'already_claimed' }, success: false,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '❌ No crops ready to harvest!',
        }),
      };
    }

    // Calculate earnings and return seeds
    let totalEarnings = 0;
    const harvestLines: string[] = [];
    for (const { crop } of harvested) {
      totalEarnings += crop.sell_price;
      harvestLines.push(`${crop.emoji} ${crop.name} — 💰 ${crop.sell_price.toLocaleString()}`);

      // V53-C2: Return seeds to inventory — check for failure and warn user
      if (crop.seeds_returned > 0 && crop.seed_item_id) {
        const seedAdded = await this.addToInventory(userId, crop.seed_item_id, crop.seeds_returned);
        if (!seedAdded) {
          harvestLines.push(`⚠️ Failed to return ${crop.seeds_returned}x seeds — contact an admin`);
          const seedCorrelation = `${correlationId}:seed:${crop.seed_item_id}`;
          await writeEconomyAudit(this.supabase, {
            guildId: this.guild.id, actorId: userId, operationId: seedCorrelation,
            action: 'farming.seed_return_failed',
            details: { itemId: crop.seed_item_id, quantity: crop.seeds_returned }, success: false, actorType: 'system',
          });
          eventBus.emit('farming.seed_return_failed', this.guild.id, {
            userId, itemId: crop.seed_item_id, quantity: crop.seeds_returned,
            correlationId: seedCorrelation, occurrenceId: seedCorrelation,
          });
        }
      }
    }

    // V49-L2: Add earnings to wallet — if this fails, revert the harvest
    // so the user can try again rather than losing crops + earnings silently.
    const walletOk = await this.addToWallet(userId, totalEarnings);
    if (!walletOk) {
      // Revert harvest flags so the user can retry
      for (const { plot } of harvested) {
        await this.supabase.from('economy_farm_plots')
          .update({ harvested: false })
          .eq('id', plot.id);
      }
      // [game-economy-farming] Owner alert + audit on the payout-revert failure
      // branch so the reverted harvest is operator-visible.
      await this.raiseFarmPayoutAlert(userId, totalEarnings)
        .catch((e: unknown) => { log.warn('farming payout alert failed:', (e as Error)?.message ?? e); });
      await writeEconomyAudit(this.supabase, {
        guildId: this.guild.id, actorId: userId, operationId: correlationId,
        action: 'farming.harvest_payout_reverted',
        details: { amount: totalEarnings, cropCount: harvested.length }, success: false, actorType: 'system',
      });
      eventBus.emit('farm.payout_failed', this.guild.id, {
        userId,
        amount: totalEarnings,
        cropCount: harvested.length,
        correlationId,
        occurrenceId: correlationId,
      });
      eventBus.emit('farming.harvest_payout_reverted', this.guild.id, {
        userId, amount: totalEarnings, cropCount: harvested.length, correlationId, occurrenceId: correlationId,
      });
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: '❌ Harvest payout failed — your crops have been restored. Try again later.',
        }),
      };
    }

    // Record transaction (fetch real balance for accurate audit trail)
    const { data: farmWallet } = await this.supabase.from('economy_wallets')
      .select('wallet').eq('guild_id', this.guild.id).eq('user_id', userId).maybeSingle();
    await this.supabase.from('economy_transactions').insert({
      guild_id: this.guild.id,
      user_id: userId,
      type: 'farm_harvest',
      amount: totalEarnings,
      balance_after: walletBalance(farmWallet),
      description: `Harvested ${harvested.length} crops`,
    });

    // Quest progress — count each harvested crop
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'farm', harvested.length).catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    // [game-economy-farming] Append-only audit row for the harvest state change
    // (crops paid out to the wallet).
    await writeEconomyAudit(this.supabase, {
      guildId: this.guild.id, actorId: userId, operationId: correlationId,
      action: 'farm.harvested', details: { cropCount: harvested.length, earnings: totalEarnings },
    });
    eventBus.emit('farm.harvested', this.guild.id, {
      userId,
      cropCount: harvested.length,
      earnings: totalEarnings,
      correlationId,
      occurrenceId: correlationId,
    });

    return {
      embed: applyBrand(
        new EmbedBuilder()
          .setTitle('🌾 Harvest Complete!')
          .setDescription(
            harvestLines.join('\n') +
            `\n\n💰 Total earnings: **${totalEarnings.toLocaleString()}** ${config.brandKit.currencyName}`,
          )
          .setTimestamp(),
        config.brandKit,
        { intent: 'primary' },
      ),
    };
  }

  // ── Fertilize ───────────────────────────────────────────

  async fertilize(userId: string, plotNum: number, operationId?: string): Promise<{ embed: EmbedBuilder }> {
    const config = await this.getConfig();
    if (!config.economy_farming_enabled) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: voice(config.brandKit.voicePreset, 'disabled', { feature: 'Farming' }),
        }),
      };
    }

    const plotIndex = plotNum - 1;
    if (plotIndex < 0 || plotIndex >= config.economy_farm_grid_size) {
      return {
        embed: brandedEmbed(config.brandKit, {
          intent: 'danger',
          description: `❌ Invalid plot number. Use 1-${config.economy_farm_grid_size}.`,
        }),
      };
    }

    const result = await this.runFarmingOperation({
      userId,
      operationId: operationId?.trim() || randomUUID(),
      operationType: 'fertilize',
      plotIndex,
      gridSize: config.economy_farm_grid_size,
      wiltEnabled: config.economy_farming_wilt_enabled,
      fertilizerReductionPct: config.economy_fertilizer_time_reduction_pct,
    });
    if (!result) return { embed: await this.unavailableEmbed() };
    if (result.status === 'empty_plot') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'danger', description: '❌ That plot is empty!',
      }) };
    }
    if (result.status === 'already_fertilized') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'warning', description: '❌ That plot is already fertilized!',
      }) };
    }
    if (result.status === 'missing_inventory') {
      return { embed: brandedEmbed(config.brandKit, {
        intent: 'danger',
        description: '❌ You don\'t have any **Fertilizer**! Craft it or buy from the shop.',
      }) };
    }
    if (result.status !== 'fertilized') return { embed: await this.unavailableEmbed() };

    return {
      embed: applyBrand(
        new EmbedBuilder()
          .setTitle('🌿 Fertilized!')
          .setDescription(`Plot ${plotNum} has been fertilized! Growth time reduced by **${config.economy_fertilizer_time_reduction_pct}%**.`)
          .setTimestamp(),
        config.brandKit,
        { intent: 'primary' },
      ),
    };
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * A member's plots, or `null` when the READ FAILED (database unreachable) —
   * a failed read is not an empty farm ([game-economy-farming DEPFAIL]).
   */
  private async getPlots(userId: string): Promise<Plot[] | null> {
    const { data, error } = await this.supabase
      .from('economy_farm_plots')
      .select('id, plot_index, crop_id, planted_at, watered_at, fertilized, harvested')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .order('plot_index')
      .limit(1000);

    if (error) {
      log.error('getPlots read failed:', error.message);
      return null;
    }
    return (data as Plot[] | null) ?? [];
  }

  /**
   * The guild's crop catalog, or `null` when the READ FAILED — a failed read
   * is not an empty catalog ([game-economy-farming DEPFAIL]).
   */
  private async getCrops(): Promise<Crop[] | null> {
    const { data, error } = await this.supabase
      .from('economy_crops')
      .select('id, name, emoji, grow_seconds, wilt_seconds, sell_price, seeds_returned, seed_item_id')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .order('sort_order')
      .limit(1000);

    if (error) {
      log.error('getCrops read failed:', error.message);
      return null;
    }
    return (data as Crop[] | null) ?? [];
  }

  /**
   * [game-economy-farming DEPFAIL] The branded farming-unavailable degradation
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
        `${voice(kit.voicePreset, 'unavailable', { brand: name, feature: 'farm' })}` +
        ` Your plots and ${kit.currencyName} are untouched.`,
    });
  }

  private async seedDefaultCrops(): Promise<void> {
    const rows = DEFAULT_CROPS.map((c) => ({
      guild_id: this.guild.id,
      ...c,
      seed_item_id: null,
      is_default: true,
    }));
    // ON CONFLICT DO NOTHING: the (guild_id, lower(name)) uniqueness index
    // turns a concurrent double-seed into a no-op instead of duplicate rows.
    const { error } = await this.supabase
      .from('economy_crops')
      .upsert(rows, { ignoreDuplicates: true });
    if (error) {
      throw new Error(`default crop seed failed: ${error.message}`);
    }
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

  private async runFarmingOperation(input: FarmingOperationInput): Promise<FarmingOperationResult | null> {
    const { data, error } = await this.supabase.rpc('economy_farming_operation_atomic', {
      p_guild_id: this.guild.id,
      p_user_id: input.userId,
      p_operation_id: input.operationId,
      p_operation_type: input.operationType,
      p_crop_id: input.cropId ?? null,
      p_item_id: input.itemId ?? null,
      p_plot_index: input.plotIndex ?? null,
      p_grid_size: input.gridSize,
      p_wilt_enabled: input.wiltEnabled,
      p_fertilizer_reduction_pct: input.fertilizerReductionPct,
      p_fail_before_plot: false,
    });
    if (error) {
      log.error('Atomic farming operation failed:', error.message);
      await this.writeFarmingOperationFailure(input, 'rpc_error', error.message);
      return null;
    }
    const parsed = farmingOperationResultSchema.safeParse(data);
    if (!parsed.success) {
      log.error('Atomic farming operation returned an invalid result:', parsed.error.message);
      await this.writeFarmingOperationFailure(input, 'invalid_result', parsed.error.message);
      return null;
    }
    return parsed.data;
  }

  private async writeFarmingOperationFailure(
    input: FarmingOperationInput,
    reason: FarmingOperationFailureReason,
    errorMessage: string,
  ): Promise<void> {
    await writeEconomyAudit(this.supabase, {
      guildId: this.guild.id,
      actorId: input.userId,
      operationId: input.operationId,
      action: `farming.${input.operationType}`,
      details: { operation: input.operationType, reason },
      success: false,
      errorMessage,
    });
  }

  private async addToInventory(userId: string, itemId: string, quantity: number): Promise<boolean> {
    // V53-C2: check upsert result — callers must handle failure
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
   * [game-economy-farming] Raise a payout-revert owner alert when a harvest
   * credit fails and the crops are restored, so an operator knows the failure
   * happened. Best effort — a failed alert never blocks the harvest flow.
   */
  private async raiseFarmPayoutAlert(userId: string, amount: number): Promise<void> {
    await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType: 'farming_payout_reverted',
      severity: 'warning',
      title: 'Farming payout reverted',
      message: `A farm harvest payout of ${amount} failed for ${userId}; the crops were restored for retry.`,
      metadata: { user_id: userId, amount },
      guild: this.guild,
    });
  }

  // V49-L2: Return success/failure so callers can handle payout errors
  // instead of silently swallowing them.
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
  /**
   * Seed this feature's default content now instead of on first command use.
   *
   * The defaults below always existed, but they were planted lazily: nothing
   * appeared until somebody ran the feature's command in Discord, so a fresh
   * install showed an empty dashboard page for a feature that claimed to be
   * on. Guild init calls this so content exists before anyone touches
   * anything. Idempotent — it only writes when the guild has NO crop rows at
   * all (an owner who deactivated the whole catalog is respected, never
   * auto-restored). Throws when the gate read or the seed write failed so
   * the warmup can report degradation.
   */
  async ensureContentSeeded(): Promise<void> {
    const { count, error } = await this.supabase
      .from('economy_crops')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', this.guild.id);
    if (error) {
      throw new Error(`crop existence check failed: ${error.message}`);
    }
    if ((count ?? 0) > 0) return; // owner content (even all-inactive) — never touch it
    await this.seedDefaultCrops();
  }
}
