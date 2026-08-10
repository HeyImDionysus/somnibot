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

function makeMember(
  guildId: string,
  id: string,
  options: {
    readonly pending?: boolean;
    readonly completed?: boolean;
    readonly hasMemberRole?: boolean;
    readonly bot?: boolean;
  } = {},
) {
  return {
    id,
    pending: options.pending ?? true,
    user: { bot: options.bot ?? false, tag: `${id}#0001` },
    flags: { has: vi.fn(() => options.completed ?? false) },
    roles: {
      cache: { has: vi.fn(() => options.hasMemberRole ?? false) },
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
  const guild = { id: guildId, members: { fetch } };
  for (const member of members) member.guild = guild;

  const rpc = vi.fn().mockResolvedValue({ data: { status: 'granted' }, error: null });
  const client = { supabase: { rpc } };
  const config = {
    fallback_mode: 'grant-after-timeout',
    fallback_timeout_minutes: 3,
    member_role_id: 'member-role',
  };

  return {
    client: client as unknown as SomniClient,
    config: config as unknown as DbGuildConfig,
    fetch,
    guild: guild as unknown as Guild,
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
    expect(rpc).toHaveBeenCalledWith('grant_onboarding_fallback_atomic', expect.objectContaining({
      p_guild_id: 'guild-reload',
      p_discord_id: 'pending-user',
      p_timeout_minutes: 3,
    }));
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
    expect(rpc).not.toHaveBeenCalled();
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
    expect(rpc).not.toHaveBeenCalled();
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
    expect(rpc).toHaveBeenCalledWith('grant_onboarding_fallback_atomic', expect.objectContaining({
      p_timeout_minutes: 1,
    }));
  });
});
