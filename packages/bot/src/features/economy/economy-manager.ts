/**
 * EconomyManager — Core wallet + transaction logic for the fake-economy system.
 *
 * Every currency operation (earn, spend, transfer, rob) goes through this class
 * so balances stay consistent and every move is recorded in economy_transactions.
 *
 * IMPORTANT: This is the "fake economy" — virtual currency only.
 * It has ZERO connection to the real-money store/commerce system.
 */
import type { Guild, TextChannel } from 'discord.js';
import { getQuestsManager } from '../quests/quests-manager.js';
import { EmbedBuilder } from 'discord.js';
import type Valkey from 'iovalkey';

// ── Types ─────────────────────────────────────────────────

export interface EconomyConfig {
  economy_enabled: boolean;
  currency_name: string;
  currency_emoji: string;
  economy_starting_balance: number;
  economy_daily_amount: number;
  economy_weekly_amount: number;
  economy_monthly_amount: number;
  economy_streak_bonus_pct: number;
  economy_work_cooldown_seconds: number;
  economy_work_min: number;
  economy_work_max: number;
  economy_crime_success_pct: number;
  economy_crime_fine_pct: number;
  economy_crime_min: number;
  economy_crime_max: number;
  economy_chat_income_enabled: boolean;
  economy_chat_income_min: number;
  economy_chat_income_max: number;
  economy_chat_income_cooldown_seconds: number;
  economy_rob_enabled: boolean;
  economy_rob_success_pct: number;
  economy_rob_fine_pct: number;
  economy_heist_enabled: boolean;
  economy_passive_mode_allowed: boolean;
  economy_pay_tax_pct: number;
  economy_max_wallet: number;
  economy_max_bank: number;
  economy_log_channel_id: string | null;
}

export interface WalletData {
  guild_id: string;
  user_id: string;
  wallet: number;
  bank: number;
  bank_max: number;
  passive: boolean;
  total_earned: number;
  total_spent: number;
}

export interface StreakData {
  current_streak: number;
  longest_streak: number;
  last_claimed_at: string | null;
  next_claim_at: string | null;
}

export interface TransactionResult {
  success: boolean;
  amount: number;
  balance: WalletData;
  message: string;
  streak?: StreakData;
}

// ── Random helpers ────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chance(pct: number): boolean {
  return Math.random() * 100 < pct;
}

// ── Flavor text ───────────────────────────────────────────

const WORK_JOBS = [
  'delivered pizzas',
  'mowed lawns',
  'fixed a leaky faucet',
  'walked dogs at the park',
  'tutored a student in math',
  'worked a shift at the coffee shop',
  'helped move furniture',
  'cleaned out a garage',
  'drove a rideshare',
  'babysat for a neighbor',
  'sold lemonade',
  'painted a fence',
  'organized a community event',
  'washed cars',
  'built a website',
];

const CRIME_SUCCESS = [
  'robbed a convenience store',
  'hacked into an ATM',
  'ran a pyramid scheme',
  'pickpocketed a rich tourist',
  'counterfeited some bills',
  'smuggled exotic goods',
];

const CRIME_FAIL = [
  'got caught by the police',
  'tripped the alarm and had to flee',
  'dropped all the evidence on the way out',
  'the getaway car wouldn\'t start',
  'undercover cop was watching the whole time',
];

const BEG_SUCCESS = [
  'A kind stranger took pity on you',
  'An old man gave you some spare change',
  'Someone felt generous today',
  'A passerby threw you some coins',
  'A dog brought you a coin in its mouth',
];

const BEG_FAIL = [
  'Nobody even looked at you',
  'Someone told you to get a job',
  'A pigeon stole your sign',
  'It started raining and everyone left',
  'You fell asleep on the sidewalk',
];

const SEARCH_LOCATIONS = [
  { name: 'the couch cushions', min: 5, max: 50 },
  { name: 'an old jacket pocket', min: 10, max: 80 },
  { name: 'under the vending machine', min: 1, max: 30 },
  { name: 'a wishing fountain', min: 20, max: 100 },
  { name: 'behind the dumpster', min: 5, max: 60 },
  { name: 'a mysterious briefcase', min: 50, max: 200 },
  { name: 'the gutter', min: 1, max: 20 },
  { name: 'a parking lot', min: 10, max: 40 },
];

const SEARCH_EMPTY = [
  'You searched everywhere but found nothing.',
  'Better luck next time — the search turned up empty.',
  'You looked high and low but came back empty-handed.',
];

// ── Manager class ─────────────────────────────────────────

export class EconomyManager {
  private configCache: EconomyConfig | null = null;
  private configCacheTTL = 30_000; // 30s
  private configCacheTime = 0;

  constructor(
    private guild: Guild,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase client (economy tables not in generated schema yet)
    private supabase: any,
    private valkey: Valkey,
  ) {}

  // ── Config ──────────────────────────────────────────────

