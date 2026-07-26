/**
 * Setup-verification boot ↔ setup-wizard "bot online" contract (Wave 3 gate).
 *
 * The dashboard setup wizard's finalize step calls getOwnerRuntimeReadiness,
 * which accepts the bot as "online" when the bot-level Valkey heartbeat
 * (`somnibot:heartbeat:bot`) is fresh AND its `guildIds` includes the
 * configured guild (see packages/dashboard/src/app/api/setup/route.ts
 * ::isBotLevelHeartbeatOnline).
 *
 * This test uses the REAL HeartbeatService (no mock) to prove that the
 * verification-only boot writes exactly that key/payload — i.e. the wizard's
 * bot-online check still works while setup is in progress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Collection } from 'discord.js';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runSetupVerificationBoot } from '../services/setup-verification-boot.js';

const BOT_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
const BOT_HEARTBEAT_STALE_MS = 120_000;

/** Mirror of the dashboard wizard's bot-online predicate over the raw payload. */
function wizardConsidersBotOnline(rawPayload: string, configuredGuildId: string): boolean {
  const hb = JSON.parse(rawPayload) as { timestamp?: unknown; guildIds?: unknown };
  const timestamp = typeof hb.timestamp === 'number' ? hb.timestamp : Number(hb.timestamp);
  const guildIds = Array.isArray(hb.guildIds)
    ? hb.guildIds.filter((id): id is string => typeof id === 'string')
    : [];
  return (
    Number.isFinite(timestamp) &&
    Date.now() - timestamp < BOT_HEARTBEAT_STALE_MS &&
    guildIds.includes(configuredGuildId)
  );
}

describe('setup verification boot → wizard bot-online contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a heartbeat the wizard accepts as "bot online" for the configured guild', async () => {
    const valkeySet = vi.fn().mockResolvedValue('OK');
    const guildUpsert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      guildId: 'guild-1',
      supabase: { from: vi.fn(() => ({ upsert: guildUpsert })) },
      valkey: { set: valkeySet },
      guilds: {
        cache: new Collection<string, any>([
          [
            'guild-1',
            {
              id: 'guild-1',
              name: 'Configured Guild',
              ownerId: 'owner-1',
              members: { me: { roles: { highest: { position: 3 } } } },
              roles: { cache: { size: 5 } },
            },
          ],
        ]),
      },
    } as any;

    const hb = await runSetupVerificationBoot(client);

    // Heartbeat wrote the bot-level Valkey key with a TTL.
    expect(valkeySet).toHaveBeenCalled();
    const [key, payload, exFlag, ttl] = valkeySet.mock.calls[0];
    expect(key).toBe(BOT_HEARTBEAT_KEY);
    expect(exFlag).toBe('EX');
    expect(ttl).toBeGreaterThan(0);

    // The wizard's own predicate accepts this payload for the configured guild.
    expect(wizardConsidersBotOnline(payload, 'guild-1')).toBe(true);
    // And rejects it for a guild the bot is not in.
    expect(wizardConsidersBotOnline(payload, 'some-other-guild')).toBe(false);

    hb?.stop();
  });
});
