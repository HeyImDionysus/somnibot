import { randomUUID } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

type AdoptionFixture = {
  readonly guildId: string;
  readonly ownerId: string;
};

async function withAdoptionFixture(
  verify: (tx: TransactionSql, fixture: AdoptionFixture) => Promise<void>,
): Promise<void> {
  await requireSupabase();
  const sql = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const rollback = new Error('rollback completed adoption fixture');
  const fixture = {
    guildId: `test-adoption-games-${randomUUID()}`,
    ownerId: '900000000000000123',
  };
  try {
    await expect(sql.begin(async (tx) => {
      // Given an isolated owner guild and the service role used by the production route.
      await tx`INSERT INTO public.guild (id, name, owner_discord_id)
        VALUES (${fixture.guildId}, 'Games adoption integration fixture', ${fixture.ownerId})`;
      await tx`SET LOCAL ROLE service_role`;

      await verify(tx, fixture);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally {
    await sql.end();
  }
}

describe('real database games adoption track', () => {
  it('publishes verified games independently of economy and returns authoritative readback', async () => {
    await withAdoptionFixture(async (tx, fixture) => {
      // Given durable runtime source fixtures, never pre-authored adoption pass rows.
      await tx`INSERT INTO public.guild_config(guild_id, economy_enabled, economy_games_enabled, economy_lottery_enabled)
        VALUES (${fixture.guildId}, true, true, false)`;
      await tx`INSERT INTO public.audit_logs(guild_id, actor_type, actor_id, action, success, timestamp, details)
        VALUES (${fixture.guildId}, 'system', 'system', 'bot.started', true, clock_timestamp(), '{"bootId":"adoption-boot"}'::jsonb),
          (${fixture.guildId}, 'user', 'player', 'casino.bet_settled', true, clock_timestamp(), '{}'::jsonb)`;
      await tx`INSERT INTO public.bot_diagnostics(guild_id, type, boot_id, uptime_seconds, valkey_connected, discord_ws_ping, snapshot_at)
        VALUES (${fixture.guildId}, 'health', 'adoption-boot', 0, true, 25, clock_timestamp())`;
      for (const track of ['core', 'games']) {
        await tx`SELECT public.check_dashboard_adoption_track(${fixture.guildId}, ${fixture.ownerId}, ${track}, ${randomUUID()}::uuid, ${randomUUID()})`;
      }

      // When the supported publisher activates the independently selected games track.
      const [published] = await tx<{ result: {
        readonly state: {
          readonly selectedTrackIds: readonly string[];
          readonly verifiedTrackIds: readonly string[];
          readonly trackStates: Record<string, string>;
        };
      } }[]>`SELECT public.publish_dashboard_adoption_map(
        ${randomUUID()}::uuid,
        ${fixture.guildId},
        ${fixture.ownerId},
        ${randomUUID()},
        ${JSON.stringify({
          mode: 'guided',
          tutorialVisible: true,
          selectedTrackIds: ['core', 'recovery', 'games'],
          trackStates: { core: 'active', games: 'active' },
        })}::jsonb
      ) AS result`;

      // Then only core and games are active, and games proof is derived from the service evidence table.
      expect(published?.result.state).toMatchObject({
        selectedTrackIds: ['core', 'recovery', 'games'],
        verifiedTrackIds: expect.arrayContaining(['core', 'games']),
        trackStates: { core: 'active', games: 'active' },
      });
      const [saved] = await tx<{
        readonly selectedTrackIds: readonly string[];
        readonly gamesState: string | null;
        readonly economyState: string | null;
      }[]>`SELECT selected_track_ids AS "selectedTrackIds",
          track_states->>'games' AS "gamesState",
          track_states->>'economy' AS "economyState"
        FROM public.dashboard_adoption_maps
       WHERE guild_id = ${fixture.guildId}`;
      expect(saved).toEqual({
        selectedTrackIds: ['core', 'recovery', 'games'],
        gamesState: 'active',
        economyState: null,
      });
    });
  });
});
