/**
 * M3/36 — replayed infraction writes must NOT re-run side effects.
 *
 * createInfraction dedupes a re-delivered command on its correlation key and
 * returns { infraction, replayed: true }. The residual bug: callers ignored
 * the replay and re-DMed the member, re-posted the mod log, and RE-RAN
 * ESCALATION (issuing a second timeout/kick/ban). These tests pin the
 * early-return of the whole side-effect block on replay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  SlashCommandBuilder: vi.fn(),
  EmbedBuilder: vi.fn().mockImplementation(function () {
    const e: any = {};
    for (const m of ['setColor', 'setTitle', 'setDescription', 'setFooter', 'setTimestamp', 'addFields', 'setAuthor', 'setThumbnail']) {
      e[m] = vi.fn().mockReturnValue(e);
    }
    return e;
  }),
  PermissionFlagsBits: { ModerateMembers: 1n << 40n, KickMembers: 1n << 1n, BanMembers: 1n << 2n },
}));

vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { ORANGE: 0xffa500, RED: 0xff0000, GREEN: 0x00ff00, BLUE: 0x0000ff },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockCreateInfraction = vi.fn();
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: (...args: unknown[]) => mockCreateInfraction(...args),
  getMemberInfractions: vi.fn().mockResolvedValue([]),
  getActiveWarningCount: vi.fn().mockResolvedValue(3),
  pardonInfraction: vi.fn().mockResolvedValue(true),
  calculateExpiryDate: vi.fn().mockReturnValue('2026-08-01'),
}));

vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn().mockResolvedValue(undefined),
  getEscalationAction: vi.fn().mockReturnValue({ action: 'mute', durationMinutes: 60 }),
}));

vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../features/branding/brand-kit.js', () => ({
  resolveBrandKit: vi.fn().mockResolvedValue({
    primaryColor: 0x123456,
    accentColor: 0x123456,
    brandName: 'Test',
    poweredByAttribution: null,
  }),
}));

import {
  handleWarnCommand,
  handleMuteCommand,
  handleKickCommand,
  handleBanCommand,
} from '../features/moderation/commands.js';
import { executeEscalation } from '../features/moderation/escalation.js';
import { postModLogEntry } from '../features/moderation/mod-log.js';

// ── Harness (mirrors moderation-commands-coverage.test.ts) ──

function chain(val: any = { data: null, error: null }) {
  const c: any = {};
  for (const m of ['select', 'eq', 'maybeSingle', 'single', 'insert', 'update', 'order', 'limit', 'in']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: any) => Promise.resolve(val).then(res);
  return c;
}

function client() {
  return {
    supabase: {
      from: vi.fn().mockReturnValue(chain({
        data: { escalation_chain: [{ threshold: 3, action: 'mute' }], infraction_expiry_days: 30, mod_log_channel_id: 'ch1' },
        error: null,
      })),
    },
    eventBus: { emit: vi.fn() },
  };
}

function member() {
  const dmSend = vi.fn().mockResolvedValue(undefined);
  return {
    id: 'target1',
    user: {
      id: 'target1',
      tag: 'Target#0001',
      bot: false,
      createDM: vi.fn().mockResolvedValue({ send: dmSend }),
    },
    roles: { highest: { position: 5 } },
    moderatable: true,
    kickable: true,
    bannable: true,
    timeout: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    dmSend,
  };
}

function interaction(target = member()) {
  const invoker = { ...member(), id: 'mod1', roles: { highest: { position: 10 } } };
  return {
    options: {
      getMember: vi.fn().mockReturnValue(target),
      getUser: vi.fn().mockReturnValue(target.user),
      getString: vi.fn().mockReturnValue('Test reason'),
      getInteger: vi.fn().mockReturnValue(60),
      getBoolean: vi.fn().mockReturnValue(null),
    },
    user: { id: 'mod1', tag: 'Mod#0001' },
    guild: {
      id: 'g1',
      name: 'Test Guild',
      ownerId: 'owner1',
      members: {
        fetch: vi.fn().mockImplementation(async (id: string) => (id === 'mod1' ? invoker : target)),
      },
    },
    guildId: 'g1',
    id: 'interaction-replayed',
    memberPermissions: { has: vi.fn().mockReturnValue(true) },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    target,
  };
}

const REPLAYED = { infraction: { id: 'inf-original', type: 'warn' }, replayed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateInfraction.mockResolvedValue(REPLAYED);
});

// ── Tests ────────────────────────────────────────────────────

describe('replayed /warn', () => {
  it('passes interaction.id as the correlation key', async () => {
    const i = interaction();
    await handleWarnCommand(i as any, client() as any);
    expect(mockCreateInfraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ correlationId: 'interaction-replayed' }),
    );
  });

  it('skips DM, mod log, events, and ESCALATION on replay', async () => {
    const c = client();
    const i = interaction();
    await handleWarnCommand(i as any, c as any);

    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('already recorded'));
    expect(i.target.user.createDM).not.toHaveBeenCalled();
    expect(postModLogEntry).not.toHaveBeenCalled();
    expect(executeEscalation).not.toHaveBeenCalled();
    expect(c.eventBus.emit).not.toHaveBeenCalled();
  });

  it('a FRESH warn still runs the side-effect block (control)', async () => {
    mockCreateInfraction.mockResolvedValue({ infraction: { id: 'inf-new', type: 'warn' }, replayed: false });
    const c = client();
    const i = interaction();
    await handleWarnCommand(i as any, c as any);

    expect(postModLogEntry).toHaveBeenCalled();
    expect(executeEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.anything(),
      'inf-new',
    );
    expect(c.eventBus.emit).toHaveBeenCalled();
  });
});

describe('replayed /mute', () => {
  it('skips DM, mod log, and events on replay', async () => {
    const c = client();
    const i = interaction();
    await handleMuteCommand(i as any, c as any);

    expect(mockCreateInfraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'mute', correlationId: 'interaction-replayed' }),
    );
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('already recorded'));
    expect(i.target.user.createDM).not.toHaveBeenCalled();
    expect(postModLogEntry).not.toHaveBeenCalled();
    expect(c.eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('replayed /kick', () => {
  it('skips mod log and events on replay', async () => {
    const c = client();
    const i = interaction();
    await handleKickCommand(i as any, c as any);

    expect(mockCreateInfraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'kick', correlationId: 'interaction-replayed' }),
    );
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('already recorded'));
    expect(postModLogEntry).not.toHaveBeenCalled();
    expect(c.eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('replayed /ban', () => {
  it('skips entitlement suspension, mod log, and events on replay', async () => {
    const c = client();
    const i = interaction();
    await handleBanCommand(i as any, c as any);

    expect(mockCreateInfraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'ban', correlationId: 'interaction-replayed' }),
    );
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining('already recorded'));
    expect(postModLogEntry).not.toHaveBeenCalled();
    expect(c.eventBus.emit).not.toHaveBeenCalled();
    // The customers/entitlements suspension lookup must not run on replay:
    // only the guild_config read may have hit the database.
    const tables = (c.supabase.from as any).mock.calls.map((call: any[]) => call[0]);
    expect(tables).not.toContain('customers');
    expect(tables).not.toContain('entitlements');
  });
});
