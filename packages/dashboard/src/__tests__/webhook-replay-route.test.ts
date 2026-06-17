import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const replaySecret = 'test-webhook-replay-secret';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/webhooks/[id]/replay/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

type ChainResult = { data: unknown; error: unknown };

function makeChain(result: ChainResult, onUpdate?: (payload: unknown) => void) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'single']) {
    chain[method] = vi.fn(() => chain);
  }
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

function makeSupabase(event: Record<string, unknown>) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const tableCallCounts = new Map<string, number>();
  const supabase = {
    from: vi.fn((table: string) => {
      const count = tableCallCounts.get(table) ?? 0;
      tableCallCounts.set(table, count + 1);

      if (table === 'webhook_events' && count === 0) {
        return makeChain({ data: event, error: null });
      }
      if (table === 'webhook_events') {
        return makeChain({ data: null, error: null }, (payload) => updates.push(payload));
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
  return { supabase, updates, inserts };
}

describe('POST /api/webhooks/[id]/replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      result: null,
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
});
