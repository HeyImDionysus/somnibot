/**
 * QuestsManager — daily/weekly quest assignment, progress tracking, claiming.
 */
import { cryptoShuffle } from '../../utils/random.js';
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Quests');

let _manager: QuestsManager | null = null;
export function registerQuestsManager(mgr: QuestsManager): void { _manager = mgr; }
export function invalidateQuestsCache(): void { _manager?.clearCache(); }
export function getQuestsManager(): QuestsManager | null { return _manager; }

export class QuestsManager {
  private supabase: SupabaseClient;
  private configCache = new Map<string, DbGuildConfig>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  clearCache(): void { this.configCache.clear(); }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  async viewQuests(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_quests_enabled) {
      await interaction.reply({ content: '❌ Quests are not enabled.', ephemeral: true });
      return;
    }

    // Get active quests — daily from today, weekly from this week's Monday
    const weekStart = getWeekStart().toISOString();
    const { data: progress } = await this.supabase
      .from('economy_quest_progress')
      .select('*, template:economy_quest_templates(*)')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .gte('assigned_at', weekStart)
      .limit(1000);

    if (!progress || progress.length === 0) {
      // Auto-assign daily + weekly quests
      await this.assignDailyQuests(guildId, userId, config);
      await this.assignWeeklyQuests(guildId, userId);
      await interaction.reply({ content: '📋 New quests assigned! Run `/quests` again to view them.', ephemeral: true });
      return;
    }

    // Also ensure weekly quests are assigned (they reset weekly, not daily)
    await this.assignWeeklyQuests(guildId, userId).catch((e: unknown) => { log.warn('Weekly quest assignment failed:', (e as Error)?.message ?? e); });

