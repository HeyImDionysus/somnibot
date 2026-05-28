/**
 * Tests for Tailwind class merge utility.
 */
import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils/cn';

describe('cn', () => {
  it('merges class strings', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1');
  });

  it('resolves Tailwind conflicts (last wins)', () => {
    // twMerge should keep the last conflicting utility
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('handles conditional classes via clsx', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra');
  });

  it('handles undefined and null inputs', () => {
    expect(cn('base', undefined, null, 'end')).toBe('base end');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });

  it('handles object syntax', () => {
    const result = cn('base', { 'text-red-500': true, 'text-blue-500': false });
    expect(result).toContain('base');
    expect(result).toContain('text-red-500');
    expect(result).not.toContain('text-blue-500');
  });
});
