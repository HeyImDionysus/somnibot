/**
 * LotteryManager — ticket purchases, jackpot pool, scheduled drawings.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';

// ── Module-level state ────────────────────────────────────

let _manager: LotteryManager | null = null;
export function registerLotteryManager(mgr: LotteryManager): void { _manager = mgr; }
export function invalidateLotteryCache(): void { _manager?.clearCache(); }

// ── Manager ───────────────────────────────────────────────

export class LotteryManager {
  private supabase: SupabaseClient;
  private configCache = new Map<string, DbGuildConfig>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase as any;
  }

  clearCache(): void { this.configCache.clear(); }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await (this.supabase as any).from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getActiveDrawing(guildId: string): Promise<any | null> {
    const { data } = await (this.supabase as any)
      .from('economy_lottery_drawings')
      .select('*')
      .eq('guild_id', guildId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data;
  }

  private async ensureActiveDrawing(guildId: string): Promise<any> {
    let drawing = await this.getActiveDrawing(guildId);
    if (!drawing) {
      const { data } = await (this.supabase as any)
        .from('economy_lottery_drawings')
        .insert({ guild_id: guildId, status: 'active', jackpot: 0 })
        .select()
        .single();
      drawing = data;
    }
    return drawing;
  }

  async buyTickets(interaction: ChatInputCommandInteraction, count: number): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_lottery_enabled) {
      await interaction.reply({ content: '❌ Lottery is not enabled on this server.', ephemeral: true });
      return;
    }

    const maxTickets = config.economy_lottery_max_tickets ?? 10;
    const ticketPrice = config.economy_lottery_ticket_price ?? 100;

    if (count < 1 || count > maxTickets) {
      await interaction.reply({ content: `❌ You can buy 1-${maxTickets} tickets per drawing.`, ephemeral: true });
      return;
    }

    const totalCost = count * ticketPrice;

    // Check balance
    const { data: wallet } = await (this.supabase as any)
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();

    if (!wallet || wallet.wallet < totalCost) {
      await interaction.reply({ content: `❌ You need **${totalCost.toLocaleString()}** coins (${count} × ${ticketPrice.toLocaleString()}).`, ephemeral: true });
      return;
    }

    const drawing = await this.ensureActiveDrawing(guildId);
    if (!drawing) {
      await interaction.reply({ content: '❌ Could not create lottery drawing.', ephemeral: true });
      return;
    }

    // Check existing tickets
    const { data: existingTickets } = await (this.supabase as any)
      .from('economy_lottery_tickets')
      .select('id')
      .eq('drawing_id', drawing.id)
      .eq('guild_id', guildId)
      .eq('user_id', userId);

    const existingCount = existingTickets?.length ?? 0;
    if (existingCount + count > maxTickets) {
      await interaction.reply({
        content: `❌ You already have ${existingCount} ticket(s). Max is ${maxTickets}.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct balance
    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: totalCost,
    }).catch(() => {});

    // Insert tickets
    const tickets = Array.from({ length: count }, () => ({
      drawing_id: drawing.id,
      guild_id: guildId,
      user_id: userId,
      ticket_number: Math.floor(Math.random() * 10000),
    }));

    await (this.supabase as any).from('economy_lottery_tickets').insert(tickets);

    // Update jackpot
    await (this.supabase as any)
      .from('economy_lottery_drawings')
      .update({ jackpot: drawing.jackpot + totalCost })
      .eq('id', drawing.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎟️ Lottery Tickets Purchased!')
        .setDescription(
          `You bought **${count}** ticket(s) for **${totalCost.toLocaleString()}** coins.\n` +
          `Current jackpot: **${(drawing.jackpot + totalCost).toLocaleString()}** coins 💰`
        )
        .setColor(0x5865F2)],
    });
  }

  async viewLottery(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);

    if (!config?.economy_lottery_enabled) {
      await interaction.reply({ content: '❌ Lottery is not enabled on this server.', ephemeral: true });
      return;
    }

    const drawing = await this.getActiveDrawing(guildId);
    if (!drawing) {
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎟️ Lottery')
          .setDescription('No active lottery drawing. Buy a ticket to start one!')
          .setColor(0x5865F2)],
      });
      return;
    }

    const { data: tickets } = await (this.supabase as any)
      .from('economy_lottery_tickets')
      .select('user_id')
      .eq('drawing_id', drawing.id);

    const uniquePlayers = new Set((tickets ?? []).map((t: any) => t.user_id));

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎟️ Current Lottery')
        .setDescription(
          `💰 Jackpot: **${(drawing.jackpot ?? 0).toLocaleString()}** coins\n` +
          `🎫 Tickets sold: **${(tickets ?? []).length}**\n` +
          `👥 Players: **${uniquePlayers.size}**\n` +
          `📅 Schedule: **${config.economy_lottery_schedule ?? 'weekly'}**\n` +
          `💵 Ticket price: **${(config.economy_lottery_ticket_price ?? 100).toLocaleString()}** coins`
        )
        .setColor(0x5865F2)],
    });
  }

  async drawWinner(guildId: string): Promise<{ winnerId: string; jackpot: number } | null> {
    const drawing = await this.getActiveDrawing(guildId);
    if (!drawing) return null;

    const { data: tickets } = await (this.supabase as any)
      .from('economy_lottery_tickets')
      .select('*')
      .eq('drawing_id', drawing.id);

    if (!tickets || tickets.length === 0) return null;

    // Random winner
    const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];

    // Award jackpot
    await (this.supabase as any).rpc('economy_add_balance', {
      p_guild_id: guildId,
      p_user_id: winnerTicket.user_id,
      p_amount: drawing.jackpot,
    }).catch(() => {});

    // Close drawing
    await (this.supabase as any)
      .from('economy_lottery_drawings')
      .update({
        status: 'drawn',
        winner_user_id: winnerTicket.user_id,
        winning_number: winnerTicket.ticket_number,
        drawn_at: new Date().toISOString(),
      })
      .eq('id', drawing.id);

    return { winnerId: winnerTicket.user_id, jackpot: drawing.jackpot };
  }
}
