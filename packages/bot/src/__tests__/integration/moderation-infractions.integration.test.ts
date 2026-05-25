/**
 * Integration test: Moderation — infractions, audit logs.
 *
 * Tests the core moderation data pipeline: creating infractions,
 * querying active warnings, pardoning, and audit log entries.
 * All against a real Supabase instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient | null = null;
const GUILD_ID = `test-mod-guild-${Date.now()}`;
const MOD_ID = 'moderator-001';
const OFFENDER_ID = 'offender-001';

beforeAll(async () => {
  supa = await requireSupabase();
  if (!supa) return;

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Moderation Test Guild',
    owner_discord_id: '444555666',
  });
});

afterAll(async () => {
  if (!supa) return;
  await supa.from('audit_logs').delete().eq('guild_id', GUILD_ID);
  await supa.from('infractions').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Infractions', () => {
  let warnId: string;

  it('creates a warning infraction', async () => {
    if (!supa) return;
    const { data, error } = await supa
      .from('infractions')
      .insert({
        guild_id: GUILD_ID,
        member_id: OFFENDER_ID,
        moderator_id: MOD_ID,
        type: 'warn',
        reason: 'Spamming in #general',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.type).toBe('warn');
    expect(data!.active).toBe(true);
    expect(data!.pardoned).toBe(false);
    warnId = data!.id;
  });

  it('creates a mute infraction with duration', async () => {
    if (!supa) return;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data, error } = await supa
      .from('infractions')
      .insert({
        guild_id: GUILD_ID,
        member_id: OFFENDER_ID,
        moderator_id: MOD_ID,
        type: 'mute',
        reason: 'Continued spam after warning',
        duration_minutes: 60,
        expires_at: expiresAt,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.type).toBe('mute');
    expect(data!.duration_minutes).toBe(60);
  });

  it('rejects invalid infraction type (CHECK constraint)', async () => {
    if (!supa) return;
    const { error } = await supa.from('infractions').insert({
      guild_id: GUILD_ID,
      member_id: OFFENDER_ID,
      moderator_id: MOD_ID,
      type: 'invalid_type',
      reason: 'Should fail',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514');
  });

  it('queries active infractions for a member', async () => {
    if (!supa) return;
    const { data, error } = await supa
      .from('infractions')
      .select('id, type, reason, active')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', OFFENDER_ID)
      .eq('active', true)
      .order('created_at', { ascending: false });

    expect(error).toBeNull();
    expect(data!.length).toBe(2);
    expect(data!.map((d) => d.type)).toContain('warn');
    expect(data!.map((d) => d.type)).toContain('mute');
  });

  it('pardons a warning', async () => {
    if (!supa) return;
    const { data, error } = await supa
      .from('infractions')
      .update({
        pardoned: true,
        pardoned_by: 'admin-001',
        pardoned_at: new Date().toISOString(),
        active: false,
      })
      .eq('id', warnId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.pardoned).toBe(true);
    expect(data!.active).toBe(false);
    expect(data!.pardoned_by).toBe('admin-001');
  });

  it('only non-pardoned infractions remain active', async () => {
    if (!supa) return;
    const { data } = await supa
      .from('infractions')
      .select('id, type')
      .eq('guild_id', GUILD_ID)
      .eq('member_id', OFFENDER_ID)
      .eq('active', true);

    expect(data!.length).toBe(1);
    expect(data![0].type).toBe('mute');
  });
});

describe('Audit logs', () => {
  it('records a moderation action', async () => {
    if (!supa) return;
    const { data, error } = await supa
      .from('audit_logs')
      .insert({
        guild_id: GUILD_ID,
        actor_type: 'moderator',
        actor_id: MOD_ID,
        action: 'MEMBER_WARN',
        target_type: 'member',
        target_id: OFFENDER_ID,
        details: { reason: 'Spamming', channel: '#general' },
        success: true,
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.action).toBe('MEMBER_WARN');
    expect(data!.details).toEqual({ reason: 'Spamming', channel: '#general' });
  });

  it('queries audit logs for a guild ordered by timestamp', async () => {
    if (!supa) return;
    await supa.from('audit_logs').insert({
      guild_id: GUILD_ID,
      actor_type: 'bot',
      actor_id: 'somnibot',
      action: 'AUTOMOD_MUTE',
      target_type: 'member',
      target_id: OFFENDER_ID,
      details: { rule: 'anti-spam', duration: 60 },
    });

    const { data, error } = await supa
      .from('audit_logs')
      .select('action, actor_type, target_id')
      .eq('guild_id', GUILD_ID)
      .order('timestamp', { ascending: false });

    expect(error).toBeNull();
    expect(data!.length).toBe(2);
    expect(data![0].action).toBe('AUTOMOD_MUTE');
    expect(data![1].action).toBe('MEMBER_WARN');
  });
});
