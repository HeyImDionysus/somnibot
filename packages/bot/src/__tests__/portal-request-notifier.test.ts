/**
 * Portal-request notifier — telling the buyer what the owner decided.
 *
 * The dashboard decides refund/support requests but cannot reach Discord, so
 * without this worker the queue moved and the customer was never told.
 *
 * The properties that matter are about the ONE-SHOT nature of a notification:
 *   - the latch is claimed BEFORE the DM, so a failed latch write cannot cause
 *     the same decision to be re-sent on every tick;
 *   - a lost claim (another tick won) sends nothing;
 *   - an approved REFUND request must not tell the buyer they have been paid —
 *     the decision and the money are separate;
 *   - a buyer with closed DMs surfaces to the owner rather than vanishing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true }),
}));

vi.mock('../features/branding/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/branding/index.js')>()),
  resolveBrandKit: vi.fn(async () => ({
    brandName: 'Acme Store',
    primaryColor: 0x1e90ff,
    accentColor: 0x00ced1,
    voicePreset: 'default',
    poweredByAttribution: 'Powered by SomniBot',
    currencyName: 'Coins',
    currencyEmoji: '🪙',
  })),
}));

import { PortalRequestNotifier } from '../features/commerce/portal-request-notifier.js';
import { raiseOwnerAlert } from '../services/alert-service.js';

const GUILD = 'guild-1';
const BUYER = '444444444444444444';

const DECIDED = {
  id: 'req-1',
  guild_id: GUILD,
  type: 'refund',
  status: 'resolved',
  resolution_note: 'Approved, sorry for the trouble.',
  order_id: 'order-1',
  customers: { discord_id: BUYER },
  orders: { order_number: 'ORD-001' },
};

/**
 * Supabase stub. `claimWins` controls whether the conditional latch UPDATE
 * matches a row — false models another tick having already claimed it.
 */
function makeSupa(opts: {
  decided?: Array<Record<string, unknown>>;
  aged?: Array<{ guild_id: string }>;
  claimWins?: boolean;
} = {}) {
  const claims: string[] = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    let isUpdate = false;
    for (const m of ['select', 'eq', 'not', 'in', 'lt', 'limit']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        if (isUpdate && args[0] === 'id') claims.push(String(args[1]));
        return chain;
      });
    }
    chain.update = vi.fn(() => { isUpdate = true; return chain; });
    chain.maybeSingle = vi.fn(async () => ({
      data: (opts.claimWins ?? true) ? { id: 'req-1' } : null,
      error: null,
    }));
    chain.then = (resolve: (v: unknown) => unknown) => {
      // Two different reads hit this table: decided-undelivered, then aged.
      const isAged = (chain.lt as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      return resolve({
        data: table !== 'commerce_portal_requests'
          ? []
          : isAged ? (opts.aged ?? []) : (opts.decided ?? []),
        error: null,
      });
    };
    return chain;
  });
  return { supabase: { from } as never, claims };
}

function makeClient(opts: { dmThrows?: boolean } = {}) {
  const send = opts.dmThrows
    ? vi.fn().mockRejectedValue(new Error('Cannot send messages to this user'))
    : vi.fn().mockResolvedValue({});
  return {
    client: {
      guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'Test Guild' }]]) },
      users: { fetch: vi.fn(async () => ({ send })) },
    } as never,
    send,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(raiseOwnerAlert).mockResolvedValue({ inserted: true } as never);
});

describe('delivering a decision', () => {
  it('DMs the buyer and claims the latch', async () => {
    const { supabase, claims } = makeSupa({ decided: [DECIDED] });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    expect(claims).toContain('req-1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when another tick already claimed it', async () => {
    const { supabase } = makeSupa({ decided: [DECIDED], claimWins: false });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    // The whole point of the latch: overlapping ticks must not both DM.
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT tell the buyer they have been paid for an approved refund', async () => {
    const { supabase } = makeSupa({ decided: [DECIDED] });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    const payload = send.mock.calls[0]![0] as { embeds: Array<{ data: Record<string, unknown> }> };
    const text = JSON.stringify(payload.embeds[0]!.data);
    // Approving the REQUEST is not the same as the money arriving.
    expect(text).toContain('processed separately');
    expect(text).not.toMatch(/you have been refunded|refund complete/i);
  });

  it('carries the owner note so a decision is never a bare yes/no', async () => {
    const { supabase } = makeSupa({ decided: [DECIDED] });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    const payload = send.mock.calls[0]![0] as { embeds: Array<{ data: Record<string, unknown> }> };
    expect(JSON.stringify(payload.embeds[0]!.data)).toContain('sorry for the trouble');
  });

  it('never pings anyone from a DM', async () => {
    const { supabase } = makeSupa({ decided: [DECIDED] });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    const payload = send.mock.calls[0]![0] as { allowedMentions?: { parse: string[] } };
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('tells the OWNER when the buyer has DMs closed', async () => {
    const { supabase } = makeSupa({ decided: [DECIDED] });
    const { client } = makeClient({ dmThrows: true });

    await new PortalRequestNotifier(client, supabase).runOnce();

    // The latch is already consumed, so a silent failure would lose the
    // notification entirely — the owner has to hear about it.
    const alerted = vi.mocked(raiseOwnerAlert).mock.calls
      .find((c) => (c[2] as { alertType: string }).alertType === 'portal_request_dm_failed');
    expect(alerted).toBeDefined();
  });

  it('skips a guild that is not cached rather than burning the latch', async () => {
    const { supabase, claims } = makeSupa({ decided: [{ ...DECIDED, guild_id: 'other-guild' }] });
    const { client, send } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    // Consuming the one-shot flag on a shard that cannot send would drop the
    // notification permanently.
    expect(claims).not.toContain('req-1');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('aged pending requests', () => {
  it('raises one alert per guild for requests left waiting', async () => {
    const { supabase } = makeSupa({
      aged: [{ guild_id: GUILD }, { guild_id: GUILD }, { guild_id: GUILD }],
    });
    const { client } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    const pending = vi.mocked(raiseOwnerAlert).mock.calls
      .filter((c) => (c[2] as { alertType: string }).alertType === 'portal_request_pending');
    // Three aged requests, ONE alert — not three.
    expect(pending).toHaveLength(1);
    expect((pending[0]![2] as { message: string }).message).toContain('3 refund/support request');
  });

  it('stays quiet when nothing is overdue', async () => {
    const { supabase } = makeSupa({ aged: [] });
    const { client } = makeClient();

    await new PortalRequestNotifier(client, supabase).runOnce();

    const pending = vi.mocked(raiseOwnerAlert).mock.calls
      .filter((c) => (c[2] as { alertType: string }).alertType === 'portal_request_pending');
    expect(pending).toHaveLength(0);
  });
});
