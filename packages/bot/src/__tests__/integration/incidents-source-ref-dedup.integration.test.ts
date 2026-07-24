/**
 * Integration coverage for the incidents source-reference dedup index
 * (migration 20260724110200_incidents_source_ref_dedup).
 *
 * One alert = at most one linked incident. The partial unique index
 * uniq_incident_source_ref (guild_id, source_ref_id) WHERE source_ref_id IS NOT
 * NULL is the real cross-process fence behind the AlertManager health-alert ->
 * incident path. Manual incidents (NULL source_ref_id) are exempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDbUrl, requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

const GUILD_ID = `incident-srcref-${Date.now()}`;
let seq = 0;

async function insertIncident(sourceRefId: string | null): Promise<void> {
  seq += 1;
  await sql`
    INSERT INTO public.incidents
      (guild_id, incident_number, title, severity, status, source, source_ref_id, created_by)
    VALUES (
      ${GUILD_ID}, ${seq}, ${'Incident ' + seq}, 'critical', 'open',
      'health_alert', ${sourceRefId}, 'system:diagnostics'
    )
  `;
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });
  const { error } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Incident Source-Ref Dedup Test Guild',
    owner_discord_id: '420000000000000001',
  });
  if (error) throw new Error(`Guild seed failed: ${error.message}`);
});

afterAll(async () => {
  await sql`DELETE FROM public.incidents WHERE guild_id = ${GUILD_ID}`;
  await supa.from('guild').delete().eq('id', GUILD_ID);
  await sql.end({ timeout: 5 });
});

describe('incidents source_ref_id dedup', () => {
  it('the partial unique index exists on (guild_id, source_ref_id)', async () => {
    const [idx] = await sql<{ indexdef: string }[]>`
      SELECT indexdef
        FROM pg_catalog.pg_indexes
       WHERE indexname = 'uniq_incident_source_ref'
    `;
    expect(idx?.indexdef).toBeTruthy();
    expect(idx!.indexdef).toMatch(/source_ref_id/);
    expect(idx!.indexdef).toMatch(/UNIQUE/i);
  });

  it('rejects a second incident with the same (guild, source_ref_id)', async () => {
    const alertId = randomUUID();
    await insertIncident(alertId);
    // A concurrent evaluation trying to open a second incident for the SAME
    // alert reference must be fenced by the unique index (23505).
    await expect(insertIncident(alertId)).rejects.toMatchObject({ code: '23505' });
  });

  it('permits many manual incidents with a NULL source_ref_id', async () => {
    // NULLs are distinct in a unique index, so manual incidents are never deduped.
    await insertIncident(null);
    await expect(insertIncident(null)).resolves.toBeUndefined();
  });
});
