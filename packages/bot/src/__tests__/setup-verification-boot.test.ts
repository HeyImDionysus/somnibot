/**
 * Setup-Verification Boot — unit tests (Wave 3 setup gate).
 *
 * The 'in_progress' gate path must bring the bot online *just enough* for the
 * dashboard setup wizard to verify it: write the `guild` row (for "guild
 * detected") and start the bot-level heartbeat + a `health` diagnostic (for
 * "bot online", including the Supabase fallback). It must NOT run the heavy
 * per-guild feature init.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Capture HeartbeatService construction + start/stop.
const heartbeatStart = vi.fn();
const heartbeatStop = vi.fn();
const heartbeatCtor = vi.fn();
vi.mock('../services/heartbeat.js', () => ({
  HeartbeatService: class {
    constructor(...args: unknown[]) {
      heartbeatCtor(...args);
    }
    start() {
      heartbeatStart();
    }
    stop() {
      heartbeatStop();
    }
  },
}));

import {
  writeGuildRecord,
  runSetupVerificationBoot,
  writeVerificationHealthSnapshot,
} from '../services/setup-verification-boot.js';

function makeGuild(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Guild ${id}`,
    ownerId: `owner-${id}`,
    members: {
      me: { roles: { highest: { position: 7 } } },
      fetchMe: vi.fn(),
    },
    roles: { cache: { size: 12 } },
    ...overrides,
  } as any;
}

/**
 * Supabase stub that records upserts per-table so tests can assert both the
 * `guild` row and the `bot_diagnostics` health row were written.
 */
function makeSupabase() {
  const calls: Array<{ table: string; row: any; opts: any }> = [];
  const supabase = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn((row: any, opts: any) => {
        calls.push({ table, row, opts });
        return Promise.resolve({ error: null });
      }),
    })),
  } as any;
  const rowsFor = (table: string) => calls.filter((c) => c.table === table).map((c) => c.row);
  return { supabase, calls, rowsFor };
}

describe('writeGuildRecord', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts the guild row the wizard reads for "guild detected"', async () => {
    const { supabase, rowsFor } = makeSupabase();
    await writeGuildRecord(makeGuild('g1'), supabase);

    expect(supabase.from).toHaveBeenCalledWith('guild');
    expect(rowsFor('guild')[0]).toEqual(
      expect.objectContaining({
        id: 'g1',
        name: 'Guild g1',
        owner_discord_id: 'owner-g1',
        bot_role_position: 7,
        total_roles: 12,
      }),
    );
  });

  it('fetches the bot member when it is not cached, then writes the row', async () => {
    const { supabase, rowsFor } = makeSupabase();
    const guild = makeGuild('g1');
    guild.members.me = null;
    guild.members.fetchMe = vi.fn().mockResolvedValue({ roles: { highest: { position: 4 } } });

    await writeGuildRecord(guild, supabase);

    expect(guild.members.fetchMe).toHaveBeenCalledTimes(1);
    // Row is still written (not skipped), with the fetched member's position.
    expect(rowsFor('guild')[0]).toEqual(
      expect.objectContaining({ id: 'g1', bot_role_position: 4 }),
    );
  });

  it('still writes the guild row with a null bot_role_position when the member cannot be resolved', async () => {
    const { supabase, rowsFor } = makeSupabase();
    const guild = makeGuild('g1');
    guild.members.me = null;
    // fetchMe rejects (e.g. missing perms / not yet chunked) — must not skip the row.
    guild.members.fetchMe = vi.fn().mockRejectedValue(new Error('not available'));

    await writeGuildRecord(guild, supabase);

    expect(guild.members.fetchMe).toHaveBeenCalledTimes(1);
    const rows = rowsFor('guild');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ id: 'g1', bot_role_position: null, total_roles: 12 }),
    );
  });
});

