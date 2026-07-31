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

import { createTicket, reconcileTicketOrphanChannels } from '../features/tickets/ticket-service.js';
import { generateTranscript } from '../features/tickets/transcript-generator.js';

function makeCreateSupa({ ticketRow = null as any, ticketError = null as any } = {}) {
  const alertsInsert = vi.fn(async () => ({ error: null }));
  const tChain: any = {};
  for (const m of ['select', 'eq', 'in', 'insert', 'update', 'delete', 'order', 'limit', 'contains']) {
    tChain[m] = vi.fn(() => tChain);
  }
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

  it('deletes the channel and reports failure when the intro message cannot be sent', async () => {
    const emit = vi.fn();
    const supa = makeCreateSupa();
    const channel = {
      id: 'tc1',
      send: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
      delete: vi.fn().mockResolvedValue({}),
    };
    const guild = makeGuild(vi.fn().mockResolvedValue(channel));

    const result = await createTicket(guild, member, panel, ticketType, supa, { emit } as any);

    expect(result).toEqual({ error: 'Failed to initialize ticket channel. Please try again.' });
    expect(channel.delete).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'ticket.create_failed',
      'g1',
      expect.objectContaining({ panelId: 'panel-1', stage: 'intro_send' }),
    );
  });

  it('preserves a committed ticket when the insert response is lost', async () => {
    const emit = vi.fn();
    const channel = {
      id: 'tc1',
      send: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    const committedTicket = {
      id: 'ticket-1',
      guild_id: 'g1',
      panel_id: 'panel-1',
      channel_id: 'tc1',
      ticket_number: 1,
      creator_id: 'u1',
      status: 'open',
      creation_occurrence_id: 'occurrence-1',
    };
    let ticketQuery = 0;
    const occurrence = {
      id: 'occurrence-1',
      guild_id: 'g1',
      operation_kind: 'ticket',
      occurrence_key: 'interaction-1',
      status: 'claimed',
      resource_id: null,
      result: {},
      last_error: null,
    };
    const supa = {
      from: vi.fn((table: string) => {
        if (table === 'alerts') return { insert: vi.fn(async () => ({ error: null })) };
        if (table === 'discord_operation_occurrences') {
          const chain = makeCreateSupa().from('tickets');
          chain.single = vi.fn(async () => ({ data: occurrence, error: null }));
          return chain;
        }
        if (table === 'tickets') {
          ticketQuery += 1;
          const chain = makeCreateSupa().from('tickets');
          if (ticketQuery === 1) {
            chain.then = (resolve: Function) => resolve({ data: [], error: null, count: 0 });
          } else if (ticketQuery === 2) {
            chain.single = vi.fn(async () => ({
              data: null,
              error: { message: 'connection lost after commit' },
            }));
          } else {
            chain.maybeSingle = vi.fn(async () => ({ data: committedTicket, error: null }));
          }
          return chain;
        }
        return makeCreateSupa().from('tickets');
      }),
      rpc: vi.fn(async () => ({ data: 1, error: null })),
    } as any;
    const guild = makeGuild(vi.fn().mockResolvedValue(channel));

    const result = await createTicket(
      guild,
      member,
      panel,
      ticketType,
      supa,
      { emit } as any,
      'interaction-1',
    );

    expect(result).toMatchObject({ ticket: committedTicket, channel });
    expect(channel.delete).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'ticket.opened',
      'g1',
      expect.objectContaining({ ticketId: 'ticket-1', channelId: 'tc1' }),
    );
  });

  it('queues durable verification when an uncertain ticket insert cannot be read back', async () => {
    const occurrenceUpdates = vi.fn();
    let ticketQuery = 0;
    const occurrence = {
      id: 'occurrence-uncertain',
      guild_id: 'g1',
      operation_kind: 'ticket',
      occurrence_key: 'interaction-uncertain',
      status: 'claimed',
      resource_id: null,
      result: {},
      last_error: null,
    };
    const supa = {
      from: vi.fn((table: string) => {
        const chain = makeCreateSupa().from('tickets');
        if (table === 'alerts') return { insert: vi.fn(async () => ({ error: null })) };
        if (table === 'discord_operation_occurrences') {
          chain.single = vi.fn(async () => ({ data: occurrence, error: null }));
          chain.update = vi.fn((payload: unknown) => {
            occurrenceUpdates(payload);
            return chain;
          });
          // The occurrence in this scenario IS still `claimed`, so the
          // hardened cleanup-pending write's conditional
          // `.update().eq('status','claimed').select('id').maybeSingle()`
          // matches exactly one row. Returning null here would model a
          // DIFFERENT scenario (fence already completed/released), which
          // the dedicated occurrence-fence suite covers fail-closed.
          chain.maybeSingle = vi.fn(async () => ({ data: { id: occurrence.id }, error: null }));
          return chain;
        }
        if (table === 'tickets') {
          ticketQuery++;
          if (ticketQuery === 1) {
            chain.then = (resolve: Function) => resolve({ data: [], error: null, count: 0 });
          } else if (ticketQuery === 2) {
            chain.single = vi.fn(async () => ({
              data: null,
              error: { message: 'connection lost after commit' },
            }));
          } else {
            chain.maybeSingle = vi.fn(async () => ({
              data: null,
              error: { message: 'read replica unavailable' },
            }));
          }
        }
        return chain;
      }),
      rpc: vi.fn(async () => ({ data: 1, error: null })),
    } as any;
    const channel = {
      id: 'tc-uncertain',
      send: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };

    const result = await createTicket(
      makeGuild(vi.fn().mockResolvedValue(channel)),
      member,
      panel,
      ticketType,
      supa,
      { emit: vi.fn() } as any,
      'interaction-uncertain',
    );

    expect(result).toEqual({
      error: 'Ticket creation could not be confirmed. The channel was preserved for automatic recovery.',
    });
    expect(channel.delete).not.toHaveBeenCalled();
    expect(occurrenceUpdates).toHaveBeenCalledWith(expect.objectContaining({
      resource_id: 'tc-uncertain',
      result: expect.objectContaining({
        channelCleanupPending: true,
        verifyTicketBeforeCleanup: true,
      }),
    }));
  });
});

