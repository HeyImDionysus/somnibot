/**
 * AchievementsManager — milestone badges + prestige system.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Achievements');

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, AchievementsManager>();

export function registerAchievementsManager(mgr: AchievementsManager, guildId: string): void {
  _managers.set(guildId, mgr);
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

    const unlockedIds = new Set((userAch ?? []).map((a: any) => a.achievement_id));

    const lines = (allDefs ?? []).map((d: any) => {
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

      // Check if already unlocked
      const { data: existing } = await this.supabase
        .from('economy_user_achievements')
        .select('id')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .eq('achievement_id', def.id)
        .limit(1)
        .single();

      if (existing) continue;

      await this.supabase.from('economy_user_achievements').insert({
        guild_id: guildId, user_id: userId, achievement_id: def.id,
      });

      if (def.reward_currency > 0) {
        const { error: rewardErr } = await this.supabase.rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: userId, p_amount: def.reward_currency,
        });
        if (rewardErr) log.error(`Failed to award ${def.reward_currency} to ${userId}:`, rewardErr.message);
      }

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

    // Check level + net worth requirements
    const [{ data: wallet }, { data: memberLevel }] = await Promise.all([
      this.supabase
        .from('economy_wallets').select('wallet, bank').eq('guild_id', guildId).eq('user_id', userId).single(),
      this.supabase
        .from('member_levels').select('level').eq('guild_id', guildId).eq('member_id', userId).single(),
    ]);

    const netWorth = (wallet?.wallet ?? 0) + (wallet?.bank ?? 0);
    const userLevel = memberLevel?.level ?? 0;
    const minLevel = config.economy_prestige_min_level ?? 50;
    const minNetWorth = config.economy_prestige_min_net_worth ?? 1000000;

    if (userLevel < minLevel) {
      await interaction.reply({
        content: `❌ You need to be at least **level ${minLevel}** to prestige. You're level **${userLevel}**.`,
        ephemeral: true,
      });
      return;
    }

    if (netWorth < minNetWorth) {
      await interaction.reply({
        content: `❌ You need at least **${minNetWorth.toLocaleString()}** net worth to prestige. You have **${netWorth.toLocaleString()}**.`,
        ephemeral: true,
      });
      return;
    }

    // Get or create prestige record
    const { data: existing } = await this.supabase
      .from('economy_prestige').select('*').eq('guild_id', guildId).eq('user_id', userId).single();

    const currentLevel = existing?.prestige_level ?? 0;
    const newLevel = currentLevel + 1;
    const multiplierGain = config.economy_prestige_multiplier_pct ?? 10;
    const newMultiplier = (existing?.multiplier_pct ?? 0) + multiplierGain;

    // Reset wallet and bank
    await this.supabase.from('economy_wallets')
      .update({ wallet: 0, bank: 0 }).eq('guild_id', guildId).eq('user_id', userId);

    // Upsert prestige record
    if (existing) {
      await this.supabase.from('economy_prestige').update({
        prestige_level: newLevel,
        total_resets: existing.total_resets + 1,
        multiplier_pct: newMultiplier,
        last_prestige: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await this.supabase.from('economy_prestige').insert({
        guild_id: guildId,
        user_id: userId,
        prestige_level: newLevel,
        total_resets: 1,
        multiplier_pct: newMultiplier,
        last_prestige: new Date().toISOString(),
      });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`⭐ Prestige Level ${newLevel}!`)
        .setDescription(
          `You\'ve prestiged! Your wallet and bank have been reset.\n\n` +
          `✅ *Kept:* Inventory, pets, achievements, streaks\n` +
          `🔄 *Reset:* Wallet, bank\n` +
          `📈 *New earning multiplier:* +**${newMultiplier}%**`
        )
        .setColor(0xF1C40F)],
    });
  }
}
