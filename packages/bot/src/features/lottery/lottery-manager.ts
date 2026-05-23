/**
 * LotteryManager — ticket purchases, jackpot pool, scheduled drawings.
 *
 * V36: Added scheduleLotteryDraws() — reads economy_lottery_schedule
 * ('daily'|'weekly'|'12h'|'6h') and runs drawWinner() + announce on interval.
 * No entries = pot resets (per design decision).
 */
import { EmbedBuilder, type ChatInputCommandInteraction, type Client, type TextChannel } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import type { DbRow } from '@somnibot/shared';


const log = createLogger('Lottery');

// ── Module-level state ────────────────────────────────────

let _manager: LotteryManager | null = null;
export function registerLotteryManager(mgr: LotteryManager): void { _manager = mgr; }
export function invalidateLotteryCache(): void { _manager?.clearCache(); }

const SCHEDULE_MS: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  'weekly': 7 * 24 * 60 * 60 * 1000,
  'biweekly': 14 * 24 * 60 * 60 * 1000,
  'monthly': 30 * 24 * 60 * 60 * 1000,
};

// ── Manager ───────────────────────────────────────────────

export class LotteryManager {
  private supabase: SupabaseClient;
  private client: Client | null = null;
  private configCache = new Map<string, DbGuildConfig>();
  private drawTimer: NodeJS.Timeout | null = null;

  constructor(supabase: SupabaseClient, client?: Client) {
    this.supabase = supabase as any;
    this.client = client ?? null;
  }

  clearCache(): void { this.configCache.clear(); }

  /** Start the lottery draw cron. Call once at boot. */
  scheduleLotteryDraws(guildId: string): void {
    // Stop any existing timer
    if (this.drawTimer) { clearInterval(this.drawTimer); this.drawTimer = null; }

    // Run the first draw check after a short delay, then on interval
    setTimeout(async () => {
      try {
        const config = await this.getConfig(guildId);
        const schedule = config?.economy_lottery_schedule ?? 'weekly';
        const intervalMs = SCHEDULE_MS[schedule] ?? SCHEDULE_MS['weekly'];

        // Check if it's time to draw (based on last drawing)
        await this.checkAndDraw(guildId);

        this.drawTimer = setInterval(async () => {
          try {
            await this.checkAndDraw(guildId);
          } catch (err) {
            log.error(`Draw check error for guild ${guildId}:`, err);
          }
        }, Math.min(intervalMs, 60 * 60 * 1000)); // Check at least every hour
      } catch (err) {
        log.error(`Failed to initialize draw schedule for guild ${guildId}:`, err);
      }
    }, 60_000); // 1 minute after boot
  }

  stopDrawTimer(): void {
    if (this.drawTimer) { clearInterval(this.drawTimer); this.drawTimer = null; }
  }

  private async checkAndDraw(guildId: string): Promise<void> {
    try {
      const config = await this.getConfig(guildId);
      if (!config?.economy_lottery_enabled) return;

      const schedule = config.economy_lottery_schedule ?? 'weekly';
      const intervalMs = SCHEDULE_MS[schedule] ?? SCHEDULE_MS['weekly'];

      // Find the active drawing
      const drawing = await this.getActiveDrawing(guildId);
      if (!drawing) return; // No active drawing

      // Check if enough time has passed since the drawing was created
      const createdAt = new Date(drawing.created_at).getTime();
      const elapsed = Date.now() - createdAt;

      if (elapsed < intervalMs) return; // Not time yet

      // Time to draw!
      await this.executeDrawAndAnnounce(guildId, config);
    } catch (err) {
      log.error('checkAndDraw error:', { error: String(err) });
    }
  }

