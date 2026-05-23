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
import type { DbGuildConfig } from '@somnibot/shared';
import { getQuestsManager } from '../quests/quests-manager.js';

const log = createLogger('Games');

// ── Module-level state ────────────────────────────────────

let _manager: GamesManager | null = null;
export function registerGamesManager(mgr: GamesManager): void { _manager = mgr; }
export function invalidateGamesCache(): void { _manager?.clearCache(); }

// ── Helpers ───────────────────────────────────────────────

const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣', '🔔', '⭐'];
const SLOT_PAYOUTS: Record<string, number> = {
  '💎': 10, '7️⃣': 7, '⭐': 5, '🔔': 4, '🍇': 3, '🍊': 2, '🍋': 1.5, '🍒': 1,
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
    const j = Math.floor(Math.random() * (i + 1));
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
  private configCache = new Map<string, DbGuildConfig>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase as any;
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
    const { data } = await (this.supabase as any).from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getBalance(guildId: string, userId: string): Promise<number> {
    const { data } = await (this.supabase as any)
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
      const { error } = await (this.supabase as any).rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: amount,
      });
      if (error) { log.error('economy_add_balance failed:', error.message); return false; }
    } else {
      const { error } = await (this.supabase as any).rpc('economy_subtract_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: Math.abs(amount),
      });
      if (error) { log.error('economy_subtract_balance failed:', error.message); return false; }
    }
    // Track quest progress for any gamble action (win or loss)
    getQuestsManager()?.trackProgress(guildId, userId, 'gamble').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
    return true;
  }

  // V49-M4: Per-user game lock — prevents two concurrent game commands
  // from the same user.  Eliminates the TOCTOU between checkDailyLimit's
  // read and addDailyLoss's increment: the second command gets a "game in
  // progress" rejection before reaching the daily-loss check.
  // Node.js is single-threaded, so a simple Set is safe (has/add/delete
  // are synchronous; no await between check and acquire).
  private activeGames = new Set<string>();

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
    const { data: current } = await (this.supabase as any).rpc('economy_increment_daily_loss', {
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
    const { error } = await (this.supabase as any).rpc('economy_increment_daily_loss', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    });
    if (error) {
      log.error('economy_increment_daily_loss failed:', error);
    }
  }

  private async validateBet(
    interaction: ChatInputCommandInteraction,
    amount: number,
    maxBetKey: keyof DbGuildConfig,
  ): Promise<{ config: DbGuildConfig; balance: number; unlock: () => void } | null> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // V49-M4: Acquire per-user game lock BEFORE any async checks.
    const lockKey = `${guildId}:${userId}`;
    if (this.activeGames.has(lockKey)) {
      await interaction.reply({ content: '⏳ You already have a game in progress! Finish it first.', ephemeral: true });
      return null;
    }
    this.activeGames.add(lockKey);
    const unlock = (): void => { this.activeGames.delete(lockKey); };

    const config = await this.getConfig(guildId);

    if (!config?.economy_games_enabled) {
      unlock();
      await interaction.reply({ content: '❌ Mini-games are not enabled.', ephemeral: true });
      return null;
    }
    if (amount <= 0) {
      unlock();
      await interaction.reply({ content: '❌ Bet must be positive.', ephemeral: true });
      return null;
    }
    const maxBet = (config[maxBetKey] as number) ?? 10000;
    if (amount > maxBet) {
      unlock();
      await interaction.reply({ content: `❌ Max bet is **${maxBet.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    const balance = await this.getBalance(guildId, userId);
    if (balance < amount) {
      unlock();
      await interaction.reply({ content: `❌ You only have **${balance.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    if (!(await this.checkDailyLimit(guildId, userId, config, amount))) {
      unlock();
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

      const win = Math.random() < 0.5;
      const result = Math.random() < 0.5 ? 'Heads' : 'Tails';

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
      v.unlock();
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
        SLOT_SYMBOLS[randomInt(0, SLOT_SYMBOLS.length - 1)],
        SLOT_SYMBOLS[randomInt(0, SLOT_SYMBOLS.length - 1)],
        SLOT_SYMBOLS[randomInt(0, SLOT_SYMBOLS.length - 1)],
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
      v.unlock();
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
      const botChoice = choices[randomInt(0, 2)];

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
      v.unlock();
    }
  }

  // ── Dice ────────────────────────────────────────────────

  async dice(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;

      const playerRoll = randomInt(1, 6) + randomInt(1, 6);
      const botRoll = randomInt(1, 6) + randomInt(1, 6);

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
      v.unlock();
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
          log.error('Blackjack button handler error:', err);
          collector.stop('error');
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
          // Timed out — auto-stand and resolve
          try {
            await this.resolveBlackjackTimeout(interaction, guildId, userId, playerHand, dealerHand, deck, currentBet, doubled);
          } catch (err) {
            log.error('Blackjack timeout resolution error:', err);
          }
        }
      });
    } finally {
      v.unlock();
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

    const number = randomInt(1, 100);
    const nextNumber = randomInt(1, 100);
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
      const grid = Array.from({ length: 9 }, () => symbols[randomInt(0, symbols.length - 1)]);

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
      v.unlock();
    }
  }

  // ── Guess ───────────────────────────────────────────────

  async guess(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    try {
      const guildId = interaction.guildId!;
      const userId = interaction.user.id;

      const target = randomInt(1, 100);
      const playerGuess = interaction.options.getInteger('number') ?? randomInt(1, 100);
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
      v.unlock();
    }
  }
}
