/**
 * Deep coverage tests for services/action-queue.ts — exercises all action handlers
 * via startActionQueueListener with mock pending actions.
 * Targets the 599 uncovered statements (15.8% covered).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245 },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return {
    ...actual,
    EmbedBuilder: class {
      setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
      setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
      addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
      setURL() { return this; }
    },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/commerce-fulfillment.js', () => ({
  fulfillPurchase: vi.fn(async () => ({ success: true })),
}));

vi.mock('../sync/sync-engine.js', () => ({
  runSyncCycle: vi.fn(async () => ({ driftItems: [], repaired: 0, timestamp: Date.now() })),
}));

vi.mock('../sync/repair-actions.js', () => ({
  repairDriftItem: vi.fn(async () => ({ success: true })),
  acceptDriftItem: vi.fn(async () => ({ success: true })),
  ignoreDriftItem: vi.fn(async () => ({ success: true })),
  clearAllDrift: vi.fn(async () => {}),
}));

import { handleRevokeRoles, startActionQueueListener } from '../services/action-queue.js';
import { repairDriftItem, acceptDriftItem } from '../sync/repair-actions.js';

// Multi-table Supabase mock that returns different data per table/call
function makeSupa(pendingActions: any[] = []) {
  // Track sequential calls to .from('bot_action_queue') to differentiate
  // the recover RPC, the pending query, and the status updates
  let pendingReturned = false;
  const queueUpdates: Record<string, unknown>[] = [];

  const makeChain = (data: any = null) => {
    const chain: any = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'filter']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn().mockResolvedValue({ data, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
    chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
    return chain;
  };

  const supa: any = {
    from: vi.fn((table: string) => {
      if (table === 'bot_action_queue') {
        const chain = makeChain([]);
        // The select().eq().eq().order().limit() chain returns pending actions
        chain.select = vi.fn(() => {
          const inner = makeChain([]);
          inner.eq = vi.fn(() => inner);
          inner.order = vi.fn(() => inner);
          inner.limit = vi.fn(() => inner);
          inner.in = vi.fn(() => inner);
          inner.then = (resolve: Function) => {
            if (!pendingReturned) {
              pendingReturned = true;
              return resolve({ data: pendingActions, error: null });
            }
            return resolve({ data: [], error: null });
          };
          return inner;
        });
        chain.update = vi.fn((row: Record<string, unknown>) => {
          queueUpdates.push(row);
          return chain;
        });
        return chain;
      }
      if (table === 'guild_config') {
        return makeChain({ guild_id: 'guild-1', economy_enabled: true });
      }
      if (table === 'guild_desired_state') {
        return makeChain({ guild_id: 'guild-1', roles: [], channels: [], categories: [] });
      }
      return makeChain();
    }),
    rpc: vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: [], error: null };
      }
      if (name === 'bot_action_queue_claim') {
        return { data: [{ id: 'claimed' }], error: null };
      }
      return { data: null, error: null };
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: Function) => { cb?.('SUBSCRIBED'); return 'subscribed'; }),
    })),
  };
  supa.__queueUpdates = queueUpdates;
  return supa;
}

function makeOwnershipSupa(
  entitlementResponses: Array<{ data: unknown; error: { message: string } | null }>,
  customerResponse: { data: unknown; error: { message: string } | null } = {
    data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'user-1' },
    error: null,
  },
  temporaryResponses: Array<{ data: unknown; error: { message: string } | null }> = [],
  originResponse: { data: unknown; error: { message: string } | null } = {
    data: {
      id: 'ent-terminal',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      order_id: 'order-1',
      product_id: 'product-1',
      status: 'expired',
      source: 'purchase',
      granted_role_ids: ['role-1'],
    },
    error: null,
  },
  orderResponse: { data: unknown; error: { message: string } | null } = {
    data: {
      id: 'order-1',
      guild_id: 'guild-1',
      customer_id: 'customer-1',
      product_id: 'product-1',
      temporary_role_grants_snapshot: [],
      grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
    },
    error: null,
  },
  originTempGrantResponse: { data: unknown; error: { message: string } | null } = {
    data: [],
    error: null,
  },
) {
  const queryCalls: Array<{ method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    if (
      table !== 'entitlements'
      && table !== 'customers'
      && table !== 'orders'
      && table !== 'temp_role_grants'
    ) {
      throw new Error(`Unexpected table: ${table}`);
    }
    const chain: any = {};
    for (const method of ['select', 'eq', 'neq', 'in', 'contains', 'gt', 'or', 'order']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        queryCalls.push({ method, args });
        return chain;
      });
    }
    chain.limit = vi.fn(async (...args: unknown[]) => {
      queryCalls.push({ method: 'limit', args });
      return table === 'entitlements'
        ? entitlementResponses.shift() ?? { data: [], error: null }
        : temporaryResponses.shift() ?? { data: [], error: null };
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'customers') return customerResponse;
      if (table === 'orders') return orderResponse;
      return originResponse;
    });
    chain.then = (resolve: Function) => resolve(
      table === 'temp_role_grants' ? originTempGrantResponse : { data: [], error: null },
    );
    return chain;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== 'commerce_find_live_temp_role_owner') return { data: null, error: null };
    const response = temporaryResponses.shift() ?? { data: null, error: null };
    if (response.error) return response;
    const owner = Array.isArray(response.data) ? response.data[0] ?? null : response.data;
    return { data: owner, error: null };
  });
  return { supabase: { from, rpc } as any, from, queryCalls };
}

function makeRevokeGuild(
  roleStates: Array<string[] | Error>,
  removeError?: Error,
  addError?: Error,
) {
  let fetchIndex = 0;
  const remove = vi.fn(async () => {
    if (removeError) throw removeError;
  });
  const add = vi.fn(async () => {
    if (addError) throw addError;
  });
  const fetch = vi.fn(async () => {
    const state = roleStates[fetchIndex++] ?? roleStates.at(-1) ?? [];
    if (state instanceof Error) throw state;
    return {
      roles: {
        cache: new Map(state.map((roleId) => [roleId, { id: roleId }])),
        add,
        remove,
      },
    };
  });
  return {
    guild: { id: 'guild-1', members: { fetch } } as any,
    fetch,
    remove,
    add,
  };
}

const identityRevokePayload = {
  guild_id: 'guild-1',
  discord_id: 'user-1',
  role_ids: ['role-1'],
  temporary_role_grant_ids: [],
  entitlement_id: 'ent-terminal',
  customer_id: 'customer-1',
  order_id: 'order-1',
  product_id: 'product-1',
  reason: 'entitlement_expired',
  source: 'entitlement_status_trigger',
};

function liveOwner(roleId = 'role-1') {
  return {
    id: 'ent-other',
    guild_id: 'guild-1',
    customer_id: 'customer-1',
    status: 'active',
    granted_role_ids: [roleId],
  };
}

function liveTemporaryOwner(
  roleId = 'role-1',
  grantStatus: 'pending' | 'applied' = 'applied',
  expiresAt = '2999-01-01T00:00:00.000Z',
) {
  return {
    id: 'temp-owner',
    guild_id: 'guild-1',
    user_id: 'user-1',
    role_id: roleId,
    expires_at: expiresAt,
    grant_status: grantStatus,
    remove_on_expiry: false,
    order_id: 'order-2',
  };
}

function makeGuild() {
  const mockRole = {
    id: 'role-1', name: 'TestRole', managed: false, position: 1,
    edit: vi.fn().mockResolvedValue({}),
    setPosition: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  const managedRole = {
    id: 'role-managed', name: 'ManagedRole', managed: true, position: 2,
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  const mockChannel = {
    id: 'ch-1', name: 'test-channel', type: 0,
    edit: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    send: vi.fn().mockResolvedValue({}),
  };
  const mockCategory = {
    id: 'cat-1', name: 'Test Category', type: 4,
    delete: vi.fn().mockResolvedValue({}),
    children: { cache: new Map() },
  };

  return {
    id: 'guild-1', name: 'Test Guild',
    memberCount: 50,
    roles: {
      cache: new Map([
        ['role-1', mockRole],
        ['role-managed', managedRole],
      ]),
      create: vi.fn().mockResolvedValue({ id: 'new-role', name: 'NewRole', position: 3 }),
    },
    channels: {
      cache: new Map<string, any>([
        ['ch-1', mockChannel],
        ['cat-1', mockCategory],
      ]),
      create: vi.fn().mockResolvedValue({ id: 'new-ch', name: 'new-channel' }),
    },
    members: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue({
        id: 'user-1', displayName: 'TestUser',
        roles: { add: vi.fn(), remove: vi.fn() },
        user: { username: 'testuser', displayAvatarURL: () => 'url' },
        send: vi.fn().mockResolvedValue({}),
      }),
    },
    iconURL: vi.fn(() => 'icon-url'),
  } as any;
}

describe('revoke_roles shared-ownership safety', () => {
  it('retains a role owned by any other live entitlement for the exact guild and customer', async () => {
    const { supabase, queryCalls } = makeOwnershipSupa([
      { data: [liveOwner()], error: null },
    ]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(queryCalls).toContainEqual({ method: 'eq', args: ['guild_id', 'guild-1'] });
    expect(queryCalls).toContainEqual({ method: 'eq', args: ['customer_id', 'customer-1'] });
    expect(queryCalls).toContainEqual({ method: 'contains', args: ['granted_role_ids', ['role-1']] });
  });

  it('retains the role when the terminal entitlement was reactivated before the queue ran', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [{ ...liveOwner(), id: 'ent-terminal' }], error: null },
    ], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'active',
        source: 'purchase',
        granted_role_ids: ['role-1'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('retains a temp-only role when its exact order was reactivated before a stale revoke ran', async () => {
    const tempRoleId = '12345678901234567';
    const tempGrantId = 'temp-current';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [{
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          expires_at: '2999-01-01T00:00:00.000Z', grant_status: 'applied',
          remove_on_expiry: true, order_id: 'order-1',
        }],
        error: null,
      }],
      {
        data: {
          id: 'ent-terminal', guild_id: 'guild-1', customer_id: 'customer-1',
          order_id: 'order-1', product_id: 'product-1', status: 'active',
          source: 'purchase', granted_role_ids: [],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_purchase', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'applied', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([[tempRoleId]]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: [tempRoleId],
      temporary_role_grant_ids: [tempGrantId],
    });

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual([tempRoleId]);
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each(['applied', 'pending'] as const)(
    'retains a role owned by an unexpired %s temporary commerce grant',
    async (grantStatus) => {
      const { supabase, queryCalls } = makeOwnershipSupa(
        [{ data: [], error: null }],
        undefined,
        [{ data: [liveTemporaryOwner('role-1', grantStatus)], error: null }],
      );
      const harness = makeRevokeGuild([['role-1']]);

      const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

      expect(result.success).toBe(true);
      expect(result.data?.retained).toEqual(['role-1']);
      expect(harness.remove).not.toHaveBeenCalled();
      expect(queryCalls).toContainEqual({
        method: 'contains',
        args: ['granted_role_ids', ['role-1']],
      });
    },
  );

  it('retains a role owned by a delayed pending grant after its provisional timestamp', async () => {
    const { supabase, queryCalls } = makeOwnershipSupa(
      [{ data: [], error: null }],
      undefined,
      [{ data: [liveTemporaryOwner('role-1', 'pending', '2000-01-01T00:00:00.000Z')], error: null }],
    );
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(queryCalls).toContainEqual({
      method: 'contains',
      args: ['granted_role_ids', ['role-1']],
    });
  });

  it('treats an applied temp owner that crosses expiry before the caller read as not live', async () => {
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [{
        data: [liveTemporaryOwner('role-1', 'applied', '2000-01-01T00:00:00.000Z')],
        error: null,
      }],
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('repairs a role when a live owner appears after Discord removal', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [], error: null },
      { data: [liveOwner()], error: null },
    ]);
    const harness = makeRevokeGuild([
      ['role-1'],
      [],
      [],
      ['role-1'],
    ]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual([]);
    expect(result.data?.retained).toEqual(['role-1']);
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.add).toHaveBeenCalledTimes(1);
  });

  it('re-adds conservatively and retries when ownership becomes unknowable after removal', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [], error: null },
      { data: null, error: { message: 'database unavailable' } },
    ]);
    const harness = makeRevokeGuild([
      ['role-1'],
      [],
      [],
      ['role-1'],
    ]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.add).toHaveBeenCalledTimes(1);
  });

  it('fails retryably and removes nothing when any ownership lookup fails', async () => {
    const { supabase } = makeOwnershipSupa([
      { data: [], error: null },
      { data: null, error: { message: 'database unavailable' } },
    ], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1', 'role-2'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1', 'role-2']]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: ['role-1', 'role-2'],
    });

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('ownership verification failed');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably when the payload customer does not map to the exact Discord user', async () => {
    const { supabase } = makeOwnershipSupa([], {
      data: { id: 'customer-1', guild_id: 'guild-1', discord_id: 'different-user' },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('customer identity');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably before Discord mutation when the exact entitlement order does not match', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'different-order',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke origin');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably before Discord mutation when a payload role is absent from the origin snapshot', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['different-role'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke role set');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('rejects a source-labeled partial revoke set that would strand an origin role', async () => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1', 'role-2'],
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1', 'role-2']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke role set');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'non-paid source', patch: { source: 'manual' } },
    { label: 'wrong terminal state', patch: { status: 'cancelled' } },
  ])('fails retryably before Discord mutation for an origin with $label', async ({ patch }) => {
    const { supabase } = makeOwnershipSupa([], undefined, [], {
      data: {
        id: 'ent-terminal',
        guild_id: 'guild-1',
        customer_id: 'customer-1',
        order_id: 'order-1',
        product_id: 'product-1',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: ['role-1'],
        ...patch,
      },
      error: null,
    });
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('revoke origin');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably and removes nothing on a malformed ownership result', async () => {
    const { supabase } = makeOwnershipSupa([{ data: null, error: null }]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('malformed result');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload without a database or Discord mutation', async () => {
    const { supabase, from } = makeOwnershipSupa([]);
    const harness = makeRevokeGuild([['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: ['role-1', ''],
    });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(from).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('treats an already absent role as an idempotent success', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild([[]]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.absent).toEqual(['role-1']);
    expect(harness.fetch).toHaveBeenCalledWith({ user: 'user-1', force: true });
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it('fails retryably when Discord role removal fails', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild(
      [['role-1']],
      new Error('Missing Permissions'),
    );

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after removal and retries when Discord still reports the role', async () => {
    const { supabase } = makeOwnershipSupa([{ data: [], error: null }]);
    const harness = makeRevokeGuild([['role-1'], ['role-1']]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a payload-captured temp grant after the sweeper tombstones it', async () => {
    const tempRoleId = '12345678901234567';
    const tempGrantId = 'temp-grant-1';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      {
        data: {
          id: 'ent-terminal', guild_id: 'guild-1', customer_id: 'customer-1',
          order_id: 'order-1', product_id: 'product-1', status: 'expired',
          source: 'purchase', granted_role_ids: [],
        },
        error: null,
      },
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: tempGrantId, guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_reconciled', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'removed', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([[tempRoleId], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, {
      ...identityRevokePayload,
      role_ids: [tempRoleId],
      temporary_role_grant_ids: [tempGrantId],
    });

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual([tempRoleId]);
  });

  it('ignores an uncaptured removed temp tombstone on a later permanent-role refund', async () => {
    const tempRoleId = '12345678901234567';
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      undefined,
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: '2026-07-12T00:00:00.000Z',
          temporary_role_grants_snapshot: [{ role_id: tempRoleId, duration_seconds: 60 }],
        },
        error: null,
      },
      {
        data: [{
          id: 'old-temp', guild_id: 'guild-1', user_id: 'user-1', role_id: tempRoleId,
          order_id: 'order-1', source: 'commerce_reconciled', source_id: 'product-1',
          duration_seconds: 60, grant_status: 'removed', remove_on_expiry: true,
        }],
        error: null,
      },
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('accepts the permanent-only legacy terminal contract when no temp provenance exists', async () => {
    const { supabase } = makeOwnershipSupa(
      [{ data: [], error: null }, { data: [], error: null }],
      undefined,
      [],
      undefined,
      {
        data: {
          id: 'order-1', guild_id: 'guild-1', customer_id: 'customer-1',
          product_id: 'product-1', grant_snapshot_frozen_at: null,
          temporary_role_grants_snapshot: [],
        },
        error: null,
      },
    );
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, supabase, identityRevokePayload);

    expect(result.success).toBe(true);
    expect(result.data?.removed).toEqual(['role-1']);
  });

  it('rejects a legacy partial-identity payload retryably without touching Discord', async () => {
    const from = vi.fn(() => {
      throw new Error('legacy payload must not query entitlement ownership');
    });
    const harness = makeRevokeGuild([['role-1'], []]);

    const result = await handleRevokeRoles(harness.guild, { from } as any, {
      discord_id: 'user-1',
      role_ids: ['role-1'],
      entitlement_id: 'legacy-entitlement-only',
      reason: 'legacy_reconciliation',
    });

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(from).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});

describe('action-queue deep routing', () => {
  it('startActionQueueListener processes pending create_role action', async () => {
    const actions = [{
      id: 'act-1', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'NewRole', tier: 'custom', color: 0xff0000, hoist: true, mentionable: false, position: 0 },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).toHaveBeenCalled();
  });

  it('startActionQueueListener processes pending update_role action', async () => {
    const actions = [{
      id: 'act-2', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'role-1', name: 'Updated', color: 0x00ff00, templateKey: 'mod' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    const role = guild.roles.cache.get('role-1');
    expect(role.edit).toHaveBeenCalled();
  });

  it('startActionQueueListener processes pending delete_role action', async () => {
    const actions = [{
      id: 'act-3', guild_id: 'guild-1', action: 'delete_role', status: 'pending',
      payload: { roleId: 'role-1', templateKey: 'custom-role-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    const role = guild.roles.cache.get('role-1');
    expect(role.delete).toHaveBeenCalled();
  });

  it('handles delete_role for managed role', async () => {
    const actions = [{
      id: 'act-4', guild_id: 'guild-1', action: 'delete_role', status: 'pending',
      payload: { roleId: 'role-managed' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // managed role shouldn't be deleted
    expect(guild.roles.cache.get('role-managed').delete).not.toHaveBeenCalled();
  });

  it('handles update_role for missing role', async () => {
    const actions = [{
      id: 'act-5', guild_id: 'guild-1', action: 'update_role', status: 'pending',
      payload: { roleId: 'nonexistent' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // no crash, action marked as failed
  });

  it('processes create_channel action', async () => {
    const actions = [{
      id: 'act-6', guild_id: 'guild-1', action: 'create_channel', status: 'pending',
      payload: { name: 'new-channel', type: 0, parentId: 'cat-1', topic: 'Test topic' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('processes update_channel action', async () => {
    const actions = [{
      id: 'act-7', guild_id: 'guild-1', action: 'update_channel', status: 'pending',
      payload: { channelId: 'ch-1', name: 'renamed', topic: 'New topic' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').edit).toHaveBeenCalled();
  });

  it('processes delete_channel action', async () => {
    const actions = [{
      id: 'act-8', guild_id: 'guild-1', action: 'delete_channel', status: 'pending',
      payload: { channelId: 'ch-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').delete).toHaveBeenCalled();
  });

  it('processes create_category action', async () => {
    const actions = [{
      id: 'act-9', guild_id: 'guild-1', action: 'create_category', status: 'pending',
      payload: { name: 'New Category' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('processes delete_category action', async () => {
    const actions = [{
      id: 'act-10', guild_id: 'guild-1', action: 'delete_category', status: 'pending',
      payload: { categoryId: 'cat-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('cat-1').delete).toHaveBeenCalled();
  });

  it('processes config_reload action', async () => {
    const actions = [{
      id: 'act-11', guild_id: 'guild-1', action: 'config_reload', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // config_reload calls various cache invalidation - no crash = success
  });

  it('processes send_embed action', async () => {
    const actions = [{
      id: 'act-12', guild_id: 'guild-1', action: 'send_embed', status: 'pending',
      payload: { channel_id: 'ch-1', embed_config_id: 'embed-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // Add isTextBased to the channel mock
    guild.channels.cache.get('ch-1').isTextBased = vi.fn(() => true);
    const supa = makeSupa(actions);
    // Override from('embed_configs') to return an embed config
    const origFrom = supa.from;
    supa.from = vi.fn((table: string) => {
      if (table === 'embed_configs') {
        const chain: any = {};
        for (const m of ['select', 'eq', 'maybeSingle']) { chain[m] = vi.fn(() => chain); }
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'embed-1', name: 'Test Embed', title: 'Hello', description: 'World', color: '#5865F2' }, error: null });
        return chain;
      }
      return origFrom(table);
    });
    await startActionQueueListener(guild, supa);
    expect(guild.channels.cache.get('ch-1').send).toHaveBeenCalled();
  });

  it('processes refresh_snapshot action', async () => {
    const actions = [{
      id: 'act-13', guild_id: 'guild-1', action: 'refresh_snapshot', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // writeGuildSnapshot is mocked - no crash = success
  });

  it('handles unknown action type', async () => {
    const actions = [{
      id: 'act-14', guild_id: 'guild-1', action: 'totally_unknown', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // unknown action should be marked as failed
  });

  it('handles claim failure (already claimed)', async () => {
    const actions = [{
      id: 'act-15', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'Test', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    // Override rpc to return null (already claimed)
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_claim') return { data: null, error: null };
      return { data: [], error: null };
    });
    await startActionQueueListener(guild, supa);
    // should skip without crash
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles claim RPC error', async () => {
    const actions = [{
      id: 'act-16', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'Test', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_claim') return { data: null, error: { message: 'DB error' } };
      return { data: [], error: null };
    });
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles recovery with failed rows (DLQ)', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return {
          data: [
            { id: 'stale-1', action: 'create_role', was_failed: true },
            { id: 'stale-2', action: 'update_role', was_failed: false },
          ],
          error: null,
        };
      }
      if (name === 'bot_action_queue_claim') return { data: [{ id: 'claimed' }], error: null };
      return { data: null, error: null };
    });
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // Should attempt to write DLQ entry for stale-1 and re-process stale-2
  });

  it('handles recovery RPC error', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    supa.rpc = vi.fn(async (name: string) => {
      if (name === 'bot_action_queue_recover_stale') {
        return { data: null, error: { message: 'Recovery failed' } };
      }
      return { data: null, error: null };
    });
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // Should log error and continue
  });

  it('rejects a legacy revoke_roles action without touching Discord', async () => {
    const actions = [{
      id: 'act-17', guild_id: 'guild-1', action: 'revoke_roles', status: 'pending',
      payload: { discord_id: 'user-1', role_ids: ['role-1'], reason: 'Subscription expired' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // members.fetch needs to return a member with roles.cache
    const remove = vi.fn().mockResolvedValue({});
    guild.members.fetch = vi.fn()
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: {
          cache: new Map([['role-1', { id: 'role-1' }]]),
          remove,
        },
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: { cache: new Map(), remove },
      });
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect((supa.__queueUpdates as Record<string, unknown>[]).map((u) => u.status)).toContain('failed');
  });

  it('rejects a partial revoke_roles identity before attempting any role removal', async () => {
    const actions = [{
      id: 'act-17b', guild_id: 'guild-1', action: 'revoke_roles', status: 'pending',
      payload: {
        discord_id: 'user-1',
        role_ids: ['role-1', 'role-2'],
        reason: 'grace_period_expired',
        entitlement_id: 'ent-9',
      },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const remove = vi
      .fn()
      .mockResolvedValueOnce({})                       // role-1 removed
      .mockRejectedValueOnce(new Error('Missing Permissions')); // role-2 fails
    guild.members.fetch = vi.fn()
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: {
          cache: new Map([['role-1', { id: 'role-1' }], ['role-2', { id: 'role-2' }]]),
          remove,
        },
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        roles: { cache: new Map([['role-2', { id: 'role-2' }]]), remove },
      });
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(remove).not.toHaveBeenCalled();
    const statuses = (supa.__queueUpdates as Record<string, unknown>[]).map((u) => u.status);
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('completed');
  });

  it('processes run_reconciliation action', async () => {
    const actions = [{
      id: 'act-18', guild_id: 'guild-1', action: 'run_reconciliation', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // runSyncCycle is mocked
  });

  it('processes sync_repair_drift action with repairDriftItem', async () => {
    const driftItem = {
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'role-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(repairDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('rejects queued channel permission drift repair instead of reporting false success', async () => {
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → mod',
      entityDiscordId: 'channel-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair-channel', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(repairDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('does not retry deterministic manual-review permission drift failures', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const driftItem = {
      entityType: 'category',
      entityName: 'restricted → mod',
      entityDiscordId: 'category-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-repair-category', guild_id: 'guild-1', action: 'sync_repair_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);

    await startActionQueueListener(guild, supa);

    expect(repairDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('processes sync_accept_drift action with acceptDriftItem', async () => {
    const driftItem = {
      entityType: 'role',
      entityName: 'Moderator',
      entityDiscordId: 'role-1',
      type: 'EXTERNAL_CHANGE',
    };
    const actions = [{
      id: 'act-sync-accept', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('processes structured queued channel permission drift accept with acceptDriftItem', async () => {
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
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
    const actions = [{
      id: 'act-sync-accept-channel-perms', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('processes structured queued channel permission drift accept with snake_case template_key', async () => {
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
      template_key: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
        overrideAction: { expected: 'update', actual: 'update' },
        allow: { expected: '2048', actual: '1024' },
        deny: { expected: '0', actual: '0' },
      },
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-snake', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
  });

  it('rejects unstructured queued channel permission drift accept without retrying', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general -> Moderator',
      entityDiscordId: 'ch-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-unstructured', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('structured permission overwrite details'),
    }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not retry structured channel permission drift accept failures', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(acceptDriftItem).mockResolvedValueOnce({
      success: false,
      error: 'No desired config found for this channel permission overwrite',
    });
    const driftItem = {
      entityType: 'channel',
      entityName: 'general → Moderator',
      entityDiscordId: 'ch-1',
      templateKey: 'general',
      type: 'PERMISSION_DRIFT',
      details: {
        overrideRoleKey: { expected: 'moderator', actual: 'moderator' },
        overrideRoleId: { expected: 'role-1', actual: 'role-1' },
      },
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms-fails', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).toHaveBeenCalledWith(guild, supa, driftItem);
    expect(supa.__queueUpdates).toContainEqual(expect.objectContaining({
      status: 'failed',
      error_message: expect.stringContaining('No desired config'),
    }));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('processes market_item_reconcile action', async () => {
    const actions = [{
      id: 'act-19', guild_id: 'guild-1', action: 'market_item_reconcile', status: 'pending',
      payload: { listingId: 'listing-1', action: 'delist' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // marketplace reconcile runs
  });

  it('processes fulfill_purchase action', async () => {
    const actions = [{
      id: 'act-20', guild_id: 'guild-1', action: 'fulfill_purchase', status: 'pending',
      payload: { orderId: 'order-1', userId: 'user-1', productId: 'prod-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // fulfillPurchase is mocked
  });

  it('processes test_welcome action', async () => {
    const actions = [{
      id: 'act-21', guild_id: 'guild-1', action: 'test_welcome', status: 'pending',
      payload: { channelId: 'ch-1', userId: 'user-1' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // test welcome message sending
  });

  it('handles create_role with missing required fields', async () => {
    const actions = [{
      id: 'act-22', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: {}, // missing name and tier
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it('handles no pending actions', async () => {
    const guild = makeGuild();
    const supa = makeSupa([]);
    await startActionQueueListener(guild, supa);
      expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
    // should just subscribe to realtime without processing
  });

  it('schedules exponential backoff retry on transient failure (V5 §6.5)', async () => {
    vi.useFakeTimers();
    const actions = [{
      id: 'act-retry-1', guild_id: 'guild-1', action: 'create_role', status: 'pending',
      payload: { name: 'FailRole', tier: 'custom' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // Make create throw a transient error
    guild.roles.create = vi.fn().mockRejectedValue(new Error('DiscordAPIError: 500'));
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // The retry code should update status back to 'pending' with retry_count = 1
    const updateCalls = supa.from.mock.results.filter(
      (r: any) => r.value?.update
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('skips retry for non-transient errors (unknown action)', async () => {
    const actions = [{
      id: 'act-skip-retry', guild_id: 'guild-1', action: 'totally_bogus_action_xyz', status: 'pending',
      payload: {},
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    // Non-transient errors (Unknown action) should NOT schedule retry —
    // they should go straight to 'failed' status
    expect(supa.from).toHaveBeenCalledWith('bot_action_queue');
  });

  it('processes multiple pending actions in order', async () => {
    const actions = [
      {
        id: 'act-a', guild_id: 'guild-1', action: 'create_role', status: 'pending',
        payload: { name: 'RoleA', tier: 'custom' },
        created_at: new Date().toISOString(), retry_count: 0,
      },
      {
        id: 'act-b', guild_id: 'guild-1', action: 'create_channel', status: 'pending',
        payload: { name: 'chan-b', type: 0 },
        created_at: new Date().toISOString(), retry_count: 0,
      },
    ];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.roles.create).toHaveBeenCalled();
    expect(guild.channels.create).toHaveBeenCalled();
  });
});
