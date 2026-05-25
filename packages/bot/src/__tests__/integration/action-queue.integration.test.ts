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
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient;
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
