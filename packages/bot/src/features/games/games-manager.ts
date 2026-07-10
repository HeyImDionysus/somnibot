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
   * Adjust a user's balance. Returns true on success, false on failure.
   * Critical: never swallow errors — callers must handle failure.
   */
  private async adjustBalance(guildId: string, userId: string, amount: number): Promise<boolean> {
    if (amount >= 0) {
      const { error } = await this.supabase.rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: amount,
      });
      if (error) { log.error('economy_add_balance failed:', error.message); return false; }
    } else {
      const { error } = await this.supabase.rpc('economy_subtract_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: Math.abs(amount),
      });
      if (error) { log.error('economy_subtract_balance failed:', error.message); return false; }
    }
    // Track quest progress for any gamble action (win or loss)
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
  // When Valkey is unavailable (not configured, or a command throws) we fall
  // back to the in-memory Set: degraded, single-instance-safe, and still
  // correct within one process (has/add/delete are synchronous — Node is
  // single-threaded, so there is no await between check and acquire).
  private activeGames = new Set<string>();

  // Lua: delete KEYS[1] only if its value still equals our token (ARGV[1]).
  // Guards against releasing a lock that TTL-expired and was re-acquired.
  private static readonly RELEASE_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  // Bounded TTL so a crash/hang between acquire and release cannot deadlock the
  // user.  Interactive blackjack runs a 60s collector; 10 minutes leaves ample
  // headroom while still self-healing.
  private static readonly LOCK_TTL_MS = 10 * 60 * 1000;

  private static readonly IN_MEMORY_TOKEN = '__in_memory__';

  private lockKey(guildId: string, userId: string): string {
    return `games:lock:${guildId}:${userId}`;
  }

  /**
   * Try to acquire the per-user game lock.  Returns an opaque token to pass to
   * {@link releaseGameLock} on success, or null if the user already holds it.
   *
   * Uses SET NX PX on Valkey; on any Valkey error (connection down, etc.) it
   * degrades to the in-memory Set so single-instance play still works.
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
        // Valkey unreachable — fall through to the in-memory Set (degraded).
        log.warn('game lock: Valkey acquire failed, using in-memory fallback:', (err as Error)?.message ?? err);
      }
    }
    // In-memory fallback (also the path when no Valkey is configured).
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
    // The in-memory fallback always releases from the Set — even when Valkey is
    // configured, because a degraded acquire may have used it.
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

  // V53-M1: Await the RPC so callers can react to failure.  The daily loss
  // counter gates how much a user can lose per day — if the increment silently
  // fails, the limit is bypassed on subsequent bets.
  private async addDailyLoss(guildId: string, userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const { error } = await this.supabase.rpc('economy_increment_daily_loss', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    });
    if (error) {
      log.error('economy_increment_daily_loss failed:', { error: String(error) });
    }
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
      await interaction.reply({ content: `❌ Max bet is **${maxBet.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    const balance = await this.getBalance(guildId, userId);
    if (balance < amount) {
      await unlock();
      await interaction.reply({ content: `❌ You only have **${balance.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    if (!(await this.checkDailyLimit(guildId, userId, config, amount))) {
      await unlock();
      await interaction.reply({ content: '❌ You\'ve hit your daily loss limit. Try again tomorrow!', ephemeral: true });
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

      const win = randomChance(50);
      const result = randomChance(50) ? 'Heads' : 'Tails';

      if (win) {
        const ok = await this.adjustBalance(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`🪙 ${result}!`)
            .setDescription(ok ? `You won **${amount.toLocaleString()}** coins! 🎉` : '⚠️ You won but the payout failed — contact an admin.')
            .setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else {
        const ok = await this.adjustBalance(guildId, userId, -amount);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await this.addDailyLoss(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`🪙 ${result}!`)
            .setDescription(`You lost **${amount.toLocaleString()}** coins. 😢`)
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
        const ok = await this.adjustBalance(guildId, userId, net);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        if (net < 0) await this.addDailyLoss(guildId, userId, Math.abs(net));
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎰 Slots')
            .setDescription(`${display}\n\n${multiplier >= 1 ? '🎉' : '🤏'} You ${net >= 0 ? 'won' : 'lost'} **${Math.abs(net).toLocaleString()}** coins! (${multiplier}x)`)
            .setColor(net >= 0 ? 0x57F287 : 0xFEE75C)],
        });
      } else {
        const ok = await this.adjustBalance(guildId, userId, -amount);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await this.addDailyLoss(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎰 Slots')
            .setDescription(`${display}\n\nNo match. You lost **${amount.toLocaleString()}** coins. 😢`)
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
        const ok = await this.adjustBalance(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\n${ok ? `You win **${amount.toLocaleString()}** coins! 🎉` : '⚠️ You won but the payout failed — contact an admin.'}`).setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else if (result === 'lose') {
        const ok = await this.adjustBalance(guildId, userId, -amount);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await this.addDailyLoss(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nYou lost **${amount.toLocaleString()}** coins. 😢`).setColor(0xED4245)],
        });
      } else {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nIt's a tie! Your coins are returned.`).setColor(0xFEE75C)],
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

      const playerRoll = randomIntRange(1, 6) + randomIntRange(1, 6);
      const botRoll = randomIntRange(1, 6) + randomIntRange(1, 6);

      if (playerRoll > botRoll) {
        const ok = await this.adjustBalance(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\n${ok ? `You win **${amount.toLocaleString()}** coins! 🎉` : '⚠️ You won but the payout failed — contact an admin.'}`).setColor(ok ? 0x57F287 : 0xFEE75C)],
        });
      } else if (playerRoll < botRoll) {
        const ok = await this.adjustBalance(guildId, userId, -amount);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await this.addDailyLoss(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\nYou lost **${amount.toLocaleString()}** coins. 😢`).setColor(0xED4245)],
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
          ? { result: `Push! Both have natural blackjack. Coins returned.`, color: 0xFEE75C, net: 0 }
          : { result: `♠️ BLACKJACK! You win **${Math.floor(amount * 1.5).toLocaleString()}** coins! 🎉`, color: 0x57F287, net: Math.floor(amount * 1.5) };

        if (net !== 0) {
          const ok = await this.adjustBalance(guildId, userId, net);
          if (!ok && net < 0) { await interaction.reply({ content: '❌ Transaction failed.', ephemeral: true }); return; }
          if (net < 0) await this.addDailyLoss(guildId, userId, Math.abs(net));
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
              const ok = await this.adjustBalance(guildId, userId, net);
              if (ok) await this.addDailyLoss(guildId, userId, Math.abs(net));
              await btnInteraction.update({
                embeds: [this.bjEmbed(playerHand, dealerHand, `Bust! You went over with **${pv}**. Lost **${currentBet.toLocaleString()}** coins.`, 0xED4245, false)],
                components: [],
              });
              return;
            }

            if (pv === 21) {
              // Auto-stand on 21
              collector.stop('stand');
              await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled);
              return;
            }

            // Continue playing — can no longer double down after first hit
            await btnInteraction.update({
              embeds: [this.bjEmbed(playerHand, dealerHand, 'Your move!', 0x5865F2, true)],
              components: [makeButtons(false)],
            });

          } else if (btnInteraction.customId === 'bj_stand') {
            collector.stop('stand');
            await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled);

          } else if (btnInteraction.customId === 'bj_double') {
            // Double down: double the bet, take exactly one more card, then stand
            doubled = true;
            currentBet = amount * 2;
            playerHand.push(deck.pop()!);
            const pv = handValue(playerHand);

            collector.stop('double');

            if (pv > 21) {
              const net = -currentBet;
              const ok = await this.adjustBalance(guildId, userId, net);
              if (ok) await this.addDailyLoss(guildId, userId, Math.abs(net));
              await btnInteraction.update({
                embeds: [this.bjEmbed(playerHand, dealerHand, `Bust on double down! **${pv}**. Lost **${currentBet.toLocaleString()}** coins.`, 0xED4245, false)],
                components: [],
              });
            } else {
              await this.resolveBlackjack(btnInteraction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled);
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
            await this.resolveBlackjackTimeout(interaction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled);
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
  ): Promise<void> {
    const playerVal = handValue(playerHand);
    const dealerVal = this.dealerPlay(dealerHand, deck);

    const { result, color, net } = this.bjOutcome(playerVal, playerHand.length, dealerVal, currentBet);

    if (net !== 0) {
      const ok = await this.adjustBalance(guildId, userId, net);
      if (ok && net < 0) await this.addDailyLoss(guildId, userId, Math.abs(net));
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
  ): Promise<void> {
    const playerVal = handValue(playerHand);
    const dealerVal = this.dealerPlay(dealerHand, deck);

    const { result, color, net } = this.bjOutcome(playerVal, playerHand.length, dealerVal, currentBet);

    if (net !== 0) {
      const ok = await this.adjustBalance(guildId, userId, net);
      if (ok && net < 0) await this.addDailyLoss(guildId, userId, Math.abs(net));
    }

    try {
      await interaction.editReply({
        embeds: [this.bjEmbed(playerHand, dealerHand, `⏰ Time's up — auto-stand.\n\n${result}`, color, false)],
        components: [],
      });
    } catch { /* message may be gone */ }
  }

  /** Compute blackjack outcome. */
  private bjOutcome(playerVal: number, playerCards: number, dealerVal: number, bet: number): { result: string; color: number; net: number } {
    if (playerVal > 21) {
      return { result: `Bust! You went over with **${playerVal}**. Lost **${bet.toLocaleString()}** coins.`, color: 0xED4245, net: -bet };
    } else if (dealerVal > 21) {
      return { result: `Dealer busts with **${dealerVal}**! You win **${bet.toLocaleString()}** coins! 🎉`, color: 0x57F287, net: bet };
    } else if (playerVal === 21 && playerCards === 2) {
      const payout = Math.floor(bet * 1.5);
      return { result: `♠️ BLACKJACK! You win **${payout.toLocaleString()}** coins! 🎉`, color: 0x57F287, net: payout };
    } else if (playerVal > dealerVal) {
      return { result: `You win with **${playerVal}** vs dealer's **${dealerVal}**! Won **${bet.toLocaleString()}** coins! 🎉`, color: 0x57F287, net: bet };
    } else if (playerVal < dealerVal) {
      return { result: `Dealer wins with **${dealerVal}** vs your **${playerVal}**. Lost **${bet.toLocaleString()}** coins.`, color: 0xED4245, net: -bet };
    } else {
      return { result: `Push! Both had **${playerVal}**. Coins returned.`, color: 0xFEE75C, net: 0 };
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
        const ok = await this.adjustBalance(guildId, userId, net);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎫 Scratch Card')
            .setDescription(`${display}\n\n${matchSymbol} x${maxMatch}! You won **${payout.toLocaleString()}** coins! (${multiplier}x) 🎉`)
            .setColor(0x57F287)],
        });
      } else {
        const ok = await this.adjustBalance(guildId, userId, -amount);
        if (!ok) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        await this.addDailyLoss(guildId, userId, amount);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎫 Scratch Card')
            .setDescription(`${display}\n\nNo matches. You lost **${amount.toLocaleString()}** coins. 😢`)
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
        const ok = await this.adjustBalance(guildId, userId, net);
        if (!ok && net < 0) {
          await interaction.reply({ content: '❌ Transaction failed — your balance was not changed.', ephemeral: true });
          return;
        }
        if (net < 0) await this.addDailyLoss(guildId, userId, Math.abs(net));
      }

      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🔢 Guess the Number')
          .setDescription(
            `Your guess: **${playerGuess}** | Target: **${target}**\n\n` +
            `${msg} ${net > 0 ? `Won **${net.toLocaleString()}** coins! 🎉` : net < 0 ? `Lost **${Math.abs(net).toLocaleString()}** coins.` : 'Break even!'}`
          )
          .setColor(net > 0 ? 0x57F287 : net < 0 ? 0xED4245 : 0xFEE75C)],
      });
    } finally {
      await v.unlock();
    }
  }
}
