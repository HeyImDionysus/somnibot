import { randomUUID } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

type Fixture = { readonly guild: string; readonly owner: string };
type Verification = { readonly result: 'pass' | 'fail' | 'unknown'; readonly eligible: boolean; readonly trackId: string };

async function withFixture(run: (tx: TransactionSql, fixture: Fixture) => Promise<void>, seedGames = true): Promise<void> {
  await requireSupabase();
  const sql = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const rollback = new Error('rollback adoption verification fixture');
  const fixture = { guild: `adoption-${randomUUID()}`, owner: '900000000000000123' };
  try {
    await expect(sql.begin(async (tx) => {
      await tx`INSERT INTO public.guild(id,name,owner_discord_id) VALUES (${fixture.guild}, 'Adoption fixture', ${fixture.owner})`;
      await tx`SET LOCAL ROLE service_role`;
      await tx`INSERT INTO public.guild_config(guild_id,economy_enabled,economy_games_enabled,economy_lottery_enabled)
        VALUES (${fixture.guild},true,true,false)`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp,details)
        VALUES (${fixture.guild},'system','system','bot.started',true,clock_timestamp(),'{"bootId":"boot-current"}'::jsonb)`;
      if (seedGames) await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'user','player','casino.bet_settled',true,clock_timestamp())`;
      await tx`INSERT INTO public.bot_diagnostics(guild_id,type,boot_id,uptime_seconds,valkey_connected,discord_ws_ping,snapshot_at)
        VALUES (${fixture.guild},'health','boot-current',0,true,20,clock_timestamp())`;
      await run(tx, fixture);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await sql.end(); }
}

async function check(tx: TransactionSql, fixture: Fixture, track = 'games'): Promise<Verification | undefined> {
  const [row] = await tx<{ result: Verification }[]>`SELECT public.check_dashboard_adoption_track(
    ${fixture.guild},${fixture.owner},${track},${randomUUID()}::uuid,${randomUUID()}) AS result`;
  return row?.result;
}

async function read(tx: TransactionSql, fixture: Fixture): Promise<readonly Verification[]> {
  const [row] = await tx<{ result: Verification[] }[]>`SELECT public.read_dashboard_adoption_verifications(${fixture.guild}) AS result`;
  return row?.result ?? [];
}

describe('real database adoption check and activation boundary', () => {
  it('records genuine source fixtures through the production writer with operation and audit receipts', async () => {
    await withFixture(async (tx, fixture) => {
      expect(await check(tx, fixture)).toMatchObject({ result: 'pass', eligible: true });
      const [row] = await tx<{ result: string; operation: string; audit: boolean }[]>`
        SELECT verification.result, operation.outcome AS operation,
          EXISTS(SELECT 1 FROM public.audit_logs WHERE guild_id=${fixture.guild} AND action='dashboard.adoption.checked') AS audit
        FROM public.dashboard_adoption_verifications AS verification JOIN public.significant_operations AS operation ON operation.id=verification.operation_id
        WHERE verification.guild_id=${fixture.guild} AND verification.track_id='games'`;
      expect(row).toEqual({ result: 'pass', operation: 'completed', audit: true });
    });
  });
  it('rejects another guild owner before recording evidence', async () => {
    await withFixture(async (tx, fixture) => {
      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.check_dashboard_adoption_track(
        ${fixture.guild},'foreign-owner','core',${randomUUID()}::uuid,${randomUUID()})`)).rejects.toMatchObject({ code: '42501' });
      expect((await read(tx, fixture)).find((row) => row.trackId === 'core')?.eligible).toBe(false);
    });
  });
  it('does not use a settlement belonging to another guild', async () => {
    await withFixture(async (tx, fixture) => {
      await tx`INSERT INTO public.guild(id,name,owner_discord_id) VALUES ('foreign-' || ${fixture.guild},'Other',${fixture.owner})`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES ('foreign-' || ${fixture.guild},'user','player','casino.bet_settled',true,clock_timestamp())`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'unknown', eligible: false });
    }, false);
  });
  it('requires new real action after relevant settings change without requiring restart', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture);
      await tx`UPDATE public.guild_config SET economy_coinflip_max_bet=900 WHERE guild_id=${fixture.guild}`;
      expect((await read(tx, fixture)).find((row) => row.trackId === 'games')?.eligible).toBe(false);
      await tx`UPDATE public.bot_diagnostics SET snapshot_at=clock_timestamp() WHERE guild_id=${fixture.guild} AND type='health'`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'unknown' });
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'user','player','casino.bet_settled',true,clock_timestamp())`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'pass', eligible: true });
    });
  });
  it('preserves games proof across unrelated welcome edits and adoption publication', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture, 'core');
      await check(tx, fixture);
      await tx`UPDATE public.guild_config SET welcome_message='unrelated' WHERE guild_id=${fixture.guild}`;
      await tx`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"guided","tutorialVisible":true,"selectedTrackIds":["core","recovery","games"],"trackStates":{"core":"active","games":"active"}}'::jsonb)`;
      expect((await read(tx, fixture)).find((row) => row.trackId === 'games')?.eligible).toBe(true);
    });
  });
  it('keeps the latest failed check visible and blocks activation despite an older pass', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture);
      await tx`UPDATE public.bot_diagnostics SET valkey_connected=false,snapshot_at=clock_timestamp() WHERE guild_id=${fixture.guild}`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'fail', eligible: false });
      await tx`UPDATE public.bot_diagnostics SET valkey_connected=true,snapshot_at=clock_timestamp() WHERE guild_id=${fixture.guild}`;
      expect((await read(tx, fixture)).find((row) => row.trackId === 'games')).toMatchObject({ result: 'fail', eligible: false });
      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"guided","tutorialVisible":true,"selectedTrackIds":["core","recovery","games"],"trackStates":{"games":"active"}}'::jsonb)`)).rejects.toMatchObject({ code: '23514' });
    });
  });
  it('allows adoption-only edits after expiry but still blocks paused-to-active reactivation', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture, 'core');
      await check(tx, fixture);
      await tx`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"guided","tutorialVisible":true,"selectedTrackIds":["core","recovery","games"],"trackStates":{"core":"active","games":"active"}}'::jsonb)`;
      await tx`UPDATE public.dashboard_adoption_verifications SET verified_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE guild_id=${fixture.guild}`;
      const [edited] = await tx<{ result: { state: { tutorialVisible: boolean } } }[]>`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"expert","tutorialVisible":false,"selectedTrackIds":["core","recovery","games"],"trackStates":{"core":"active","games":"active"}}'::jsonb) AS result`;
      expect(edited?.result.state.tutorialVisible).toBe(false);
      await tx`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"expert","tutorialVisible":false,"selectedTrackIds":["core","recovery","games"],"trackStates":{"core":"active","games":"paused"}}'::jsonb)`;
      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.publish_dashboard_adoption_map(${randomUUID()}::uuid,${fixture.guild},${fixture.owner},${randomUUID()},
        '{"mode":"expert","tutorialVisible":false,"selectedTrackIds":["core","recovery","games"],"trackStates":{"core":"active","games":"active"}}'::jsonb)`)).rejects.toMatchObject({ code: '23514' });
    });
  });
  it('rejects expired verification rows even when current health is good', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture);
      await tx`UPDATE public.dashboard_adoption_verifications SET verified_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
        WHERE guild_id=${fixture.guild}`;
      expect((await read(tx, fixture)).find((row) => row.trackId === 'games')?.eligible).toBe(false);
    });
  });
  it('rejects stale and changed-boot evidence', async () => {
    await withFixture(async (tx, fixture) => {
      await check(tx, fixture);
      await tx`UPDATE public.bot_diagnostics SET boot_id='boot-next' WHERE guild_id=${fixture.guild}`;
      expect((await read(tx, fixture)).find((row) => row.trackId === 'games')?.eligible).toBe(false);
      await tx`UPDATE public.bot_diagnostics SET snapshot_at=clock_timestamp()-interval '10 minutes' WHERE guild_id=${fixture.guild}`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'unknown', eligible: false });
    });
  });
  it('does not invent required recovery proof from a working bot', async () => {
    await withFixture(async (tx, fixture) => {
      expect(await check(tx, fixture, 'recovery')).toMatchObject({ result: 'unknown', eligible: false });
    });
  });
  it('does not verify community using actions from disabled optional features', async () => {
    await withFixture(async (tx, fixture) => {
      await tx`UPDATE public.guild_config SET levels_enabled=false WHERE guild_id=${fixture.guild}`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'user','player','level.up',true,clock_timestamp())`;
      await tx`UPDATE public.bot_diagnostics SET snapshot_at=clock_timestamp() WHERE guild_id=${fixture.guild}`;
      expect(await check(tx, fixture, 'community')).toMatchObject({ result: 'unknown', eligible: false });
    });
  });
  it('does not let a newer casino success clear a failed configured lottery payout', async () => {
    await withFixture(async (tx, fixture) => {
      await tx`UPDATE public.guild_config SET economy_lottery_enabled=true WHERE guild_id=${fixture.guild}`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'system','system','lottery.drawn',true,clock_timestamp())`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'system','system','lottery.payout_failed',false,clock_timestamp())`;
      await tx`INSERT INTO public.audit_logs(guild_id,actor_type,actor_id,action,success,timestamp)
        VALUES (${fixture.guild},'user','player','casino.bet_settled',true,clock_timestamp())`;
      await tx`UPDATE public.bot_diagnostics SET snapshot_at=clock_timestamp() WHERE guild_id=${fixture.guild}`;
      expect(await check(tx, fixture)).toMatchObject({ result: 'fail', eligible: false });
    });
  });
  it('denies browser roles access to the recording boundary', async () => {
    await withFixture(async (tx, fixture) => {
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`SET LOCAL ROLE authenticated`;
        await savepoint`SELECT public.check_dashboard_adoption_track(${fixture.guild},${fixture.owner},'core',${randomUUID()}::uuid,${randomUUID()})`;
      })).rejects.toMatchObject({ code: '42501' });
    });
  });
});