  async loadConfig(): Promise<EconomyConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCacheTime < this.configCacheTTL) {
      return this.configCache;
    }

    const { data } = await this.supabase
      .from('guild_config')
      .select(
        'economy_enabled, currency_name, currency_emoji, economy_starting_balance, ' +
        'economy_daily_amount, economy_weekly_amount, economy_monthly_amount, ' +
        'economy_streak_bonus_pct, economy_work_cooldown_seconds, economy_work_min, ' +
        'economy_work_max, economy_crime_success_pct, economy_crime_fine_pct, ' +
        'economy_crime_min, economy_crime_max, economy_chat_income_enabled, ' +
        'economy_chat_income_min, economy_chat_income_max, economy_chat_income_cooldown_seconds, ' +
        'economy_rob_enabled, economy_rob_success_pct, economy_rob_fine_pct, ' +
        'economy_heist_enabled, economy_passive_mode_allowed, economy_pay_tax_pct, ' +
        'economy_max_wallet, economy_max_bank, economy_log_channel_id',
      )
      .eq('guild_id', this.guild.id)
      .maybeSingle();

    this.configCache = {
      economy_enabled: data?.economy_enabled ?? false,
      currency_name: data?.currency_name ?? 'Coins',
      currency_emoji: data?.currency_emoji ?? '🪙',
      economy_starting_balance: data?.economy_starting_balance ?? 0,
      economy_daily_amount: data?.economy_daily_amount ?? 500,
      economy_weekly_amount: data?.economy_weekly_amount ?? 3500,
      economy_monthly_amount: data?.economy_monthly_amount ?? 15000,
      economy_streak_bonus_pct: data?.economy_streak_bonus_pct ?? 5,
      economy_work_cooldown_seconds: data?.economy_work_cooldown_seconds ?? 1800,
      economy_work_min: data?.economy_work_min ?? 100,
      economy_work_max: data?.economy_work_max ?? 500,
      economy_crime_success_pct: data?.economy_crime_success_pct ?? 40,
      economy_crime_fine_pct: data?.economy_crime_fine_pct ?? 50,
      economy_crime_min: data?.economy_crime_min ?? 200,
      economy_crime_max: data?.economy_crime_max ?? 1000,
      economy_chat_income_enabled: data?.economy_chat_income_enabled ?? false,
      economy_chat_income_min: data?.economy_chat_income_min ?? 5,
      economy_chat_income_max: data?.economy_chat_income_max ?? 15,
      economy_chat_income_cooldown_seconds: data?.economy_chat_income_cooldown_seconds ?? 60,
      economy_rob_enabled: data?.economy_rob_enabled ?? true,
      economy_rob_success_pct: data?.economy_rob_success_pct ?? 35,
      economy_rob_fine_pct: data?.economy_rob_fine_pct ?? 50,
      economy_heist_enabled: data?.economy_heist_enabled ?? true,
      economy_passive_mode_allowed: data?.economy_passive_mode_allowed ?? true,
      economy_pay_tax_pct: data?.economy_pay_tax_pct ?? 0,
      economy_max_wallet: data?.economy_max_wallet ?? 0,
      economy_max_bank: data?.economy_max_bank ?? 0,
      economy_log_channel_id: data?.economy_log_channel_id ?? null,
    };
    this.configCacheTime = now;
    return this.configCache;
  }

  invalidateConfig(): void {
    this.configCache = null;
    this.configCacheTime = 0;
  }

  // ── Wallet operations ───────────────────────────────────

  async getOrCreateWallet(userId: string): Promise<WalletData> {
    const { data: existing } = await this.supabase
      .from('economy_wallets')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) return existing as WalletData;

    const cfg = await this.loadConfig();
    const startBal = cfg.economy_starting_balance;

    const { data: created } = await this.supabase
      .from('economy_wallets')
      .upsert(
        {
          guild_id: this.guild.id,
          user_id: userId,
          wallet: startBal,
          bank: 0,
          bank_max: 10000,
          passive: false,
          total_earned: startBal,
          total_spent: 0,
        },
        { onConflict: 'guild_id,user_id' },
      )
      .select('*')
      .single();

    if (startBal > 0 && created) {
      await this.recordTransaction(userId, 'admin_add', startBal, startBal, 'Starting balance');
    }

    return (created ?? {
      guild_id: this.guild.id,
      user_id: userId,
      wallet: startBal,
      bank: 0,
      bank_max: 10000,
      passive: false,
      total_earned: startBal,
      total_spent: 0,
    }) as WalletData;
  }

  /**
   * Atomically credit a user's wallet via RPC. Returns updated wallet data.
   * Uses economy_add_balance to avoid TOCTOU race conditions.
   */
  async creditWallet(userId: string, amount: number): Promise<WalletData> {
    // Ensure wallet exists before RPC call
    await this.getOrCreateWallet(userId);

    const { error } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) {
      console.error('[Economy] creditWallet RPC error:', error);
    }

    // Re-read wallet to get updated state (RPC doesn't return row)
    return this.getOrCreateWallet(userId);
  }

  /**
   * Atomically debit a user's wallet via RPC. Fails if insufficient funds.
   * Uses economy_subtract_balance to avoid TOCTOU race conditions.
   */
  async debitWallet(userId: string, amount: number): Promise<WalletData | null> {
    // Ensure wallet exists before RPC call
    const wallet = await this.getOrCreateWallet(userId);
    if (wallet.wallet < amount) return null;

    const { error } = await this.supabase.rpc('economy_subtract_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) {
      // RPC raises exception on insufficient funds
      console.warn('[Economy] debitWallet RPC failed (likely insufficient funds):', error.message);
      return null;
    }

    // Re-read wallet to get updated state
    return this.getOrCreateWallet(userId);
  }

  async deposit(userId: string, amount: number): Promise<TransactionResult> {
    const wallet = await this.getOrCreateWallet(userId);
    const cfg = await this.loadConfig();

    if (wallet.wallet < amount) {
      return { success: false, amount: 0, balance: wallet, message: "You don't have that much in your wallet." };
    }

    const maxDeposit = wallet.bank_max - wallet.bank;
    if (maxDeposit <= 0) {
      return { success: false, amount: 0, balance: wallet, message: 'Your bank is full!' };
    }

    const requestedAmount = Math.min(amount, maxDeposit);

    // Atomic bank deposit — debits wallet + credits bank in a single FOR UPDATE txn
    const { data: actualAmount, error: depositErr } = await this.supabase.rpc('economy_bank_deposit', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: requestedAmount,
    });

    if (depositErr || !actualAmount || actualAmount <= 0) {
      return { success: false, amount: 0, balance: wallet, message: "You don't have that much in your wallet." };
    }

    const updated = await this.getOrCreateWallet(userId);
    await this.recordTransaction(userId, 'deposit', -actualAmount, updated.wallet, `Deposited ${actualAmount} to bank`);

    return {
      success: true,
      amount: actualAmount,
      balance: updated,
      message: `${cfg.currency_emoji} Deposited **${actualAmount.toLocaleString()} ${cfg.currency_name}** to your bank.`,
    };
  }

  async withdraw(userId: string, amount: number): Promise<TransactionResult> {
    const wallet = await this.getOrCreateWallet(userId);
    const cfg = await this.loadConfig();

    if (wallet.bank < amount) {
      return { success: false, amount: 0, balance: wallet, message: "You don't have that much in your bank." };
    }

    // Atomic bank withdraw — debits bank + credits wallet in a single FOR UPDATE txn
    const { data: actualAmount, error: withdrawErr } = await this.supabase.rpc('economy_bank_withdraw', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: amount,
      p_max_wallet: cfg.economy_max_wallet,
    });

    if (withdrawErr || !actualAmount || actualAmount <= 0) {
      return { success: false, amount: 0, balance: wallet, message: 'Failed to withdraw.' };
    }

    const updated = await this.getOrCreateWallet(userId);
    await this.recordTransaction(userId, 'withdraw', actualAmount, updated.wallet, `Withdrew ${actualAmount} from bank`);

    return {
      success: true,
      amount: actualAmount,
      balance: updated,
      message: `${cfg.currency_emoji} Withdrew **${actualAmount.toLocaleString()} ${cfg.currency_name}** from your bank.`,
    };
  }

  // ── Earning commands ────────────────────────────────────

  async claimTimedReward(
    userId: string,
    type: 'daily' | 'weekly' | 'monthly',
  ): Promise<TransactionResult> {
    const cfg = await this.loadConfig();
    const amounts: Record<string, number> = {
      daily: cfg.economy_daily_amount,
      weekly: cfg.economy_weekly_amount,
      monthly: cfg.economy_monthly_amount,
    };
    const intervals: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };
    const streakWindows: Record<string, number> = {
      daily: 48 * 60 * 60 * 1000,     // Must claim within 48h for streak
      weekly: 14 * 24 * 60 * 60 * 1000, // Within 14 days
      monthly: 60 * 24 * 60 * 60 * 1000, // Within 60 days
    };

    // V48-M1: atomic cooldown claim. /daily, /weekly, /monthly all
    // grant large rewards — a double-fire from a click race would be
    // worth real coins, so claim the slot via SET NX before crediting.
    const cooldownKey = `economy:${this.guild.id}:${userId}:${type}`;
    const cooldownMs = intervals[type];
    const expiresAt = Date.now() + cooldownMs;
    const claimedSlot = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimedSlot) {
      const lastClaim = await this.valkey.get(cooldownKey);
      const remaining = lastClaim ? parseInt(lastClaim, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(userId);
      const hours = Math.max(0, Math.floor(remaining / 3600000));
      const mins = Math.max(0, Math.floor((remaining % 3600000) / 60000));
      return {
        success: false,
        amount: 0,
        balance: wallet,
        message: `⏰ You already claimed your ${type} reward. Come back in **${hours}h ${mins}m**.`,
      };
    }

    // Get/update streak
    const { data: streakRow } = await this.supabase
      .from('economy_streaks')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('streak_type', type)
      .maybeSingle();

    let currentStreak = 0;
    const now = new Date();

    if (streakRow?.last_claimed_at) {
      const lastTime = new Date(streakRow.last_claimed_at).getTime();
      const sinceLastClaim = now.getTime() - lastTime;
      // If within the streak window, continue streak; otherwise reset
      if (sinceLastClaim <= streakWindows[type]) {
        currentStreak = (streakRow.current_streak ?? 0) + 1;
      } else {
        currentStreak = 1;
      }
    } else {
      currentStreak = 1;
    }

    const longestStreak = Math.max(currentStreak, streakRow?.longest_streak ?? 0);
    const baseAmount = amounts[type];
    const streakBonus = Math.floor(baseAmount * ((currentStreak - 1) * cfg.economy_streak_bonus_pct / 100));
    const totalAmount = baseAmount + streakBonus;

    // Credit wallet
    const updated = await this.creditWallet(userId, totalAmount);

    // Update streak
    const nextClaimAt = new Date(now.getTime() + intervals[type]).toISOString();
    await this.supabase
      .from('economy_streaks')
      .upsert(
        {
          guild_id: this.guild.id,
          user_id: userId,
          streak_type: type,
          current_streak: currentStreak,
          longest_streak: longestStreak,
          last_claimed_at: now.toISOString(),
          next_claim_at: nextClaimAt,
        },
        { onConflict: 'guild_id,user_id,streak_type' },
      );

    // (V48-M1) cooldown already claimed atomically above

    // Record transaction
    await this.recordTransaction(
      userId,
      type,
      totalAmount,
      updated.wallet,
      `${type} reward (streak: ${currentStreak})`,
    );

    // Log
    await this.logEconomyEvent(userId, `${type} claim`, totalAmount);

    let msg = `${cfg.currency_emoji} You claimed your **${type}** reward: **+${totalAmount.toLocaleString()} ${cfg.currency_name}**`;
    if (streakBonus > 0) {
      msg += `\n🔥 **${currentStreak}-day streak!** (+${streakBonus.toLocaleString()} bonus)`;
    }
    if (currentStreak === 1) {
      msg += `\n💫 Streak started! Come back ${type === 'daily' ? 'tomorrow' : `next ${type.replace('ly', '')}`} to keep it going.`;
    }

    return {
      success: true,
      amount: totalAmount,
      balance: updated,
      message: msg,
      streak: {
        current_streak: currentStreak,
        longest_streak: longestStreak,
        last_claimed_at: now.toISOString(),
        next_claim_at: nextClaimAt,
      },
    };
  }

  async work(userId: string): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    // V48-M1: atomic SET NX cooldown claim. The previous read-check-set
    // pattern allowed two concurrent /work invocations from the same
    // user to both pass the check before either wrote the cooldown,
    // doubling the payout. SET NX returns null on race-loser so we can
    // tell them to wait without paying anyone twice.
    const cooldownKey = `economy:${this.guild.id}:${userId}:work`;
    const cooldownMs = cfg.economy_work_cooldown_seconds * 1000;
    const expiresAt = Date.now() + cooldownMs;
    const claimed = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimed) {
      const lastWork = await this.valkey.get(cooldownKey);
      const remaining = lastWork ? parseInt(lastWork, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(userId);
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      return { success: false, amount: 0, balance: wallet, message: `⏰ You need to rest before working again. Try again in **${mins}m**.` };
    }

    const amount = randInt(cfg.economy_work_min, cfg.economy_work_max);
    const job = WORK_JOBS[Math.floor(Math.random() * WORK_JOBS.length)];
    const updated = await this.creditWallet(userId, amount);

    await this.recordTransaction(userId, 'work', amount, updated.wallet, `Worked: ${job}`);
    await this.logEconomyEvent(userId, 'work', amount);
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'work').catch(() => {});

    return {
      success: true,
      amount,
      balance: updated,
      message: `${cfg.currency_emoji} You ${job} and earned **${amount.toLocaleString()} ${cfg.currency_name}**!`,
    };
  }

  async crime(userId: string): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    // V48-M1: atomic cooldown claim (see /work). Crime cooldown is set
    // up-front, win or lose; failing the chance still consumes it.
    const cooldownKey = `economy:${this.guild.id}:${userId}:crime`;
    const cooldownMs = Math.floor(cfg.economy_work_cooldown_seconds * 1.5) * 1000;
    const expiresAt = Date.now() + cooldownMs;
    const claimed = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimed) {
      const lastCrime = await this.valkey.get(cooldownKey);
      const remaining = lastCrime ? parseInt(lastCrime, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(userId);
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      return { success: false, amount: 0, balance: wallet, message: `⏰ You need to lay low for a bit. Try again in **${mins}m**.` };
    }

    if (chance(cfg.economy_crime_success_pct)) {
      // Success
      const amount = randInt(cfg.economy_crime_min, cfg.economy_crime_max);
      const updated = await this.creditWallet(userId, amount);
      const story = CRIME_SUCCESS[Math.floor(Math.random() * CRIME_SUCCESS.length)];

      await this.recordTransaction(userId, 'crime', amount, updated.wallet, `Crime success: ${story}`);
      await this.logEconomyEvent(userId, 'crime (success)', amount);
      getQuestsManager()?.trackProgress(this.guild.id, userId, 'crime').catch(() => {});

      return {
        success: true,
        amount,
        balance: updated,
        message: `${cfg.currency_emoji} You ${story} and got away with **${amount.toLocaleString()} ${cfg.currency_name}**!`,
      };
    } else {
      // Fail — pay fine
      const wallet = await this.getOrCreateWallet(userId);
      const fine = Math.floor(wallet.wallet * (cfg.economy_crime_fine_pct / 100));
      const updated = fine > 0 ? (await this.debitWallet(userId, fine)) ?? wallet : wallet;
      const story = CRIME_FAIL[Math.floor(Math.random() * CRIME_FAIL.length)];

      if (fine > 0) {
        await this.recordTransaction(userId, 'crime', -fine, updated.wallet, `Crime failed: ${story}`);
      }
      await this.logEconomyEvent(userId, 'crime (fail)', -fine);

      return {
        success: false,
        amount: -fine,
        balance: updated,
        message: fine > 0
          ? `🚨 You ${story} and paid a fine of **${fine.toLocaleString()} ${cfg.currency_name}**.`
          : `🚨 You ${story}! Lucky you had no money to lose.`,
      };
    }
  }

  async beg(userId: string): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    // V48-M1: atomic cooldown claim.
    const cooldownKey = `economy:${this.guild.id}:${userId}:beg`;
    const cooldownMs = 120_000; // 2 min
    const expiresAt = Date.now() + cooldownMs;
    const claimed = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimed) {
      const lastBeg = await this.valkey.get(cooldownKey);
      const remaining = lastBeg ? parseInt(lastBeg, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(userId);
      const secs = Math.max(1, Math.ceil(remaining / 1000));
      return { success: false, amount: 0, balance: wallet, message: `⏰ You can beg again in **${secs}s**.` };
    }

    if (chance(60)) {
      // Success
      const amount = randInt(1, 50);
      const updated = await this.creditWallet(userId, amount);
      const story = BEG_SUCCESS[Math.floor(Math.random() * BEG_SUCCESS.length)];

      await this.recordTransaction(userId, 'beg', amount, updated.wallet, `Begged: ${story}`);

      return {
        success: true,
        amount,
        balance: updated,
        message: `${cfg.currency_emoji} ${story} and gave you **${amount.toLocaleString()} ${cfg.currency_name}**.`,
      };
    } else {
      const wallet = await this.getOrCreateWallet(userId);
      const story = BEG_FAIL[Math.floor(Math.random() * BEG_FAIL.length)];
      return { success: false, amount: 0, balance: wallet, message: `😢 ${story}` };
    }
  }

  async search(userId: string): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    // V48-M1: atomic cooldown claim.
    const cooldownKey = `economy:${this.guild.id}:${userId}:search`;
    const cooldownMs = 180_000;
    const expiresAt = Date.now() + cooldownMs;
    const claimed = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimed) {
      const lastSearch = await this.valkey.get(cooldownKey);
      const remaining = lastSearch ? parseInt(lastSearch, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(userId);
      const secs = Math.max(1, Math.ceil(remaining / 1000));
      return { success: false, amount: 0, balance: wallet, message: `⏰ You can search again in **${secs}s**.` };
    }

    if (chance(65)) {
      const loc = SEARCH_LOCATIONS[Math.floor(Math.random() * SEARCH_LOCATIONS.length)];
      const amount = randInt(loc.min, loc.max);
      const updated = await this.creditWallet(userId, amount);

      await this.recordTransaction(userId, 'search', amount, updated.wallet, `Searched ${loc.name}`);

      return {
        success: true,
        amount,
        balance: updated,
        message: `${cfg.currency_emoji} You searched ${loc.name} and found **${amount.toLocaleString()} ${cfg.currency_name}**!`,
      };
    } else {
      const wallet = await this.getOrCreateWallet(userId);
      const msg = SEARCH_EMPTY[Math.floor(Math.random() * SEARCH_EMPTY.length)];
      return { success: false, amount: 0, balance: wallet, message: `🔍 ${msg}` };
    }
  }

  // ── Pay / Transfer ──────────────────────────────────────

  async pay(
    senderId: string,
    receiverId: string,
    amount: number,
  ): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    if (senderId === receiverId) {
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: "You can't pay yourself." };
    }
    if (amount <= 0) {
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: 'Amount must be positive.' };
    }

    const senderWallet = await this.getOrCreateWallet(senderId);
    if (senderWallet.wallet < amount) {
      return { success: false, amount: 0, balance: senderWallet, message: "You don't have enough in your wallet." };
    }

    // Calculate tax
    const tax = cfg.economy_pay_tax_pct > 0
      ? Math.floor(amount * (cfg.economy_pay_tax_pct / 100))
      : 0;
    const received = amount - tax;

    // Debit sender
    const updatedSender = await this.debitWallet(senderId, amount);
    if (!updatedSender) {
      return { success: false, amount: 0, balance: senderWallet, message: "You don't have enough in your wallet." };
    }

    // Credit receiver
    await this.creditWallet(receiverId, received);

    await this.recordTransaction(senderId, 'pay_send', -amount, updatedSender.wallet, `Paid <@${receiverId}>`);
    await this.recordTransaction(receiverId, 'pay_receive', received, (await this.getOrCreateWallet(receiverId)).wallet, `Received from <@${senderId}>`);
    await this.logEconomyEvent(senderId, `paid ${receiverId}`, amount);

    let msg = `${cfg.currency_emoji} Sent **${amount.toLocaleString()} ${cfg.currency_name}** to <@${receiverId}>.`;
    if (tax > 0) {
      msg += `\n💸 Tax: **${tax.toLocaleString()}** (${cfg.economy_pay_tax_pct}%)`;
      msg += `\n📬 They received: **${received.toLocaleString()} ${cfg.currency_name}**`;
    }

    return { success: true, amount, balance: updatedSender, message: msg };
  }

  // ── Rob ─────────────────────────────────────────────────

  async rob(robberId: string, victimId: string): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    if (!cfg.economy_rob_enabled) {
      const wallet = await this.getOrCreateWallet(robberId);
      return { success: false, amount: 0, balance: wallet, message: '🚫 Robbing is disabled on this server.' };
    }

    if (robberId === victimId) {
      const wallet = await this.getOrCreateWallet(robberId);
      return { success: false, amount: 0, balance: wallet, message: "You can't rob yourself." };
    }

    // 10 min cooldown
    const cooldownKey = `economy:${this.guild.id}:${robberId}:rob`;
    const lastRob = await this.valkey.get(cooldownKey);
    if (lastRob) {
      const remaining = parseInt(lastRob, 10) - Date.now();
      if (remaining > 0) {
        const wallet = await this.getOrCreateWallet(robberId);
        const mins = Math.ceil(remaining / 60000);
        return { success: false, amount: 0, balance: wallet, message: `⏰ You need to wait **${mins}m** before robbing again.` };
      }
    }

    const robberWallet = await this.getOrCreateWallet(robberId);
    const victimWallet = await this.getOrCreateWallet(victimId);

    // Check passive mode
    if (robberWallet.passive) {
      return { success: false, amount: 0, balance: robberWallet, message: '🛡️ You have passive mode enabled. Disable it first with `/passive`.' };
    }
    if (victimWallet.passive) {
      return { success: false, amount: 0, balance: robberWallet, message: '🛡️ That user has passive mode enabled. You cannot rob them.' };
    }

    if (victimWallet.wallet < 50) {
      return { success: false, amount: 0, balance: robberWallet, message: "They don't have enough to rob (minimum 50 in wallet)." };
    }

    // Check for padlock item
    const { data: padlock } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity')
      .eq('guild_id', this.guild.id)
      .eq('user_id', victimId)
      .eq('item_id', (await this.findItemByEffect('padlock'))?.id ?? '00000000-0000-0000-0000-000000000000')
      .gt('quantity', 0)
      .maybeSingle();

    if (padlock && padlock.quantity > 0) {
      // V47-M3: atomic decrement returns boolean. If a concurrent rob already
      // consumed the last padlock the RPC returns false — in that case the
      // padlock did NOT block THIS attempt and we must fall through to the
      // normal rob outcome instead of pretending it did.
      const padlockItemId = (await this.findItemByEffect('padlock'))?.id;
      let padlockConsumed = false;
      if (padlockItemId) {
        const { data: consumed } = await this.supabase.rpc('economy_decrement_inventory', {
          p_guild_id: this.guild.id,
          p_user_id: victimId,
          p_item_id: padlockItemId,
          p_quantity: 1,
        });
        padlockConsumed = consumed === true;
      }

      if (padlockConsumed) {
        const cooldownMs = 600_000;
        await this.valkey.set(cooldownKey, String(Date.now() + cooldownMs), 'PX', cooldownMs);

        return { success: false, amount: 0, balance: robberWallet, message: `🔒 <@${victimId}>'s padlock blocked your robbery attempt! The padlock was consumed.` };
      }
      // padlock raced out — fall through to normal rob attempt
    }

    const cooldownMs = 600_000;
    await this.valkey.set(cooldownKey, String(Date.now() + cooldownMs), 'PX', cooldownMs);

    if (chance(cfg.economy_rob_success_pct)) {
      // Success — steal 10-50% of their wallet
      const stealPct = randInt(10, 50);
      const stolen = Math.floor(victimWallet.wallet * (stealPct / 100));

      await this.debitWallet(victimId, stolen);
      const updatedRobber = await this.creditWallet(robberId, stolen);

      await this.recordTransaction(robberId, 'rob_success', stolen, updatedRobber.wallet, `Robbed <@${victimId}>`);
      await this.recordTransaction(victimId, 'rob_victim', -stolen, (await this.getOrCreateWallet(victimId)).wallet, `Robbed by <@${robberId}>`);
      await this.logEconomyEvent(robberId, `robbed ${victimId}`, stolen);

      return {
        success: true,
        amount: stolen,
        balance: updatedRobber,
        message: `${cfg.currency_emoji} You robbed <@${victimId}> and stole **${stolen.toLocaleString()} ${cfg.currency_name}**!`,
      };
    } else {
      // Fail — pay fine to victim
      const fine = Math.floor(robberWallet.wallet * (cfg.economy_rob_fine_pct / 100));
      if (fine > 0) {
        await this.debitWallet(robberId, fine);
        await this.creditWallet(victimId, fine);
        await this.recordTransaction(robberId, 'rob_fail', -fine, (await this.getOrCreateWallet(robberId)).wallet, `Failed robbery on <@${victimId}>`);
      }

      const updatedRobber = await this.getOrCreateWallet(robberId);
      return {
        success: false,
        amount: -fine,
        balance: updatedRobber,
        message: fine > 0
          ? `🚨 You got caught trying to rob <@${victimId}> and paid a **${fine.toLocaleString()} ${cfg.currency_name}** fine!`
          : `🚨 You got caught trying to rob <@${victimId}>! Lucky you had no money to lose.`,
      };
    }
  }

  // ── Passive mode ────────────────────────────────────────

  async togglePassive(userId: string): Promise<{ enabled: boolean; message: string }> {
    const cfg = await this.loadConfig();
    if (!cfg.economy_passive_mode_allowed) {
      return { enabled: false, message: '🚫 Passive mode is disabled on this server.' };
    }

    const wallet = await this.getOrCreateWallet(userId);
    const newState = !wallet.passive;

    await this.supabase
      .from('economy_wallets')
      .update({ passive: newState, updated_at: new Date().toISOString() })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId);

    return {
      enabled: newState,
      message: newState
        ? '🛡️ Passive mode **enabled**. You can\'t be robbed, but you also can\'t rob or gamble.'
        : '⚔️ Passive mode **disabled**. You can now rob and gamble, but others can rob you too.',
    };
  }

  // ── Shop operations ─────────────────────────────────────

  async getShopItems(category?: string): Promise<Array<{ id: string; name: string; description: string | null; emoji: string; category: string; price: number; stock: number | null }>> {
    let query = this.supabase
      .from('economy_items')
      .select('id, name, description, emoji, category, price, stock')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('price', { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    const { data } = await query;
    return (data ?? []) as Array<{ id: string; name: string; description: string | null; emoji: string; category: string; price: number; stock: number | null }>;
  }

  async buyItem(userId: string, itemId: string, quantity: number = 1): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    const { data: item } = await this.supabase
      .from('economy_items')
      .select('*')
      .eq('id', itemId)
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .single();

    if (!item) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Item not found.' };
    }

    // Stock check (preliminary — final atomic check happens after payment)
    if (item.stock !== null && item.stock < quantity) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: `❌ Only **${item.stock}** left in stock.` };
    }

    // Max per user check
    if (item.max_per_user !== null) {
      const { data: inv } = await this.supabase
        .from('economy_inventory')
        .select('quantity')
        .eq('guild_id', this.guild.id)
        .eq('user_id', userId)
        .eq('item_id', itemId)
        .maybeSingle();

      const owned = inv?.quantity ?? 0;
      if (owned + quantity > item.max_per_user) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: `❌ You can only own **${item.max_per_user}** of this item (you have ${owned}).` };
      }
    }

    // Role requirement check
    if (item.require_role_id) {
      const member = this.guild.members.cache.get(userId);
      if (member && !member.roles.cache.has(item.require_role_id)) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: `❌ You need the <@&${item.require_role_id}> role to buy this.` };
      }
    }

    const totalCost = item.price * quantity;
    const wallet = await this.debitWallet(userId, totalCost);
    if (!wallet) {
      const w = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: w, message: `${cfg.currency_emoji} You need **${totalCost.toLocaleString()} ${cfg.currency_name}** but only have **${w.wallet.toLocaleString()}**.` };
    }

    // Reduce stock atomically (prevents overselling via TOCTOU)
    if (item.stock !== null) {
      const { data: stockOk } = await this.supabase.rpc('economy_decrement_stock', {
        p_item_id: itemId,
        p_quantity: quantity,
      });
      if (!stockOk) {
        // Refund the wallet debit
        await this.creditWallet(userId, totalCost);
        const w = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: w, message: `❌ Item went out of stock.` };
      }
    }

    // Add to inventory atomically (prevents TOCTOU on quantity)
    await this.supabase.rpc('economy_upsert_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: itemId,
      p_quantity: quantity,
      p_durability: item.durability,
    });

    // Grant role if applicable
    if (item.grant_role_id) {
      try {
        const member = await this.guild.members.fetch(userId);
        await member.roles.add(item.grant_role_id, `Purchased ${item.name} from economy shop`);
      } catch (err) {
        console.warn(`[Economy] Failed to grant role ${item.grant_role_id}:`, err);
      }
    }

    await this.recordTransaction(userId, 'shop_buy', -totalCost, wallet.wallet, `Bought ${quantity}x ${item.name}`);
    await this.logEconomyEvent(userId, `bought ${quantity}x ${item.name}`, -totalCost);
    getQuestsManager()?.trackProgress(this.guild.id, userId, 'shop_buy', quantity).catch(() => {});

    return {
      success: true,
      amount: totalCost,
      balance: wallet,
      message: `${item.emoji} Bought **${quantity}x ${item.name}** for **${totalCost.toLocaleString()} ${cfg.currency_name}**!`,
    };
  }

  async sellItem(userId: string, itemId: string, quantity: number = 1): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    const { data: item } = await this.supabase
      .from('economy_items')
      .select('*')
      .eq('id', itemId)
      .eq('guild_id', this.guild.id)
      .single();

    if (!item) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Item not found.' };
    }

    if (item.sell_price <= 0) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ This item cannot be sold.' };
    }

    // Check inventory quantity (for error message)
    const { data: inv } = await this.supabase
      .from('economy_inventory')
      .select('id, quantity')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .maybeSingle();

    if (!inv || inv.quantity < quantity) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: `❌ You only have **${inv?.quantity ?? 0}** of this item.` };
    }

    const totalValue = item.sell_price * quantity;

    // Remove from inventory atomically (prevents TOCTOU)
    const { data: decremented } = await this.supabase.rpc('economy_decrement_inventory', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: itemId,
      p_quantity: quantity,
    });
    if (!decremented) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: `❌ You don't have enough of this item.` };
    }

    // Credit wallet
    const updated = await this.creditWallet(userId, totalValue);

    await this.recordTransaction(userId, 'shop_sell', totalValue, updated.wallet, `Sold ${quantity}x ${item.name}`);

    return {
      success: true,
      amount: totalValue,
      balance: updated,
      message: `${item.emoji} Sold **${quantity}x ${item.name}** for **${totalValue.toLocaleString()} ${cfg.currency_name}**!`,
    };
  }

  async getInventory(userId: string): Promise<Array<{ item_name: string; item_emoji: string; quantity: number; item_id: string; durability_remaining: number | null }>> {
    const { data } = await this.supabase
      .from('economy_inventory')
      .select('quantity, durability_remaining, item_id, economy_items(name, emoji)')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .gt('quantity', 0);

    return (data ?? []).map((row: Record<string, unknown>) => {
      const item = row.economy_items as Record<string, string> | null;
      return {
        item_name: item?.name ?? 'Unknown',
        item_emoji: item?.emoji ?? '📦',
        quantity: row.quantity as number,
        item_id: row.item_id as string,
        durability_remaining: row.durability_remaining as number | null,
      };
    });
  }

  // ── Chat income ─────────────────────────────────────────

  async processChatIncome(userId: string, channelId: string): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg.economy_enabled || !cfg.economy_chat_income_enabled) return;

    // Cooldown
    const cooldownKey = `economy:${this.guild.id}:${userId}:chat_income`;
    const last = await this.valkey.get(cooldownKey);
    if (last) return; // Still on cooldown

    const amount = randInt(cfg.economy_chat_income_min, cfg.economy_chat_income_max);
    if (amount <= 0) return;

    const updated = await this.creditWallet(userId, amount);

    const cooldownMs = cfg.economy_chat_income_cooldown_seconds * 1000;
    await this.valkey.set(cooldownKey, '1', 'PX', cooldownMs);

    await this.recordTransaction(userId, 'chat_income', amount, updated.wallet, 'Chat income');
  }

  // ── Leaderboard ─────────────────────────────────────────

  async getLeaderboard(limit: number = 10): Promise<Array<{ user_id: string; net_worth: number; wallet: number; bank: number }>> {
    // Fetch extra rows to account for users with high bank but low wallet,
    // then sort by net_worth (wallet + bank) and take top N.
    const fetchLimit = Math.max(limit * 5, 50);
    const { data } = await this.supabase
      .from('economy_wallets')
      .select('user_id, wallet, bank')
      .eq('guild_id', this.guild.id)
      .limit(fetchLimit);

    return (data ?? []).map((row: Record<string, unknown>) => ({
      user_id: row.user_id as string,
      net_worth: (row.wallet as number) + (row.bank as number),
      wallet: row.wallet as number,
      bank: row.bank as number,
    })).sort((a: { net_worth: number }, b: { net_worth: number }) => b.net_worth - a.net_worth).slice(0, limit);
  }

  // ── Internal helpers ────────────────────────────────────

  private async recordTransaction(
    userId: string,
    type: string,
    amount: number,
    balanceAfter: number,
    description: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.supabase.from('economy_transactions').insert({
        guild_id: this.guild.id,
        user_id: userId,
        type,
        amount,
        balance_after: balanceAfter,
        description,
        metadata: metadata ?? null,
      });
    } catch (err) {
      console.error('[Economy] Failed to record transaction:', err);
    }
  }

  private async logEconomyEvent(userId: string, action: string, amount: number): Promise<void> {
    try {
      const cfg = await this.loadConfig();
      if (!cfg.economy_log_channel_id) return;

      const channel = this.guild.channels.cache.get(cfg.economy_log_channel_id) as TextChannel | undefined;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setColor(amount >= 0 ? 0x2ecc71 : 0xe74c3c)
        .setDescription(`<@${userId}> — ${action}: **${amount >= 0 ? '+' : ''}${amount.toLocaleString()} ${cfg.currency_name}**`)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch {
      // Non-fatal
    }
  }

  private async findItemByEffect(effectType: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase
      .from('economy_items')
      .select('id')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .contains('use_effect', { type: effectType })
      .limit(1)
      .maybeSingle();

    return data as { id: string } | null;
  }
}
