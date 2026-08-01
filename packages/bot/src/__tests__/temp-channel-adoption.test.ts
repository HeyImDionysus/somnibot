/**
 * Round 31 (P2): a temp-room worker that loses its claim to stale recovery
 * must NOT blindly delete its channels — recovery may have ADOPTED those
 * exact channels through the durable createdChannelIds, and deleting them
 * disconnected the adopted room's users and left the committed active row
 * pointing at nothing. Only a confirmed different-or-absent adoption makes
 * ours the duplicates.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  RESTJSONErrorCodes: { UnknownChannel: 10003 },
  PermissionFlagsBits: {
    ManageChannels: 4n, MoveMembers: 8n, MuteMembers: 16n, DeafenMembers: 32n,
    ViewChannel: 1n, SendMessages: 2n, ManageMessages: 64n,
  },
}));

const fence = vi.hoisted(() => ({
  claimDiscordOccurrence: vi.fn(),
  completeDiscordOccurrence: vi.fn(async () => undefined),
  failDiscordOccurrence: vi.fn(async () => undefined),
  markDiscordOccurrenceCleanupPending: vi.fn(async () => undefined),
  recordDiscordOccurrenceChannels: vi.fn(),
  reclaimStaleDiscordOccurrence: vi.fn(),
  releaseDiscordOccurrence: vi.fn(async () => undefined),
}));
vi.mock('../services/occurrence-fence.js', () => fence);

const HUB = {
  id: 'hub1', guild_id: 'g1', hub_channel_id: 'hubvc', category_id: 'cat1',
  naming_format: "{owner-name}'s room",
  default_user_limit: 0, default_bitrate: 64000,
  keep_alive_minutes: 1, empty_grace_seconds: 15,
  allow_text_channel: false, allow_claim: true,
  moderator_roles: [] as string[], active: true,
};

function makeSupa(adoptionRow: { channel_id: string } | null, adoptionError?: { message: string }) {
  function chainFor(table: string) {
    const data = table === 'temp_channel_hubs' ? [HUB] : [];
    const c: any = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'contains', 'update', 'delete', 'insert']) {
      c[m] = () => c;
    }
    c.maybeSingle = async () => (table === 'active_temp_channels'
      ? { data: adoptionRow, error: adoptionError ?? null }
      : { data: data[0] ?? null, error: null });
    c.single = async () => ({ data: data[0] ?? null, error: null });
    c.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    return c;
  }
  return {
    from: (t: string) => chainFor(t),
    // Ownership RPC: recovery already reclaimed the occurrence.
    rpc: vi.fn(async () => ({ data: false, error: null })),
  } as any;
}

function member(id = 'u1', displayName = 'Alice') {
  return {
    id, displayName,
    user: { id, username: 'alice', bot: false },
    send: vi.fn(async () => {}),
    voice: { setChannel: vi.fn(async () => {}) },
  } as any;
}

async function joinWithLostClaim(
  adoptionRow: { channel_id: string } | null,
  adoptionError?: { message: string },
) {
  fence.claimDiscordOccurrence.mockResolvedValue({
    won: true,
    occurrence: {
      id: 'f0000000-0000-4000-8000-000000000031',
      updated_at: '2026-08-01T10:00:00.000Z',
    },
  });
  fence.recordDiscordOccurrenceChannels.mockResolvedValue({
    updatedAt: '2026-08-01T10:00:05.000Z',
  });
  const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
  const vc = {
    id: 'newvc',
    name: "Alice's room",
    members: new Map(),
    delete: vi.fn(async () => undefined),
  };
  const cache = new Map<string, any>();
  const g = { id: 'g1', channels: { cache, create: vi.fn(async () => vc) } } as any;
  const supabase = makeSupa(adoptionRow, adoptionError);
  const mgr = new TempChannelManager(g, supabase);
  await mgr.start();
  await mgr.handleJoinHub(member(), 'hubvc', 'join-occurrence-1');
  return { vc, g, supabase };
}

describe('temp-room lost claim vs recovery adoption', () => {
  it('preserves channels that recovery ADOPTED (active row points at our room)', async () => {
    const { vc, g } = await joinWithLostClaim({ channel_id: 'newvc' });
    expect(g.channels.create).toHaveBeenCalled();
    expect(vc.delete).not.toHaveBeenCalled();
  });

  it('preserves channels when the adoption read is unresolved', async () => {
    const { vc, g } = await joinWithLostClaim(null, { message: 'db down' });
    expect(g.channels.create).toHaveBeenCalled();
    expect(vc.delete).not.toHaveBeenCalled();
  });

  it('removes true duplicates when no adoption row exists', async () => {
    const { vc, g, supabase } = await joinWithLostClaim(null);
    expect(g.channels.create).toHaveBeenCalled();
    // The full ownership flow actually ran: claim, record, ownership RPC.
    expect(fence.recordDiscordOccurrenceChannels).toHaveBeenCalled();
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]))
      .toContain('insert_owned_temp_channel');
    expect(vc.delete).toHaveBeenCalled();
  });
});
