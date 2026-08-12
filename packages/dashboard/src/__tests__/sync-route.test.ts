/**
 * Tests for legacy POST /api/sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));

import { POST } from '@/app/api/sync/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/sync', {
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
    upsert: vi.fn(() => chain),
    then: (resolve: (value: { data: null; error: null }) => unknown) =>
      resolve({ data: null, error: null }),
  };
  const supabase = { from: vi.fn(() => chain) };
  return { supabase, inserted, chain };
}

beforeEach(() => {
  vi.resetAllMocks();
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
  });
});

describe('POST /api/sync', () => {
  it('rejects legacy channel permission drift accepts instead of reporting queued success', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'accept',
      entityType: 'channel',
      entityId: 'channel-1',
      entityName: 'general -> Moderator',
      driftType: 'PERMISSION_DRIFT',
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('manual review');
    expect(supabase.from).not.toHaveBeenCalledWith('audit_logs');
    expect(inserted).toHaveLength(0);
  });

  it('rejects update_config with an out-of-range interval (2000) with 400 and no write', async () => {
    const { supabase, chain } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'update_config',
      syncEnabled: true,
      syncIntervalMinutes: 2000,
      autoRepair: false,
      autoRepairEveryone: false,
    }));

    expect(res.status).toBe(400);
    expect(chain.upsert).not.toHaveBeenCalled();
  });

  it('rejects update_config with a below-minimum interval (3) with 400 — bound unified at 5', async () => {
    const { supabase, chain } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'update_config',
      syncEnabled: true,
      syncIntervalMinutes: 3,
      autoRepair: false,
      autoRepairEveryone: false,
    }));

    expect(res.status).toBe(400);
    expect(chain.upsert).not.toHaveBeenCalled();
  });

  it('accepts update_config with an in-range interval (15)', async () => {
    const { supabase, chain } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'update_config',
      syncEnabled: true,
      syncIntervalMinutes: 15,
      autoRepair: false,
      autoRepairEveryone: false,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sync_interval_minutes: 15 }),
      expect.anything(),
    );
    expect(notifyBot).toHaveBeenCalledWith('guild-1', 'settings', {
      sync_enabled: true,
      sync_interval_minutes: 15,
      sync_auto_repair: false,
      sync_auto_repair_everyone: false,
    });
  });

  it('keeps legacy non-permission accepts working', async () => {
    const { supabase, inserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(makeRequest({
      action: 'accept',
      entityType: 'channel',
      entityId: 'channel-1',
      entityName: 'general',
      driftType: 'TOPIC_DRIFT',
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, message: 'accept queued' });
    expect(inserted[0]).toMatchObject({
      guild_id: 'guild-1',
      action: 'drift.accept',
      target_type: 'channel',
      target_id: 'channel-1',
    });
  });
});
