import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleRevokeRoles, type ClaimedActionContext } from '../services/action-queue.js';

const GUILD_ID = '12345678901234567';
const USER_A = '22345678901234567';
const USER_B = '32345678901234567';
const ROLE_ID = '42345678901234567';
const ENTITLEMENT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const ACTIVATION_GENERATION = '55555555-5555-4555-8555-555555555555';
const PREVIOUS_ACTIVATION_GENERATION = '66666666-6666-4666-8666-666666666666';
const RELINK_GENERATION = '77777777-7777-4777-8777-777777777777';
const INTENT_ID = '88888888-8888-4888-8888-888888888888';
const MUTATION_TOKEN = '99999999-9999-4999-8999-999999999999';
const context: ClaimedActionContext = {
  actionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  claimToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

function activationPayload(): Record<string, unknown> {
  return {
    source: 'noncommerce_entitlement_activation_trigger',
    guild_id: GUILD_ID,
    discord_id: USER_B,
    entitlement_id: ENTITLEMENT_ID,
    customer_id: CUSTOMER_ID,
    order_id: ORDER_ID,
    product_id: PRODUCT_ID,
    entitlement_source: 'manual',
    entitlement_status: 'active',
    entitlement_type: 'one_time',
    plan_id: null,
    role_ids: [ROLE_ID],
    temporary_role_grant_ids: [],
    reason: 'entitlement_activated',
    activation_generation: ACTIVATION_GENERATION,
  };
}

function terminalPayload(): Record<string, unknown> {
  return {
    source: 'noncommerce_entitlement_status_trigger',
    guild_id: GUILD_ID,
    discord_id: USER_A,
    entitlement_id: ENTITLEMENT_ID,
    customer_id: CUSTOMER_ID,
    order_id: ORDER_ID,
    product_id: PRODUCT_ID,
    entitlement_source: 'manual',
    entitlement_status: 'cancelled',
    entitlement_type: 'one_time',
    plan_id: null,
    role_ids: [ROLE_ID],
    temporary_role_grant_ids: [],
    reason: 'entitlement_cancelled',
  };
}

function relinkPayload(): Record<string, unknown> {
  return {
    source: 'noncommerce_entitlement_customer_relink_trigger',
    guild_id: GUILD_ID,
    old_discord_id: USER_A,
    discord_id: USER_B,
    entitlement_id: ENTITLEMENT_ID,
    customer_id: CUSTOMER_ID,
    order_id: ORDER_ID,
    product_id: PRODUCT_ID,
    entitlement_source: 'manual',
    entitlement_status: 'active',
    entitlement_type: 'one_time',
    plan_id: null,
    role_ids: [ROLE_ID],
    temporary_role_grant_ids: [],
    reason: 'entitlement_customer_relinked',
    relink_generation: RELINK_GENERATION,
    previous_activation_generation: PREVIOUS_ACTIVATION_GENERATION,
  };
}

function makeHarness(resolver: (
  name: string,
  params: Record<string, unknown>,
) => { data: unknown; error: { message: string } | null }) {
  const fetch = vi.fn(async () => {
    throw new Error('Discord must not be touched in this test');
  });
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => resolver(name, params));
  const guild = { id: GUILD_ID, members: { fetch } } as unknown as Guild;
  const supabase = { rpc } as unknown as SupabaseClient;
  return { guild, supabase, rpc, fetch };
}

