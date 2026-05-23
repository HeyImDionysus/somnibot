/**
 * PollsManager — handles free polls and currency-based prediction markets.
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Polls');

// ── Module-level state ────────────────────────────────────

let _manager: PollsManager | null = null;
export function registerPollsManager(mgr: PollsManager): void { _manager = mgr; }
export function invalidatePollsCache(): void { _manager?.clearCache(); }

// ── Manager ───────────────────────────────────────────────

export class PollsManager {
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

  // ── Polls ───────────────────────────────────────────────

  async createPoll(
    interaction: ChatInputCommandInteraction,
    title: string,
    options: string[],
    allowMultiple: boolean,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);

    if (!config?.polls_enabled) {
      await interaction.reply({ content: '❌ Polls are not enabled on this server.', ephemeral: true });
      return;
    }

    if (options.length < 2 || options.length > 10) {
      await interaction.reply({ content: '❌ Polls need 2-10 options.', ephemeral: true });
      return;
    }

    // Create poll
    const { data: poll } = await (this.supabase as any)
      .from('polls')
      .insert({
        guild_id: guildId,
        channel_id: interaction.channelId,
        creator_user_id: interaction.user.id,
        title,
        allow_multiple: allowMultiple,
      })
      .select()
      .single();

    if (!poll) {
      await interaction.reply({ content: '❌ Failed to create poll.', ephemeral: true });
      return;
    }

    // Insert options
    const optionRows = options.map((label, i) => ({
      poll_id: poll.id,
      label,
      sort_order: i,
    }));

    const { data: insertedOptions } = await (this.supabase as any)
      .from('poll_options')
      .insert(optionRows)
      .select();

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${title}`)
      .setDescription(
        (insertedOptions ?? []).map((opt: any, i: number) =>
          `${numberEmojis[i]} **${opt.label}** — 0 votes`
        ).join('\n') +
        `\n\n*${allowMultiple ? 'Multiple votes allowed' : 'One vote per person'}*`
      )
      .setColor(0x5865F2)
      .setFooter({ text: `Poll ID: ${poll.id}` });

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const buttonsPerRow = 5;
    for (let i = 0; i < (insertedOptions ?? []).length; i += buttonsPerRow) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const slice = (insertedOptions ?? []).slice(i, i + buttonsPerRow);
      for (let j = 0; j < slice.length; j++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`poll:${poll.id}:${slice[j].id}`)
            .setLabel(numberEmojis[i + j])
            .setStyle(ButtonStyle.Secondary)
        );
      }
      rows.push(row);
    }

    await interaction.reply({ embeds: [embed], components: rows });

    // Store message ID
    const reply = await interaction.fetchReply();
    await (this.supabase as any)
      .from('polls')
      .update({ message_id: reply.id })
      .eq('id', poll.id);
  }

  async handlePollVote(buttonInteraction: ButtonInteraction): Promise<void> {
    const parts = buttonInteraction.customId.split(':');
    if (parts.length < 3) return;
    const pollId = parts[1];
    const optionId = parts[2];
    const userId = buttonInteraction.user.id;

    // Check poll exists and is active
    const { data: poll } = await (this.supabase as any)
      .from('polls')
      .select('*')
      .eq('id', pollId)
      .single();

    if (!poll || poll.status !== 'active') {
      await buttonInteraction.reply({ content: 'This poll is closed.', ephemeral: true });
      return;
    }

    if (!poll.allow_multiple) {
      // V50-M3: use poll_vote_single RPC — atomically inserts a vote only
      // if the user has no existing vote on this poll. The previous
      // read-then-write pattern let concurrent clicks both pass the
      // "already voted?" check and insert duplicate votes.
      const { data: voteRows, error: voteErr } = await (this.supabase as any).rpc('poll_vote_single', {
        p_poll_id: pollId,
        p_option_id: optionId,
        p_user_id: userId,
      });

      if (voteErr) {
        // 23505 = unique_violation from uniq_poll_vote_per_option index
        if ((voteErr as { code?: string }).code === '23505') {
          await buttonInteraction.reply({ content: 'You already voted for this option!', ephemeral: true });
          return;
        }
        log.error('poll_vote_single RPC error:', voteErr);
        await buttonInteraction.reply({ content: '❌ Failed to record vote — please try again.', ephemeral: true });
        return;
      }

      // RPC returns empty set if user already had a vote on this poll
      if (!voteRows || (Array.isArray(voteRows) && voteRows.length === 0)) {
        await buttonInteraction.reply({ content: 'You already voted! (Single vote poll)', ephemeral: true });
        return;
      }

      getQuestsManager()?.trackProgress(buttonInteraction.guildId!, userId, 'poll_vote').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      await buttonInteraction.reply({ content: '✅ Vote recorded!', ephemeral: true });
      return;
    }

    // Multi-vote polls: check if already voted for this specific option
    // The uniq_poll_vote_per_option unique index is the authoritative gate.
    const { error: insertErr } = await (this.supabase as any)
      .from('poll_votes')
      .insert({
        poll_id: pollId,
        option_id: optionId,
        user_id: userId,
      });

    if (insertErr) {
      if ((insertErr as { code?: string }).code === '23505') {
        await buttonInteraction.reply({ content: 'You already voted for this option!', ephemeral: true });
        return;
      }
      log.error('poll_votes insert error:', insertErr);
      await buttonInteraction.reply({ content: '❌ Failed to record vote — please try again.', ephemeral: true });
      return;
    }

    getQuestsManager()?.trackProgress(buttonInteraction.guildId!, userId, 'poll_vote').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    await buttonInteraction.reply({ content: '✅ Vote recorded!', ephemeral: true });
  }

  async closePoll(interaction: ChatInputCommandInteraction, pollId: string): Promise<void> {
    const { data: poll } = await (this.supabase as any)
      .from('polls')
      .select('*')
      .eq('id', pollId)
      .single();

    if (!poll) {
      await interaction.reply({ content: '❌ Poll not found.', ephemeral: true });
      return;
    }

    if (poll.creator_user_id !== interaction.user.id) {
      await interaction.reply({ content: '❌ Only the poll creator can close it.', ephemeral: true });
      return;
    }

    // V47-L2: gate the status flip on the current status so concurrent /poll close
    // (or a retry after a deferred reply) cannot reset closed_at or re-post results.
    const { data: closedRows } = await (this.supabase as any)
      .from('polls')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', pollId)
      .eq('status', 'open')
      .select('id');

    if (!closedRows || closedRows.length === 0) {
      await interaction.reply({ content: '❌ Poll is already closed.', ephemeral: true });
      return;
    }

    // Get results
    const { data: options } = await (this.supabase as any)
      .from('poll_options')
      .select('*')
      .eq('poll_id', pollId)
      .order('sort_order');

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const results: string[] = [];

    for (let i = 0; i < (options ?? []).length; i++) {
      const opt = options[i];
      const { count } = await (this.supabase as any)
        .from('poll_votes')
        .select('*', { count: 'exact', head: true })
        .eq('option_id', opt.id);
      results.push(`${numberEmojis[i]} **${opt.label}** — ${count ?? 0} votes`);
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`📊 Poll Closed: ${poll.title}`)
        .setDescription(results.join('\n'))
        .setColor(0x57F287)],
    });
  }

  // ── Predictions ─────────────────────────────────────────

  async createPrediction(
    interaction: ChatInputCommandInteraction,
    title: string,
    options: string[],
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);

    if (!config?.predictions_enabled) {
      await interaction.reply({ content: '❌ Predictions are not enabled on this server.', ephemeral: true });
      return;
    }

    if (options.length < 2 || options.length > 10) {
      await interaction.reply({ content: '❌ Predictions need 2-10 outcomes.', ephemeral: true });
      return;
    }

    const { data: prediction } = await (this.supabase as any)
      .from('predictions')
      .insert({
        guild_id: guildId,
        channel_id: interaction.channelId,
        creator_user_id: interaction.user.id,
        title,
      })
      .select()
      .single();

    if (!prediction) {
      await interaction.reply({ content: '❌ Failed to create prediction.', ephemeral: true });
      return;
    }

    const optionRows = options.map((label, i) => ({
      prediction_id: prediction.id,
      label,
      sort_order: i,
    }));

    const { data: insertedOptions } = await (this.supabase as any)
      .from('prediction_options')
      .insert(optionRows)
      .select();

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    const embed = new EmbedBuilder()
      .setTitle(`🔮 ${title}`)
      .setDescription(
        (insertedOptions ?? []).map((opt: any, i: number) =>
          `${numberEmojis[i]} **${opt.label}** — 0 coins bet`
        ).join('\n') +
        `\n\n💰 Total pool: **0** coins\n*Use /predict bet to place your bet!*`
      )
      .setColor(0x9B59B6)
      .setFooter({ text: `Prediction ID: ${prediction.id}` });

    await interaction.reply({ embeds: [embed] });

    const reply = await interaction.fetchReply();
    await (this.supabase as any)
      .from('predictions')
      .update({ message_id: reply.id })
      .eq('id', prediction.id);
  }

  async placeBet(
    interaction: ChatInputCommandInteraction,
    predictionId: string,
    optionIndex: number,
    amount: number,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const { data: prediction } = await (this.supabase as any)
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (!prediction || prediction.status !== 'open') {
      await interaction.reply({ content: '❌ Prediction is not open for bets.', ephemeral: true });
      return;
    }

    // Check for existing bet
    const { data: existingBet } = await (this.supabase as any)
      .from('prediction_bets')
      .select('id')
      .eq('prediction_id', predictionId)
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (existingBet) {
      await interaction.reply({ content: '❌ You already placed a bet on this prediction.', ephemeral: true });
      return;
    }

    // Get option
    const { data: options } = await (this.supabase as any)
      .from('prediction_options')
      .select('*')
      .eq('prediction_id', predictionId)
      .order('sort_order');

    if (!options || optionIndex >= options.length) {
      await interaction.reply({ content: '❌ Invalid option number.', ephemeral: true });
      return;
    }

    // Check balance
    const { data: wallet } = await (this.supabase as any)
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();

    if (!wallet || wallet.wallet < amount) {
      await interaction.reply({ content: '❌ Insufficient balance.', ephemeral: true });
      return;
    }

    // V47-M2: Insert the bet FIRST so the UNIQUE(prediction_id, user_id)
    // constraint is the authoritative gate. Only debit after the row is owned
    // by this user — otherwise a concurrent /predict bet from the same user
    // would silently consume their coins on the losing race.
    const { data: insertedBet, error: insertErr } = await (this.supabase as any)
      .from('prediction_bets')
      .insert({
        prediction_id: predictionId,
        option_id: options[optionIndex].id,
        guild_id: guildId,
        user_id: userId,
        amount,
      })
      .select('id')
      .single();

    if (insertErr || !insertedBet) {
      // Duplicate bet from a concurrent invocation, or insert failure.
      // We have NOT debited yet, so there is nothing to roll back.
      const msg = (insertErr as { code?: string } | null)?.code === '23505'
        ? '❌ You already placed a bet on this prediction.'
        : '❌ Failed to place bet — please try again.';
      await interaction.reply({ content: msg, ephemeral: true });
      return;
    }

    // Deduct balance — bet is already locked in.
    const { error: debitErr } = await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: amount,
    });
    if (debitErr) {
      // Roll back the bet so we don't credit the user with a free bet.
      await (this.supabase as any)
        .from('prediction_bets')
        .delete()
        .eq('id', insertedBet.id);
      await interaction.reply({ content: `❌ Payment failed — you need **${amount.toLocaleString()}** coins.`, ephemeral: true });
      return;
    }

    // V48-C1: update pool atomically. The RPC error was previously
    // ignored — if it failed we'd have a bet row + debit on the user
    // but the predictions.total_pool snapshot would be short, and
    // resolvePrediction would under-pay every winner. On failure,
    // refund the user and delete the bet so the books reconcile.
    const { data: newPool, error: poolErr } = await (this.supabase as any).rpc(
      'economy_increment_prediction_pool',
      { p_prediction_id: predictionId, p_amount: amount },
    );
    if (poolErr) {
      log.error('economy_increment_prediction_pool failed:', poolErr.message);
      // Compensate: re-credit and delete the bet so we don't keep a
      // ghost bet that resolvePrediction will try to pay out of a pool
      // that doesn't include it.
      const { error: refundErr } = await (this.supabase as any).rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: amount,
      });
      if (refundErr) {
        log.error('CRITICAL: pool RPC failed AND refund failed — manual reconcile required', {
          predictionId, userId, amount, poolErr: poolErr.message, refundErr: refundErr.message,
        });
      }
      await (this.supabase as any)
        .from('prediction_bets')
        .delete()
        .eq('id', insertedBet.id);
      await interaction.reply({
        content: '❌ Failed to place bet — please try again. Your coins were refunded.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🔮 Bet Placed!')
        .setDescription(
          `You bet **${amount.toLocaleString()}** coins on **${options[optionIndex].label}**.\n` +
          `New pool total: **${(newPool ?? prediction.total_pool + amount).toLocaleString()}** coins`
        )
        .setColor(0x9B59B6)],
    });
  }

  async resolvePrediction(
    interaction: ChatInputCommandInteraction,
    predictionId: string,
    winningIndex: number,
  ): Promise<void> {
    const guildId = interaction.guildId!;

    const { data: prediction } = await (this.supabase as any)
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (!prediction) {
      await interaction.reply({ content: '❌ Prediction not found.', ephemeral: true });
      return;
    }

    if (prediction.creator_user_id !== interaction.user.id) {
      await interaction.reply({ content: '❌ Only the creator can resolve this prediction.', ephemeral: true });
      return;
    }

    const { data: options } = await (this.supabase as any)
      .from('prediction_options')
      .select('*')
      .eq('prediction_id', predictionId)
      .order('sort_order');

    if (!options || winningIndex >= options.length) {
      await interaction.reply({ content: '❌ Invalid winning option.', ephemeral: true });
      return;
    }

    const winningOption = options[winningIndex];

    // V47-C1: atomic status flip. The RPC returns the row's locked
    // total_pool only when the status was still open/locked — otherwise
    // it returns no rows and we bail out without paying anyone. This
    // makes resolve idempotent against concurrent / retried clicks.
    const { data: resolveRows, error: resolveErr } = await (this.supabase as any)
      .rpc('predictions_resolve_atomic', {
        p_prediction_id: predictionId,
        p_winning_option_id: winningOption.id,
      });

    if (resolveErr) {
      await interaction.reply({ content: '❌ Failed to resolve prediction — please try again.', ephemeral: true });
      return;
    }

    const resolved = Array.isArray(resolveRows) ? resolveRows[0] : resolveRows;
    if (!resolved) {
      await interaction.reply({ content: '❌ This prediction has already been resolved or cancelled.', ephemeral: true });
      return;
    }

    const finalTotalPool: number = resolved.total_pool ?? 0;

    // Get all bets (after the status flip — no new bets can land now)
    const { data: allBets } = await (this.supabase as any)
      .from('prediction_bets')
      .select('*')
      .eq('prediction_id', predictionId);

    const allBetsArr = (allBets ?? []) as Array<{
      id: string;
      user_id: string;
      option_id: string;
      amount: number;
      payout: number | null;
    }>;
    const winningBets = allBetsArr.filter((b) => b.option_id === winningOption.id);
    const totalWinnerPool = winningBets.reduce((sum, b) => sum + b.amount, 0);

    // V48-C2: when no one picked the winning option, the previous
    // implementation distributed nothing — every bettor lost their stake
    // and the entire pool evaporated. Refund all unpaid bets at face
    // value so losers don't fund a non-existent winner.
    let refundedCount = 0;
    let payoutCount = 0;
    if (winningBets.length === 0) {
      for (const bet of allBetsArr) {
        if (bet.payout != null) continue;
        const { error: refundErr } = await (this.supabase as any).rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: bet.user_id, p_amount: bet.amount,
        });
        if (refundErr) {
          log.error(`Failed to refund bettor ${bet.user_id} after zero-winner resolve:`, refundErr.message);
          continue;
        }
        await (this.supabase as any)
          .from('prediction_bets')
          .update({ payout: bet.amount })
          .eq('id', bet.id);
        refundedCount++;
      }
    } else {
      // Distribute winnings proportionally
      for (const bet of winningBets) {
        // Skip bets that were already paid (defence-in-depth — should not
        // happen now that the status flip is atomic, but worth the safety net).
        if (bet.payout != null) continue;

        const share = totalWinnerPool > 0 ? bet.amount / totalWinnerPool : 0;
        const payout = Math.floor(finalTotalPool * share);

        const { error: payoutErr } = await (this.supabase as any).rpc('economy_add_balance', {
          p_guild_id: guildId, p_user_id: bet.user_id, p_amount: payout,
        });
        if (payoutErr) {
          log.error(`Failed to pay prediction winner ${bet.user_id}:`, payoutErr.message);
          continue;
        }

        await (this.supabase as any)
          .from('prediction_bets')
          .update({ payout })
          .eq('id', bet.id);
        payoutCount++;
      }
    }

    const summaryLine = winningBets.length === 0
      ? `🔁 No bets on the winning outcome — pool refunded to **${refundedCount}** bettor(s).`
      : `🏆 Winners: **${payoutCount}** player(s)`;

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🔮 Prediction Resolved: ${prediction.title}`)
        .setDescription(
          `✅ Winning outcome: **${winningOption.label}**\n` +
          `💰 Pool: **${finalTotalPool.toLocaleString()}** coins\n` +
          summaryLine
        )
        .setColor(0x57F287)],
    });
  }
}
