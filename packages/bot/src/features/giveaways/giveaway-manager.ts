/**
 * GiveawayManager — handles giveaway lifecycle, button entries, and winner selection.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type TextChannel,
  type ButtonInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import { randomInt } from 'node:crypto';
import type { PlatformEventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { applyBrand, resolveBrandKit, type BrandKit } from '../branding/index.js';

const log = createLogger('Giveaway');

interface GiveawayRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  prize: string;
  prize_product_id: string | null;
  prize_license_count: number;
  winner_count: number;
  ends_at: string;
  required_role_id: string | null;
  required_level: number | null;
  required_entitlement_product_id: string | null;
  entries: string[];
  winners: string[];
  status: 'active' | 'ended' | 'cancelled' | 'paused';
  created_by: string;
  created_at: string;
}

interface GiveawayConfig {
  defaultWinnerCount: number;
  dmWinners: boolean;
  entryButtonLabel: string;
  winnerAnnouncementStyle: 'embed' | 'plain';
}

export function buildGiveawayEntryLabel(
  configuredLabel: string,
  entryCount: number,
  paused: boolean,
): string {
  const suffix = ` (${entryCount})`;
  const base = paused ? 'Paused' : configuredLabel;
  return `${base.slice(0, Math.max(0, 80 - suffix.length))}${suffix}`;
}

const DEFAULT_GIVEAWAY_CONFIG: GiveawayConfig = {
  defaultWinnerCount: 1,
  dmWinners: true,
  entryButtonLabel: 'Count me in!',
  winnerAnnouncementStyle: 'embed',
};

export class GiveawayManager {
  private checkTimer: NodeJS.Timeout | null = null;
  private cfg: GiveawayConfig = { ...DEFAULT_GIVEAWAY_CONFIG };
  private cfgLoadedAt = 0;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private valkey: Valkey,
    private eventBus: PlatformEventBus,
  ) {}

  /** Load the guild's giveaway config (cached ~60s). Feeds the button label,
   *  announcement style, default winner count, and DM-winners toggle. */
  private async loadConfig(): Promise<void> {
    const now = Date.now();
    if (now - this.cfgLoadedAt < 60_000) return;
    const { data } = await this.supabase
      .from('guild_config')
      .select('giveaway_default_winner_count, giveaway_dm_winners, giveaway_entry_button_label, giveaway_winner_announcement_style')
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (data) {
      const style = data.giveaway_winner_announcement_style === 'plain' ? 'plain' : 'embed';
      this.cfg = {
        defaultWinnerCount: data.giveaway_default_winner_count ?? DEFAULT_GIVEAWAY_CONFIG.defaultWinnerCount,
        dmWinners: data.giveaway_dm_winners ?? DEFAULT_GIVEAWAY_CONFIG.dmWinners,
        entryButtonLabel: data.giveaway_entry_button_label ?? DEFAULT_GIVEAWAY_CONFIG.entryButtonLabel,
        winnerAnnouncementStyle: style,
      };
    }
    this.cfgLoadedAt = now;
  }

  /** The configured default winner count (used when /giveaway start omits winners). */
  async getDefaultWinnerCount(): Promise<number> {
    await this.loadConfig();
    return this.cfg.defaultWinnerCount;
  }

  /** Whether winners should be DM'd (channel-announced regardless). */
  async getDmWinners(): Promise<boolean> {
    await this.loadConfig();
    return this.cfg.dmWinners;
  }

  async start(): Promise<void> {
    // Check every 30 seconds for giveaways that need to end
    this.checkTimer = setInterval(() => {
      this.checkExpired().catch((err) => {
        log.error('Check error:', { error: String(err) });
      });
    }, 30_000);

    // Initial check
    await this.checkExpired();
    log.info('Manager started');
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Create a new giveaway and post the embed.
   */
  async create(options: {
    channelId: string;
    prize: string;
    winnerCount: number;
    durationMs: number;
    creatorId: string;
    requiredRoleId?: string;
    requiredLevel?: number;
    prizeProductId?: string;
    prizeLicenseCount?: number;
  }): Promise<GiveawayRow | null> {
    await this.loadConfig(); // so the entry button renders with the owner's label
    const endsAt = new Date(Date.now() + options.durationMs);

    const { data, error } = await this.supabase
      .from('giveaways')
      .insert({
        guild_id: this.guild.id,
        channel_id: options.channelId,
        prize: options.prize,
        winner_count: options.winnerCount,
        ends_at: endsAt.toISOString(),
        created_by: options.creatorId,
        required_role_id: options.requiredRoleId ?? null,
        required_level: options.requiredLevel ?? null,
        prize_product_id: options.prizeProductId ?? null,
        prize_license_count: options.prizeLicenseCount ?? 1,
        entries: [],
        winners: [],
        status: 'active',
      })
      .select()
      .single();

    if (error || !data) {
      log.error('Create error:', error?.message);
      // Audit + owner alert for the failure branch (contracted giveaway-alert).
      this.eventBus.emit('giveaway.failed', this.guild.id, {
        giveawayId: null,
        stage: 'create',
        actorId: options.creatorId,
        error: error?.message ?? 'unknown',
        occurrenceId: `create:${options.channelId}:${options.prize}`,
        correlationId: `giveaway:create:${options.creatorId}`,
      });
      await this.raiseGiveawayAlert(
        'create',
        `A giveaway ("${options.prize}") could not be created: ${error?.message ?? 'unknown error'}.`,
        { channel_id: options.channelId, creator_id: options.creatorId },
      );
      return null;
    }

    const giveaway = data as GiveawayRow;

    // Post embed
    const channel = this.guild.channels.cache.get(options.channelId) as TextChannel | undefined;
    if (channel) {
      const embed = await this.buildGiveawayEmbed(giveaway);
      const row = this.buildEntryButton(giveaway);

      const msg = await channel.send({ embeds: [embed], components: [row] });

      await this.supabase
        .from('giveaways')
        .update({ message_id: msg.id })
        .eq('id', giveaway.id);

      giveaway.message_id = msg.id;
    }

    this.eventBus.emit('giveaway.started', this.guild.id, {
      giveawayId: giveaway.id,
      prize: giveaway.prize,
      winnerCount: giveaway.winner_count,
      channelId: giveaway.channel_id,
      creatorId: giveaway.created_by,
      endsAt: giveaway.ends_at,
      requiredRoleId: giveaway.required_role_id,
      requiredLevel: giveaway.required_level,
      occurrenceId: giveaway.id,
      correlationId: `giveaway:${giveaway.id}`,
    });

    return giveaway;
  }

  /**
   * Raise exactly one owner alert for a giveaway failure branch. Best effort —
   * a failed alert insert never blocks the giveaway flow.
   */
  private async raiseGiveawayAlert(
    stage: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'giveaway_failed',
        severity: 'warning',
        title: 'Giveaway action failed',
        message,
        metadata: { stage, ...metadata },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.error('Failed to write giveaway alert:', { error: String(alertErr) });
    }
  }

  /**
   * Handle button click for giveaway entry.
   */
  async handleEntry(interaction: ButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;
    if (!customId.startsWith('giveaway_enter:')) return false;

    const giveawayId = customId.replace('giveaway_enter:', '');
    const userId = interaction.user.id;

    // Load giveaway
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!data || (data as GiveawayRow).status !== 'active') {
      // [#57] Honest deny audit: a click on an ended/paused/unknown giveaway
      // is a real denial, batched via the event rail like the gate denials.
      this.eventBus.emit('giveaway.entry_denied', this.guild.id, {
        giveawayId,
        userId,
        reason: 'not_active',
        occurrenceId: `${giveawayId}:${userId}:not_active`,
        correlationId: `giveaway:${giveawayId}`,
      });
      await interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
      return true;
    }

    const giveaway = data as GiveawayRow;

    // Check requirements
    const member = this.guild.members.cache.get(userId);
    if (!member) {
      this.eventBus.emit('giveaway.entry_denied', this.guild.id, {
        giveawayId,
        userId,
        reason: 'member_not_found',
        occurrenceId: `${giveawayId}:${userId}:member_not_found`,
        correlationId: `giveaway:${giveawayId}`,
      });
      await interaction.reply({ content: '❌ Could not find your member data.', ephemeral: true });
      return true;
    }

    if (giveaway.required_role_id && !member.roles.cache.has(giveaway.required_role_id)) {
      // [#57] Entry attempts are hot (button clicks) — the denial is audited
      // via the batched event rail, never a direct audit write.
      this.eventBus.emit('giveaway.entry_denied', this.guild.id, {
        giveawayId,
        userId,
        reason: 'role_gate',
        requiredRoleId: giveaway.required_role_id,
        occurrenceId: `${giveawayId}:${userId}:role_gate`,
        correlationId: `giveaway:${giveawayId}`,
      });
      await interaction.reply({
        content: `❌ You need the <@&${giveaway.required_role_id}> role to enter this giveaway.`,
        ephemeral: true,
      });
      return true;
    }

    if (giveaway.required_level != null && giveaway.required_level > 0) {
      const { data: levelData } = await this.supabase
        .from('member_levels')
        .select('level')
        .eq('guild_id', this.guild.id)
        .eq('member_id', userId)
        .maybeSingle();

      const userLevel = levelData?.level ?? 0;
      if (userLevel < giveaway.required_level) {
        this.eventBus.emit('giveaway.entry_denied', this.guild.id, {
          giveawayId,
          userId,
          reason: 'level_gate',
          requiredLevel: giveaway.required_level,
          userLevel,
          occurrenceId: `${giveawayId}:${userId}:level_gate`,
          correlationId: `giveaway:${giveawayId}`,
        });
        await interaction.reply({
          content: `❌ You need to be level ${giveaway.required_level} or higher to enter. Your current level: ${userLevel}.`,
          ephemeral: true,
        });
        return true;
      }
    }

    // Check if already entered
    if (giveaway.entries.includes(userId)) {
      // Withdraw — atomic array_remove to avoid race condition
      const { data: updated } = await this.supabase.rpc('giveaway_remove_entry', {
        p_giveaway_id: giveawayId,
        p_user_id: userId,
      });

      if (!updated || !Array.isArray(updated) || updated.length === 0) {
        log.error('giveaway_remove_entry RPC not found or no match — run migrations');
        this.eventBus.emit('giveaway.failed', this.guild.id, {
          giveawayId,
          stage: 'entry',
          actorId: userId,
          error: 'giveaway_remove_entry RPC not found or no match',
          occurrenceId: `${giveawayId}:${userId}:withdraw_failed`,
          correlationId: `giveaway:${giveawayId}`,
        });
        await this.raiseGiveawayAlert(
          'entry',
          `A member could not withdraw from giveaway ${giveawayId} — the giveaway_remove_entry RPC is missing. Run migrations.`,
          { giveaway_id: giveawayId, user_id: userId },
        );
        await interaction.reply({ content: '❌ Internal error — please try again.', ephemeral: true });
        return true;
      }
      const newEntries: string[] = updated[0].entries ?? [];

      await this.updateGiveawayMessage({ ...giveaway, entries: newEntries });
      this.eventBus.emit('giveaway.entered', this.guild.id, {
        giveawayId,
        userId,
        withdrawn: true,
        entryCount: newEntries.length,
        occurrenceId: `${giveawayId}:${userId}:withdraw`,
        correlationId: `giveaway:${giveawayId}`,
      });
      await interaction.reply({ content: '🚪 You have withdrawn from the giveaway.', ephemeral: true });
      return true;
    }

    // Add entry — atomic array_append to avoid race condition
    // Two users clicking simultaneously won't overwrite each other's entry
    const { data: updated } = await this.supabase.rpc('giveaway_add_entry', {
      p_giveaway_id: giveawayId,
      p_user_id: userId,
    });

    if (!updated || !Array.isArray(updated) || updated.length === 0) {
      log.error('giveaway_add_entry RPC not found or no match — run migrations');
      this.eventBus.emit('giveaway.failed', this.guild.id, {
        giveawayId,
        stage: 'entry',
        actorId: userId,
        error: 'giveaway_add_entry RPC not found or no match',
        occurrenceId: `${giveawayId}:${userId}:entry_failed`,
        correlationId: `giveaway:${giveawayId}`,
      });
      await this.raiseGiveawayAlert(
        'entry',
        `A member could not enter giveaway ${giveawayId} — the giveaway_add_entry RPC is missing. Run migrations.`,
        { giveaway_id: giveawayId, user_id: userId },
      );
      await interaction.reply({ content: '❌ Internal error — please try again.', ephemeral: true });
      return true;
    }
    const newEntries: string[] = updated[0].entries ?? [];

    await this.updateGiveawayMessage({ ...giveaway, entries: newEntries });
    this.eventBus.emit('giveaway.entered', this.guild.id, {
      giveawayId,
      userId,
      withdrawn: false,
      entryCount: newEntries.length,
      occurrenceId: `${giveawayId}:${userId}:enter`,
      correlationId: `giveaway:${giveawayId}`,
    });
    await interaction.reply({ content: '🎉 You have entered the giveaway! Click again to withdraw.', ephemeral: true });
    return true;
  }

  /**
   * End a specific giveaway and select winners.
   *
   * Returns the committed winner list, [] when the giveaway does not exist, or
   * NULL when the database was unreachable. A FAILED read must never be
   * reported as a completed "no entries" draw (that fabricates a draw result
   * from state the bot could not read) — the command layer degrades to the
   * branded unavailable notice instead, and the durable row stays undisturbed
   * so the draw completes exactly once after recovery.
   */
  async endGiveaway(giveawayId: string): Promise<string[] | null> {
    const { data, error } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (error) return null; // the read failed (outage) — unavailable, not "ended with no entries"
    if (!data) return [];
    const giveaway = data as GiveawayRow;
    if (giveaway.status !== 'active') return giveaway.winners;

    return this.selectWinnersAndEnd(giveaway);
  }

  /**
   * Pause an active giveaway — entries blocked, timer stops.
   */
  async pauseGiveaway(giveawayId: string, actorId?: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!data) return false;
    const giveaway = data as GiveawayRow;
    if (giveaway.status !== 'active') return false;

    await this.supabase
      .from('giveaways')
      .update({ status: 'paused' })
      .eq('id', giveawayId);

    // Update the giveaway message to show paused state
    const pausedGiveaway = { ...giveaway, status: 'paused' as const };
    await this.updateGiveawayMessage(pausedGiveaway);

    this.eventBus.emit('giveaway.paused', this.guild.id, {
      giveawayId,
      prize: giveaway.prize,
      actorId: actorId ?? null,
      occurrenceId: `${giveawayId}:pause`,
      correlationId: `giveaway:${giveawayId}`,
    });

    log.info(`Paused "${giveaway.prize}"`);
    return true;
  }

  /**
   * Resume a paused giveaway — recalculates end time based on remaining duration.
   */
  async resumeGiveaway(giveawayId: string, actorId?: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!data) return false;
    const giveaway = data as GiveawayRow;
    if (giveaway.status !== 'paused') return false;

    // Extend the end time by the amount of time it was paused
    // (keep original end time if it hasn't passed, otherwise extend from now)
    const originalEnd = new Date(giveaway.ends_at).getTime();
    const newEnd = Math.max(originalEnd, Date.now() + 60_000); // At least 1 minute from now

    await this.supabase
      .from('giveaways')
      .update({
        status: 'active',
        ends_at: new Date(newEnd).toISOString(),
      })
      .eq('id', giveawayId);

    const resumedGiveaway = {
      ...giveaway,
      status: 'active' as const,
      ends_at: new Date(newEnd).toISOString(),
    };
    await this.updateGiveawayMessage(resumedGiveaway);

    this.eventBus.emit('giveaway.resumed', this.guild.id, {
      giveawayId,
      prize: giveaway.prize,
      actorId: actorId ?? null,
      endsAt: resumedGiveaway.ends_at,
      occurrenceId: `${giveawayId}:resume`,
      correlationId: `giveaway:${giveawayId}`,
    });

    log.info(`Resumed "${giveaway.prize}"`);
    return true;
  }

  /**
   * Reroll winners for an ended giveaway.
   */
  async reroll(giveawayId: string, count?: number, actorId?: string): Promise<string[]> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!data) return [];
    const giveaway = data as GiveawayRow;
    if (giveaway.status !== 'ended') return [];

    const winnerCount = count ?? giveaway.winner_count;
    const eligibleEntries = giveaway.entries.filter(
      (e: string) => !giveaway.winners.includes(e),
    );

    const newWinners = this.pickRandom(eligibleEntries, winnerCount);

    // V50-M4: use giveaway_atomic_reroll RPC — appends new winners
    // atomically. Concurrent rerolls won't overwrite each other's picks.
    const { data: rerolled, error: rerollErr } = await this.supabase.rpc('giveaway_atomic_reroll', {
      p_giveaway_id: giveawayId,
      p_new_winners: newWinners,
    });

    if (rerollErr || !rerolled || (Array.isArray(rerolled) && rerolled.length === 0)) {
      log.error('giveaway_atomic_reroll failed:', rerollErr?.message);
      this.eventBus.emit('giveaway.failed', this.guild.id, {
        giveawayId,
        stage: 'reroll',
        actorId: actorId ?? null,
        error: rerollErr?.message ?? 'giveaway_atomic_reroll returned no rows',
      });
      await this.raiseGiveawayAlert(
        'reroll',
        `A reroll for giveaway ${giveawayId} ("${giveaway.prize}") failed: ${rerollErr?.message ?? 'no rows updated'}.`,
        { giveaway_id: giveawayId },
      );
      return [];
    }

    // Announce reroll
    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (channel) {
      const winnerMentions = newWinners.map((id) => `<@${id}>`).join(', ');
      await channel.send({
        content: `🎊 **Giveaway Reroll** — New winner${newWinners.length > 1 ? 's' : ''}: ${winnerMentions || 'No eligible entries'}`,
        // winners are pinged on purpose; the PRIZE name is owner-authored.
        allowedMentions: { parse: ['users'] },
      });
    }

    this.eventBus.emit('giveaway.rerolled', this.guild.id, {
      giveawayId,
      prize: giveaway.prize,
      winnerIds: newWinners,
      actorId: actorId ?? null,
      occurrenceId: `${giveawayId}:reroll:${newWinners.join(',')}`,
      correlationId: `giveaway:${giveawayId}`,
    });

    return newWinners;
  }

  private async checkExpired(): Promise<void> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .lte('ends_at', new Date().toISOString())
      .limit(1000);

    if (!data || data.length === 0) return;

    for (const row of data) {
      try {
        const giveaway = row as GiveawayRow;
        await this.selectWinnersAndEnd(giveaway);
      } catch (err) {
        log.error(`Error ending giveaway ${row.id}:`, err);
      }
    }
  }

  private async selectWinnersAndEnd(giveaway: GiveawayRow): Promise<string[] | null> {
    await this.loadConfig();
    // If a prior worker persisted winners before crashing, resume from that
    // durable set. Sampling again would violate exactly-once winner selection.
    if (giveaway.winners.length > 0) {
      this.eventBus.emit('giveaway.draw_resumed', this.guild.id, {
        giveawayId: giveaway.id,
        winnerIds: [...giveaway.winners],
        occurrenceId: `${giveaway.id}:draw-resumed`,
        correlationId: `giveaway:${giveaway.id}`,
      });
      await this.raiseGiveawayAlert(
        'draw_resumed',
        `Giveaway "${giveaway.prize}" resumed from its durable draw record with ${giveaway.winners.length} winner(s).`,
        { giveaway_id: giveaway.id, winner_count: giveaway.winners.length },
      );
    }
    const winners = giveaway.winners.length > 0
      ? [...giveaway.winners]
      : this.pickRandom(giveaway.entries, giveaway.winner_count);

    // V50-M2: use giveaway_atomic_end RPC — gates the status flip on
    // status='active' so concurrent checkExpired + manual endGiveaway
    // cannot both succeed and double-select/double-pay winners.
    const { data: endedRows, error: endErr } = await this.supabase.rpc('giveaway_atomic_end', {
      p_giveaway_id: giveaway.id,
      p_winners: winners,
      p_ended_at: new Date().toISOString(),
    });

    if (endErr) {
      // The atomic end could not be executed (database unreachable). The row is
      // untouched — no partial draw leaked — so surface "unavailable" rather
      // than a completed draw; the draw runs exactly once after recovery.
      log.error(`giveaway_atomic_end failed for "${giveaway.prize}":`, endErr.message);
      return null;
    }
    if (!endedRows || (Array.isArray(endedRows) && endedRows.length === 0)) {
      // Another call already ended this giveaway — bail out
      log.info(`giveaway_atomic_end returned empty for "${giveaway.prize}" — already ended`);
      return giveaway.winners;
    }

    // Update the giveaway message
    const endedGiveaway = { ...giveaway, status: 'ended' as const, winners };
    await this.updateGiveawayMessage(endedGiveaway);

    // Announce winners in the configured style (embed or plain text).
    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (channel) {
      if (winners.length > 0) {
        const winnerMentions = winners.map((id) => `<@${id}>`).join(', ');
        if (this.cfg.winnerAnnouncementStyle === 'embed') {
          const kit = await this.brandKit();
          const embed = new EmbedBuilder()
            .setTitle('🎉 Giveaway ended!')
            .setDescription(
              `Prize: **${giveaway.prize}**\n` +
              `Winner${winners.length > 1 ? 's' : ''}: ${winnerMentions}\n\nCongratulations!`,
            );
          applyBrand(embed, kit, { intent: 'primary' });
          await channel.send({
            content: winnerMentions,
            embeds: [embed],
            allowedMentions: { parse: ['users'] },
          });
        } else {
          await channel.send({
            content: `🎉 **Giveaway ended!** Prize: **${giveaway.prize}**\nWinner${winners.length > 1 ? 's' : ''}: ${winnerMentions}\n\nCongratulations!`,
            // nobody won — nothing should ping.
            allowedMentions: { parse: [] },
          });
        }
      } else if (this.cfg.winnerAnnouncementStyle === 'embed') {
        const kit = await this.brandKit();
        const embed = new EmbedBuilder()
          .setTitle('😔 Giveaway ended!')
          .setDescription(`Prize: **${giveaway.prize}**\nNo valid entries — no winners selected.`);
        applyBrand(embed, kit, { intent: 'danger' });
        await channel.send({ embeds: [embed] });
      } else {
        await channel.send({
          content: `😔 **Giveaway ended!** Prize: **${giveaway.prize}**\nNo valid entries — no winners selected.`,
          // Nobody won, so nothing should ping — and the PRIZE name is
          // owner-authored, so it must not be able to.
          allowedMentions: { parse: [] },
        });
      }
    }

    // Emit platform event
    this.eventBus.emit('giveaway.ended', this.guild.id, {
      giveawayId: giveaway.id,
      title: giveaway.prize,
      winnerIds: winners,
      prizeProductId: giveaway.prize_product_id,
      occurrenceId: `${giveaway.id}:end`,
      correlationId: `giveaway:${giveaway.id}`,
    });

    log.info(`Ended "${giveaway.prize}" — ${winners.length} winner(s)`);
    return winners;
  }

  private async updateGiveawayMessage(giveaway: GiveawayRow): Promise<void> {
    if (!giveaway.message_id) return;

    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (!channel) return;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const msg = await channel.messages.fetch(giveaway.message_id);
        const embed = await this.buildGiveawayEmbed(giveaway);

        if (giveaway.status === 'ended' || giveaway.status === 'cancelled') {
          await msg.edit({ embeds: [embed], components: [] });
        } else {
          const row = this.buildEntryButton(giveaway);
          await msg.edit({ embeds: [embed], components: [row] });
        }
        return;
      } catch {
        // Message edits are best-effort, but a transient Discord failure gets
        // a bounded retry under the same giveaway/message occurrence.  The
        // state row remains authoritative throughout.
        if (attempt === 3) return;
        this.eventBus.emit('giveaway.embed_update_retried', this.guild.id, {
          giveawayId: giveaway.id,
          channelId: giveaway.channel_id,
          messageId: giveaway.message_id,
          attempt: attempt + 1,
          occurrenceId: `${giveaway.id}:embed-update-retry:${attempt + 1}`,
          correlationId: `giveaway:${giveaway.id}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  /** Resolve the guild's white-label brand kit (cached; never throws). */
  private brandKit(): Promise<BrandKit> {
    return resolveBrandKit(this.supabase, this.guild.id, { fallbackName: this.guild.name });
  }

  private async buildGiveawayEmbed(giveaway: GiveawayRow): Promise<EmbedBuilder> {
    const isEnded = giveaway.status === 'ended';
    const isPaused = giveaway.status === 'paused';
    const title = isEnded ? '🎉 Giveaway Ended' : isPaused ? '⏸️ Giveaway Paused' : '🎉 Giveaway';
    const kit = await this.brandKit();
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(giveaway.prize)
      .setTimestamp(new Date(giveaway.ends_at));

    const fields: Array<{ name: string; value: string; inline: boolean }> = [];

    if (!isEnded) {
      fields.push({
        name: '⏰ Ends',
        value: `<t:${Math.floor(new Date(giveaway.ends_at).getTime() / 1000)}:R>`,
        inline: true,
      });
    }

    fields.push({
      name: '🎫 Entries',
      value: String(giveaway.entries.length),
      inline: true,
    });

    fields.push({
      name: '🏆 Winners',
      value: isEnded
        ? (giveaway.winners.length > 0 ? giveaway.winners.map((id) => `<@${id}>`).join('\n') : 'None')
        : String(giveaway.winner_count),
      inline: true,
    });

    // Requirements
    const reqs: string[] = [];
    if (giveaway.required_role_id) reqs.push(`Role: <@&${giveaway.required_role_id}>`);
    if (giveaway.required_level) reqs.push(`Level: ${giveaway.required_level}+`);
    if (reqs.length > 0) {
      fields.push({ name: '📋 Requirements', value: reqs.join('\n'), inline: false });
    }

    embed.addFields(fields);
    embed.setFooter({ text: isEnded ? 'Giveaway ended' : isPaused ? 'Giveaway paused' : `${giveaway.winner_count} winner(s) • Ends` });

    // Live giveaways carry the brand primary; paused maps to the warning
    // intent. The gray "ended" state is semantic (inactive), not brandable —
    // applyBrand still appends the powered-by attribution to the footer.
    applyBrand(embed, kit, { intent: isPaused ? 'warning' : 'primary' });
    if (isEnded) embed.setColor(0x808080);

    return embed;
  }

  private buildEntryButton(giveaway: GiveawayRow): ActionRowBuilder<ButtonBuilder> {
    const isPaused = giveaway.status === 'paused';
    // Uses the owner-configured entry-button label (cfg is refreshed by
    // loadConfig() before any render path). Falls back to the default until the
    // first load completes.
    const enterLabel = this.cfg.entryButtonLabel || DEFAULT_GIVEAWAY_CONFIG.entryButtonLabel;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter:${giveaway.id}`)
        .setLabel(buildGiveawayEntryLabel(enterLabel, giveaway.entries.length, isPaused))
        .setEmoji(isPaused ? '⏸️' : '🎉')
        .setStyle(isPaused ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(isPaused),
    );
  }

  private pickRandom(arr: string[], count: number): string[] {
    if (arr.length === 0) return [];
    // V6 Audit §4.3: Use crypto.randomInt() for winner selection because
    // giveaways can award real commerce products (auto-fulfilled via
    // CrossFeatureBridge). Fisher-Yates (Knuth) shuffle — uniform distribution.
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shuffled[i]!, shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
}
