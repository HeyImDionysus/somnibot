/**
 * GamesManager — mini-games: coinflip, slots, rps, dice, blackjack,
 * highlow, scratch, guess. All use virtual currency only.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';

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
  private dailyLosses = new Map<string, number>(); // `guildId:userId` → today's losses

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

  private async getBalance(guildId: string, userId: string): Promise<number> {
    const { data } = await (this.supabase as any)
      .from('economy_wallets')
      .select('balance')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .single();
    return data?.balance ?? 0;
  }

  private async adjustBalance(guildId: string, userId: string, amount: number): Promise<void> {
    if (amount >= 0) {
      await (this.supabase as any).rpc('economy_add_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: amount,
      }).catch(() => {});
    } else {
      await (this.supabase as any).rpc('economy_subtract_balance', {
        p_guild_id: guildId, p_user_id: userId, p_amount: Math.abs(amount),
      }).catch(() => {});
    }
  }

  private checkDailyLimit(guildId: string, userId: string, config: DbGuildConfig, amount: number): boolean {
    const limit = config.economy_daily_loss_limit ?? 0;
    if (limit <= 0) return true; // no limit
    const key = `${guildId}:${userId}`;
    const current = this.dailyLosses.get(key) ?? 0;
    return (current + amount) <= limit;
  }

  private addDailyLoss(guildId: string, userId: string, amount: number): void {
    const key = `${guildId}:${userId}`;
    this.dailyLosses.set(key, (this.dailyLosses.get(key) ?? 0) + amount);
  }

  private async validateBet(
    interaction: ChatInputCommandInteraction,
    amount: number,
    maxBetKey: keyof DbGuildConfig,
  ): Promise<{ config: DbGuildConfig; balance: number } | null> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const config = await this.getConfig(guildId);

    if (!config?.economy_games_enabled) {
      await interaction.reply({ content: '❌ Mini-games are not enabled.', ephemeral: true });
      return null;
    }
    if (amount <= 0) {
      await interaction.reply({ content: '❌ Bet must be positive.', ephemeral: true });
      return null;
    }
    const maxBet = (config[maxBetKey] as number) ?? 10000;
    if (amount > maxBet) {
      await interaction.reply({ content: `❌ Max bet is **${maxBet.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    const balance = await this.getBalance(guildId, userId);
    if (balance < amount) {
      await interaction.reply({ content: `❌ You only have **${balance.toLocaleString()}** coins.`, ephemeral: true });
      return null;
    }
    if (!this.checkDailyLimit(guildId, userId, config, amount)) {
      await interaction.reply({ content: '❌ You\'ve hit your daily loss limit. Try again tomorrow!', ephemeral: true });
      return null;
    }
    return { config, balance };
  }

  // ── Coinflip ────────────────────────────────────────────

  async coinflip(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const win = Math.random() < 0.5;
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails';

    if (win) {
      await this.adjustBalance(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`🪙 ${result}!`)
          .setDescription(`You won **${amount.toLocaleString()}** coins! 🎉`)
          .setColor(0x57F287)],
      });
    } else {
      await this.adjustBalance(guildId, userId, -amount);
      this.addDailyLoss(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`🪙 ${result}!`)
          .setDescription(`You lost **${amount.toLocaleString()}** coins. 😢`)
          .setColor(0xED4245)],
      });
    }
  }

  // ── Slots ───────────────────────────────────────────────

  async slots(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_slots_max_bet');
    if (!v) return;
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
      await this.adjustBalance(guildId, userId, net);
      if (net < 0) this.addDailyLoss(guildId, userId, Math.abs(net));
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎰 Slots')
          .setDescription(`${display}\n\n${multiplier >= 1 ? '🎉' : '🤏'} You ${net >= 0 ? 'won' : 'lost'} **${Math.abs(net).toLocaleString()}** coins! (${multiplier}x)`)
          .setColor(net >= 0 ? 0x57F287 : 0xFEE75C)],
      });
    } else {
      await this.adjustBalance(guildId, userId, -amount);
      this.addDailyLoss(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎰 Slots')
          .setDescription(`${display}\n\nNo match. You lost **${amount.toLocaleString()}** coins. 😢`)
          .setColor(0xED4245)],
      });
    }
  }

  // ── Rock Paper Scissors ─────────────────────────────────

  async rps(interaction: ChatInputCommandInteraction, amount: number, choice: string): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
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
      await this.adjustBalance(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nYou win **${amount.toLocaleString()}** coins! 🎉`).setColor(0x57F287)],
      });
    } else if (result === 'lose') {
      await this.adjustBalance(guildId, userId, -amount);
      this.addDailyLoss(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nYou lost **${amount.toLocaleString()}** coins. 😢`).setColor(0xED4245)],
      });
    } else {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✂️ Rock Paper Scissors').setDescription(`${desc}\n\nIt's a tie! Your coins are returned.`).setColor(0xFEE75C)],
      });
    }
  }

  // ── Dice ────────────────────────────────────────────────

  async dice(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const playerRoll = randomInt(1, 6) + randomInt(1, 6);
    const botRoll = randomInt(1, 6) + randomInt(1, 6);

    if (playerRoll > botRoll) {
      await this.adjustBalance(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\nYou win **${amount.toLocaleString()}** coins! 🎉`).setColor(0x57F287)],
      });
    } else if (playerRoll < botRoll) {
      await this.adjustBalance(guildId, userId, -amount);
      this.addDailyLoss(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`You rolled **${playerRoll}** vs bot's **${botRoll}**\n\nYou lost **${amount.toLocaleString()}** coins. 😢`).setColor(0xED4245)],
      });
    } else {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🎲 Dice Roll').setDescription(`Both rolled **${playerRoll}**! It's a tie.`).setColor(0xFEE75C)],
      });
    }
  }

  // ── Blackjack ───────────────────────────────────────────

  async blackjack(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_blackjack_max_bet');
    if (!v) return;
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const deck = makeDeck();
    const playerHand = [deck.pop()!, deck.pop()!];
    const dealerHand = [deck.pop()!, deck.pop()!];

    // Auto-play: player stands on 17+, hits below
    while (handValue(playerHand) < 17) {
      playerHand.push(deck.pop()!);
    }

    const playerVal = handValue(playerHand);
    let dealerVal = handValue(dealerHand);

    // Dealer hits until 17
    while (dealerVal < 17) {
      dealerHand.push(deck.pop()!);
      dealerVal = handValue(dealerHand);
    }

    let result: string;
    let color: number;
    let net: number;

    if (playerVal > 21) {
      result = `Bust! You went over with **${playerVal}**. Lost **${amount.toLocaleString()}** coins.`;
      color = 0xED4245;
      net = -amount;
    } else if (dealerVal > 21) {
      result = `Dealer busts with **${dealerVal}**! You win **${amount.toLocaleString()}** coins! 🎉`;
      color = 0x57F287;
      net = amount;
    } else if (playerVal === 21 && playerHand.length === 2) {
      const blackjackPayout = Math.floor(amount * 1.5);
      result = `♠️ BLACKJACK! You win **${blackjackPayout.toLocaleString()}** coins! 🎉`;
      color = 0x57F287;
      net = blackjackPayout;
    } else if (playerVal > dealerVal) {
      result = `You win with **${playerVal}** vs dealer's **${dealerVal}**! Won **${amount.toLocaleString()}** coins! 🎉`;
      color = 0x57F287;
      net = amount;
    } else if (playerVal < dealerVal) {
      result = `Dealer wins with **${dealerVal}** vs your **${playerVal}**. Lost **${amount.toLocaleString()}** coins.`;
      color = 0xED4245;
      net = -amount;
    } else {
      result = `Push! Both had **${playerVal}**. Coins returned.`;
      color = 0xFEE75C;
      net = 0;
    }

    if (net !== 0) {
      await this.adjustBalance(guildId, userId, net);
      if (net < 0) this.addDailyLoss(guildId, userId, Math.abs(net));
    }

    const embed = new EmbedBuilder()
      .setTitle('🃏 Blackjack')
      .setDescription(
        `**Your hand:** ${formatHand(playerHand)} (${playerVal})\n` +
        `**Dealer:** ${formatHand(dealerHand)} (${dealerVal})\n\n` +
        result
      )
      .setColor(color);

    await interaction.reply({ embeds: [embed] });
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
      await this.adjustBalance(guildId, userId, net);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎫 Scratch Card')
          .setDescription(`${display}\n\n${matchSymbol} x${maxMatch}! You won **${payout.toLocaleString()}** coins! (${multiplier}x) 🎉`)
          .setColor(0x57F287)],
      });
    } else {
      await this.adjustBalance(guildId, userId, -amount);
      this.addDailyLoss(guildId, userId, amount);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎫 Scratch Card')
          .setDescription(`${display}\n\nNo matches. You lost **${amount.toLocaleString()}** coins. 😢`)
          .setColor(0xED4245)],
      });
    }
  }

  // ── Guess ───────────────────────────────────────────────

  async guess(interaction: ChatInputCommandInteraction, amount: number): Promise<void> {
    const v = await this.validateBet(interaction, amount, 'economy_coinflip_max_bet');
    if (!v) return;
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
      await this.adjustBalance(guildId, userId, net);
      if (net < 0) this.addDailyLoss(guildId, userId, Math.abs(net));
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
  }
}
