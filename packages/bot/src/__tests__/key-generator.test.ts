/**
 * License Key Generator — Unit Tests
 *
 * Tests key format, uniqueness, hashing, and charset compliance.
 */
import { describe, it, expect } from 'vitest';
import { generateLicenseKey, hashLicenseKey } from '../features/commerce/key-generator.js';

describe('generateLicenseKey', () => {
  it('returns SMNI-XXXX-XXXX-XXXX-XXXX format', () => {
    const { plaintext } = generateLicenseKey();
    expect(plaintext).toMatch(/^SMNI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('does not contain ambiguous characters (0, O, 1, I)', () => {
    // Generate many keys to increase chance of catching errors
    for (let i = 0; i < 50; i++) {
      const { plaintext } = generateLicenseKey();
      const body = plaintext.replace(/^SMNI-/, '').replace(/-/g, '');
      expect(body).not.toMatch(/[0OI1]/);
    }
  });

  it('returns a valid SHA-256 hash', () => {
    const { hash } = generateLicenseKey();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hash matches hashLicenseKey(plaintext)', () => {
    const { plaintext, hash } = generateLicenseKey();
    expect(hashLicenseKey(plaintext)).toBe(hash);
  });

  it('returns prefix SMNI', () => {
    const { prefix } = generateLicenseKey();
    expect(prefix).toBe('SMNI');
  });

  it('suffix matches last 4 characters of plaintext', () => {
    const { plaintext, suffix } = generateLicenseKey();
    const parts = plaintext.split('-');
    expect(suffix).toBe(parts[4]);
  });

  it('generates unique keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateLicenseKey().plaintext);
    }
    expect(keys.size).toBe(100);
  });

  it('generates unique hashes', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(generateLicenseKey().hash);
    }
    expect(hashes.size).toBe(100);
  });
});

describe('hashLicenseKey', () => {
  it('returns consistent hash for same input', () => {
    const key = 'SMNI-ABCD-EFGH-JKLM-NPQR';
    expect(hashLicenseKey(key)).toBe(hashLicenseKey(key));
  });

  it('returns different hashes for different inputs', () => {
    const h1 = hashLicenseKey('SMNI-AAAA-BBBB-CCCC-DDDD');
    const h2 = hashLicenseKey('SMNI-AAAA-BBBB-CCCC-EEED');
    expect(h1).not.toBe(h2);
  });

  it('returns 64-character hex string', () => {
    const hash = hashLicenseKey('any-string');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
