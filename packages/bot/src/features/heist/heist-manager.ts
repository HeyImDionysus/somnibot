/**
 * HeistManager — multi-user cooperative heist system.
 *
 * Flow: /heist start → recruiting phase (join window) → resolve (success/fail) → payouts.
 * Participants join with /heist join. Each additional member increases success chance.
 * Roles are randomly assigned: Hacker, Muscle, Lookout, Driver, Demolitions.
 */
import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';

// ── Module-level state ────────────────────────────────────

let _manager: HeistManager | null = null;
export function registerHeistManager(mgr: HeistManager): void { _manager = mgr; }
export function invalidateHeistCache(): void { _manager?.clearCache(); }
export function getHeistManager(): HeistManager | null { return _manager; }

// ── Constants ─────────────────────────────────────────────

const HEIST_ROLES = ['Hacker', 'Muscle', 'Lookout', 'Driver', 'Demolitions'] as const;

const HEIST_TARGETS = [
  { name: 'Corner Store', difficultyMod: 0, payoutMod: 0.5 },
  { name: 'City Bank', difficultyMod: 0, payoutMod: 1.0 },
  { name: 'The Museum', difficultyMod: -5, payoutMod: 1.5 },
  { name: 'Federal Reserve', difficultyMod: -10, payoutMod: 2.0 },
  { name: 'The Vault of Legends', difficultyMod: -15, payoutMod: 3.0 },
];

const SUCCESS_STORIES = [
  'The crew slipped past every guard and cracked the vault wide open!',
  'A masterful execution — in and out before anyone noticed!',
  'Alarms blared but the team moved like clockwork. Clean getaway!',
  'The hacker killed the cameras just in time. Perfect heist!',
  'Against all odds, the crew pulled it off!',
];

const FAIL_STORIES = [
  'The alarm triggered and the crew scattered. Everyone got caught!',
  'A guard spotted the lookout — the whole plan fell apart.',
  'The vault had a secondary lock nobody expected. Busted!',
  'Someone tripped a laser grid. The cops were there in seconds.',
  'The getaway car wouldn\'t start. Classic.',
];

// ── Manager ───────────────────────────────────────────────

export class HeistManager {
  private supabase: SupabaseClient;
  private client: Client;
  private configCache = new Map<string, DbGuildConfig>();
  private resolveTimers = new Map<string, NodeJS.Timeout>();

  constructor(supabase: SupabaseClient, client: Client) {
    this.supabase = supabase as any;
    this.client = client;
  }

  clearCache(): void { this.configCache.clear(); }

  cleanup(): void {
    for (const timer of this.resolveTimers.values()) clearTimeout(timer);
    this.resolveTimers.clear();
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await (this.supabase as any)
      .from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  async startHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_heist_enabled) {
      await interaction.reply({ content: '🚫 Heists are not enabled on this server.', ephemeral: true });
      return;
    }

