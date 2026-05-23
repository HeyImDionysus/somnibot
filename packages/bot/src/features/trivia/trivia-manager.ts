/**
 * TriviaManager — handles trivia rounds with streak bonuses,
 * difficulty scaling, category support, and custom question packs.
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
import type { DbGuildConfig, TriviaDifficulty } from '@somnibot/shared';
import type { Redis } from 'iovalkey';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Trivia');

// ── Module-level state ────────────────────────────────────

let _manager: TriviaManager | null = null;
export function registerTriviaManager(mgr: TriviaManager): void { _manager = mgr; }
export function invalidateTriviaCache(): void { _manager?.clearCache(); }

// ── Built-in question pool ────────────────────────────────

interface TriviaQuestion {
  question: string;
  correct: string;
  wrong: string[];
  category: string;
  difficulty: TriviaDifficulty;
}

const BUILT_IN_QUESTIONS: TriviaQuestion[] = [
  { question: 'What planet is known as the Red Planet?', correct: 'Mars', wrong: ['Venus', 'Jupiter', 'Saturn'], category: 'science', difficulty: 'easy' },
  { question: 'What is the chemical symbol for gold?', correct: 'Au', wrong: ['Ag', 'Fe', 'Cu'], category: 'science', difficulty: 'easy' },
  { question: 'In what year did the Titanic sink?', correct: '1912', wrong: ['1905', '1918', '1923'], category: 'history', difficulty: 'medium' },
  { question: 'What is the largest organ in the human body?', correct: 'Skin', wrong: ['Liver', 'Brain', 'Heart'], category: 'science', difficulty: 'easy' },
  { question: 'Which country has the most natural lakes?', correct: 'Canada', wrong: ['USA', 'Russia', 'Brazil'], category: 'geography', difficulty: 'medium' },
  { question: 'What is the speed of light in km/s (approx)?', correct: '300,000', wrong: ['150,000', '500,000', '1,000,000'], category: 'science', difficulty: 'hard' },
  { question: 'Who painted the Mona Lisa?', correct: 'Leonardo da Vinci', wrong: ['Michelangelo', 'Raphael', 'Donatello'], category: 'art', difficulty: 'easy' },
  { question: 'What is the square root of 144?', correct: '12', wrong: ['14', '10', '16'], category: 'math', difficulty: 'easy' },
  { question: 'Which element has the atomic number 1?', correct: 'Hydrogen', wrong: ['Helium', 'Lithium', 'Carbon'], category: 'science', difficulty: 'easy' },
  { question: 'What year was the first iPhone released?', correct: '2007', wrong: ['2005', '2008', '2010'], category: 'technology', difficulty: 'medium' },
  { question: 'What is the capital of Australia?', correct: 'Canberra', wrong: ['Sydney', 'Melbourne', 'Brisbane'], category: 'geography', difficulty: 'medium' },
  { question: 'How many bones are in the adult human body?', correct: '206', wrong: ['198', '212', '220'], category: 'science', difficulty: 'hard' },
  { question: 'What is the longest river in the world?', correct: 'Nile', wrong: ['Amazon', 'Mississippi', 'Yangtze'], category: 'geography', difficulty: 'medium' },
  { question: 'Who wrote "1984"?', correct: 'George Orwell', wrong: ['Aldous Huxley', 'Ray Bradbury', 'H.G. Wells'], category: 'literature', difficulty: 'medium' },
  { question: 'What is the hardest natural substance on Earth?', correct: 'Diamond', wrong: ['Titanium', 'Quartz', 'Sapphire'], category: 'science', difficulty: 'easy' },
  { question: 'In which year did World War II end?', correct: '1945', wrong: ['1944', '1946', '1943'], category: 'history', difficulty: 'easy' },
  { question: 'What is the smallest country in the world?', correct: 'Vatican City', wrong: ['Monaco', 'San Marino', 'Liechtenstein'], category: 'geography', difficulty: 'medium' },
  { question: 'What gas do plants absorb from the atmosphere?', correct: 'Carbon dioxide', wrong: ['Oxygen', 'Nitrogen', 'Hydrogen'], category: 'science', difficulty: 'easy' },
  { question: 'Who developed the theory of relativity?', correct: 'Albert Einstein', wrong: ['Isaac Newton', 'Niels Bohr', 'Max Planck'], category: 'science', difficulty: 'medium' },
  { question: 'What is the deepest ocean trench?', correct: 'Mariana Trench', wrong: ['Tonga Trench', 'Java Trench', 'Puerto Rico Trench'], category: 'geography', difficulty: 'hard' },
];

const DIFFICULTY_MULTIPLIERS: Record<TriviaDifficulty, number> = { easy: 1, medium: 1.5, hard: 2 };

// ── Active rounds tracking ────────────────────────────────

interface ActiveRound {
  question: TriviaQuestion;
  answers: Map<string, number>; // userId → chosen index
  correctIndex: number;
  shuffled: string[];
  timeout: ReturnType<typeof setTimeout>;
}

// ── Manager ───────────────────────────────────────────────

export class TriviaManager {
  private supabase: SupabaseClient;
  private valkey: Redis;
  private configCache = new Map<string, DbGuildConfig>();
  private customQuestionCache = new Map<string, TriviaQuestion[]>();
  private activeRounds = new Map<string, ActiveRound>(); // channelId → round

  constructor(supabase: SupabaseClient, valkey?: Redis) {
    this.supabase = supabase as any;
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

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await (this.supabase as any).from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getCustomQuestions(guildId: string): Promise<TriviaQuestion[]> {
    const cached = this.customQuestionCache.get(guildId);
    if (cached) return cached;
    const { data } = await (this.supabase as any)
      .from('economy_trivia_questions')
      .select('*')
      .eq('guild_id', guildId);
    const questions: TriviaQuestion[] = (data ?? []).map((q: any) => ({
      question: q.question,
      correct: q.correct_answer,
      wrong: q.wrong_answers ?? [],
      category: q.category,
      difficulty: q.difficulty as TriviaDifficulty,
    }));
    this.customQuestionCache.set(guildId, questions);
    return questions;
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

  async startRound(
    interaction: ChatInputCommandInteraction,
    category?: string,
    difficulty?: TriviaDifficulty,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.channelId;
    const config = await this.getConfig(guildId);

    if (!config?.economy_trivia_enabled) {
      await interaction.reply({ content: '❌ Trivia is not enabled on this server.', ephemeral: true });
      return;
    }

    if (this.activeRounds.has(channelId)) {
      await interaction.reply({ content: '⚠️ A trivia round is already active in this channel!', ephemeral: true });
      return;
    }

    // Pick a question
    const customQuestions = await this.getCustomQuestions(guildId);
    let pool = [...BUILT_IN_QUESTIONS, ...customQuestions];

    if (category) {
      const filtered = pool.filter((q) => q.category.toLowerCase() === category.toLowerCase());
      if (filtered.length > 0) pool = filtered;
    }
    if (difficulty) {
      const filtered = pool.filter((q) => q.difficulty === difficulty);
      if (filtered.length > 0) pool = filtered;
    }

    const question = pool[Math.floor(Math.random() * pool.length)];

    // Shuffle answers
    const allAnswers = [question.correct, ...question.wrong];
    for (let i = allAnswers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allAnswers[i], allAnswers[j]] = [allAnswers[j], allAnswers[i]];
    }
    const correctIndex = allAnswers.indexOf(question.correct);

    const labels = ['🅰️', '🅱️', '🅲', '🅳'];
    const embed = new EmbedBuilder()
      .setTitle('🧠 Trivia Time!')
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

    await interaction.reply({ embeds: [embed], components: [row] });

    const round: ActiveRound = {
      question,
      answers: new Map(),
      correctIndex,
      shuffled: allAnswers,
      timeout: setTimeout(() => this.endRound(channelId, interaction), 20_000),
    };
    this.activeRounds.set(channelId, round);
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

  private async endRound(
    channelId: string,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const round = this.activeRounds.get(channelId);
    if (!round) return;
    this.activeRounds.delete(channelId);
    clearTimeout(round.timeout);

    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    const basePayout = config?.economy_trivia_base_payout ?? 50;
    const streakMultPct = config?.economy_trivia_streak_multiplier_pct ?? 10;
    const diffMult = DIFFICULTY_MULTIPLIERS[round.question.difficulty] ?? 1;
    const hardMult = round.question.difficulty === 'hard' ? (config?.economy_trivia_hard_multiplier ?? 2) : diffMult;

    // V52-L4: track per-winner payment status so the embed accurately
    // reflects who was actually paid (previously a failed economy_add_balance
    // was only logged, but the embed still showed the user as a winner).
    const winners: Array<{ userId: string; paid: boolean }> = [];
    const losers: string[] = [];

    for (const [userId, choice] of round.answers) {
      if (choice === round.correctIndex) {
        const streak = (await this.getStreak(guildId, userId)) + 1;
        await this.setStreak(guildId, userId, streak);
        const streakBonus = 1 + (streak * streakMultPct) / 100;
        const payout = Math.floor(basePayout * hardMult * streakBonus);

        // Award currency
        const { error: triviaPayErr } = await (this.supabase as any).rpc('economy_add_balance', {
          p_guild_id: guildId,
          p_user_id: userId,
          p_amount: payout,
        });
        if (triviaPayErr) log.error(`Failed to pay ${userId}:`, triviaPayErr.message);
        winners.push({ userId, paid: !triviaPayErr });
        getQuestsManager()?.trackProgress(guildId, userId, 'trivia').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
      } else {
        losers.push(userId);
        await this.setStreak(guildId, userId, 0);
      }
    }

    const paidWinners = winners.filter((w) => w.paid);
    const failedWinners = winners.filter((w) => !w.paid);

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
      await interaction.editReply({ embeds: [embed], components: [] });
    } catch {
      // interaction may have expired
    }
  }
}
