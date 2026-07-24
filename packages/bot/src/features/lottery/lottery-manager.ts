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
import { eventBus } from '../../services/event-bus.js';

const log = createLogger('Lottery');

// ── Module-level state ────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, LotteryManager>();

export function registerLotteryManager(mgr: LotteryManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterLotteryManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateLotteryCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

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
    this.supabase = supabase;
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

      // Find the active drawing — or one stuck in 'drawing' (claimed but
      // payout pending), which must be retried until the stored winner is paid.
      const drawing = await this.getPendingDrawing(guildId);
      if (!drawing) return; // No pending drawing

      // Check if enough time has passed since the drawing was created
      const createdAt = new Date(drawing.created_at).getTime();
      const elapsed = Date.now() - createdAt;

      if (elapsed < intervalMs) return; // Not time yet

      // Time to draw! Pass the selected drawing through so the draw, the
      // payout and any no-entries reset all act on this exact row.
      await this.executeDrawAndAnnounce(guildId, config, drawing);
    } catch (err) {
      log.error('checkAndDraw error:', { error: String(err) });
    }
  }

  private async executeDrawAndAnnounce(guildId: string, config: DbGuildConfig, pending?: any): Promise<void> {
    // One tick acts on ONE drawing: the row selected here is the row that
    // gets drawn AND the row the no-entries branch may reset. Re-selecting
    // independently in each step picks DIFFERENT rows when several drawings
    // are pending (the draw path is oldest-first across active+drawing, the
    // old reset path was newest-first active-only), which left an old empty
    // drawing uncancelled and re-selected forever while a newer ticketed
    // drawing was never drawn.
    const selected = pending ?? await this.getPendingDrawing(guildId);
    if (!selected) return;

    const result = await this.drawWinner(guildId, selected);

    const logChannelId = config.economy_log_channel_id;
    const channel = logChannelId && this.client
      ? this.client.channels.cache.get(logChannelId) as TextChannel | undefined
      : undefined;

    if (result) {
      // Winner!
      if (channel) {
        const currencyName = config.currency_name ?? 'Coins';
        const currencyEmoji = config.currency_emoji ?? '🪙';
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('🎟️ Lottery Drawing Results!')
            .setDescription(
              `🎉 <@${result.winnerId}> won the lottery!\n\n` +
              `${currencyEmoji} Jackpot: **${result.jackpot.toLocaleString()}** ${currencyName}\n` +
              `🎫 Winning ticket: #${result.winningNumber}\n\n` +
              `A new lottery has started — buy tickets with \`/lottery buy\`!`
            )
            .setColor(0xF1C40F)],
        });
      }
    } else {
      // No entries — reset (cancel the drawing, start fresh). A null result
      // can also mean a payout retry is pending ('drawing' status with a
      // stored winner) or another worker claimed the row, so cancellation is
      // delegated to lottery_cancel_drawing_if_empty, which re-checks status
      // AND emptiness under the drawing row lock and cancels in the SAME
      // transaction. The previous bot-side probe-then-UPDATE left a window
      // where a /lottery buy acquired the row lock after the probe saw zero
      // tickets but before the cancel committed — the buyer's tickets and
      // coins landed in a drawing cancelled an instant later, with no refund
      // path. The RPC serialises against lottery_buy_tickets' FOR UPDATE:
      // a buy that commits first flips the outcome to 'has_tickets'; a
      // cancel that commits first makes the buy fail its post-lock status
      // guard (20260709190000) and the bot refunds.
      const { data: outcome, error: cancelErr } = await this.supabase.rpc(
        'lottery_cancel_drawing_if_empty',
        { p_drawing_id: selected.id },
      );
      if (cancelErr) {
        // Transient failure — never guess; leave the drawing for next tick.
        log.error(`Skipping no-entries reset of ${selected.id} — cancel RPC failed:`, cancelErr.message);
        return;
      }
      if (outcome === 'has_tickets') {
        // Entries exist (e.g. a buy raced this tick's claim attempt) — the
        // drawing is live; the next tick's draw path will settle it.
        log.info(`Skipping reset of ${selected.id} — drawing has tickets; will draw next tick`);
        return;
      }
      if (outcome !== 'cancelled') {
        // 'not_active': claimed, finalised or already cancelled elsewhere —
        // the payout-retry or already-done paths own this row now.
        return;
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

  /**
   * V49: The drawing the scheduler should act on — the active drawing, or one
   * stuck in the claimed-but-unpaid 'drawing' state whose stored winner still
   * needs the jackpot payout retried. Oldest first (id as a deterministic
   * tiebreak on equal created_at), so a stuck drawing is settled before a
   * newer active one is drawn. Every branch acting on the selected row makes
   * progress (draw, payout retry, legacy recovery or empty-cancel), so one
   * bad row can never starve newer drawings.
   */
  private async getPendingDrawing(guildId: string): Promise<any | null> {
    const { data } = await this.supabase
      .from('economy_lottery_drawings')
      .select('*')
      .eq('guild_id', guildId)
      .in('status', ['active', 'drawing'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
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
    // White-label currency branding (parity with the rest of the economy).
    const currencyName = config.currency_name ?? 'Coins';
    const currencyEmoji = config.currency_emoji ?? '🪙';

    if (count < 1 || count > maxTickets) {
      await interaction.reply({ content: `❌ You can buy 1-${maxTickets} tickets per drawing.`, ephemeral: true });
      return;
    }

    const totalCost = count * ticketPrice;

    const drawing = await this.ensureActiveDrawing(guildId);
    if (!drawing) {
      await interaction.reply({ content: '❌ Could not create lottery drawing.', ephemeral: true });
      return;
    }

    // Atomic + idempotent purchase: the funds check, debit, ticket insert, and
    // jackpot increment commit as ONE call keyed on the interaction id, so a
    // redelivered /lottery buy charges and issues tickets exactly once (no
    // double-charge). Insufficient funds / a closed drawing roll everything back.
    const { data, error: buyErr } = await this.supabase.rpc('lottery_buy_tickets_atomic', {
      p_drawing_id: drawing.id,
      p_guild_id: guildId,
      p_user_id: userId,
      p_count: count,
      p_max: maxTickets,
      p_cost: totalCost,
      p_request_id: interaction.id,
    });
    if (buyErr || !data || typeof data !== 'object') {
      log.error('lottery_buy_tickets_atomic failed:', buyErr?.message);
      await interaction.reply({ content: '❌ Could not buy tickets right now — please try again.', ephemeral: true });
      return;
    }

    const result = data as { status?: string; replayed?: boolean; jackpot?: number };
    switch (result.status) {
      case 'insufficient_funds':
        await interaction.reply({ content: `❌ You need **${totalCost.toLocaleString()}** ${currencyName} (${count} × ${ticketPrice.toLocaleString()}).`, ephemeral: true });
        return;
      case 'max_tickets':
        await interaction.reply({ content: `❌ You already have the maximum number of tickets for this drawing (max ${maxTickets}).`, ephemeral: true });
        return;
      case 'drawing_closed':
        await interaction.reply({ content: '⏰ That drawing just closed — its winner is being drawn. Buy tickets again once the next drawing starts!', ephemeral: true });
        return;
      case 'purchased':
        break;
      default:
        await interaction.reply({ content: '❌ Could not buy tickets right now — please try again.', ephemeral: true });
        return;
    }

    // Quest progress is not idempotent — credit it only on the first application.
    if (!result.replayed) {
      getQuestsManager(guildId)?.trackProgress(guildId, userId, 'lottery', count).catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      // [game-economy-lottery] Append-only audit row for the ticket-purchase
      // state change (only a genuinely-new, non-replayed buy charges + issues).
      eventBus.emit('lottery.ticket_purchased', guildId, {
        userId,
        count,
        totalCost,
        jackpot: result.jackpot ?? drawing.jackpot + totalCost,
      });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎟️ Lottery Tickets Purchased!')
        .setDescription(
          `You bought **${count}** ticket(s) for **${totalCost.toLocaleString()}** ${currencyName}.\n` +
          `Current jackpot: **${(result.jackpot ?? drawing.jackpot + totalCost).toLocaleString()}** ${currencyName} ${currencyEmoji}`
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
      .eq('drawing_id', drawing.id)
      .limit(1000);

    const uniquePlayers = new Set((tickets ?? []).map((t: any) => t.user_id));
    const currencyName = config.currency_name ?? 'Coins';
    const currencyEmoji = config.currency_emoji ?? '🪙';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎟️ Current Lottery')
        .setDescription(
          `${currencyEmoji} Jackpot: **${(drawing.jackpot ?? 0).toLocaleString()}** ${currencyName}\n` +
          `🎫 Tickets sold: **${(tickets ?? []).length}**\n` +
          `👥 Players: **${uniquePlayers.size}**\n` +
          `📅 Schedule: **${config.economy_lottery_schedule ?? 'weekly'}**\n` +
          `💵 Ticket price: **${(config.economy_lottery_ticket_price ?? 100).toLocaleString()}** ${currencyName}`
        )
        .setColor(0x5865F2)],
    });
  }

  async drawWinner(guildId: string, pending?: any): Promise<{ winnerId: string; jackpot: number; winningNumber: number } | null> {
    // The scheduler passes the drawing it already selected so this call, the
    // payout and the caller's no-entries reset all act on the same row.
    const drawing = pending ?? await this.getPendingDrawing(guildId);
    if (!drawing) return null;

    let status = drawing.status;

    // Legacy recovery (codex round 2): the v48-era flow flipped status to
    // 'drawing' BEFORE a winner was picked bot-side, so a crash in that
    // window leaves status='drawing' with winner_user_id NULL. Neither the
    // claim path (needs 'active') nor lottery_award_jackpot (needs a stored
    // winner) can settle such a row, so the oldest-first pending query would
    // re-select it forever and newer drawings would never be drawn.
    //
    // winner_user_id IS NULL is proof no payout ever happened: the v48 bot
    // only paid after a successfully committed claim, which the v31 status
    // CHECK made impossible (it did not allow 'drawing' until the
    // 20260709130000 widening — the same migration that made the claim store
    // the winner atomically), and lottery_award_jackpot refuses NULL-winner
    // rows. Reverting the row to 'active' is therefore double-pay-safe: it
    // re-enters the normal pipeline this same tick — claimed and drawn if it
    // has tickets, cancelled by the empty-reset path if it has none. The
    // guarded single-statement UPDATE is atomic; if a concurrent worker
    // recovered the row first the UPDATE is a no-op and the claim below
    // still decides a single owner.
    if (status === 'drawing' && drawing.winner_user_id == null) {
      const { error: recoverErr } = await this.supabase
        .from('economy_lottery_drawings')
        .update({ status: 'active' })
        .eq('id', drawing.id)
        .eq('status', 'drawing')
        .is('winner_user_id', null);
      if (recoverErr) {
        log.error(`Failed to recover legacy claimed drawing ${drawing.id} (no stored winner):`, recoverErr.message);
        return null;
      }
      log.warn(`Recovered legacy drawing ${drawing.id} stuck in 'drawing' with no stored winner — re-queued as active`);
      status = 'active';
    }

    // V49: stable winner + idempotent payout. lottery_claim_drawing picks
    // AND persists the winning ticket inside the atomic active→'drawing'
    // claim; lottery_award_jackpot credits the STORED winner and finalises
    // to 'drawn' in a single transaction. A failed payout leaves the row in
    // 'drawing' with its winner recorded, so the next tick retries the SAME
    // winner — the previous revert-to-'active' re-rolled the winner and
    // could double-pay when the "failed" payout had landed server-side.
    if (status === 'active') {
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
        // Another worker claimed it, or the drawing has no tickets (the RPC
        // leaves it 'active' so the caller's "no entries" path can reset it).
        log.info(`Skipping draw of ${drawing.id} — already claimed or no tickets`);
        return null;
      }
    }

    // Pay the stored winner. Returns the drawing iff THIS call performed the
    // payout; no rows means it was already finalised — never pay twice.
    const { data: awarded, error: awardErr } = await this.supabase.rpc(
      'lottery_award_jackpot',
      { p_drawing_id: drawing.id },
    );
    if (awardErr) {
      log.error(`Failed to award lottery jackpot for ${drawing.id} (stored winner will be retried next tick):`, awardErr.message);
      // [game-economy-lottery] Owner draw-degraded alert + audit on jackpot-payout
      // failure so the stuck (unpaid, will-retry) drawing is operator-visible.
      await this.raiseDrawDegradedAlert(guildId, drawing.id)
        .catch((e: unknown) => { log.warn('lottery draw-degraded alert failed:', (e as Error)?.message ?? e); });
      eventBus.emit('lottery.payout_failed', guildId, {
        drawingId: drawing.id,
        reason: awardErr.message,
      });
      return null;
    }
    const awardedRow = Array.isArray(awarded) ? awarded[0] : awarded;
    if (!awardedRow) {
      log.info(`Skipping payout of ${drawing.id} — already finalised`);
      return null;
    }

    // [game-economy-lottery] Append-only audit row for the draw state change
    // (winner selected + jackpot paid). Only the call that performed the payout
    // reaches here (awardedRow non-null), so this never double-audits.
    eventBus.emit('lottery.drawn', guildId, {
      drawingId: drawing.id,
      winnerId: awardedRow.winner_user_id,
      jackpot: awardedRow.jackpot ?? 0,
      winningNumber: awardedRow.winning_number,
    });

    return {
      winnerId: awardedRow.winner_user_id,
      jackpot: awardedRow.jackpot ?? 0,
      winningNumber: awardedRow.winning_number,
    };
  }

  /**
   * [game-economy-lottery] Raise a draw-degraded owner alert when the jackpot
   * payout RPC fails so an operator knows a stored winner is still owed their
   * prize (the draw is retried next tick). Best effort — never blocks the draw.
   */
  private async raiseDrawDegradedAlert(guildId: string, drawingId: string): Promise<void> {
    await this.supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'lottery_draw_degraded',
      severity: 'warning',
      title: 'Lottery jackpot payout degraded',
      message: `The jackpot payout for drawing ${drawingId} failed. The stored winner will be retried on the next draw tick.`,
      metadata: { drawing_id: drawingId },
    });
  }
}