describe('non-commerce exact-claim role protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('binds an activation claim and confirms an exactly-owned Discord add', async () => {
    const roles = new Set<string>();
    const add = vi.fn(async (roleId: string) => {
      roles.add(roleId);
    });
    const member = { roles: { cache: { has: (roleId: string) => roles.has(roleId) }, add } };
    const fetch = vi.fn(async () => member);
    const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'commerce_begin_noncommerce_role_delivery_attempt') {
        expect(params).toMatchObject({
          p_action_id: context.actionId,
          p_claim_token: context.claimToken,
          p_entitlement_id: ENTITLEMENT_ID,
          p_activation_generation: ACTIVATION_GENERATION,
          p_permanent_role_ids: [ROLE_ID],
        });
        return {
          data: [{
            intent_id: INTENT_ID,
            mutation_token: MUTATION_TOKEN,
            intent_state: 'open',
            may_mutate: true,
            contract_live: true,
            delivery_confirmed: false,
            cleanup_needed: false,
            disposition: 'live_mutation',
          }],
          error: null,
        };
      }
      if (name === 'commerce_assert_role_delivery_attempt_live') {
        return { data: [{ intent_state: 'open', may_mutate: true }], error: null };
      }
      if (name === 'commerce_attach_permanent_role_delivery') {
        expect(params).toMatchObject({
          p_intent_id: INTENT_ID,
          p_mutation_token: MUTATION_TOKEN,
          p_role_id: ROLE_ID,
          p_role_was_present: false,
        });
        return {
          data: [{
            intent_state: 'open',
            may_mutate: true,
            owns_removal: false,
            claim_newly_acquired: true,
            disposition: 'reserve_add',
          }],
          error: null,
        };
      }
      if (name === 'commerce_confirm_permanent_role_delivery') {
        return {
          data: [{ intent_state: 'open', promoted: true, owns_removal: true }],
          error: null,
        };
      }
      if (name === 'commerce_finish_role_delivery_attempt') {
        expect(params).toMatchObject({ p_outcome: 'live' });
        return {
          data: [{
            intent_state: 'open',
            settled: false,
            authority_empty: false,
            disposition: 'confirmed_open',
          }],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const guild = { id: GUILD_ID, members: { fetch } } as unknown as Guild;
    const supabase = { rpc } as unknown as SupabaseClient;

    const result = await handleRevokeRoles(guild, supabase, activationPayload(), context);

    expect(result).toMatchObject({ success: true, data: { outcome: 'live_confirmed' } });
    expect(add).toHaveBeenCalledTimes(1);
    expect(roles.has(ROLE_ID)).toBe(true);
    expect(rpc.mock.calls.filter(([name]) => name === 'commerce_assert_role_delivery_attempt_live')).toHaveLength(2);
  });

  it('treats a confirmed activation replay as success without touching Discord', async () => {
    const harness = makeHarness((name) => {
      expect(name).toBe('commerce_begin_noncommerce_role_delivery_attempt');
      return {
        data: [{
          intent_id: INTENT_ID,
          mutation_token: null,
          intent_state: 'open',
          may_mutate: false,
          contract_live: true,
          delivery_confirmed: true,
          cleanup_needed: false,
          disposition: 'confirmed_replay',
        }],
        error: null,
      };
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      activationPayload(),
      context,
    );

    expect(result).toMatchObject({
      success: true,
      data: { deliveryIntentId: INTENT_ID, outcome: 'live_confirmed_replay' },
    });
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('finishes an unproven terminal carrier without treating desired metadata as removal authority', async () => {
    const harness = makeHarness((name, params) => {
      expect(name).toBe('commerce_prepare_noncommerce_role_delivery_cleanup');
      expect(params).toEqual({
        p_action_id: context.actionId,
        p_claim_token: context.claimToken,
      });
      return { data: [{ intent_id: null, disposition: 'unproven' }], error: null };
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      terminalPayload(),
      context,
    );

    expect(result).toMatchObject({ success: true, data: { outcome: 'unproven' } });
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('accepts a superseded relink cleanup without creating a destination activation carrier', async () => {
    const harness = makeHarness((name, params) => {
      expect(name).toBe('commerce_prepare_noncommerce_role_delivery_cleanup');
      expect(params).toEqual({
        p_action_id: context.actionId,
        p_claim_token: context.claimToken,
      });
      return { data: [{ intent_id: null, disposition: 'superseded' }], error: null };
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      relinkPayload(),
      context,
    );

    expect(result).toMatchObject({ success: true, data: { outcome: 'superseded' } });
    expect(harness.rpc).toHaveBeenCalledTimes(1);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('accepts a destination activation request that becomes superseded after cleanup preparation', async () => {
    const names: string[] = [];
    const harness = makeHarness((name) => {
      names.push(name);
      if (name === 'commerce_prepare_noncommerce_role_delivery_cleanup') {
        return { data: [{ intent_id: null, disposition: 'destination_pending' }], error: null };
      }
      if (name === 'commerce_request_noncommerce_relink_activation') {
        return { data: [{ activation_action_id: null, disposition: 'superseded' }], error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      relinkPayload(),
      context,
    );

    expect(result).toMatchObject({ success: true, data: { outcome: 'superseded' } });
    expect(names).toEqual([
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      'commerce_request_noncommerce_relink_activation',
    ]);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('atomically defers relink cleanup while destination activation is pending', async () => {
    const activationActionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const names: string[] = [];
    const harness = makeHarness((name) => {
      names.push(name);
      if (name === 'commerce_request_noncommerce_relink_activation') {
        return { data: [{ activation_action_id: activationActionId, disposition: 'enqueued' }], error: null };
      }
      if (name === 'commerce_prepare_noncommerce_role_delivery_cleanup') {
        return { data: [{ intent_id: null, disposition: 'destination_pending' }], error: null };
      }
      if (name === 'commerce_defer_noncommerce_relink_cleanup') {
        return { data: [{ applied: true, disposition: 'deferred' }], error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      relinkPayload(),
      context,
    );

    expect(result).toMatchObject({
      success: false,
      retryable: true,
      claimTransition: 'deferred',
      data: { activationActionId, outcome: 'deferred' },
    });
    expect(names).toEqual([
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      'commerce_request_noncommerce_relink_activation',
      'commerce_defer_noncommerce_relink_cleanup',
    ]);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('rejects a relink carrier without its previous activation CAS generation', async () => {
    const payload = relinkPayload();
    delete payload.previous_activation_generation;
    const harness = makeHarness(() => {
      throw new Error('RPC must not run');
    });

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      payload,
      context,
    );

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('relink identity');
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it('fails closed on malformed cleanup evidence before Discord mutation', async () => {
    const harness = makeHarness(() => ({ data: [], error: null }));

    const result = await handleRevokeRoles(
      harness.guild,
      harness.supabase,
      terminalPayload(),
      context,
    );

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('malformed evidence');
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});
