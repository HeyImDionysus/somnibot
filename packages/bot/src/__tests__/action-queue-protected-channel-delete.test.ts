import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

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

import { ACTION_HANDLERS } from '../services/action-queue.js';

const context = { actionId: 'action-1', claimToken: 'claim-1' };
type ActionGuild = Parameters<(typeof ACTION_HANDLERS)['delete_channel']>[0];
type ActionSupabase = Parameters<(typeof ACTION_HANDLERS)['delete_channel']>[1];

function makeSupabase(
  moderatorOnlyChannelIds: readonly string[],
  mappingError: { message: string } | null = null,
) {
  const mappingQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    delete: vi.fn(),
  };
  mappingQuery.select.mockReturnValue(mappingQuery);
  mappingQuery.eq.mockReturnValue(mappingQuery);
  mappingQuery.in.mockReturnValue(mappingQuery);
  mappingQuery.delete.mockReturnValue(mappingQuery);
  Object.assign(mappingQuery, {
    then: (resolve: (value: unknown) => unknown) => resolve({
      data: mappingError ? null : moderatorOnlyChannelIds.map((discord_id) => ({ discord_id })),
      error: mappingError,
    }),
  });

  return {
    supabase: { from: vi.fn(() => mappingQuery) },
    mappingQuery,
  };
}

function makeGuild(
  targetId: string,
  type: ChannelType.GuildText | ChannelType.GuildCategory,
  protectedChannelIds: Readonly<Record<'rulesChannelId' | 'publicUpdatesChannelId' | 'safetyAlertsChannelId', string | null>>,
) {
  const target = {
    id: targetId,
    name: 'custom-name-that-must-not-affect-protection',
    type,
    delete: vi.fn(async () => undefined),
  };
  return {
    guild: {
      id: 'guild-1',
      ...protectedChannelIds,
      channels: { cache: new Map([[targetId, target]]) },
    },
    target,
  };
}

function makeRoleGuild(
  roleId: string,
  options: Readonly<{ editable: boolean; managed: boolean }>,
) {
  const role = {
    id: roleId,
    name: 'selected-user-role',
    editable: options.editable,
    managed: options.managed,
    delete: vi.fn(async () => undefined),
  };
  return {
    guild: {
      id: 'guild-1',
      roles: { cache: new Map([[roleId, role]]) },
    },
    role,
  };
}

