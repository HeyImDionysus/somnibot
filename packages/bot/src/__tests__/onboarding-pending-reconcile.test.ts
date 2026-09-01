import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import type { DbGuildConfig } from '@somnibot/shared';
import type { SomniClient } from '../client.js';

vi.mock('discord.js', () => ({
  GuildMemberFlags: { CompletedOnboarding: 1 << 0 },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../features/welcome/welcome-service.js', () => ({
  executeWelcomeFlow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../features/welcome/member-service.js', () => ({
  lookupMember: vi.fn(),
  recordMemberJoin: vi.fn(),
  recordMemberLeave: vi.fn(),
  markOnboardingCompleted: vi.fn(),
  fetchCompleteRoster: vi.fn(async (guild: {
    readonly members: {
      readonly fetch: (request?: string | { readonly time: number }) => Promise<unknown>;
    };
  }) => guild.members.fetch({ time: 15_000 })),
}));

vi.mock('../features/welcome/goodbye-service.js', () => ({
  executeGoodbyeFlow: vi.fn(),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(),
}));

import { reconcilePendingOnboardingMembers } from '../features/welcome/onboarding-handler.js';
import { markOnboardingCompleted } from '../features/welcome/member-service.js';
import { executeWelcomeFlow } from '../features/welcome/welcome-service.js';

