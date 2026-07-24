/**
 * Tests for PUT /api/sync/config interval validation.
 *
 * Regression: this route used to Zod-parse then silently CLAMP the interval
 * (1-4 → 5, and a dead `> 1440` branch). The clamp is removed; the schema
 * (schemas.sync.config, min 5 max 1440) now rejects out-of-range values with a
 * 400 and no partial write — identical to POST /api/sync update_config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));

import { PUT } from '@/app/api/sync/config/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/sync/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeSupabase() {
  const upserted: Record<string, unknown>[] = [];
  const chain = {
    upsert: vi.fn((row: Record<string, unknown>) => {
      upserted.push(row);
      return Promise.resolve({ data: null, error: null });
    }),
  };
  const supabase = { from: vi.fn(() => chain) };
  return { supabase, chain, upserted };
}

beforeEach(() => {
  vi.clearAllMocks();
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
  });
});

describe('PUT /api/sync/config interval validation', () => {
  it('rejects an out-of-range interval (2000) with 400 and no write', async () => {
    const { supabase, chain, upserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await PUT(makeRequest({ sync_interval_minutes: 2000 }));

    expect(res.status).toBe(400);
    expect(chain.upsert).not.toHaveBeenCalled();
    expect(upserted).toHaveLength(0);
  });

  it('rejects a below-minimum interval (3) with 400 instead of silently clamping to 5', async () => {
    const { supabase, chain, upserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await PUT(makeRequest({ sync_interval_minutes: 3 }));

    expect(res.status).toBe(400);
    expect(chain.upsert).not.toHaveBeenCalled();
    // The value is rejected, never coerced to 5 and persisted.
    expect(upserted).toHaveLength(0);
  });

  it('persists an in-range interval (15) verbatim (no clamp)', async () => {
    const { supabase, upserted } = makeSupabase();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await PUT(makeRequest({ sync_interval_minutes: 15 }));

    expect(res.status).toBe(200);
    expect(upserted[0]).toMatchObject({ guild_id: 'guild-1', sync_interval_minutes: 15 });
  });
});
