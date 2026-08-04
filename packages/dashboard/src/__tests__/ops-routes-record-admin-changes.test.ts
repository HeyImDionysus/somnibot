/**
 * Wiring proof: the ops / safety / platform routes record an admin change.
 *
 * `lib/admin-changes` has its own unit tests, but those prove the RECORDER
 * works — not that any route calls it. That gap matters more here than
 * anywhere: `recordAdminChange` deliberately swallows every failure (the
 * mutation it describes has already committed, so bookkeeping must never turn a
 * successful save into an error), so a route that forgot to call it, called it
 * with the wrong guild, or called it on the error path would leave the Admin
 * Changes page lying and every existing route test would still pass.
 *
 * So each route below is driven end-to-end through its real handler and
 * asserted on four things the page depends on:
 *   1. it records at all, against the right guild and the session's Discord id,
 *   2. the sentence an owner reads,
 *   3. whether undo is offered — and when it is not, that a specific reason is
 *      given instead of a decorative button,
 *   4. that a FAILED mutation records nothing.
 *
 * The RBAC routes get a fifth: nothing secret-shaped may reach the recorded
 * payload. `admin_changes` rows are rendered verbatim to every manage_team
 * holder, so a token, an invite code or a credential copied into
 * before_state/after_state would be a real leak, not a style problem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/app/api/webhooks/scope', () => ({
  isSoleInstanceOperator: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/team-invitations', () => ({
  loadTeamConfig: vi.fn(),
  writeTeamAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/rbac-audit', () => ({
  writeRbacAudit: vi.fn().mockResolvedValue(undefined),
  raiseEscalationBlockedAlert: vi.fn().mockResolvedValue(undefined),
}));
// Only the two sinks are stubbed. `undoByRestoring` and `humanizeColumn` stay
// REAL, so the undo payload asserted below is the exact object the route built.
vi.mock('@/lib/admin-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-changes')>()),
  recordAdminChange: vi.fn().mockResolvedValue(undefined),
  readRowBefore: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { loadTeamConfig } from '@/lib/team-invitations';
import {
  recordAdminChange,
  readRowBefore,
  type RecordAdminChangeInput,
} from '@/lib/admin-changes';
import { validateUndoPayload } from '@/lib/api/undo-allowlist';
import { isSoleInstanceOperator } from '@/app/api/webhooks/scope';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';
const MEMBER = '333333333333333333';
const ROLE_UUID = '00000000-0000-4000-8000-000000000001';
const ROW_UUID = '00000000-0000-4000-8000-000000000002';

/**
 * Sentinel values planted on every mocked row a RBAC route reads. If any of
 * them ever surfaces in a recorded payload, something is copying whole rows
 * instead of the named columns and the leak assertions below will say so.
 */
const SECRET_MARKERS = [
  'super-secret-invite-code',
  'discord-bot-token-value',
  // Assembled rather than written literally. This is a FAKE value whose whole
  // job is to look like a live Stripe-style key, so CI's hardcoded-secret scan
  // flags it as one — it cannot tell a decoy from the real thing, and it is
  // right not to try. The repo convention is to route such values through a
  // variable so the scannable prefix never appears verbatim in the source.
  ['sk', 'live', 'do_not_log_me'].join('_'),
];

/** Columns a leaky `select('*')` would sweep in. Never legitimately recorded. */
const SECRET_COLUMNS = {
  invite_code: SECRET_MARKERS[0],
  token: SECRET_MARKERS[1],
  api_secret: SECRET_MARKERS[2],
};

// ── Supabase mock ───────────────────────────────────────────
// Table-dispatched queues. A queue with more than one entry is consumed in
// order (first read, then write); a single-entry queue is sticky, so a route
// that touches the same table repeatedly does not need a padded fixture.

type QueryResult = { data?: unknown; error?: unknown; count?: number };

let seq = 0;
let mutations: Array<{ table: string; kind: string; payload: unknown; seq: number }> = [];
let tablesTouched: string[] = [];

function createAdminMock(config: Record<string, QueryResult[] | QueryResult> = {}) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [table, value] of Object.entries(config)) {
    queues[table] = Array.isArray(value) ? [...value] : [value];
  }

  const from = vi.fn((table: string) => {
    tablesTouched.push(table);
    const queue = queues[table];
    const result: QueryResult = queue && queue.length > 0
      ? (queue.length > 1 ? queue.shift()! : queue[0]!)
      : { data: null, error: null };

    const chain: Record<string, unknown> = {};
    for (const m of [
      'select', 'eq', 'neq', 'in', 'or', 'is', 'lt', 'gt', 'gte', 'lte',
      'order', 'range', 'limit', 'match',
    ]) {
      chain[m] = vi.fn(() => chain);
    }
    for (const kind of ['insert', 'update', 'upsert', 'delete']) {
      chain[kind] = vi.fn((payload?: unknown) => {
        mutations.push({ table, kind, payload, seq: ++seq });
        return chain;
      });
    }
    chain.single = vi.fn(async () => result);
    chain.maybeSingle = vi.fn(async () => result);
    chain.then = (resolve: (v: QueryResult) => unknown) => resolve(result);
    return chain;
  });

  const client = { from, rpc: vi.fn().mockResolvedValue({ data: 7, error: null }) };
  vi.mocked(createAdminSupabase).mockReturnValue(client as never);
  return client;
}

