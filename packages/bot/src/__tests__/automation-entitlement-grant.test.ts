import { describe, expect, it, vi } from 'vitest';
import {
  executeActions,
  type ActionContext,
  type AutomationAction,
} from '../features/automations/action-executor.js';

const GUILD_ID = '12345678901234567';
const USER_ID = '22345678901234567';
const ROLE_ID = '32345678901234567';
const CHANNEL_ID = '42345678901234567';
const AUTOMATION_ID = '00000000-0000-4000-a000-000000000001';
const PRODUCT_ID = '00000000-0000-4000-a000-000000000002';
const CUSTOMER_ID = '00000000-0000-4000-a000-000000000003';
const ENTITLEMENT_ID = '00000000-0000-4000-a000-000000000004';
const OCCURRENCE_ID = '00000000-0000-4000-a000-000000000005';
const OTHER_OCCURRENCE_ID = '00000000-0000-4000-a000-000000000006';
const UNTRUSTED_CUSTOMER_ID = '00000000-0000-4000-a000-000000000007';
const PLAN_ID = '00000000-0000-4000-a000-000000000008';

const grantAction: AutomationAction = {
  type: 'grant_entitlement',
  config: { product_id: PRODUCT_ID },
};

function fluentQuery() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.insert.mockReturnValue(query);
  return query;
}

