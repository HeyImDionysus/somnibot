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
import { createLogger } from '@somnibot/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { eventBus } from '../../services/event-bus.js';

const log = createLogger('Economy');

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

// ── Random helpers (crypto-backed) ────────────────────────
// V5C-6: Replaced Math.random() with crypto.randomInt() so game
// outcomes (work, crime, beg, search) are not predictable from
// V8's PRNG state. This is a defense-in-depth measure — the
// economy is virtual currency only, but crypto randomness
// prevents even theoretical outcome prediction.

function randInt(min: number, max: number): number {
  // Guard against undefined/NaN from incomplete configs — fall back to 0..0
  const lo = Number.isSafeInteger(min) ? min : 0;
  const hi = Number.isSafeInteger(max) ? max : lo;
  if (lo > hi) return lo;
  return randomInt(lo, hi + 1); // randomInt upper bound is exclusive
}

function chance(pct: number): boolean {
  const p = typeof pct === 'number' && !Number.isNaN(pct) ? pct : 0;
  return randomInt(0, 10000) < p * 100;
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
  private configCacheTTL = 10_000; // 10s — V5 Audit §4.P3b: reduced from 30s to narrow stale-config window
  private configCacheTime = 0;

  constructor(
    private guild: Guild,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase client (economy tables not in generated schema yet)
    private supabase: SupabaseClient,
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

    // Cast — generic Supabase types don't include column names without codegen
    const cfg = data as Partial<EconomyConfig> | null;
    this.configCache = {
      economy_enabled: cfg?.economy_enabled ?? true,
      currency_name: cfg?.currency_name ?? 'Coins',
      currency_emoji: cfg?.currency_emoji ?? '🪙',
      economy_starting_balance: cfg?.economy_starting_balance ?? 0,
      economy_daily_amount: cfg?.economy_daily_amount ?? 500,
      economy_weekly_amount: cfg?.economy_weekly_amount ?? 3500,
      economy_monthly_amount: cfg?.economy_monthly_amount ?? 15000,
      economy_streak_bonus_pct: cfg?.economy_streak_bonus_pct ?? 5,
      economy_work_cooldown_seconds: cfg?.economy_work_cooldown_seconds ?? 1800,
      economy_work_min: cfg?.economy_work_min ?? 100,
      economy_work_max: cfg?.economy_work_max ?? 500,
      economy_crime_success_pct: cfg?.economy_crime_success_pct ?? 40,
      economy_crime_fine_pct: cfg?.economy_crime_fine_pct ?? 50,
      economy_crime_min: cfg?.economy_crime_min ?? 200,
      economy_crime_max: cfg?.economy_crime_max ?? 1000,
      economy_chat_income_enabled: cfg?.economy_chat_income_enabled ?? true,
      economy_chat_income_min: cfg?.economy_chat_income_min ?? 5,
      economy_chat_income_max: cfg?.economy_chat_income_max ?? 15,
      economy_chat_income_cooldown_seconds: cfg?.economy_chat_income_cooldown_seconds ?? 60,
      economy_rob_enabled: cfg?.economy_rob_enabled ?? true,
      economy_rob_success_pct: cfg?.economy_rob_success_pct ?? 35,
      economy_rob_fine_pct: cfg?.economy_rob_fine_pct ?? 50,
      economy_heist_enabled: cfg?.economy_heist_enabled ?? true,
      economy_passive_mode_allowed: cfg?.economy_passive_mode_allowed ?? true,
      economy_pay_tax_pct: cfg?.economy_pay_tax_pct ?? 0,
      economy_max_wallet: cfg?.economy_max_wallet ?? 0,
      economy_max_bank: cfg?.economy_max_bank ?? 0,
      economy_log_channel_id: cfg?.economy_log_channel_id ?? null,
    };
    this.configCacheTime = now;
    return this.configCache!;
  }

  invalidateConfig(): void {
    this.configCache = null;
    this.configCacheTime = 0;
  }

  // ── Wallet operations ───────────────────────────────────

  async getOrCreateWallet(userId: string): Promise<WalletData> {
    const { data: existing, error: fetchErr } = await this.supabase
      .from('economy_wallets')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchErr) {
      log.error('getOrCreateWallet fetch failed', { userId, detail: fetchErr.message });
    }

    if (existing) return existing as WalletData;

    const { data: created, error: createErr } = await this.supabase.rpc(
      'economy_get_or_create_wallet',
      {
        p_guild_id: this.guild.id,
        p_user_id: userId,
      },
    );

    if (createErr) {
      log.error('getOrCreateWallet initialization RPC failed', {
        userId,
        detail: createErr.message,
      });
    }

    if (created) return created as WalletData;

    // Preserve the established non-throwing fallback when persistence fails.
    const cfg = await this.loadConfig();
    const startBal = cfg.economy_starting_balance;

    return {
      guild_id: this.guild.id,
      user_id: userId,
      wallet: startBal,
      bank: 0,
      bank_max: 10000,
      passive: false,
      total_earned: startBal,
      total_spent: 0,
    } as WalletData;
  }

  /**
   * Atomically credit a user's wallet via RPC. Returns updated wallet data,
   * or null if the RPC failed (V50-L2: callers must handle null).
   * Uses economy_add_balance to avoid TOCTOU race conditions.
   */
  async creditWallet(userId: string, amount: number): Promise<WalletData | null> {
    // V5 Audit §4.1: Reject non-positive amounts at the JS boundary.
    // The RPC also enforces this, but catching here gives a clearer error.
    if (!Number.isFinite(amount) || amount <= 0) {
      log.warn('creditWallet rejected non-positive amount', { userId, amount });
      return null;
    }

    // Ensure wallet exists before RPC call
    await this.getOrCreateWallet(userId);

    // V5-Audit §4.1: Pass amount as string so the Supabase client sends it
    // as a JSON string → Postgres BIGINT, avoiding JS number precision loss
    // for values beyond Number.MAX_SAFE_INTEGER.
    const { error } = await this.supabase.rpc('economy_add_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: String(amount),
    });

    if (error) {
      log.error('creditWallet RPC error', { detail: error });
      return null;
    }

    // Re-read wallet to get updated state (RPC doesn't return row)
    return this.getOrCreateWallet(userId);
  }

  /**
   * Atomically debit a user's wallet via RPC. Fails if insufficient funds.
   * Uses economy_subtract_balance to avoid TOCTOU race conditions.
   *
   * V5 Audit [4.1]: Removed redundant JS-side balance check. The RPC itself
   * enforces the constraint atomically — a JS-side check is misleading because
   * another concurrent debit could change the balance between the read and the RPC.
   */
  async debitWallet(userId: string, amount: number): Promise<WalletData | null> {
    // V5 Audit §4.1: Reject non-positive amounts at the JS boundary.
    if (!Number.isFinite(amount) || amount <= 0) {
      log.warn('debitWallet rejected non-positive amount', { userId, amount });
      return null;
    }

    // Ensure wallet exists before RPC call
    await this.getOrCreateWallet(userId);

    const { error } = await this.supabase.rpc('economy_subtract_balance', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: String(amount),
    });

    if (error) {
      // RPC raises exception on insufficient funds
      log.warn('debitWallet RPC failed (likely insufficient funds)', { detail: error.message });
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
    const { data: rawAmount, error: depositErr } = await this.supabase.rpc('economy_bank_deposit', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: String(requestedAmount),
    });
    // RPC may return BIGINT as string; coerce back to number for display/comparison
    const actualAmount = Number(rawAmount);

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
    const { data: rawAmount, error: withdrawErr } = await this.supabase.rpc('economy_bank_withdraw', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_amount: String(amount),
      p_max_wallet: String(cfg.economy_max_wallet),
    });
    // RPC may return BIGINT as string; coerce back to number for display/comparison
    const actualAmount = Number(rawAmount);

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

    // Credit wallet — V50-L2: handle null (RPC failure)
    const updated = await this.creditWallet(userId, totalAmount);
    if (!updated) {
      // [game-economy-wallet-rewards] Outage lane: the reward credit RPC failed.
      // Raise an owner alert + append-only audit event so the dropped reward is
      // observable (the cooldown slot was already claimed for this window).
      await this.raiseRewardOutageAlert(userId, type, totalAmount)
        .catch((e: unknown) => { log.warn('reward outage alert failed', { detail: (e as Error)?.message ?? e }); });
      eventBus.emit('economy.reward_failed', this.guild.id, {
        userId,
        rewardType: type,
        amount: totalAmount,
      });
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: `❌ Failed to credit your ${type} reward. Please try again.` };
    }

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

    // [game-economy-wallet-rewards] Central append-only audit row for the timed
    // reward-amount lane (daily/weekly/monthly claim credited).
    eventBus.emit('economy.reward_claimed', this.guild.id, {
      userId,
      rewardType: type,
      amount: totalAmount,
      streak: currentStreak,
    });

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
    const job = WORK_JOBS[randomInt(0, WORK_JOBS.length)];
    const updated = await this.creditWallet(userId, amount);
    if (!updated) {
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Failed to credit your work earnings. Please try again.' };
    }

    await this.recordTransaction(userId, 'work', amount, updated.wallet, `Worked: ${job}`);
    await this.logEconomyEvent(userId, 'work', amount);
    getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'work').catch((e: unknown) => { log.warn('Quest trackProgress failed', { detail: (e as Error)?.message ?? e }); });

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
      if (!updated) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: '❌ Failed to credit your crime earnings. Please try again.' };
      }
      const story = CRIME_SUCCESS[randomInt(0, CRIME_SUCCESS.length)];

      await this.recordTransaction(userId, 'crime', amount, updated.wallet, `Crime success: ${story}`);
      await this.logEconomyEvent(userId, 'crime (success)', amount);
      getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'crime').catch((e: unknown) => { log.warn('Quest trackProgress failed', { detail: (e as Error)?.message ?? e }); });

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
      const story = CRIME_FAIL[randomInt(0, CRIME_FAIL.length)];

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
      if (!updated) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: '❌ Failed to credit your begging earnings.' };
      }
      const story = BEG_SUCCESS[randomInt(0, BEG_SUCCESS.length)];

      await this.recordTransaction(userId, 'beg', amount, updated.wallet, `Begged: ${story}`);

      return {
        success: true,
        amount,
        balance: updated,
        message: `${cfg.currency_emoji} ${story} and gave you **${amount.toLocaleString()} ${cfg.currency_name}**.`,
      };
    } else {
      const wallet = await this.getOrCreateWallet(userId);
      const story = BEG_FAIL[randomInt(0, BEG_FAIL.length)];
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
      const loc = SEARCH_LOCATIONS[randomInt(0, SEARCH_LOCATIONS.length)];
      const amount = randInt(loc.min, loc.max);
      const updated = await this.creditWallet(userId, amount);
      if (!updated) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: '❌ Failed to credit your search findings.' };
      }

      await this.recordTransaction(userId, 'search', amount, updated.wallet, `Searched ${loc.name}`);

      return {
        success: true,
        amount,
        balance: updated,
        message: `${cfg.currency_emoji} You searched ${loc.name} and found **${amount.toLocaleString()} ${cfg.currency_name}**!`,
      };
    } else {
      const wallet = await this.getOrCreateWallet(userId);
      const msg = SEARCH_EMPTY[randomInt(0, SEARCH_EMPTY.length)];
      return { success: false, amount: 0, balance: wallet, message: `🔍 ${msg}` };
    }
  }

  // ── Pay / Transfer ──────────────────────────────────────

  /**
   * Transfer wallet currency between two members.
   *
   * The debit, the receiver credit, and both ledger rows commit as one
   * serializable database call (economy_pay), keyed on the interaction id so a
   * redelivered interaction returns the first outcome and never debits twice.
   * `requestId` MUST be a stable per-invocation id (the Discord interaction id);
   * without it exactly-once cannot be guaranteed, so the transfer is refused.
   */
  async pay(
    senderId: string,
    receiverId: string,
    amount: number,
    requestId: string,
  ): Promise<TransactionResult> {
    const cfg = await this.loadConfig();

    if (senderId === receiverId) {
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: "You can't pay yourself." };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: 'Amount must be positive.' };
    }
    if (!requestId) {
      log.error('pay() called without an idempotency request id — refusing to transfer');
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Payment could not be processed. Please try again.' };
    }

    const payArgs = {
      p_guild_id: this.guild.id,
      p_sender_id: senderId,
      p_receiver_id: receiverId,
      // Pass amount as a string so the client sends it as a JSON string →
      // Postgres BIGINT, matching debitWallet/creditWallet and avoiding
      // precision loss beyond Number.MAX_SAFE_INTEGER.
      p_amount: String(amount),
      p_tax_pct: cfg.economy_pay_tax_pct ?? 0,
      p_request_id: requestId,
    };

    // economy_pay is idempotent on p_request_id, so an ambiguous transport
    // failure (e.g. the transfer committed but the HTTP response was lost) is
    // safe to retry: the retry replays the committed outcome instead of
    // debiting a second time. Without this, a lost response would surface as a
    // "failed" message and a user re-run — which mints a NEW interaction id —
    // would double-debit. Retrying the SAME request id closes that window.
    let data: unknown = null;
    let error: { message?: string } | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await this.supabase.rpc('economy_pay', payArgs);
      data = res.data;
      error = res.error;
      if (!error) break;
      log.warn('pay() economy_pay attempt failed; retrying idempotently', {
        attempt,
        detail: error.message,
      });
    }

    if (error || !data || typeof data !== 'object') {
      log.error('pay() economy_pay RPC failed after retries', { detail: error?.message });
      const wallet = await this.getOrCreateWallet(senderId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Payment failed. Please try again.' };
    }

    const result = data as { status?: string; amount?: number | string; tax?: number | string; received?: number | string };
    // Re-read the sender wallet for the reported balance; the RPC has committed
    // by now, so this reflects the post-transfer state (or the unchanged wallet
    // on the insufficient-funds path).
    const balance = await this.getOrCreateWallet(senderId);

    if (result.status === 'insufficient_funds') {
      return { success: false, amount: 0, balance, message: "You don't have enough in your wallet." };
    }
    if (result.status !== 'sent') {
      return { success: false, amount: 0, balance, message: '❌ Payment failed. Please try again.' };
    }

    const paidAmount = Number(result.amount);
    const tax = Number(result.tax);
    const received = Number(result.received);

    await this.logEconomyEvent(senderId, `paid ${receiverId}`, paidAmount);

    let msg = `${cfg.currency_emoji} Sent **${paidAmount.toLocaleString()} ${cfg.currency_name}** to <@${receiverId}>.`;
    if (tax > 0) {
      msg += `\n💸 Tax: **${tax.toLocaleString()}** (${cfg.economy_pay_tax_pct}%)`;
      msg += `\n📬 They received: **${received.toLocaleString()} ${cfg.currency_name}**`;
    }

    return { success: true, amount: paidAmount, balance, message: msg };
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

    // V50-C1: claim cooldown atomically with SET PX NX BEFORE any
    // wallet reads or outcome logic. The previous GET→check→SET pattern
    // let two concurrent /rob commands both pass the cooldown check.
    const cooldownMs = 600_000;
    const cooldownKey = `economy:${this.guild.id}:${robberId}:rob`;
    const expiresAt = Date.now() + cooldownMs;
    const claimedSlot = await this.valkey.set(cooldownKey, String(expiresAt), 'PX', cooldownMs, 'NX');
    if (!claimedSlot) {
      const lastRob = await this.valkey.get(cooldownKey);
      const remaining = lastRob ? parseInt(lastRob, 10) - Date.now() : cooldownMs;
      const wallet = await this.getOrCreateWallet(robberId);
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      return { success: false, amount: 0, balance: wallet, message: `⏰ You need to wait **${mins}m** before robbing again.` };
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
        // V50-C1: cooldown already claimed via SET NX above — no redundant SET needed
        return { success: false, amount: 0, balance: robberWallet, message: `🔒 <@${victimId}>'s padlock blocked your robbery attempt! The padlock was consumed.` };
      }
      // padlock raced out — fall through to normal rob attempt
    }

    // V50-C1: cooldown already claimed via SET NX above — no redundant SET needed

    if (chance(cfg.economy_rob_success_pct)) {
      // Success — steal 10-50% of their wallet
      const stealPct = randInt(10, 50);
      const stolen = Math.floor(victimWallet.wallet * (stealPct / 100));

      // V50-C2: check debitWallet return — if victim's wallet was drained
      // concurrently, the debit fails and we must NOT credit the robber
      // (previous code created coins from thin air).
      const debitResult = await this.debitWallet(victimId, stolen);
      if (!debitResult) {
        return {
          success: false,
          amount: 0,
          balance: robberWallet,
          message: `💨 <@${victimId}>'s wallet was emptied before you could grab anything!`,
        };
      }

      const updatedRobber = await this.creditWallet(robberId, stolen);
      if (!updatedRobber) {
        // Credit failed after debit — refund victim to avoid coin destruction
        log.error(`rob() creditWallet failed for robber ${robberId} — refunding victim ${victimId}`);
        await this.creditWallet(victimId, stolen);
        return {
          success: false,
          amount: 0,
          balance: await this.getOrCreateWallet(robberId),
          message: '❌ Something went wrong with the robbery. The victim has been refunded.',
        };
      }

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
      // V53-M2: Fail — pay fine to victim. Check debit+credit to avoid coins vanishing.
      const fine = Math.floor(robberWallet.wallet * (cfg.economy_rob_fine_pct / 100));
      if (fine > 0) {
        const fineDebited = await this.debitWallet(robberId, fine);
        if (fineDebited) {
          const fineCredited = await this.creditWallet(victimId, fine);
          if (!fineCredited) {
            // Credit failed — refund the robber so coins aren't destroyed
            log.error(`rob() fine credit to victim ${victimId} failed — refunding robber ${robberId}`);
            await this.creditWallet(robberId, fine);
          }
        }
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

    // V53-M3: check update result — surface error if DB write fails
    const { error: passiveErr } = await this.supabase
      .from('economy_wallets')
      .update({ passive: newState, updated_at: new Date().toISOString() })
      .eq('guild_id', this.guild.id)
      .eq('user_id', userId);

    if (passiveErr) {
      log.error('togglePassive update failed', { detail: passiveErr.message });
      return { enabled: !newState, message: '❌ Failed to toggle passive mode. Please try again.' };
    }

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
      .order('price', { ascending: true })
      .limit(1000);

    if (category) {
      query = query.eq('category', category);
    }

    const { data } = await query;
    return (data ?? []) as Array<{ id: string; name: string; description: string | null; emoji: string; category: string; price: number; stock: number | null }>;
  }

  async buyItem(userId: string, itemId: string, quantity: number = 1, requestId?: string): Promise<TransactionResult> {
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

    // Role requirement — a live-Discord check, so it stays here (the RPC can't
    // see the member's roles). The RPC re-validates stock/max/funds under a lock.
    if (item.require_role_id) {
      const member = this.guild.members.cache.get(userId);
      if (member && !member.roles.cache.has(item.require_role_id)) {
        const wallet = await this.getOrCreateWallet(userId);
        return { success: false, amount: 0, balance: wallet, message: `❌ You need the <@&${item.require_role_id}> role to buy this.` };
      }
    }

    if (!requestId) {
      log.error('buyItem called without an idempotency request id — refusing to purchase');
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Purchase could not be processed. Please try again.' };
    }

    // Atomic + idempotent purchase: the funds check, debit, stock decrement,
    // inventory grant, and ledger row commit as ONE call keyed on the interaction
    // id, so a redelivered /buy charges and delivers exactly once (no double-spend).
    const { data, error } = await this.supabase.rpc('economy_buy_item', {
      p_guild_id: this.guild.id,
      p_user_id: userId,
      p_item_id: itemId,
      p_quantity: quantity,
      p_request_id: requestId,
    });

    if (error || !data || typeof data !== 'object') {
      log.error('buyItem economy_buy_item RPC failed', { detail: error?.message });
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Purchase failed. Please try again.' };
    }

    const result = data as {
      status?: string; replayed?: boolean; total_cost?: number | string;
      max_per_user?: number; owned?: number; stock?: number;
    };
    const wallet = await this.getOrCreateWallet(userId);

    switch (result.status) {
      case 'item_not_found':
        return { success: false, amount: 0, balance: wallet, message: '❌ Item not found.' };
      case 'max_per_user':
        return { success: false, amount: 0, balance: wallet, message: `❌ You can only own **${result.max_per_user}** of this item (you have ${result.owned}).` };
      case 'out_of_stock':
        return { success: false, amount: 0, balance: wallet, message: `❌ Only **${result.stock}** left in stock.` };
      case 'insufficient_funds': {
        const need = Number(result.total_cost ?? item.price * quantity);
        return { success: false, amount: 0, balance: wallet, message: `${cfg.currency_emoji} You need **${need.toLocaleString()} ${cfg.currency_name}** but only have **${wallet.wallet.toLocaleString()}**.` };
      }
      case 'purchased':
        break;
      default:
        return { success: false, amount: 0, balance: wallet, message: '❌ Purchase failed. Please try again.' };
    }

    const totalCost = Number(result.total_cost);

    // Grant role if applicable (member.roles.add is idempotent — safe on a replay).
    if (item.grant_role_id) {
      try {
        const member = await this.guild.members.fetch(userId);
        await member.roles.add(item.grant_role_id, `Purchased ${item.name} from economy shop`);
      } catch (err) {
        log.warn('Failed to grant role', { roleId: item.grant_role_id, detail: err });
      }
    }

    // Secondary, non-idempotent effects run only on the FIRST application (never a replay).
    if (!result.replayed) {
      await this.logEconomyEvent(userId, `bought ${quantity}x ${item.name}`, -totalCost);
      getQuestsManager(this.guild.id)?.trackProgress(this.guild.id, userId, 'shop_buy', quantity).catch((e: unknown) => { log.warn('Quest trackProgress failed', { detail: (e as Error)?.message ?? e }); });
    }

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

    // Snapshot wallet balance before credit so the compensating restore
    // can verify the credit didn't actually go through.
    const walletBefore = await this.getOrCreateWallet(userId);
    const balanceBefore = walletBefore.wallet;

    // Credit wallet — V50-L2: handle null (RPC failure)
    // V53-M4: refund items back to inventory if credit fails
    const updated = await this.creditWallet(userId, totalValue);
    if (!updated) {
      // Before restoring items, re-check the wallet. If the balance increased
      // despite creditWallet returning null (transient network blip where the
      // RPC actually succeeded), skip the restore to avoid giving the user
      // both the coins AND the items back.
      const walletAfter = await this.getOrCreateWallet(userId);
      if (walletAfter.wallet > balanceBefore) {
        log.warn('sellItem: creditWallet returned null but balance increased — credit likely succeeded, skipping item restore', {
          userId, itemId, quantity, balanceBefore, balanceAfter: walletAfter.wallet,
        });
        // Credit went through — treat as success (user already has the coins)
        await this.recordTransaction(userId, 'shop_sell', totalValue, walletAfter.wallet, `Sold ${quantity}x ${item.name}`);
        return {
          success: true,
          amount: totalValue,
          balance: walletAfter,
          message: `${item.emoji} Sold **${quantity}x ${item.name}** for **${totalValue.toLocaleString()} ${cfg.currency_name}**!`,
        };
      }

      // Balance unchanged — credit genuinely failed, safe to restore items
      await Promise.resolve(this.supabase.rpc('economy_upsert_inventory', {
        p_guild_id: this.guild.id,
        p_user_id: userId,
        p_item_id: itemId,
        p_quantity: quantity,
      })).catch((err: unknown) => {
        // V53-L1: Log item restore failures — if this fails, items are permanently lost
        log.error('CRITICAL: sellItem item restore failed', { userId, itemId, quantity, detail: err });
      });
      const wallet = await this.getOrCreateWallet(userId);
      return { success: false, amount: 0, balance: wallet, message: '❌ Failed to credit sale proceeds. Your items have been returned.' };
    }

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
      .gt('quantity', 0)
      .limit(1000);

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

    // V50-M1: claim cooldown atomically with SET PX NX. The previous
    // GET→check→SET pattern let two messages in rapid succession both
    // pass the cooldown check and each award chat income.
    const cooldownMs = cfg.economy_chat_income_cooldown_seconds * 1000;
    const cooldownKey = `economy:${this.guild.id}:${userId}:chat_income`;
    const claimed = await this.valkey.set(cooldownKey, '1', 'PX', cooldownMs, 'NX');
    if (!claimed) return; // Still on cooldown

    const amount = randInt(cfg.economy_chat_income_min, cfg.economy_chat_income_max);
    if (amount <= 0) return;

    const updated = await this.creditWallet(userId, amount);
    if (!updated) return; // RPC failed — cooldown consumed but no harm

    await this.recordTransaction(userId, 'chat_income', amount, updated.wallet, 'Chat income');
  }

  // ── Leaderboard ─────────────────────────────────────────

  async getLeaderboard(limit: number = 10): Promise<Array<{ user_id: string; net_worth: number; wallet: number; bank: number }>> {
    // V53-M2: Use RPC for accurate server-side net_worth ranking.
    // Falls back to client-side sort if RPC doesn't exist yet.
    const { data: rpcData, error: rpcError } = await this.supabase
      .rpc('economy_leaderboard', {
        p_guild_id: this.guild.id,
        p_limit: limit,
      });

    if (!rpcError && rpcData) {
      return (rpcData as Array<Record<string, unknown>>).map((row) => ({
        user_id: row.user_id as string,
        net_worth: row.net_worth as number,
        wallet: row.wallet as number,
        bank: row.bank as number,
      }));
    }

    // V7 Audit §4.P3a — economy_leaderboard RPC is required (migration applied).
    // Log the error instead of silently falling back to a 500-row client-side sort.
    /* v8 ignore next 2 -- error path covered by RPC-fail test; instrumentation gap */
    log.error(`economy_leaderboard RPC failed for guild ${this.guild.id}:`, rpcError?.message ?? 'unknown');
    return [];
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
      const { error } = await this.supabase.from('economy_transactions').insert({
        guild_id: this.guild.id,
        user_id: userId,
        type,
        amount,
        balance_after: balanceAfter,
        description,
        metadata: metadata ?? null,
      });
      if (error) {
        log.error('Failed to record transaction', { userId, type, detail: error.message });
      }
    } catch (err) {
      log.error('Failed to record transaction (exception)', { detail: err });
    }
  }

  /**
   * [game-economy-wallet-rewards] Raise an owner alert when a timed-reward credit
   * fails (outage lane), so an operator knows a member's daily/weekly/monthly
   * reward was dropped for this window. Best effort — never blocks the claim flow.
   */
  private async raiseRewardOutageAlert(userId: string, type: string, amount: number): Promise<void> {
    await this.supabase.from('alerts').insert({
      guild_id: this.guild.id,
      alert_type: 'economy_reward_outage',
      severity: 'warning',
      title: 'Economy reward credit failed',
      message: `A ${type} reward of ${amount} failed to credit ${userId}. The claim cooldown was consumed for this window.`,
      metadata: { user_id: userId, reward_type: type, amount },
    });
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
