/**
 * Setup-Verification Boot — unit tests (Wave 3 setup gate).
 *
 * The 'in_progress' gate path must bring the bot online *just enough* for the
 * dashboard setup wizard to verify it: write the `guild` row (for "guild
 * detected") and start the bot-level heartbeat (for "bot online"). It must NOT
 * run the heavy per-guild feature init.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Capture HeartbeatService construction + start.
const heartbeatStart = vi.fn();
const heartbeatCtor = vi.fn();
vi.mock('../services/heartbeat.js', () => ({
  HeartbeatService: class {
    constructor(...args: unknown[]) {
      heartbeatCtor(...args);
    }
    start() {
      heartbeatStart();
    }
    stop() {}
  },
}));

import { writeGuildRecord, runSetupVerificationBoot } from '../services/setup-verification-boot.js';

function makeGuild(id: string) {
  return {
    id,
    name: `Guild ${id}`,
    ownerId: `owner-${id}`,
    members: { me: { roles: { highest: { position: 7 } } } },
    roles: { cache: { size: 12 } },
  } as any;
}

function makeSupabase() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const supabase = {
    from: vi.fn(() => ({ upsert })),
  } as any;
  return { supabase, upsert };
}

describe('writeGuildRecord', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts the guild row the wizard reads for "guild detected"', async () => {
    const { supabase, upsert } = makeSupabase();
    await writeGuildRecord(makeGuild('g1'), supabase);

    expect(supabase.from).toHaveBeenCalledWith('guild');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'g1',
        name: 'Guild g1',
        owner_discord_id: 'owner-g1',
        bot_role_position: 7,
        total_roles: 12,
      }),
      { onConflict: 'id' },
    );
  });

  it('skips the write when the bot member is not resolved yet', async () => {
    const { supabase, upsert } = makeSupabase();
    const guild = makeGuild('g1');
    guild.members.me = null;
    await writeGuildRecord(guild, supabase);
    expect(upsert).not.toHaveBeenCalled();
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
    const { supabase, upsert } = makeSupabase();
    const client = {
      guildId,
      supabase,
      valkey: {},
      guilds: { cache },
    } as any;
    return { client, upsert };
  }

  it('writes guild records and starts the heartbeat so the wizard can verify the bot', async () => {
    const { client, upsert } = makeClient([makeGuild('g1')], 'g1');
    const hb = await runSetupVerificationBoot(client);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(heartbeatStart).toHaveBeenCalledTimes(1);
    expect(hb).not.toBeNull();
    // Heartbeat is constructed with the primary guild id.
    expect(heartbeatCtor).toHaveBeenCalledWith(client.valkey, client.supabase, 'g1', client);
  });

  it('auto-detects the primary guild id when not preset', async () => {
    const { client } = makeClient([makeGuild('gX')]);
    await runSetupVerificationBoot(client);
    expect(client.guildId).toBe('gX');
    expect(heartbeatCtor).toHaveBeenCalledWith(client.valkey, client.supabase, 'gX', client);
  });

  it('returns null and does not start a heartbeat when no guild is present', async () => {
    const { client, upsert } = makeClient([]);
    const hb = await runSetupVerificationBoot(client);
    expect(upsert).not.toHaveBeenCalled();
    expect(heartbeatStart).not.toHaveBeenCalled();
    expect(hb).toBeNull();
  });
});
