/**
 * Guild Router Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests the `getGuildId` helper and `GuildRouter` logic.
 */
import { describe, it, expect } from 'vitest';
import { getGuildId } from '../guild-router.js';

describe('getGuildId', () => {
  it('extracts guildId from interaction with guildId string', () => {
    expect(getGuildId({ guildId: '123456789' })).toBe('123456789');
  });

  it('extracts guildId from event with guild object', () => {
    expect(getGuildId({ guild: { id: '987654321' } as any })).toBe('987654321');
  });

  it('prefers guildId string over guild object', () => {
    expect(getGuildId({ guildId: '111', guild: { id: '222' } as any })).toBe('111');
  });

  it('throws for null guildId', () => {
    expect(() => getGuildId({ guildId: null })).toThrow();
  });

  it('throws for undefined guildId and null guild', () => {
    expect(() => getGuildId({ guild: null })).toThrow();
  });

  it('throws for empty object', () => {
    expect(() => getGuildId({})).toThrow();
  });
});
