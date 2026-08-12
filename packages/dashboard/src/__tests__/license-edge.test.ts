/**
 * License key generation tests.
 *
 * V5 Audit §13.P2a: Verify key format, uniqueness, and hash properties.
 */
import { describe, it, expect } from 'vitest';
import { generateLicenseKey } from '@/app/api/paypal/webhook/fulfillment';
import { createHash } from 'crypto';

describe('generateLicenseKey', () => {
  it('produces SMNI-XXXX-XXXX-XXXX-XXXX format', () => {
    const key = generateLicenseKey();
    expect(key.plaintext).toMatch(/^SMNI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('hash matches SHA-256 of plaintext', () => {
    const key = generateLicenseKey();
    const expected = createHash('sha256').update(key.plaintext).digest('hex');
    expect(key.hash).toBe(expected);
  });

  it('prefix is always SMNI', () => {
    for (let i = 0; i < 10; i++) {
      const key = generateLicenseKey();
      expect(key.prefix).toBe('SMNI');
    }
  });

  it('accepts a configured uppercase product prefix without weakening hashing', () => {
    const key = generateLicenseKey('ACME');
    expect(key.prefix).toBe('ACME');
    expect(key.plaintext).toMatch(/^ACME-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(key.hash).toBe(createHash('sha256').update(key.plaintext).digest('hex'));
  });

  it('rejects malformed configured prefixes', () => {
    expect(() => generateLicenseKey('bad-prefix')).toThrow('Invalid license key prefix');
  });

  it('suffix matches last group of plaintext', () => {
    const key = generateLicenseKey();
    const lastGroup = key.plaintext.split('-').at(-1);
    expect(key.suffix).toBe(lastGroup);
  });

  it('generates unique keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateLicenseKey().plaintext);
    }
    expect(keys.size).toBe(100);
  });

  it('excludes ambiguous characters (0, O, 1, I)', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateLicenseKey();
      const body = key.plaintext.replace(/^SMNI-/, '').replace(/-/g, '');
      expect(body).not.toMatch(/[0OI1]/);
    }
  });
});
