import { describe, expect, it, vi } from 'vitest';
import { validateAssignableDiscordTargets } from '@/lib/api/live-discord-facts';

function client(row: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: row, error }));
  return { from: vi.fn(() => chain) };
}

const now = Date.parse('2026-07-30T19:00:00.000Z');
const valid = {
  snapshot_version: 2,
  snapshot_at: '2026-07-30T18:55:00.000Z',
  roles: [
    { id: '10000000000000001', name: 'Customer', managed: false, editableByBot: true },
    { id: '10000000000000002', name: 'Admin', managed: false, editableByBot: false },
  ],
  channels: [
    {
      id: '20000000000000001',
      name: 'customer-lounge',
      manageableByBot: true,
      botPermissions: '3072',
    },
  ],
};

describe('live Discord benefit validation', () => {
  it('accepts targets proven assignable by a fresh v2 snapshot', async () => {
    const result = await validateAssignableDiscordTargets(
      client(valid) as never,
      'guild',
      ['10000000000000001'],
      ['20000000000000001'],
      now,
    );
    expect(result.ok).toBe(true);
  });

  it('reports deleted and unreachable targets before a product is accepted', async () => {
    const result = await validateAssignableDiscordTargets(
      client(valid) as never,
      'guild',
      ['10000000000000002', '10000000000000999'],
      ['20000000000000999'],
      now,
    );
    expect(result).toEqual({
      ok: false,
      kind: 'conflict',
      issues: [
        'Move SomniBot above the "Admin" role and grant Manage Roles before selling this benefit.',
        'Discord role 10000000000000999 was deleted or is not in this server.',
        'Discord channel 20000000000000999 was deleted or is not in this server.',
      ],
    });
  });

  it('rejects a channel benefit the bot cannot see before the product is accepted', async () => {
    const result = await validateAssignableDiscordTargets(
      client({
        ...valid,
        channels: [{ ...valid.channels[0], botPermissions: '0' }],
      }) as never,
      'guild',
      [],
      ['20000000000000001'],
      now,
    );
    expect(result).toEqual({
      ok: false,
      kind: 'conflict',
      issues: ['Grant SomniBot View Channel in "#customer-lounge" before selling this benefit.'],
    });
  });

  it.each([
    ['missing', null],
    ['legacy', { ...valid, snapshot_version: 1 }],
    ['stale', { ...valid, snapshot_at: '2026-07-30T18:40:00.000Z' }],
    ['malformed', { ...valid, roles: [{ id: 'broken' }] }],
  ])('fails closed when live facts are %s', async (_label, row) => {
    const result = await validateAssignableDiscordTargets(
      client(row) as never,
      'guild',
      ['10000000000000001'],
      [],
      now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unavailable');
  });

  it('does not require a snapshot for reference-free product updates', async () => {
    const supabase = client(null);
    const result = await validateAssignableDiscordTargets(
      supabase as never,
      'guild',
      [],
      [],
      now,
    );
    expect(result.ok).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
