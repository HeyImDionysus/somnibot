/**
 * Wiring proof: the Discord-object and server-structure routes record an
 * admin change — and record an HONEST one.
 *
 * Sibling of config-routes-record-admin-changes.test.ts, and it exists for the
 * same reason: `recordAdminChange` deliberately swallows every failure, so a
 * route that never calls it leaves the Admin Changes page silently empty while
 * every other test for that route still passes.
 *
 * This group needs a second kind of proof on top of "did it call the recorder".
 * These routes mutate real Discord objects, so the interesting question is
 * whether the undo they advertise is REAL:
 *
 *   · a change that offers an undo is asserted to produce a payload the undo
 *     route's own validator accepts (validateDiscordUndo, unmocked), because a
 *     button that looks like it works and 400s on click is the actual defect;
 *   · a change that cannot be undone is asserted to carry NO undo and a
 *     specific reason, not a generic one;
 *   · the prior state is asserted to be read BEFORE the write, via the recorded
 *     call order — a "before" captured afterwards is just the "after".
 *
 * And throughout: a failed mutation must record nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/api/member-enrichment', () => ({
  enrichMembers: vi.fn().mockResolvedValue([]),
  MemberEnrichmentError: class MemberEnrichmentError extends Error {},
}));
vi.mock('@/lib/admin-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-changes')>()),
  recordAdminChange: vi.fn().mockResolvedValue(undefined),
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
  readRowBefore: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  recordAdminChange,
  recordCrudChange,
  readRowBefore,
  type RecordAdminChangeInput,
} from '@/lib/admin-changes';
import { validateDiscordUndo } from '@/lib/api/undo-allowlist';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';
const ROLE_ID = '333333333333333333';
const CHANNEL_ID = '444444444444444444';

type TableResult = { data?: unknown; error?: { message: string; code?: string } | null };

/**
 * Ordered log of every table touched and every write issued, so a test can
 * prove the "before" read happened before the mutation rather than after.
 */
let calls: string[] = [];

/**
 * A Supabase double whose chains satisfy every shape these routes use:
 * select().eq().maybeSingle(), insert().select().single(), bare-awaited
 * insert/update/upsert/delete chains, and .in()/.order()/.limit() lists.
 */
function mockClient(tables: Record<string, TableResult> = {}) {
  const from = vi.fn((table: string) => {
    calls.push(`read:${table}`);
    const resolve = () => {
      const spec = tables[table] ?? {};
      return { data: spec.data ?? null, error: spec.error ?? null };
    };
    const chain: Record<string, unknown> = {
      maybeSingle: vi.fn(async () => resolve()),
      single: vi.fn(async () => resolve()),
      then: (res: (v: unknown) => unknown) => res(resolve()),
    };
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'match']) {
      chain[m] = vi.fn(() => chain);
    }
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      chain[m] = vi.fn(() => {
        calls.push(`${m}:${table}`);
        return chain;
      });
    }
    return chain;
  });

  const client = { from, rpc: vi.fn(async () => ({ data: null, error: null })) };
  vi.mocked(createAdminSupabase).mockReturnValue(client as never);
  return client;
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stub `readRowBefore` so its call lands in the SAME ordered log as the writes.
 * Without this the module mock is invisible to `calls` and "read before write"
 * could only be asserted vacuously.
 */
function stubRowBefore(value: Record<string, unknown> | undefined) {
  vi.mocked(readRowBefore).mockImplementation(async () => {
    calls.push('readRowBefore');
    return value;
  });
}

/** The single recorded change, failing loudly if there wasn't exactly one. */
function onlyChange(): RecordAdminChangeInput {
  expect(recordAdminChange).toHaveBeenCalledTimes(1);
  return vi.mocked(recordAdminChange).mock.calls[0]![0];
}

/**
 * Assert the change is honestly NOT undoable: no payload, and a reason that
 * actually explains this change rather than a stock phrase.
 */
function expectNotUndoable(change: RecordAdminChangeInput, mentions: RegExp) {
  expect(change.undo).toBeUndefined();
  expect(change.undoReason).toBeDefined();
  expect(change.undoReason).toMatch(mentions);
}

/**
 * Assert the change offers an undo the undo ROUTE would actually accept —
 * validated with the same function the route runs on click.
 */