    // Check cooldown
    const { data: recent } = await (this.supabase as any)
      .from('economy_heists')
      .select('resolved_at')
      .eq('guild_id', guildId)
      .in('status', ['success', 'failed'])
      .order('resolved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recent?.resolved_at) {
      const cooldownMs = (config.economy_heist_cooldown_seconds ?? 300) * 1000;
      const elapsed = Date.now() - new Date(recent.resolved_at).getTime();
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        await interaction.reply({
          content: `⏰ The crew needs to lay low. Next heist available in **${remaining}m**.`,
          ephemeral: true,
        });
        return;
      }
    }

    // Check no active heist
    const { data: active } = await (this.supabase as any)
      .from('economy_heists')
      .select('id')
      .eq('guild_id', guildId)
      .in('status', ['recruiting', 'in_progress'])
      .limit(1)
      .maybeSingle();

    if (active) {
      await interaction.reply({
        content: '❌ There\'s already an active heist! Use `/heist join` to join it.',
        ephemeral: true,
      });
      return;
    }

    // Check balance for entry fee
    const entryFee = config.economy_heist_entry_fee ?? 100;
    const { data: wallet } = await (this.supabase as any)
      .from('economy_wallets').select('wallet')
      .eq('guild_id', guildId).eq('user_id', userId).single();

    if (!wallet || wallet.wallet < entryFee) {
      await interaction.reply({
        content: `❌ You need **${entryFee.toLocaleString()}** coins to start a heist.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct entry fee
    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: entryFee,
    });

    // Pick random target
    const target = HEIST_TARGETS[Math.floor(Math.random() * HEIST_TARGETS.length)];
    const basePayout = Math.floor((config.economy_heist_base_payout ?? 500) * target.payoutMod);
    const joinWindowSecs = config.economy_heist_join_window_secs ?? 60;
    const expiresAt = new Date(Date.now() + joinWindowSecs * 1000).toISOString();

    // Create heist
    const { data: heist } = await (this.supabase as any)
      .from('economy_heists')
      .insert({
        guild_id: guildId,
        initiator_id: userId,
        target_name: target.name,
        target_payout: basePayout,
        participants: [userId],
        success_chance: (config.economy_heist_success_base_pct ?? 40) + target.difficultyMod,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (!heist) {
      await interaction.reply({ content: '❌ Failed to create heist.', ephemeral: true });
      return;
    }

    // Add initiator as participant
    const role = HEIST_ROLES[Math.floor(Math.random() * HEIST_ROLES.length)];
    await (this.supabase as any).from('economy_heist_participants').insert({
      heist_id: heist.id,
      guild_id: guildId,
      user_id: userId,
      role,
    });

    // Schedule resolution
    const timer = setTimeout(async () => {
      await this.resolveHeist(guildId, heist.id, interaction.channelId);
    }, joinWindowSecs * 1000);
    this.resolveTimers.set(heist.id, timer);

    const maxParticipants = config.economy_heist_max_participants ?? 8;

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🏴‍☠️ Heist: ${target.name}`)
        .setDescription(
          `<@${userId}> is assembling a crew to rob **${target.name}**!\n\n` +
          `💰 Potential payout: **${basePayout.toLocaleString()}** coins (split among crew)\n` +
          `🎯 Base success chance: **${heist.success_chance}%** (+7% per extra member)\n` +
          `💵 Entry fee: **${entryFee.toLocaleString()}** coins\n` +
          `👥 Crew: 1/${maxParticipants}\n\n` +
          `Use \`/heist join\` within **${joinWindowSecs}s** to join the crew!`
        )
        .setColor(0xFFA500)
        .setFooter({ text: `Heist resolves in ${joinWindowSecs} seconds` })],
    });
  }

  async joinHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_heist_enabled) {
      await interaction.reply({ content: '🚫 Heists are not enabled.', ephemeral: true });
      return;
    }

    // Find active recruiting heist
    const { data: heist } = await (this.supabase as any)
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .eq('status', 'recruiting')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!heist) {
      await interaction.reply({
        content: '❌ No heist is currently recruiting. Use `/heist start` to begin one!',
        ephemeral: true,
      });
      return;
    }

    // Already joined?
    if ((heist.participants as string[]).includes(userId)) {
      await interaction.reply({ content: '❌ You\'re already in this heist!', ephemeral: true });
      return;
    }

    // Max participants
    const max = config.economy_heist_max_participants ?? 8;
    if ((heist.participants as string[]).length >= max) {
      await interaction.reply({ content: '❌ The crew is full!', ephemeral: true });
      return;
    }

    // Check balance for entry fee
    const entryFee = config.economy_heist_entry_fee ?? 100;
    const { data: wallet } = await (this.supabase as any)
      .from('economy_wallets').select('wallet')
      .eq('guild_id', guildId).eq('user_id', userId).single();

    if (!wallet || wallet.wallet < entryFee) {
      await interaction.reply({
        content: `❌ You need **${entryFee.toLocaleString()}** coins to join.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct fee
    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: entryFee,
    });

    // Add participant
    const role = HEIST_ROLES[Math.floor(Math.random() * HEIST_ROLES.length)];
    await (this.supabase as any).from('economy_heist_participants').insert({
      heist_id: heist.id,
      guild_id: guildId,
      user_id: userId,
      role,
    });

    // Atomic array_append to prevent TOCTOU race when multiple users join concurrently
    await (this.supabase as any).rpc('array_append_heist_participant', {
      p_heist_id: heist.id, p_user_id: userId,
    }).catch(() => {
      // Fallback: direct update (less safe but functional)
      (this.supabase as any).from('economy_heists').update({
        participants: [...(heist.participants as string[]), userId],
        success_chance: Math.min(95, heist.success_chance + 7),
      }).eq('id', heist.id);
    });

    // Re-read actual participant count for accurate display
    const { count: crewCount } = await (this.supabase as any)
      .from('economy_heist_participants')
      .select('id', { count: 'exact', head: true })
      .eq('heist_id', heist.id);
    const actualCount = crewCount ?? (heist.participants as string[]).length + 1;

    const displayChance = Math.min(95, (config.economy_heist_success_base_pct ?? 40) + (actualCount - 1) * 7 + (HEIST_TARGETS.find(t => t.name === heist.target_name)?.difficultyMod ?? 0));

    getQuestsManager()?.trackProgress(guildId, userId, 'heist').catch(() => {});

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🏴‍☠️ Joined the Heist!')
        .setDescription(
          `<@${userId}> joined as the **${role}**!\n\n` +
          `👥 Crew: **${actualCount}/${max}**\n` +
          `🎯 Success chance: **${displayChance}%**`
        )
        .setColor(0xFFA500)],
    });
  }

  async viewHeist(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;

    const { data: heist } = await (this.supabase as any)
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .in('status', ['recruiting', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!heist) {
      // Show last completed heist
      const { data: last } = await (this.supabase as any)
        .from('economy_heists')
        .select('*')
        .eq('guild_id', guildId)
        .in('status', ['success', 'failed'])
        .order('resolved_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!last) {
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🏴‍☠️ Heist Status')
            .setDescription('No heists have been attempted yet! Use `/heist start` to begin one.')
            .setColor(0x5865F2)],
        });
        return;
      }

      const resultEmoji = last.status === 'success' ? '✅' : '❌';
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`🏴‍☠️ Last Heist: ${last.target_name}`)
          .setDescription(
            `${resultEmoji} **${last.status === 'success' ? 'SUCCESS' : 'FAILED'}**\n\n` +
            `👥 Crew: ${(last.participants as string[]).map((id: string) => `<@${id}>`).join(', ')}\n` +
            `💰 Payout: **${last.target_payout.toLocaleString()}** coins\n` +
            `📅 ${new Date(last.resolved_at).toLocaleString()}`
          )
          .setColor(last.status === 'success' ? 0x57F287 : 0xED4245)],
      });
      return;
    }

    const participants = (heist.participants as string[]).map((id: string) => `<@${id}>`).join(', ');
    const remainingSecs = Math.max(0, Math.floor((new Date(heist.expires_at).getTime() - Date.now()) / 1000));

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🏴‍☠️ Active Heist: ${heist.target_name}`)
        .setDescription(
          `Status: **${heist.status}**\n\n` +
          `👥 Crew: ${participants}\n` +
          `🎯 Success chance: **${heist.success_chance}%**\n` +
          `💰 Potential payout: **${heist.target_payout.toLocaleString()}** coins\n` +
          `⏱️ ${remainingSecs > 0 ? `Resolves in **${remainingSecs}s**` : 'Resolving...'}`
        )
        .setColor(0xFFA500)],
    });
  }

  private async resolveHeist(guildId: string, heistId: string, channelId: string): Promise<void> {
    this.resolveTimers.delete(heistId);

    const { data: heist } = await (this.supabase as any)
      .from('economy_heists')
      .select('*')
      .eq('id', heistId)
      .single();

    if (!heist || heist.status !== 'recruiting') return;

    const config = await this.getConfig(guildId);
    const minParticipants = config?.economy_heist_min_participants ?? 2;

    // Use the join table as source of truth (immune to array TOCTOU race)
    const { data: partRows } = await (this.supabase as any)
      .from('economy_heist_participants')
      .select('user_id')
      .eq('heist_id', heistId);
    const participants = (partRows ?? []).map((r: any) => r.user_id as string);

    // Not enough participants — cancel
    if (participants.length < minParticipants) {
      await (this.supabase as any).from('economy_heists')
        .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
        .eq('id', heistId);

      // Refund entry fees
      const entryFee = config?.economy_heist_entry_fee ?? 100;
      for (const uid of participants) {
        const { error: refundErr } = await (this.supabase as any).rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: uid, p_amount: entryFee,
        });
        if (refundErr) console.error(`[Heist] Failed to refund ${uid}:`, refundErr.message);
      }

      const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('🏴‍☠️ Heist Cancelled')
            .setDescription(
              `Not enough crew members joined (needed ${minParticipants}, got ${participants.length}).\n` +
              `Entry fees have been refunded.`
            )
            .setColor(0x95A5A6)],
        });
      }
      return;
    }

    // Mark as in_progress
    await (this.supabase as any).from('economy_heists')
      .update({ status: 'in_progress' })
      .eq('id', heistId);

    // Roll success
    const roll = Math.random() * 100;
    const isSuccess = roll < heist.success_chance;

    if (isSuccess) {
      // Split payout among participants
      const totalPayout = heist.target_payout;
      const perPerson = Math.floor(totalPayout / participants.length);

      for (const uid of participants) {
        const { error: payErr } = await (this.supabase as any).rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: uid, p_amount: perPerson,
        });
        if (payErr) console.error(`[Heist] Failed to pay ${uid}:`, payErr.message);

        await (this.supabase as any).from('economy_heist_participants')
          .update({ payout: perPerson })
          .eq('heist_id', heistId)
          .eq('user_id', uid);
      }

      await (this.supabase as any).from('economy_heists')
        .update({ status: 'success', resolved_at: new Date().toISOString() })
        .eq('id', heistId);

      const { data: partData } = await (this.supabase as any)
        .from('economy_heist_participants')
        .select('user_id, role')
        .eq('heist_id', heistId);

      const crewList = (partData ?? [])
        .map((p: any) => `• <@${p.user_id}> — **${p.role}** (+${perPerson.toLocaleString()} coins)`)
        .join('\n');

      const story = SUCCESS_STORIES[Math.floor(Math.random() * SUCCESS_STORIES.length)];

      const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle(`✅ Heist Success: ${heist.target_name}`)
            .setDescription(
              `${story}\n\n` +
              `💰 Total haul: **${totalPayout.toLocaleString()}** coins\n\n` +
              `**Crew Payouts:**\n${crewList}`
            )
            .setColor(0x57F287)],
        });
      }
    } else {
      // Failed — entry fees are lost
      await (this.supabase as any).from('economy_heists')
        .update({ status: 'failed', resolved_at: new Date().toISOString() })
        .eq('id', heistId);

      const story = FAIL_STORIES[Math.floor(Math.random() * FAIL_STORIES.length)];
      const entryFee = config?.economy_heist_entry_fee ?? 100;

      const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle(`❌ Heist Failed: ${heist.target_name}`)
            .setDescription(
              `${story}\n\n` +
              `👥 ${participants.map((id: string) => `<@${id}>`).join(', ')}\n\n` +
              `Each crew member lost their **${entryFee.toLocaleString()}** coin entry fee.`
            )
            .setColor(0xED4245)],
        });
      }
    }
  }

  /** Re-schedule pending heists on bot restart */
  async resumePendingHeists(guildId: string): Promise<void> {
    const { data: pending } = await (this.supabase as any)
      .from('economy_heists')
      .select('*')
      .eq('guild_id', guildId)
      .eq('status', 'recruiting');

    for (const heist of pending ?? []) {
      const remaining = new Date(heist.expires_at).getTime() - Date.now();
      if (remaining <= 0) {
        // Expired while offline — resolve immediately
        // Find the channel from the initiator's last message context — use log channel as fallback
        const config = await this.getConfig(guildId);
        const channelId = config?.economy_log_channel_id ?? '';
        await this.resolveHeist(guildId, heist.id, channelId);
      } else {
        const config = await this.getConfig(guildId);
        const channelId = config?.economy_log_channel_id ?? '';
        const timer = setTimeout(async () => {
          await this.resolveHeist(guildId, heist.id, channelId);
        }, remaining);
        this.resolveTimers.set(heist.id, timer);
      }
    }
  }
}
