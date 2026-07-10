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

import { writeGuildRecord, runSetupVerificationBoot } from '../services/setup-verification-boot.js';

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

  it('auto-detects the primary guild id when not preset', async () => {
    const { client } = makeClient([makeGuild('gX')]);
    await runSetupVerificationBoot(client);
    expect(client.guildId).toBe('gX');
    expect(heartbeatCtor).toHaveBeenCalledWith(client.valkey, client.supabase, 'gX', client);
  });

  it('returns null and does not start a heartbeat when no guild is present', async () => {
    const { client, rowsFor } = makeClient([]);
    const services = await runSetupVerificationBoot(client);
    expect(rowsFor('guild')).toHaveLength(0);
    expect(heartbeatStart).not.toHaveBeenCalled();
    expect(services).toBeNull();
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
