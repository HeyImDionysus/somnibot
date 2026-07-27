/**
 * Tests for lib/admin-changes — DASHBOARD-side admin_changes recording.
 *
 * The dashboard previously never wrote this table: its /api/admin-changes
 * route only read rows and applied undos, so every settings change an owner
 * made from the dashboard was invisible on the page built to explain
 * "what changed in my server".
 *
 * These tests pin the properties that make the recorded row trustworthy:
 *  - the row is actually INSERTED, with the caller's actor/action/description
 *    and a before/after pair;
 *  - recording NEVER throws and never surfaces an error, because the mutation
 *    it describes has already committed — bookkeeping must not fail a save;
 *  - an undo is validated at WRITE time with the same allowlist the undo route
 *    uses at CLICK time, so the page can never show a button that would fail;
 *  - bookkeeping columns (guild_id, updated_at) are excluded from both the
 *    description and the restore payload — guild_id is the undo MATCH key and
 *    is rejected inside undo data, and neither is a setting the owner chose;
 *  - when the prior values could not be read there is nothing to restore TO,
 *    so the change records as not-undoable with that reason stated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));

import {
  recordAdminChange,
  recordGuildConfigChange,
  readGuildConfigBefore,
  describeSettingChange,
} from '@/lib/admin-changes';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';

/** Capture what was inserted into admin_changes. */
function makeAdmin(opts: { insertError?: { message: string } | null } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const admin = {
    from: vi.fn((table: string) => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        if (table === 'admin_changes') inserted.push(row);
        return { error: opts.insertError ?? null };
      }),
    })),
  } as never;
  return { admin, inserted };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('recordAdminChange', () => {
  it('inserts a row carrying the actor, action and readable description', async () => {
    const { admin, inserted } = makeAdmin();

    await recordAdminChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'branding.updated',
        targetType: 'guild_config',
        targetId: GUILD,
        description: 'Changed the store brand name setting in branding',
        before: { store_brand_name: 'Old' },
        after: { store_brand_name: 'New' },
        blastRadius: 'medium',
      },
      admin,
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      guild_id: GUILD,
      actor_id: ACTOR,
      action: 'branding.updated',
      target_type: 'guild_config',
      description: 'Changed the store brand name setting in branding',
      blast_radius: 'medium',
      is_undoable: false,
    });
  });

  it('never throws when the insert fails — the mutation already committed', async () => {
    const { admin } = makeAdmin({ insertError: { message: 'db is on fire' } });

    await expect(
      recordAdminChange(
        {
          guildId: GUILD,
          actorId: ACTOR,
          action: 'levels.updated',
          targetType: 'guild_config',
          description: 'Changed a setting',
        },
        admin,
      ),
    ).resolves.toBeUndefined();
  });

  it('never throws when the client itself blows up', async () => {
    const exploding = {
      from: () => {
        throw new Error('no connection');
      },
    } as never;

    await expect(
      recordAdminChange(
        {
          guildId: GUILD,
          actorId: ACTOR,
          action: 'levels.updated',
          targetType: 'guild_config',
          description: 'Changed a setting',
        },
        exploding,
      ),
    ).resolves.toBeUndefined();
  });

  it('stores an undo the undo route would accept', async () => {
    const { admin, inserted } = makeAdmin();

    await recordAdminChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        targetType: 'guild_config',
        description: 'Changed the xp cooldown seconds setting in levels & XP',
        undo: {
          kind: 'db',
          table: 'guild_config',
          data: { xp_cooldown_seconds: 60 },
          match: { guild_id: GUILD },
        },
      },
      admin,
    );

    expect(inserted[0].is_undoable).toBe(true);
    expect(inserted[0].undo_payload).toMatchObject({ table: 'guild_config' });
  });

  it('refuses an undo for a table outside the allowlist, and says so', async () => {
    const { admin, inserted } = makeAdmin();

    await recordAdminChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'suspicious.updated',
        targetType: 'users',
        description: 'Changed something',
        undo: {
          kind: 'db',
          table: 'users',
          data: { role: 'admin' },
          match: { id: '1' },
        },
      },
      admin,
    );

    // The undo route would reject this on click; better an honest "cannot be
    // undone" than a button that errors.
    expect(inserted[0].is_undoable).toBe(false);
    expect(inserted[0].undo_payload).toBeNull();
    expect(String(inserted[0].description)).toContain('cannot be undone');
  });

  it('refuses a Discord undo whose action is not a structural inverse', async () => {
    const { admin, inserted } = makeAdmin();

    await recordAdminChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'role.created',
        targetType: 'role',
        description: 'Created a role',
        undo: { kind: 'discord', action: 'send_dm', payload: { userId: '1' } },
      },
      admin,
    );

    expect(inserted[0].is_undoable).toBe(false);
    expect(inserted[0].undo_payload).toBeNull();
  });

  it('requires confirmation only for undoable high-impact changes', async () => {
    const { admin, inserted } = makeAdmin();

    await recordAdminChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'retention.updated',
        targetType: 'guild_config',
        description: 'Changed the data retention days setting',
        blastRadius: 'high',
        undo: {
          kind: 'db',
          table: 'guild_config',
          data: { data_retention_days: 90 },
          match: { guild_id: GUILD },
        },
      },
      admin,
    );

    expect(inserted[0].requires_confirmation).toBe(true);
  });
});