describe('ticket orphan cleanup reconciliation', () => {
  it('deletes a durable orphan and releases its occurrence only after confirmation', async () => {
    const channel = { id: 'tc-orphan', delete: vi.fn().mockResolvedValue(undefined) };
    let occurrenceReads = 0;
    const supabase = {
      from: vi.fn(() => {
        occurrenceReads += 1;
        const chain = makeCreateSupa().from('tickets');
        chain.then = (resolve: Function) => resolve(
          occurrenceReads === 1
            ? {
                data: [{
                  id: 'occurrence-orphan',
                  resource_id: 'tc-orphan',
                  result: { channelCleanupPending: true },
                }],
                error: null,
              }
            : { data: null, error: null },
        );
        return chain;
      }),
    } as any;
    const guild = {
      id: 'g1',
      channels: {
        cache: new Map([['tc-orphan', channel]]),
        fetch: vi.fn(),
      },
    } as any;

    await expect(reconcileTicketOrphanChannels(guild, supabase)).resolves.toBe(1);
    expect(channel.delete).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('retains the cleanup job when Discord deletion is still failing', async () => {
    const channel = { id: 'tc-orphan', delete: vi.fn().mockRejectedValue(new Error('rate limited')) };
    const chain = makeCreateSupa().from('tickets');
    chain.then = (resolve: Function) => resolve({
      data: [{
        id: 'occurrence-orphan',
        resource_id: 'tc-orphan',
        result: { channelCleanupPending: true },
      }],
      error: null,
    });
    const supabase = { from: vi.fn(() => chain) } as any;
    const guild = {
      id: 'g1',
      channels: {
        cache: new Map([['tc-orphan', channel]]),
        fetch: vi.fn(),
      },
    } as any;

    await expect(reconcileTicketOrphanChannels(guild, supabase)).resolves.toBe(0);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('completes an uncertain occurrence without deleting its committed ticket channel', async () => {
    const channel = { id: 'tc-committed', delete: vi.fn() };
    const occurrenceUpdates = vi.fn();
    const supabase = {
      from: vi.fn((table: string) => {
        const chain = makeCreateSupa().from('tickets');
        if (table === 'tickets') {
          chain.maybeSingle = vi.fn(async () => ({
            data: { id: 'ticket-committed', channel_id: 'tc-committed' },
            error: null,
          }));
        } else {
          let selected = false;
          chain.select = vi.fn(() => {
            selected = true;
            return chain;
          });
          chain.update = vi.fn((payload: unknown) => {
            selected = false;
            occurrenceUpdates(payload);
            return chain;
          });
          chain.then = (resolve: Function) => resolve(selected
            ? {
                data: [{
                  id: 'occurrence-committed',
                  resource_id: 'tc-committed',
                  result: {
                    channelCleanupPending: true,
                    verifyTicketBeforeCleanup: true,
                  },
                }],
                error: null,
              }
            : { data: null, error: null });
        }
        return chain;
      }),
    } as any;
    const guild = {
      id: 'g1',
      channels: {
        cache: new Map([['tc-committed', channel]]),
        fetch: vi.fn(),
      },
    } as any;

    await expect(reconcileTicketOrphanChannels(guild, supabase)).resolves.toBe(1);
    expect(channel.delete).not.toHaveBeenCalled();
    expect(occurrenceUpdates).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      result: { ticketId: 'ticket-committed', recovered: true },
    }));
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
