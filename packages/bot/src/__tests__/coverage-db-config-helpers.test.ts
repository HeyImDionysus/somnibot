/**
 * Coverage tests for src/utils/db-helpers.ts and src/config.ts.
 * Targets the ~0.04% gap to reach the 70% statement threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { joinField, joinProp, walletBalance, hasErrorCode } from '../utils/db-helpers.js';

describe('db-helpers', () => {
  describe('joinField', () => {
    it('returns nested value when key exists', () => {
      const row = { profile: { name: 'Alice' } };
      expect(joinField<{ name: string }>(row, 'profile')).toEqual({ name: 'Alice' });
    });

    it('returns undefined for missing key', () => {
      expect(joinField({}, 'missing')).toBeUndefined();
    });

    it('returns undefined for null row', () => {
      expect(joinField(null, 'key')).toBeUndefined();
    });

    it('returns undefined for non-object row', () => {
      expect(joinField('string', 'key')).toBeUndefined();
    });

    it('returns undefined for undefined row', () => {
      expect(joinField(undefined, 'key')).toBeUndefined();
    });
  });

  describe('joinProp', () => {
    it('returns nested property', () => {
      const row = { guild: { name: 'Test', id: '123' } };
      expect(joinProp(row, 'guild', 'name')).toBe('Test');
    });

    it('returns undefined when join is missing', () => {
      expect(joinProp({}, 'guild', 'name')).toBeUndefined();
    });

    it('returns undefined when prop is missing', () => {
      const row = { guild: { name: 'Test' } };
      expect(joinProp(row, 'guild', 'missing')).toBeUndefined();
    });
  });

  describe('walletBalance', () => {
    it('returns wallet value', () => {
      expect(walletBalance({ wallet: 500 })).toBe(500);
    });

    it('returns 0 for null wallet', () => {
      expect(walletBalance({ wallet: null })).toBe(0);
    });

    it('returns 0 for missing wallet field', () => {
      expect(walletBalance({ balance: 100 })).toBe(0);
    });

    it('returns 0 for null row', () => {
      expect(walletBalance(null)).toBe(0);
    });

    it('returns 0 for non-object', () => {
      expect(walletBalance(42)).toBe(0);
    });
  });

  describe('hasErrorCode', () => {
    it('returns true for error object', () => {
      expect(hasErrorCode({ code: '23505', message: 'duplicate' })).toBe(true);
    });

    it('returns false for null', () => {
      expect(hasErrorCode(null)).toBe(false);
    });

    it('returns false for string', () => {
      expect(hasErrorCode('error')).toBe(false);
    });

    it('returns false for object without code', () => {
      expect(hasErrorCode({ message: 'oops' })).toBe(false);
    });
  });
});

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getConfig throws if loadConfig was not called', async () => {
    const { getConfig } = await import('../config.js');
    expect(() => getConfig()).toThrow('Config not loaded');
  });
});
