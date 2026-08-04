/**
 * Reaction Roles Engine — Full tests
 *
 * Tests loadReactionRoles, handleReactionAdd, handleReactionRemove.
 * Covers: cache population, role granting, role removal, exclusive groups,
 * max per group, prerequisite role/level checks, bot user filtering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  loadReactionRoles,
  handleReactionAdd,
  handleReactionRemove,
} from '../features/reaction-roles/reaction-engine.js';
import { MockCollection } from './helpers/discord-mocks.js';

function supaChain(data: any[] = [], error: any = null) {
  const c: any = {};
  const methods = ['select','eq','neq','gte','lt','lte','limit','order','in','head','filter'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.single = vi.fn(async () => ({ data: data[0] ?? null, error }));
  c.maybeSingle = vi.fn(async () => ({ data: data[0] ?? null, error }));
  c.then = (resolve: any) => resolve({ data, error });
  return c;
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: any[]) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (...keys: string[]) => { for (const k of keys) store.delete(k); return keys.length; }),
    scan: vi.fn(async () => ['0', []]),
    _store: store,
  } as any;
}

function makeSupabase(tableResponses: Record<string, any[]> = {}) {
  return {
    from: vi.fn((table: string) => supaChain(tableResponses[table] ?? [])),
  } as any;
}

function makeReaction(messageId: string, emojiName: string, emojiId?: string) {
  return {
    message: { id: messageId },
    emoji: {
      name: emojiName,
      id: emojiId ?? null,
    },
    users: {
      remove: vi.fn(async () => {}),
    },
  } as any;
}

function makeGuild(members: any[] = []) {
  const memberMap = new MockCollection();
  for (const m of members) memberMap.set(m.id, m);
  const roleMap = new MockCollection();
  roleMap.set('r1', { id: 'r1', name: 'ColorRed' });
  roleMap.set('r2', { id: 'r2', name: 'ColorBlue' });
  roleMap.set('r3', { id: 'r3', name: 'Premium' });
  return {
    id: 'g1',
    members: {
      cache: memberMap,
      fetch: vi.fn(async (id: string) => memberMap.get(id) ?? null),
    },
    roles: { cache: roleMap },
  } as any;
}

function makeMember(id: string, roleIds: string[] = []) {
  const roles = new MockCollection();
  for (const r of roleIds) roles.set(r, { id: r, name: `Role-${r}` });
  return {
    id,
    user: { id, bot: false },
    roles: {
      cache: roles,
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  } as any;
}

function makeUser(id: string, bot = false) {
  return { id, bot } as any;
}

const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadReactionRoles', () => {
  it('caches active reaction roles from supabase', async () => {
    const valkey = makeValkey();
    const rrData = [
      {
        id: 'rr1', message_id: 'msg1', emoji: '🔥', role_id: 'r1',
        exclusive_group: null, require_role: null, require_level: null,
        max_per_group: null, remove_on_unreact: true, log_actions: false,
      },
    ];
    const supabase = makeSupabase({ reaction_roles: rrData });

    await loadReactionRoles(supabase, valkey, 'g1');

    expect(supabase.from).toHaveBeenCalledWith('reaction_roles');
    expect(valkey.set).toHaveBeenCalledWith(
      'reactionRoles:g1:msg1:🔥',
      expect.any(String),
      'EX',
      600,
    );
  });

  it('carries the guild default interaction style into the runtime cache', async () => {
    const valkey = makeValkey();
    const supabase = makeSupabase({
      guild_config: [{
        reaction_roles_enabled: true,
        default_style: 'select-menu',
        default_max_per_group: 0,
        default_require_level: 0,
        default_remove_on_unreact: true,
      }],
      reaction_roles: [{
        id: 'rr-style', message_id: 'msg-style', emoji: '🎨', role_id: 'r1',
        exclusive_group: null, require_role: null, require_level: null,
        max_per_group: null, remove_on_unreact: true, log_actions: false,
      }],
    });

    await loadReactionRoles(supabase, valkey, 'g1');

    expect(JSON.parse(valkey._store.get('reactionRoles:g1:msg-style:🎨')!)).toMatchObject({
      default_style: 'select-menu',
    });
  });

  it('does nothing when no active configs', async () => {
    const valkey = makeValkey();
    const supabase = makeSupabase({ reaction_roles: [] });

    await loadReactionRoles(supabase, valkey, 'g1');
    expect(valkey.set).not.toHaveBeenCalled();
  });

  it('clears old cache before populating new', async () => {
    const valkey = makeValkey();
    valkey.scan = vi.fn(async () => ['0', ['reactionRoles:g1:old1', 'reactionRoles:g1:old2']]);
    const supabase = makeSupabase({
      reaction_roles: [
        { id: 'rr1', message_id: 'msg1', emoji: '✅', role_id: 'r1',
          exclusive_group: null, require_role: null, require_level: null,
          max_per_group: null, remove_on_unreact: true, log_actions: false },
      ],
    });

    await loadReactionRoles(supabase, valkey, 'g1');
    expect(valkey.del).toHaveBeenCalledWith('reactionRoles:g1:old1', 'reactionRoles:g1:old2');
  });
});

describe('handleReactionAdd', () => {
  it('returns false for bot users', async () => {
    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('bot1', true);
    const guild = makeGuild();
    const supabase = makeSupabase();
    const valkey = makeValkey();

    const result = await handleReactionAdd(reaction, user, guild, supabase, valkey, eventBus);
    expect(result).toBe(false);
  });

  it('returns false when no cached config exists', async () => {
    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const valkey = makeValkey(); // empty cache

    const result = await handleReactionAdd(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(false);
  });

  it('grants role when config exists in cache', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    // Pre-populate cache
    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Reaction role');
    expect(eventBus.emit).toHaveBeenCalledWith('role.gained', 'g1', expect.objectContaining({
      roleId: 'r1',
    }));
  });

  it('denies when member lacks required prerequisite role', async () => {
    const member = makeMember('u1', []); // no roles
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: 'premium-role', require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:⭐', JSON.stringify(config));

    const reaction = makeReaction('msg1', '⭐');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true); // handled, but silently denied
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(reaction.users.remove).toHaveBeenCalledWith('u1');
  });

  it('denies when member level is below requirement', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: 10, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🎖️', JSON.stringify(config));

    // Return level data below requirement
    const supabase = makeSupabase({ member_levels: [{ level: 5 }] });

    const reaction = makeReaction('msg1', '🎖️');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, supabase, valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('removes other roles in exclusive group before granting', async () => {
    const member = makeMember('u1', ['r2']); // has r2
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: 'colors',
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔴', JSON.stringify(config));

    // Other roles in the group
    const supabase = makeSupabase({
      reaction_roles: [{ role_id: 'r2' }, { role_id: 'r3' }],
    });

    const reaction = makeReaction('msg1', '🔴');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, supabase, valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledWith('r2', 'Exclusive reaction role group');
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Reaction role');
  });

  it('handles member fetch failure gracefully', async () => {
    const guild = makeGuild([]); // no members
    guild.members.fetch = vi.fn(async () => null);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(false);
  });

  it('falls back to emoji name when custom emoji format not found', async () => {
    const member = makeMember('u1');
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    // Config stored under plain name, not custom format
    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:custom_emoji', JSON.stringify(config));

    const reaction = makeReaction('msg1', 'custom_emoji', 'emoji123');
    const user = makeUser('u1');

    const result = await handleReactionAdd(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Reaction role');
  });
});

describe('handleReactionRemove', () => {
  it('returns false for bot users', async () => {
    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('bot1', true);
    const guild = makeGuild();
    const result = await handleReactionRemove(reaction, user, guild, makeSupabase(), makeValkey(), eventBus);
    expect(result).toBe(false);
  });

  it('returns false when no cached config', async () => {
    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');
    const guild = makeGuild();
    const result = await handleReactionRemove(reaction, user, guild, makeSupabase(), makeValkey(), eventBus);
    expect(result).toBe(false);
  });

  it('removes role when remove_on_unreact is true', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    const result = await handleReactionRemove(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledWith('r1', 'Reaction role removed');
    expect(eventBus.emit).toHaveBeenCalledWith('role.lost', 'g1', expect.objectContaining({
      roleId: 'r1',
    }));
  });

  it('does not remove role when remove_on_unreact is false', async () => {
    const member = makeMember('u1', ['r1']);
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: false, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    const result = await handleReactionRemove(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true); // handled but no role removal
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('handles role removal failure gracefully', async () => {
    const member = makeMember('u1', ['r1']);
    member.roles.remove = vi.fn(async () => { throw new Error('Missing perms'); });
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    await expect(
      handleReactionRemove(reaction, user, guild, makeSupabase(), valkey, eventBus),
    ).resolves.not.toThrow();
  });

  it('does not remove role member doesn\'t have', async () => {
    const member = makeMember('u1', []); // no r1
    const guild = makeGuild([member]);
    const valkey = makeValkey();

    const config = {
      id: 'rr1', role_id: 'r1', exclusive_group: null,
      require_role: null, require_level: null, max_per_group: null,
      remove_on_unreact: true, log_actions: false,
    };
    valkey._store.set('reactionRoles:g1:msg1:🔥', JSON.stringify(config));

    const reaction = makeReaction('msg1', '🔥');
    const user = makeUser('u1');

    const result = await handleReactionRemove(reaction, user, guild, makeSupabase(), valkey, eventBus);
    expect(result).toBe(true);
    expect(member.roles.remove).not.toHaveBeenCalled();
  });
});
