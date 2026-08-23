import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;

const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const guildId = `test-onboarding-undo-${runId}`;

async function seedChange(requestId: string): Promise<string> {
  const change = await supa.from('admin_changes').insert({
    guild_id: guildId,
    actor_id: 'original-owner',
    action: 'onboarding.updated',
    target_type: 'config',
    target_id: 'onboarding',
    description: 'changed onboarding',
    before_state: { onboarding_enabled: false },
    after_state: {
      onboarding_enabled: true,
      onboarding_sync_state: { request_id: requestId },
    },
    undo_payload: {
      table: 'guild_config',
      data: { onboarding_enabled: false },
      match: { guild_id: guildId },
    },
    is_undoable: true,
    blast_radius: 'low',
  }).select('id').single();
  if (change.error) throw new Error(`Admin change seed failed: ${change.error.message}`);
  return change.data.id;
}

async function resetConfig(requestId: string): Promise<void> {
  const reset = await supa.from('guild_config').upsert({
    guild_id: guildId,
    onboarding_enabled: true,
    onboarding_sync_state: {
      status: 'synced',
      managed: true,
      request_id: requestId,
    },
  });
  if (reset.error) throw new Error(`Guild config reset failed: ${reset.error.message}`);
}

beforeAll(async () => {
  supa = await requireSupabase();
  const guild = await supa.from('guild').insert({
    id: guildId,
    name: 'Onboarding undo transaction test',
    owner_discord_id: '111222333444555666',
  });
  if (guild.error) throw new Error(`Guild seed failed: ${guild.error.message}`);
});

afterAll(async () => {
  if (!supa) return;
  await supa.from('admin_changes').delete().eq('guild_id', guildId);
  await supa.from('guild_config').delete().eq('guild_id', guildId);
  await supa.from('guild').delete().eq('id', guildId);
});

describe('undo_onboarding_change transaction', () => {
  it('applies the config revision and audit reversal atomically', async () => {
    const expectedRequestId = randomUUID();
    const newRequestId = randomUUID();
    await resetConfig(expectedRequestId);
    const changeId = await seedChange(expectedRequestId);

    const result = await supa.rpc('undo_onboarding_change', {
      p_change_id: changeId,
      p_guild_id: guildId,
      p_actor_id: 'undoing-owner',
      p_expected_request_id: expectedRequestId,
      p_new_request_id: newRequestId,
      p_requested_at: new Date().toISOString(),
      p_undo_data: { onboarding_enabled: false },
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'applied',
      sync_state: { request_id: newRequestId, status: 'pending' },
      undo_record: { action: 'undo:onboarding.updated' },
    });
    const config = await supa.from('guild_config')
      .select('onboarding_enabled,onboarding_sync_state')
      .eq('guild_id', guildId)
      .single();
    expect(config.data).toMatchObject({
      onboarding_enabled: false,
      onboarding_sync_state: { request_id: newRequestId, status: 'pending' },
    });
    const change = await supa.from('admin_changes')
      .select('is_undone,undone_by,undo_change_id')
      .eq('id', changeId)
      .single();
    expect(change.data).toMatchObject({
      is_undone: true,
      undone_by: 'undoing-owner',
      undo_change_id: expect.any(String),
    });
  });

  it('rolls back the config write when the reverse audit insert fails', async () => {
    const expectedRequestId = randomUUID();
    const newRequestId = randomUUID();
    await resetConfig(expectedRequestId);
    const changeId = await seedChange(expectedRequestId);

    const result = await supa.rpc('undo_onboarding_change', {
      p_change_id: changeId,
      p_guild_id: guildId,
      p_actor_id: null,
      p_expected_request_id: expectedRequestId,
      p_new_request_id: newRequestId,
      p_requested_at: new Date().toISOString(),
      p_undo_data: { onboarding_enabled: false },
    });

    expect(result.error).not.toBeNull();
    const config = await supa.from('guild_config')
      .select('onboarding_enabled,onboarding_sync_state')
      .eq('guild_id', guildId)
      .single();
    expect(config.data).toMatchObject({
      onboarding_enabled: true,
      onboarding_sync_state: { request_id: expectedRequestId, status: 'synced' },
    });
    const change = await supa.from('admin_changes')
      .select('is_undone,undone_by,undo_change_id')
      .eq('id', changeId)
      .single();
    expect(change.data).toEqual({
      is_undone: false,
      undone_by: null,
      undo_change_id: null,
    });
  });
});