function makeMember(
  guildId: string,
  id: string,
  options: {
    readonly pending?: boolean;
    readonly completed?: boolean;
    readonly hasMemberRole?: boolean;
    readonly roleIds?: readonly string[];
    readonly bot?: boolean;
  } = {},
) {
  const roleIds = options.roleIds ?? (options.hasMemberRole ? ['member-role'] : []);
  return {
    id,
    pending: options.pending ?? true,
    user: { bot: options.bot ?? false, tag: `${id}#0001` },
    flags: { has: vi.fn(() => options.completed ?? false) },
    roles: {
      cache: { has: vi.fn((roleId: string) => roleIds.includes(roleId)) },
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    guild: { id: guildId },
  };
}

function makeFixture(guildId: string, members: ReturnType<typeof makeMember>[]) {
  const roster = new Map(members.map((member) => [member.id, member]));
  const fetch = vi.fn(async (request?: string | { readonly time: number }) => (
    typeof request === 'string' ? roster.get(request) : roster
  ));
  const roleIds = ['member-role', 'current-member-role', 'stale-member-role'];
  const roles = new Map(roleIds.map((roleId) => [roleId, {
    id: roleId,
    name: roleId,
    managed: false,
    editable: true,
  }]));
  const guild = {
    id: guildId,
    members: {
      fetch,
      me: { permissions: { has: vi.fn(() => true) } },
    },
    roles: { cache: roles },
  };
  for (const member of members) member.guild = guild;

  type RpcResult = {
    readonly data: unknown;
    readonly error: { readonly message: string } | null;
  };
  const rpc = vi.fn<(
    name: string,
    parameters?: { readonly p_member_role_id?: string },
  ) => Promise<RpcResult>>(async (name, parameters) => {
    if (name === 'list_onboarding_fallback_intents') return { data: [], error: null };
    if (name === 'claim_onboarding_fallback_intent') {
      return {
        data: {
          status: 'claimed',
          intent_id: '11111111-1111-4111-8111-111111111111',
          attempt_token: '22222222-2222-4222-8222-222222222222',
          member_role_id: parameters?.p_member_role_id ?? 'member-role',
          attempt_count: 1,
          role_add_authorized: true,
        },
        error: null,
      };
    }
    if (name === 'complete_onboarding_fallback_intent') {
      return { data: { status: 'completed' }, error: null };
    }
    return { data: { status: 'lost_claim' }, error: null };
  });
  const client = { supabase: { rpc } };
  const config = {
    onboarding_enabled: true,
    fallback_mode: 'grant-after-timeout',
    fallback_timeout_minutes: 3,
    member_role_id: 'member-role',
  };
  const clientFixture: SomniClient = Object.assign(Object.create(null), client);
  const configFixture: DbGuildConfig = Object.assign(Object.create(null), config);
  const guildFixture: Guild = Object.assign(Object.create(null), guild);

  return {
    client: clientFixture,
    config: configFixture,
    fetch,
    guild: guildFixture,
    rpc,
  };
}

describe('reconcilePendingOnboardingMembers', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps one active fallback when current config is reconciled repeatedly', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-reload', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-reload', [pendingMember]);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await reconcilePendingOnboardingMembers(client, guild, config);
    await reconcilePendingOnboardingMembers(client, guild, config);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(pendingMember.roles.add).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('claim_onboarding_fallback_intent', expect.objectContaining({
      p_guild_id: 'guild-reload',
      p_discord_id: 'pending-user',
      p_timeout_minutes: 3,
      p_role_add_authorized: true,
    }));
  });

  it('persists fallback intent before granting Discord access and finalizes only afterward', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-durable-order', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-durable-order', [pendingMember]);
    const actions: string[] = [];
    pendingMember.roles.add.mockImplementation(async () => {
      actions.push('discord-role');
    });
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return { data: [], error: null };
      }
      actions.push(name);
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'member-role',
            attempt_count: 1,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      return { data: { status: 'completed' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(actions).toEqual([
      'claim_onboarding_fallback_intent',
      'discord-role',
      'complete_onboarding_fallback_intent',
    ]);
  });

  it('does not claim or attribute fallback when the role appears before the first attempt', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-preexisting-role', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-preexisting-role', [pendingMember]);

    await reconcilePendingOnboardingMembers(client, guild, config);
    pendingMember.roles.cache.has.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(pendingMember.roles.add).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([name]) => name === 'claim_onboarding_fallback_intent')).toBe(false);
    expect(rpc.mock.calls.some(([name]) => name === 'complete_onboarding_fallback_intent')).toBe(false);
  });

  it('retries a failed Discord role grant automatically but stops after three attempts', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-bounded-retry', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-bounded-retry', [pendingMember]);
    pendingMember.roles.add.mockRejectedValue(new Error('Discord unavailable'));
    let claimCount = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') return { data: [], error: null };
      if (name === 'claim_onboarding_fallback_intent') {
        claimCount++;
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: `22222222-2222-4222-8222-22222222222${claimCount}`,
            member_role_id: 'member-role',
            attempt_count: claimCount,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      if (name === 'fail_onboarding_fallback_attempt') {
        return claimCount < 3
          ? { data: { status: 'retry', retry_after_ms: 1_000 }, error: null }
          : { data: { status: 'failed' }, error: null };
      }
      return { data: { status: 'lost_claim' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 2_000);

    expect(pendingMember.roles.add).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.filter(([name]) => name === 'fail_onboarding_fallback_attempt')).toHaveLength(3);
    expect(rpc.mock.calls.some(([name]) => name === 'complete_onboarding_fallback_intent')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes a durable intent after restart and completes an already-present role idempotently', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-restart', 'pending-user', { hasMemberRole: true });
    const { client, config, guild, rpc } = makeFixture('guild-restart', [pendingMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'member-role',
            attempt_count: 2,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      return { data: { status: 'completed' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.add).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('claim_onboarding_fallback_intent', expect.objectContaining({
      p_role_add_authorized: false,
    }));
    expect(rpc).toHaveBeenCalledWith('complete_onboarding_fallback_intent', {
      p_intent_id: '11111111-1111-4111-8111-111111111111',
      p_attempt_token: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('does not attribute an already-present role without durable add authorization', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-unauthorized-role', 'pending-user', { hasMemberRole: true });
    const { client, config, guild, rpc } = makeFixture('guild-unauthorized-role', [pendingMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: false,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'member-role',
            attempt_count: 1,
            role_add_authorized: false,
          },
          error: null,
        };
      }
      return { data: { status: 'cancelled' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.add).not.toHaveBeenCalled();
    expect(pendingMember.roles.remove).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([name]) => name === 'complete_onboarding_fallback_intent')).toBe(false);
    expect(rpc).toHaveBeenCalledWith('cancel_onboarding_fallback_intent', {
      p_intent_id: '11111111-1111-4111-8111-111111111111',
      p_attempt_token: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('executes welcome exactly once when a stale worker observes an already-completed replay', async () => {
    vi.useFakeTimers();
    vi.mocked(executeWelcomeFlow).mockClear();
    const pendingMember = makeMember('guild-welcome-owner', 'pending-user', { hasMemberRole: true });
    const { client, config, guild, rpc } = makeFixture('guild-welcome-owner', [pendingMember]);
    let claimCount = 0;
    let completionCount = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        claimCount++;
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: `22222222-2222-4222-8222-22222222222${claimCount}`,
            member_role_id: 'member-role',
            attempt_count: claimCount,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      if (name === 'complete_onboarding_fallback_intent') {
        completionCount++;
        return {
          data: { status: completionCount === 1 ? 'completed' : 'already_completed' },
          error: null,
        };
      }
      return { data: { status: 'lost_claim' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(0);
    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.mock.calls.filter(([name]) => name === 'complete_onboarding_fallback_intent')).toHaveLength(2);
    expect(vi.mocked(executeWelcomeFlow)).toHaveBeenCalledOnce();
  });

  it('does not grant from an in-flight attempt superseded by current configuration', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-in-flight', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-in-flight', [pendingMember]);
    type ClaimResult = {
      readonly data: {
        readonly status: 'claimed';
        readonly intent_id: string;
        readonly attempt_token: string;
        readonly member_role_id: string;
        readonly attempt_count: number;
        readonly role_add_authorized: boolean;
      };
      readonly error: null;
    };
    let resolveClaim: ((result: ClaimResult) => void) | undefined;
    const heldClaim = new Promise<ClaimResult>((resolve) => {
      resolveClaim = resolve;
    });
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') return { data: [], error: null };
      if (name === 'claim_onboarding_fallback_intent') return heldClaim;
      return { data: { status: 'lost_claim' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    vi.advanceTimersByTime(3 * 60_000);
    await vi.waitFor(() => {
      expect(rpc.mock.calls.some(([name]) => name === 'claim_onboarding_fallback_intent')).toBe(true);
    });

    await reconcilePendingOnboardingMembers(client, guild, {
      ...config,
      fallback_timeout_minutes: 1,
      member_role_id: 'current-member-role',
    });
    resolveClaim?.({
      data: {
        status: 'claimed',
        intent_id: '11111111-1111-4111-8111-111111111111',
        attempt_token: '22222222-2222-4222-8222-222222222222',
        member_role_id: 'member-role',
        attempt_count: 1,
        role_add_authorized: true,
      },
      error: null,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.add).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('fail_onboarding_fallback_attempt', expect.objectContaining({
      p_intent_id: '11111111-1111-4111-8111-111111111111',
    }));
  });

  it('removes a crash-surviving stale role when fallback is disabled before restart', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-disabled-restart', 'pending-user', {
      roleIds: ['stale-member-role'],
    });
    const { client, config, guild, rpc } = makeFixture('guild-disabled-restart', [pendingMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'stale-member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'stale_config',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'stale-member-role',
            attempt_count: 1,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      return { data: { status: 'cancelled' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, {
      ...config,
      fallback_mode: 'manual-review',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.remove).toHaveBeenCalledWith(
      'stale-member-role',
      'Onboarding fallback configuration changed',
    );
    expect(pendingMember.roles.add).not.toHaveBeenCalled();
  });

  it('removes an already-present resumed role when completion detects stale configuration', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-stale-completion', 'pending-user', { hasMemberRole: true });
    const { client, config, guild, rpc } = makeFixture('guild-stale-completion', [pendingMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'member-role',
            attempt_count: 2,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      if (name === 'complete_onboarding_fallback_intent') {
        return { data: { status: 'stale_config' }, error: null };
      }
      return { data: { status: 'cancelled' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.remove).toHaveBeenCalledWith(
      'member-role',
      'Onboarding fallback completion rejected',
    );
    expect(rpc).toHaveBeenCalledWith('cancel_onboarding_fallback_intent', expect.any(Object));
  });

  it('starts the current fallback after cleaning a durable stale-role intent', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-durable-replace', 'pending-user', {
      roleIds: ['stale-member-role'],
    });
    const { client, config, guild, rpc } = makeFixture('guild-durable-replace', [pendingMember]);
    rpc.mockImplementation(async (
      name: string,
      parameters?: { readonly p_member_role_id?: string },
    ) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'pending-user',
            member_role_id: 'stale-member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent' && parameters?.p_member_role_id === 'stale-member-role') {
        return {
          data: {
            status: 'stale_config',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'stale-member-role',
            attempt_count: 1,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '33333333-3333-4333-8333-333333333333',
            attempt_token: '44444444-4444-4444-8444-444444444444',
            member_role_id: 'current-member-role',
            attempt_count: 1,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      if (name === 'complete_onboarding_fallback_intent') {
        return { data: { status: 'completed' }, error: null };
      }
      return { data: { status: 'cancelled' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, {
      ...config,
      fallback_timeout_minutes: 1,
      member_role_id: 'current-member-role',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(pendingMember.roles.remove).toHaveBeenCalledWith(
      'stale-member-role',
      'Onboarding fallback configuration changed',
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pendingMember.roles.add).toHaveBeenCalledWith(
      'current-member-role',
      'Onboarding fallback timeout',
    );
  });

  it('does not revoke a role when completion ownership moved to another worker', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-claim-moved', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-claim-moved', [pendingMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') return { data: [], error: null };
      if (name === 'claim_onboarding_fallback_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '11111111-1111-4111-8111-111111111111',
            attempt_token: '22222222-2222-4222-8222-222222222222',
            member_role_id: 'member-role',
            attempt_count: 1,
            role_add_authorized: true,
          },
          error: null,
        };
      }
      return { data: { status: 'lost_claim' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(pendingMember.roles.add).toHaveBeenCalledOnce();
    expect(pendingMember.roles.remove).not.toHaveBeenCalled();
  });

  it('immediately restores the current role for a completed non-pending member', async () => {
    vi.useFakeTimers();
    const completedMember = makeMember('guild-completed', 'completed-user', {
      completed: true,
      pending: false,
    });
    const { client, config, guild, rpc } = makeFixture('guild-completed', [completedMember]);

    await reconcilePendingOnboardingMembers(client, guild, config);

    expect(completedMember.roles.add).toHaveBeenCalledWith(
      'member-role',
      'Recovering completed Discord onboarding',
    );
    expect(vi.mocked(markOnboardingCompleted)).toHaveBeenCalledWith(
      client.supabase,
      'guild-completed',
      'completed-user',
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(rpc.mock.calls.some(([name]) => name === 'claim_onboarding_fallback_intent')).toBe(false);
  });

  it('prioritizes native completion over a durable fallback and terminates the intent', async () => {
    vi.useFakeTimers();
    const completedMember = makeMember('guild-native-priority', 'completed-user', {
      completed: true,
      pending: false,
    });
    const { client, config, guild, rpc } = makeFixture('guild-native-priority', [completedMember]);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_onboarding_fallback_intents') {
        return {
          data: [{
            discord_id: 'completed-user',
            member_role_id: 'stale-member-role',
            timeout_minutes: 3,
            next_attempt_at: new Date(0).toISOString(),
            role_add_authorized: true,
          }],
          error: null,
        };
      }
      if (name === 'terminate_onboarding_fallback_intent') {
        return { data: { status: 'cancelled' }, error: null };
      }
      return { data: { status: 'lost_claim' }, error: null };
    });

    await reconcilePendingOnboardingMembers(client, guild, config);

    expect(vi.mocked(markOnboardingCompleted)).toHaveBeenCalledWith(
      client.supabase,
      'guild-native-priority',
      'completed-user',
    );
    expect(completedMember.roles.add).toHaveBeenCalledWith(
      'member-role',
      'Recovering completed Discord onboarding',
    );
    expect(rpc).toHaveBeenCalledWith('terminate_onboarding_fallback_intent', {
      p_guild_id: 'guild-native-priority',
      p_discord_id: 'completed-user',
      p_reason: 'native_onboarding_completed',
    });
    expect(rpc.mock.calls.some(([name]) => name === 'claim_onboarding_fallback_intent')).toBe(false);
    expect(rpc.mock.calls.some(([name]) => name === 'complete_onboarding_fallback_intent')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule role-present, incomplete non-pending, or bot members', async () => {
    vi.useFakeTimers();
    const members = [
      makeMember('guild-skips', 'role-present', { hasMemberRole: true }),
      makeMember('guild-skips', 'not-pending', { pending: false }),
      makeMember('guild-skips', 'bot', { bot: true }),
    ];
    const { client, config, guild } = makeFixture('guild-skips', members);

    await reconcilePendingOnboardingMembers(client, guild, config);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not grant when the member is no longer pending at timeout', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-completed', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-completed', [pendingMember]);

    await reconcilePendingOnboardingMembers(client, guild, config);
    pendingMember.pending = false;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(pendingMember.roles.add).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([name]) => name === 'claim_onboarding_fallback_intent')).toBe(false);
  });

  it('cancels an existing fallback when current config disables it', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-disable', 'pending-user');
    const { client, config, guild } = makeFixture('guild-disable', [pendingMember]);

    await reconcilePendingOnboardingMembers(client, guild, config);
    expect(vi.getTimerCount()).toBe(1);

    await reconcilePendingOnboardingMembers(client, guild, {
      ...config,
      fallback_mode: 'manual-review',
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a stale fallback with the current role and timeout', async () => {
    vi.useFakeTimers();
    const pendingMember = makeMember('guild-change', 'pending-user');
    const { client, config, guild, rpc } = makeFixture('guild-change', [pendingMember]);

    await reconcilePendingOnboardingMembers(client, guild, config);
    await reconcilePendingOnboardingMembers(client, guild, {
      ...config,
      fallback_timeout_minutes: 1,
      member_role_id: 'current-member-role',
    });

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pendingMember.roles.add).toHaveBeenCalledWith(
      'current-member-role',
      'Onboarding fallback timeout',
    );
    expect(rpc).toHaveBeenCalledWith('claim_onboarding_fallback_intent', expect.objectContaining({
      p_timeout_minutes: 1,
    }));
  });
});
