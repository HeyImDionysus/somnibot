/**
 * V5-Audit §7.1 — Tests for typedPick utility.
 */
import { describe, it, expect } from 'vitest';
import { typedPick } from '@/lib/api/typed-pick';

describe('typedPick', () => {
  it('picks only the specified keys that exist on the object', () => {
    const body = { name: 'test', enabled: true, description: 'hello', extra: 42 };
    const result = typedPick(body, ['name', 'enabled']);
    expect(result).toEqual({ name: 'test', enabled: true });
  });

  it('omits keys whose value is undefined', () => {
    const body = { name: 'test', enabled: undefined, description: 'hello' };
    const result = typedPick(body, ['name', 'enabled', 'description']);
    expect(result).toEqual({ name: 'test', description: 'hello' });
  });

  it('returns empty object when no keys match', () => {
    const body = { name: undefined };
    const result = typedPick(body, ['name']);
    expect(result).toEqual({});
  });

  it('preserves null values (null !== undefined)', () => {
    const body = { name: null as string | null, enabled: true };
    const result = typedPick(body, ['name', 'enabled']);
    expect(result).toEqual({ name: null, enabled: true });
  });
});