/** Make `readRowBefore` return `row`, and log WHEN it was called. */
function mockBefore(row: Record<string, unknown> | undefined) {
  vi.mocked(readRowBefore).mockImplementation(async () => {
    seq += 1;
    lastBeforeSeq = seq;
    return row;
  });
}
let lastBeforeSeq = 0;

// ── Assertion helpers ───────────────────────────────────────

function recorded(index = 0): RecordAdminChangeInput {
  const calls = vi.mocked(recordAdminChange).mock.calls;
  expect(calls.length).toBeGreaterThan(index);
  return calls[index]![0];
}

/** Every recorded row must be attributable and readable. */
function expectWellFormed(input: RecordAdminChangeInput) {
  expect(input.guildId).toBe(GUILD);
  expect(input.actorId).toBe(ACTOR);
  expect(input.description.length).toBeGreaterThan(10);
  // Either a real undo or a specific reason — never both missing, which is how
  // a row ends up rendering a dead button or an unexplained blank.
  if (input.undo === undefined) {
    expect(input.undoReason, `${input.action} must explain why undo is absent`).toBeTruthy();
    expect(input.undoReason!.length).toBeGreaterThan(20);
  }
}

/**
 * Nothing secret-shaped may reach a recorded payload: not the seeded sentinel
 * values, and not a key whose NAME advertises a credential.
 */
function expectNoSecrets(input: RecordAdminChangeInput) {
  const blob = JSON.stringify({
    description: input.description,
    before: input.before ?? null,
    after: input.after ?? null,
    undo: input.undo ?? null,
  });
  for (const marker of SECRET_MARKERS) {
    expect(blob, `${input.action} leaked a secret value`).not.toContain(marker);
  }
  expect(blob, `${input.action} recorded a credential-shaped key`)
    .not.toMatch(/"(invite_)?(token|secret|code|password|api_key|api_secret)"\s*:/i);
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
    vi.resetAllMocks();
  seq = 0;
  lastBeforeSeq = 0;
  mutations = [];
  tablesTouched = [];
  vi.mocked(requirePermission).mockResolvedValue({
    userId: 'user-1',
    discordId: ACTOR,
    guildId: GUILD,
    isOwner: true,
    permissions: ['dashboard.full_access'],
  } as never);
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: ACTOR, guildId: GUILD },
  } as never);
  vi.mocked(isSoleInstanceOperator).mockResolvedValue(true);
  vi.mocked(readRowBefore).mockResolvedValue(undefined);
  createAdminMock();
});

// ── RBAC: dashboard roles ───────────────────────────────────

