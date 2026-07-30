import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/admin-changes', () => ({
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
}));

import { GET, PATCH, PUT } from '@/app/api/automations/holds/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { recordCrudChange } from '@/lib/admin-changes';
import { mockAuthSuccess } from './helpers/mock-auth';

const HOLD_ID = '10000000-0000-8000-8000-000000000001';
const HOLD = {
  id: HOLD_ID,
  guild_id: 'guild-1',
  automation_id: '20000000-0000-8000-8000-000000000001',
  status: 'held',
  member_count: 26,
  threshold: 25,
};

function request(method: string, body: unknown) {
  return new NextRequest('http://localhost/api/automations/holds', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeAdmin(options: {
  holds?: unknown[];
  threshold?: number;
  decided?: unknown;
  configUpdated?: unknown;
} = {}) {
  const calls: Record<string, unknown[][]> = {};
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        (calls[`${table}.${method}`] ??= []).push(args);
        return chain;
      });
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(
      table === 'guild_config'
        ? { data: { automation_mass_action_threshold: options.threshold ?? 25 }, error: null }
        : { data: options.decided ?? null, error: null },
    ));
    chain.single = vi.fn(() => Promise.resolve({
      data: options.configUpdated ?? { automation_mass_action_threshold: options.threshold ?? 25 },
      error: null,
    }));
    chain.then = (resolve: (value: unknown) => unknown) => resolve({
      data: table === 'automation_mass_action_holds' ? options.holds ?? [] : null,
      error: null,
    });
    return chain;
  };
  return {
    admin: { from: vi.fn((table: string) => makeChain(table)) },
    calls,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, {
    guildId: 'guild-1',
    discordId: 'owner-1',
  });
});

describe('/api/automations/holds', () => {
  it('lists only the active guild holds and returns its configurable threshold', async () => {
    const { admin, calls } = makeAdmin({ holds: [HOLD], threshold: 30 });
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);

    const response = await GET();
    const json = await response.json();

    expect(json).toMatchObject({ success: true, data: [HOLD], threshold: 30 });
    expect(calls['automation_mass_action_holds.eq']).toContainEqual(['guild_id', 'guild-1']);
  });

  it('approves only a still-held occurrence with the authenticated owner identity', async () => {
    const { admin, calls } = makeAdmin({
      decided: { ...HOLD, status: 'approved', approved_by: 'owner-1' },
    });
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);

    const response = await PATCH(request('PATCH', { id: HOLD_ID, decision: 'approve' }));
    expect(response.status).toBe(200);
    expect(calls['automation_mass_action_holds.eq']).toEqual(expect.arrayContaining([
      ['id', HOLD_ID],
      ['guild_id', 'guild-1'],
      ['status', 'held'],
    ]));
    const update = calls['automation_mass_action_holds.update'][0][0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'approved', approved_by: 'owner-1' });
    expect(recordCrudChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'automations.mass_action_approved', blastRadius: 'high' }),
      admin,
    );
  });

  it('returns conflict when another owner or worker already decided the hold', async () => {
    const { admin } = makeAdmin({ decided: null });
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);
    const response = await PATCH(request('PATCH', { id: HOLD_ID, decision: 'reject' }));
    expect(response.status).toBe(409);
  });

  it('rejects malformed identities and decisions before writing', async () => {
    const { admin, calls } = makeAdmin();
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);
    expect((await PATCH(request('PATCH', { id: 'not-a-uuid', decision: 'approve' }))).status).toBe(400);
    expect((await PATCH(request('PATCH', { id: HOLD_ID, decision: 'execute-all' }))).status).toBe(400);
    expect(calls['automation_mass_action_holds.update']).toBeUndefined();
  });

  it('enforces the documented 1..500 threshold range', async () => {
    const { admin, calls } = makeAdmin({ threshold: 40 });
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);
    expect((await PUT(request('PUT', { threshold: 0 }))).status).toBe(400);
    expect((await PUT(request('PUT', { threshold: 501 }))).status).toBe(400);
    expect((await PUT(request('PUT', { threshold: 12.5 }))).status).toBe(400);
    expect((await PUT(request('PUT', { threshold: 40 }))).status).toBe(200);
    expect(calls['guild_config.update'][0][0]).toEqual({
      automation_mass_action_threshold: 40,
    });
  });
});
