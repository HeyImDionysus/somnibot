import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('../services/guild-snapshot.js', () => ({ writeGuildSnapshot: vi.fn(async () => {}) }));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/reconciliation.js', () => ({ runReconciliation: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => {
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  return { eventBus: bus, PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); } };
});

import { ACTION_HANDLERS } from '../services/action-queue.js';
import { eventBus } from '../services/event-bus.js';

const DELIVERY_ID = '00000000-0000-4000-8000-000000000010';
const REWARD_ID = '00000000-0000-4000-8000-000000000011';
const GUILD_ID = '100000000000000001';
const MEMBER_ID = '100000000000000002';
const GRANT_ROLE_ID = '100000000000000003';
const REMOVE_ROLE_ID = '100000000000000004';
const context = { actionId: DELIVERY_ID, claimToken: 'claim-token' };

type LevelRewardHandler = (typeof ACTION_HANDLERS)['deliver_level_reward_roles'];
type ActionGuild = Parameters<LevelRewardHandler>[0];
type ActionSupabase = Parameters<LevelRewardHandler>[1];

function makeFixture() {
  const roleCache = new Map<string, { name: string }>([[REMOVE_ROLE_ID, { name: 'Previous tier' }]]);
  const add = vi.fn(async (roleId: string) => {
    roleCache.set(roleId, { name: 'New tier' });
  });
  const remove = vi.fn(async (roleId: string) => {
    roleCache.delete(roleId);
  });
  const guild = {
    id: GUILD_ID,
    members: {
      fetch: vi.fn(async () => ({ roles: { cache: roleCache, add, remove } })),
    },
    roles: {
      cache: new Map([
        [GRANT_ROLE_ID, { name: 'New tier' }],
        [REMOVE_ROLE_ID, { name: 'Previous tier' }],
      ]),
    },
  };
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const supabase = { rpc };
  return {
    guild: guild as unknown as ActionGuild,
    supabase: supabase as unknown as ActionSupabase,
    rpc,
    add,
    remove,
  };
}

function payload() {
  return {
    delivery_id: DELIVERY_ID,
    guild_id: GUILD_ID,
    member_id: MEMBER_ID,
    reward_id: REWARD_ID,
    delivery_kind: 'award',
    grant_role_id: GRANT_ROLE_ID,
    remove_role_id: REMOVE_ROLE_ID,
  };
}

describe('deliver_level_reward_roles action', () => {
  it('is registered and settles the durable delivery after Discord readback', async () => {
    const { guild, supabase, rpc, add, remove } = makeFixture();

    const result = await ACTION_HANDLERS.deliver_level_reward_roles(
      guild,
      supabase,
      payload(),
      context,
    );

    expect(result.success).toBe(true);
    expect(add).toHaveBeenCalledWith(GRANT_ROLE_ID, 'SomniBot level reward');
    expect(remove).toHaveBeenCalledWith(REMOVE_ROLE_ID, 'SomniBot level reward replacement');
    expect(rpc).toHaveBeenCalledWith('complete_level_reward_role_delivery', {
      p_delivery_id: DELIVERY_ID,
      p_action_id: DELIVERY_ID,
      p_guild_id: GUILD_ID,
    });
    expect(eventBus.emit).toHaveBeenCalledWith('role.gained', GUILD_ID, expect.objectContaining({ roleId: GRANT_ROLE_ID }));
    expect(eventBus.emit).toHaveBeenCalledWith('role.lost', GUILD_ID, expect.objectContaining({ roleId: REMOVE_ROLE_ID }));
  });

  it('rejects mismatched delivery identity before Discord or database mutation', async () => {
    const { guild, supabase, rpc, add, remove } = makeFixture();

    const result = await ACTION_HANDLERS.deliver_level_reward_roles(
      guild,
      supabase,
      { ...payload(), delivery_id: '00000000-0000-4000-8000-000000000099' },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Malformed level reward role delivery',
      retryable: false,
    });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
