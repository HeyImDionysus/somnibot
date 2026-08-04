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
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { resolveBrandKit, brandKitFromConfig } from '../branding/brand-kit.js';
import { applyBrand, brandedEmbed } from '../branding/branded-embed.js';
import { voice } from '../branding/voice.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Polls');

// ── Module-level state ────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, PollsManager>();

export function registerPollsManager(mgr: PollsManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterPollsManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidatePollsCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

// ── Manager ───────────────────────────────────────────────

export class PollsManager {
  private supabase: SupabaseClient;
  private eventBus: PlatformEventBus;
  private configCache = new Map<string, DbGuildConfig>();

  constructor(supabase: SupabaseClient, eventBus: PlatformEventBus = defaultEventBus) {
    this.supabase = supabase;
    this.eventBus = eventBus;
  }

  clearCache(): void { this.configCache.clear(); }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  // ── Polls ───────────────────────────────────────────────

  async createPoll(
    interaction: ChatInputCommandInteraction,
    title: string,
    options: string[],
    allowMultiple?: boolean,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    const kit = brandKitFromConfig(config, interaction.guild?.name);

    if (!config?.polls_enabled) {
      await interaction.reply({ content: voice(kit.voicePreset, 'disabled', { feature: 'Polls' }), ephemeral: true });
      return;
    }

    const maxOptions = Math.min(10, Math.max(2, Number(config.max_poll_options ?? 10)));
    if (options.length < 2 || options.length > maxOptions) {
      await interaction.reply({ content: `❌ Polls need 2-${maxOptions} options.`, ephemeral: true });
      return;
    }
    const effectiveAllowMultiple = allowMultiple ?? Boolean(config.allow_multiple_default ?? false);

    // Create poll
    const { data: poll } = await this.supabase
      .from('polls')
      .insert({
        guild_id: guildId,
        channel_id: interaction.channelId,
        creator_user_id: interaction.user.id,
        title,
        allow_multiple: effectiveAllowMultiple,
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

    const { data: insertedOptions } = await this.supabase
      .from('poll_options')
      .insert(optionRows)
      .select()
      .limit(1000);

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    const embed = applyBrand(
      new EmbedBuilder()
        .setTitle(`📊 ${title}`)
        .setDescription(
          (insertedOptions ?? []).map((opt: any, i: number) =>
            `${numberEmojis[i]} **${opt.label}** — 0 votes`
          ).join('\n') +
          `\n\n*${effectiveAllowMultiple ? 'Multiple votes allowed' : 'One vote per person'}*`
        )
        .setFooter({ text: `Poll ID: ${poll.id}` }),
      kit,
      { intent: 'info' },
    );

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
    await this.supabase
      .from('polls')
      .update({ message_id: reply.id })
      .eq('id', poll.id);

    this.eventBus.emit('poll.created', guildId, {
      pollId: poll.id,
      title,
      optionCount: options.length,
      allowMultiple: effectiveAllowMultiple,
      creatorId: interaction.user.id,
      channelId: interaction.channelId,
    });
  }

  async handlePollVote(buttonInteraction: ButtonInteraction): Promise<void> {
    const parts = buttonInteraction.customId.split(':');
    if (parts.length < 3) return;
    const pollId = parts[1];
    const optionId = parts[2];
    const userId = buttonInteraction.user.id;

    // Check poll exists and is active
    const { data: poll } = await this.supabase
      .from('polls')
      .select('*')
      .eq('id', pollId)
      .single();

    if (!poll || poll.status !== 'active') {
      await buttonInteraction.reply({ content: 'This poll is closed.', ephemeral: true });
      return;
    }

    if (!poll.allow_multiple) {
      // V50-M3 / switch: single-choice polls let a member MOVE their vote.
      // poll_vote_switch_single atomically removes the user's prior vote on this
      // poll and records the new option, returning the previous option so we can
      // distinguish a first vote, a switch, and a same-option re-click. Doing it
      // in one RPC keeps concurrent clicks race-safe (no read-then-write window).
      const { data: voteRows, error: voteErr } = await this.supabase.rpc('poll_vote_switch_single', {
        p_poll_id: pollId,
        p_option_id: optionId,
        p_user_id: userId,
      });

      if (voteErr) {
        log.error('poll_vote_switch_single RPC error:', voteErr);
        await buttonInteraction.reply({ content: '❌ Failed to record vote — please try again.', ephemeral: true });
        return;
      }

      const row = Array.isArray(voteRows) ? voteRows[0] : voteRows;
      const previousOptionId = (row as { previous_option_id?: string | null } | null)?.previous_option_id ?? null;

      if (previousOptionId === optionId) {
        // Re-clicking the option they already hold — nothing changed.
        await buttonInteraction.reply({ content: 'You already voted for this option!', ephemeral: true });
        return;
      }

      // Only credit a quest on a genuinely new vote, not on a switch.
      if (previousOptionId === null) {
        getQuestsManager(buttonInteraction.guildId ?? undefined)?.trackProgress(buttonInteraction.guildId!, userId, 'poll_vote').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      }
      await buttonInteraction.reply({
        content: previousOptionId === null ? '✅ Vote recorded!' : '🔄 Vote updated!',
        ephemeral: true,
      });
      return;
    }

    // Multi-vote polls: check if already voted for this specific option
    // The uniq_poll_vote_per_option unique index is the authoritative gate.
    const { error: insertErr } = await this.supabase
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

    getQuestsManager(buttonInteraction.guildId ?? undefined)?.trackProgress(buttonInteraction.guildId!, userId, 'poll_vote').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });

    await buttonInteraction.reply({ content: '✅ Vote recorded!', ephemeral: true });
  }

  async closePoll(interaction: ChatInputCommandInteraction, pollId: string): Promise<void> {
    const kit = brandKitFromConfig(await this.getConfig(interaction.guildId!), interaction.guild?.name);
    const { data: poll } = await this.supabase
      .from('polls')
      .select('*')
      .eq('id', pollId)
      .single();

    if (!poll) {
      await interaction.reply({ content: voice(kit.voicePreset, 'not_found', { thing: 'Poll' }), ephemeral: true });
      return;
    }

    if (poll.creator_user_id !== interaction.user.id) {
      await interaction.reply({ content: '❌ Only the poll creator can close it.', ephemeral: true });
      return;
    }

    // V47-L2: gate the status flip on the current status so concurrent /poll close
    // (or a retry after a deferred reply) cannot reset closed_at or re-post results.
    // Polls are created with status 'active' (the polls_status_check enum is
    // {'active','closed'}); gating on a non-existent 'open' status matched zero
    // rows, so /poll close ALWAYS reported "already closed" and never closed a poll.
    const { data: closedRows } = await this.supabase
      .from('polls')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', pollId)
      .eq('status', 'active')
      .select('id')
      .limit(1000);

    if (!closedRows || closedRows.length === 0) {
      await interaction.reply({ content: '❌ Poll is already closed.', ephemeral: true });
      return;
    }

    this.eventBus.emit('poll.closed', poll.guild_id ?? interaction.guildId!, {
      pollId,
      title: poll.title,
      actorId: interaction.user.id,
    });

    // Get results
    const { data: options } = await this.supabase
      .from('poll_options')
      .select('*')
      .eq('poll_id', pollId)
      .order('sort_order')
      .limit(1000);

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const results: string[] = [];

    const safeOptions = options ?? [];
    for (let i = 0; i < safeOptions.length; i++) {
      const opt = safeOptions[i];
      const { count } = await this.supabase
        .from('poll_votes')
        .select('*', { count: 'exact', head: true })
        .eq('option_id', opt.id);
      results.push(`${numberEmojis[i]} **${opt.label}** — ${count ?? 0} votes`);
    }

    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'primary',
        title: `📊 Poll Closed: ${poll.title}`,
        description: results.join('\n'),
      })],
    });
  }

  /**
   * The branded predictions-unavailable degradation notice. Replied when a read
   * the bet path depends on FAILS (a database outage) — never when a read
   * merely finds no row. No bet row is written and no balance moves before the
   * failing read is detected, so "nothing was debited" is always true here. The
   * brand read is itself outage-safe (resolveBrandKit never throws; guild-name
   * fallback).
   */
  private async replyPredictionsUnavailable(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const brandKit = await resolveBrandKit(this.supabase, guildId, { fallbackName: interaction.guild?.name })
      .catch(() => null);
    const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
    const content = `${voice(brandKit?.voicePreset ?? 'default', 'unavailable', { brand: name, feature: 'predictions' })} No bet was placed and nothing was debited.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }

  // ── Predictions ─────────────────────────────────────────

  async createPrediction(
    interaction: ChatInputCommandInteraction,
    title: string,
    options: string[],
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    const kit = brandKitFromConfig(config, interaction.guild?.name);

    if (!config?.predictions_enabled) {
      await interaction.reply({ content: voice(kit.voicePreset, 'disabled', { feature: 'Predictions' }), ephemeral: true });
      return;
    }

    // White-label: use the owner-configured currency name (never the stock 'coins').
    const currency = config?.currency_name ?? 'coins';

    const maxOptions = Math.min(10, Math.max(2, Number(config.max_poll_options ?? 10)));
    if (options.length < 2 || options.length > maxOptions) {
      await interaction.reply({ content: `❌ Predictions need 2-${maxOptions} outcomes.`, ephemeral: true });
      return;
    }

    const { data: prediction } = await this.supabase
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

    const { data: insertedOptions } = await this.supabase
      .from('prediction_options')
      .insert(optionRows)
      .select()
      .limit(1000);

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    const embed = applyBrand(
      new EmbedBuilder()
        .setTitle(`🔮 ${title}`)
        .setDescription(
          (insertedOptions ?? []).map((opt: any, i: number) =>
            `${numberEmojis[i]} **${opt.label}** — 0 ${currency} bet`
          ).join('\n') +
          `\n\n💰 Total pool: **0** ${currency}\n*Use /predict bet to place your bet!*`
        )
        .setFooter({ text: `Prediction ID: ${prediction.id}` }),
      kit,
      { intent: 'info' },
    );

    await interaction.reply({ embeds: [embed] });

    const reply = await interaction.fetchReply();
    await this.supabase
      .from('predictions')
      .update({ message_id: reply.id })
      .eq('id', prediction.id);

    this.eventBus.emit('prediction.created', guildId, {
      predictionId: prediction.id,
      title,
      optionCount: options.length,
      creatorId: interaction.user.id,
      channelId: interaction.channelId,
    });
  }

  async placeBet(
    interaction: ChatInputCommandInteraction,
    predictionId: string,
    optionIndex: number,
    amount: number,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Load the guild's prediction bet limits + currency name (white-label).
    const cfg = await this.getConfig(guildId) as
      | (DbGuildConfig & { prediction_min_bet?: number; prediction_max_bet?: number })
      | null;
    const kit = brandKitFromConfig(cfg, interaction.guild?.name);
    const currency = cfg?.currency_name ?? 'coins';
    const minBet = cfg?.prediction_min_bet ?? 1;
    const maxBet = cfg?.prediction_max_bet ?? 0; // 0 = uncapped

    const { data: prediction, error: predictionErr } = await this.supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    // DEPFAIL fail-soft: a FAILED read (database outage) is not a closed
    // prediction. Replying "not open for bets" would fabricate a state claim
    // from a read that never happened — degrade honestly and touch no money.
    // PGRST116 (zero rows) is the genuine unknown-id case and falls through.
    if (predictionErr && (predictionErr as { code?: string }).code !== 'PGRST116') {
      await this.replyPredictionsUnavailable(interaction);
      return;
    }
    if (!prediction || prediction.status !== 'open') {
      await interaction.reply({ content: '❌ Prediction is not open for bets.', ephemeral: true });
      return;
    }

    // Enforce the owner-tuned bet floor/cap before touching the wallet.
    if (amount < minBet) {
      await interaction.reply({ content: `❌ Minimum bet is **${minBet.toLocaleString()} ${currency}**.`, ephemeral: true });
      return;
    }
    if (maxBet > 0 && amount > maxBet) {
      await interaction.reply({ content: `❌ Maximum bet is **${maxBet.toLocaleString()} ${currency}**.`, ephemeral: true });
      return;
    }

    // Check for existing bet
    const { data: existingBet, error: existingBetErr } = await this.supabase
      .from('prediction_bets')
      .select('id')
      .eq('prediction_id', predictionId)
      .eq('user_id', userId)
      .limit(1)
      .single();

    // A no-existing-bet read surfaces as PGRST116 (healthy). Anything else is a
    // failed read — proceeding could double-bet, so degrade before touching money.
    if (existingBetErr && (existingBetErr as { code?: string }).code !== 'PGRST116') {
      await this.replyPredictionsUnavailable(interaction);
      return;
    }
    if (existingBet) {
      await interaction.reply({ content: '❌ You already placed a bet on this prediction.', ephemeral: true });
      return;
    }

    // Get option
    const { data: options, error: optionsErr } = await this.supabase
      .from('prediction_options')
      .select('*')
      .eq('prediction_id', predictionId)
      .order('sort_order')
      .limit(1000);

    // A failed options read is not an invalid option number — degrade honestly.
    if (optionsErr) {
      await this.replyPredictionsUnavailable(interaction);
      return;
    }
    if (!options || optionIndex >= options.length) {
      await interaction.reply({ content: '❌ Invalid option number.', ephemeral: true });
      return;
    }

    // Check balance
    const { data: wallet, error: walletErr } = await this.supabase
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();

    // A failed wallet read is not a zero balance — "Insufficient balance"
    // during an outage would be a lie about money the bot could not read.
    // PGRST116 (no wallet row) is a genuine zero and falls through.
    if (walletErr && (walletErr as { code?: string }).code !== 'PGRST116') {
      await this.replyPredictionsUnavailable(interaction);
      return;
    }
    if (!wallet || wallet.wallet < amount) {
      await interaction.reply({ content: '❌ Insufficient balance.', ephemeral: true });
      return;
    }

    // Money-layer review (2026-07-26): DEBIT-FIRST. The wallet debit and its
    // prediction_bet ledger row land BEFORE the bet row exists, keyed on a
    // client-generated bet id. A crash between the two steps can only leave a
    // debit whose keyed refund is replay-safe — never a ghost bet row that
    // resolve would pay without the stake ever being taken (the old
    // insert-first order's free-roll / pay-before-debit window). A concurrent
    // duplicate attempt debits and is then refunded through the same key, so
    // no coins are silently consumed on the losing race either.
    const betId = randomUUID();
    const debitArgs = {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: -amount,
      p_type: 'prediction_bet',
      p_request_id: betId,
      p_description: `Prediction bet (${predictionId})`,
    };
    let { data: debitRes, error: debitErr } = await this.supabase.rpc('economy_prediction_settle', debitArgs);
    if (debitErr) {
      // Ambiguous failure — the RPC may have committed before the error
      // surfaced. Re-call with IDENTICAL args: the replay fence makes the
      // probe safe. `replayed: true` (or a fresh settle) proves the debit is
      // committed; a second error confirms nothing was debited.
      const probe = await this.supabase.rpc('economy_prediction_settle', debitArgs);
      if (probe.error) {
        log.error('Prediction bet debit failed (probe confirms not committed):', debitErr.message);
        await interaction.reply({ content: '❌ Failed to place bet — please try again. Nothing was debited.', ephemeral: true });
        return;
      }
      debitRes = probe.data;
      debitErr = null;
    }
    const debitStatus = (debitRes as { status?: string } | null)?.status;
    if (debitStatus === 'insufficient_funds') {
      await interaction.reply({ content: `❌ Payment failed — you need **${amount.toLocaleString()}** ${currency}.`, ephemeral: true });
      return;
    }
    if (debitStatus !== 'settled') {
      // economy_prediction_settle rolls its wallet delta back on every
      // non-'settled' return, so nothing was debited here.
      log.error('Prediction bet debit returned unexpected status:', debitStatus ?? 'none');
      await interaction.reply({ content: '❌ Failed to place bet — please try again. Nothing was debited.', ephemeral: true });
      return;
    }

    // Keyed compensation for the settled debit above. Replay-safe (same
    // request id as the debit) and mutually exclusive with a payout for this
    // bet, so it can never double-credit.
    const refundBetDebit = async (why: string): Promise<boolean> => {
      const { data: refundRes, error: refundErr } = await this.supabase.rpc('economy_prediction_settle', {
        p_guild_id: guildId,
        p_user_id: userId,
        p_amount: amount,
        p_type: 'prediction_refund',
        p_request_id: betId,
        p_description: `Prediction bet refund — ${why} (${predictionId})`,
      });
      const refundStatus = (refundRes as { status?: string } | null)?.status;
      if (refundErr || refundStatus !== 'settled') {
        log.error('CRITICAL: prediction bet debit could not be refunded — manual reconcile required', {
          predictionId, userId, amount, betId, why,
          refundErr: refundErr?.message ?? `status ${refundStatus ?? 'none'}`,
        });
        return false;
      }
      return true;
    };

    // Compensation for an UNCONFIRMED prediction_place_bet — the RPC may have
    // committed (bet row + total_pool increment) before its response was
    // lost. prediction_unplace_bet resolves the ambiguity atomically under
    // the same predictions row lock resolve takes:
    //   'removed'   → the insert HAD committed; the row AND its total_pool
    //                 contribution are gone in one transaction, so the keyed
    //                 refund makes the member whole without inflating the pot
    //                 (the old raw-delete compensation left the stake in
    //                 total_pool for winners to split — minting the stake).
    //   'not_found' → the insert never landed (or a retried compensation
    //                 already removed it); the stake never entered a live
    //                 pool. The debit was PROVEN committed above (the flow
    //                 only reaches the place call after debitStatus ===
    //                 'settled'), and the keyed refund IS the ledger probe:
    //                 economy_prediction_settle credits only while no
    //                 payout/refund row exists for this bet id, replays its
    //                 own refund idempotently, and refuses with
    //                 'conflicting_settlement' if a payout already landed.
    //   'closed'    → the insert committed AND the prediction left 'open':
    //                 resolve's pool snapshot includes this stake and its
    //                 settlement loop will settle the bet row like any other.
    //                 NO refund — a compensation refund next to the winners'
    //                 split of a pool still containing this stake would mint
    //                 exactly the stake. The resolver owns this bet now.
    const compensateUnconfirmedPlace = async (why: string): Promise<void> => {
      const unplaceArgs = {
        p_guild_id: guildId,
        p_prediction_id: predictionId,
        p_bet_id: betId,
      };
      let { data: unplaceRes, error: unplaceErr } = await this.supabase.rpc('prediction_unplace_bet', unplaceArgs);
      if (unplaceErr) {
        // Idempotent RPC — probe once with identical args.
        const probe = await this.supabase.rpc('prediction_unplace_bet', unplaceArgs);
        if (probe.error) {
          // We cannot learn whether the stake is in the pool. A blind refund
          // here could mint (committed place + later resolve), so freeze and
          // page instead of guessing with money.
          log.error('CRITICAL: prediction_unplace_bet failed twice — bet state unknown, NOT refunding; manual reconcile required', {
            predictionId, userId, betId, amount, why,
            firstError: unplaceErr.message, probeError: probe.error.message,
          });
          await interaction.reply({
            content: '❌ Something went wrong placing this bet and it could not be automatically reversed — the team has been alerted.',
            ephemeral: true,
          });
          return;
        }
        unplaceRes = probe.data;
        unplaceErr = null;
      }
      const unplaced = unplaceRes as { status?: string; amount?: number } | null;
      if (unplaced?.status === 'removed' || unplaced?.status === 'not_found') {
        const refunded = await refundBetDebit(`${why} (unplace: ${unplaced.status})`);
        await interaction.reply({
          content: refunded
            ? `❌ Failed to place bet — please try again. Your ${currency} were refunded.`
            : '❌ Failed to place bet — the refund could not be confirmed and the team has been alerted.',
          ephemeral: true,
        });
        return;
      }
      if (unplaced?.status === 'closed') {
        // The bet stands: the stake is inside the snapshotted pool and the
        // resolver will settle this row. Loud marker for reconciliation —
        // nobody may hand-refund this bet id.
        log.error('CRITICAL: unconfirmed bet HAD committed and the prediction closed before compensation — the resolver settles this bet; do NOT refund it manually', {
          predictionId, userId, betId, amount, why,
        });
        await interaction.reply({
          content: '⚠️ Your bet was placed just before this prediction closed. It is locked in and will be settled with the prediction\'s outcome.',
          ephemeral: true,
        });
        return;
      }
      // Unknown status — same freeze-and-page as the double error: without
      // knowing whether the stake is pooled, any refund could mint.
      log.error('CRITICAL: prediction_unplace_bet returned unexpected status — bet state unknown, NOT refunding; manual reconcile required', {
        predictionId, userId, betId, amount, why, status: unplaced?.status ?? 'none',
      });
      await interaction.reply({
        content: '❌ Something went wrong placing this bet and it could not be automatically reversed — the team has been alerted.',
        ephemeral: true,
      });
    };

    // Closed-state fence at the money layer: prediction_place_bet inserts the
    // bet row AND increments total_pool in ONE transaction, conditional on
    // the prediction still being 'open' under the same row lock
    // predictions_resolve_atomic takes. If the prediction resolved between
    // the debit and here, the fence reports 'closed' and the debit is
    // refunded through the key. Idempotent on p_bet_id, so a transport error
    // is probed by re-calling with identical args.
    const placeArgs = {
      p_bet_id: betId,
      p_prediction_id: predictionId,
      p_option_id: options[optionIndex].id,
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    };
    let { data: placeRes, error: placeErr } = await this.supabase.rpc('prediction_place_bet', placeArgs);
    if (placeErr) {
      const probe = await this.supabase.rpc('prediction_place_bet', placeArgs);
      if (probe.error) {
        // Still ambiguous — the insert may or may not have committed.
        // prediction_unplace_bet settles the question atomically (delete +
        // pool decrement while open; 'closed' when the resolver owns the
        // stake) and the refund only follows the statuses where the stake is
        // provably NOT in a pool a resolver will pay from.
        log.error('prediction_place_bet failed twice — compensating:', placeErr.message);
        await compensateUnconfirmedPlace('bet insert unconfirmed');
        return;
      }
      placeRes = probe.data;
      placeErr = null;
    }
    const placed = placeRes as { status?: string; new_pool?: number } | null;

    if (placed?.status === 'duplicate') {
      // A concurrent bet from the same member raced past the pre-check; the
      // fence refused this row, so hand the settled debit back.
      await refundBetDebit('duplicate bet');
      await interaction.reply({ content: '❌ You already placed a bet on this prediction. This attempt was refunded.', ephemeral: true });
      return;
    }
    if (placed?.status === 'closed' || placed?.status === 'not_found') {
      // The prediction resolved (or vanished) between the debit and the
      // fence — compensate the debit and tell the member honestly.
      const refunded = await refundBetDebit('prediction closed before bet landed');
      await interaction.reply({
        content: refunded
          ? `❌ This prediction just closed — your bet was not placed and your ${currency} were refunded.`
          : '❌ This prediction just closed — your bet was not placed, but the refund could not be confirmed and the team has been alerted.',
        ephemeral: true,
      });
      return;
    }
    if (placed?.status !== 'inserted') {
      // Unknown status: we cannot tell whether the row landed. Same
      // compensation as the twice-failed path — prediction_unplace_bet
      // resolves the ambiguity atomically and gates the refund on it.
      log.error('prediction_place_bet returned unexpected status:', placed?.status ?? 'none');
      await compensateUnconfirmedPlace('unexpected place_bet status');
      return;
    }

    const newPool = placed.new_pool ?? prediction.total_pool + amount;

    this.eventBus.emit('prediction.bet_placed', guildId, {
      predictionId,
      userId,
      optionId: options[optionIndex].id,
      amount,
      newPool,
    });

    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'info',
        title: '🔮 Bet Placed!',
        description:
          `You bet **${amount.toLocaleString()}** ${currency} on **${options[optionIndex].label}**.\n` +
          `New pool total: **${newPool.toLocaleString()}** ${currency}`,
      })],
    });
  }

  async resolvePrediction(
    interaction: ChatInputCommandInteraction,
    predictionId: string,
    winningIndex: number,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    // White-label: resolve the configured currency name for the result embed.
    const resolveCfg = await this.getConfig(guildId);
    const currency = resolveCfg?.currency_name ?? 'coins';
    const kit = brandKitFromConfig(resolveCfg, interaction.guild?.name);

    const { data: prediction } = await this.supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (!prediction) {
      await interaction.reply({ content: voice(kit.voicePreset, 'not_found', { thing: 'Prediction' }), ephemeral: true });
      return;
    }

    if (prediction.creator_user_id !== interaction.user.id) {
      await interaction.reply({ content: '❌ Only the creator can resolve this prediction.', ephemeral: true });
      return;
    }

    const { data: options } = await this.supabase
      .from('prediction_options')
      .select('*')
      .eq('prediction_id', predictionId)
      .order('sort_order')
      .limit(1000);

    if (!options || winningIndex >= options.length) {
      await interaction.reply({ content: '❌ Invalid winning option.', ephemeral: true });
      return;
    }

    const winningOption = options[winningIndex];

    // V47-C1: atomic status flip. The RPC returns the row's locked
    // total_pool only when the status was still open/locked — otherwise
    // it returns no rows and we bail out without paying anyone. This
    // makes resolve idempotent against concurrent / retried clicks.
    const { data: resolveRows, error: resolveErr } = await this.supabase
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
      // Already resolved: instead of a bare "already resolved" reply, re-drive
      // any stranded settlements (review #4) — bets whose payout marker is
      // still NULL after a crashed or partially-failed earlier run.
      await this.redriveResolvedPrediction(interaction, predictionId, options, currency);
      return;
    }

    const finalTotalPool: number = resolved.total_pool ?? 0;

    const { payoutCount, refundedCount, winnersExist } = await this.settleResolvedBets(
      guildId,
      predictionId,
      winningOption.id,
      finalTotalPool,
    );

    const summaryLine = !winnersExist
      ? `🔁 No bets on the winning outcome — pool refunded to **${refundedCount}** bettor(s).`
      : `🏆 Winners: **${payoutCount}** player(s)`;

    this.eventBus.emit('prediction.resolved', guildId, {
      predictionId,
      title: prediction.title,
      winningOptionId: winningOption.id,
      totalPool: finalTotalPool,
      payoutCount,
      refundedCount,
      actorId: interaction.user.id,
    });

    await interaction.reply({
      embeds: [brandedEmbed(kit, {
        intent: 'primary',
        title: `🔮 Prediction Resolved: ${prediction.title}`,
        description:
          `✅ Winning outcome: **${winningOption.label}**\n` +
          `💰 Pool: **${finalTotalPool.toLocaleString()}** ${currency}\n` +
          summaryLine,
      })],
    });
  }

  /**
   * Settlement loop for a resolved prediction: pay every winning bet whose
   * payout marker is NULL, or — when nobody picked the winner — refund every
   * unpaid bet at face value (V48-C2: losers must not fund a non-existent
   * winner). economy_prediction_settle credits AND writes the ledger row
   * atomically (request_id = bet id), so a re-run loop cannot double-pay.
   *
   * Counts are HONEST (review #4): a settle the RPC reports as `replayed`
   * moved no money NOW (an earlier run already paid it; only its marker
   * write was lost), so it neither increments the counters nor rewrites the
   * marker. `conflicting_settlement` (the bet already settled the OTHER way)
   * is a clean skip. Per-bet RPC errors leave the marker NULL so a later
   * /predict resolve re-drive finds them.
   */
  private async settleResolvedBets(
    guildId: string,
    predictionId: string,
    winningOptionId: string,
    finalTotalPool: number,
  ): Promise<{ payoutCount: number; refundedCount: number; winnersExist: boolean }> {
    const { data: allBets } = await this.supabase
      .from('prediction_bets')
      .select('*')
      .eq('prediction_id', predictionId)
      .limit(1000);

    const allBetsArr = (allBets ?? []) as Array<{
      id: string;
      user_id: string;
      option_id: string;
      amount: number;
      payout: number | null;
    }>;
    const winningBets = allBetsArr.filter((b) => b.option_id === winningOptionId);
    const totalWinnerPool = winningBets.reduce((sum, b) => sum + b.amount, 0);

    let refundedCount = 0;
    let payoutCount = 0;

    const settleOne = async (
      bet: { id: string; user_id: string; amount: number },
      creditAmount: number,
      type: 'prediction_payout' | 'prediction_refund',
      description: string,
    ): Promise<boolean> => {
      const { data: res, error: err } = await this.supabase.rpc('economy_prediction_settle', {
        p_guild_id: guildId,
        p_user_id: bet.user_id,
        p_amount: creditAmount,
        p_type: type,
        p_request_id: bet.id,
        p_description: description,
      });
      if (err) {
        // Marker stays NULL — the next resolve re-drive retries this bet.
        log.error(`Failed to settle bet ${bet.id} (${type}) for ${bet.user_id}:`, err.message);
        return false;
      }
      const settled = res as { status?: string; replayed?: boolean } | null;
      if (settled?.status === 'conflicting_settlement') {
        log.warn(`Bet ${bet.id} was already settled the other way — skipping ${type}.`);
        return false;
      }
      if (settled?.status !== 'settled') {
        log.error(`Unexpected settle status for bet ${bet.id} (${type}):`, settled?.status ?? 'none');
        return false;
      }
      if (settled.replayed === true) {
        // An earlier run moved this money; no fresh settlement to count and
        // no marker to rewrite.
        return false;
      }
      const { error: markErr } = await this.supabase
        .from('prediction_bets')
        .update({ payout: creditAmount })
        .eq('id', bet.id);
      if (markErr) {
        // Money moved; the missing marker only means the next re-drive
        // re-verifies this bet (and replays harmlessly).
        log.error(`Failed to write payout marker for bet ${bet.id}:`, markErr.message);
      }
      return true;
    };

    if (winningBets.length === 0) {
      for (const bet of allBetsArr) {
        if (bet.payout != null) continue;
        if (await settleOne(bet, bet.amount, 'prediction_refund', `Prediction refund — no winning bets (${predictionId})`)) {
          refundedCount++;
        }
      }
    } else {
      for (const bet of winningBets) {
        if (bet.payout != null) continue;
        const share = totalWinnerPool > 0 ? bet.amount / totalWinnerPool : 0;
        const payout = Math.floor(finalTotalPool * share);
        if (await settleOne(bet, payout, 'prediction_payout', `Prediction payout (${predictionId})`)) {
          payoutCount++;
        }
      }
    }

    return { payoutCount, refundedCount, winnersExist: winningBets.length > 0 };
  }

  /**
   * Review #4 — re-drive stranded winners. /predict resolve on an ALREADY-
   * resolved prediction re-runs the settlement loop for bets whose payout
   * marker is still NULL instead of replying "already resolved". The per-bet
   * replay keys make re-paying a settled bet impossible, so the re-drive can
   * only move money that never moved. Uses the STORED winning option — the
   * outcome was fixed at first resolution and a re-run may not change it.
   */
  private async redriveResolvedPrediction(
    interaction: ChatInputCommandInteraction,
    predictionId: string,
    options: Array<{ id: string; label: string }>,
    currency: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const { data: current, error: currentErr } = await this.supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (currentErr || !current || current.status !== 'resolved' || !current.winning_option_id) {
      // Cancelled, unreadable, or racing — nothing safe to re-drive.
      await interaction.reply({ content: '❌ This prediction has already been resolved or cancelled.', ephemeral: true });
      return;
    }

    const winningOptionId: string = current.winning_option_id;
    const totalPool: number = current.total_pool ?? 0;
    const winningOption = options.find((opt) => opt.id === winningOptionId);

    const { payoutCount, refundedCount } = await this.settleResolvedBets(
      guildId,
      predictionId,
      winningOptionId,
      totalPool,
    );

    if (payoutCount + refundedCount === 0) {
      await interaction.reply({
        content: '✅ This prediction is already resolved and every bet is settled — nothing to re-drive.',
        ephemeral: true,
      });
      return;
    }

    this.eventBus.emit('prediction.resolved', guildId, {
      predictionId,
      title: current.title,
      winningOptionId,
      totalPool,
      payoutCount,
      refundedCount,
      actorId: interaction.user.id,
      redrive: true,
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🔮 Prediction Re-Settled: ${current.title}`)
        .setDescription(
          `This prediction was already resolved${winningOption ? ` (winner: **${winningOption.label}**)` : ''} — ` +
          `stranded settlements were re-driven.\n` +
          `💰 Pool: **${totalPool.toLocaleString()}** ${currency}\n` +
          `🏆 Paid now: **${payoutCount}** · 🔁 Refunded now: **${refundedCount}**`
        )
        .setColor(0x57F287)],
    });
  }
}
