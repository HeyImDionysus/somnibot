/**
 * Integration test: Action queue — enqueue, claim, complete, dead-letter.
 *
 * The bot_action_queue is the backbone of async task processing.
 * Columns: id, guild_id, action (TEXT), payload (JSONB), status, retry_count,
 *          created_at, started_at, completed_at, result, error_message.
 * bot_action_queue_claim(p_action_id UUID) atomically claims a single action.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase, getAnonTestClient, getAuthenticatedTestClient } from './helpers.js';

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
    // RPC takes a single UUID, atomically moves pending → processing
    const { data, error } = await supa.rpc('bot_action_queue_claim', {
      p_action_id: actionId,
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();

    const claimed = Array.isArray(data) ? data : [data];
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(actionId);
    expect(claimed[0].status).toBe('processing');
    expect(claimed[0].action).toBe('SEND_WELCOME_DM');
  });

  it('does not re-claim an already processing action', async () => {
    // Try claiming the same action again — should return empty
    const { data, error } = await supa.rpc('bot_action_queue_claim', {
      p_action_id: actionId,
    });

    expect(error).toBeNull();
    const rows = Array.isArray(data) ? data : [];
    expect(rows.length).toBe(0);
  });

  it('marks an action as completed', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: { delivered: true },
      })
      .eq('id', actionId)
      .select()
      .single();

    expect(error).toBeNull();
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

  it(
    'still delivers Realtime INSERT events to the service-role listener (bot flow)',
    { timeout: 45_000 },
    async () => {
      // The bot subscribes to postgres_changes INSERTs on
      // bot_action_queue with the service key
      // (packages/bot/src/services/action-queue.ts). Realtime applies
      // RLS per subscriber, so revoking authenticated must not break
      // service-role delivery — this guards the dashboard-insert →
      // bot-notification flow end to end.
      const channelName = `test-baq-lockdown-${Date.now()}`;

      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for Realtime INSERT event')),
          40_000,
        );

        supa
          .channel(channelName)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'bot_action_queue',
              filter: `guild_id=eq.${GUILD_ID}`,
            },
            (payload) => {
              clearTimeout(timer);
              resolve(payload.new as Record<string, unknown>);
            },
          )
          .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
              // Insert only after the subscription is live — Realtime
              // does not replay events from before SUBSCRIBED.
              supa
                .from('bot_action_queue')
                .insert({
                  guild_id: GUILD_ID,
                  action: 'realtime_lockdown_probe',
                  payload: { probe: true },
                  status: 'pending',
                })
                .then(({ error }) => {
                  if (error) {
                    clearTimeout(timer);
                    reject(new Error(`Probe insert failed: ${error.message}`));
                  }
                });
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              clearTimeout(timer);
              reject(new Error(`Realtime subscription failed: ${status} ${err ?? ''}`));
            }
          });
      });

      try {
        const row = await received;
        expect(row.action).toBe('realtime_lockdown_probe');
        expect(row.guild_id).toBe(GUILD_ID);
      } finally {
        await supa.removeAllChannels();
      }
    },
  );
});