    const lines = progress.map((p: any) => {
      const t = p.template;
      const status = p.claimed ? '✅' : p.completed ? '🎁' : '📋';
      return `${status} **${t?.title ?? 'Quest'}** — ${p.progress}/${t?.target_count ?? 1}${p.completed && !p.claimed ? ' *(claim available!)*' : ''}`;
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('📋 Your Quests')
        .setDescription(lines.join('\n') || 'No active quests.')
        .setColor(0x5865F2)
        .setFooter({ text: 'Use /quests claim to collect completed quest rewards' })],
    });
  }

  async claimQuests(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // V49-C1: Atomic claim — RPC flips claimed=true only for rows still
    // unclaimed, returning only the rows it actually flipped.  Two concurrent
    // calls cannot both claim the same quest.
    const { data: claimed } = await this.supabase.rpc('economy_quest_atomic_claim', {
      p_guild_id: guildId,
      p_user_id: userId,
    });

    if (!claimed || !Array.isArray(claimed) || claimed.length === 0) {
      await interaction.reply({ content: '❌ No completed quests to claim.', ephemeral: true });
      return;
    }

    let totalCurrency = 0;
    let totalXp = 0;
    for (const row of claimed) {
      totalCurrency += row.reward_currency ?? 0;
      totalXp += row.reward_xp ?? 0;
    }

    if (totalCurrency > 0) {
      const { error: payoutErr } = await this.supabase.rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: totalCurrency,
      });
      if (payoutErr) {
        log.error('claimQuests payout failed — reverting claimed status:', payoutErr.message);
        // Revert: un-claim the quests so the user can retry
        for (const row of claimed) {
          await Promise.resolve(this.supabase.from('economy_quest_progress')
            .update({ claimed: false }).eq('id', row.id)).catch((e: unknown) => { log.warn('Reset claimed status failed:', (e as Error)?.message ?? e); });
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setDescription('❌ Failed to pay out quest rewards. Please try again.')
            .setColor(0xFF0000)],
        });
        return;
      }
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎁 Quests Claimed!')
        .setDescription(`Claimed **${claimed.length}** quest(s)!\n💰 +**${totalCurrency.toLocaleString()}** coins\n✨ +**${totalXp}** XP`)
        .setColor(0x57F287)],
    });
  }

  /** Increment quest progress for a user when they do something. */
  async trackProgress(guildId: string, userId: string, actionType: string, amount: number = 1): Promise<void> {
    // V49-C2: Fetch matching quest IDs, then use atomic RPC to increment.
    // The old read-modify-write pattern lost increments under concurrency.
    const { data: active } = await this.supabase
      .from('economy_quest_progress')
      .select('id, template:economy_quest_templates(action_type)')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .eq('completed', false)
      .limit(1000);

    for (const p of active ?? []) {
      if ((p.template as Record<string, unknown> | null)?.action_type === actionType) {
        await Promise.resolve(this.supabase.rpc('economy_quest_increment_progress', {
          p_id: p.id,
          p_amount: amount,
        })).catch((err: Error) => log.error('increment_progress failed:', err.message));
      }
    }
  }

  private async assignDailyQuests(guildId: string, userId: string, config: DbGuildConfig): Promise<void> {
    // Seed default templates if none exist
    await this.seedDefaultTemplates(guildId);

    const count = config.economy_daily_quest_count ?? 3;
    const { data: templates } = await this.supabase
      .from('economy_quest_templates')
      .select('*')
      .eq('guild_id', guildId)
      .eq('quest_type', 'daily')
      .eq('active', true)
      .limit(1000);

    if (!templates || templates.length === 0) return;

    // V49-M5: Shuffle and pick — use ON CONFLICT DO NOTHING to prevent
    // duplicate assignments from concurrent /quests calls.
    const shuffled = cryptoShuffle(templates).slice(0, count);
    const today = new Date().toISOString().slice(0, 10);
    const rows = shuffled.map((t: any) => ({
      guild_id: guildId,
      user_id: userId,
      template_id: t.id,
      progress: 0,
      assigned_date: today,
    }));

    await this.supabase.from('economy_quest_progress')
      .upsert(rows, { onConflict: 'guild_id,user_id,template_id,assigned_date', ignoreDuplicates: true });
  }

  /** Assign weekly quests — called on Monday or when user has no weekly quests this week. */
  async assignWeeklyQuests(guildId: string, userId: string): Promise<void> {
    const config = await this.getConfig(guildId);
    if (!config?.economy_quests_enabled) return;

    const weeklyCount = config.economy_weekly_quest_count ?? 5;

    // Check if user already has weekly quests this week
    const monday = getWeekStart();
    const { data: existing } = await this.supabase
      .from('economy_quest_progress')
      .select('id, template:economy_quest_templates(quest_type)')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .gte('assigned_at', monday.toISOString())
      .limit(1000);

    const weeklyExisting = (existing ?? []).filter((p: any) => p.template?.quest_type === 'weekly');
    if (weeklyExisting.length >= weeklyCount) return;

    // Seed defaults if needed
    await this.seedDefaultTemplates(guildId);

    const { data: templates } = await this.supabase
      .from('economy_quest_templates')
      .select('*')
      .eq('guild_id', guildId)
      .eq('quest_type', 'weekly')
      .eq('active', true)
      .limit(1000);

    if (!templates || templates.length === 0) return;

    const needed = weeklyCount - weeklyExisting.length;
    const usedIds = new Set(weeklyExisting.map((p: any) => p.template_id));
    const available = templates.filter((t: any) => !usedIds.has(t.id));
    const shuffled = cryptoShuffle(available).slice(0, needed);

    if (shuffled.length === 0) return;

    // V49-M5: ON CONFLICT DO NOTHING — idempotent under concurrent calls.
    const mondayStr = monday.toISOString().slice(0, 10);
    const rows = shuffled.map((t: any) => ({
      guild_id: guildId,
      user_id: userId,
      template_id: t.id,
      progress: 0,
      assigned_date: mondayStr,
    }));

    await this.supabase.from('economy_quest_progress')
      .upsert(rows, { onConflict: 'guild_id,user_id,template_id,assigned_date', ignoreDuplicates: true });
  }

  /** Schedule weekly quest reset — runs every hour, resets on Monday 00:00 UTC. */
  scheduleWeeklyReset(guildId: string): void {
    if (this._resetTimer) { clearInterval(this._resetTimer); this._resetTimer = null; }

    this._resetTimer = setInterval(async () => {
      try {
        const now = new Date();
        // Monday = 1, check if we're in the first hour of Monday
        if (now.getUTCDay() !== 1 || now.getUTCHours() !== 0) return;

        // Clean up old unclaimed weekly progress (older than 1 week)
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        await this.supabase
          .from('economy_quest_progress')
          .delete()
          .eq('guild_id', guildId)
          .eq('claimed', false)
          .lt('assigned_at', oneWeekAgo);

        log.info(`Weekly quest cleanup done for guild ${guildId}`);
      } catch (err) {
        log.error('Weekly reset error:', { error: String(err) });
      }
    }, 60 * 60 * 1000); // Check every hour
  }

  stopResetTimer(): void {
    if (this._resetTimer) { clearInterval(this._resetTimer); this._resetTimer = null; }
  }

  private _resetTimer: NodeJS.Timeout | null = null;

  /** Seed default quest templates via DB function. */
  private async seedDefaultTemplates(guildId: string): Promise<void> {
    try {
      await this.supabase.rpc('seed_default_quest_templates', { p_guild_id: guildId });
    } catch {
      // Ignore — function may not exist yet or templates already seeded
    }
  }
}

/** Get the start of the current ISO week (Monday 00:00 UTC). */
function getWeekStart(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day; // Monday is 1
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  return monday;
}
