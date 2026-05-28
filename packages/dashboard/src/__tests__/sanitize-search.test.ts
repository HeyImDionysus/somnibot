/**
 * Tests for the sanitizeSearch utility module.
 *
 * Unlike route-validation.test.ts (which tests an inline copy), these tests
 * exercise the actual production module to ensure coverage and catch drift.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';

describe('sanitizeSearch', () => {
  it('strips commas (PostgREST OR separator)', () => {
    expect(sanitizeSearch('admin,user,mod')).toBe('adminusermod');
  });

  it('strips parentheses (logical grouping)', () => {
    expect(sanitizeSearch('test(admin)')).toBe('testadmin');
  });

  it('strips percent signs (LIKE wildcard)', () => {
    expect(sanitizeSearch('%admin%')).toBe('admin');
  });

  it('strips asterisks (full-text wildcard)', () => {
    expect(sanitizeSearch('test*')).toBe('test');
  });

  it('strips backslashes (escape chars)', () => {
    expect(sanitizeSearch('test\\escape')).toBe('testescape');
  });

  it('preserves periods (V5 Audit §7.2 — email addresses)', () => {
    expect(sanitizeSearch('user@example.com')).toBe('user@example.com');
  });

  it('trims whitespace', () => {
    expect(sanitizeSearch('  hello world  ')).toBe('hello world');
  });

  it('caps at 200 characters', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeSearch(long);
    expect(result.length).toBe(200);
  });

  it('handles empty string', () => {
    expect(sanitizeSearch('')).toBe('');
  });

  it('handles whitespace-only', () => {
    expect(sanitizeSearch('   ')).toBe('');
  });

  it('preserves normal search terms', () => {
    expect(sanitizeSearch('john_doe123')).toBe('john_doe123');
  });

  it('strips multiple metacharacters in sequence', () => {
    expect(sanitizeSearch('a%b*c(d)e,f\\g')).toBe('abcdefg');
  });
});
