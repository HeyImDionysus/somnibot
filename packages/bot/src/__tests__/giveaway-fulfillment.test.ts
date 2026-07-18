import { describe, expect, it, vi } from 'vitest';
import {
  GiveawayFulfillmentService,
  GiveawayPrizeContractError,
} from '../services/giveaway-fulfillment.js';
import { deterministicUuidV8 } from '../utils/deterministic-uuid.js';

const GUILD_ID = '12345678901234567';
const WINNER_ID = '22345678901234567';
const OTHER_WINNER_ID = '22345678901234568';
const ROLE_ID = '32345678901234567';
const CHANNEL_ID = '42345678901234567';
const GIVEAWAY_ID = '00000000-0000-4000-a000-000000000001';
const PRODUCT_ID = '00000000-0000-4000-a000-000000000002';
const CUSTOMER_ID = '00000000-0000-4000-a000-000000000003';
const ENTITLEMENT_ID = '00000000-0000-4000-a000-000000000004';
const UNTRUSTED_CUSTOMER_ID = '00000000-0000-4000-a000-000000000005';
const MESSAGE_ID = '52345678901234567';

type QueryResult = {
  data: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
};

const PRODUCT = {
  id: PRODUCT_ID,
  name: 'VIP Prize',
  type: 'one_time',
  granted_role_ids: [ROLE_ID],
  granted_channel_ids: [CHANNEL_ID],
};

const GIVEAWAY = {
  id: GIVEAWAY_ID,
  guild_id: GUILD_ID,
  status: 'ended',
  winners: [WINNER_ID, OTHER_WINNER_ID],
  prize_product_id: PRODUCT_ID,
  prize: 'VIP Prize',
};

