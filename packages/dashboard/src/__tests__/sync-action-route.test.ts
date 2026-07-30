/**
 * Tests for POST /api/sync/action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/sync/action/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/sync/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeSupabase() {
  const inserted: Record<string, unknown>[] = [];
  const chain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      inserted.push(row);
      return chain;
    }),
    select: vi.fn(() => chain),
    single: vi.fn().mockResolvedValue({ data: { id: 'queue-1' }, error: null }),
    then: (resolve: (value: { data: { id: string }; error: null }) => unknown) =>
      resolve({ data: { id: 'queue-1' }, error: null }),
  };
  const supabase = { from: vi.fn(() => chain) };
  return { supabase, chain, inserted };
}

const driftItem = {
  entityType: 'role',
  entityName: 'Moderator',
  entityDiscordId: 'role-1',
  templateKey: 'role:moderator',
  type: 'PERMISSION_DRIFT',
  details: { permissions: { expected: '2048', actual: '1024' } },
};

beforeEach(() => {
  vi.resetAllMocks();
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
  });
});

describe('POST /api/sync/action', () => {
  it('queues repair actions through bot_action_queue', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({ action: 'repair', driftItem }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.success).toBe(true);
    expect(body.actionId).toBe('queue-1');
    expect(supabase.from).toHaveBeenCalledWith('bot_action_queue');
    expect(inserted[0]).toMatchObject({
      guild_id: 'guild-1',
      action: 'sync_repair_drift',
      payload: { driftItem: expect.objectContaining({
        templateKey: 'role:moderator',
        details: { permissions: { expected: '2048', actual: '1024' } },
      }) },
      status: 'pending',
    });
  });

  it('queues accept actions through bot_action_queue so the bot can update desired state', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({ action: 'accept', driftItem }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.success).toBe(true);
    expect(supabase.from).toHaveBeenCalledWith('bot_action_queue');
    expect(supabase.from).not.toHaveBeenCalledWith('sync_actions');
    expect(inserted[0]).toMatchObject({
      guild_id: 'guild-1',
      action: 'sync_accept_drift',
      payload: { driftItem },
      status: 'pending',
    });
  });

  it('queues structured channel permission drift accepts through bot_action_queue', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const permissionDrift = {
      entityType: 'channel',
      entityName: 'general → moderator',
      entityDiscordId: 'channel-1',
      templateKey: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideChannelKey: { expected: 'general', actual: 'general' },
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '1024' },
        deny: { expected: '0', actual: '0' },
      },
    };

    const res = await POST(makeRequest({ action: 'accept', driftItem: permissionDrift }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.success).toBe(true);
    expect(supabase.from).toHaveBeenCalledWith('bot_action_queue');
    expect(inserted[0]).toMatchObject({
      guild_id: 'guild-1',
      action: 'sync_accept_drift',
      payload: { driftItem: permissionDrift },
      status: 'pending',
    });
  });

  it('rejects unstructured channel permission drift accept instead of queuing false success', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'accept',
      driftItem: {
        entityType: 'channel',
        entityName: 'general -> moderator',
        entityDiscordId: 'channel-1',
        type: 'PERMISSION_DRIFT',
        details: { overwrite: { expected: '2048', actual: '1024' } },
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('structured permission overwrite details');
    expect(supabase.from).not.toHaveBeenCalledWith('bot_action_queue');
    expect(inserted).toHaveLength(0);
  });
});