describe('runSetupVerificationBoot', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeClient(guilds: any[], guildId = '') {
    // discord.js exposes guilds.cache as a Collection (Map + .first()); mirror
    // the bits runSetupVerificationBoot uses.
    const cache = new Map(guilds.map((g) => [g.id, g])) as Map<string, any> & {
      first: () => any;
    };
    cache.first = () => guilds[0];
    const { supabase, rowsFor } = makeSupabase();
    const client = {
      guildId,
      supabase,
      valkey: {},
      guilds: { cache },
    } as any;
    return { client, rowsFor };
  }

  it('writes guild records and starts the heartbeat so the wizard can verify the bot', async () => {
    const { client, rowsFor } = makeClient([makeGuild('g1')], 'g1');
    const services = await runSetupVerificationBoot(client);

    expect(rowsFor('guild')).toHaveLength(1);
    expect(heartbeatStart).toHaveBeenCalledTimes(1);
    expect(services).not.toBeNull();
    expect(services!.heartbeat).toBeDefined();
    // Heartbeat is constructed with the primary guild id.
    expect(heartbeatCtor).toHaveBeenCalledWith(client.valkey, client.supabase, 'g1', client);
  });

  it('writes a `health` diagnostic row so the wizard Supabase readiness fallback works without Valkey', async () => {
    const { client, rowsFor } = makeClient([makeGuild('g1')], 'g1');
    await runSetupVerificationBoot(client);

    const healthRows = rowsFor('bot_diagnostics').filter((r) => r.type === 'health');
    expect(healthRows.length).toBeGreaterThanOrEqual(1);
    expect(healthRows[0]).toEqual(
      expect.objectContaining({ guild_id: 'g1', type: 'health' }),
    );
    expect(typeof healthRows[0].snapshot_at).toBe('string');
  });

  // ── Codex round-2 finding #3: health for the CONFIGURED guild ──
  // The setup route reads bot_diagnostics health for the configured guild id,
  // which is NOT necessarily the primary/first guild when the bot is already
  // in several guilds. Writing health only for the primary would leave a
  // non-primary configured guild marked offline whenever Valkey is down (the
  // exact outage this Supabase fallback covers). We write a row per current
  // guild so the configured one is always covered.
  it('writes a `health` row for EVERY current guild (covers a non-primary configured guild)', async () => {
    // Primary is g1, but the owner may be configuring g2 — both must get health.
    const { client, rowsFor } = makeClient([makeGuild('g1'), makeGuild('g2')], 'g1');
    await runSetupVerificationBoot(client);

    const healthGuildIds = new Set(
      rowsFor('bot_diagnostics').filter((r) => r.type === 'health').map((r) => r.guild_id),
    );
    expect(healthGuildIds.has('g1')).toBe(true);
    expect(healthGuildIds.has('g2')).toBe(true);
  });

  // ── Codex round-2 finding #3: stop refreshing after removal ──
  // The refresher re-reads client.guilds.cache each tick, so a guild the bot
  // has been removed from (dropped from the cache, e.g. via guildDelete) stops
  // getting fresh health rows — its last row goes stale and the readiness
  // check no longer trusts it, preventing a "finalized but bot not present"
  // instance.
  it('stops refreshing health for a guild the bot has been removed from', async () => {
    vi.useFakeTimers();
    try {
      const guilds = new Map([['g1', makeGuild('g1')], ['g2', makeGuild('g2')]]) as any;
      guilds.first = () => guilds.get('g1');
      const { supabase, rowsFor } = makeSupabase();
      const client = { guildId: 'g1', supabase, valkey: {}, guilds: { cache: guilds } } as any;

      const services = await runSetupVerificationBoot(client);
      // Immediate write covered both guilds.
      expect(new Set(rowsFor('bot_diagnostics').map((r) => r.guild_id))).toEqual(new Set(['g1', 'g2']));

      // Bot removed from g2 (as guildDelete would do) — drop it from the cache.
      guilds.delete('g2');

      // Advance past one refresh interval (60s).
      await vi.advanceTimersByTimeAsync(60_000);

      const g2RowsAfter = rowsFor('bot_diagnostics').filter((r) => r.guild_id === 'g2').length;
      const g1RowsAfter = rowsFor('bot_diagnostics').filter((r) => r.guild_id === 'g1').length;
      // g1 got at least one more refresh; g2 got no NEW rows after removal
      // (still just the single pre-removal write).
      expect(g1RowsAfter).toBeGreaterThanOrEqual(2);
      expect(g2RowsAfter).toBe(1);

      services!.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-detects the primary guild id when not preset', async () => {
    const { client } = makeClient([makeGuild('gX')]);
    await runSetupVerificationBoot(client);
    expect(client.guildId).toBe('gX');
    expect(heartbeatCtor).toHaveBeenCalledWith(client.valkey, client.supabase, 'gX', client);
  });

  // ── Codex round-3 finding #4: persist the auto-detected guild ──
  // The dashboard setup route resolves the configured guild via
  // getConfiguredDiscordGuildId, which — when DISCORD_GUILD_ID is unset (exactly
  // this auto-detect case) — falls back to instance_settings.discord_guild_id
  // and returns guildDetected:false when that is null. So a pure
  // invite-and-detect setup would stay blocked even though the `guild` row was
  // written. Persisting the detected id closes that gap.
  it('persists the auto-detected guild id to instance_settings.discord_guild_id', async () => {
    const { client, rowsFor } = makeClient([makeGuild('gX')]);
    await runSetupVerificationBoot(client);

    const settingsRows = rowsFor('instance_settings');
    const guildIdRow = settingsRows.find((r) => r.key === 'discord_guild_id');
    expect(guildIdRow).toBeDefined();
    expect(guildIdRow).toEqual(
      expect.objectContaining({ key: 'discord_guild_id', value: 'gX', section: 'discord' }),
    );
  });

  it('does NOT overwrite instance_settings.discord_guild_id when the guild is already configured', async () => {
    // guildId preset (DISCORD_GUILD_ID configured) → no auto-detect, so we must
    // not clobber the configured value with a write here.
    const { client, rowsFor } = makeClient([makeGuild('g1')], 'g1');
    await runSetupVerificationBoot(client);

    const settingsRows = rowsFor('instance_settings');
    expect(settingsRows.find((r) => r.key === 'discord_guild_id')).toBeUndefined();
  });

  it('returns null and does not start a heartbeat when no guild is present', async () => {
    const { client, rowsFor } = makeClient([]);
    const services = await runSetupVerificationBoot(client);
    expect(rowsFor('guild')).toHaveLength(0);
    expect(heartbeatStart).not.toHaveBeenCalled();
    expect(services).toBeNull();
  });

  // ── Codex round-3 finding #3: immediate health for a newly-invited guild ──
  // On the guildCreate verification path, when a heartbeat already exists (an
  // earlier guild started verification), runSetupVerificationBoot is NOT re-run,
  // so the periodic refresher would not cover the new guild until its next 60s
  // tick. index.ts writes an immediate snapshot via this exported helper so the
  // setup route's Supabase fallback can see the guild online right after the
  // invite (Valkey-down case). This asserts the helper writes the health row the
  // readiness check reads.
  it('writeVerificationHealthSnapshot upserts an immediate health row for one guild', async () => {
    const { supabase, rowsFor } = makeSupabase();
    await writeVerificationHealthSnapshot(supabase, 'g-new');

    expect(supabase.from).toHaveBeenCalledWith('bot_diagnostics');
    const rows = rowsFor('bot_diagnostics');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ guild_id: 'g-new', type: 'health' }),
    );
    expect(typeof rows[0].snapshot_at).toBe('string');
  });

  it('stop() halts both the heartbeat and the health-snapshot refresher', async () => {
    const { client } = makeClient([makeGuild('g1')], 'g1');
    const services = await runSetupVerificationBoot(client);
    expect(services).not.toBeNull();
    // Should not throw and must stop the underlying heartbeat.
    services!.stop();
    expect(heartbeatStop).toHaveBeenCalledTimes(1);
  });
});
