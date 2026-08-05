/**
 * PATCH /api/guild — validation for the newly-surfaced config controls.
 *
 * These columns all EXISTED in guild_config with the bot already honouring
 * them; what was missing was any way for an owner to set them. Adding the UI
 * is only half the fix — the route has to accept them, and its Zod ranges have
 * to mirror the database CHECK constraints exactly.
 *
 * That mirroring is the whole point of these tests: if the schema is looser
 * than the CHECK, a plausible value passes validation and then dies deep in
 * Postgres as a raw 23514, which surfaces to the owner as an unexplained
 * failure. If it is tighter, a legitimate value is refused for no reason.
 *
 * Constraints mirrored here:
 *   team_max_pending_invitations  BETWEEN 1 AND 100         (20260723193000)
 *   team_invitation_expiry_ms     BETWEEN 3.6e6 AND 2.592e9 (20260723193000)
 *   memory_alert_threshold_mb     BETWEEN 128 AND 8192      (20260804145000)
 *   ws_ping_alert_threshold_ms    BETWEEN 50 AND 10000      (20260727000000)
 *   webhook_error_rate_threshold  BETWEEN 0 AND 1           (20260727000000)
 *   diagnostics_snapshot_interval_ms BETWEEN 15000 AND 600000 (20260804145000)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/admin-changes', () => ({
  recordGuildConfigChange: vi.fn().mockResolvedValue(undefined),
  readGuildConfigBefore: vi.fn().mockResolvedValue({}),
}));

import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/guild/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD = '111111111111111111';
let configUpsert: ReturnType<typeof vi.fn>;
let persistedConfig: Record<string, unknown>;

function patch(body: unknown) {
  return new NextRequest('http://x/api/guild', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedConfig = {
    diagnostics_guided_mode: true,
    memory_alert_threshold_mb: 512,
    ws_ping_alert_threshold_ms: 500,
    diagnostics_snapshot_interval_ms: 60000,
  };
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'u', discordId: '222222222222222222', guildId: GUILD },
  } as never);
  const chain: Record<string, unknown> = {
    maybeSingle: vi.fn(async () => ({ data: {}, error: null })),
    then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
  };
  configUpsert = vi.fn((payload: Record<string, unknown>) => {
    persistedConfig = { ...persistedConfig, ...payload };
    return chain;
  });
  for (const m of ['select', 'eq', 'update']) chain[m] = vi.fn(() => chain);
  chain.upsert = configUpsert;
  vi.mocked(createAdminSupabase).mockReturnValue({ from: vi.fn(() => chain) } as never);
});

describe('team invitation controls', () => {
  it('accepts the consent-model settings', async () => {
    const res = await PATCH(patch({
      team_direct_assignment_enabled: true,
      team_invite_dm_enabled: false,
      team_max_pending_invitations: 50,
      team_invitation_expiry_ms: 604_800_000,
    }));
    expect(res.status).toBe(200);
  });

  it.each([
    ['zero pending invitations', { team_max_pending_invitations: 0 }],
    ['over the 100 cap', { team_max_pending_invitations: 101 }],
    ['expiry under one hour', { team_invitation_expiry_ms: 3_599_999 }],
    ['expiry over 30 days', { team_invitation_expiry_ms: 2_592_000_001 }],
  ])('rejects %s before it reaches the database', async (_label, body) => {
    const res = await PATCH(patch(body));
    // A 400 here is the readable error; letting it through would produce a
    // raw CHECK violation the owner cannot act on.
    expect(res.status).toBe(400);
  });

  it('accepts the exact CHECK boundaries', async () => {
    for (const body of [
      { team_max_pending_invitations: 1 },
      { team_max_pending_invitations: 100 },
      { team_invitation_expiry_ms: 3_600_000 },
      { team_invitation_expiry_ms: 2_592_000_000 },
    ]) {
      const res = await PATCH(patch(body));
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
  });
});

describe('fraud notification routing', () => {
  it('accepts a staff channel and the owner-DM toggle', async () => {
    const res = await PATCH(patch({
      fraud_staff_alert_channel_id: '333333333333333333',
      fraud_owner_dm_on_critical: false,
    }));
    expect(res.status).toBe(200);
  });

  it('accepts clearing the staff channel', async () => {
    // Null means "announce nowhere" — a legitimate choice, not a missing value.
    const res = await PATCH(patch({ fraud_staff_alert_channel_id: null }));
    expect(res.status).toBe(200);
  });
});

describe('diagnostics controls', () => {
  it('accepts guided mode and in-range thresholds', async () => {
    const res = await PATCH(patch({
      diagnostics_guided_mode: false,
      memory_alert_threshold_mb: 1024,
      ws_ping_alert_threshold_ms: 250,
      webhook_error_rate_threshold: 0.5,
    }));
    expect(res.status).toBe(200);
  });

  it.each([
    ['memory below the floor', { memory_alert_threshold_mb: 63 }],
    ['memory above the ceiling', { memory_alert_threshold_mb: 16_385 }],
    ['ping below the floor', { ws_ping_alert_threshold_ms: 49 }],
    ['ping above the ceiling', { ws_ping_alert_threshold_ms: 10_001 }],
    ['error rate above 1', { webhook_error_rate_threshold: 1.5 }],
    ['negative error rate', { webhook_error_rate_threshold: -0.1 }],
  ])('rejects %s before it reaches the database', async (_label, body) => {
    const res = await PATCH(patch(body));
    expect(res.status).toBe(400);
  });

  it('keeps the prior persisted values after an invalid update', async () => {
    const valid = await PATCH(patch({
      memory_alert_threshold_mb: 1024,
      diagnostics_snapshot_interval_ms: 30000,
    }));
    expect(valid.status).toBe(200);
    const beforeInvalid = { ...persistedConfig };
    configUpsert.mockClear();

    const invalid = await PATCH(patch({
      memory_alert_threshold_mb: 0,
      diagnostics_snapshot_interval_ms: 1000,
    }));

    expect(invalid.status).toBe(400);
    expect(configUpsert).not.toHaveBeenCalled();
    expect(persistedConfig).toEqual(beforeInvalid);
  });
});
