import type { SupabaseClient } from '@supabase/supabase-js';
import { expect } from 'vitest';
import { requireSupabase } from './helpers.js';

export const scheduledNextGuildId = `test-scheduled-next-${Date.now()}`;
let supabase: SupabaseClient | null = null;

class ScheduledNextTestError extends Error {}

export function requireScheduledNextClient(): SupabaseClient {
  if (supabase === null) {
    throw new ScheduledNextTestError('scheduled next-occurrence test client is not initialized');
  }
  return supabase;
}

export async function insertScheduledNextFixture(overrides: Record<string, unknown> = {}) {
  const result = await requireScheduledNextClient()
    .from('scheduled_messages')
    .insert({
      guild_id: scheduledNextGuildId,
      name: `Next occurrence ${crypto.randomUUID()}`,
      channel_id: '12345678901234567',
      message: 'scheduled next occurrence proof',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      current_sends: 0,
      active: true,
      status: 'active',
      ...overrides,
    })
    .select('id,next_occurrence_at,current_sends,last_sent_at,active,status,max_sends')
    .single();
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  return result.data;
}

export async function initializeScheduledNextFixture(): Promise<void> {
  supabase = await requireSupabase();
  const seeded = await supabase.from('guild').insert({
    id: scheduledNextGuildId,
    name: 'Scheduled next occurrence integration test',
    owner_discord_id: '12345678901234567',
  });
  if (seeded.error) {
    throw new ScheduledNextTestError(`Guild seed failed: ${seeded.error.message}`);
  }
}

export async function cleanupScheduledNextFixture(): Promise<void> {
  if (supabase !== null) {
    await supabase.from('guild').delete().eq('id', scheduledNextGuildId);
  }
}
