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
import type { PlatformEventBus } from '../../services/event-bus.js';

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
  status: 'active' | 'ended' | 'cancelled';
  created_by: string;
  created_at: string;
}

export class GiveawayManager {
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private valkey: Valkey,
    private eventBus: PlatformEventBus,
  ) {}

  async start(): Promise<void> {
    // Check every 30 seconds for giveaways that need to end
    this.checkTimer = setInterval(() => {
      this.checkExpired().catch((err) => {
        console.error('[Giveaways] Check error:', err);
      });
    }, 30_000);

    // Initial check
    await this.checkExpired();
    console.log('[Giveaways] Manager started');
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
      console.error('[Giveaways] Create error:', error?.message);
      return null;
    }

    const giveaway = data as GiveawayRow;

    // Post embed
    const channel = this.guild.channels.cache.get(options.channelId) as TextChannel | undefined;
    if (channel) {
      const embed = this.buildGiveawayEmbed(giveaway);
      const row = this.buildEntryButton(giveaway);

      const msg = await channel.send({ embeds: [embed], components: [row] });

      await this.supabase
        .from('giveaways')
        .update({ message_id: msg.id })
        .eq('id', giveaway.id);

      giveaway.message_id = msg.id;
    }

    return giveaway;
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
      await interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });
      return true;
    }

    const giveaway = data as GiveawayRow;

    // Check requirements
    const member = this.guild.members.cache.get(userId);
    if (!member) {
      await interaction.reply({ content: '❌ Could not find your member data.', ephemeral: true });
      return true;
    }

    if (giveaway.required_role_id && !member.roles.cache.has(giveaway.required_role_id)) {
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
        console.error('[Giveaways] giveaway_remove_entry RPC not found or no match — run migrations');
        await interaction.reply({ content: '❌ Internal error — please try again.', ephemeral: true });
        return true;
      }
      const newEntries: string[] = updated[0].entries ?? [];

      await this.updateGiveawayMessage({ ...giveaway, entries: newEntries });
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
      console.error('[Giveaways] giveaway_add_entry RPC not found or no match — run migrations');
      await interaction.reply({ content: '❌ Internal error — please try again.', ephemeral: true });
      return true;
    }
    const newEntries: string[] = updated[0].entries ?? [];

    await this.updateGiveawayMessage({ ...giveaway, entries: newEntries });
    await interaction.reply({ content: '🎉 You have entered the giveaway! Click again to withdraw.', ephemeral: true });
    return true;
  }

  /**
   * End a specific giveaway and select winners.
   */
  async endGiveaway(giveawayId: string): Promise<string[]> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('id', giveawayId)
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    if (!data) return [];
    const giveaway = data as GiveawayRow;
    if (giveaway.status !== 'active') return giveaway.winners;

    return this.selectWinnersAndEnd(giveaway);
  }

  /**
   * Reroll winners for an ended giveaway.
   */
  async reroll(giveawayId: string, count?: number): Promise<string[]> {
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

    await this.supabase
      .from('giveaways')
      .update({ winners: [...giveaway.winners, ...newWinners] })
      .eq('id', giveawayId);

    // Announce reroll
    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (channel) {
      const winnerMentions = newWinners.map((id) => `<@${id}>`).join(', ');
      await channel.send({
        content: `🎊 **Giveaway Reroll** — New winner${newWinners.length > 1 ? 's' : ''}: ${winnerMentions || 'No eligible entries'}`,
      });
    }

    return newWinners;
  }

  private async checkExpired(): Promise<void> {
    const { data } = await this.supabase
      .from('giveaways')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('status', 'active')
      .lte('ends_at', new Date().toISOString());

    if (!data || data.length === 0) return;

    for (const row of data) {
      try {
        await this.selectWinnersAndEnd(row as GiveawayRow);
      } catch (err) {
        console.error(`[Giveaways] Error ending giveaway ${row.id}:`, err);
      }
    }
  }

  private async selectWinnersAndEnd(giveaway: GiveawayRow): Promise<string[]> {
    const winners = this.pickRandom(giveaway.entries, giveaway.winner_count);

    await this.supabase
      .from('giveaways')
      .update({
        status: 'ended',
        winners,
        ended_at: new Date().toISOString(),
      })
      .eq('id', giveaway.id);

    // Update the giveaway message
    const endedGiveaway = { ...giveaway, status: 'ended' as const, winners };
    await this.updateGiveawayMessage(endedGiveaway);

    // Announce winners
    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (channel) {
      if (winners.length > 0) {
        const winnerMentions = winners.map((id) => `<@${id}>`).join(', ');
        await channel.send({
          content: `🎉 **Giveaway ended!** Prize: **${giveaway.prize}**\nWinner${winners.length > 1 ? 's' : ''}: ${winnerMentions}\n\nCongratulations!`,
        });
      } else {
        await channel.send({
          content: `😔 **Giveaway ended!** Prize: **${giveaway.prize}**\nNo valid entries — no winners selected.`,
        });
      }
    }

    // Emit platform event
    this.eventBus.emit('giveaway.ended', this.guild.id, {
      giveawayId: giveaway.id,
      title: giveaway.prize,
      winnerIds: winners,
      prizeProductId: giveaway.prize_product_id,
    });

    console.log(`[Giveaways] Ended "${giveaway.prize}" — ${winners.length} winner(s)`);
    return winners;
  }

  private async updateGiveawayMessage(giveaway: GiveawayRow): Promise<void> {
    if (!giveaway.message_id) return;

    const channel = this.guild.channels.cache.get(giveaway.channel_id) as TextChannel | undefined;
    if (!channel) return;

    try {
      const msg = await channel.messages.fetch(giveaway.message_id);
      const embed = this.buildGiveawayEmbed(giveaway);

      if (giveaway.status === 'ended') {
        await msg.edit({ embeds: [embed], components: [] });
      } else {
        const row = this.buildEntryButton(giveaway);
        await msg.edit({ embeds: [embed], components: [row] });
      }
    } catch {
      // Message may have been deleted
    }
  }

  private buildGiveawayEmbed(giveaway: GiveawayRow): EmbedBuilder {
    const isEnded = giveaway.status === 'ended';
    const embed = new EmbedBuilder()
      .setTitle(isEnded ? '🎉 Giveaway Ended' : '🎉 Giveaway')
      .setDescription(giveaway.prize)
      .setColor(isEnded ? 0x808080 : 0x57F287)
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
    embed.setFooter({ text: isEnded ? 'Giveaway ended' : `${giveaway.winner_count} winner(s) • Ends` });

    return embed;
  }

  private buildEntryButton(giveaway: GiveawayRow): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter:${giveaway.id}`)
        .setLabel(`Enter (${giveaway.entries.length})`)
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success),
    );
  }

  private pickRandom(arr: string[], count: number): string[] {
    if (arr.length === 0) return [];
    // Fisher-Yates (Knuth) shuffle — produces a uniform distribution.
    // The previous .sort(() => Math.random() - 0.5) is a known-biased approach.
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i]!, shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
}