function expectRealDiscordUndo(change: RecordAdminChangeInput) {
  expect(change.undoReason).toBeUndefined();
  expect(change.undo).toBeDefined();
  expect(validateDiscordUndo(change.undo)).toMatchObject({ ok: true });
  return change.undo as { kind: string; action: string; payload: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: ACTOR, guildId: GUILD },
  } as never);
  vi.mocked(readRowBefore).mockResolvedValue(undefined);
  mockClient();
});

// ── /api/roles ──────────────────────────────────────────────

describe('/api/roles', () => {
  const LIVE_ROLE = {
    id: ROLE_ID,
    name: 'Moderator',
    color: 255,
    hoist: false,
    mentionable: false,
    permissions: '8',
  };

  it('POST records the queued creation and refuses to promise an undo', async () => {
    mockClient({ bot_action_queue: { data: { id: 'act-1' } } });
    const { POST } = await import('@/app/api/roles/route');

    const res = await POST(req('http://x/api/roles', 'POST', { name: 'Helper', tier: 'staff' }));
    expect(res.status).toBe(202);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'roles.create_queued',
      targetType: 'role',
      blastRadius: 'medium',
    });
    expect(change.description).toBe('Queued creation of the "Helper" role in the staff tier');
    // The role has no id yet, so delete_role has nothing to aim at.
    expectNotUndoable(change, /has not been created yet/);
  });

  it('POST records nothing when the queue insert fails', async () => {
    mockClient({ bot_action_queue: { error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/roles/route');

    const res = await POST(req('http://x/api/roles', 'POST', { name: 'Helper', tier: 'staff' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PATCH offers a replayable update_role undo built from the prior values', async () => {
    mockClient({
      guild_live_state: { data: { roles: [LIVE_ROLE] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { PATCH } = await import('@/app/api/roles/route');

    const res = await PATCH(
      req('http://x/api/roles', 'PATCH', { roleId: ROLE_ID, name: 'Senior Mod', color: 16711680 }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'roles.update_queued',
      targetId: ROLE_ID,
    });
    expect(change.description).toBe('Queued an update to the "Moderator" role (name, color)');

    const undo = expectRealDiscordUndo(change);
    // Restores what it WAS, not what it became.
    expect(undo).toMatchObject({
      kind: 'discord',
      action: 'update_role',
      payload: { roleId: ROLE_ID, name: 'Moderator', color: 255 },
    });

    // The snapshot must be read before the queue row is written.
    expect(calls.indexOf('read:guild_live_state')).toBeLessThan(
      calls.indexOf('insert:bot_action_queue'),
    );
  });

  it('PATCH declines an undo when the change also rewrites the server template', async () => {
    mockClient({
      guild_live_state: { data: { roles: [LIVE_ROLE] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { PATCH } = await import('@/app/api/roles/route');

    const res = await PATCH(
      req('http://x/api/roles', 'PATCH', {
        roleId: ROLE_ID,
        name: 'Senior Mod',
        templateKey: 'staff-mod',
      }),
    );
    expect(res.status).toBe(200);

    // A queued Discord undo cannot carry templateKey, so guild_desired_state
    // would keep the new values and sync would drag the role back.
    expectNotUndoable(onlyChange(), /template/);
  });

  it('PATCH declines an undo when the bot has published no snapshot', async () => {
    mockClient({
      guild_live_state: { data: null },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { PATCH } = await import('@/app/api/roles/route');

    await PATCH(req('http://x/api/roles', 'PATCH', { roleId: ROLE_ID, name: 'Senior Mod' }));

    expectNotUndoable(onlyChange(), /snapshot/);
  });

  it('DELETE keeps the role in before_state and never offers to re-create it', async () => {
    mockClient({
      guild_live_state: { data: { roles: [LIVE_ROLE] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { DELETE } = await import('@/app/api/roles/route');

    const res = await DELETE(req('http://x/api/roles', 'DELETE', { roleId: ROLE_ID }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'roles.delete_queued',
      targetId: ROLE_ID,
      blastRadius: 'high',
    });
    expect(change.description).toBe('Queued deletion of the "Moderator" role');
    // Deleting is the only record left of what the role was.
    expect(change.before).toMatchObject({ name: 'Moderator' });
    // create_role IS an allowlisted undo action — using it would mint a NEW id.
    expectNotUndoable(change, /nobody holds|every member/);
  });
});

// ── /api/channels ───────────────────────────────────────────

describe('/api/channels', () => {
  const LIVE_CHANNEL = {
    id: CHANNEL_ID,
    name: 'general',
    topic: 'Chat here',
    nsfw: false,
    slowmode: 0,
    parentId: null,
  };

  it('POST records the queued creation without a fictional undo', async () => {
    mockClient({ bot_action_queue: { data: { id: 'act-1' } } });
    const { POST } = await import('@/app/api/channels/route');

    const res = await POST(req('http://x/api/channels', 'POST', { name: 'support' }));
    expect(res.status).toBe(202);

    const change = onlyChange();
    expect(change).toMatchObject({ action: 'channels.create_queued', blastRadius: 'low' });
    expect(change.description).toBe('Queued creation of the #support channel');
    expectNotUndoable(change, /has not been created yet/);
  });

  it('POST records nothing when the queue insert fails', async () => {
    mockClient({ bot_action_queue: { error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/channels/route');

    const res = await POST(req('http://x/api/channels', 'POST', { name: 'support' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('PATCH offers a replayable update_channel undo built from the prior values', async () => {
    mockClient({
      guild_live_state: { data: { channels: [LIVE_CHANNEL], categories: [] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { PATCH } = await import('@/app/api/channels/route');

    const res = await PATCH(
      req('http://x/api/channels', 'PATCH', {
        channelId: CHANNEL_ID,
        name: 'general-chat',
        slowmode: 30,
      }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change.description).toBe('Queued an update to the #general channel (name, slowmode)');

    const undo = expectRealDiscordUndo(change);
    expect(undo).toMatchObject({
      kind: 'discord',
      action: 'update_channel',
      payload: { channelId: CHANNEL_ID, name: 'general', slowmode: 0 },
    });

    expect(calls.indexOf('read:guild_live_state')).toBeLessThan(
      calls.indexOf('insert:bot_action_queue'),
    );
  });

  it('DELETE of a channel is high blast radius and not undoable', async () => {
    mockClient({
      guild_live_state: { data: { channels: [LIVE_CHANNEL], categories: [] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { DELETE } = await import('@/app/api/channels/route');

    const res = await DELETE(
      req('http://x/api/channels', 'DELETE', { channelId: CHANNEL_ID }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'channels.delete_queued',
      targetId: CHANNEL_ID,
      blastRadius: 'high',
    });
    expect(change.description).toBe('Queued deletion of the #general channel');
    expectNotUndoable(change, /messages/);
  });

  it('DELETE of a category records the category verb', async () => {
    mockClient({
      guild_live_state: { data: { channels: [], categories: [{ id: CHANNEL_ID, name: 'STAFF' }] } },
      bot_action_queue: { data: { id: 'act-1' } },
    });
    const { DELETE } = await import('@/app/api/channels/route');

    await DELETE(
      req('http://x/api/channels', 'DELETE', { categoryId: CHANNEL_ID, isCategory: true }),
    );

    const change = onlyChange();
    expect(change).toMatchObject({ action: 'channels.category_delete_queued' });
    expect(change.description).toBe('Queued deletion of the "STAFF" category');
  });
});

// ── /api/members/bulk ───────────────────────────────────────

describe('/api/members/bulk', () => {
  const MEMBERS = ['555555555555555555', '666666666666666666'];

  it('records a bulk role change as high blast radius with no bulk reversal', async () => {
    mockClient();
    const { POST } = await import('@/app/api/members/bulk/route');

    const res = await POST(
      req('http://x/api/members/bulk', 'POST', {
        member_ids: MEMBERS,
        action: 'assign_role',
        params: { role_id: ROLE_ID },
      }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'members.bulk_assign_role',
      targetType: 'members',
      targetId: 'bulk:2',
      blastRadius: 'high',
    });
    expect(change.description).toBe(`Queued adding the role ${ROLE_ID} to 2 members`);
    expectNotUndoable(change, /separate role change|Members page/);
  });

  it('records an economy reset as critical and permanently gone', async () => {
    mockClient();
    const { POST } = await import('@/app/api/members/bulk/route');

    const res = await POST(
      req('http://x/api/members/bulk', 'POST', {
        member_ids: MEMBERS,
        action: 'reset_economy',
      }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      action: 'members.bulk_reset_economy',
      blastRadius: 'critical',
    });
    expect(change.description).toBe('Reset the economy balances of 2 members');
    expectNotUndoable(change, /nothing left to restore|no copy/);
  });

  it('records a bulk DM that cannot be recalled', async () => {
    mockClient();
    const { POST } = await import('@/app/api/members/bulk/route');

    await POST(
      req('http://x/api/members/bulk', 'POST', {
        member_ids: MEMBERS,
        action: 'send_dm',
        params: { message: 'Server maintenance tonight' },
      }),
    );

    const change = onlyChange();
    expect(change).toMatchObject({ action: 'members.bulk_send_dm', blastRadius: 'high' });
    expect(change.description).toBe('Queued a direct message to 2 members');
    expectNotUndoable(change, /recalled/);
  });

  it('does not record an export — nothing in the server changed', async () => {
    mockClient({ members: { data: [] } });
    const { POST } = await import('@/app/api/members/bulk/route');

    const res = await POST(
      req('http://x/api/members/bulk', 'POST', { member_ids: MEMBERS, action: 'export' }),
    );
    expect(res.status).toBe(200);

    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('records nothing when the bulk queue insert fails', async () => {
    mockClient({ bot_action_queue: { error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/members/bulk/route');

    const res = await POST(
      req('http://x/api/members/bulk', 'POST', {
        member_ids: MEMBERS,
        action: 'assign_role',
        params: { role_id: ROLE_ID },
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── /api/server-setup ───────────────────────────────────────

describe('POST /api/server-setup', () => {
  it('records the confirmation, reading the prior flags first', async () => {
    mockClient({ guild_desired_state: { data: { applied_at: '2026-01-01T00:00:00Z' } } });
    stubRowBefore({ setup_completed: false, setup_confirmed_at: null });
    const { POST } = await import('@/app/api/server-setup/route');

    const res = await POST(req('http://x/api/server-setup', 'POST', { action: 'confirm' }));
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'server_setup.confirmed',
      targetType: 'guild',
      targetId: GUILD,
      blastRadius: 'high',
    });
    expect(change.before).toMatchObject({ setup_completed: false });
    expect(change.after).toMatchObject({ setup_completed: true });
    // `guild` is not on the undo allowlist and there is no un-confirm path.
    expectNotUndoable(change, /one-way/);

    expect(readRowBefore).toHaveBeenCalledWith(
      expect.anything(),
      'guild',
      { id: GUILD },
      expect.stringContaining('setup_completed'),
    );
    // Read the flags AFTER the update and "before" would just be "after".
    expect(calls).toContain('readRowBefore');
    expect(calls).toContain('update:guild');
    expect(calls.indexOf('readRowBefore')).toBeLessThan(calls.indexOf('update:guild'));
  });

  it('records nothing when the guild update fails', async () => {
    mockClient({
      guild_desired_state: { data: { applied_at: '2026-01-01T00:00:00Z' } },
      guild: { error: { message: 'boom' } },
    });
    const { POST } = await import('@/app/api/server-setup/route');

    const res = await POST(req('http://x/api/server-setup', 'POST', { action: 'confirm' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('records nothing when deployment has not happened yet', async () => {
    mockClient({ guild_desired_state: { data: { applied_at: null } } });
    const { POST } = await import('@/app/api/server-setup/route');

    const res = await POST(req('http://x/api/server-setup', 'POST', { action: 'confirm' }));

    expect(res.status).toBe(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── /api/embeds/send ────────────────────────────────────────

describe('POST /api/embeds/send', () => {
  const EMBED_ID = '9f1d9d1e-0e1a-4a2a-9d3e-2a5d7b6c1f00';

  it('records a real posted message, named, and not undoable', async () => {
    mockClient({ embed_configs: { data: { id: EMBED_ID, name: 'Server Rules' } } });
    const { POST } = await import('@/app/api/embeds/send/route');

    const res = await POST(
      req('http://x/api/embeds/send', 'POST', { embed_id: EMBED_ID, channel_id: CHANNEL_ID }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'embeds.sent',
      targetType: 'embed',
      targetId: EMBED_ID,
      blastRadius: 'medium',
    });
    expect(change.description).toBe(`Sent the "Server Rules" embed to channel ${CHANNEL_ID}`);
    expectNotUndoable(change, /unsent/);
  });

  it('records nothing when the embed does not belong to this guild', async () => {
    mockClient({ embed_configs: { data: null } });
    const { POST } = await import('@/app/api/embeds/send/route');

    const res = await POST(
      req('http://x/api/embeds/send', 'POST', { embed_id: EMBED_ID, channel_id: CHANNEL_ID }),
    );

    expect(res.status).toBe(404);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('records nothing when the send could not be queued', async () => {
    mockClient({
      embed_configs: { data: { id: EMBED_ID, name: 'Server Rules' } },
      bot_action_queue: { error: { message: 'boom' } },
    });
    const { POST } = await import('@/app/api/embeds/send/route');

    const res = await POST(
      req('http://x/api/embeds/send', 'POST', { embed_id: EMBED_ID, channel_id: CHANNEL_ID }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── /api/welcome/test ───────────────────────────────────────

describe('POST /api/welcome/test', () => {
  it('records the test message because the bot really posts it', async () => {
    mockClient();
    const { POST } = await import('@/app/api/welcome/test/route');

    const res = await POST(
      req('http://x/api/welcome/test', 'POST', { channel_id: CHANNEL_ID, type: 'goodbye' }),
    );
    expect(res.status).toBe(200);

    const change = onlyChange();
    expect(change).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'welcome.test_message_sent',
      targetType: 'channel',
      targetId: CHANNEL_ID,
      blastRadius: 'low',
    });
    expect(change.description).toBe(`Sent a test goodbye message to channel ${CHANNEL_ID}`);
    expectNotUndoable(change, /unsent/);
  });

  it('records nothing when the test could not be queued', async () => {
    mockClient({ bot_action_queue: { error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/welcome/test/route');

    const res = await POST(
      req('http://x/api/welcome/test', 'POST', { channel_id: CHANNEL_ID }),
    );

    expect(res.status).toBe(500);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── /api/tutorial ───────────────────────────────────────────

describe('PUT /api/tutorial', () => {
  const BODY = {
    config: { enabled: true, auto_trigger: true, trigger_mode: 'on_join' },
    steps: [
      { step_order: 0, title: 'Say hi', description: 'Introduce yourself', enabled: true },
    ],
  };

  it('records the config change (undoable) and the step replacement (not) separately', async () => {
    mockClient({ tutorial_steps: { data: [{ id: 'old-1', title: 'Old step' }] } });
    stubRowBefore({ enabled: false, auto_trigger: false, trigger_mode: 'first_command' });
    const { PUT } = await import('@/app/api/tutorial/route');

    const res = await PUT(req('http://x/api/tutorial', 'PUT', BODY));
    expect(res.status).toBe(200);

    // 1. The config half — a real restore of the prior values.
    expect(recordCrudChange).toHaveBeenCalledTimes(1);
    const config = vi.mocked(recordCrudChange).mock.calls[0]![0];
    expect(config).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      operation: 'updated',
      action: 'tutorial.config_updated',
      table: 'tutorial_configs',
      match: { guild_id: GUILD },
      blastRadius: 'medium',
    });
    expect(config.before).toMatchObject({ enabled: false, trigger_mode: 'first_command' });
    expect(config.after).toMatchObject({ enabled: true, trigger_mode: 'on_join' });

    // 2. The steps half — deleted rows cannot be restored by a row update.
    const steps = onlyChange();
    expect(steps).toMatchObject({
      action: 'tutorial.steps_replaced',
      targetType: 'tutorial steps',
      targetId: GUILD,
    });
    expect(steps.description).toBe('Replaced the tutorial steps (1 before, 1 now)');
    expect(steps.before).toMatchObject([{ title: 'Old step' }]);
    expectNotUndoable(steps, /deleted/);

    // Both prior reads must precede the first write — the steps read
    // especially, since the delete that follows destroys what it captured.
    const firstWrite = calls.findIndex((c) => c.startsWith('upsert:') || c.startsWith('delete:'));
    expect(firstWrite).toBeGreaterThan(-1);
    expect(calls.indexOf('read:tutorial_steps')).toBeGreaterThan(-1);
    expect(calls.indexOf('read:tutorial_steps')).toBeLessThan(firstWrite);
    expect(calls.indexOf('readRowBefore')).toBeGreaterThan(-1);
    expect(calls.indexOf('readRowBefore')).toBeLessThan(firstWrite);
  });

  it('records nothing when the config upsert fails', async () => {
    mockClient({ tutorial_configs: { error: { message: 'boom' } } });
    const { PUT } = await import('@/app/api/tutorial/route');

    const res = await PUT(req('http://x/api/tutorial', 'PUT', BODY));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordCrudChange).not.toHaveBeenCalled();
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('still records the committed config change when only the steps insert fails', async () => {
    // The config upsert already landed, so staying silent about it would
    // recreate exactly the blind spot this work removes.
    mockClient({ tutorial_steps: { error: { message: 'boom' } } });
    const { PUT } = await import('@/app/api/tutorial/route');

    const res = await PUT(req('http://x/api/tutorial', 'PUT', BODY));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordCrudChange).toHaveBeenCalledTimes(1);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});
