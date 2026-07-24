/**
 * ticket-service — panel-configured inactivity thresholds + feedback-prompt gate.
 * Guards the fleet finding: inactivity-warn-hours / inactivity-close-hours /
 * feedback-prompt-enabled were inert (no wiring).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('discord.js', () => {
  class Chainable {
    setCustomId() { return this; }
    setLabel() { return this; }
    setEmoji() { return this; }
    setStyle() { return this; }
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
    addComponents() { return this; }
  }
  return {
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n },
    ButtonBuilder: Chainable,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ActionRowBuilder: Chainable,
    EmbedBuilder: Chainable,
  };
});

vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { CYAN: 0x00FFFF, ORANGE: 0xFFA500, HOT_PINK: 0xFF69B4 },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { checkInactiveTickets, closeTicket } from '../features/tickets/ticket-service.js';

// ── checkInactiveTickets ────────────────────────────────────────────────────

function inactivitySupabase(openTickets: any[], panels: any[]) {
  return {
    from: vi.fn((table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update']) chain[m] = vi.fn(() => chain);
      const data = table === 'ticket_panels' ? panels : openTickets;
      chain.then = (res: any) => Promise.resolve({ data, error: null }).then(res);
      return chain;
    }),
  } as any;
}

function guildWithChannel(channelId: string, channel: any) {
  return {
    id: 'g1',
    channels: { cache: new Map([[channelId, channel]]) },
    client: { user: { id: 'bot' } },
    members: { fetch: vi.fn(async () => ({ id: 'u1' })) },
  } as any;
}

describe('checkInactiveTickets — per-panel thresholds', () => {
  it('warns at 90 min idle when the panel sets warn=1h (default 24h would not)', async () => {
    const now = Date.now();
    const idle = new Date(now - 90 * 60 * 1000).toISOString(); // 90 min ago
    const ticket = {
      id: 't1', channel_id: 'c1', ticket_number: 5, panel_id: 'p1',
      status: 'open', creator_id: 'u1', inactivity_warned: false,
      updated_at: idle, created_at: idle,
    };
    const panels = [{ id: 'p1', inactivity_warn_hours: 1, inactivity_close_hours: 48 }];
    const send = vi.fn(async () => {});
    const supabase = inactivitySupabase([ticket], panels);
    const res = await checkInactiveTickets(supabase, guildWithChannel('c1', { send }), { emit: vi.fn() } as any);
    expect(res.warned).toBe(1);
    expect(res.closed).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn at 90 min idle when no panel override exists (24h default)', async () => {
    const now = Date.now();
    const idle = new Date(now - 90 * 60 * 1000).toISOString();
    const ticket = {
      id: 't1', channel_id: 'c1', ticket_number: 5, panel_id: 'p1',
      status: 'open', creator_id: 'u1', inactivity_warned: false,
      updated_at: idle, created_at: idle,
    };
    const send = vi.fn(async () => {});
    const supabase = inactivitySupabase([ticket], []); // no panels → 24h/48h fallback
    const res = await checkInactiveTickets(supabase, guildWithChannel('c1', { send }), { emit: vi.fn() } as any);
    expect(res.warned).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

// ── closeTicket feedback gate ───────────────────────────────────────────────

function closeSupabase(ticket: any, panel: any) {
  return {
    from: vi.fn((table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'update']) chain[m] = vi.fn(() => chain);
      chain.single = vi.fn(async () => ({ data: table === 'ticket_panels' ? panel : ticket, error: null }));
      chain.then = (res: any) => Promise.resolve({ error: null }).then(res);
      return chain;
    }),
  } as any;
}

function closeGuild(channel: any) {
  return {
    id: 'g1',
    channels: { cache: new Map([['c1', channel]]) },
    members: { fetch: vi.fn(async () => ({ id: 'u1' })) },
  } as any;
}

const openTicket = { id: 't1', channel_id: 'c1', ticket_number: 7, panel_id: 'p1', status: 'open', creator_id: 'u1' };

describe('closeTicket — feedback-prompt gate', () => {
  it('skips the feedback prompt when the panel disables it (only the close embed posts)', async () => {
    const channel = {
      permissionOverwrites: { edit: vi.fn(async () => {}) },
      send: vi.fn(async () => {}),
      setParent: vi.fn(async () => {}),
    };
    const supabase = closeSupabase(openTicket, { closed_category_id: null, feedback_prompt_enabled: false });
    const res = await closeTicket(closeGuild(channel), supabase, { emit: vi.fn() } as any, 7, 'staff1');
    expect(res.success).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(1); // close embed only, no feedback
  });

  it('posts the feedback prompt when enabled (close embed + feedback)', async () => {
    const channel = {
      permissionOverwrites: { edit: vi.fn(async () => {}) },
      send: vi.fn(async () => {}),
      setParent: vi.fn(async () => {}),
    };
    const supabase = closeSupabase(openTicket, { closed_category_id: null, feedback_prompt_enabled: true });
    const res = await closeTicket(closeGuild(channel), supabase, { emit: vi.fn() } as any, 7, 'staff1');
    expect(res.success).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(2); // close embed + feedback prompt
  });
});