describe('protected channel and category deletion', () => {
  it.each([
    ['rulesChannelId', 'rules-1'],
    ['publicUpdatesChannelId', 'updates-1'],
    ['safetyAlertsChannelId', 'alerts-1'],
    ['persisted channel:moderator-only', 'moderator-1'],
  ] as const)('rejects delete_channel for %s without Discord or map mutation', async (protectedSource, targetId) => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1']);
    const { guild, target } = makeGuild(targetId, ChannelType.GuildText, {
      rulesChannelId: protectedSource === 'rulesChannelId' ? targetId : null,
      publicUpdatesChannelId: protectedSource === 'publicUpdatesChannelId' ? targetId : null,
      safetyAlertsChannelId: protectedSource === 'safetyAlertsChannelId' ? targetId : null,
    });

    const result = await ACTION_HANDLERS.delete_channel(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { channelId: targetId },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Cannot delete a protected community channel',
      retryable: false,
    });
    expect(target.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['rulesChannelId', 'rules-1'],
    ['publicUpdatesChannelId', 'updates-1'],
    ['safetyAlertsChannelId', 'alerts-1'],
    ['persisted channel:moderator-only', 'moderator-1'],
  ] as const)('rejects delete_category for %s without Discord or map mutation', async (protectedSource, targetId) => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1']);
    const { guild, target } = makeGuild(targetId, ChannelType.GuildCategory, {
      rulesChannelId: protectedSource === 'rulesChannelId' ? targetId : null,
      publicUpdatesChannelId: protectedSource === 'publicUpdatesChannelId' ? targetId : null,
      safetyAlertsChannelId: protectedSource === 'safetyAlertsChannelId' ? targetId : null,
    });

    const result = await ACTION_HANDLERS.delete_category(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { categoryId: targetId },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Cannot delete a protected community channel',
      retryable: false,
    });
    expect(target.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });

  it('refuses deletion when the persisted moderator-only ID cannot be verified', async () => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1'], { message: 'database unavailable' });
    const { guild, target } = makeGuild('custom-1', ChannelType.GuildText, {
      rulesChannelId: null,
      publicUpdatesChannelId: null,
      safetyAlertsChannelId: null,
    });

    const result = await ACTION_HANDLERS.delete_channel(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { channelId: 'custom-1' },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Unable to verify protected community channels; delete refused',
      retryable: true,
    });
    expect(target.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });

  it('allows a dashboard delete for an unrelated user-created channel', async () => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1']);
    const { guild, target } = makeGuild('user-channel-1', ChannelType.GuildText, {
      rulesChannelId: 'rules-1',
      publicUpdatesChannelId: 'updates-1',
      safetyAlertsChannelId: 'alerts-1',
    });

    const result = await ACTION_HANDLERS.delete_channel(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      {
      channelId: 'user-channel-1',
      },
      context,
    );

    expect(result).toMatchObject({
      success: true,
      data: { channelId: 'user-channel-1' },
    });
    expect(target.delete).toHaveBeenCalledOnce();
    expect(mappingQuery.delete).toHaveBeenCalledOnce();
  });

  it('rejects the legacy persisted moderator-only ID without a name lookup', async () => {
    const { supabase, mappingQuery } = makeSupabase(['legacy-moderator-1']);
    const { guild, target } = makeGuild('legacy-moderator-1', ChannelType.GuildText, {
      rulesChannelId: null,
      publicUpdatesChannelId: null,
      safetyAlertsChannelId: null,
    });

    const result = await ACTION_HANDLERS.delete_channel(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      {
      channelId: 'legacy-moderator-1',
      },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Cannot delete a protected community channel',
      retryable: false,
    });
    expect(mappingQuery.in).toHaveBeenCalledWith(
      'template_key',
      ['channel:moderator-only', 'moderator-only'],
    );
    expect(target.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });

  it('refuses deletion when either moderator-only mapping row is malformed', async () => {
    const { supabase, mappingQuery } = makeSupabase(['']);
    const { guild, target } = makeGuild('custom-1', ChannelType.GuildText, {
      rulesChannelId: null,
      publicUpdatesChannelId: null,
      safetyAlertsChannelId: null,
    });

    const result = await ACTION_HANDLERS.delete_channel(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { channelId: 'custom-1' },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Unable to verify protected community channels; delete refused',
      retryable: true,
    });
    expect(target.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });
});

describe('protected role deletion', () => {
  it.each([
    ['@everyone', 'guild-1', { editable: false, managed: false }, 'Cannot delete the @everyone role'],
    ['uneditable role', 'role-above-bot', { editable: false, managed: false }, 'Cannot delete a role the bot cannot manage'],
  ] as const)('rejects %s before Discord or map mutation', async (_label, roleId, options, error) => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1']);
    const { guild, role } = makeRoleGuild(roleId, options);

    const result = await ACTION_HANDLERS.delete_role(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { roleId },
      context,
    );

    expect(result).toEqual({ success: false, error, retryable: false });
    expect(role.delete).not.toHaveBeenCalled();
    expect(mappingQuery.delete).not.toHaveBeenCalled();
  });

  it('allows an explicit dashboard deletion of an editable user role', async () => {
    const { supabase, mappingQuery } = makeSupabase(['moderator-1']);
    const { guild, role } = makeRoleGuild('user-role-1', { editable: true, managed: false });

    const result = await ACTION_HANDLERS.delete_role(
      guild as unknown as ActionGuild,
      supabase as unknown as ActionSupabase,
      { roleId: 'user-role-1' },
      context,
    );

    expect(result).toMatchObject({
      success: true,
      data: { roleId: 'user-role-1' },
    });
    expect(role.delete).toHaveBeenCalledOnce();
    expect(mappingQuery.delete).toHaveBeenCalledOnce();
  });
});
