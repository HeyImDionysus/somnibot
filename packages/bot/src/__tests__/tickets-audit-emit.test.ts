/**
 * observability-gap [moderation-tickets-transcripts]:
 * Ticket create/transcript failure branches raised no owner alert and emitted no
 * failure audit event.
 *
 * These tests spy the eventBus + alerts insert and assert createTicket emits
 * 'ticket.create_failed' (+ owner alert) on the channel-create and db-save
 * failure branches, and generateTranscript emits 'ticket.transcript_failed'
 * (+ owner alert) on the db-save and generation-exception branches.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async () => {
  const actual = await vi.importActual<any>('@somnibot/shared');
  return { ...actual, createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});
vi.mock('../features/branding/brand-kit.js', () => ({
  resolveBrandKit: vi.fn(async () => ({ primaryColor: 0x1, accentColor: 0x2, poweredByAttribution: null })),
}));

import { createTicket } from '../features/tickets/ticket-service.js';
import { generateTranscript } from '../features/tickets/transcript-generator.js';

function makeCreateSupa({ ticketRow = null as any, ticketError = null as any } = {}) {
  const alertsInsert = vi.fn(async () => ({ error: null }));
  const tChain: any = {};
  for (const m of ['select', 'eq', 'in', 'insert', 'update', 'order', 'limit']) tChain[m] = vi.fn(() => tChain);
  tChain.single = vi.fn(async () => ({ data: ticketRow, error: ticketError }));
  tChain.maybeSingle = vi.fn(async () => ({ data: ticketRow, error: ticketError }));
  tChain.then = (res: Function) => res({ data: [], error: null, count: 0 });
  return {
    from: vi.fn((t: string) => (t === 'alerts' ? { insert: alertsInsert } : tChain)),
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    _alertsInsert: alertsInsert,
  } as any;
}

const panel = { id: 'panel-1', max_open_per_user: 5, open_category_id: null, manager_roles: [], introduction_message: null } as any;
const ticketType = { id: 't1', label: 'Support', categoryOverride: null, managerRoleOverride: null, introMessageOverride: null } as any;
const member = { id: 'u1', user: { username: 'user', tag: 'user#0001' } } as any;

function makeGuild(createImpl: any) {
  return {
    id: 'g1', name: 'G',
    members: { me: { id: 'bot' } },
    channels: { create: createImpl, cache: new Map() },
  } as any;
}

describe('ticket creation failure observability', () => {
  it('emits ticket.create_failed + owner alert when channel creation fails', async () => {
    const emit = vi.fn();
    const supa = makeCreateSupa();
    const guild = makeGuild(vi.fn().mockRejectedValue(new Error('Missing Permissions')));

    const result = await createTicket(guild, member, panel, ticketType, supa, { emit } as any);

    expect('error' in result).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'ticket.create_failed',
      'g1',
      expect.objectContaining({ userDiscordId: 'u1', panelId: 'panel-1', stage: 'channel_create' }),
    );
    expect(supa._alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ guild_id: 'g1', alert_type: 'ticket_create_failed' }),
    );
  });

  it('emits ticket.create_failed + owner alert when the ticket DB save fails', async () => {
    const emit = vi.fn();
    const supa = makeCreateSupa({ ticketRow: null, ticketError: { message: 'insert boom' } });
    const channel = { id: 'tc1', send: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}) };
    const guild = makeGuild(vi.fn().mockResolvedValue(channel));

    const result = await createTicket(guild, member, panel, ticketType, supa, { emit } as any);

    expect('error' in result).toBe(true);
    expect(channel.delete).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'ticket.create_failed',
      'g1',
      expect.objectContaining({ panelId: 'panel-1', stage: 'db_save' }),
    );
    expect(supa._alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ alert_type: 'ticket_create_failed' }),
    );
  });
});

const ticket = {
  id: 'tk1', channel_id: 'tc1', ticket_number: 5, creator_id: 'u1',
  panel_id: 'p1', created_at: new Date().toISOString(), closed_at: null, closed_by: null,
} as any;

function makeTranscriptSupa({ insertError = null as any } = {}) {
  const alertsInsert = vi.fn(async () => ({ error: null }));
  return {
    from: vi.fn((t: string) => {
      if (t === 'alerts') return { insert: alertsInsert };
      if (t === 'ticket_transcripts') return { insert: vi.fn(async () => ({ error: insertError })) };
      return {};
    }),
    _alertsInsert: alertsInsert,
  } as any;
}

function makeTranscriptGuild(fetchImpl: any) {
  const channel = { id: 'tc1', messages: { fetch: fetchImpl } };
  return { id: 'g1', name: 'G', channels: { cache: new Map([['tc1', channel]]) } } as any;
}

describe('ticket transcript failure observability', () => {
  it('emits ticket.transcript_failed + owner alert when the transcript DB save fails', async () => {
    const emit = vi.fn();
    const supa = makeTranscriptSupa({ insertError: { message: 'save boom' } });
    // Empty message set (size 0) so fetch loop terminates immediately.
    const guild = makeTranscriptGuild(vi.fn().mockResolvedValue(new Map()));

    const result = await generateTranscript(guild, ticket, supa, { emit } as any);

    expect(result.success).toBe(false);
    expect(emit).toHaveBeenCalledWith(
      'ticket.transcript_failed',
      'g1',
      expect.objectContaining({ ticketId: 'tk1', ticketNumber: 5 }),
    );
    expect(supa._alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ guild_id: 'g1', alert_type: 'ticket_transcript_failed' }),
    );
  });

  it('emits ticket.transcript_failed + owner alert when generation throws', async () => {
    const emit = vi.fn();
    const supa = makeTranscriptSupa();
    const guild = makeTranscriptGuild(vi.fn().mockRejectedValue(new Error('fetch exploded')));

    const result = await generateTranscript(guild, ticket, supa, { emit } as any);

    expect(result.success).toBe(false);
    expect(emit).toHaveBeenCalledWith(
      'ticket.transcript_failed',
      'g1',
      expect.objectContaining({ ticketId: 'tk1' }),
    );
    expect(supa._alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ alert_type: 'ticket_transcript_failed' }),
    );
  });
});
