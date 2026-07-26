/**
 * TriviaManager — handles trivia rounds with streak bonuses,
 * difficulty scaling, category support, and custom question packs.
 */
import { randomPick, cryptoShuffle } from '../../utils/random.js';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig, TriviaDifficulty, TriviaQuestionContent } from '@somnibot/shared';
import { BUILT_IN_TRIVIA_QUESTIONS } from '@somnibot/shared';
import type { Redis } from 'iovalkey';
import { randomUUID } from 'node:crypto';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import { eventBus } from '../../services/event-bus.js';
import { resolveBrandKit } from '../branding/brand-kit.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';

const log = createLogger('Trivia');

// ── Module-level state ────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, TriviaManager>();

export function registerTriviaManager(mgr: TriviaManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterTriviaManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateTriviaCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

// ── Built-in question pool ────────────────────────────────

// The bank itself lives in @somnibot/shared so the dashboard can render the
// same built-ins the bot serves. Custom questions mapped from the DB share
// the same content shape.
type TriviaQuestion = TriviaQuestionContent;

const DIFFICULTY_MULTIPLIERS: Record<TriviaDifficulty, number> = { easy: 1, medium: 1.5, hard: 2 };

// ── Active rounds tracking ────────────────────────────────

/**
 * Editor for the round's message surface. Both entrypoints resolve a round the
 * same way — the only difference is WHERE the question was posted:
 *   - `/trivia start` posts via the slash reply, so `edit` is `interaction.editReply`;
 *   - a hosted/scheduled round posts via `channel.send`, so `edit` is `message.edit`.
 * `endRound` is fully interaction-agnostic: it drives whichever editor is attached.
 */
type RoundEditor = (payload: { embeds: EmbedBuilder[]; components: never[] }) => Promise<unknown>;

interface ActiveRound {
  question: TriviaQuestion;
  answers: Map<string, number>; // userId → chosen index
  correctIndex: number;
  shuffled: string[];
  timeout: ReturnType<typeof setTimeout>;
  guildId: string;
  /**
   * Stable identity of this round, minted once at round start (X2/39). It keys
   * the payout idempotency fence trivia:${roundId}:${userId} shared by the
   * primary economy_add_balance credit AND the bot_action_queue retry, so a
   * retry after a partial success can never double-pay a winner. A uuid — the
   * channelId+timestamp pair is NOT stable across restarts/redeliveries.
   */
  roundId: string;
  /** Discord guild for owner-alert delivery; null when unresolvable. */
  guild: Guild | null;
  edit: RoundEditor;
}

// ── Manager ───────────────────────────────────────────────

export class TriviaManager {
  private supabase: SupabaseClient;
  private valkey: Redis;
  private configCache = new Map<string, DbGuildConfig>();
  private customQuestionCache = new Map<string, TriviaQuestion[]>();
  private activeRounds = new Map<string, ActiveRound>(); // channelId → round

  constructor(supabase: SupabaseClient, valkey?: Redis) {
    this.supabase = supabase;
    this.valkey = valkey as Redis;
  }

  /** Stop all active trivia rounds — called on shutdown */
  stopAll(): void {
    for (const [, round] of this.activeRounds) {
      clearTimeout(round.timeout);
    }
    this.activeRounds.clear();
  }

  clearCache(): void {
    this.configCache.clear();
    this.customQuestionCache.clear();
  }

  /**
   * Read the guild config (cached). `degraded` is true only when the read FAILED
   * (e.g. a database outage) as opposed to genuinely finding no row (PGRST116) —
   * callers must not present a failed read as "trivia is not enabled".
   */
  private async getConfigChecked(
    guildId: string,
  ): Promise<{ config: DbGuildConfig | null; degraded: boolean }> {
    const cached = this.configCache.get(guildId);
    if (cached) return { config: cached, degraded: false };
    const { data, error } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return { config: data, degraded: error != null && error.code !== 'PGRST116' };
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    return (await this.getConfigChecked(guildId)).config;
  }

  /**
   * [game-economy-trivia DEPFAIL] Branded degradation notice for a dependency
   * outage. With the database unreachable a round must NOT open ("no question
   * embed posts") — a round opened blind could not read the owner's custom pack
   * and could not be paid/settled honestly. The brand lookup is itself
   * outage-safe (resolveBrandKit never throws; belt-and-braces .catch).
   */
  private async replyTriviaUnavailable(interaction: ChatInputCommandInteraction): Promise<void> {
    const brandKit = await resolveBrandKit(this.supabase, interaction.guildId!, {
      fallbackName: interaction.guild?.name,
    }).catch(() => null);
    const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
    const content = `⚠️ ${name}'s trivia is temporarily unavailable — please try again in a moment. No round was started and your streak is safe.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * The owner's custom question pack. `degraded` is true only when the read
   * FAILED — and a failed read is NEVER cached: caching the empty fallback would
   * permanently drop the owner's pack from every later round (silent pool
   * corruption persisting past the outage).
   */
  private async getCustomQuestions(
    guildId: string,
  ): Promise<{ questions: TriviaQuestion[]; degraded: boolean }> {
    const cached = this.customQuestionCache.get(guildId);
    if (cached) return { questions: cached, degraded: false };
    const { data, error } = await this.supabase
      .from('economy_trivia_questions')
      .select('*')
      .eq('guild_id', guildId)
      .limit(1000);
    const questions: TriviaQuestion[] = (data ?? []).map((q: any) => ({
      question: q.question,
      correct: q.correct_answer,
      wrong: q.wrong_answers ?? [],
      category: q.category,
      difficulty: q.difficulty as TriviaDifficulty,
    }));
    if (!error) this.customQuestionCache.set(guildId, questions);
    return { questions, degraded: error != null };
  }

  /** Retrieve the trivia streak for a user (persisted in Valkey, survives restarts) */
  private async getStreak(guildId: string, userId: string): Promise<number> {
    const val = await this.valkey.get(`trivia:streak:${guildId}:${userId}`);
    return val ? parseInt(val) : 0;
  }

  /** Persist the trivia streak (TTL: 24h — streaks expire after a day of inactivity) */
  private async setStreak(guildId: string, userId: string, val: number): Promise<void> {
    await this.valkey.set(`trivia:streak:${guildId}:${userId}`, String(val), 'EX', 86400);
  }

  /**
   * Build the served question pool for a guild (built-ins + custom pack) and
   * pick one, honoring an optional category / difficulty filter. A filter that
   * would empty the pool is ignored (falls back to the unfiltered pool) so a
   * hosted schedule pinned to a category with no matching custom question still
   * runs from the built-ins.
   */
  private async selectQuestion(
    guildId: string,
    category?: string,
    difficulty?: TriviaDifficulty,
  ): Promise<TriviaQuestion | null> {
    const { questions: customQuestions, degraded } = await this.getCustomQuestions(guildId);
    // A failed pack read means the pool cannot honestly be built (the owner's
    // custom questions are unreadable, not absent) — callers degrade, never
    // silently serve a built-ins-only round during an outage.
    if (degraded) return null;
    let pool = [...BUILT_IN_TRIVIA_QUESTIONS, ...customQuestions];

    if (category) {
      const filtered = pool.filter((q) => q.category.toLowerCase() === category.toLowerCase());
      if (filtered.length > 0) pool = filtered;
    }
    if (difficulty) {
      const filtered = pool.filter((q) => q.difficulty === difficulty);
      if (filtered.length > 0) pool = filtered;
    }

    return randomPick(pool);
  }

  /**
   * Shuffle the answers and build the question embed + answer-button row for a
   * channel. The button customIds encode the channelId so `handleAnswer` routes
   * a press back to the round in that channel — identical for command-driven and
   * hosted rounds.
   */
  private buildRoundSurface(
    channelId: string,
    question: TriviaQuestion,
    hosted: boolean,
  ): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder>; correctIndex: number; shuffled: string[] } {
    const allAnswers = cryptoShuffle([question.correct, ...question.wrong]);
    const correctIndex = allAnswers.indexOf(question.correct);

    const labels = ['🅰️', '🅱️', '🅲', '🅳'];
    const embed = new EmbedBuilder()
      .setTitle(hosted ? '🎉 Hosted Trivia!' : '🧠 Trivia Time!')
      .setDescription(
        `**${question.question}**\n\n` +
        allAnswers.map((a, i) => `${labels[i]} ${a}`).join('\n') +
        `\n\n*Difficulty: ${question.difficulty.toUpperCase()} • Category: ${question.category}*\n*You have 20 seconds to answer!*`
      )
      .setColor(0x5865F2);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      allAnswers.map((_, i) =>
        new ButtonBuilder()
          .setCustomId(`trivia:${channelId}:${i}`)
          .setLabel(labels[i])
          .setStyle(ButtonStyle.Secondary)
      )
    );

    return { embed, row, correctIndex, shuffled: allAnswers };
  }

  /**
   * Per-channel cooldown ("breather") probe. Returns the seconds remaining on the
   * breather, or 0 when it is absent/expired or Valkey is unavailable. The window
   * is owner-tunable via economy_trivia_cooldown_seconds and is opened when a
   * round ends (see endRound), preventing back-to-back payout farming.
   */
  private async cooldownRemaining(guildId: string, channelId: string, cooldownSeconds: number): Promise<number> {
    if (cooldownSeconds <= 0 || !this.valkey) return 0;
    const remaining = await this.valkey.ttl(`trivia:cooldown:${guildId}:${channelId}`);
    return remaining > 0 ? remaining : 0;
  }

  async startRound(
    interaction: ChatInputCommandInteraction,
    category?: string,
    difficulty?: TriviaDifficulty,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.channelId;
    const { config, degraded } = await this.getConfigChecked(guildId);

    // A failed config read is an outage, not "trivia is off" — degrade honestly
    // with the branded unavailable notice and post no round.
    if (degraded) {
      await this.replyTriviaUnavailable(interaction);
      return;
    }
    if (!config?.economy_trivia_enabled) {
      await interaction.reply({ content: '❌ Trivia is not enabled on this server.', ephemeral: true });
      return;
    }

    if (this.activeRounds.has(channelId)) {
      await interaction.reply({ content: '⚠️ A trivia round is already active in this channel!', ephemeral: true });
      return;
    }

    // [game-economy-trivia] Per-channel cooldown ("breather") that prevents
    // payout farming. Guarded on Valkey so a no-Valkey deployment simply skips
    // the breather rather than throwing.
    const cooldownSeconds = config.economy_trivia_cooldown_seconds ?? 30;
    const remaining = await this.cooldownRemaining(guildId, channelId, cooldownSeconds);
    if (remaining > 0) {
      await interaction.reply({ content: `⏳ A trivia round can start again in ${remaining}s.`, ephemeral: true });
      return;
    }

    const question = await this.selectQuestion(guildId, category, difficulty);
    // The pool could not be read (outage) — no question embed posts.
    if (!question) {
      await this.replyTriviaUnavailable(interaction);
      return;
    }
    const { embed, row, correctIndex, shuffled } = this.buildRoundSurface(channelId, question, false);

    await interaction.reply({ embeds: [embed], components: [row] });

    const round: ActiveRound = {
      question,
      answers: new Map(),
      correctIndex,
      shuffled,
      guildId,
      roundId: randomUUID(),
      guild: interaction.guild,
      edit: (payload) => interaction.editReply(payload),
      timeout: setTimeout(() => this.endRound(channelId), 20_000),
    };
    this.activeRounds.set(channelId, round);
  }

  /**
   * Start a hosted / scheduled trivia round in a channel WITHOUT an interaction.
   *
   * This is the entrypoint the TriviaScheduleRunner drives when the owner-scheduled
   * cadence is due. It mirrors startRound's gating (enabled → active → cooldown)
   * but posts the question via `channel.send` and resolves through `message.edit`,
   * so the exact same button-answer + payout lifecycle runs. Returns a structured
   * result (never throws for an expected skip) so the scheduler can log why a hosted
   * round did not open.
   */
  async startScheduledRound(
    guild: Guild,
    channel: TextChannel,
    category?: string,
    difficulty?: TriviaDifficulty,
  ): Promise<{ started: boolean; reason?: string }> {
    const guildId = guild.id;
    const channelId = channel.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_trivia_enabled) return { started: false, reason: 'trivia_disabled' };
    if (this.activeRounds.has(channelId)) return { started: false, reason: 'round_active' };

    const cooldownSeconds = config.economy_trivia_cooldown_seconds ?? 30;
    const remaining = await this.cooldownRemaining(guildId, channelId, cooldownSeconds);
    if (remaining > 0) return { started: false, reason: 'cooldown' };

    const question = await this.selectQuestion(guildId, category, difficulty);
    // The pool could not be read (outage) — skip this hosted tick; the next
    // scheduled tick retries against a healthy database.
    if (!question) return { started: false, reason: 'question_pool_unavailable' };
    const { embed, row, correctIndex, shuffled } = this.buildRoundSurface(channelId, question, true);

    let edit: RoundEditor;
    try {
      // Post the hosted question to the channel and resolve the round by editing
      // that same message (the command path edits the slash reply instead).
      const message = await channel.send({ embeds: [embed], components: [row] });
      edit = (payload) => message.edit(payload);
    } catch (e: unknown) {
      log.warn('hosted trivia send failed:', (e as Error)?.message ?? e);
      return { started: false, reason: 'send_failed' };
    }

    const round: ActiveRound = {
      question,
      answers: new Map(),
      correctIndex,
      shuffled,
      guildId,
      roundId: randomUUID(),
      guild,
      edit,
      timeout: setTimeout(() => this.endRound(channelId), 20_000),
    };
    this.activeRounds.set(channelId, round);
    return { started: true };
  }

  async handleAnswer(buttonInteraction: ButtonInteraction): Promise<void> {
    const parts = buttonInteraction.customId.split(':');
    if (parts.length < 3) return;
    const channelId = parts[1];
    const choiceIndex = parseInt(parts[2]);

    const round = this.activeRounds.get(channelId);
    if (!round) {
      await buttonInteraction.reply({ content: 'This round has ended!', ephemeral: true });
      return;
    }

    const userId = buttonInteraction.user.id;
    if (round.answers.has(userId)) {
      await buttonInteraction.reply({ content: 'You already answered!', ephemeral: true });
      return;
    }

    round.answers.set(userId, choiceIndex);
    await buttonInteraction.reply({ content: `✅ Answer locked in: ${round.shuffled[choiceIndex]}`, ephemeral: true });
  }

  private async endRound(channelId: string): Promise<void> {
    const round = this.activeRounds.get(channelId);
    if (!round) return;
    this.activeRounds.delete(channelId);
    clearTimeout(round.timeout);

    const guildId = round.guildId;
    const config = await this.getConfig(guildId);

    // [game-economy-trivia] Open the per-channel cooldown breather so the next
    // round in this channel is gated for economy_trivia_cooldown_seconds.
    const cooldownSeconds = config?.economy_trivia_cooldown_seconds ?? 30;
    if (cooldownSeconds > 0 && this.valkey) {
      await this.valkey
        .set(`trivia:cooldown:${guildId}:${channelId}`, '1', 'EX', cooldownSeconds)
        .catch((e: unknown) => { log.warn('trivia cooldown set failed:', (e as Error)?.message ?? e); });
    }

    const basePayout = config?.economy_trivia_base_payout ?? 50;
    const streakMultPct = config?.economy_trivia_streak_multiplier_pct ?? 10;
    const diffMult = DIFFICULTY_MULTIPLIERS[round.question.difficulty] ?? 1;
    const hardMult = round.question.difficulty === 'hard' ? (config?.economy_trivia_hard_multiplier ?? 2) : diffMult;

    // V52-L4: track per-winner payment status so the embed accurately
    // reflects who was actually paid (previously a failed economy_add_balance
    // was only logged, but the embed still showed the user as a winner).
    const winners: Array<{ userId: string; paid: boolean }> = [];
    const losers: string[] = [];
    let totalPaid = 0;

    for (const [userId, choice] of round.answers) {
      if (choice === round.correctIndex) {
        const streak = (await this.getStreak(guildId, userId)) + 1;
        await this.setStreak(guildId, userId, streak);
        const streakBonus = 1 + (streak * streakMultPct) / 100;
        const payout = Math.floor(basePayout * hardMult * streakBonus);

        // Award currency — keyed on trivia:${roundId}:${userId} (X2/39) so the
        // bot_action_queue retry below uses the SAME idempotency key: a retry
        // that runs after this credit actually landed (partial success — e.g.
        // the RPC committed but the response was lost) replays as a no-op
        // instead of paying the winner twice.
        const idempotencyKey = `trivia:${round.roundId}:${userId}`;
        const { error: triviaPayErr } = await this.supabase.rpc('economy_add_balance', {
          p_guild_id: guildId,
          p_user_id: userId,
          p_amount: payout,
          p_idempotency_key: idempotencyKey,
        });
        if (triviaPayErr) {
          log.error(`Failed to pay ${userId}:`, triviaPayErr.message);
          // [game-economy-trivia] Owner alert + operator-retry queue + audit on the
          // failed-winner-payout branch so the owed winner is not silently lost.
          await this.raiseTriviaPayoutAlert(round, userId, payout)
            .catch((e: unknown) => { log.warn('trivia payout alert failed:', (e as Error)?.message ?? e); });
          await Promise.resolve(this.supabase.from('bot_action_queue').insert({
            guild_id: guildId,
            action: 'trivia_payout_retry',
            payload: { user_id: userId, amount: payout, round_id: round.roundId, reason: 'trivia_payout_failed', original_error: triviaPayErr.message },
            status: 'pending',
          })).catch((e: unknown) => { log.warn('trivia payout retry-queue failed:', (e as Error)?.message ?? e); });
          eventBus.emit('trivia.payout_failed', guildId, {
            userId,
            amount: payout,
          });
        } else {
          totalPaid += payout;
        }
        winners.push({ userId, paid: !triviaPayErr });
        getQuestsManager(guildId)?.trackProgress(guildId, userId, 'trivia').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      } else {
        losers.push(userId);
        await this.setStreak(guildId, userId, 0);
      }
    }

    const paidWinners = winners.filter((w) => w.paid);
    const failedWinners = winners.filter((w) => !w.paid);

    // [game-economy-trivia] Append-only audit row for the round-completed state
    // change (winners paid, total payout, participation).
    eventBus.emit('trivia.completed', guildId, {
      channelId,
      answers: round.answers.size,
      winners: winners.length,
      paidWinners: paidWinners.length,
      totalPayout: totalPaid,
    });

    const labels = ['🅰️', '🅱️', '🅲', '🅳'];
    let resultText =
      `**${round.question.question}**\n\n` +
      `✅ Correct Answer: ${labels[round.correctIndex]} **${round.question.correct}**\n\n`;

    if (paidWinners.length > 0) {
      resultText += `🏆 Winners: ${paidWinners.map((w) => `<@${w.userId}>`).join(', ')}\n`;
    }
    if (failedWinners.length > 0) {
      resultText += `⚠️ Correct but payout failed: ${failedWinners.map((w) => `<@${w.userId}>`).join(', ')} — contact an admin\n`;
    }
    if (winners.length === 0) {
      resultText += '😢 Nobody got it right!\n';
    }
    resultText += round.answers.size === 0 ? '💤 Nobody answered...' : `📊 ${round.answers.size} player(s) answered`;

    const embed = new EmbedBuilder()
      .setTitle('🧠 Trivia Results!')
      .setDescription(resultText)
      .setColor(winners.length > 0 ? 0x57F287 : 0xED4245);

    try {
      await round.edit({ embeds: [embed], components: [] });
    } catch {
      // the reply/message may have been deleted or expired
    }
  }

  /**
   * [game-economy-trivia] Raise a payout-failed owner alert when a correct
   * answer's reward credit fails, so an operator knows a winner is still owed
   * their prize (a retry job is queued in bot_action_queue). Delivered via
   * raiseOwnerAlert (row + alert-channel notice); the round carries the Guild.
   * Best effort.
   */
  private async raiseTriviaPayoutAlert(round: ActiveRound, userId: string, amount: number): Promise<void> {
    await raiseOwnerAlert(this.supabase, round.guildId, {
      alertType: 'trivia_payout_failed',
      severity: 'warning',
      title: 'Trivia payout failed',
      message: `A trivia reward of ${amount} failed to credit ${userId}. A retry has been queued.`,
      metadata: { user_id: userId, amount, round_id: round.roundId },
      guild: round.guild,
    });
  }
}
