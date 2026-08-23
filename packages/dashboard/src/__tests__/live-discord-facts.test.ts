import { describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  validateAssignableDiscordTargets,
  validateDiscordRoleTargets,
  validateExternalWebhookChannel,
} from '@/lib/api/live-discord-facts';

const TEST_SUPABASE_URL = 'https://somnibot-test.supabase.co';
const TEST_SUPABASE_KEY = 'test-service-role-key';

type LiveDiscordClientFixture = {
  readonly supabase: SupabaseClient;
  readonly requests: Request[];
};

function client(row: unknown): LiveDiscordClientFixture {
  const requests: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const supabase: SupabaseClient = createClient(TEST_SUPABASE_URL, TEST_SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchMock },
  });

  return { supabase, requests };
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
      type: 0,
      manageableByBot: true,
      botPermissions: '3072',
    },
  ],
};

describe('live Discord benefit validation', () => {
  it('accepts targets proven assignable by a fresh v2 snapshot', async () => {
    const fixture = client(valid);
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
      'guild',
      ['10000000000000001'],
      ['20000000000000001'],
      now,
    );
    expect(result.ok).toBe(true);
  });

  it('distinguishes reference-only roles from roles SomniBot must mutate', async () => {
    const fixture = client(valid);
    const result = await validateDiscordRoleTargets(
      fixture.supabase,
      'guild',
      {
        assignableRoleIds: ['10000000000000001'],
        existingRoleIds: ['10000000000000002'],
      },
      now,
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed when an effect targets a managed Discord role', async () => {
    const fixture = client({
      ...valid,
      roles: [{ id: '10000000000000003', name: 'Integration', managed: true, editableByBot: false }],
    });
    const result = await validateDiscordRoleTargets(
      fixture.supabase,
      'guild',
      { assignableRoleIds: ['10000000000000003'], existingRoleIds: [] },
      now,
    );
    expect(result).toEqual({
      ok: false,
      kind: 'conflict',
      issues: ['Discord role "Integration" is managed by Discord and cannot be changed by SomniBot.'],
    });
  });

  it('reports deleted and unreachable targets before a product is accepted', async () => {
    const fixture = client(valid);
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
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
    const fixture = client({
      ...valid,
      channels: [{ ...valid.channels[0], botPermissions: '0' }],
    });
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
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

  it('rejects a visible channel benefit the bot cannot manage', async () => {
    const fixture = client({
      ...valid,
      channels: [{ ...valid.channels[0], manageableByBot: false }],
    });
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
      'guild',
      [],
      ['20000000000000001'],
      now,
    );
    expect(result).toEqual({
      ok: false,
      kind: 'conflict',
      issues: ['Grant SomniBot Manage Channels in "#customer-lounge" before selling this benefit.'],
    });
  });

  it.each([
    ['missing', null],
    ['legacy', { ...valid, snapshot_version: 1 }],
    ['stale', { ...valid, snapshot_at: '2026-07-30T18:40:00.000Z' }],
    ['malformed', { ...valid, roles: [{ id: 'broken' }] }],
  ])('fails closed when live facts are %s', async (_label, row) => {
    const fixture = client(row);
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
      'guild',
      ['10000000000000001'],
      [],
      now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('unavailable');
  });

  it('does not require a snapshot for reference-free product updates', async () => {
    const fixture = client(null);
    const result = await validateAssignableDiscordTargets(
      fixture.supabase,
      'guild',
      [],
      [],
      now,
    );
    expect(result.ok).toBe(true);
    expect(fixture.requests).toHaveLength(0);
  });

  it('accepts a relay destination only when a fresh text channel proves view and send', async () => {
    const fixture = client(valid);
    const result = await validateExternalWebhookChannel(
      fixture.supabase,
      'guild',
      '20000000000000001',
      now,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['voice channel', { ...valid.channels[0], type: 2 }, 'text or announcement'],
    ['missing Send Messages', { ...valid.channels[0], botPermissions: '1024' }, 'Send Messages'],
  ])('rejects a relay %s', async (_label, channel, issue) => {
    const fixture = client({ ...valid, channels: [channel] });
    const result = await validateExternalWebhookChannel(
      fixture.supabase,
      'guild',
      '20000000000000001',
      now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain(issue);
  });
});
