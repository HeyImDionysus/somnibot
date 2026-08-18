import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProfileWrites } from '../../features/profiles/profile-writes.js';
import { requireSupabase } from './helpers.js';

let supabase: SupabaseClient;
const suffix = `${Date.now()}`;
const guildId = `profile-write-${suffix}`;
const actorId = `profile-actor-${suffix}`;
const targetId = `profile-target-${suffix}`;

beforeAll(async () => {
  supabase = await requireSupabase();
  const { error } = await supabase.from('guild').insert({
    id: guildId,
    name: 'Profile Write Occurrence Guild',
    owner_discord_id: `profile-owner-${suffix}`,
  });
  if (error) throw new Error(`guild seed failed: ${error.message}`);
});

afterAll(async () => {
  if (!supabase) return;
  await supabase.from('profile_write_occurrences').delete().eq('guild_id', guildId);
  await supabase.from('economy_profiles').delete().eq('guild_id', guildId);
});

describe('durable profile write occurrences', () => {
  it('applies one same-identity replay and denies crafted interaction identity reuse', async () => {
    // Given two process-local adapters sharing one durable interaction identity.
    const firstInstance = new ProfileWrites(supabase);
    const secondInstance = new ProfileWrites(supabase);
    const input = {
      guildId,
      interactionId: `profile-write-replay-${suffix}`,
      actorId,
      targetId: actorId,
      field: 'bio',
      value: 'One durable profile bio',
      truncated: false,
    } as const;

    // When both instances receive the same interaction concurrently.
    const outcomes = await Promise.all([
      firstInstance.apply(input),
      secondInstance.apply(input),
    ]);

    // Then only one caller may confirm, one mutation lands, and one success audit exists.
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['applied', 'replayed']);
    const { data: profile } = await supabase
      .from('economy_profiles')
      .select('bio,updated_at')
      .eq('guild_id', guildId)
      .eq('user_id', actorId)
      .single();
    expect(profile?.bio).toBe(input.value);
    const firstUpdatedAt = profile?.updated_at;
    expect(firstUpdatedAt).toBeTruthy();

    const replay = await firstInstance.apply(input);
    expect(replay.kind).toBe('replayed');

    const identityMismatch = await secondInstance.apply({
      ...input,
      actorId: targetId,
      targetId: actorId,
      value: 'Crafted interaction reuse',
    });
    expect(identityMismatch).toEqual({
      kind: 'denied',
      reason: 'interaction_identity_mismatch',
    });

    const { data: replayedProfile } = await supabase
      .from('economy_profiles')
      .select('bio,updated_at')
      .eq('guild_id', guildId)
      .eq('user_id', actorId)
      .single();
    expect(replayedProfile?.bio).toBe(input.value);
    expect(replayedProfile?.updated_at).toBe(firstUpdatedAt);

    const { count } = await supabase
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .eq('occurrence_key', `profiles.bio_updated:${input.interactionId}`);
    expect(count).toBe(1);

    const { data: identityMismatchAuditRows, count: identityMismatchAudits } = await supabase
      .from('audit_logs')
      .select('actor_id,target_id,details,success,error_message', { count: 'exact' })
      .eq('guild_id', guildId)
      .eq('occurrence_key', `profiles.write_denied:${input.interactionId}:identity_mismatch`);
    expect(identityMismatchAudits).toBe(1);
    expect(identityMismatchAuditRows?.[0]).toMatchObject({
      actor_id: targetId,
      target_id: actorId,
      success: false,
      error_message: 'interaction_identity_mismatch',
      details: {
        actorId: targetId,
        targetId: actorId,
        reason: 'interaction_identity_mismatch',
        originalActorId: actorId,
        originalTargetId: actorId,
      },
    });
  });

  it('denies an actor-target mismatch before mutation and audits it once', async () => {
    // Given a target profile and a crafted internal request from a different actor.
    await supabase.from('economy_profiles').upsert({
      guild_id: guildId,
      user_id: targetId,
      title: 'Original title',
    });
    const writes = new ProfileWrites(supabase);
    const interactionId = `profile-write-denied-${suffix}`;

    // When the service is asked to write another member's profile.
    const outcome = await writes.apply({
      guildId,
      interactionId,
      actorId,
      targetId,
      field: 'title',
      value: 'Crafted overwrite',
      truncated: false,
    });

    // Then the target remains unchanged and one occurrence-keyed denial is durable.
    expect(outcome).toEqual({ kind: 'denied', reason: 'actor_target_mismatch' });
    const { data: target } = await supabase
      .from('economy_profiles')
      .select('title')
      .eq('guild_id', guildId)
      .eq('user_id', targetId)
      .single();
    expect(target?.title).toBe('Original title');

    const { data: audits, count } = await supabase
      .from('audit_logs')
      .select('actor_id,target_id,details,success', { count: 'exact' })
      .eq('guild_id', guildId)
      .eq('occurrence_key', `profiles.write_denied:${interactionId}`);
    expect(count).toBe(1);
    expect(audits?.[0]).toMatchObject({
      actor_id: actorId,
      target_id: targetId,
      success: false,
      details: { actorId, targetId, reason: 'actor_target_mismatch' },
    });
  });
});
