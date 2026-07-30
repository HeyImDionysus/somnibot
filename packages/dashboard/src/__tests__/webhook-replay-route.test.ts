import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const replaySecret = 'test-webhook-replay-secret';
const replayClaimToken = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/webhooks/[id]/replay/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

type ChainResult = { data: unknown; error: unknown };

function makeChain(
  result: ChainResult,
  onUpdate?: (payload: unknown) => void,
  onEq?: (column: string, value: unknown) => void,
  onIs?: (column: string, value: unknown) => void,
  onLt?: (column: string, value: unknown) => void,
) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'single', 'maybeSingle']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.eq = vi.fn((column: string, value: unknown) => {
    onEq?.(column, value);
    return chain;
  });
  chain.is = vi.fn((column: string, value: unknown) => {
    onIs?.(column, value);
    return chain;
  });
  chain.lt = vi.fn((column: string, value: unknown) => {
    onLt?.(column, value);
    return chain;
  });
  chain.update = vi.fn((payload: unknown) => {
    onUpdate?.(payload);
    return chain;
  });
  chain.insert = vi.fn(() => chain);
  chain.then = (
    resolve: (value: ChainResult) => unknown,
    reject?: (reason: unknown) => void,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeSupabase(
  event: Record<string, unknown>,
  options: { claimResult?: ChainResult } = {},
) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const isCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const ltCalls: Array<{ table: string; column: string; value: unknown }> = [];
  const tableCallCounts = new Map<string, number>();
  const rpc = vi.fn(async (name: string) => {
    if (name === 'webhooks_abandon_stale_replay_claim') {
      return { data: true, error: null };
    }
    if (name === 'webhooks_finish_replay_claim') {
      return { data: true, error: null };
    }
    if (name !== 'webhooks_claim_scoped_replay') {
      return { data: null, error: null };
    }
    if (options.claimResult) {
      return options.claimResult.data == null
        ? { data: [{ outcome: 'processing', event_data: null }], error: options.claimResult.error }
        : options.claimResult;
    }
    const processedAt = Date.parse(String(event.processed_at ?? ''));
    const recentProcessing = event.result == null
      && (!Number.isFinite(processedAt) || Date.now() - processedAt < 5 * 60 * 1000);
    return {
      data: [{
        outcome: recentProcessing ? 'processing' : 'claimed',
        event_data: recentProcessing ? null : event,
        claim_token: recentProcessing ? null : replayClaimToken,
      }],
      error: null,
    };
  });
  const supabase = {
    rpc,
    from: vi.fn((table: string) => {
      const count = tableCallCounts.get(table) ?? 0;
      tableCallCounts.set(table, count + 1);

      if (table === 'webhook_events' && count === 0) {
        return makeChain(
          { data: event, error: null },
          undefined,
          (column, value) => eqCalls.push({ table, column, value }),
        );
      }
      if (table === 'webhook_events') {
        return makeChain(
          options.claimResult ?? { data: { event_id: event.event_id }, error: null },
          (payload) => updates.push(payload),
          (column, value) => eqCalls.push({ table, column, value }),
          (column, value) => isCalls.push({ table, column, value }),
          (column, value) => ltCalls.push({ table, column, value }),
        );
      }
      if (table === 'bot_action_queue') {
        const chain = makeChain({ data: null, error: null });
        chain.insert = vi.fn((payload: unknown) => {
          inserts.push(payload);
          return chain;
        });
        return chain;
      }
      return makeChain({ data: null, error: null });
    }),
  };
  return { supabase, updates, inserts, eqCalls, isCalls, ltCalls };
}

