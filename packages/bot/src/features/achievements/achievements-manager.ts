/**
 * AchievementsManager — milestone badges + prestige system.
 */
import { EmbedBuilder, type ChatInputCommandInteraction, type Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';
import { eventBus } from '../../services/event-bus.js';
import * as auditService from '../../services/audit.js';
import type { EconomyAuditOptions } from '../../services/audit.js';
import { randomUUID } from 'node:crypto';
import { handleLevelUp } from '../levels/level-announcer.js';
import { brandKitFromConfig } from '../branding/brand-kit.js';
import { applyBrand, brandedEmbed } from '../branding/branded-embed.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';

const log = createLogger('Achievements');

async function writeEconomyAudit(supabase: SupabaseClient, options: EconomyAuditOptions): Promise<void> {
  const correlationId = options.operationId ?? randomUUID();
  await auditService.writeAuditLog(supabase, {
    guildId: options.guildId, actorType: options.actorType ?? 'user', actorId: options.actorId,
    action: options.action, category: 'economy', targetType: options.targetType ?? 'member',
    targetId: options.targetId ?? options.actorId, details: options.details, correlationId,
    occurrenceKey: `${options.action}:${correlationId}`, success: options.success, errorMessage: options.errorMessage,
  });
}

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
  private guild: Guild | null;
  private configCache = new Map<string, { data: DbGuildConfig; time: number }>();
  /**
   * Re-entrancy fence for reward_xp payment (keyed guildId:userId). Paying an
   * achievement's XP reward can level the member up, and level-up side effects
   * can re-enter checkAndUnlock in the SAME call chain — without the fence
   * that nests achievement checks inside achievement checks. A fenced call
   * returns null; unlocks are idempotent, so the next threshold event simply
   * catches up.
   */
  private xpRewardInFlight = new Set<string>();

  constructor(supabase: SupabaseClient, guild?: Guild) {
    this.supabase = supabase;
    // Optional so callers without a live Discord handle (tests) still work;
    // guild-init always passes the guild so reward XP runs the full level-up
    // path (role rewards + announcements).
    this.guild = guild ?? null;
  }

  clearCache(): void { this.configCache.clear(); }

  private async getConfigChecked(
    guildId: string,
  ): Promise<{ readonly config: DbGuildConfig | null; readonly degraded: boolean; readonly errorMessage?: string }> {
    const now = Date.now();
    const cached = this.configCache.get(guildId);
    if (cached && now - cached.time < CONFIG_CACHE_TTL_MS) {
      return { config: cached.data, degraded: false };
    }

    const { data, error } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) {
      // Evict oldest if at capacity
      if (this.configCache.size >= CONFIG_CACHE_MAX) {
        const oldest = this.configCache.keys().next().value;
        if (oldest !== undefined) this.configCache.delete(oldest);
      }
      this.configCache.set(guildId, { data, time: now });
    }
    const degraded = error != null && error.code !== 'PGRST116';
    return {
      config: data,
      degraded,
      ...(degraded ? { errorMessage: error.message } : {}),
    };
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    return (await this.getConfigChecked(guildId)).config;
  }

  private async replyBackendUnavailable(
    interaction: ChatInputCommandInteraction,
    operation: 'view_badges' | 'prestige',
    errorMessage?: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const operationId = interaction.id || randomUUID();
    await writeEconomyAudit(this.supabase, {
      guildId,
      actorId: userId,
      operationId,
      action: 'achievements.backend_unavailable',
      details: { operation },
      success: false,
      errorMessage,
      actorType: 'system',
    });
    eventBus.emit('achievements.backend_unavailable', guildId, {
      userId,
      operation,
      correlationId: operationId,
      occurrenceId: operationId,
    });
    await raiseOwnerAlert(this.supabase, guildId, {
      alertType: 'achievements_backend_unavailable',
      severity: 'warning',
      title: 'Achievements are temporarily unavailable',
      message: `The ${operation === 'prestige' ? 'prestige' : 'badges'} dependency failed for member ${userId}.`,
      channelMessage: 'The achievements system could not reach its data store. Member progress remains unchanged; retry after the dependency recovers.',
      metadata: { operation, user_id: userId },
      ...(this.guild ? { guild: this.guild } : {}),
    });

    const kit = brandKitFromConfig(null, interaction.guild?.name);
    const brandName = interaction.guild?.name ?? kit.brandName;
    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'warning',
        title: '🏆 Achievements',
        description: `${brandName}'s achievements are temporarily unavailable — please try again in a moment. Your progress is unchanged.`,
      })],
      ephemeral: true,
    });
  }

  async viewBadges(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const { data: allDefs, error: defsError } = await this.supabase
      .from('economy_achievement_defs').select('*').eq('guild_id', guildId).order('created_at')
      .limit(1000);

    const { data: userAch, error: achError } = await this.supabase
      .from('economy_user_achievements').select('achievement_id').eq('guild_id', guildId).eq('user_id', userId)
      .limit(1000);

    if (defsError || achError) {
      await this.replyBackendUnavailable(interaction, 'view_badges', defsError?.message ?? achError?.message);
      return;
    }

    // V11 Audit L-6: Replace `any` casts with typed row references.
    const unlockedIds = new Set((userAch ?? []).map((a) => a.achievement_id));

    const lines = (allDefs ?? []).map((d) => {
      const unlocked = unlockedIds.has(d.id);
      if (d.hidden && !unlocked) return `❓ *Hidden achievement*`;
      return `${unlocked ? '✅' : '⬜'} ${d.badge_emoji} **${d.name}** — ${d.description}`;
    });

    const kit = brandKitFromConfig(await this.getConfig(guildId), interaction.guild?.name);
    await interaction.reply({
      embeds: [applyBrand(
        new EmbedBuilder()
          .setTitle('🏆 Achievements')
          .setDescription(lines.join('\n') || 'No achievements configured yet.')
          .setFooter({ text: `${unlockedIds.size}/${(allDefs ?? []).length} unlocked` }),
        kit,
        { intent: 'warning' },
      )],
    });
  }

  /** Check if a user should unlock an achievement. Called from other modules. */
  async checkAndUnlock(guildId: string, userId: string, conditionType: string, currentValue: number): Promise<string | null> {
    const operationId = randomUUID();
    // Recursion guard: this call arrived from the level-up side effects of an
    // achievement XP reward being paid right now for this member — do not
    // nest. The unlock is idempotent and re-fires on the next threshold event.
    if (this.xpRewardInFlight.has(`${guildId}:${userId}`)) return null;

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
        // A failed unlock used to be log-only: the member met the criteria,
        // earned nothing, and nobody was told. Surface it instead — the next
        // check re-evaluates the same criteria, so the badge is not lost.
        log.error(`Failed to unlock achievement ${def.id} for ${userId}:`, insErr.message);
        await this.reportUnlockFailure(guildId, userId, def, 'unlock', insErr.message, operationId);
        continue;
      }
      // No returned row → the achievement was already unlocked; do not re-reward.
      if (!inserted || inserted.length === 0) continue;

      if (def.reward_currency > 0) {
        const { error: rewardErr } = await this.supabase.rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: userId, p_amount: def.reward_currency,
        });
        if (rewardErr) {
          log.error(`Failed to award ${def.reward_currency} to ${userId}:`, rewardErr.message);
          await this.reportUnlockFailure(guildId, userId, def, 'currency', rewardErr.message, operationId);
        }
      }

      // Pay reward_xp through the levels system's own award path — the same
      // increment_member_xp RPC message XP uses — so a resulting level-up
      // runs the full handleLevelUp flow (role rewards + announcement).
      // The xpRewardInFlight fence above stops that flow from nesting another
      // achievement check inside this one.
      let rewardXp = 0;
      if (((def.reward_xp as number | null) ?? 0) > 0) {
        const fenceKey = `${guildId}:${userId}`;
        this.xpRewardInFlight.add(fenceKey);
        try {
          const { data: xpResult, error: xpErr } = await this.supabase.rpc('increment_member_xp', {
            p_guild_id: guildId,
            p_member_id: userId,
            p_xp_amount: def.reward_xp,
            p_increment_messages: false,
            p_voice_minutes: 0,
          });
          if (xpErr || !xpResult) {
            log.error(`Failed to award ${def.reward_xp} XP to ${userId}:`, xpErr?.message ?? 'increment_member_xp returned null');
            await this.reportUnlockFailure(
              guildId, userId, def, 'xp',
              xpErr?.message ?? 'increment_member_xp returned null', operationId,
            );
          } else {
            rewardXp = def.reward_xp as number;
            if (this.guild && this.guild.id === guildId && xpResult.new_level > xpResult.old_level) {
              await handleLevelUp(this.guild, this.supabase, eventBus, userId, xpResult.old_level, xpResult.new_level, xpResult.new_xp)
                .catch((e: unknown) => { log.warn('achievement XP level-up handling failed:', (e as Error)?.message ?? e); });
            }
          }
        } finally {
          this.xpRewardInFlight.delete(fenceKey);
        }
      }

      // [game-economy-achievements-prestige] Append-only audit row on the badge
      // unlock state change (catalog contracts one per state change).
      // rewardXp reports what was actually PAID (0 when the grant failed) —
      // assigned via a variable so the extra field rides along until the
      // shared PlatformEventMap entry gains it.
      const unlockPayload = {
        userId,
        achievementId: def.id as string,
        name: def.name as string,
        rewardCurrency: (def.reward_currency as number) ?? 0,
        rewardXp,
        correlationId: operationId,
        occurrenceId: operationId,
      };
      await writeEconomyAudit(this.supabase, {
        guildId, actorId: userId, operationId,
        action: 'achievement.unlocked', details: { achievementId: def.id, name: def.name, rewardCurrency: def.reward_currency, rewardXp },
      });
      eventBus.emit('achievement.unlocked', guildId, unlockPayload);

      return def.name;
    }
    return null;
  }

  /**
   * Report an achievement that could not be fully granted.
   *
   * Emits the audit event and raises a deduped owner alert. The badge itself
   * is not lost: `checkAchievements` re-evaluates the same criteria on the
   * next qualifying action, so a transient database failure self-heals — but
   * a persistent one now shows up on the Alerts page instead of only in logs.
   */
  private async reportUnlockFailure(
    guildId: string,
    userId: string,
    def: { id: string; name: string },
    stage: 'unlock' | 'currency' | 'xp',
    detail: string,
    operationId?: string,
  ): Promise<void> {
    const correlationId = operationId || randomUUID();
    await writeEconomyAudit(this.supabase, {
      guildId, actorId: userId, operationId: correlationId,
      action: 'achievement.unlock_failed', details: { achievementId: def.id, name: def.name, stage }, success: false, errorMessage: detail,
    });
    eventBus.emit('achievement.unlock_failed', guildId, {
      userId,
      achievementId: def.id,
      name: def.name,
      stage,
      correlationId,
      occurrenceId: correlationId,
    });

    try {
      await raiseOwnerAlert(this.supabase, guildId, {
        alertType: 'achievement_grant_failing',
        severity: 'warning',
        title: 'Achievement rewards are not being granted',
        message:
          `Could not complete the "${def.name}" achievement for a member (stage: ${stage}). `
          + 'Members are meeting the criteria without receiving the badge or its reward. '
          + `Detail: ${detail}`,
        metadata: { achievement_id: def.id, achievement_name: def.name, stage, user_id: userId },
        ...(this.guild ? { guild: this.guild } : {}),
      });
    } catch (e: unknown) {
      // Alerting must never break the unlock loop it is reporting on.
      log.warn('achievement failure alert failed:', (e as Error)?.message ?? e);
    }
  }

  // ── Prestige ────────────────────────────────────────────

  async prestige(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const operationId = interaction.id || randomUUID();
    const { config, degraded, errorMessage } = await this.getConfigChecked(guildId);

    if (degraded) {
      await this.replyBackendUnavailable(interaction, 'prestige', errorMessage);
      return;
    }

    if (!config?.economy_prestige_enabled) {
      await writeEconomyAudit(this.supabase, {
        guildId, actorId: userId, operationId,
        action: 'prestige.denied', details: { reason: 'feature_disabled' }, success: false,
      });
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
      await writeEconomyAudit(this.supabase, {
        guildId, actorId: userId, operationId,
        action: 'prestige.failed', details: { reason: 'rpc_error' }, success: false, errorMessage: error?.message,
      });
      await interaction.reply({ content: '❌ Could not prestige right now — please try again.', ephemeral: true });
      return;
    }

    const result = data as { status?: string; replayed?: boolean; new_level?: number; new_multiplier?: number; level?: number; net_worth?: number; max_level?: number };
    switch (result.status) {
      case 'level_too_low':
        await writeEconomyAudit(this.supabase, { guildId, actorId: userId, operationId, action: 'prestige.denied', details: { reason: 'level_too_low', level: result.level, required: minLevel }, success: false });
        await interaction.reply({ content: `❌ You need to be at least **level ${minLevel}** to prestige. You're level **${result.level ?? 0}**.`, ephemeral: true });
        return;
      case 'net_worth_too_low':
        await writeEconomyAudit(this.supabase, { guildId, actorId: userId, operationId, action: 'prestige.denied', details: { reason: 'net_worth_too_low', netWorth: result.net_worth, required: minNetWorth }, success: false });
        await interaction.reply({ content: `❌ You need at least **${minNetWorth.toLocaleString()}** net worth to prestige. You have **${(result.net_worth ?? 0).toLocaleString()}**.`, ephemeral: true });
        return;
      case 'prestige_capped':
        await writeEconomyAudit(this.supabase, { guildId, actorId: userId, operationId, action: 'prestige.denied', details: { reason: 'prestige_capped', maxLevel: result.max_level ?? maxLevel }, success: false });
        await interaction.reply({ content: `⭐ You've reached the maximum prestige level (**${result.max_level ?? maxLevel}**). Your earning multiplier is already at its ceiling.`, ephemeral: true });
        return;
      case 'prestiged':
        break;
      default:
        await writeEconomyAudit(this.supabase, { guildId, actorId: userId, operationId, action: 'prestige.failed', details: { reason: 'unknown_status', status: result.status }, success: false });
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
      await writeEconomyAudit(this.supabase, {
        guildId, actorId: userId, operationId,
        action: 'prestige.performed', details: { newLevel: result.new_level ?? 0, newMultiplier: result.new_multiplier ?? 0 },
      });
      eventBus.emit('prestige.performed', guildId, {
        userId,
        newLevel: result.new_level ?? 0,
        newMultiplier: result.new_multiplier ?? 0,
        correlationId: operationId,
        occurrenceId: operationId,
      });
    }

    await interaction.reply({
      embeds: [brandedEmbed(brandKitFromConfig(config, interaction.guild?.name), {
        intent: 'warning',
        title: `⭐ Prestige Level ${result.new_level}!`,
        description:
          `You\'ve prestiged! Your wallet and bank have been reset.\n\n` +
          `✅ *Kept:* Inventory, pets, achievements, streaks\n` +
          `🔄 *Reset:* Wallet, bank\n` +
          `📈 *New earning multiplier:* +**${result.new_multiplier}%**`,
      })],
    });
  }
}