function fluentQuery(responses: QueryResult[]) {
  const remaining = [...responses];
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(async () => remaining.shift() ?? { data: null, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.insert.mockReturnValue(query);
  return query;
}

function makeGuild() {
  const sends = new Map<string, ReturnType<typeof vi.fn>>();
  const fetch = vi.fn(async (winnerId: string) => {
    let send = sends.get(winnerId);
    if (!send) {
      send = vi.fn(async () => ({ id: MESSAGE_ID }));
      sends.set(winnerId, send);
    }
    return {
      id: winnerId,
      user: { id: winnerId, username: `winner-${winnerId}` },
      send,
    };
  });
  return {
    guild: {
      id: GUILD_ID,
      name: 'Test Guild',
      iconURL: () => null,
      members: { fetch },
    } as never,
    fetch,
    sends,
  };
}

function makeSupabase(options: {
  giveawayResponses?: QueryResult[];
  productResponses?: QueryResult[];
  customerResponses?: QueryResult[];
  entitlementResponses?: QueryResult[];
  grantRows?: (requestId: string) => unknown;
  grantError?: { message: string } | null;
} = {}) {
  const giveawayQuery = fluentQuery(options.giveawayResponses ?? [
    { data: GIVEAWAY, error: null },
  ]);
  const productQuery = fluentQuery(options.productResponses ?? [
    { data: PRODUCT, error: null },
  ]);
  const customerQuery = fluentQuery(options.customerResponses ?? [
    { data: { id: CUSTOMER_ID }, error: null },
  ]);
  const entitlementQuery = fluentQuery(options.entitlementResponses ?? [
    {
      data: {
        id: ENTITLEMENT_ID,
        guild_id: GUILD_ID,
        order_id: null,
        product_id: PRODUCT_ID,
        source: 'giveaway',
        status: 'active',
      },
      error: null,
    },
  ]);
  const from = vi.fn((table: string) => {
    if (table === 'giveaways') return giveawayQuery;
    if (table === 'products') return productQuery;
    if (table === 'customers') return customerQuery;
    if (table === 'entitlements') return entitlementQuery;
    throw new Error(`Unexpected table: ${table}`);
  });
  const rpc = vi.fn(async (_name: string, params: Record<string, unknown>) => ({
    data: options.grantRows
      ? options.grantRows(params.p_request_id as string)
      : [{
          entitlement_id: ENTITLEMENT_ID,
          order_id: params.p_request_id,
          request_id: params.p_request_id,
        }],
    error: options.grantError ?? null,
  }));
  return {
    supabase: { from, rpc } as never,
    from,
    rpc,
    giveawayQuery,
    productQuery,
    customerQuery,
    entitlementQuery,
  };
}

type GiveawayEventData = {
  giveawayId: string;
  title: string;
  winnerIds: string[];
  prizeProductId: string | null;
};

function makeService(options: Parameters<typeof makeSupabase>[0] = {}) {
  const db = makeSupabase(options);
  const discord = makeGuild();
  const eventBus = { on: vi.fn(), off: vi.fn() } as never;
  return {
    service: new GiveawayFulfillmentService(discord.guild, db.supabase, eventBus),
    ...db,
    ...discord,
  };
}

function queued(
  service: GiveawayFulfillmentService,
  overrides: Partial<{ giveawayId: string; winnerId: string; productId: string }> = {},
) {
  return service.fulfillQueuedProductPrize({
    giveawayId: GIVEAWAY_ID,
    winnerId: WINNER_ID,
    productId: PRODUCT_ID,
    ...overrides,
  });
}

async function emitEnded(
  service: GiveawayFulfillmentService,
  overrides: Partial<GiveawayEventData> = {},
): Promise<void> {
  const data: GiveawayEventData = {
    giveawayId: GIVEAWAY_ID,
    title: 'VIP Prize',
    winnerIds: [WINNER_ID],
    prizeProductId: PRODUCT_ID,
    ...overrides,
  };
  await (service as unknown as {
    handleGiveawayEnded(value: GiveawayEventData): Promise<void>;
  }).handleGiveawayEnded(data);
}

function sentDescription(send: ReturnType<typeof vi.fn>): string {
  const payload = send.mock.calls.at(-1)?.[0] as {
    embeds?: Array<{ data?: { description?: string } }>;
  };
  return payload.embeds?.[0]?.data?.description ?? '';
}

describe('GiveawayFulfillmentService durable product grants', () => {
  it('derives the same atomic request when a durable action is retried', async () => {
    const { service, rpc, giveawayQuery, productQuery, customerQuery, sends } = makeService({
      giveawayResponses: [
        { data: GIVEAWAY, error: null },
        { data: GIVEAWAY, error: null },
      ],
      productResponses: [
        { data: PRODUCT, error: null },
        { data: PRODUCT, error: null },
      ],
      customerResponses: [
        { data: { id: CUSTOMER_ID }, error: null },
        { data: { id: CUSTOMER_ID }, error: null },
      ],
    });

    const firstResult = await queued(service);
    const replayResult = await queued(service);

    expect(firstResult.requestId).toBe(replayResult.requestId);
    expect(firstResult.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_request_id: firstResult.requestId,
      p_guild_id: GUILD_ID,
      p_customer_id: CUSTOMER_ID,
      p_product_id: PRODUCT_ID,
      p_source: 'giveaway',
      p_type: 'one_time',
      p_plan_id: null,
      p_expires_at: null,
      p_granted_role_ids: [ROLE_ID],
      p_granted_channel_ids: [CHANNEL_ID],
    });
    expect(giveawayQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(productQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(customerQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(sends.has(WINNER_ID)).toBe(false);
  });

  it('uses distinct deterministic requests for distinct winners', async () => {
    const { service, rpc } = makeService({
      giveawayResponses: [
        { data: GIVEAWAY, error: null },
        { data: GIVEAWAY, error: null },
      ],
      productResponses: [
        { data: PRODUCT, error: null },
        { data: PRODUCT, error: null },
      ],
      customerResponses: [
        { data: { id: CUSTOMER_ID }, error: null },
        { data: { id: CUSTOMER_ID }, error: null },
      ],
    });

    await queued(service);
    await queued(service, { winnerId: OTHER_WINNER_ID });

    const requestIds = rpc.mock.calls.map((call) => (
      call[1] as Record<string, unknown>
    ).p_request_id);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('resolves a customer insert race through exact scoped read-back', async () => {
    const { service, rpc, customerQuery } = makeService({
      customerResponses: [
        { data: null, error: null },
        {
          data: { id: UNTRUSTED_CUSTOMER_ID },
          error: { message: 'duplicate', code: '23505' },
        },
        { data: { id: CUSTOMER_ID }, error: null },
      ],
    });

    await queued(service);

    expect(customerQuery.insert).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_customer_id: CUSTOMER_ID });
  });

  it.each([
    ['empty response', () => []],
    ['multiple rows', (requestId: string) => [
      { entitlement_id: ENTITLEMENT_ID, order_id: requestId, request_id: requestId },
      { entitlement_id: ENTITLEMENT_ID, order_id: requestId, request_id: requestId },
    ]],
    ['wrong order', (requestId: string) => [{
      entitlement_id: ENTITLEMENT_ID,
      order_id: GIVEAWAY_ID,
      request_id: requestId,
    }]],
    ['wrong request', (requestId: string) => [{
      entitlement_id: ENTITLEMENT_ID,
      order_id: requestId,
      request_id: GIVEAWAY_ID,
    }]],
    ['malformed entitlement', (requestId: string) => [{
      entitlement_id: 'entitlement',
      order_id: requestId,
      request_id: requestId,
    }]],
  ] as const)('fails closed on %s identity evidence', async (_label, grantRows) => {
    const { service, sends } = makeService({ grantRows });

    await expect(queued(service)).rejects.toBeInstanceOf(GiveawayPrizeContractError);

    expect(sends.has(WINNER_ID)).toBe(false);
  });

  it.each([
    ['active giveaway', { status: 'active' }],
    ['wrong guild', { guild_id: OTHER_WINNER_ID }],
    ['wrong product', { prize_product_id: GIVEAWAY_ID }],
    ['winner absent', { winners: [OTHER_WINNER_ID] }],
  ])('rejects an ended-winner contract with %s', async (_label, patch) => {
    const { service, from, rpc } = makeService({
      giveawayResponses: [{ data: { ...GIVEAWAY, ...patch }, error: null }],
    });

    await expect(queued(service)).rejects.toBeInstanceOf(GiveawayPrizeContractError);

    expect(from).not.toHaveBeenCalledWith('products');
    expect(from).not.toHaveBeenCalledWith('customers');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('treats a database lookup failure as retryable rather than a contract rejection', async () => {
    const { service } = makeService({
      giveawayResponses: [{ data: null, error: { message: 'database unavailable' } }],
    });

    let caught: unknown;
    try {
      await queued(service);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(GiveawayPrizeContractError);
    expect((caught as Error).message).toContain('database unavailable');
  });

  it('leaves product prizes to the durable queue instead of racing the event listener', async () => {
    const { service, from, rpc, fetch } = makeService();

    await emitEnded(service, { winnerIds: [WINNER_ID, WINNER_ID] });

    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves manual-prize notification to the durable winner action', async () => {
    const { service, from, rpc, fetch } = makeService();

    await emitEnded(service, { prizeProductId: null });

    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails malformed event identities before any database or Discord effect', async () => {
    const { service, from, rpc, fetch } = makeService();

    await expect(emitEnded(service, { giveawayId: 'giveaway' })).rejects.toThrow(
      /malformed fulfillment identity/i,
    );

    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('durable giveaway winner notifications', () => {
  const requestId = deterministicUuidV8('somnibot:giveaway-entitlement:v1', [
    GUILD_ID,
    GIVEAWAY_ID,
    WINNER_ID,
    PRODUCT_ID,
  ]);

  it('waits for exact product entitlement proof and sends with a deterministic enforced nonce', async () => {
    const { service, sends } = makeService({
      giveawayResponses: [
        { data: GIVEAWAY, error: null },
        { data: GIVEAWAY, error: null },
      ],
      entitlementResponses: [
        {
          data: {
            id: ENTITLEMENT_ID,
            guild_id: GUILD_ID,
            order_id: requestId,
            product_id: PRODUCT_ID,
            source: 'giveaway',
            status: 'active',
          },
          error: null,
        },
        {
          data: {
            id: ENTITLEMENT_ID,
            guild_id: GUILD_ID,
            order_id: requestId,
            product_id: PRODUCT_ID,
            source: 'giveaway',
            status: 'active',
          },
          error: null,
        },
      ],
    });
    const input = {
      source: 'giveaway_atomic_end' as const,
      giveawayId: GIVEAWAY_ID,
      winnerId: WINNER_ID,
      productId: PRODUCT_ID,
      deliveryKind: 'product' as const,
      prizeSnapshot: 'VIP Prize',
    };

    const first = await service.notifyQueuedWinner(input);
    const replay = await service.notifyQueuedWinner(input);

    expect(first).toMatchObject({
      entitlementId: ENTITLEMENT_ID,
      messageId: MESSAGE_ID,
      deliveryKind: 'product',
    });
    expect(first.nonce).toBe(replay.nonce);
    expect(first.nonce).toMatch(/^[0-9a-f]{25}$/);
    const send = sends.get(WINNER_ID)!;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      nonce: first.nonce,
      enforceNonce: true,
    });
    expect(sentDescription(send)).toMatch(/delivery is being processed/i);
    expect(sentDescription(send)).not.toMatch(/automatically delivered/i);
  });

  it('keeps a product notification retryable until its deterministic entitlement exists', async () => {
    const { service, sends } = makeService({
      entitlementResponses: [{ data: null, error: null }],
    });

    let caught: unknown;
    try {
      await service.notifyQueuedWinner({
        source: 'giveaway_atomic_end',
        giveawayId: GIVEAWAY_ID,
        winnerId: WINNER_ID,
        productId: PRODUCT_ID,
        deliveryKind: 'product',
        prizeSnapshot: 'VIP Prize',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(GiveawayPrizeContractError);
    expect((caught as Error).message).toContain('not durable yet');
    expect(sends.has(WINNER_ID)).toBe(false);
  });

  it('delivers a manual prize only from its exact ended-winner carrier', async () => {
    const manualGiveaway = {
      ...GIVEAWAY,
      prize_product_id: null,
      prize: 'Custom Art',
    };
    const { service, sends, from } = makeService({
      giveawayResponses: [{ data: manualGiveaway, error: null }],
    });

    const result = await service.notifyQueuedWinner({
      source: 'giveaway_atomic_reroll',
      giveawayId: GIVEAWAY_ID,
      winnerId: WINNER_ID,
      productId: null,
      deliveryKind: 'manual',
      prizeSnapshot: 'Custom Art',
    });

    expect(result).toMatchObject({
      entitlementId: null,
      deliveryKind: 'manual',
      messageId: MESSAGE_ID,
    });
    expect(from).not.toHaveBeenCalledWith('entitlements');
    expect(sentDescription(sends.get(WINNER_ID)!)).toMatch(/staff member will reach out/i);
  });
});

describe('durable giveaway action handler', () => {
  const payload = {
    source: 'giveaway_atomic_end',
    guild_id: GUILD_ID,
    giveaway_id: GIVEAWAY_ID,
    winner_id: WINNER_ID,
    product_id: PRODUCT_ID,
  };

  it('routes an exact carrier to the atomic non-commerce grant', async () => {
    const { handleGiveawayPrizeFulfillment } = await import('../services/action-queue.js');
    const db = makeSupabase();
    const { guild } = makeGuild();

    const result = await handleGiveawayPrizeFulfillment(guild, db.supabase, payload);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      giveawayId: GIVEAWAY_ID,
      winnerId: WINNER_ID,
      productId: PRODUCT_ID,
      entitlementId: ENTITLEMENT_ID,
    });
    expect(db.rpc).toHaveBeenCalledWith(
      'commerce_create_noncommerce_entitlement',
      expect.objectContaining({ p_source: 'giveaway' }),
    );
  });

  it('rejects malformed carriers before any read', async () => {
    const { handleGiveawayPrizeFulfillment } = await import('../services/action-queue.js');
    const db = makeSupabase();
    const { guild } = makeGuild();

    const result = await handleGiveawayPrizeFulfillment(guild, db.supabase, {
      ...payload,
      source: 'giveaway.ended',
    });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('classifies database failures as retryable and contract failures as terminal', async () => {
    const { handleGiveawayPrizeFulfillment } = await import('../services/action-queue.js');
    const transient = makeSupabase({
      giveawayResponses: [{ data: null, error: { message: 'database unavailable' } }],
    });
    const invalid = makeSupabase({
      giveawayResponses: [{ data: { ...GIVEAWAY, winners: [] }, error: null }],
    });
    const { guild } = makeGuild();

    await expect(handleGiveawayPrizeFulfillment(guild, transient.supabase, payload))
      .resolves.toMatchObject({ success: false, retryable: true });
    await expect(handleGiveawayPrizeFulfillment(guild, invalid.supabase, payload))
      .resolves.toMatchObject({ success: false, retryable: false });
  });

  it('routes an exact product notification carrier with durable message evidence', async () => {
    const { handleGiveawayWinnerNotification } = await import('../services/action-queue.js');
    const requestId = deterministicUuidV8('somnibot:giveaway-entitlement:v1', [
      GUILD_ID,
      GIVEAWAY_ID,
      WINNER_ID,
      PRODUCT_ID,
    ]);
    const db = makeSupabase({
      entitlementResponses: [{
        data: {
          id: ENTITLEMENT_ID,
          guild_id: GUILD_ID,
          order_id: requestId,
          product_id: PRODUCT_ID,
          source: 'giveaway',
          status: 'active',
        },
        error: null,
      }],
    });
    const { guild, sends } = makeGuild();

    const result = await handleGiveawayWinnerNotification(guild, db.supabase, {
      source: 'giveaway_atomic_end',
      guild_id: GUILD_ID,
      giveaway_id: GIVEAWAY_ID,
      winner_id: WINNER_ID,
      product_id: PRODUCT_ID,
      delivery_kind: 'product',
      prize_snapshot: 'VIP Prize',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        giveawayId: GIVEAWAY_ID,
        winnerId: WINNER_ID,
        entitlementId: ENTITLEMENT_ID,
        messageId: MESSAGE_ID,
        deliveryKind: 'product',
      },
    });
    expect(sends.get(WINNER_ID)).toHaveBeenCalledWith(
      expect.objectContaining({ enforceNonce: true }),
    );
  });

  it('rejects cross-linked notification payload shapes before any read', async () => {
    const { handleGiveawayWinnerNotification } = await import('../services/action-queue.js');
    const db = makeSupabase();
    const { guild } = makeGuild();

    const result = await handleGiveawayWinnerNotification(guild, db.supabase, {
      source: 'giveaway_atomic_end',
      guild_id: GUILD_ID,
      giveaway_id: GIVEAWAY_ID,
      winner_id: WINNER_ID,
      product_id: PRODUCT_ID,
      delivery_kind: 'manual',
      prize_snapshot: 'VIP Prize',
    });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(db.from).not.toHaveBeenCalled();
  });
});
