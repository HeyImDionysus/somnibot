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
      // Check if already voted
      const { data: existingVote } = await (this.supabase as any)
        .from('poll_votes')
        .select('id')
        .eq('poll_id', pollId)
        .eq('user_id', userId)
        .limit(1)
        .single();

      if (existingVote) {
        await buttonInteraction.reply({ content: 'You already voted! (Single vote poll)', ephemeral: true });
        return;
      }
    }

    // Check if already voted for this option
    const { data: dupeVote } = await (this.supabase as any)
      .from('poll_votes')
      .select('id')
      .eq('poll_id', pollId)
      .eq('option_id', optionId)
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (dupeVote) {
      await buttonInteraction.reply({ content: 'You already voted for this option!', ephemeral: true });
      return;
    }

    await (this.supabase as any).from('poll_votes').insert({
      poll_id: pollId,
      option_id: optionId,
      user_id: userId,
    });

    getQuestsManager()?.trackProgress(buttonInteraction.guildId!, userId, 'poll_vote').catch(() => {});

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

    await (this.supabase as any)
      .from('polls')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', pollId);

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

    // Deduct balance + place bet
    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: amount,
    }).catch(() => {});

    await (this.supabase as any).from('prediction_bets').insert({
      prediction_id: predictionId,
      option_id: options[optionIndex].id,
      guild_id: guildId,
      user_id: userId,
      amount,
    });

    // Update pool
    await (this.supabase as any)
      .from('predictions')
      .update({ total_pool: prediction.total_pool + amount })
      .eq('id', predictionId);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🔮 Bet Placed!')
        .setDescription(
          `You bet **${amount.toLocaleString()}** coins on **${options[optionIndex].label}**.\n` +
          `New pool total: **${(prediction.total_pool + amount).toLocaleString()}** coins`
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

    // Get all bets
    const { data: allBets } = await (this.supabase as any)
      .from('prediction_bets')
      .select('*')
      .eq('prediction_id', predictionId);

    const winningBets = (allBets ?? []).filter((b: any) => b.option_id === winningOption.id);
    const totalWinnerPool = winningBets.reduce((sum: number, b: any) => sum + b.amount, 0);

    // Distribute winnings proportionally
    for (const bet of winningBets) {
      const share = totalWinnerPool > 0 ? bet.amount / totalWinnerPool : 0;
      const payout = Math.floor(prediction.total_pool * share);

      await (this.supabase as any).rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: bet.user_id, p_amount: payout,
      }).catch(() => {});

      await (this.supabase as any)
        .from('prediction_bets')
        .update({ payout })
        .eq('id', bet.id);
    }

    // Close prediction
    await (this.supabase as any)
      .from('predictions')
      .update({
        status: 'resolved',
        winning_option_id: winningOption.id,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', predictionId);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🔮 Prediction Resolved: ${prediction.title}`)
        .setDescription(
          `✅ Winning outcome: **${winningOption.label}**\n` +
          `💰 Pool: **${prediction.total_pool.toLocaleString()}** coins\n` +
          `🏆 Winners: **${winningBets.length}** player(s)`
        )
        .setColor(0x57F287)],
    });
  }
}