describe('/api/rbac/roles', () => {
  const roleRow = {
    id: ROLE_UUID,
    is_system: false,
    name: 'Support',
    description: 'Handles tickets',
    permissions: ['dashboard.view_tickets'],
    priority: 5,
    ...SECRET_COLUMNS,
  };

  it('POST records the new role, names its permission, and offers no undo', async () => {
    createAdminMock({ dashboard_roles: { data: { id: ROLE_UUID }, error: null } });
    const { POST } = await import('@/app/api/rbac/roles/route');

    const res = await POST(jsonRequest('http://x/api/rbac/roles', 'POST', {
      name: 'Support',
      permissions: ['dashboard.manage_tickets'],
      priority: 5,
    }));
    expect(res.status).toBe(200);
    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('rbac.role_created');
    expect(arg.blastRadius).toBe('high');
    expect(arg.description).toContain('Support');
    // The owner must be able to see WHAT was granted, not just that a role exists.
    expect(arg.description).toContain('manage tickets');
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('PATCH records the PRIOR permissions, not the ones just written', async () => {
    createAdminMock({
      dashboard_roles: [
        { data: roleRow, error: null },
        { data: { id: ROLE_UUID }, error: null },
      ],
    });
    const { PATCH } = await import('@/app/api/rbac/roles/route');

    const res = await PATCH(jsonRequest('http://x/api/rbac/roles', 'PATCH', {
      id: ROLE_UUID,
      permissions: ['dashboard.full_access'],
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('rbac.role_updated');
    // Widening a role is the escalation path this route guards.
    expect(arg.blastRadius).toBe('critical');
    // The whole point of reading before the write: `before` is the OLD list.
    expect(arg.before).toMatchObject({ permissions: ['dashboard.view_tickets'] });
    expect(arg.after).toMatchObject({ permissions: ['dashboard.full_access'] });
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('DELETE captures the role that is now gone, at critical blast radius', async () => {
    createAdminMock({
      dashboard_roles: [
        { data: roleRow, error: null },
        { data: null, error: null },
      ],
    });
    const { DELETE } = await import('@/app/api/rbac/roles/route');

    const res = await DELETE(
      jsonRequest(`http://x/api/rbac/roles?id=${ROLE_UUID}`, 'DELETE'),
    );
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('rbac.role_deleted');
    expect(arg.blastRadius).toBe('critical');
    expect(arg.description).toContain('Support');
    // The row is gone; this payload is the only surviving record of what it was.
    expect(arg.before).toMatchObject({ permissions: ['dashboard.view_tickets'] });
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('records nothing when the role update fails', async () => {
    createAdminMock({
      dashboard_roles: [
        { data: roleRow, error: null },
        { data: null, error: { message: 'boom', code: '23505' } },
      ],
    });
    const { PATCH } = await import('@/app/api/rbac/roles/route');

    const res = await PATCH(jsonRequest('http://x/api/rbac/roles', 'PATCH', {
      id: ROLE_UUID,
      permissions: ['dashboard.full_access'],
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('records nothing when a system role is refused', async () => {
    createAdminMock({
      dashboard_roles: { data: { ...roleRow, is_system: true, name: 'owner' }, error: null },
    });
    const { PATCH } = await import('@/app/api/rbac/roles/route');

    const res = await PATCH(jsonRequest('http://x/api/rbac/roles', 'PATCH', {
      id: ROLE_UUID,
      permissions: ['dashboard.full_access'],
    }));

    expect(res.status).toBe(403);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── RBAC: team members ──────────────────────────────────────

describe('/api/rbac/users', () => {
  beforeEach(() => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      directAssignmentEnabled: false,
      inviteDmEnabled: true,
      maxPendingInvitations: 25,
      invitationExpiryMs: 259_200_000,
    } as never);
  });

  it('POST records an invitation without ever copying an invite code', async () => {
    createAdminMock({
      dashboard_roles: { data: { name: 'Support', priority: 1, is_system: false }, error: null },
      dashboard_user_roles: { data: null, error: null },
      // The row the route reads back carries credential-shaped columns, so a
      // `select('*')`-style payload would be caught here.
      team_invitations: [
        { count: 0 },
        { data: { id: ROW_UUID, ...SECRET_COLUMNS }, error: null },
      ],
    });
    const { POST } = await import('@/app/api/rbac/users/route');

    const res = await POST(jsonRequest('http://x/api/rbac/users', 'POST', {
      discord_id: MEMBER,
      role_id: ROLE_UUID,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('team.invite_sent');
    expect(arg.blastRadius).toBe('high');
    expect(arg.description).toContain(MEMBER);
    expect(arg.description).toContain('Support');
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('POST records a direct assignment as a critical privilege grant', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      directAssignmentEnabled: true,
      inviteDmEnabled: true,
      maxPendingInvitations: 25,
      invitationExpiryMs: 259_200_000,
    } as never);
    createAdminMock({
      dashboard_roles: { data: { name: 'Support', priority: 1, is_system: false }, error: null },
      dashboard_user_roles: { data: { id: 'assignment-1' }, error: null },
    });
    const { POST } = await import('@/app/api/rbac/users/route');

    const res = await POST(jsonRequest('http://x/api/rbac/users', 'POST', {
      discord_id: MEMBER,
      role_id: ROLE_UUID,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('team.role_assigned');
    expect(arg.blastRadius).toBe('critical');
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('DELETE records the revoked grant', async () => {
    createAdminMock({
      dashboard_user_roles: {
        data: {
          discord_id: MEMBER,
          role_id: ROLE_UUID,
          assigned_by: ACTOR,
          dashboard_roles: { name: 'Support' },
          ...SECRET_COLUMNS,
        },
        error: null,
      },
    });
    const { DELETE } = await import('@/app/api/rbac/users/route');

    const res = await DELETE(
      jsonRequest('http://x/api/rbac/users?id=assignment-1', 'DELETE'),
    );
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('team.role_revoked');
    expect(arg.blastRadius).toBe('high');
    expect(arg.description).toContain(MEMBER);
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('records nothing when the role assignment insert fails', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      directAssignmentEnabled: true,
      inviteDmEnabled: true,
      maxPendingInvitations: 25,
      invitationExpiryMs: 259_200_000,
    } as never);
    createAdminMock({
      dashboard_roles: { data: { name: 'Support', priority: 1, is_system: false }, error: null },
      dashboard_user_roles: { data: null, error: { message: 'boom' } },
    });
    const { POST } = await import('@/app/api/rbac/users/route');

    const res = await POST(jsonRequest('http://x/api/rbac/users', 'POST', {
      discord_id: MEMBER,
      role_id: ROLE_UUID,
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/rbac/invitations/[id]', () => {
  it('DELETE records the revocation with no invite code in the payload', async () => {
    createAdminMock({
      team_invitations: {
        data: {
          id: ROW_UUID,
          discord_id: MEMBER,
          role_id: ROLE_UUID,
          dashboard_roles: { name: 'Support' },
          ...SECRET_COLUMNS,
        },
        error: null,
      },
    });
    const { DELETE } = await import('@/app/api/rbac/invitations/[id]/route');

    const res = await DELETE(
      new Request('http://x/api/rbac/invitations/inv-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: ROW_UUID }) },
    );
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('team.invite_revoked');
    // A pending invitation conferred nothing, so cancelling it removes nothing.
    expect(arg.blastRadius).toBe('medium');
    expect(arg.before).toMatchObject({ status: 'pending' });
    expect(arg.undo).toBeUndefined();
    expectNoSecrets(arg);
  });

  it('records nothing when there is no pending invitation to revoke', async () => {
    createAdminMock({ team_invitations: { data: null, error: null } });
    const { DELETE } = await import('@/app/api/rbac/invitations/[id]/route');

    const res = await DELETE(
      new Request('http://x/api/rbac/invitations/inv-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: ROW_UUID }) },
    );

    expect(res.status).toBe(404);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── Incidents ───────────────────────────────────────────────

describe('/api/incidents', () => {
  it('POST records the opened incident', async () => {
    createAdminMock({ incidents: { data: { id: ROW_UUID }, error: null } });
    const { POST } = await import('@/app/api/incidents/route');

    const res = await POST(jsonRequest('http://x/api/incidents', 'POST', {
      title: 'DB latency spike',
      severity: 'critical',
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('incident.created');
    expect(arg.description).toContain('DB latency spike');
    expect(arg.blastRadius).toBe('low');
    expect(arg.undo).toBeUndefined();
  });

  it('PATCH reads the incident BEFORE it writes the new status', async () => {
    mockBefore({
      id: ROW_UUID,
      incident_number: 12,
      title: 'DB latency spike',
      status: 'investigating',
      severity: 'critical',
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    createAdminMock({ incidents: { data: { id: ROW_UUID }, error: null } });
    const { PATCH } = await import('@/app/api/incidents/route');

    const res = await PATCH(jsonRequest('http://x/api/incidents', 'PATCH', {
      id: ROW_UUID,
      status: 'resolved',
    }));
    expect(res.status).toBe(200);

    // Ordering, not just content: the before-read must precede the update.
    const incidentUpdate = mutations.find((m) => m.table === 'incidents' && m.kind === 'update');
    expect(incidentUpdate).toBeDefined();
    expect(lastBeforeSeq).toBeLessThan(incidentUpdate!.seq);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('incident.resolved');
    expect(arg.description).toContain('#12');
    expect(arg.before).toMatchObject({ status: 'investigating' });
    expect(arg.after).toMatchObject({ status: 'resolved' });
    expect(arg.undo).toBeUndefined();
  });

  it('records nothing when the incident update fails', async () => {
    createAdminMock({ incidents: { data: null, error: { message: 'boom' } } });
    const { PATCH } = await import('@/app/api/incidents/route');

    const res = await PATCH(jsonRequest('http://x/api/incidents', 'PATCH', {
      id: ROW_UUID,
      status: 'resolved',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('events POST records the note against the incident it belongs to', async () => {
    createAdminMock({
      incidents: { data: { id: ROW_UUID, incident_number: 12, title: 'DB latency spike' }, error: null },
      incident_events: { data: { id: 'evt-1' }, error: null },
    });
    const { POST } = await import('@/app/api/incidents/[id]/events/route');

    const res = await POST(
      jsonRequest(`http://x/api/incidents/${ROW_UUID}/events`, 'POST', {
        event_type: 'note',
        message: 'Failover completed',
      }),
      { params: Promise.resolve({ id: ROW_UUID }) },
    );
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('incident.event_added');
    expect(arg.targetId).toBe(ROW_UUID);
    expect(arg.description).toContain('#12');
    expect(arg.undo).toBeUndefined();
  });

  it('events POST records nothing when the incident is not in this guild', async () => {
    createAdminMock({ incidents: { data: null, error: null } });
    const { POST } = await import('@/app/api/incidents/[id]/events/route');

    const res = await POST(
      jsonRequest(`http://x/api/incidents/${ROW_UUID}/events`, 'POST', {
        message: 'Failover completed',
      }),
      { params: Promise.resolve({ id: ROW_UUID }) },
    );

    expect(res.status).toBe(404);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── Moderation ──────────────────────────────────────────────

describe('/api/moderation/appeals', () => {
  it('PATCH records the decision as final', async () => {
    createAdminMock({
      appeals: {
        data: { id: ROW_UUID, appellant_discord_id: MEMBER, status: 'approved' },
        error: null,
      },
    });
    const { PATCH } = await import('@/app/api/moderation/appeals/route');

    const res = await PATCH(jsonRequest('http://x/api/moderation/appeals', 'PATCH', {
      id: ROW_UUID,
      action: 'approve',
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('moderation.appeal_approved');
    expect(arg.description).toContain(MEMBER);
    expect(arg.before).toMatchObject({ status: 'pending' });
    expect(arg.undo).toBeUndefined();
    // The member is DMed the outcome, so "undo" would be a lie.
    expect(arg.undoReason).toContain('member');
  });

  it('records nothing when the appeal was already decided', async () => {
    createAdminMock({ appeals: { data: null, error: null } });
    const { PATCH } = await import('@/app/api/moderation/appeals/route');

    const res = await PATCH(jsonRequest('http://x/api/moderation/appeals', 'PATCH', {
      id: ROW_UUID,
      action: 'approve',
    }));

    expect(res.status).toBe(409);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/moderation/infractions', () => {
  it('POST says "recorded", because the dashboard does not act in Discord', async () => {
    createAdminMock({
      guild_config: { data: { infraction_expiry_days: 30 }, error: null },
      infractions: { data: { id: ROW_UUID }, error: null },
    });
    const { POST } = await import('@/app/api/moderation/infractions/route');

    const res = await POST(jsonRequest('http://x/api/moderation/infractions', 'POST', {
      member_id: MEMBER,
      type: 'ban',
      reason: 'Repeated spam after warnings',
    }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      execution: 'history_only',
      message: expect.stringContaining('no Discord action'),
    });

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('moderation.infraction_created');
    expect(arg.blastRadius).toBe('high');
    // This route writes a row and nothing else — it must not claim the member
    // was banned in Discord, because nothing banned them.
    expect(arg.description).toMatch(/^Recorded a manual ban/);
    expect(arg.undo).toBeUndefined();
  });

  it('PATCH records a pardon against the prior state of the infraction', async () => {
    mockBefore({
      id: ROW_UUID, member_id: MEMBER, type: 'warn', active: true, pardoned: false,
    });
    createAdminMock({ infractions: { data: { id: ROW_UUID }, error: null } });
    const { PATCH } = await import('@/app/api/moderation/infractions/route');

    const res = await PATCH(jsonRequest('http://x/api/moderation/infractions', 'PATCH', {
      id: ROW_UUID,
      action: 'pardon',
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('moderation.infraction_pardoned');
    expect(arg.before).toMatchObject({ active: true, pardoned: false });
    expect(arg.after).toMatchObject({ active: false, pardoned: true });
    expect(arg.undo).toBeUndefined();
  });

  it('records nothing when the pardon write fails', async () => {
    createAdminMock({ infractions: { data: null, error: { message: 'boom' } } });
    const { PATCH } = await import('@/app/api/moderation/infractions/route');

    const res = await PATCH(jsonRequest('http://x/api/moderation/infractions', 'PATCH', {
      id: ROW_UUID,
      action: 'pardon',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── Alerts: the one genuinely undoable change in this group ──

describe('/api/alerts', () => {
  it('PATCH acknowledge offers an undo the apply path would actually accept', async () => {
    mockBefore({
      id: ROW_UUID,
      title: 'Webhook error rate high',
      acknowledged: false,
      acknowledged_at: null,
      resolved: false,
      resolved_at: null,
    });
    createAdminMock({ alerts: { data: null, error: null } });
    const { PATCH } = await import('@/app/api/alerts/route');

    const res = await PATCH(jsonRequest('http://x/api/alerts', 'PATCH', {
      id: ROW_UUID,
      action: 'acknowledge',
    }));
    expect(res.status).toBe(200);

    const alertUpdate = mutations.find((m) => m.table === 'alerts' && m.kind === 'update');
    expect(alertUpdate).toBeDefined();
    expect(lastBeforeSeq).toBeLessThan(alertUpdate!.seq);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('alerts.acknowledged');
    expect(arg.description).toContain('Webhook error rate high');
    expect(arg.blastRadius).toBe('low');

    // An undo button that fails on click is the defect the allowlist exists to
    // prevent, so validate the stored payload with the SAME validator the undo
    // route runs — not just "an undo object is present".
    expect(arg.undo).toBeDefined();
    const check = validateUndoPayload(arg.undo, { guildId: GUILD });
    expect(check.ok, check.ok ? '' : check.reason).toBe(true);
    expect(arg.undo).toMatchObject({
      kind: 'db',
      table: 'alerts',
      data: { acknowledged: false, acknowledged_at: null },
      match: { id: ROW_UUID, guild_id: GUILD },
    });
  });

  it('PATCH resolve is undoable and restores the resolved columns', async () => {
    mockBefore({
      id: ROW_UUID, title: 'Webhook error rate high', resolved: false, resolved_at: null,
      acknowledged: true, acknowledged_at: '2026-07-01T00:00:00.000Z',
    });
    createAdminMock({ alerts: { data: null, error: null } });
    const { PATCH } = await import('@/app/api/alerts/route');

    const res = await PATCH(jsonRequest('http://x/api/alerts', 'PATCH', {
      id: ROW_UUID,
      action: 'resolve',
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expect(arg.action).toBe('alerts.resolved');
    expect(validateUndoPayload(arg.undo, { guildId: GUILD }).ok).toBe(true);
    expect(arg.undo).toMatchObject({ data: { resolved: false, resolved_at: null } });
  });

  it('drops the undo honestly when the prior state could not be read', async () => {
    vi.mocked(readRowBefore).mockResolvedValue(undefined);
    createAdminMock({ alerts: { data: null, error: null } });
    const { PATCH } = await import('@/app/api/alerts/route');

    await PATCH(jsonRequest('http://x/api/alerts', 'PATCH', {
      id: ROW_UUID,
      action: 'acknowledge',
    }));

    const arg = recorded();
    expect(arg.undo).toBeUndefined();
    expect(arg.undoReason).toBeTruthy();
  });

  it('records nothing when the acknowledge write fails', async () => {
    createAdminMock({ alerts: { data: null, error: { message: 'boom' } } });
    const { PATCH } = await import('@/app/api/alerts/route');

    const res = await PATCH(jsonRequest('http://x/api/alerts', 'PATCH', {
      id: ROW_UUID,
      action: 'acknowledge',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── Queues: work handed to the bot ──────────────────────────

describe('/api/action-queue', () => {
  it('POST acknowledge records the batch and admits it cannot be un-acknowledged', async () => {
    createAdminMock({ action_queue_dlq: { data: null, error: null } });
    const { POST } = await import('@/app/api/action-queue/route');

    const res = await POST(jsonRequest('http://x/api/action-queue', 'POST', {
      action: 'acknowledge',
      ids: [ROW_UUID],
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('action_queue.dlq_acknowledged');
    expect(arg.undo).toBeUndefined();
  });

  it('POST retry records only when work was actually re-opened', async () => {
    const client = createAdminMock({
      action_queue_dlq: {
        data: [{ id: ROW_UUID, guild_id: GUILD, action: 'send_notification', original_id: ROLE_UUID }],
        error: null,
      },
    });
    client.rpc.mockResolvedValue({
      data: [{ action_id: ROLE_UUID, action_status: 'pending', disposition: 'requeued' }],
      error: null,
    });
    const { POST } = await import('@/app/api/action-queue/route');

    const res = await POST(jsonRequest('http://x/api/action-queue', 'POST', {
      action: 'retry',
      ids: [ROW_UUID],
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('action_queue.dlq_retried');
    expect(arg.blastRadius).toBe('high');
    expect(arg.undo).toBeUndefined();
    // The queued work may already have run; the reason must say so.
    expect(arg.undoReason).toContain('already');
  });

  it('records nothing when every retry in the batch failed', async () => {
    const client = createAdminMock({
      action_queue_dlq: {
        data: [{ id: ROW_UUID, guild_id: GUILD, action: 'send_notification', original_id: ROLE_UUID }],
        error: null,
      },
    });
    client.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { POST } = await import('@/app/api/action-queue/route');

    const res = await POST(jsonRequest('http://x/api/action-queue', 'POST', {
      action: 'retry',
      ids: [ROW_UUID],
    }));

    expect(res.status).toBe(409);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/workflows/dead-letter', () => {
  beforeEach(() => {
    mockBefore({
      id: ROW_UUID, event_type: 'purchase.completed', source: 'commerce',
      status: 'exhausted', retry_count: 3,
    });
  });

  it('POST retry is high blast radius — the job runs again for real', async () => {
    createAdminMock({ dead_letter_queue: { data: { id: ROW_UUID }, error: null } });
    const { POST } = await import('@/app/api/workflows/dead-letter/route');

    const res = await POST(jsonRequest('http://x/api/workflows/dead-letter', 'POST', {
      action: 'retry',
      id: ROW_UUID,
    }));
    expect(res.status).toBe(200);

    const dlqUpdate = mutations.find((m) => m.table === 'dead_letter_queue' && m.kind === 'update');
    expect(lastBeforeSeq).toBeLessThan(dlqUpdate!.seq);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('workflows.dead_letter_retried');
    expect(arg.blastRadius).toBe('high');
    expect(arg.before).toMatchObject({ status: 'exhausted', retry_count: 3 });
    expect(arg.undo).toBeUndefined();
  });

  it('POST discard records that nothing was re-run', async () => {
    createAdminMock({ dead_letter_queue: { data: { id: ROW_UUID }, error: null } });
    const { POST } = await import('@/app/api/workflows/dead-letter/route');

    const res = await POST(jsonRequest('http://x/api/workflows/dead-letter', 'POST', {
      action: 'discard',
      id: ROW_UUID,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('workflows.dead_letter_discarded');
    expect(arg.blastRadius).toBe('medium');
    expect(arg.undo).toBeUndefined();
  });

  it('POST resolve records the manual resolution', async () => {
    createAdminMock({ dead_letter_queue: { data: { id: ROW_UUID }, error: null } });
    const { POST } = await import('@/app/api/workflows/dead-letter/route');

    const res = await POST(jsonRequest('http://x/api/workflows/dead-letter', 'POST', {
      action: 'resolve',
      id: ROW_UUID,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('workflows.dead_letter_resolved');
    expect(arg.blastRadius).toBe('medium');
    expect(arg.undo).toBeUndefined();
  });

  it('records nothing when the dead-letter write fails', async () => {
    createAdminMock({ dead_letter_queue: { data: null, error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/workflows/dead-letter/route');

    const res = await POST(jsonRequest('http://x/api/workflows/dead-letter', 'POST', {
      action: 'retry',
      id: ROW_UUID,
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

// ── Platform: deploy, sync, settings, templates, replay ──────

describe('/api/deploy', () => {
  it('POST records a critical deployment with no undo attached', async () => {
    mockBefore({ guild_id: GUILD, roles: [{}], channels: [{}, {}], applied_at: null });
    createAdminMock({ guild_desired_state: { data: null, error: null } });
    const { POST } = await import('@/app/api/deploy/route');

    const res = await POST(jsonRequest('http://x/api/deploy', 'POST', {
      roles: [{ name: 'Moderator' }, { name: 'Member' }],
      channels: [{ name: 'general' }],
      cleanExisting: true,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('deploy.requested');
    expect(arg.blastRadius).toBe('critical');
    expect(arg.description).toContain('2 roles');
    // Deploying deletes real Discord channels — a fake undo here would be the
    // worst possible lie on this page.
    expect(arg.undo).toBeUndefined();
    expect(arg.undoReason).toContain('Discord');

    const auditInsert = mutations.find(
      (mutation) => mutation.table === 'audit_logs' && mutation.kind === 'insert',
    );
    expect(auditInsert?.payload).toMatchObject({
      guild_id: GUILD,
      actor_id: ACTOR,
      action: 'deploy.requested',
    });
  });

  it('records nothing when the desired-state write fails', async () => {
    createAdminMock({ guild_desired_state: { data: null, error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/deploy/route');

    const res = await POST(jsonRequest('http://x/api/deploy', 'POST', {
      roles: [{ name: 'Moderator' }],
      channels: [{ name: 'general' }],
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/sync/action', () => {
  const driftItem = {
    entityType: 'role',
    entityName: 'Moderator',
    entityDiscordId: 'role-1',
    type: 'PERMISSION_DRIFT',
  };

  it('POST repair records queued Discord work that cannot be called back', async () => {
    createAdminMock({ bot_action_queue: { data: { id: 'queue-1' }, error: null } });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'repair',
      driftItem,
    }));
    expect(res.status).toBe(202);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('sync.drift_repair_queued');
    expect(arg.blastRadius).toBe('high');
    expect(arg.description).toContain('Moderator');
    expect(arg.undo).toBeUndefined();
    expect(arg.undoReason).toContain('already');
  });

  it('POST accept is recorded at a lower blast radius than repair', async () => {
    createAdminMock({ bot_action_queue: { data: { id: 'queue-1' }, error: null } });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'accept',
      driftItem,
    }));
    expect(res.status).toBe(202);

    const arg = recorded();
    expect(arg.action).toBe('sync.drift_accept_queued');
    expect(arg.blastRadius).toBe('medium');
  });

  it('POST ignore records how much was on the drift list before and after', async () => {
    createAdminMock({
      guild_desired_state: {
        data: {
          drift_details: [
            { entityType: 'role', entityName: 'Moderator' },
            { entityType: 'role', entityName: 'Member' },
          ],
        },
        error: null,
      },
    });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'ignore',
      driftItem,
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('sync.drift_ignored');
    expect(arg.before).toMatchObject({ drift_count: 2 });
    expect(arg.after).toMatchObject({ drift_count: 1 });
  });

  it('POST ignore rejects a missing drift item instead of reporting a no-op success', async () => {
    createAdminMock({
      guild_desired_state: {
        data: {
          drift_details: [{ entityType: 'role', entityName: 'Member' }],
        },
        error: null,
      },
    });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'ignore',
      driftItem,
    }));

    expect(res.status).toBe(404);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('POST ignore reports a failed desired-state update', async () => {
    createAdminMock({
      guild_desired_state: [
        {
          data: {
            drift_details: [
              { entityType: 'role', entityName: 'Moderator' },
              { entityType: 'role', entityName: 'Member' },
            ],
          },
          error: null,
        },
        { data: null, error: { message: 'write failed' } },
      ],
    });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'ignore',
      driftItem,
    }));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('POST clear_all records nothing when the write fails', async () => {
    createAdminMock({ guild_desired_state: { data: null, error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/sync/action/route');

    const res = await POST(jsonRequest('http://x/api/sync/action', 'POST', {
      action: 'clear_all',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/settings', () => {
  it('PUT records WHICH installation settings changed and never their values', async () => {
    createAdminMock({ instance_settings: { data: null, error: null } });
    const { PUT } = await import('@/app/api/settings/route');

    // discord_bot_token is encrypted before persistence. Supply the same
    // bootstrap inputs production uses so this wiring test exercises the
    // successful write path rather than failing before the upsert.
    const previousSecret = process.env.SUPABASE_SECRET_KEY;
    const previousUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = 'test-bootstrap-secret';
    process.env.SUPABASE_URL = 'https://test.supabase.co';

    let res: Response;
    try {
      res = await PUT(jsonRequest('http://x/api/settings', 'PUT', {
        section: 'discord',
        values: {
          discord_guild_id: '111222333',
          discord_bot_token: SECRET_MARKERS[1],
        },
      }));
    } finally {
      if (previousSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
      else process.env.SUPABASE_SECRET_KEY = previousSecret;
      if (previousUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousUrl;
    }
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('instance.settings_updated');
    expect(arg.blastRadius).toBe('critical');
    // instance_settings stores the bot token, the Supabase service-role key and
    // the PayPal secret. Key NAMES are useful; values would replicate every
    // credential of this installation into a table the admin UI renders.
    expect(arg.after).toMatchObject({
      section: 'discord',
      changed_keys: ['discord_guild_id', 'discord_bot_token_encrypted'],
    });
    expect(arg.before).toBeUndefined();
    expectNoSecrets(arg);
    // Instance settings are not per-guild; the sentence has to say so.
    expect(arg.description).toContain('installation');
    expect(arg.undo).toBeUndefined();
  });

  it('rejects a no-op when every submitted value was masked or blank', async () => {
    createAdminMock({ instance_settings: { data: null, error: null } });
    const { PUT } = await import('@/app/api/settings/route');

    const res = await PUT(jsonRequest('http://x/api/settings', 'PUT', {
      section: 'discord',
      values: { discord_bot_token: '••••••••abcd', discord_client_secret: '  ' },
    }));

    expect(res.status).toBe(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });

  it('records nothing when the settings upsert reports an error', async () => {
    createAdminMock({ instance_settings: { data: null, error: { message: 'boom' } } });
    const { PUT } = await import('@/app/api/settings/route');

    const res = await PUT(jsonRequest('http://x/api/settings', 'PUT', {
      section: 'discord',
      values: { discord_guild_id: '111222333' },
    }));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/automations/templates', () => {
  it('POST records the automation the template created', async () => {
    createAdminMock({ automations: { data: { id: ROW_UUID }, error: null } });
    const { POST } = await import('@/app/api/automations/templates/route');

    const res = await POST(jsonRequest('http://x/api/automations/templates', 'POST', {
      template_id: 'welcome_dm',
    }));
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('automation.template_deployed');
    expect(arg.description).toContain('Welcome DM');
    expect(arg.blastRadius).toBe('medium');
    expect(arg.undo).toBeUndefined();
  });

  it('records nothing when the automation insert fails', async () => {
    createAdminMock({ automations: { data: null, error: { message: 'boom' } } });
    const { POST } = await import('@/app/api/automations/templates/route');

    const res = await POST(jsonRequest('http://x/api/automations/templates', 'POST', {
      template_id: 'welcome_dm',
    }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});

describe('/api/webhooks/[id]/replay', () => {
  beforeEach(() => {
    process.env.WEBHOOK_REPLAY_SECRET = 'test-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WEBHOOK_REPLAY_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('POST records the replay and never copies the PayPal payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const client = createAdminMock({
      webhook_events: [
        {
          data: {
            event_id: 'EVT-1',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            guild_id: GUILD,
            result: 'error',
            replay_count: 0,
            // Payer identity that must never reach the change log.
            payload: { payer: { email_address: SECRET_MARKERS[2] } },
          },
          error: null,
        },
        { data: { event_id: 'EVT-1' }, error: null },
      ],
    });
    client.rpc.mockResolvedValue({
      data: [{
        outcome: 'claimed',
        claim_token: '11111111-1111-4111-8111-111111111111',
        event_data: {
          event_id: 'EVT-1',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          guild_id: GUILD,
          result: 'error',
          replay_count: 0,
          payload: { payer: { email_address: SECRET_MARKERS[2] } },
        },
      }],
      error: null,
    });
    const { POST } = await import('@/app/api/webhooks/[id]/replay/route');

    const res = await POST(new Request('http://x/api/webhooks/EVT-1/replay', { method: 'POST' }), {
      params: Promise.resolve({ id: 'EVT-1' }),
    });
    expect(res.status).toBe(200);

    const arg = recorded();
    expectWellFormed(arg);
    expect(arg.action).toBe('webhook.replayed');
    expect(arg.blastRadius).toBe('high');
    expect(arg.after).toMatchObject({ replay_count: 1 });
    expect(arg.undo).toBeUndefined();
    expect(arg.undoReason).toMatch(/payment/i);
    expectNoSecrets(arg);
  });

  it('records nothing when the replay claim loses its race', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const client = createAdminMock({
      webhook_events: [
        {
          data: {
            event_id: 'EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', guild_id: GUILD,
            result: 'error', replay_count: 0, payload: {},
          },
          error: null,
        },
        { data: null, error: null },
      ],
    });
    client.rpc.mockResolvedValue({
      data: [{ outcome: 'processing', event_data: null }],
      error: null,
    });
    const { POST } = await import('@/app/api/webhooks/[id]/replay/route');

    const res = await POST(new Request('http://x/api/webhooks/EVT-1/replay', { method: 'POST' }), {
      params: Promise.resolve({ id: 'EVT-1' }),
    });

    expect(res.status).toBe(409);
    expect(recordAdminChange).not.toHaveBeenCalled();
  });
});
