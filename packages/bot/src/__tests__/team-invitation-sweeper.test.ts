/**
 * TeamInvitationSweeper — the bot-side lifecycle worker for consent-based
 * dashboard-team invitations.
 *
 * Proves the three phases: DM delivery (gated by invite-dm-enabled), the
 * DM-failure path (invitation stays pending + owner mirror + audit), and the
 * expiry sweep (pending → expired + audit + owner mirror).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: Array<Record<string, unknown>> = [];
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setTimestamp() { return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...args: Array<Record<string, unknown>>) { for (const a of args) this.fields.push(a); return this; }
  },
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { TeamInvitationSweeper } from '../features/team-invitations/sweeper.js';

// ── Fakes ───────────────────────────────────────────────────
interface QState {
  table: string;
  op: string;
  filters: Record<string, unknown>;
  columns: string | null;
  payload: unknown;
}

function makeSupabase(handler: (s: QState) => unknown) {
  const from = (table: string) => {
    const state: QState = { table, op: 'select', filters: {}, columns: null, payload: null };
    const builder = {
      select: (cols?: string) => { state.columns = cols ?? null; return builder; },
      insert: (p: unknown) => { state.op = 'insert'; state.payload = p; return builder; },
      upsert: (p: unknown) => { state.op = 'upsert'; state.payload = Array.isArray(p) ? p[0] : p; return builder; },
      update: (p: unknown) => { state.op = 'update'; state.payload = p; return builder; },
      eq: (k: string, v: unknown) => { state.filters[k] = v; return builder; },
      gt: (k: string, v: unknown) => { state.filters['gt_' + k] = v; return builder; },
      lt: (k: string, v: unknown) => { state.filters['lt_' + k] = v; return builder; },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(handler(state)),
      single: () => Promise.resolve(handler(state)),
      then: (resolve: (v: unknown) => unknown) => resolve(handler(state)),
    };
    return builder;
  };
  return { from } as never;
}

interface SetupOpts {
  deliverRows?: unknown[];
  mirrorRows?: unknown[];
  expireRows?: unknown[];
  dmEnabled?: boolean;
  dmThrows?: boolean;
}

function setup(opts: SetupOpts) {
  const audits: Array<Record<string, unknown>> = [];
  const updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  const handler = (s: QState): unknown => {
    const { table, op, filters, columns } = s;
    if (table === 'team_invitations') {
      if (op === 'select') {
        if (filters.dm_status === 'queued') return { data: opts.deliverRows ?? [], error: null };
        if ('accept_notified' in filters) return { data: opts.mirrorRows ?? [], error: null };
        return { data: [], error: null };
      }
      if (op === 'update') {
        updates.push({ payload: s.payload as Record<string, unknown>, filters });
        if (filters.dm_status === 'queued') return { data: { id: filters.id }, error: null };
        if ('accept_notified' in filters) return { data: { id: filters.id }, error: null };
        // expiry sweep (status pending + lt expires_at) → list of transitioned rows
        return { data: opts.expireRows ?? [], error: null };
      }
    }
    if (table === 'guild_config') {
      if (typeof columns === 'string' && columns.includes('team_invite_dm_enabled')) {
        return { data: { team_invite_dm_enabled: opts.dmEnabled ?? true }, error: null };
      }
      return { data: { mod_log_channel_id: null }, error: null };
    }
    if (table === 'audit_logs' && (op === 'insert' || op === 'upsert')) {
      audits.push(s.payload as Record<string, unknown>);
      return { error: null };
    }
    return { data: null, error: null };
  };

  const supabase = makeSupabase(handler);
  const inviteeUser = {
    send: vi.fn(() => (opts.dmThrows ? Promise.reject(new Error('Cannot send DMs')) : Promise.resolve())),
  };
  const ownerUser = { send: vi.fn(() => Promise.resolve()) };
  const usersFetched: string[] = [];
  const guild = {
    id: 'guild-1',
    name: 'Guild One',
    ownerId: 'owner-1',
    channels: { cache: new Map<string, unknown>() },
  };
  const client = {
    guilds: { cache: new Map([['guild-1', guild]]) },
    users: {
      fetch: vi.fn((id: string) => {
        usersFetched.push(id);
        return Promise.resolve(id === 'owner-1' ? ownerUser : inviteeUser);
      }),
    },
  };

  return { supabase, client, audits, updates, inviteeUser, ownerUser, usersFetched };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

function inviteRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv-1',
    guild_id: 'guild-1',
    discord_id: 'invitee-1',
    role_id: 'role-1',
    invited_by: 'owner-1',
    invited_by_name: null,
    expires_at: future(),
    dashboard_roles: { name: 'Moderator' },
    ...over,
  };
}

const previousDashboardUrl = process.env.DASHBOARD_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_URL = 'https://ops.example.test';
});

afterAll(() => {
  if (previousDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = previousDashboardUrl;
});

describe('TeamInvitationSweeper', () => {
  it('delivers a DM for a queued pending invitation and marks it sent', async () => {
    const env = setup({
      deliverRows: [inviteRow({ invited_by_name: 'Owner Alice' })],
      dmEnabled: true,
    });
    const sweeper = new TeamInvitationSweeper(env.client, env.supabase, 60_000);
    await sweeper.runOnce();

    expect(env.usersFetched).toContain('invitee-1');
    expect(env.inviteeUser.send).toHaveBeenCalledTimes(1);
    const deliveredDm = JSON.stringify(env.inviteeUser.send.mock.calls);
    expect(deliveredDm).toContain('Owner Alice');
    expect(deliveredDm).toContain('https://ops.example.test/dashboard');
    const claim = env.updates.find((u) => u.filters.dm_status === 'queued');
    expect(claim!.payload.dm_status).toBe('sent');
    expect(claim!.payload.delivery_mode).toBe('dm');
    // No DM-failure audit on the happy path.
    expect(env.audits.some((a) => a.action === 'team.invite_dm_failed')).toBe(false);
  });

  it('keeps the invitation pending and mirrors to the owner when the DM fails', async () => {
    const env = setup({ deliverRows: [inviteRow()], dmEnabled: true, dmThrows: true });
    const sweeper = new TeamInvitationSweeper(env.client, env.supabase, 60_000);
    await sweeper.runOnce();

    const claim = env.updates.find((u) => u.filters.dm_status === 'queued');
    // dm_status becomes 'failed' but the invitation lifecycle stays pending
    // (only dm_status is written, never status).
    expect(claim!.payload.dm_status).toBe('failed');
    expect(claim!.payload).not.toHaveProperty('status');
    expect(env.audits.some((a) => a.action === 'team.invite_dm_failed')).toBe(true);
    expect(env.ownerUser.send).toHaveBeenCalledTimes(1);
  });

  it('does not DM when invite-dm-enabled is false (dashboard-only)', async () => {
    const env = setup({ deliverRows: [inviteRow()], dmEnabled: false });
    const sweeper = new TeamInvitationSweeper(env.client, env.supabase, 60_000);
    await sweeper.runOnce();

    expect(env.usersFetched).not.toContain('invitee-1');
    expect(env.inviteeUser.send).not.toHaveBeenCalled();
    const claim = env.updates.find((u) => u.filters.dm_status === 'queued');
    expect(claim!.payload.dm_status).toBe('skipped');
    expect(claim!.payload.delivery_mode).toBe('dashboard');
  });

  it('does not run a queued invitation against a mismatched cached guild', async () => {
    const env = setup({ deliverRows: [inviteRow()], dmEnabled: true });
    env.client.guilds.cache.set('guild-1', {
      id: 'guild-2',
      name: 'Foreign Guild',
      ownerId: 'owner-2',
      channels: { cache: new Map<string, unknown>() },
    });
    const sweeper = new TeamInvitationSweeper(env.client, env.supabase, 60_000);

    await sweeper.runOnce();

    expect(env.inviteeUser.send).not.toHaveBeenCalled();
    expect(env.updates.some((update) => update.filters.dm_status === 'queued')).toBe(false);
  });

  it('expires overdue pending invitations, audits, and mirrors to the owner', async () => {
    const expired = inviteRow({ id: 'inv-9', discord_id: 'invitee-9', role_id: 'role-9', expires_at: past(), dashboard_roles: { name: 'Support' } });
    const env = setup({ expireRows: [expired] });
    const sweeper = new TeamInvitationSweeper(env.client, env.supabase, 60_000);
    await sweeper.runOnce();

    // The expiry update writes status='expired'.
    const expUpdate = env.updates.find((u) => u.payload.status === 'expired');
    expect(expUpdate).toBeTruthy();
    expect(env.audits.some((a) => a.action === 'team.invite_expired')).toBe(true);
    expect(env.ownerUser.send).toHaveBeenCalledTimes(1);
  });
});
