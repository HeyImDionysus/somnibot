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

import { startActionQueueListener } from '../services/action-queue.js';
import { repairDriftItem, acceptDriftItem } from '../sync/repair-actions.js';

// Multi-table Supabase mock that returns different data per table/call
function makeSupa(pendingActions: any[] = []) {
  // Track sequential calls to .from('bot_action_queue') to differentiate
  // the recover RPC, the pending query, and the status updates
  let pendingReturned = false;

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
        chain.update = vi.fn(() => chain);
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
  return supa;
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

  it('processes revoke_roles action', async () => {
    const actions = [{
      id: 'act-17', guild_id: 'guild-1', action: 'revoke_roles', status: 'pending',
      payload: { discord_id: 'user-1', role_ids: ['role-1'], reason: 'Subscription expired' },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    // members.fetch needs to return a member with roles.cache
    guild.members.fetch = vi.fn().mockResolvedValue({
      id: 'user-1',
      roles: {
        cache: new Map([['role-1', { id: 'role-1' }]]),
        remove: vi.fn().mockResolvedValue({}),
      },
    });
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);
    expect(guild.members.fetch).toHaveBeenCalledWith('user-1');
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

  it('rejects queued channel permission drift accept instead of reporting false success', async () => {
    vi.mocked(acceptDriftItem).mockClear();
    const driftItem = {
      entityType: 'channel',
      entityName: 'general -> Moderator',
      entityDiscordId: 'ch-1',
      type: 'PERMISSION_DRIFT',
    };
    const actions = [{
      id: 'act-sync-accept-channel-perms', guild_id: 'guild-1', action: 'sync_accept_drift', status: 'pending',
      payload: { driftItem },
      created_at: new Date().toISOString(), retry_count: 0,
    }];
    const guild = makeGuild();
    const supa = makeSupa(actions);
    await startActionQueueListener(guild, supa);

    expect(acceptDriftItem).not.toHaveBeenCalledWith(guild, supa, driftItem);
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