describe('POST /api/webhooks/[id]/replay', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.WEBHOOK_REPLAY_SECRET = replaySecret;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WEBHOOK_REPLAY_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('marks null-result replays as failed-event retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase({
      event_id: 'EVT-STUCK',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      guild_id: 'guild-1',
      result: null,
      processed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      replay_count: 0,
      payload: {
        id: 'EVT-STUCK',
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-STUCK' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(new Request('http://localhost/api/webhooks/EVT-STUCK/replay'), {
      params: Promise.resolve({ id: 'EVT-STUCK' }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/paypal/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'PayPal-Transmission-Id': 'EVT-STUCK',
          'X-Replay-Secret': replaySecret,
          'X-Replay-Claim-Token': replayClaimToken,
          'X-Webhook-Retrying-Failed-Event': '1',
        }),
      }),
    );
  });

  it('marks successful subscription expiry replays as failed-event retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase({
      event_id: 'EVT-EXPIRED-SUCCESS-ASYNC-FAIL',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      guild_id: 'guild-1',
      result: 'success',
      replay_count: 1,
      payload: {
        id: 'EVT-EXPIRED-SUCCESS-ASYNC-FAIL',
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-ASYNC-ROLE-FAIL' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(
      new Request('http://localhost/api/webhooks/EVT-EXPIRED-SUCCESS-ASYNC-FAIL/replay'),
      {
        params: Promise.resolve({ id: 'EVT-EXPIRED-SUCCESS-ASYNC-FAIL' }),
      },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/paypal/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Webhook-Retrying-Failed-Event': '1',
        }),
      }),
    );
  });

  it('passes the stored event id when replaying payloads without an id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase({
      event_id: 'TRANSMISSION-ONLY',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      guild_id: 'guild-1',
      result: 'error',
      replay_count: 0,
      payload: {
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-TRANSMISSION-ONLY' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(
      new Request('http://localhost/api/webhooks/TRANSMISSION-ONLY/replay'),
      {
        params: Promise.resolve({ id: 'TRANSMISSION-ONLY' }),
      },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/paypal/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'PayPal-Transmission-Id': 'TRANSMISSION-ONLY',
        }),
        body: JSON.stringify({
          event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
          resource: { id: 'SUB-TRANSMISSION-ONLY' },
        }),
      }),
    );
  });

  it('scopes replay lookup and claim to the owner guild', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase, updates } = makeSupabase({
      event_id: 'EVT-GUILD-SCOPED',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      guild_id: 'guild-1',
      result: 'error',
      replay_count: 0,
      payload: {
        id: 'EVT-GUILD-SCOPED',
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-GUILD-SCOPED' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(new Request('http://localhost/api/webhooks/EVT-GUILD-SCOPED/replay'), {
      params: Promise.resolve({ id: 'EVT-GUILD-SCOPED' }),
    });

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('webhooks_claim_scoped_replay', {
      p_event_id: 'EVT-GUILD-SCOPED',
      p_guild_id: 'guild-1',
      p_discord_id: 'discord-1',
      p_stale_seconds: 300,
    });
    expect(updates).toHaveLength(0);
  });

  it('rejects non-stale null-result replay rows as already processing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase({
      event_id: 'EVT-RECENT-NULL',
      event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
      guild_id: 'guild-1',
      result: null,
      processed_at: new Date().toISOString(),
      replay_count: 0,
      payload: {
        id: 'EVT-RECENT-NULL',
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        resource: { id: 'SUB-RECENT-NULL' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(new Request('http://localhost/api/webhooks/EVT-RECENT-NULL/replay'), {
      params: Promise.resolve({ id: 'EVT-RECENT-NULL' }),
    });

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects replay when the atomic claim loses a race', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase(
      {
        event_id: 'EVT-CLAIM-RACE',
        event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
        guild_id: 'guild-1',
        result: 'success',
        replay_count: 0,
        payload: {
          id: 'EVT-CLAIM-RACE',
          event_type: 'BILLING.SUBSCRIPTION.EXPIRED',
          resource: { id: 'SUB-CLAIM-RACE' },
        },
      },
      { claimResult: { data: null, error: null } },
    );
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(new Request('http://localhost/api/webhooks/EVT-CLAIM-RACE/replay'), {
      params: Promise.resolve({ id: 'EVT-CLAIM-RACE' }),
    });

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the claim fenced when internal dispatch has an ambiguous failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    const { supabase } = makeSupabase({
      event_id: 'EVT-AMBIGUOUS-DISPATCH',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      guild_id: 'guild-1',
      result: 'error',
      replay_count: 0,
      payload: {
        id: 'EVT-AMBIGUOUS-DISPATCH',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAPTURE-1' },
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(
      new Request('http://localhost/api/webhooks/EVT-AMBIGUOUS-DISPATCH/replay'),
      { params: Promise.resolve({ id: 'EVT-AMBIGUOUS-DISPATCH' }) },
    );

    expect(res.status).toBe(502);
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'webhooks_finish_replay_claim',
      expect.anything(),
    );
  });

  it('explicitly abandons a stale claim without dispatching another replay', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { supabase } = makeSupabase({
      event_id: 'EVT-STALE-RECOVERY',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      guild_id: 'guild-1',
      result: null,
      replay_count: 1,
      payload: {},
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await POST(
      new Request('http://localhost/api/webhooks/EVT-STALE-RECOVERY/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abandon_stale_claim' }),
      }),
      { params: Promise.resolve({ id: 'EVT-STALE-RECOVERY' }) },
    );

    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith(
      'webhooks_abandon_stale_replay_claim',
      {
        p_event_id: 'EVT-STALE-RECOVERY',
        p_guild_id: 'guild-1',
        p_discord_id: 'discord-1',
        p_stale_seconds: 900,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
