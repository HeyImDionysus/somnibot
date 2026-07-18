/**
 * Integration test: Action queue — enqueue, claim, complete, dead-letter.
 *
 * The bot_action_queue is the backbone of async task processing.
 * Columns: id, guild_id, action (TEXT), payload (JSONB), status, retry_count,
 *          created_at, started_at, completed_at, result, error_message.
 * bot_action_queue_claim(p_action_id UUID, p_protocol_version INTEGER)
 * atomically claims a single action.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import {
  requireSupabase,
  getAnonTestClient,
  getAuthenticatedTestClient,
  getTestDbUrl,
} from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-queue-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Queue Test Guild',
    owner_discord_id: '123456789',
  });
});

afterAll(async () => {
  await supa.from('action_queue_dlq').delete().eq('guild_id', GUILD_ID);
  await supa.from('bot_action_queue').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Action queue', () => {
  let actionId: string;
  let claimToken: string;

  it('enqueues an action', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'SEND_WELCOME_DM',
        payload: { user_id: 'new-member-123', message: 'Welcome!' },
        status: 'pending',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.action).toBe('SEND_WELCOME_DM');
    expect(data!.status).toBe('pending');
    actionId = data!.id;
  });

  it('claims a pending action via bot_action_queue_claim RPC', async () => {
    // RPC binds the worker to the current protocol before moving pending → processing.
    const { data, error } = await supa.rpc('bot_action_queue_claim', {
      p_action_id: actionId,
      p_protocol_version: 2,
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();

    const claimed = Array.isArray(data) ? data : [data];
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(actionId);
    expect(claimed[0].status).toBe('processing');
    expect(claimed[0].action).toBe('SEND_WELCOME_DM');
    claimToken = claimed[0].claim_token;
  });

  it('does not re-claim an already processing action', async () => {
    // Try claiming the same action again — should return empty
    const { data, error } = await supa.rpc('bot_action_queue_claim', {
      p_action_id: actionId,
      p_protocol_version: 2,
    });

    expect(error).toBeNull();
    const rows = Array.isArray(data) ? data : [];
    expect(rows.length).toBe(0);
  });

  it('marks an action as completed', async () => {
    const { error } = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: actionId,
      p_claim_token: claimToken,
      p_success: true,
      p_result: { delivered: true },
      p_error: null,
    });

    expect(error).toBeNull();

    const { data, error: readError } = await supa
      .from('bot_action_queue')
      .select('status, result')
      .eq('id', actionId)
      .single();

    expect(readError).toBeNull();
    expect(data!.status).toBe('completed');
    expect(data!.result).toEqual({ delivered: true });
  });

  it('enqueues multiple actions and queries by status', async () => {
    const actions = Array.from({ length: 3 }, (_, i) => ({
      guild_id: GUILD_ID,
      action: 'ASSIGN_ROLE',
      payload: { user_id: `user-${i}`, role_id: 'role-member' },
      status: 'pending' as const,
    }));

    await supa.from('bot_action_queue').insert(actions);

    const { data, error } = await supa
      .from('bot_action_queue')
      .select('id, action, status')
      .eq('guild_id', GUILD_ID)
      .eq('status', 'pending');

    expect(error).toBeNull();
    expect(data!.length).toBe(3);
    expect(data!.every((a) => a.action === 'ASSIGN_ROLE')).toBe(true);
  });
});

describe('Dead-letter queue', () => {
  it('moves a failed action to the DLQ', async () => {
    // Insert a "failed" action
    const { data: failed } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'SEND_NOTIFICATION',
        payload: { channel: 'announcements', text: 'Server maintenance' },
        status: 'failed',
        error_message: 'Discord API 50013: Missing Permissions',
      })
      .select()
      .single();

    // Move to DLQ
    const { data: dlqEntry, error } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        original_id: failed!.id,
        action: failed!.action,
        payload: failed!.payload,
        error_message: failed!.error_message,
        retry_count: 3,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(dlqEntry!.action).toBe('SEND_NOTIFICATION');
    expect(dlqEntry!.error_message).toContain('Missing Permissions');
    expect(dlqEntry!.retry_count).toBe(3);
  });

  it('atomically retries a generic DLQ row once across concurrent calls and stays opaque', async () => {
    const marker = `generic-retry-${randomUUID()}`;
    const originalId = randomUUID();
    const { data: dlq, error: dlqError } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        original_id: originalId,
        action: 'SEND_NOTIFICATION',
        payload: { marker },
        error_message: 'first failure',
        retry_count: 5,
      })
      .select('id')
      .single();
    expect(dlqError).toBeNull();

    const attempts = await Promise.all([
      supa.rpc('bot_action_queue_retry_dlq', {
        p_dlq_id: dlq!.id,
        p_guild_id: GUILD_ID,
      }),
      supa.rpc('bot_action_queue_retry_dlq', {
        p_dlq_id: dlq!.id,
        p_guild_id: GUILD_ID,
      }),
    ]);
    expect(attempts.every(({ error }) => error === null)).toBe(true);
    const outcomes = attempts.map(({ data }) => {
      const rows = Array.isArray(data) ? data : [];
      expect(rows).toHaveLength(1);
      return rows[0] as {
        action_id: string | null;
        action_status: string | null;
        disposition: string;
      };
    });
    expect(outcomes.map(({ disposition }) => disposition).sort()).toEqual([
      'already_retried',
      'requeued',
    ]);
    expect(outcomes.find(({ disposition }) => disposition === 'requeued')).toMatchObject({
      action_id: expect.any(String),
      action_status: 'pending',
    });
    expect(outcomes.find(({ disposition }) => disposition === 'already_retried')).toEqual({
      action_id: null,
      action_status: null,
      disposition: 'already_retried',
    });

    const { data: replacements, error: replacementsError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'SEND_NOTIFICATION')
      .contains('payload', { marker });
    expect(replacementsError).toBeNull();
    expect(replacements).toHaveLength(1);
    expect(replacements![0]).toMatchObject({ status: 'pending', payload: { marker } });

    const replay = await supa.rpc('bot_action_queue_retry_dlq', {
      p_dlq_id: dlq!.id,
      p_guild_id: GUILD_ID,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual([{
      action_id: null,
      action_status: null,
      disposition: 'already_retried',
    }]);

    const wrongGuildMarker = `wrong-guild-${randomUUID()}`;
    const { data: wrongGuildDlq, error: wrongGuildDlqError } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        original_id: randomUUID(),
        action: 'SEND_NOTIFICATION',
        payload: { marker: wrongGuildMarker },
      })
      .select('id')
      .single();
    expect(wrongGuildDlqError).toBeNull();
    const wrongGuild = await supa.rpc('bot_action_queue_retry_dlq', {
      p_dlq_id: wrongGuildDlq!.id,
      p_guild_id: `${GUILD_ID}-wrong`,
    });
    expect(wrongGuild.error).toBeNull();
    expect(wrongGuild.data).toEqual([{
      action_id: null,
      action_status: null,
      disposition: 'already_retried',
    }]);
    const { data: wrongGuildAfter } = await supa
      .from('action_queue_dlq')
      .select('retried')
      .eq('id', wrongGuildDlq!.id)
      .single();
    expect(wrongGuildAfter?.retried).toBe(false);
    const { count: wrongGuildClones } = await supa
      .from('bot_action_queue')
      .select('*', { count: 'exact', head: true })
      .contains('payload', { marker: wrongGuildMarker });
    expect(wrongGuildClones).toBe(0);

    const exactMarker = `exact-carrier-${randomUUID()}`;
    const { data: exactDlq, error: exactDlqError } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: GUILD_ID,
        original_id: randomUUID(),
        action: 'fulfill_purchase',
        payload: { guild_id: GUILD_ID, marker: exactMarker },
      })
      .select('id')
      .single();
    expect(exactDlqError).toBeNull();
    const exactAttempt = await supa.rpc('bot_action_queue_retry_dlq', {
      p_dlq_id: exactDlq!.id,
      p_guild_id: GUILD_ID,
    });
    expect(exactAttempt.error).toBeNull();
    expect(exactAttempt.data).toEqual([{
      action_id: null,
      action_status: null,
      disposition: 'exact_carrier_required',
    }]);
    const { data: exactAfter } = await supa
      .from('action_queue_dlq')
      .select('retried')
      .eq('id', exactDlq!.id)
      .single();
    expect(exactAfter?.retried).toBe(false);
  });
});

const expectPermissionDenied = (error: { code?: string; message?: string } | null) => {
  expect(error).not.toBeNull();
  const denied =
    error!.code === '42501' || /permission denied/i.test(error!.message ?? '');
  expect(denied, `expected permission denied, got: ${JSON.stringify(error)}`).toBe(true);
};

describe('Dead-letter queue lockdown (20260709210000_dlq_rls_lockdown)', () => {
  // The DLQ preserves full action payloads — including
  // license_key_plaintext for failed deliver_receipt actions — so it
  // must be readable/writable only via service_role. Grants for
  // anon/authenticated are revoked, so PostgREST must return a
  // permission-denied error (42501), not an empty RLS-filtered result.

  it('denies anon reads on action_queue_dlq', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon.from('action_queue_dlq').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies anon inserts into action_queue_dlq', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon.from('action_queue_dlq').insert({
      guild_id: GUILD_ID,
      action: 'deliver_receipt',
      payload: {},
    });
    expectPermissionDenied(error);
  });

  it('denies authenticated reads on action_queue_dlq', async () => {
    const authed = getAuthenticatedTestClient();
    const { error } = await authed.from('action_queue_dlq').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies authenticated updates on action_queue_dlq', async () => {
    const authed = getAuthenticatedTestClient();
    const { error } = await authed
      .from('action_queue_dlq')
      .update({ acknowledged: true })
      .eq('guild_id', GUILD_ID);
    expectPermissionDenied(error);
  });

  it('still allows service-role reads (bot + dashboard admin path)', async () => {
    const { data, error } = await supa
      .from('action_queue_dlq')
      .select('id, action, payload')
      .eq('guild_id', GUILD_ID);

    expect(error).toBeNull();
    // The row dead-lettered in the previous suite is still visible.
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('Live queue lockdown (20260709230000_bot_action_queue_rls_lockdown)', () => {
  // bot_action_queue retry rows for deliver_receipt / fulfill_* carry
  // license_key_plaintext in payload, so the live queue must be
  // service_role-only, same posture as the DLQ. Phase A's
  // SELECT/INSERT grants to authenticated (and any legacy anon default
  // grants) are revoked — PostgREST must return permission denied
  // (42501), not an empty RLS-filtered result.

  it('denies anon reads on bot_action_queue', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon.from('bot_action_queue').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies anon inserts into bot_action_queue', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'deliver_receipt',
      payload: {},
    });
    expectPermissionDenied(error);
  });

  it('denies authenticated reads on bot_action_queue', async () => {
    const authed = getAuthenticatedTestClient();
    const { error } = await authed.from('bot_action_queue').select('id, payload').limit(1);
    expectPermissionDenied(error);
  });

  it('denies authenticated inserts into bot_action_queue (Phase A grant revoked)', async () => {
    const authed = getAuthenticatedTestClient();
    const { error } = await authed.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'config_reload',
      payload: { section: 'all' },
    });
    expectPermissionDenied(error);
  });

  it('still allows service-role reads including retry payloads', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .select('id, action, payload, status')
      .eq('guild_id', GUILD_ID);

    expect(error).toBeNull();
    // Rows enqueued by the suites above are still visible.
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the bot Realtime feed preconditions intact (publication + service_role grants)', async () => {
    // The bot's production listener subscribes to postgres_changes
    // INSERTs on bot_action_queue with the service key
    // (packages/bot/src/services/action-queue.ts). End-to-end event
    // delivery is environment-dependent and cannot be exercised
    // against the CI-local Supabase stack — a live subscribe/insert
    // probe deterministically timed out there (websocket join never
    // completed; see PR #265) — so this asserts, at the catalog level,
    // the two preconditions of that flow which the lockdown migration
    // could plausibly have broken:
    //   1. the table is still a member of the supabase_realtime
    //      publication (the WAL feed Realtime reads), and
    //   2. service_role still holds SELECT (required both for walrus
    //      visibility checks and the bot's own reads).
    // Authenticated/anon subscribers losing events is the *intended*
    // effect of the lockdown; no browser subscription targets this
    // table. Delivery itself is proven by the production bot flow.
    const sql = postgres(getTestDbUrl(), { max: 1 });
    try {
      const pub = await sql`
        SELECT 1 AS ok
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'bot_action_queue'`;
      expect(pub.length, 'bot_action_queue must stay in the supabase_realtime publication').toBe(1);

      const [priv] = await sql`
        SELECT has_table_privilege('service_role', 'public.bot_action_queue', 'SELECT') AS can_select,
               has_table_privilege('service_role', 'public.bot_action_queue', 'INSERT') AS can_insert`;
      expect(priv?.can_select, 'service_role must retain SELECT on bot_action_queue').toBe(true);
      expect(priv?.can_insert, 'service_role must retain INSERT on bot_action_queue').toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
