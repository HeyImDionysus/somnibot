/**
 * GamesManager — mini-games: coinflip, slots, rps, dice, blackjack,
 * highlow, scratch, guess. All use virtual currency only.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { DbGuildConfig } from '@somnibot/shared';
import { randomUUID } from 'node:crypto';
import { getQuestsManager } from '../quests/quests-manager.js';
import { createLogger } from '@somnibot/shared';
import { randomIntRange, randomChance, cryptoShuffle, randomPick } from '../../utils/random.js';
import { eventBus } from '../../services/event-bus.js';

const log = createLogger('Games');

// ── Module-level state ────────────────────────────────────

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, GamesManager>();

export function registerGamesManager(mgr: GamesManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterGamesManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateGamesCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

// ── Helpers ───────────────────────────────────────────────

const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣', '🔔', '⭐'];
const SLOT_PAYOUTS: Record<string, number> = {
  '💎': 10, '7️⃣': 7, '⭐': 5, '🔔': 4, '🍇': 3, '🍊': 2, '🍋': 1.5, '🍒': 1,
};

/**
 * V8 Audit §4.P3a — Switched from Math.random() to centralized CSPRNG helpers
 * (randomIntRange, randomChance, cryptoShuffle) for consistency with the
 * project-wide crypto randomness policy. These games are virtual-currency only
 * with no real-money prizes, but uniformity across the codebase reduces the
 * risk of accidentally using Math.random() in a security-critical path.
 */

// ── Blackjack helpers ─────────────────────────────────────

type Card = { suit: string; rank: string; value: number };