  private async executeDrawAndAnnounce(guildId: string, config: DbGuildConfig): Promise<void> {
    const result = await this.drawWinner(guildId);

    const logChannelId = config.economy_log_channel_id;
    const channel = logChannelId && this.client
      ? this.client.channels.cache.get(logChannelId) as TextChannel | undefined
      : undefined;

    if (result) {
      // Winner!
      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('🎟️ Lottery Drawing Results!')
            .setDescription(
              `🎉 <@${result.winnerId}> won the lottery!\n\n` +
              `💰 Jackpot: **${result.jackpot.toLocaleString()}** coins\n` +
              `🎫 Winning ticket: #${result.winningNumber}\n\n` +
              `A new lottery has started — buy tickets with \`/lottery buy\`!`
            )
            .setColor(0xF1C40F)],
        });
      }
    } else {
      // No entries — reset (cancel the drawing, start fresh)
      const drawing = await this.getActiveDrawing(guildId);
      if (drawing) {
        await this.supabase
          .from('economy_lottery_drawings')
          .update({ status: 'cancelled', drawn_at: new Date().toISOString() })
          .eq('id', drawing.id);
      }

      if (channel) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('🎟️ Lottery Reset')
            .setDescription(
              'No one entered this lottery drawing. The pot has been reset.\n' +
              'Buy tickets with `/lottery buy` to start the next one!'
            )
            .setColor(0x95A5A6)],
        });
      }
    }
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getActiveDrawing(guildId: string): Promise<any | null> {
    const { data } = await this.supabase
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
      const { data } = await this.supabase
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
    const { data: wallet } = await this.supabase
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
    const { data: existingTickets } = await this.supabase
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

    // Deduct balance — bail if insufficient funds
    const { error: debitErr } = await this.supabase.rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: totalCost,
    });
    if (debitErr) {
      await interaction.reply({
        content: `❌ You don't have enough to buy ${count} ticket(s) (need **${totalCost.toLocaleString()}**).`,
        ephemeral: true,
      });
      return;
    }

    // V48-M3: insert tickets and refund on failure. Previously the
    // insert error was swallowed — a transient DB error would debit the
    // user but produce no tickets and no jackpot increment, robbing
    // them. We also no longer mutate the jackpot if ticket insert
    // failed (otherwise winners get coins from nowhere).
    const tickets = Array.from({ length: count }, () => ({
      drawing_id: drawing.id,
      guild_id: guildId,
      user_id: userId,
      ticket_number: Math.floor(Math.random() * 10000),
    }));

    const { error: ticketsErr } = await this.supabase
      .from('economy_lottery_tickets')
      .insert(tickets);
    if (ticketsErr) {
      log.error('ticket insert failed, refunding user:', ticketsErr.message);
      const { error: refundErr } = await this.supabase.rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: totalCost,
      });
      if (refundErr) {
        log.error('CRITICAL: ticket insert failed AND refund failed', {
          guildId, userId, totalCost, ticketsErr, refundErr,
        });
      }
      await interaction.reply({
        content: '❌ Failed to record your tickets — your coins were refunded.',
        ephemeral: true,
      });
      return;
    }

    // Atomically increment jackpot to prevent TOCTOU race
    const { data: newJackpot, error: jackpotErr } = await this.supabase.rpc('lottery_increment_jackpot', {
      p_drawing_id: drawing.id, p_amount: totalCost,
    });
    if (jackpotErr) {
      // Tickets exist but jackpot is short. Best-effort compensate by
      // deleting just-inserted tickets and refunding the user so the
      // pool stays consistent with what was paid in.
      log.error('jackpot increment failed, rolling back tickets:', jackpotErr.message);
      await this.supabase
        .from('economy_lottery_tickets')
        .delete()
        .eq('drawing_id', drawing.id)
        .eq('user_id', userId)
        .in('ticket_number', tickets.map((t) => t.ticket_number));
      const { error: refundErr } = await this.supabase.rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: totalCost,
      });
      if (refundErr) {
        log.error('CRITICAL: jackpot increment failed AND refund failed', {
          guildId, userId, totalCost, jackpotErr, refundErr,
        });
      }
      await interaction.reply({
        content: '❌ Failed to update the jackpot — your coins were refunded.',
        ephemeral: true,
      });
      return;
    }

    getQuestsManager()?.trackProgress(guildId, userId, 'lottery', count).catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎟️ Lottery Tickets Purchased!')
        .setDescription(
          `You bought **${count}** ticket(s) for **${totalCost.toLocaleString()}** coins.\n` +
          `Current jackpot: **${(newJackpot ?? drawing.jackpot + totalCost).toLocaleString()}** coins 💰`
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

    const { data: tickets } = await this.supabase
      .from('economy_lottery_tickets')
      .select('user_id')
      .eq('drawing_id', drawing.id);

    const uniquePlayers = new Set((tickets ?? []).map((t: DbRow) => t.user_id));

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

  async drawWinner(guildId: string): Promise<{ winnerId: string; jackpot: number; winningNumber: number } | null> {
    const drawing = await this.getActiveDrawing(guildId);
    if (!drawing) return null;

    // V48-L1: atomic active→drawing claim. The previous flow flipped
    // status to 'drawn' unconditionally and only *logged* a failed
    // payout — so a failed `economy_add_balance` left the winner unpaid
    // and the drawing closed, with no recovery. It was also non-
    // idempotent: a manual /lottery draw racing the scheduler could
    // award two payouts. The RPC returns the drawing iff it was still
    // 'active', so exactly one caller will proceed.
    const { data: claimed, error: claimErr } = await this.supabase.rpc(
      'lottery_claim_drawing',
      { p_drawing_id: drawing.id },
    );
    if (claimErr) {
      log.error('lottery_claim_drawing failed:', claimErr.message);
      return null;
    }
    const claimedRow = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!claimedRow) {
      log.info(`Skipping draw of ${drawing.id} — already claimed by another worker`);
      return null;
    }

    const jackpotSnapshot: number = claimedRow.jackpot ?? drawing.jackpot ?? 0;

    const { data: tickets } = await this.supabase
      .from('economy_lottery_tickets')
      .select('*')
      .eq('drawing_id', drawing.id);

    if (!tickets || tickets.length === 0) {
      // No tickets — revert the claim so the scheduled "no entries"
      // path can flip it to 'cancelled' (the executeDrawAndAnnounce
      // caller expects status='active' to update).
      await this.supabase
        .from('economy_lottery_drawings')
        .update({ status: 'active' })
        .eq('id', drawing.id);
      return null;
    }

    // Random winner
    const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];

    // Award jackpot BEFORE flipping to 'drawn' so a payout failure
    // doesn't leave the winner unpaid + the drawing permanently closed.
    const { error: jackpotErr } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: guildId,
      p_user_id: winnerTicket.user_id,
      p_amount: jackpotSnapshot,
    });
    if (jackpotErr) {
      log.error(`Failed to award jackpot to ${winnerTicket.user_id}:`, jackpotErr.message);
      // Revert to 'active' so the next scheduled tick retries the draw
      // (and the same winner won't necessarily be picked, but the pool
      // is preserved and no one is silently shortchanged).
      await this.supabase
        .from('economy_lottery_drawings')
        .update({ status: 'active' })
        .eq('id', drawing.id);
      return null;
    }

    // Close drawing — finalize from 'drawing' to 'drawn'.
    await this.supabase
      .from('economy_lottery_drawings')
      .update({
        status: 'drawn',
        winner_user_id: winnerTicket.user_id,
        winning_number: winnerTicket.ticket_number,
        drawn_at: new Date().toISOString(),
      })
      .eq('id', drawing.id)
      .eq('status', 'drawing');

    return { winnerId: winnerTicket.user_id, jackpot: jackpotSnapshot, winningNumber: winnerTicket.ticket_number };
  }
}
