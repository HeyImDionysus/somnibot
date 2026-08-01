/**
 * Round 23 P1: the ownership insert must verify against the POST-record
 * claim snapshot. recordDiscordOccurrenceChannels bumps the occurrence's
 * updated_at (trigger), so comparing against the CLAIM-time value made every
 * production ticket create read as reclaimed — the RPC returned no row, the
 * fresh channel was deleted, and "recovery won" was reported for a flow
 * nobody raced.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn(async () => ({ inserted: true, delivered: true })),
  resolveOwnerAlert: vi.fn(async () => undefined),
  resolveOwnerAlertWithStatus: vi.fn(async () => ({ succeeded: true, resolvedCount: 0 })),
}));

import { createTicket } from '../features/tickets/ticket-service.js';

describe('ticket ownership insert uses the POST-record claim snapshot', () => {
  it('passes the refreshed updated_at to insert_owned_ticket', async () => {
    fence.claimDiscordOccurrence.mockResolvedValue({
      won: true,
      occurrence: {
        id: 'f0000000-0000-4000-8000-000000000001',
        updated_at: '2026-07-31T10:00:00.000Z',
      },
    });
    fence.recordDiscordOccurrenceChannels.mockResolvedValue({
      updatedAt: '2026-07-31T10:00:05.000Z',
    });

    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'gt', 'lt', 'not', 'update', 'insert', 'upsert']) {
      chain[method] = vi.fn(() => chain);
    }
    (chain as { maybeSingle: unknown }).maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    (chain as { single: unknown }).single = vi.fn(async () => ({ data: null, error: null }));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ data: [], error: null, count: 0 });
    const supabase = {
      from: vi.fn(() => chain),
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'nextval_ticket') return { data: 7, error: null };
        if (fn === 'insert_owned_ticket') {
          return {
            data: [{
              id: 'ticket-row-1',
              guild_id: 'g1',
              channel_id: 'ticket-ch-1',
              ticket_number: 7,
              status: 'open',
            }],
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    };

    const channel = {
      id: 'ticket-ch-1',
      isTextBased: () => true,
      send: vi.fn(async () => ({ id: 'msg-1' })),
      delete: vi.fn(async () => undefined),
      permissionOverwrites: { edit: vi.fn(async () => undefined) },
    };
    const guild = {
      id: 'g1',
      channels: {
        create: vi.fn(async () => channel),
        cache: new Map(),
      },
      roles: { everyone: { id: 'g1' } },
      members: { me: { id: 'bot1' } },
    };
    const member = {
      id: 'member-1',
      user: { tag: 'Member#0001', username: 'Member' },
      displayName: 'Member',
      toString: () => '<@member-1>',
    };
    const panel = {
      id: 'e1000000-0000-4000-8000-000000000001',
      guild_id: 'g1',
      open_category_id: 'cat-1',
      support_role_ids: [],
      manager_roles: [],
      welcome_message: null,
    };
    const ticketType = { id: 'support', label: 'Support', emoji: null };
    const eventBus = { emit: vi.fn() };

    const result = await createTicket(
      guild as never,
      member as never,
      panel as never,
      ticketType as never,
      supabase as never,
      eventBus as never,
      'occurrence-key-1',
    );

    const ownershipCall = rpcCalls.find((call) => call.fn === 'insert_owned_ticket');
    expect(ownershipCall).toBeDefined();
    // The POST-record snapshot, not the claim-time one: with the claim-time
    // value this RPC always refused and the flow self-destructed.
    expect(ownershipCall!.args.p_expected_updated_at).toBe('2026-07-31T10:00:05.000Z');
    expect(channel.delete).not.toHaveBeenCalled();
    expect('error' in (result as Record<string, unknown>)).toBe(false);
  });
});
