/**
 * Discord-side undo validation.
 *
 * Undo payloads are read back out of admin_changes, so a tampered row must not
 * be able to turn "undo" into arbitrary bot work. Only structural inverses are
 * accepted, and only with the fields they need.
 */
import { describe, it, expect } from 'vitest';
import { isDiscordUndo, validateDiscordUndo } from '@/lib/api/undo-allowlist';

describe('isDiscordUndo', () => {
  it('distinguishes Discord undos from row-update undos', () => {
    expect(isDiscordUndo({ kind: 'discord', action: 'delete_role', payload: {} })).toBe(true);
    expect(isDiscordUndo({ table: 'guild_config', data: {}, match: {} })).toBe(false);
    expect(isDiscordUndo(null)).toBe(false);
    expect(isDiscordUndo('delete everything')).toBe(false);
  });
});

describe('validateDiscordUndo', () => {
  it('accepts a structural inverse with its expected fields', () => {
    const result = validateDiscordUndo({
      kind: 'discord',
      action: 'delete_role',
      payload: { discord_id: '555', id: '555' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('delete_role');
      expect(result.payload).toEqual({ discord_id: '555', id: '555' });
    }
  });

  it('rejects a queue action that is not a reversal', () => {
    // These are real bot actions — undo must not be a way to invoke them.
    for (const action of ['bulk_send_dm', 'fulfill_purchase', 'revoke_roles', 'bulk_role_add']) {
      const result = validateDiscordUndo({ kind: 'discord', action, payload: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('not a reversible Discord action');
    }
  });

  it('rejects fields outside the action’s allowlist', () => {
    const result = validateDiscordUndo({
      kind: 'discord',
      action: 'delete_role',
      payload: { discord_id: '555', guild_id: 'someone-elses-guild' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('guild_id');
  });

  it('rejects a delete with no target', () => {
    const result = validateDiscordUndo({
      kind: 'discord',
      action: 'delete_channel',
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no target id');
  });

  it('rejects prototype-polluting action names', () => {
    for (const action of ['__proto__', 'constructor', 'toString']) {
      const result = validateDiscordUndo({ kind: 'discord', action, payload: {} });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects malformed payloads', () => {
    expect(validateDiscordUndo(null).ok).toBe(false);
    expect(validateDiscordUndo({ kind: 'discord', action: 42, payload: {} }).ok).toBe(false);
    expect(validateDiscordUndo({ kind: 'discord', action: 'delete_role', payload: 'x' }).ok)
      .toBe(false);
  });
});