function makeSupabase(options: {
  product?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  customer?: Record<string, unknown> | null;
  grantRows?: (requestId: string) => unknown;
  grantError?: { message: string } | null;
} = {}) {
  const productQuery = fluentQuery();
  const customerQuery = fluentQuery();
  const planQuery = fluentQuery();
  const product = options.product === undefined
    ? {
        id: PRODUCT_ID,
        type: 'one_time',
        granted_role_ids: [ROLE_ID],
        granted_channel_ids: [CHANNEL_ID],
      }
    : options.product;
  const customer = options.customer === undefined ? { id: CUSTOMER_ID } : options.customer;
  productQuery.maybeSingle.mockResolvedValue({ data: product, error: null });
  customerQuery.maybeSingle.mockResolvedValue({ data: customer, error: null });
  planQuery.maybeSingle.mockResolvedValue({
    data: options.plan === undefined ? { id: PLAN_ID } : options.plan,
    error: null,
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
  const from = vi.fn((table: string) => {
    if (table === 'products') return productQuery;
    if (table === 'plans') return planQuery;
    if (table === 'customers') return customerQuery;
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    supabase: { from, rpc },
    from,
    rpc,
    productQuery,
    planQuery,
    customerQuery,
  };
}

function makeContext(
  supabase: ReturnType<typeof makeSupabase>['supabase'],
  occurrenceId = OCCURRENCE_ID,
): ActionContext {
  return {
    guild: {} as ActionContext['guild'],
    member: { id: USER_ID, user: { username: 'winner' } } as ActionContext['member'],
    channelId: null,
    messageId: null,
    message: null,
    supabase: supabase as unknown as ActionContext['supabase'],
    guildId: GUILD_ID,
    rateLimiter: {} as ActionContext['rateLimiter'],
    automationId: AUTOMATION_ID,
    occurrenceId,
    variables: {},
  };
}

describe('automation grant_entitlement', () => {
  it('derives replay-stable UUIDv8 identities per occurrence and action index', async () => {
    const { supabase, from, rpc, productQuery } = makeSupabase();
    const actions = [grantAction, grantAction];
    const context = makeContext(supabase);

    expect(await executeActions(actions, context)).toMatchObject({ executed: 2, failed: 0 });
    expect(await executeActions(actions, context)).toMatchObject({ executed: 2, failed: 0 });
    expect(
      await executeActions(actions, makeContext(supabase, OTHER_OCCURRENCE_ID)),
    ).toMatchObject({ executed: 2, failed: 0 });

    const requestIds = rpc.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).p_request_id as string,
    );
    expect(requestIds).toHaveLength(6);
    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestIds[0]).toBe(requestIds[2]);
    expect(requestIds[1]).toBe(requestIds[3]);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds[4]).not.toBe(requestIds[0]);

    expect(productQuery.eq).toHaveBeenCalledWith('id', PRODUCT_ID);
    expect(productQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(from).not.toHaveBeenCalledWith('bot_action_queue');
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe('commerce_create_noncommerce_entitlement');
      expect(call[1]).toMatchObject({
        p_guild_id: GUILD_ID,
        p_customer_id: CUSTOMER_ID,
        p_product_id: PRODUCT_ID,
        p_source: 'automation',
        p_type: 'one_time',
        p_plan_id: null,
        p_expires_at: null,
        p_granted_role_ids: [ROLE_ID],
        p_granted_channel_ids: [CHANNEL_ID],
      });
    }
  });

  it('resolves concurrent customer insert conflicts and replays one atomic request', async () => {
    const { supabase, rpc, customerQuery } = makeSupabase({ customer: null });
    customerQuery.maybeSingle
      // Both initial reads miss.
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      // Both inserts observe the concurrent unique winner rather than a row.
      .mockResolvedValueOnce({ data: null, error: { message: 'duplicate', code: '23505' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'duplicate', code: '23505' } })
      // Exact scoped read-back resolves the same customer.
      .mockResolvedValueOnce({ data: { id: CUSTOMER_ID }, error: null })
      .mockResolvedValueOnce({ data: { id: CUSTOMER_ID }, error: null });
    const context = makeContext(supabase);

    const [first, replay] = await Promise.all([
      executeActions([grantAction], context),
      executeActions([grantAction], context),
    ]);

    expect(first).toMatchObject({ executed: 1, failed: 0 });
    expect(replay).toMatchObject({ executed: 1, failed: 0 });
    expect(customerQuery.insert).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toEqual(rpc.mock.calls[1]?.[1]);
  });

  it('resolves the sole authoritative active plan for a subscription product', async () => {
    const { supabase, rpc, planQuery } = makeSupabase({
      product: {
        id: PRODUCT_ID,
        type: 'subscription',
        granted_role_ids: [ROLE_ID],
        granted_channel_ids: [CHANNEL_ID],
      },
    });

    const result = await executeActions([grantAction], makeContext(supabase));

    expect(result).toMatchObject({ executed: 1, failed: 0 });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_type: 'subscription',
      p_plan_id: PLAN_ID,
    });
    expect(planQuery.eq).toHaveBeenCalledWith('product_id', PRODUCT_ID);
    expect(planQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(planQuery.eq).toHaveBeenCalledWith('active', true);
  });

  it('validates an explicitly configured subscription plan in the same guild and product', async () => {
    const { supabase, rpc, planQuery } = makeSupabase({
      product: {
        id: PRODUCT_ID,
        type: 'subscription',
        granted_role_ids: [ROLE_ID],
        granted_channel_ids: [CHANNEL_ID],
      },
    });
    const action: AutomationAction = {
      type: 'grant_entitlement',
      config: { product_id: PRODUCT_ID, plan_id: PLAN_ID },
    };

    expect(await executeActions([action], makeContext(supabase))).toMatchObject({
      executed: 1,
      failed: 0,
    });
    expect(planQuery.eq).toHaveBeenCalledWith('product_id', PRODUCT_ID);
    expect(planQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(planQuery.eq).toHaveBeenCalledWith('active', true);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_type: 'subscription',
      p_plan_id: PLAN_ID,
    });
  });

  it('fails closed when a subscription product has no active plan', async () => {
    const { supabase, rpc, from } = makeSupabase({
      product: {
        id: PRODUCT_ID,
        type: 'subscription',
        granted_role_ids: [ROLE_ID],
        granted_channel_ids: [CHANNEL_ID],
      },
      plan: null,
    });

    const result = await executeActions([grantAction], makeContext(supabase));

    expect(result).toMatchObject({ executed: 0, failed: 1 });
    expect(result.errors[0]).toMatch(/exactly one active plan/i);
    expect(from).not.toHaveBeenCalledWith('customers');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed when an explicit subscription plan resolves to another identity', async () => {
    const { supabase, rpc, from } = makeSupabase({
      product: {
        id: PRODUCT_ID,
        type: 'subscription',
        granted_role_ids: [ROLE_ID],
        granted_channel_ids: [CHANNEL_ID],
      },
      plan: { id: OTHER_OCCURRENCE_ID },
    });
    const action: AutomationAction = {
      type: 'grant_entitlement',
      config: { product_id: PRODUCT_ID, plan_id: PLAN_ID },
    };

    const result = await executeActions([action], makeContext(supabase));

    expect(result).toMatchObject({ executed: 0, failed: 1 });
    expect(result.errors[0]).toMatch(/not active for this product/i);
    expect(from).not.toHaveBeenCalledWith('customers');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('discards impossible insert data-plus-error and trusts only scoped read-back', async () => {
    const { supabase, rpc, customerQuery } = makeSupabase({ customer: null });
    customerQuery.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: UNTRUSTED_CUSTOMER_ID },
        error: { message: 'ambiguous insert response' },
      })
      .mockResolvedValueOnce({ data: { id: CUSTOMER_ID }, error: null });

    const result = await executeActions([grantAction], makeContext(supabase));

    expect(result).toMatchObject({ executed: 1, failed: 0 });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_customer_id: CUSTOMER_ID });
  });

  it('rejects a product outside the current guild before resolving a customer', async () => {
    const { supabase, rpc, from, productQuery } = makeSupabase({ product: null });

    const result = await executeActions([grantAction], makeContext(supabase));

    expect(result).toMatchObject({ executed: 0, failed: 1 });
    expect(result.errors[0]).toMatch(/not found in this guild/i);
    expect(productQuery.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(from).not.toHaveBeenCalledWith('customers');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['empty response', () => []],
    ['multiple rows', (id: string) => [
      { entitlement_id: ENTITLEMENT_ID, order_id: id, request_id: id },
      { entitlement_id: ENTITLEMENT_ID, order_id: id, request_id: id },
    ]],
    ['wrong order', (id: string) => [{
      entitlement_id: ENTITLEMENT_ID,
      order_id: OTHER_OCCURRENCE_ID,
      request_id: id,
    }]],
    ['wrong request', (id: string) => [{
      entitlement_id: ENTITLEMENT_ID,
      order_id: id,
      request_id: OTHER_OCCURRENCE_ID,
    }]],
    ['missing entitlement', (id: string) => [{
      entitlement_id: '',
      order_id: id,
      request_id: id,
    }]],
    ['non-UUID entitlement', (id: string) => [{
      entitlement_id: 'not-a-uuid',
      order_id: id,
      request_id: id,
    }]],
  ] as const)(
    'fails closed on %s identity evidence',
    async (_label, grantRows) => {
      const { supabase } = makeSupabase({ grantRows });

      const result = await executeActions([grantAction], makeContext(supabase));

      expect(result).toMatchObject({ executed: 0, failed: 1 });
      expect(result.errors[0]).toMatch(/malformed replay identity evidence/i);
    },
  );

  it.each([
    ['occurrence UUID', (ctx: ActionContext): void => { ctx.occurrenceId = ''; }, grantAction],
    ['automation UUID', (ctx: ActionContext): void => { ctx.automationId = 'automation'; }, grantAction],
    ['guild snowflake', (ctx: ActionContext): void => { ctx.guildId = 'guild'; }, grantAction],
    [
      'member snowflake',
      (ctx: ActionContext): void => {
        ctx.member = { ...ctx.member, id: 'member' } as ActionContext['member'];
      },
      grantAction,
    ],
    [
      'product UUID',
      (_ctx: ActionContext): void => {},
      { type: 'grant_entitlement', config: { product_id: 'product' } },
    ],
  ] as const)(
    'fails before reads when the %s is malformed',
    async (_label, mutate, action) => {
      const { supabase, from, rpc } = makeSupabase();
      const context = makeContext(supabase);
      mutate(context);

      const result = await executeActions([action], context);

      expect(result).toMatchObject({ executed: 0, failed: 1 });
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );
});