describe('recordGuildConfigChange', () => {
  it('restores exactly the columns the write touched', async () => {
    const { admin, inserted } = makeAdmin();

    await recordGuildConfigChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        area: 'levels & XP',
        updates: { xp_cooldown_seconds: 90, levels_enabled: false },
        before: { xp_cooldown_seconds: 60, levels_enabled: true, unrelated: 'x' },
      },
      admin,
    );

    expect(inserted[0].is_undoable).toBe(true);
    expect(inserted[0].undo_payload).toMatchObject({
      table: 'guild_config',
      data: { xp_cooldown_seconds: 60, levels_enabled: true },
      match: { guild_id: GUILD },
    });
    // The untouched column must not be dragged into the restore.
    expect((inserted[0].undo_payload as { data: Record<string, unknown> }).data)
      .not.toHaveProperty('unrelated');
  });

  it('excludes guild_id and updated_at from the description and the restore', async () => {
    const { admin, inserted } = makeAdmin();

    await recordGuildConfigChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        area: 'levels & XP',
        // Several routes fold these bookkeeping columns into the update object.
        updates: { levels_enabled: true, guild_id: GUILD, updated_at: 'now' },
        before: { levels_enabled: false, guild_id: GUILD, updated_at: 'then' },
      },
      admin,
    );

    const undo = inserted[0].undo_payload as { data: Record<string, unknown> };
    expect(undo.data).toEqual({ levels_enabled: false });
    // guild_id inside undo data would be rejected by the allowlist (an undo
    // must never re-key a row), so its absence is load-bearing.
    expect(undo.data).not.toHaveProperty('guild_id');
    expect(String(inserted[0].description)).not.toContain('guild id');
  });

  it('records not-undoable when the prior values could not be read', async () => {
    const { admin, inserted } = makeAdmin();

    await recordGuildConfigChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        area: 'levels & XP',
        updates: { levels_enabled: true },
        before: undefined,
      },
      admin,
    );

    expect(inserted[0].is_undoable).toBe(false);
    expect(String(inserted[0].description)).toContain('nothing to restore');
  });

  it('records not-undoable when the prior read is missing one of the columns', async () => {
    const { admin, inserted } = makeAdmin();

    await recordGuildConfigChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        area: 'levels & XP',
        updates: { levels_enabled: true, xp_cooldown_seconds: 90 },
        before: { levels_enabled: false },
      },
      admin,
    );

    // A partial restore would silently leave one setting changed.
    expect(inserted[0].is_undoable).toBe(false);
  });

  it('writes nothing when there is no real setting change', async () => {
    const { admin, inserted } = makeAdmin();

    await recordGuildConfigChange(
      {
        guildId: GUILD,
        actorId: ACTOR,
        action: 'levels.updated',
        area: 'levels & XP',
        updates: { updated_at: 'now', guild_id: GUILD },
      },
      admin,
    );

    expect(inserted).toHaveLength(0);
  });
});

describe('readGuildConfigBefore', () => {
  function makeReader(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {
      maybeSingle: vi.fn(async () => result),
    };
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    return { from: vi.fn(() => chain) } as never;
  }

  it('returns the prior row', async () => {
    const admin = makeReader({ data: { levels_enabled: true }, error: null });
    await expect(readGuildConfigBefore(admin, GUILD, ['levels_enabled']))
      .resolves.toEqual({ levels_enabled: true });
  });

  it('returns undefined on a read error instead of throwing', async () => {
    const admin = makeReader({ data: null, error: { message: 'nope' } });
    await expect(readGuildConfigBefore(admin, GUILD, ['levels_enabled']))
      .resolves.toBeUndefined();
  });

  it('skips the query entirely when there are no columns', async () => {
    const admin = makeReader({ data: null, error: null });
    await expect(readGuildConfigBefore(admin, GUILD, [])).resolves.toBeUndefined();
    expect((admin as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });
});

describe('describeSettingChange', () => {
  it('reads as a sentence for one, two and many settings', () => {
    expect(describeSettingChange(['welcome_enabled']))
      .toBe('Changed the welcome enabled setting');
    expect(describeSettingChange(['welcome_enabled', 'welcome_channel_id']))
      .toBe('Changed the welcome enabled and welcome channel id settings');
    expect(describeSettingChange(['a_one', 'b_two', 'c_three']))
      .toBe('Changed 3 settings (a one, b two and c three)');
  });
});