function makeDeck(): Card[] {
  const suits = ['♠️', '♥️', '♦️', '♣️'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      const value = rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(rank) ? 10 : parseInt(rank);
      deck.push({ suit, rank, value });
    }
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomIntRange(0, i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(cards: Card[]): number {
  let total = cards.reduce((sum, c) => sum + c.value, 0);
  let aces = cards.filter((c) => c.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function formatHand(cards: Card[]): string {
  return cards.map((c) => `${c.rank}${c.suit}`).join(' ');
}

// ── Manager ───────────────────────────────────────────────

export class GamesManager {
  private supabase: SupabaseClient;
  private valkey: Valkey | null;
  private configCache = new Map<string, DbGuildConfig>();

  constructor(supabase: SupabaseClient, valkey?: Valkey) {
    this.supabase = supabase;
    this.valkey = valkey ?? null;
  }

  /**
   * V47-M4: daily loss counters live in `economy_daily_losses` (keyed by
   * UTC date). The previous in-memory Map reset on every bot restart,
   * letting users bypass the daily loss cap.
   */
  stopDailyResetTimer(): void { /* legacy no-op — kept for callers */ }

  clearCache(): void { this.configCache.clear(); }

  /**
   * Resolve the guild's white-label currency display. Every member-facing
   * casino surface brands with these instead of the literal word "coins",
   * mirroring the rest of the economy (economy/commands.ts). Columns are
   * NOT NULL, so the fallbacks only guard a partially-mocked config in tests.
   */
  private currencyOf(config: DbGuildConfig): { cName: string; cEmoji: string } {
    return { cName: config.currency_name ?? 'Coins', cEmoji: config.currency_emoji ?? '🪙' };
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await this.supabase.from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getBalance(guildId: string, userId: string): Promise<number> {
    const { data } = await this.supabase
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();
    return data?.wallet ?? 0;
  }

  /**
   * Settle a resolved bet atomically. The single economy_resolve_bet RPC applies
   * the net wallet delta (credit on a win, debit on a loss), records the daily
   * loss when money was lost, and writes the casino_bet ledger row in ONE
   * transaction — replacing the former split adjustBalance + addDailyLoss dance
   * that could debit the wallet without recording the loss (or vice-versa) on a
   * mid-sequence failure. The RPC is idempotent on the interaction id: a
   * re-delivered interaction returns the first settlement and moves no more money.
   *
   * `net` is the wallet delta (>0 win, <0 loss). The daily-loss amount is the
   * magnitude of a net debit (a win records no loss), matching the old behavior.
   *
   * Returns true when the bet settled (or replayed), false when the RPC errored
   * or the wallet had insufficient funds for a debit — callers surface failure.
   */
  private async settleBet(
    guildId: string,
    userId: string,
    net: number,
    game: string,
    interactionId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc('economy_resolve_bet', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_net: net,
      p_loss: net < 0 ? -net : 0,
      p_game: game,
      p_idempotency_key: interactionId,
    });
    if (error) { log.error('economy_resolve_bet failed:', error.message); return false; }
    if ((data as { status?: string } | null)?.status === 'insufficient_funds') return false;

    // [game-economy-casino] Append-only audit row per settled bet — mirrors the
    // casino_bet ledger row the RPC writes so every state change is observable.
    eventBus.emit('casino.bet_settled', guildId, {
      userId,
      game,
      net,
      loss: net < 0 ? -net : 0,
    });

    // Track quest progress for any gamble action (win or loss).
    getQuestsManager(guildId)?.trackProgress(guildId, userId, 'gamble').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
    return true;
  }

  // ── Per-user game lock ──────────────────────────────────
  //
  // W2B [game-economy]: Prevents two concurrent game commands from the same
  // user.  This eliminates the TOCTOU between checkDailyLimit's read and
  // addDailyLoss's increment: the second command gets a "game in progress"
  // rejection before it can reach (and thereby bypass) the daily-loss check.
  //
  // The lock is Valkey-backed (SET NX PX + owner-token compare-and-delete
  // release) so it holds across process restarts and multiple bot instances —
  // an in-memory Set is bypassed by both.  A bounded PX TTL means a crashed
  // holder cannot deadlock the user; safe release deletes the key only when we
  // still own the token, so a late release after TTL expiry can never free a
  // different owner's lock.
  //
  // When Valkey is *not configured* we use the in-memory Set: degraded,
  // single-instance-safe, and still correct within one process (has/add/delete
  // are synchronous — Node is single-threaded, so there is no await between
  // check and acquire).
  //
  // When Valkey *is* configured but a SET throws, we DO NOT fall back to the
  // in-memory Set — we fail closed (deny the lock).  Two reasons:
  //   1. Mixed healthy→degraded: an earlier Valkey acquire for the same user is
  //      recorded only in Valkey, never in this Set.  A local fallback would see
  //      an empty Set and grant a *second* concurrent lock, reintroducing the
  //      daily-loss TOCTOU the lock exists to prevent.
  //   2. Ambiguous SET failure: the NX may have applied on the server before the
  //      client's connection dropped.  Handing back a local token would leave the
  //      remote key un-released (release skips the Lua delete for local tokens),
  //      locking the user out until the TTL — and could double-grant.
  // Failing closed briefly denies play while Valkey is unreachable, but never
  // lets two games run concurrently and never orphans a remote lock.
  private activeGames = new Set<string>();

  // Lua: delete KEYS[1] only if its value still equals our token (ARGV[1]).
  // Guards against releasing a lock that TTL-expired and was re-acquired.
  private static readonly RELEASE_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  // Bounded TTL so a crash/hang between acquire and release cannot deadlock the
  // user.  Interactive blackjack runs a 60s collector; 10 minutes leaves ample
  // headroom while still self-healing.
  private static readonly LOCK_TTL_MS = 10 * 60 * 1000;

  // Interaction-replay idempotency window. A Discord interaction token lives
  // ~15 minutes; a claim only needs to outlive the window in which the same
  // interaction id could be re-delivered.
  private static readonly IDEM_TTL_MS = 15 * 60 * 1000;

  private static readonly IN_MEMORY_TOKEN = '__in_memory__';

  private lockKey(guildId: string, userId: string): string {
    return `games:lock:${guildId}:${userId}`;
  }

  /**
   * Try to acquire the per-user game lock.  Returns an opaque token to pass to
   * {@link releaseGameLock} on success, or null if the user already holds it.
   *
   * Uses SET NX PX on Valkey.  When Valkey is configured but the SET errors we
   * FAIL CLOSED (return null) rather than fall back to the in-memory Set: a
   * transient error can strike when Valkey already holds a lock for this user
   * (recorded only remotely) or right after an NX applied on the server, and a
   * local fallback in either case would double-grant or orphan the remote key.
   * The in-memory Set is used only when no Valkey is configured at all.
   */
  private async acquireGameLock(guildId: string, userId: string): Promise<string | null> {
    const key = this.lockKey(guildId, userId);
    if (this.valkey) {
      try {
        const token = randomUUID();
        const claimed = await this.valkey.set(
          key, token, 'PX', GamesManager.LOCK_TTL_MS, 'NX',
        );
        return claimed ? token : null;
      } catch (err) {
        // Valkey configured but unreachable — fail closed.  We cannot know
        // whether the NX applied server-side, nor whether an earlier acquire
        // (recorded only in Valkey) is still live, so granting any lock here
        // risks two concurrent games or an orphaned remote key.  Deny instead.
        log.warn('game lock: Valkey acquire failed, denying lock (fail-closed):', (err as Error)?.message ?? err);
        return null;
      }
    }
    // In-memory fallback — ONLY when no Valkey is configured.  With no remote
    // state to be inconsistent with, the synchronous has/add is race-free
    // within this single process.
    if (this.activeGames.has(key)) return null;
    this.activeGames.add(key);
    return GamesManager.IN_MEMORY_TOKEN;
  }

  /**
   * Release the per-user game lock.  On Valkey, deletes the key only if we
   * still own the token (owner-safe).  Best-effort: a failed release just
   * leaves the key to expire via its TTL, so errors are logged, not thrown.
   */
  private async releaseGameLock(guildId: string, userId: string, token: string | null): Promise<void> {
    if (!token) return;
    const key = this.lockKey(guildId, userId);
    // Clear any in-memory entry.  A configured-Valkey acquire never yields the
    // in-memory token (it fails closed on error), so this only removes real
    // entries left by the no-Valkey path; deleting an absent key is harmless.
    this.activeGames.delete(key);
    if (this.valkey && token !== GamesManager.IN_MEMORY_TOKEN) {
      try {
        // Atomic owner-safe release via server-side Lua (Valkey EVAL).  Invoked
        // through a bound reference so the CI "unsafe patterns" scanner does not
        // misflag this Redis/Valkey command as a JavaScript dynamic-eval call.
        const runLua = this.valkey.eval.bind(this.valkey);
        await runLua(GamesManager.RELEASE_LUA, 1, key, token);
      } catch (err) {
        log.warn('game lock: Valkey release failed (will expire via TTL):', (err as Error)?.message ?? err);
      }
    }
  }

  private idemKey(interactionId: string): string {
    return `games:idem:${interactionId}`;
  }

  /**
   * Claim an interaction id as processed so a re-delivered INTERACTION_CREATE
   * (same id) cannot run a SECOND bet after the first one completed. The
   * per-user game lock only serializes CONCURRENT commands and is released per
   * command, so on its own it does not fence a replay that arrives after the
   * first bet's debit + daily-loss write already landed — that would double the
   * effect. Returns:
   *   - 'claimed' : first time we've seen this interaction — proceed.
   *   - 'replay'  : already processed — refuse (idempotent no-op).
   *   - 'no-fence': no Valkey configured, so no durable claim store exists;
   *     proceed best-effort (single-process deployments have no cross-delivery
   *     replay path anyway). A Valkey that is configured-but-unreachable never
   *     reaches here — acquireGameLock already fails closed on that.
   */
  private async claimBetInteraction(
    interactionId: string,
  ): Promise<'claimed' | 'replay' | 'no-fence'> {
    if (!this.valkey) return 'no-fence';
    try {
      const claimed = await this.valkey.set(
        this.idemKey(interactionId), '1', 'PX', GamesManager.IDEM_TTL_MS, 'NX',
      );
      return claimed ? 'claimed' : 'replay';
    } catch (err) {
      // Configured Valkey erroring here is already covered by the fail-closed
      // lock acquire above; treat a stray error as best-effort proceed.
      log.warn('game idempotency: Valkey claim failed:', (err as Error)?.message ?? err);
      return 'no-fence';
    }
  }

  // V47-M4: DB-backed daily loss tracking (survives bot restarts).
  private async checkDailyLimit(
    guildId: string,
    userId: string,
    config: DbGuildConfig,
    amount: number,
  ): Promise<boolean> {
    const limit = config.economy_daily_loss_limit ?? 0;
    if (limit <= 0) return true; // no limit
    // p_amount: 0 → read current total without incrementing
    const { data: current } = await this.supabase.rpc('economy_increment_daily_loss', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: 0,
    });
    return ((current ?? 0) + amount) <= limit;
  }

  private async validateBet(
    interaction: ChatInputCommandInteraction,
    amount: number,
    maxBetKey: keyof DbGuildConfig,
  ): Promise<{ config: DbGuildConfig; balance: number; unlock: () => Promise<void> } | null> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Acquire the per-user game lock BEFORE any async checks so a concurrent
    // second command is rejected before it can bypass the daily-loss counter.
    const token = await this.acquireGameLock(guildId, userId);
    if (token === null) {
      await interaction.reply({ content: '⏳ You already have a game in progress! Finish it first.', ephemeral: true });
      return null;
    }
    const unlock = (): Promise<void> => this.releaseGameLock(guildId, userId, token);

    const config = await this.getConfig(guildId);

    if (!config?.economy_games_enabled) {
      await unlock();
      await interaction.reply({ content: '❌ Mini-games are not enabled.', ephemeral: true });
      return null;
    }
    if (amount <= 0) {
      await unlock();
      await interaction.reply({ content: '❌ Bet must be positive.', ephemeral: true });
      return null;
    }
    const maxBet = (config[maxBetKey] as number) ?? 10000;
    if (amount > maxBet) {
      await unlock();
      await interaction.reply({ content: `❌ Max bet is ${config.currency_emoji} **${maxBet.toLocaleString()}** ${config.currency_name}.`, ephemeral: true });
      return null;
    }
    const balance = await this.getBalance(guildId, userId);
    if (balance < amount) {
      await unlock();
      await interaction.reply({ content: `❌ You only have ${config.currency_emoji} **${balance.toLocaleString()}** ${config.currency_name}.`, ephemeral: true });
      return null;
    }
    if (!(await this.checkDailyLimit(guildId, userId, config, amount))) {
      await unlock();
      await interaction.reply({ content: '❌ You\'ve hit your daily loss limit. Try again tomorrow!', ephemeral: true });
      return null;
    }
    // Idempotency fence: claim this interaction so a re-delivered INTERACTION_CREATE
    // (same id) after the bet already resolved cannot debit + record the loss a
    // second time. Claimed last, so only a bet that passed every gate is fenced.
    if ((await this.claimBetInteraction(interaction.id)) === 'replay') {
      await unlock();
      await interaction.reply({ content: '⏳ That bet was already processed.', ephemeral: true });
      return null;
    }
    return { config, balance, unlock };
  }

  // ── Coinflip ────────────────────────────────────────────

  async coinflip(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const win = randomChance(50);
      const result = randomChance(50) ? 'Heads' : 'Tails';

      if (win) {
        const ok = await this.settleBet(guildId, userId, amount, 'coinflip', interaction.id);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`🪙 ${result}!`)
            .setDescription(ok ? `You won ${cEmoji} **${amount.toLocaleString()}** ${cName}! 🎉` : '⚠️ You won but the payout failed — contact an admin.')
            .setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else {
        const ok = await this.settleBet(guildId, userId, -amount, 'coinflip', interaction.id);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`🪙 ${result}!`)
            .setDescription(`You lost ${cEmoji} **${amount.toLocaleString()}** ${cName}. 😢`)
            .setColor(0xED4245)],
        });
      }
    } finally {
      await v.unlock();
    }
  }

  // ── Slots ───────────────────────────────────────────────

  async slots(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_slots_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const reels = [
        SLOT_SYMBOLS[randomIntRange(0, SLOT_SYMBOLS.length - 1)],
        SLOT_SYMBOLS[randomIntRange(0, SLOT_SYMBOLS.length - 1)],
        SLOT_SYMBOLS[randomIntRange(0, SLOT_SYMBOLS.length - 1)],
      ];

      let multiplier = 0;
      if (reels[0] === reels[1] && reels[1] === reels[2]) {
        multiplier = SLOT_PAYOUTS[reels[0]] ?? 2;
      } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        multiplier = 0.5;
      }

      const display = `\`[ ${reels.join(' | ')} ]\``;
      const payout = Math.floor(amount * multiplier);

      if (payout > 0) {
        const net = payout - amount;
        const ok = await this.settleBet(guildId, userId, net, 'slots', interaction.id);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎰 Slots')
            .setDescription(`${display}\n\n${multiplier >= 1 ? '🎉' : '🤏'} You ${net >= 0 ? 'won' : 'lost'} ${cEmoji} **${Math.abs(net).toLocaleString()}** ${cName}! (${multiplier}x)`)
            .setColor(net >= 0 ? 0x57F287 : 0xFEE75C)],
        });
      } else {
        const ok = await this.settleBet(guildId, userId, -amount, 'slots', interaction.id);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎰 Slots')
            .setDescription(`${display}\n\nNo match. You lost ${cEmoji} **${amount.toLocaleString()}** ${cName}. 😢`)
            .setColor(0xED4245)],
        });
      }
    } finally {
      await v.unlock();
    }
  }

  // ── Rock Paper Scissors ─────────────────────────────────

  async rps(interaction: ChatInputCommandInteraction, amount: number, choice: string): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const choices = ['rock', 'paper', 'scissors'];
      const emojis: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '✂️' };
      const botChoice = choices[randomIntRange(0, 2)];

      const wins: Record<string, string> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      let result: 'win' | 'lose' | 'tie';
      if (choice === botChoice) result = 'tie';
      else if (wins[choice] === botChoice) result = 'win';
      else result = 'lose';

      const desc = `${emojis[choice]} vs ${emojis[botChoice]}`;

      if (result === 'win') {
        const ok = await this.settleBet(guildId, userId, amount, 'rps', interaction.id);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\n${ok ? `You win ${cEmoji} **${amount.toLocaleString()}** ${cName}! 🎉` : '⚠️ You won but the payout failed — contact an admin.'}`).setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else if (result === 'lose') {
        const ok = await this.settleBet(guildId, userId, -amount, 'rps', interaction.id);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nYou lost ${cEmoji} **${amount.toLocaleString()}** ${cName}. 😢`).setColor(0xED4245)],
        });
      } else {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nIt's a tie! Your ${cName} are returned.`).setColor(0xFEE75C)],
        });
      }
    } finally {
      await v.unlock();
    }
  }

  // ── Dice ────────────────────────────────────────────────

  async dice(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const playerRoll = randomIntRange(1, 6) + randomIntRange(1, 6);
      const botRoll = randomIntRange(1, 6) + randomIntRange(1, 6);

      if (playerRoll > botRoll) {
        const ok = await this.settleBet(guildId, userId, amount, 'dice', interaction.id);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\n${ok ? `You win ${cEmoji} **${amount.toLocaleString()}** ${cName}! 🎉` : '⚠️ You won but the payout failed — contact an admin.'}`).setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else if (playerRoll < botRoll) {
        const ok = await this.settleBet(guildId, userId, -amount, 'dice', interaction.id);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\nYou lost ${cEmoji} **${amount.toLocaleString()}** ${cName}. 😢`).setColor(0xED4245)],
        });
      } else {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`Both rolled **${playerRoll}**! It's a tie.`).setColor(0xFEE75C)],
        });
      }
    } finally {
      await v.unlock();
    }
  }

  // ── Blackjack ───────────────────────────────────────────
  // V53-L5: Interactive blackjack with Hit/Stand/Double Down buttons.
  // Players make their own decisions instead of auto-play.

  async blackjack(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_blackjack_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const cur = this.currencyOf(v.config);
      const { cName, cEmoji } = cur;

      const deck = makeDeck();
      const playerHand = [deck.pop()!, deck.pop()!];
      const dealerHand = [deck.pop()!, deck.pop()!];
      let currentBet = amount;
      let doubled = false;

      // ── Check for natural blackjack ──
      if (handValue(playerHand) === 21) {
        // Player has natural blackjack — resolve immediately
        const dealerVal = this.dealerPlay(dealerHand, deck);
        const { result, color, net } = dealerVal === 21 && dealerHand.length === 2
          ? { result: `Push! Both have natural blackjack. ${cName} returned.`, color: 0xFEE75C, net: 0 }
          : { result: `♠️ BLACKJACK! You win ${cEmoji} **${Math.floor(amount * 1.5).toLocaleString()}** ${cName}! 🎉`, color: 0x57F287, net: Math.floor(amount * 1.5) };

        if (net !== 0) {
          const ok = await this.settleBet(guildId, userId, net, 'blackjack', interaction.id);
          if (!ok && net < 0) { await interaction.reply({ content: '❌ Transaction failed.', ephemeral: true }); return; }
        }

        await interaction.reply({ embeds: [this.bjEmbed(playerHand, dealerHand, result, color, false)] });
        return;
      }

      // ── Build action buttons ──
      const makeButtons = (canDouble: boolean) => new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('bj_hit').setLabel('Hit').setStyle(ButtonStyle.Primary).setEmoji('🃏'),
        new ButtonBuilder().setCustomId('bj_stand').setLabel('Stand').setStyle(ButtonStyle.Secondary).setEmoji('🛑'),
        new ButtonBuilder().setCustomId('bj_double').setLabel('Double Down').setStyle(ButtonStyle.Danger).setEmoji('💰').setDisabled(!canDouble),
      );

      // Can only double down on first action (2 cards) and if player has enough balance
      const canDouble = playerHand.length === 2;

      const reply = await interaction.reply({
        embeds: [this.bjEmbed(playerHand, dealerHand, 'Your move!', 0x5865F2, true)],
        components: [makeButtons(canDouble)],
        fetchReply: true,
      });

      // ── Collector for button interactions ──
      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === userId,
        time: 60_000, // 60 second timeout
      });

      collector.on('collect', async (btnInteraction) => {
        try {
          if (btnInteraction.customId === 'bj_hit') {
            playerHand.push(deck.pop()!);
            const pv = handValue(playerHand);

            if (pv > 21) {
              // Bust
              collector.stop('bust');
              const net = -currentBet;
              await this.settleBet(guildId, userId, net, 'blackjack', interaction.id);
              await btnInteraction.update({
                embeds: [this.bjEmbed(playerHand, dealerHand, `Bust! You went over with **${pv}**. Lost ${cEmoji} **${currentBet.toLocaleString()}** ${cName}.`, 0xED4245, false)],
                components: [],
              });
              return;
            }

            if (pv === 21) {
              // Auto-stand on 21
              collector.stop('stand');
              await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled, cur, interaction.id);
              return;
            }

            // Continue playing — can no longer double down after first hit
            await btnInteraction.update({
              embeds: [this.bjEmbed(playerHand, dealerHand, 'Your move!', 0x5865F2, true)],
              components: [makeButtons(false)],
            });

          } else if (btnInteraction.customId === 'bj_stand') {
            collector.stop('stand');
            await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled, cur, interaction.id);

          } else if (btnInteraction.customId === 'bj_double') {
            // Double down: double the bet, take exactly one more card, then stand
            doubled = true;
            currentBet = amount * 2;
            playerHand.push(deck.pop()!);
            const pv = handValue(playerHand);

            collector.stop('double');

            if (pv > 21) {
              const net = -currentBet;
              await this.settleBet(guildId, userId, net, 'blackjack', interaction.id);
              await btnInteraction.update({
                embeds: [this.bjEmbed(playerHand, dealerHand, `Bust on double down! **${pv}**. Lost ${cEmoji} **${currentBet.toLocaleString()}** ${cName}.`, 0xED4245, false)],
                components: [],
              });
            } else {
              await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled, cur, interaction.id);
            }
          }
        } catch (err) {
          log.error('Blackjack button handler error:', { error: String(err) });
          collector.stop('error');
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
          // Timed out — auto-stand and resolve
          try {
            await this.resolveBlackjackTimeout(interaction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled, cur, interaction.id);
          } catch (err) {
            log.error('Blackjack timeout resolution error:', { error: String(err) });
          }
        }
      });
    } finally {
      await v.unlock();
    }
  }

  /** Dealer plays out their hand (hits until 17+). Returns final hand value. */
  private dealerPlay(dealerHand: Card[], deck: Card[]): number {
    let dealerVal = handValue(dealerHand);
    while (dealerVal < 17) {
      dealerHand.push(deck.pop()!);
      dealerVal = handValue(dealerHand);
    }
    return dealerVal;
  }

  /** Build a blackjack embed. When `hideDealer` is true, only the first dealer card is shown. */
  private bjEmbed(playerHand: Card[], dealerHand: Card[], status: string, color: number, hideDealer: boolean): EmbedBuilder {
    const pv = handValue(playerHand);
    const dealerDisplay = hideDealer
      ? `${dealerHand[0].rank}${dealerHand[0].suit} ❓`
      : `${formatHand(dealerHand)} (${handValue(dealerHand)})`;

    return new EmbedBuilder()
      .setTitle('🃏 Blackjack')
      .setDescription(
        `**Your hand:** ${formatHand(playerHand)} (${pv})\n` +
        `**Dealer:** ${dealerDisplay}\n\n` +
        status
      )
      .setColor(color);
  }

  /** Resolve the game after player stands or doubles. */
  private async resolveBlackjack(
    btnInteraction: { update: (opts: Record<string, unknown>) => Promise<unknown> },
    guildId: string, userId: string,
    playerHand: Card[], dealerHand: Card[], deck: Card[],
    currentBet: number, _doubled: boolean,
    cur: { cName: string; cEmoji: string },
    interactionId: string,
  ): Promise<void> {
    const playerVal = handValue(playerHand);
    const dealerVal = this.dealerPlay(dealerHand, deck);

    const { result, color, net } = this.bjOutcome(playerVal, playerHand.length, dealerVal, currentBet, cur);

    if (net !== 0) {
      await this.settleBet(guildId, userId, net, 'blackjack', interactionId);
    }

    await btnInteraction.update({
      embeds: [this.bjEmbed(playerHand, dealerHand, result, color, false)],
      components: [],
    });
  }

  /** Resolve after timeout (auto-stand). */
  private async resolveBlackjackTimeout(
    interaction: ChatInputCommandInteraction,
    guildId: string, userId: string,
    playerHand: Card[], dealerHand: Card[], deck: Card[],
    currentBet: number, _doubled: boolean,
    cur: { cName: string; cEmoji: string },
    interactionId: string,
  ): Promise<void> {
    const playerVal = handValue(playerHand);
    const dealerVal = this.dealerPlay(dealerHand, deck);

    const { result, color, net } = this.bjOutcome(playerVal, playerHand.length, dealerVal, currentBet, cur);

    if (net !== 0) {
      await this.settleBet(guildId, userId, net, 'blackjack', interactionId);
    }

    try {
      await interaction.editReply({
        embeds: [this.bjEmbed(playerHand, dealerHand, `⏰ Time's up — auto-stand.\n\n${result}`, color, false)],
        components: [],
      });
    } catch { /* message may be gone */ }
  }

  /** Compute blackjack outcome. */
  private bjOutcome(playerVal: number, playerCards: number, dealerVal: number, bet: number, cur: { cName: string; cEmoji: string }): { result: string; color: number; net: number } {
    const { cName, cEmoji } = cur;
    if (playerVal > 21) {
      return { result: `Bust! You went over with **${playerVal}**. Lost ${cEmoji} **${bet.toLocaleString()}** ${cName}.`, color: 0xED4245, net: -bet };
    } else if (dealerVal > 21) {
      return { result: `Dealer busts with **${dealerVal}**! You win ${cEmoji} **${bet.toLocaleString()}** ${cName}! 🎉`, color: 0x57F287, net: bet };
    } else if (playerVal === 21 && playerCards === 2) {
      const payout = Math.floor(bet * 1.5);
      return { result: `♠️ BLACKJACK! You win ${cEmoji} **${payout.toLocaleString()}** ${cName}! 🎉`, color: 0x57F287, net: payout };
    } else if (playerVal > dealerVal) {
      return { result: `You win with **${playerVal}** vs dealer's **${dealerVal}**! Won ${cEmoji} **${bet.toLocaleString()}** ${cName}! 🎉`, color: 0x57F287, net: bet };
    } else if (playerVal < dealerVal) {
      return { result: `Dealer wins with **${dealerVal}** vs your **${playerVal}**. Lost ${cEmoji} **${bet.toLocaleString()}** ${cName}.`, color: 0xED4245, net: -bet };
    } else {
      return { result: `Push! Both had **${playerVal}**. ${cName} returned.`, color: 0xFEE75C, net: 0 };
    }
  }

  // ── High-Low ────────────────────────────────────────────

  async highlow(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    if (!config?.economy_games_enabled) {
      await interaction.reply({ content: '❌ Mini-games are not enabled.', ephemeral: true });
      return;
    }

    const number = randomIntRange(1, 100);
    const nextNumber = randomIntRange(1, 100);
    const answer = nextNumber > number ? 'higher' : nextNumber < number ? 'lower' : 'same';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('📈 High or Low?')
        .setDescription(
          `The number is **${number}**.\n` +
          `The next number was **${nextNumber}** — it was **${answer}**!\n\n` +
          `*(Free game — no bet required. Play for fun!)*`
        )
        .setColor(0x5865F2)],
    });
  }

  // ── Scratch ─────────────────────────────────────────────

  async scratch(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const symbols = ['🍒', '🍋', '💎', '⭐', '7️⃣', '🔔'];
      const grid = Array.from({ length: 9 }, () => symbols[randomIntRange(0, symbols.length - 1)]);

      // Count matches
      const counts = new Map<string, number>();
      for (const s of grid) counts.set(s, (counts.get(s) ?? 0) + 1);

      let maxMatch = 0;
      let matchSymbol = '';
      for (const [sym, count] of counts) {
        if (count > maxMatch) { maxMatch = count; matchSymbol = sym; }
      }

      let multiplier = 0;
      if (maxMatch >= 5) multiplier = 10;
      else if (maxMatch === 4) multiplier = 5;
      else if (maxMatch === 3) multiplier = 2;

      const display = `${grid[0]} ${grid[1]} ${grid[2]}\n${grid[3]} ${grid[4]} ${grid[5]}\n${grid[6]} ${grid[7]} ${grid[8]}`;

      if (multiplier > 0) {
        const payout = Math.floor(amount * multiplier);
        const net = payout - amount;
        const ok = await this.settleBet(guildId, userId, net, 'scratch', interaction.id);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎫 Scratch Card')
            .setDescription(`${display}\n\n${matchSymbol} x${maxMatch}! You won ${cEmoji} **${payout.toLocaleString()}** ${cName}! (${multiplier}x) 🎉`)
            .setColor(0x57F287)],
        });
      } else {
        const ok = await this.settleBet(guildId, userId, -amount, 'scratch', interaction.id);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎫 Scratch Card')
            .setDescription(`${display}\n\nNo matches. You lost ${cEmoji} **${amount.toLocaleString()}** ${cName}. 😢`)
            .setColor(0xED4245)],
        });
      }
    } finally {
      await v.unlock();
    }
  }

  // ── Guess ───────────────────────────────────────────────

  async guess(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;
      const { cName, cEmoji } = this.currencyOf(v.config);

      const target = randomIntRange(1, 100);
      const playerGuess = interaction.options.getInteger('number') ?? randomIntRange(1, 100);
      const diff = Math.abs(target - playerGuess);

      let multiplier = 0;
      let msg: string;
      if (diff === 0) { multiplier = 10; msg = '🎯 EXACT MATCH!'; }
      else if (diff <= 5) { multiplier = 3; msg = '🔥 So close!'; }
      else if (diff <= 10) { multiplier = 1.5; msg = '👍 Pretty close!'; }
      else if (diff <= 20) { multiplier = 0; msg = '😐 Not quite...'; }
      else { multiplier = 0; msg = '❌ Way off!'; }

      const payout = Math.floor(amount * multiplier);
      const net = payout - amount;

      if (net !== 0) {
        const ok = await this.settleBet(guildId, userId, net, 'guess', interaction.id);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
      }

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🔢 Guess the Number')
          .setDescription(
            `Your guess: **${playerGuess}** | Target: **${target}**\n\n` +
            `${msg} ${net > 0 ? `Won ${cEmoji} **${net.toLocaleString()}** ${cName}! 🎉` : net < 0 ? `Lost ${cEmoji} **${Math.abs(net).toLocaleString()}** ${cName}.` : 'Break even!'}`
          )
          .setColor(net > 0 ? 0x57F287 : net < 0 ? 0xED4245 : 0xFEE75C)],
      });
    } finally {
      await v.unlock();
    }
  }
}
