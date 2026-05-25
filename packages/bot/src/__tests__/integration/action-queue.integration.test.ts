/**
 * Integration test: Action queue — claim, process, dead-letter lifecycle.
 *
 * The bot_action_queue is the backbone of async task processing.
 * Tests the bot_action_queue_claim RPC (atomic claim with SELECT FOR UPDATE SKIP LOCKED)
 * and the dead-letter queue flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let supa: SupabaseClient;
const GUILD_ID = `test-queue-guild-${Date.now()}`;

beforeAll(async () => {
  supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
  it('enqueues an action', async () => {
    const { data, error } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action_type: 'SEND_WELCOME_DM',
        payload: { user_id: 'new-member-123', message: 'Welcome!' },
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.action_type).toBe('SEND_WELCOME_DM');
    expect(data!.status).toBe('pending');
    expect(data!.attempts).toBe(0);
  });

  it('claims a pending action via RPC', async () => {
    const { data, error } = await supa.rpc('bot_action_queue_claim', {
      p_guild_id: GUILD_ID,
      p_limit: 5,
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();

    // Should claim the action we just enqueued
    const claimed = Array.isArray(data) ? data : [data];
    expect(claimed.length).toBeGreaterThanOrEqual(1);

    const item = claimed[0];
    expect(item.action_type).toBe('SEND_WELCOME_DM');
  });

  it('marks an action as completed', async () => {
    // Get the pending/processing item
    const { data: items } = await supa
      .from('bot_action_queue')
      .select('id')
      .eq('guild_id', GUILD_ID)
      .limit(1);

    const { data, error } = await supa
      .from('bot_action_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', items![0].id)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.status).toBe('completed');
  });

  it('enqueues multiple actions and claims in batch', async () => {
    const actions = Array.from({ length: 3 }, (_, i) => ({
      guild_id: GUILD_ID,
      action_type: 'ASSIGN_ROLE',
      payload: { user_id: `user-${i}`, role_id: 'role-member' },
      status: 'pending' as const,
      attempts: 0,
      max_attempts: 3,
    }));

    await supa.from('bot_action_queue').insert(actions);

    const { data } = await supa.rpc('bot_action_queue_claim', {
      p_guild_id: GUILD_ID,
      p_limit: 10,
    });

    const claimed = Array.isArray(data) ? data : [data];
    // Should claim all 3 pending ASSIGN_ROLE actions
    const roleActions = claimed.filter((a: any) => a.action_type === 'ASSIGN_ROLE');
    expect(roleActions.length).toBe(3);
  });
});

describe('Dead-letter queue', () => {
  it('moves a failed action to the DLQ', async () => {
    // Insert a "failed" action
    const { data: failed } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action_type: 'SEND_NOTIFICATION',
        payload: { channel: 'announcements', text: 'Server maintenance' },
        status: 'failed',
        attempts: 3,
        max_attempts: 3,
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
        action_type: failed!.action_type,
        payload: failed!.payload,
        error_message: failed!.error_message,
        attempts: failed!.attempts,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(dlqEntry!.action_type).toBe('SEND_NOTIFICATION');
    expect(dlqEntry!.error_message).toContain('Missing Permissions');
    expect(dlqEntry!.attempts).toBe(3);
  });
});
