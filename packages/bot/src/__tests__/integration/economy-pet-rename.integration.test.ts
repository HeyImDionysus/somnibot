import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeEconomyAudit } from '../../services/audit.js';
import { requireSupabase } from './helpers.js';

let supa: SupabaseClient | null = null;
const GUILD_ID = `test-pet-rename-${Date.now()}`;
const USER_ID = `pet-rename-user-${Date.now()}`;
const REQUEST_ID = `pet-rename-request-${Date.now()}`;

async function renamePet() {
  if (supa === null) throw new Error('Supabase client is unavailable');
  return supa.rpc('economy_pet_rename_atomic', {
    p_guild_id: GUILD_ID,
    p_user_id: USER_ID,
    p_new_name: 'Comet',
    p_request_id: REQUEST_ID,
  });
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: guildError } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Pet Rename Integration Guild',
    owner_discord_id: '100000000000000098',
  });
  if (guildError) throw new Error(`guild seed: ${guildError.message}`);
  const { error: configError } = await supa.from('guild_config').insert({
    guild_id: GUILD_ID,
    economy_pets_enabled: true,
  });
  if (configError) throw new Error(`guild_config seed: ${configError.message}`);
  const { error: petError } = await supa.from('economy_pets').insert({
    guild_id: GUILD_ID,
    user_id: USER_ID,
    name: 'Fluffy',
    pet_type: 'hunting',
  });
  if (petError) throw new Error(`pet seed: ${petError.message}`);
});

afterAll(async () => {
  if (supa === null) return;
  await supa.from('audit_logs').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_pet_operations').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_pets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('economy_pet_rename_atomic', () => {
  it('renames once and converges duplicate delivery and audit writes on one operation identity', async () => {
    if (supa === null) throw new Error('Supabase client is unavailable');
    const [first, replay] = await Promise.all([renamePet(), renamePet()]);

    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect([first.data?.replayed, replay.data?.replayed].sort()).toEqual([false, true]);
    expect(first.data).toMatchObject({
      status: 'renamed',
      old_name: 'Fluffy',
      new_name: 'Comet',
    });

    await Promise.all([
      writeEconomyAudit(supa, {
        guildId: GUILD_ID,
        actorId: USER_ID,
        action: 'pets.renamed',
        operationId: REQUEST_ID,
        details: { beforeName: 'Fluffy', afterName: 'Comet' },
      }),
      writeEconomyAudit(supa, {
        guildId: GUILD_ID,
        actorId: USER_ID,
        action: 'pets.renamed',
        operationId: REQUEST_ID,
        details: { beforeName: 'Fluffy', afterName: 'Comet' },
      }),
    ]);

    const { data: pet, error: petError } = await supa
      .from('economy_pets')
      .select('name')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_ID)
      .single();
    expect(petError).toBeNull();
    expect(pet?.name).toBe('Comet');

    const { count: operationCount, error: operationError } = await supa
      .from('economy_pet_operations')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_ID)
      .eq('operation', 'rename')
      .eq('request_id', REQUEST_ID);
    expect(operationError).toBeNull();
    expect(operationCount).toBe(1);

    const { count: auditCount, error: auditError } = await supa
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('occurrence_key', `pets.renamed:${REQUEST_ID}`);
    expect(auditError).toBeNull();
    expect(auditCount).toBe(1);
  });
});
