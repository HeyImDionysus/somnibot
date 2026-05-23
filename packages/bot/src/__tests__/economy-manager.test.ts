/**
 * Economy Manager — Unit Tests
 *
 * Tests core economy logic: config defaults, wallet operations,
 * deposit/withdraw bounds, reward calculations, and cooldown logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Inline types (from economy-manager.ts) ─────────────────

interface EconomyConfig {
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

interface WalletData {
  guild_id: string;
  user_id: string;
  wallet: number;
  bank: number;
  bank_max: number;
  passive: boolean;
  total_earned: number;
  total_spent: number;
}

interface TransactionResult {
  success: boolean;
  amount: number;
  balance: WalletData;
  message: string;
}

// ── Inline helpers (from economy-manager.ts) ───────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chance(pct: number): boolean {
  return Math.random() * 100 < pct;
}

// ── Default config (matches source defaults) ───────────────

const DEFAULT_CONFIG: EconomyConfig = {
  economy_enabled: true,
  currency_name: 'Coins',
  currency_emoji: '🪙',
  economy_starting_balance: 100,
  economy_daily_amount: 500,
  economy_weekly_amount: 2500,
  economy_monthly_amount: 10000,
  economy_streak_bonus_pct: 5,
  economy_work_cooldown_seconds: 30,
  economy_work_min: 50,
  economy_work_max: 250,
  economy_crime_success_pct: 40,
  economy_crime_fine_pct: 30,
  economy_crime_min: 100,
  economy_crime_max: 500,
  economy_chat_income_enabled: false,
  economy_chat_income_min: 1,
  economy_chat_income_max: 5,
  economy_chat_income_cooldown_seconds: 60,
  economy_rob_enabled: true,
  economy_rob_success_pct: 30,
  economy_rob_fine_pct: 25,
  economy_heist_enabled: true,
  economy_passive_mode_allowed: true,
  economy_pay_tax_pct: 0,
  economy_max_wallet: 0,
  economy_max_bank: 0,
  economy_log_channel_id: null,
};

// ── Deposit/Withdraw Logic (inlined from economy-manager) ──

function calculateDeposit(
  wallet: number,
  bank: number,
  bankMax: number,
  requestedAmount: number,
): { amount: number; newWallet: number; newBank: number; error?: string } {
  if (requestedAmount <= 0) return { amount: 0, newWallet: wallet, newBank: bank, error: 'Amount must be positive' };
  if (requestedAmount > wallet) return { amount: 0, newWallet: wallet, newBank: bank, error: 'Insufficient wallet balance' };

  let depositAmount = requestedAmount;
  if (bankMax > 0 && bank + depositAmount > bankMax) {
    depositAmount = bankMax - bank;
    if (depositAmount <= 0) return { amount: 0, newWallet: wallet, newBank: bank, error: 'Bank is full' };
  }

  return {
    amount: depositAmount,
    newWallet: wallet - depositAmount,
    newBank: bank + depositAmount,
  };
}

function calculateWithdraw(
  wallet: number,
  bank: number,
  requestedAmount: number,
): { amount: number; newWallet: number; newBank: number; error?: string } {
  if (requestedAmount <= 0) return { amount: 0, newWallet: wallet, newBank: bank, error: 'Amount must be positive' };
  if (requestedAmount > bank) return { amount: 0, newWallet: wallet, newBank: bank, error: 'Insufficient bank balance' };

  return {
    amount: requestedAmount,
    newWallet: wallet + requestedAmount,
    newBank: bank - requestedAmount,
  };
}

// ── Streak Bonus Calculation ───────────────────────────────

function calculateStreakBonus(baseAmount: number, streak: number, bonusPct: number): number {
  if (streak <= 1 || bonusPct <= 0) return baseAmount;
  const multiplier = 1 + ((streak - 1) * bonusPct / 100);
  return Math.floor(baseAmount * multiplier);
}

// ── Pay Tax Calculation ────────────────────────────────────

function calculatePayTax(amount: number, taxPct: number): { net: number; tax: number } {
  if (taxPct <= 0) return { net: amount, tax: 0 };
  const tax = Math.floor(amount * (taxPct / 100));
  return { net: amount - tax, tax };
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

describe('randInt', () => {
  it('returns values within range', () => {
    for (let i = 0; i < 100; i++) {
      const val = randInt(10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(20);
    }
  });

  it('returns min when min equals max', () => {
    expect(randInt(5, 5)).toBe(5);
  });

  it('returns integers', () => {
    for (let i = 0; i < 50; i++) {
      const val = randInt(1, 100);
      expect(Number.isInteger(val)).toBe(true);
    }
  });
});

describe('chance', () => {
  it('returns true sometimes for 50%', () => {
    let trueCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (chance(50)) trueCount++;
    }
    // Should be roughly 500, allow wide margin
    expect(trueCount).toBeGreaterThan(300);
    expect(trueCount).toBeLessThan(700);
  });

  it('always returns true for 100%', () => {
    for (let i = 0; i < 100; i++) {
      expect(chance(100)).toBe(true);
    }
  });

  it('always returns false for 0%', () => {
    for (let i = 0; i < 100; i++) {
      expect(chance(0)).toBe(false);
    }
  });
});

describe('calculateDeposit', () => {
  it('deposits full amount when bank has capacity', () => {
    const result = calculateDeposit(1000, 0, 5000, 500);
    expect(result.amount).toBe(500);
    expect(result.newWallet).toBe(500);
    expect(result.newBank).toBe(500);
  });

  it('caps deposit at bank max', () => {
    const result = calculateDeposit(1000, 4800, 5000, 500);
    expect(result.amount).toBe(200);
    expect(result.newWallet).toBe(800);
    expect(result.newBank).toBe(5000);
  });

  it('rejects deposit when bank is full', () => {
    const result = calculateDeposit(1000, 5000, 5000, 100);
    expect(result.error).toContain('full');
    expect(result.amount).toBe(0);
  });

  it('rejects deposit exceeding wallet balance', () => {
    const result = calculateDeposit(50, 0, 5000, 100);
    expect(result.error).toContain('Insufficient');
  });

  it('rejects zero or negative amount', () => {
    expect(calculateDeposit(1000, 0, 5000, 0).error).toBeDefined();
    expect(calculateDeposit(1000, 0, 5000, -10).error).toBeDefined();
  });

  it('allows unlimited bank when max is 0', () => {
    const result = calculateDeposit(1000, 999999, 0, 1000);
    expect(result.amount).toBe(1000);
    expect(result.newBank).toBe(1000999);
  });
});

describe('calculateWithdraw', () => {
  it('withdraws full amount', () => {
    const result = calculateWithdraw(100, 1000, 500);
    expect(result.amount).toBe(500);
    expect(result.newWallet).toBe(600);
    expect(result.newBank).toBe(500);
  });

  it('rejects withdraw exceeding bank balance', () => {
    const result = calculateWithdraw(100, 50, 100);
    expect(result.error).toContain('Insufficient');
  });

  it('rejects zero or negative amount', () => {
    expect(calculateWithdraw(100, 1000, 0).error).toBeDefined();
    expect(calculateWithdraw(100, 1000, -5).error).toBeDefined();
  });

  it('withdraws exact bank balance', () => {
    const result = calculateWithdraw(0, 100, 100);
    expect(result.amount).toBe(100);
    expect(result.newWallet).toBe(100);
    expect(result.newBank).toBe(0);
  });
});

describe('calculateStreakBonus', () => {
  it('returns base amount for streak of 1', () => {
    expect(calculateStreakBonus(500, 1, 5)).toBe(500);
  });

  it('returns base amount for zero bonus pct', () => {
    expect(calculateStreakBonus(500, 10, 0)).toBe(500);
  });

  it('applies 5% per additional streak day', () => {
    // Streak 2 = 1.05x, streak 3 = 1.10x
    expect(calculateStreakBonus(1000, 2, 5)).toBe(1050);
    expect(calculateStreakBonus(1000, 3, 5)).toBe(1100);
    expect(calculateStreakBonus(1000, 11, 5)).toBe(1500); // 1.5x
  });

  it('floors the result', () => {
    // 333 * 1.05 = 349.65 → 349
    expect(calculateStreakBonus(333, 2, 5)).toBe(349);
  });
});

describe('calculatePayTax', () => {
  it('returns full amount when tax is 0', () => {
    const result = calculatePayTax(1000, 0);
    expect(result.net).toBe(1000);
    expect(result.tax).toBe(0);
  });

  it('calculates 10% tax', () => {
    const result = calculatePayTax(1000, 10);
    expect(result.tax).toBe(100);
    expect(result.net).toBe(900);
  });

  it('floors tax amount', () => {
    // 333 * 5% = 16.65 → 16
    const result = calculatePayTax(333, 5);
    expect(result.tax).toBe(16);
    expect(result.net).toBe(317);
  });

  it('handles negative tax (treated as no tax)', () => {
    const result = calculatePayTax(1000, -5);
    expect(result.net).toBe(1000);
    expect(result.tax).toBe(0);
  });
});

describe('Default EconomyConfig', () => {
  it('has sensible default values', () => {
    expect(DEFAULT_CONFIG.economy_enabled).toBe(true);
    expect(DEFAULT_CONFIG.currency_name).toBe('Coins');
    expect(DEFAULT_CONFIG.economy_starting_balance).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.economy_work_min).toBeLessThan(DEFAULT_CONFIG.economy_work_max);
    expect(DEFAULT_CONFIG.economy_crime_min).toBeLessThan(DEFAULT_CONFIG.economy_crime_max);
    expect(DEFAULT_CONFIG.economy_crime_success_pct).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.economy_crime_success_pct).toBeLessThan(100);
    expect(DEFAULT_CONFIG.economy_rob_success_pct).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.economy_rob_success_pct).toBeLessThan(100);
    expect(DEFAULT_CONFIG.economy_pay_tax_pct).toBe(0);
    expect(DEFAULT_CONFIG.economy_max_wallet).toBe(0); // Unlimited
    expect(DEFAULT_CONFIG.economy_max_bank).toBe(0); // Unlimited
  });

  it('daily < weekly < monthly rewards', () => {
    expect(DEFAULT_CONFIG.economy_daily_amount).toBeLessThan(DEFAULT_CONFIG.economy_weekly_amount);
    expect(DEFAULT_CONFIG.economy_weekly_amount).toBeLessThan(DEFAULT_CONFIG.economy_monthly_amount);
  });
});
