/**
 * reaction-roles/button-roles — coverage tests
 *
 * Tests handleButtonRoleInteraction and deployButtonRolesPanel with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  EmbedBuilder: vi.fn().mockImplementation(() => ({
    setColor: vi.fn().mockReturnThis(),
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setTimestamp: vi.fn().mockReturnThis(),
  })),
  ActionRowBuilder: vi.fn().mockImplementation(() => ({
    components: [],
    addComponents: vi.fn().mockImplementation(function (this: any, ...c: any[]) {
      this.components.push(...c);
      return this;
    }),
  })),
  ButtonBuilder: vi.fn().mockImplementation(() => ({
    setCustomId: vi.fn().mockReturnThis(),
    setLabel: vi.fn().mockReturnThis(),
    setStyle: vi.fn().mockReturnThis(),
    setEmoji: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { handleButtonRoleInteraction, deployButtonRolesPanel } from '../features/reaction-roles/button-roles.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'maybeSingle', 'update']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(responses: Record<string, any> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (responses[table]) return chainBuilder(responses[table]);
      return chainBuilder();
    }),
  };
}

function makeInteraction(customId: string, hasRole = false) {
  return {
    customId,
    user: { id: 'u1' },
    guild: {
      id: 'g1',
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: 'u1',
          roles: {
            cache: new Map(hasRole ? [['role1', {}]] : []),
            add: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
          },
        }),
      },
      roles: { cache: new Map([['role1', { name: 'TestRole' }]]) },
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleButtonRoleInteraction', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns false for non-btnrole interactions', async () => {
    const interaction = makeInteraction('other:panel:role');
    const result = await handleButtonRoleInteraction(interaction as any, {} as any);
    expect(result).toBe(false);
  });

  it('replies error for invalid button config', async () => {
    const interaction = makeInteraction('btnrole:');
    const result = await handleButtonRoleInteraction(interaction as any, {} as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Invalid'),
    }));
  });

  it('replies error when button role not found', async () => {
    const supabase = makeSupabase({ button_roles: { data: null, error: null } });
    const interaction = makeInteraction('btnrole:panel1:role1');
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('no longer configured'),
    }));
  });

  it('replies error when button role is disabled', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: false, exclusive_group: null, require_role: null, require_level: null }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1');
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('disabled'),
    }));
  });

  it('adds role when user does not have it', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: null, require_role: null, require_level: null }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1', false);
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Added'),
    }));
  });

  it('removes role when user already has it', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: null, require_role: null, require_level: null }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1', true);
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Removed'),
    }));
  });

  it('checks require_role gate', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: null, require_role: 'admin-role', require_level: null }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1', false);
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('need the'),
    }));
  });

  it('checks require_level gate', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: null, require_role: null, require_level: 10 }, error: null },
      member_levels: { data: { level: 5 }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1', false);
    const result = await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(result).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('level 10'),
    }));
  });

  it('handles exclusive group — removes other roles', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: 'colors', require_role: null, require_level: null }, error: null },
    });
    // Override the from mock for the second call (fetching group entries)
    let callCount = 0;
    supabase.from.mockImplementation((table: string) => {
      callCount++;
      if (table === 'button_roles' && callCount === 1) {
        return chainBuilder({ data: { active: true, exclusive_group: 'colors', require_role: null, require_level: null }, error: null });
      }
      if (table === 'button_roles' && callCount === 2) {
        return chainBuilder({ data: [{ role_id: 'old-role' }], error: null });
      }
      return chainBuilder();
    });
    const interaction = makeInteraction('btnrole:panel1:role1', false);
    await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Added'),
    }));
  });

  it('handles role toggle error', async () => {
    const supabase = makeSupabase({
      button_roles: { data: { active: true, exclusive_group: null, require_role: null, require_level: null }, error: null },
    });
    const interaction = makeInteraction('btnrole:panel1:role1', false);
    // Make roles.add throw
    (interaction.guild as any).members.fetch.mockResolvedValue({
      id: 'u1',
      roles: {
        cache: new Map(),
        add: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
      },
    });
    await handleButtonRoleInteraction(interaction as any, supabase as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Failed to update'),
    }));
  });
});

describe('deployButtonRolesPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deploys a new panel', async () => {
    const channel = {
      send: vi.fn().mockResolvedValue({ id: 'msg1' }),
      messages: { fetch: vi.fn().mockRejectedValue(new Error('not found')) },
    };
    const guild = {
      id: 'g1',
      channels: { cache: new Map([['ch1', channel]]) },
    };
    const supabase = makeSupabase({
      button_roles: {
        data: [
          { id: 'br1', guild_id: 'g1', panel_id: 'p1', channel_id: 'ch1', message_id: null, label: 'Red', emoji: '🔴', role_id: 'r1', style: 'danger', sort_order: 0, active: true, exclusive_group: null },
          { id: 'br2', guild_id: 'g1', panel_id: 'p1', channel_id: 'ch1', message_id: null, label: 'Blue', emoji: null, role_id: 'r2', style: 'primary', sort_order: 1, active: true, exclusive_group: null },
        ],
        error: null,
      },
    });

    const result = await deployButtonRolesPanel(guild as any, supabase as any, 'p1');
    expect(result.success).toBe(true);
    expect(channel.send).toHaveBeenCalled();
  });

  it('returns error when no entries found', async () => {
    const supabase = makeSupabase({ button_roles: { data: [], error: null } });
    const guild = { id: 'g1', channels: { cache: new Map() } };

    const result = await deployButtonRolesPanel(guild as any, supabase as any, 'p1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active roles');
  });

  it('returns error when channel not found', async () => {
    const supabase = makeSupabase({
      button_roles: {
        data: [{ id: 'br1', channel_id: 'missing', message_id: null, label: 'X', role_id: 'r1', style: 'primary', sort_order: 0, active: true }],
        error: null,
      },
    });
    const guild = { id: 'g1', channels: { cache: new Map() } };

    const result = await deployButtonRolesPanel(guild as any, supabase as any, 'p1');
    expect(result.success).toBe(false);
  });

  it('edits existing message', async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const channel = {
      send: vi.fn().mockResolvedValue({ id: 'msg2' }),
      messages: { fetch: vi.fn().mockResolvedValue({ edit: editFn }) },
    };
    const guild = {
      id: 'g1',
      channels: { cache: new Map([['ch1', channel]]) },
    };
    const supabase = makeSupabase({
      button_roles: {
        data: [{ id: 'br1', channel_id: 'ch1', message_id: 'existing-msg', label: 'X', role_id: 'r1', style: 'primary', sort_order: 0, active: true }],
        error: null,
      },
    });

    const result = await deployButtonRolesPanel(guild as any, supabase as any, 'p1');
    expect(result.success).toBe(true);
    expect(editFn).toHaveBeenCalled();
  });
});
