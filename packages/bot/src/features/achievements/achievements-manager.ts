/**
 * AchievementsManager — milestone badges + prestige system.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { eventBus } from '../../services/event-bus.js';

const log = createLogger('Achievements');

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, AchievementsManager>();

export function registerAchievementsManager(mgr: AchievementsManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterAchievementsManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateAchievementsCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

/**
 * V10 Audit §14.P3a — Max config-cache entries (defense-in-depth).
 * The GuildRouter already evicts idle guilds after 30 min, so this
 * naturally stays small. The cap prevents unbounded growth if
 * AchievementsManager outlives its guild context.
 */
const CONFIG_CACHE_MAX = 500;
const CONFIG_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export class AchievementsManager {
  private supabase: SupabaseClient;
  private configCache = new Map<string, { data: DbGuildConfig; time: number }>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  clearCache(): void { this.configCache.clear(); }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const now = Date.now();
    const cached = this.configCache.get(guildId);
    if (cached && now - cached.time < CONFIG_CACHE_TTL_MS) return cached.data;

    const { data } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) {
      // Evict oldest if at capacity
      if (this.configCache.size >= CONFIG_CACHE_MAX) {
        const oldest = this.configCache.keys().next().value;
        if (oldest !== undefined) this.configCache.delete(oldest);
      }
      this.configCache.set(guildId, { data, time: now });
    }
    return data;
  }

  async viewBadges(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const { data: allDefs } = await this.supabase
      .from('economy_achievement_defs').select('*').eq('guild_id', guildId).order('created_at')
      .limit(1000);

    const { data: userAch } = await this.supabase
      .from('economy_user_achievements').select('achievement_id').eq('guild_id', guildId).eq('user_id', userId)
      .limit(1000);

    // V11 Audit L-6: Replace `any` casts with typed row references.
    const unlockedIds = new Set((userAch ?? []).map((a) => a.achievement_id));

    const lines = (allDefs ?? []).map((d) => {
      const unlocked = unlockedIds.has(d.id);
      if (d.hidden && !unlocked) return `❓ *Hidden achievement*`;
      return `${unlocked ? '✅' : '⬜'} ${d.badge_emoji} **${d.name}** — ${d.description}`;
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🏆 Achievements')
        .setDescription(lines.join('\n') || 'No achievements configured yet.')
        .setColor(0xF1C40F)
        .setFooter({ text: `${unlockedIds.size}/${(allDefs ?? []).length} unlocked` })],
    });
  }

  /** Check if a user should unlock an achievement. Called from other modules. */
  async checkAndUnlock(guildId: string, userId: string, conditionType: string, currentValue: number): Promise<string | null> {
    const config = await this.getConfig(guildId);
    if (!config?.economy_achievements_enabled) return null;

    const { data: defs } = await this.supabase
      .from('economy_achievement_defs')
      .select('*')
      .eq('guild_id', guildId)
      .eq('condition_type', conditionType)
      .limit(1000);

    for (const def of defs ?? []) {
      if (currentValue < def.condition_value) continue;

      // Idempotent unlock: INSERT ... ON CONFLICT DO NOTHING against
      // UNIQUE(guild_id,user_id,achievement_id). A row is RETURNED only when
      // this call actually inserted the unlock, so a concurrent check or a
      // re-fire past the same threshold never pays the badge reward twice.
      const { data: inserted, error: insErr } = await this.supabase
        .from('economy_user_achievements')
        .upsert(
          { guild_id: guildId, user_id: userId, achievement_id: def.id },
          { onConflict: 'guild_id,user_id,achievement_id', ignoreDuplicates: true },
        )
        .select('id');

      if (insErr) {
        log.error(`Failed to unlock achievement ${def.id} for ${userId}:`, insErr.message);
        continue;
      }
      // No returned row → the achievement was already unlocked; do not re-reward.
      if (!inserted || inserted.length === 0) continue;

      if (def.reward_currency > 0) {
        const { error: rewardErr } = await this.supabase.rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: userId, p_amount: def.reward_currency,
        });
        if (rewardErr) log.error(`Failed to award ${def.reward_currency} to ${userId}:`, rewardErr.message);
      }

      // [game-economy-achievements-prestige] Append-only audit row on the badge
      // unlock state change (catalog contracts one per state change).
      eventBus.emit('achievement.unlocked', guildId, {
        userId,
        achievementId: def.id as string,
        name: def.name as string,
        rewardCurrency: (def.reward_currency as number) ?? 0,
      });

      return def.name;
    }
    return null;
  }

  // ── Prestige ────────────────────────────────────────────

  async prestige(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_prestige_enabled) {
      await interaction.reply({ content: '❌ Prestige is not enabled.', ephemeral: true }); return;
    }

    const minLevel = config.economy_prestige_min_level ?? 50;
    const minNetWorth = config.economy_prestige_min_net_worth ?? 1000000;
    const multiplierGain = config.economy_prestige_multiplier_pct ?? 10;
    // New column may not be in the generated types yet — read defensively.
    const maxLevel = (config as { economy_prestige_max_level?: number | null }).economy_prestige_max_level ?? 10;

    // Atomic + idempotent: the requirement checks, prestige-cap check, wallet/bank
    // reset, and prestige-record bump commit as ONE call keyed on the interaction
    // id, so a redelivered /prestige applies exactly once (a replay never
    // double-bumps the level or the earning multiplier).
    const { data, error } = await this.supabase.rpc('economy_prestige_apply', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_min_level: minLevel,
      p_min_net_worth: minNetWorth,
      p_multiplier_gain: multiplierGain,
      p_max_level: maxLevel,
      p_request_id: interaction.id,
    });

    if (error || !data || typeof data !== 'object') {
      log.error('economy_prestige_apply failed', { detail: error?.message });
      await interaction.reply({ content: '❌ Could not prestige right now — please try again.', ephemeral: true });
      return;
    }

    const result = data as { status?: string; replayed?: boolean; new_level?: number; new_multiplier?: number; level?: number; net_worth?: number; max_level?: number };
    switch (result.status) {
      case 'level_too_low':
        await interaction.reply({ content: `❌ You need to be at least **level ${minLevel}** to prestige. You're level **${result.level ?? 0}**.`, ephemeral: true });
        return;
      case 'net_worth_too_low':
        await interaction.reply({ content: `❌ You need at least **${minNetWorth.toLocaleString()}** net worth to prestige. You have **${(result.net_worth ?? 0).toLocaleString()}**.`, ephemeral: true });
        return;
      case 'prestige_capped':
        await interaction.reply({ content: `⭐ You've reached the maximum prestige level (**${result.max_level ?? maxLevel}**). Your earning multiplier is already at its ceiling.`, ephemeral: true });
        return;
      case 'prestiged':
        break;
      default:
        await interaction.reply({ content: '❌ Could not prestige right now — please try again.', ephemeral: true });
        return;
    }

    // [game-economy-achievements-prestige] Append-only audit row on the prestige
    // state change (wallet/bank reset + earning multiplier bump). Emitted ONLY
    // when this call actually applied the reset: the RPC returns
    // status='prestiged' with replayed=true for a re-delivered interaction id
    // (economy_prestige.last_request_id) whose reset already committed, and
    // re-emitting there would append a second audit row for one logical
    // prestige — the ledger must stay replay-idempotent like the DB state.
    if (result.replayed !== true) {
      eventBus.emit('prestige.performed', guildId, {
        userId,
        newLevel: result.new_level ?? 0,
        newMultiplier: result.new_multiplier ?? 0,
      });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`⭐ Prestige Level ${result.new_level}!`)
        .setDescription(
          `You\'ve prestiged! Your wallet and bank have been reset.\n\n` +
          `✅ *Kept:* Inventory, pets, achievements, streaks\n` +
          `🔄 *Reset:* Wallet, bank\n` +
          `📈 *New earning multiplier:* +**${result.new_multiplier}%**`
        )
        .setColor(0xF1C40F)],
    });
  }
}
