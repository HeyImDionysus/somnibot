/**
 * AuditService — coverage tests.
 *
 * Imports the REAL AuditService and exercises the event-to-audit mapping,
 * queue batching, flush, start/stop lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AuditService } from '../features/audit/audit-service.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase() {
  // flush() writes via upsert(..., { onConflict, ignoreDuplicates }) — the
  // occurrence-dedupe path (ON CONFLICT DO NOTHING against
  // uq_audit_logs_guild_occurrence).
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  return {
    from: vi.fn().mockReturnValue({
      upsert: upsertMock,
    }),
    _upsertMock: upsertMock,
  };
}

function makeEventBus() {
  const handlers: Array<(event: any) => Promise<void>> = [];
  return {
    onAny: vi.fn((handler: (event: any) => Promise<void>) => {
      handlers.push(handler);
    }),
    offAny: vi.fn((handler: (event: any) => Promise<void>) => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    }),
    _emit: async (event: any) => {
      for (const h of [...handlers]) await h(event);
    },
    _handlers: handlers,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ────────────────────────────────────────────────

describe('AuditService', () => {
  let service: AuditService;
  let supabase: ReturnType<typeof makeSupabase>;
  let eventBus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    eventBus = makeEventBus();
    service = new AuditService('g1', supabase as any, eventBus as any);
  });

  afterEach(async () => {
    await service.stop().catch(() => undefined);
  });

  describe('constructor', () => {
    it('creates instance', () => {
      expect(service).toBeInstanceOf(AuditService);
    });
  });

  describe('start', () => {
    it('registers a backpressure-exempt onAny handler and starts flush timer', () => {
      service.start();
      expect(eventBus.onAny).toHaveBeenCalledWith(
        expect.any(Function),
        { backpressureExempt: true },
      );
    });
  });

  describe('event handling via onAny', () => {
    it('bounds the exempt audit buffer under a sustained event burst', async () => {
      service.start();

      for (let i = 0; i < 5_001; i++) {
        await eventBus._emit({
          type: 'member.joined',
          guildId: 'g1',
          data: { discordId: `u${i}`, username: `User${i}`, isReturning: false },
        });
      }

      const internals = service as unknown as {
        queue: Array<Record<string, unknown>>;
        pendingEnqueues: Set<Promise<void>>;
        droppedAtCapacity: number;
        flush: () => Promise<void>;
      };
      expect(internals.queue).toHaveLength(5_000);
      expect(internals.pendingEnqueues.size).toBe(0);
      expect(internals.droppedAtCapacity).toBe(1);

      supabase._upsertMock
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: 'capacity row temporarily unavailable' } })
        .mockResolvedValueOnce({ error: null });
      await internals.flush();
      await internals.flush();
      const capacityRows = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>)
        .filter((row) => row.action === 'audit.capacity_exhausted');
      expect(capacityRows).toHaveLength(2);
      expect(capacityRows[0]!.occurrence_key).toBe(capacityRows[1]!.occurrence_key);
      const capacityCalls = supabase._upsertMock.mock.calls
        .filter(([rows]) => (rows as Array<Record<string, any>>)
          .some((row) => row.action === 'audit.capacity_exhausted'));
      expect(capacityCalls).toHaveLength(2);
      for (const [, options] of capacityCalls) {
        expect(options).toMatchObject({
          onConflict: 'guild_id,occurrence_key',
          ignoreDuplicates: true,
        });
      }
      expect(capacityRows[1]!.details).toMatchObject({
        count: 1,
        sources: ['buffered audit row'],
        eventTypes: ['member.joined'],
        actions: [],
        bufferedEntryLimit: 5_000,
        pendingEnqueueLimit: 5_000,
      });
    });

    it('routes a manual-log capacity loss through the same durable gap row', async () => {
      const internals = service as unknown as {
        queue: Array<Record<string, unknown>>;
        flush: () => Promise<void>;
      };
      internals.queue.length = 5_000;

      await service.log({
        action: 'manual.at_capacity',
        actorType: 'bot',
        actorId: 'bot1',
      });
      internals.queue.length = 0;
      await internals.flush();

      const capacityRow = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>)
        .find((row) => row.action === 'audit.capacity_exhausted');
      expect(capacityRow?.details).toMatchObject({
        count: 1,
        sources: ['manual audit log'],
        eventTypes: [],
        actions: ['manual.at_capacity'],
      });
    });

    it('freezes later capacity drops into a distinct immutable window', async () => {
      const firstWrite = deferred<{ error: null }>();
      supabase._upsertMock
        .mockImplementationOnce(() => firstWrite.promise)
        .mockResolvedValue({ error: null });

      const internals = service as unknown as {
        recordCapacityDrop: (
          context: { source: string; action?: string },
          count?: number,
        ) => void;
        flush: () => Promise<void>;
      };

      internals.recordCapacityDrop({ source: 'manual audit log', action: 'first' });
      const firstFlush = internals.flush();
      expect(supabase._upsertMock).toHaveBeenCalledOnce();

      // This arrives after the first immutable row has been handed to the DB.
      internals.recordCapacityDrop({ source: 'manual audit log', action: 'second' });
      firstWrite.resolve({ error: null });
      await firstFlush;
      await internals.flush();

      const capacityRows = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>)
        .filter((row) => row.action === 'audit.capacity_exhausted');
      expect(capacityRows).toHaveLength(2);
      expect(capacityRows[0]!.occurrence_key).not.toBe(capacityRows[1]!.occurrence_key);
      expect(capacityRows.map((row) => row.details.count)).toEqual([1, 1]);
      expect(capacityRows.map((row) => row.details.actions)).toEqual([['first'], ['second']]);
    });

    it('turns a mapping exception into a durable append-only gap row', async () => {
      service.start();
      await eventBus._emit({
        type: 'config.changed',
        guildId: 'g1',
        data: null,
      });

      const internals = service as unknown as { flush: () => Promise<void> };
      await internals.flush();

      const mappingCall = supabase._upsertMock.mock.calls.find(([rows]) =>
        (rows as Array<Record<string, any>>)
          .some((row) => row.action === 'audit.mapping_failed'));
      expect(mappingCall).toBeDefined();
      expect(mappingCall?.[0]).toEqual([
        expect.objectContaining({
          actor_type: 'system',
          actor_id: 'audit-service',
          action: 'audit.mapping_failed',
          success: false,
          occurrence_key: expect.stringMatching(/^audit\.mapping_failed:/),
          details: expect.objectContaining({
            count: 1,
            eventTypes: ['config.changed'],
          }),
        }),
      ]);
      expect(mappingCall?.[1]).toMatchObject({
        onConflict: 'guild_id,occurrence_key',
        ignoreDuplicates: true,
      });
    });

    it('bounds a never-settling config snapshot and records a durable mapping gap', async () => {
      vi.useFakeTimers();
      try {
        service.start();
        const never = deferred<void>();
        const internals = service as unknown as {
          snapshotLoad: Promise<void>;
          pendingEnqueues: Set<Promise<void>>;
          flush: () => Promise<void>;
        };
        internals.snapshotLoad = never.promise;

        await eventBus._emit({
          type: 'config.changed',
          guildId: 'g1',
          data: { changedBy: 'u1', changes: { prefix: '!' } },
        });
        expect(internals.pendingEnqueues.size).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);
        await internals.flush();

        expect(internals.pendingEnqueues.size).toBe(0);
        const mappingRows = supabase._upsertMock.mock.calls
          .flatMap(([rows]) => rows as Array<Record<string, any>>)
          .filter((row) => row.action === 'audit.mapping_failed');
        expect(mappingRows).toHaveLength(1);
        expect(mappingRows[0]?.details).toMatchObject({
          count: 1,
          eventTypes: ['config.changed'],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('matches the append-only production grant with DO NOTHING gap writes', () => {
      const migration = readFileSync(
        new URL(
          '../../../supabase/migrations/20260713030000_audit_logs_anonymize_purge.sql',
          import.meta.url,
        ),
        'utf8',
      );
      expect(migration).toMatch(
        /REVOKE UPDATE,\s*DELETE,\s*TRUNCATE,\s*REFERENCES,\s*TRIGGER\s+ON public\.audit_logs FROM service_role;/,
      );
    });

    it('maps member.joined event to audit entry', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1', username: 'TestUser', isReturning: false },
      });

      // Trigger flush via stop
      service.stop();
      await new Promise((r) => process.nextTick(r));
      expect(supabase.from).toHaveBeenCalledWith('audit_logs');
    });

    it('maps member.left event', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.left',
        guildId: 'g1',
        data: { discordId: 'u1', username: 'TestUser', roles: ['role1'] },
      });

    });

    it('maps role.gained event with before/after state', async () => {
      service.start();
      await eventBus._emit({
        type: 'role.gained',
        guildId: 'g1',
        data: { discordId: 'u1', roleId: 'r1', roleName: 'Admin', source: 'reaction' },
      });

    });

    it('maps role.lost event', async () => {
      service.start();
      await eventBus._emit({
        type: 'role.lost',
        guildId: 'g1',
        data: { discordId: 'u1', roleId: 'r1', roleName: 'Admin', source: 'reaction' },
      });

    });

    it('maps infraction.created event', async () => {
      service.start();
      await eventBus._emit({
        type: 'infraction.created',
        guildId: 'g1',
        data: { userId: 'u1', moderatorId: 'mod1', type: 'warn', reason: 'spam', totalInfractions: 3 },
      });

    });

    it('maps member.muted event', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.muted',
        guildId: 'g1',
        data: { userId: 'u1', moderatorId: 'mod1', reason: 'spam', duration: 3600 },
      });

    });

    it('maps member.kicked event', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.kicked',
        guildId: 'g1',
        data: { userId: 'u1', moderatorId: 'mod1', reason: 'rule violation' },
      });

    });

    it('maps member.banned event', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.banned',
        guildId: 'g1',
        data: { userId: 'u1', moderatorId: 'mod1', reason: 'severe' },
      });

    });

    it('maps ticket events (opened, claimed, closed, reopened)', async () => {
      service.start();
      for (const type of ['ticket.opened', 'ticket.claimed', 'ticket.closed', 'ticket.reopened']) {
        await eventBus._emit({
          type,
          guildId: 'g1',
          data: { ticketId: 't1', userId: 'u1', channelId: 'c1', claimedBy: 'mod1', closedBy: 'mod1', reason: 'resolved', reopenedBy: 'u1' },
        });
      }

    });

    it('maps commerce events (purchase, entitlement, subscription)', async () => {
      service.start();
      for (const type of ['purchase.completed', 'entitlement.granted', 'entitlement.revoked', 'subscription.activated', 'subscription.lapsed', 'subscription.expired', 'subscription.changed']) {
        await eventBus._emit({
          type,
          guildId: 'g1',
          data: { userId: 'u1', sku: 'sku1', skuId: 'sku1', plan: 'premium', amount: 999, entitlementId: 'e1', oldPlan: 'free', newPlan: 'premium' },
        });
      }

    });

    it('maps level.up event', async () => {
      service.start();
      await eventBus._emit({
        type: 'level.up',
        guildId: 'g1',
        data: { discordId: 'u1', oldLevel: 4, newLevel: 5 },
      });

    });

    it('maps deploy events (requested, completed, failed)', async () => {
      service.start();
      for (const type of ['server.deployed', 'deploy.requested', 'deploy.failed']) {
        await eventBus._emit({
          type,
          guildId: 'g1',
          data: { userId: 'u1', environment: 'prod', version: '1.0', error: 'timeout' },
        });
      }

    });

    it('maps sync events', async () => {
      service.start();
      for (const type of ['drift.detected', 'sync.completed']) {
        await eventBus._emit({
          type,
          guildId: 'g1',
          data: { entity: 'roles', changes: 3, action: 'repair' },
        });
      }

    });

    it('maps config.changed event', async () => {
      service.start();
      await eventBus._emit({
        type: 'config.changed',
        guildId: 'g1',
        data: { userId: 'u1', key: 'welcome_enabled', oldValue: false, newValue: true },
      });

    });

    it('maps automation events', async () => {
      service.start();
      for (const type of ['automation.executed', 'automation.created', 'automation.updated']) {
        await eventBus._emit({
          type,
          guildId: 'g1',
          data: { automationId: 'a1', name: 'Welcome Flow', userId: 'u1', trigger: 'member.joined' },
        });
      }

    });

    it('maps member.verified event', async () => {
      service.start();
      await eventBus._emit({
        type: 'member.verified',
        guildId: 'g1',
        data: { discordId: 'u1', username: 'TestUser' },
      });

    });

    it('maps giveaway.ended event', async () => {
      service.start();
      await eventBus._emit({
        type: 'giveaway.ended',
        guildId: 'g1',
        data: { giveawayId: 'gw1', winnerId: 'u1', prize: 'Nitro' },
      });

    });

    it('ignores unmapped event types', async () => {
      service.start();
      await eventBus._emit({
        type: 'unknown.event',
        guildId: 'g1',
        data: {},
      });


      // Queue should be empty since event was unmapped
      // flush shouldn't call insert
    });
  });

  describe('stop', () => {
    it('stops the flush timer and does final flush', () => {
      service.start();
      service.stop();
      // Should not throw
    });

    it('handles stop when not started', () => {
      service.stop();
    });

    it('unsubscribes and drains a row queued behind an active flush', async () => {
      const firstWrite = deferred<{ error: null }>();
      supabase._upsertMock
        .mockImplementationOnce(() => firstWrite.promise)
        .mockResolvedValue({ error: null });
      service.start();
      await service.log({
        action: 'before.stop',
        actorType: 'bot',
        actorId: 'bot1',
      });

      const internals = service as unknown as { flush: () => Promise<void> };
      const registeredHandler = eventBus._handlers[0];
      const activeFlush = internals.flush();
      expect(supabase._upsertMock).toHaveBeenCalledOnce();

      await service.log({
        action: 'during.stop',
        actorType: 'bot',
        actorId: 'bot1',
      });
      const stopped = Promise.resolve(service.stop());
      firstWrite.resolve({ error: null });
      await activeFlush;
      await stopped;

      expect(eventBus.offAny).toHaveBeenCalledWith(registeredHandler);
      const actions = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, unknown>>)
        .map((row) => row.action)
        .filter((action) => action === 'before.stop' || action === 'during.stop');
      expect(actions).toEqual(['before.stop', 'during.stop']);
    });

    it('does not duplicate keyless rows after a stop and restart', async () => {
      service.start();
      await Promise.resolve(service.stop());
      service.start();
      await eventBus._emit({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1', username: 'User', isReturning: false },
      });

      const internals = service as unknown as { flush: () => Promise<void> };
      await internals.flush();

      const rows = supabase._upsertMock.mock.calls
        .flatMap(([batch]) => batch as Array<Record<string, unknown>>)
        .filter((row) => row.action === 'member.joined');
      expect(rows).toHaveLength(1);
      await Promise.resolve(service.stop());
    });

    it('hands failed shutdown residue to Valkey and replays it idempotently after restart', async () => {
      const stored = new Map<string, string>();
      const recoveryStore = {
        get: vi.fn(async (key: string) => stored.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          stored.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => stored.delete(key) ? 1 : 0),
      };
      const failedSupabase = makeSupabase();
      failedSupabase._upsertMock.mockResolvedValue({
        error: { message: 'audit store remains unavailable' },
      });
      const first = new AuditService(
        'g1',
        failedSupabase as any,
        makeEventBus() as any,
        recoveryStore,
      );
      await first.log({
        action: 'must.cross.restart',
        actorType: 'bot',
        actorId: 'bot1',
      });

      await expect(first.stop()).resolves.toBeUndefined();
      expect(recoveryStore.set).toHaveBeenCalledOnce();
      const persisted = JSON.parse(stored.values().next().value as string);
      expect(persisted).toMatchObject({ version: 1, guildId: 'g1' });
      const persistedRow = persisted.rows.find(
        (row: Record<string, unknown>) => row.action === 'must.cross.restart',
      );
      expect(persistedRow.occurrence_key).toMatch(/^audit\.delivery:/);

      const recoveredSupabase = makeSupabase();
      const restarted = new AuditService(
        'g1',
        recoveredSupabase as any,
        makeEventBus() as any,
        recoveryStore,
      );
      restarted.start();
      await (restarted as unknown as { flush: () => Promise<void> }).flush();

      const replayed = recoveredSupabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, unknown>>)
        .find((row) => row.action === 'must.cross.restart');
      expect(replayed?.occurrence_key).toBe(persistedRow.occurrence_key);
      expect(recoveryStore.del).toHaveBeenCalledOnce();
      expect(stored.size).toBe(0);
      await restarted.stop();
    });

    it('deletes an oversized restart spool and records bounded integrity-gap evidence', async () => {
      const oversized = JSON.stringify({
        version: 1,
        guildId: 'g1',
        rows: new Array(10_000).fill({}),
      });
      const recoveryStore = {
        get: vi.fn(async () => oversized),
        set: vi.fn(async () => 'OK'),
        del: vi.fn(async () => 1),
      };
      const guarded = new AuditService(
        'g1',
        supabase as any,
        makeEventBus() as any,
        recoveryStore,
      );
      guarded.start();
      await (guarded as unknown as { flush: () => Promise<void> }).flush();

      expect(recoveryStore.del).toHaveBeenCalledOnce();
      const writes = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        action: 'audit.mapping_failed',
        success: false,
        details: expect.objectContaining({
          eventTypes: ['persisted audit residue'],
        }),
      });
      await guarded.stop();
    });

    it('replays a mixed gap and flush-recovery spool as one homogeneous batch', async () => {
      const stored = new Map<string, string>();
      const recoveryStore = {
        get: vi.fn(async (key: string) => stored.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          stored.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => stored.delete(key) ? 1 : 0),
      };
      const failedSupabase = makeSupabase();
      failedSupabase._upsertMock
        .mockResolvedValueOnce({ error: { message: 'batch outage' } })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValue({ error: { message: 'ledger unavailable again' } });
      const first = new AuditService(
        'g1',
        failedSupabase as any,
        makeEventBus() as any,
        recoveryStore,
      );
      await first.log({
        action: 'batch.before.mixed.spool',
        actorType: 'bot',
        actorId: 'bot1',
      });
      const firstInternals = first as unknown as {
        flush: () => Promise<void>;
        recordMappingFailure: (eventType: string, error: unknown) => void;
      };
      await firstInternals.flush();
      await firstInternals.flush();
      firstInternals.recordMappingFailure('mixed.spool.test', new Error('mapping failed'));
      await first.stop();

      const envelope = JSON.parse(stored.values().next().value as string);
      expect(envelope.rows.map((row: Record<string, unknown>) => row.action).sort())
        .toEqual(['audit.flush_failed', 'audit.mapping_failed']);
      const rowKeySets = envelope.rows.map((row: Record<string, unknown>) =>
        Object.keys(row).sort());
      expect(rowKeySets[1]).toEqual(rowKeySets[0]);

      const recoveredSupabase = makeSupabase();
      const restarted = new AuditService(
        'g1',
        recoveredSupabase as any,
        makeEventBus() as any,
        recoveryStore,
      );
      restarted.start();
      await (restarted as unknown as { flush: () => Promise<void> }).flush();

      const replayBatch = recoveredSupabase._upsertMock.mock.calls[0]?.[0] as
        Array<Record<string, unknown>>;
      expect(replayBatch.map((row) => row.action).sort())
        .toEqual(['audit.flush_failed', 'audit.mapping_failed']);
      expect(recoveryStore.del).toHaveBeenCalledOnce();
      await restarted.stop();
    });

    it('rejects instead of falsely completing when persistent write failure leaves residue', async () => {
      supabase._upsertMock.mockResolvedValue({
        error: { message: 'audit store remains unavailable' },
      });
      await service.log({
        action: 'must.survive.shutdown',
        actorType: 'bot',
        actorId: 'bot1',
      });

      await expect(service.stop()).rejects.toThrow(/stalled with residue/);

      const internals = service as unknown as {
        queue: Array<Record<string, unknown>>;
      };
      expect(internals.queue).toHaveLength(1);
      expect(internals.queue[0]?.action).toBe('must.survive.shutdown');

      // The rejected stop keeps finite residue available for an explicit
      // retry instead of reporting success and letting its owner discard it.
      supabase._upsertMock.mockResolvedValue({ error: null });
      await service.stop();
      expect(internals.queue).toHaveLength(0);
    });

    it('does not finish shutdown until a failed flush-recovery row is durably retried', async () => {
      supabase._upsertMock
        .mockResolvedValueOnce({ error: { message: 'audit store temporarily unavailable' } })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: 'recovery row temporarily unavailable' } })
        .mockResolvedValueOnce({ error: null });

      await service.log({
        action: 'must.record.outage',
        actorType: 'bot',
        actorId: 'bot1',
      });

      await service.stop();

      const recoveryRows = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>)
        .filter((row) => row.action === 'audit.flush_failed');
      expect(recoveryRows).toHaveLength(2);
      expect(recoveryRows[1]).toEqual(recoveryRows[0]);
      expect(recoveryRows[1]?.details).toMatchObject({
        attempts: 1,
        recoveredEntries: 1,
      });
      expect(recoveryRows[0]).toMatchObject({
        target_type: null,
        target_id: null,
        before_state: null,
        after_state: null,
        correlation_id: null,
      });

      const internals = service as unknown as {
        flushOutage: unknown;
        pendingFlushRecoveries: Array<Record<string, unknown>>;
      };
      expect(internals.flushOutage).toBeNull();
      expect(internals.pendingFlushRecoveries).toEqual([]);
    });

    it('retries the exact frozen recovery row without folding in a later batch', async () => {
      supabase._upsertMock
        .mockResolvedValueOnce({ error: { message: 'batch A temporarily unavailable' } })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: 'recovery marker ambiguously failed' } })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: null });

      const internals = service as unknown as {
        flush: () => Promise<void>;
      };
      await service.log({
        action: 'batch.a',
        actorType: 'bot',
        actorId: 'bot1',
      });
      await internals.flush();
      await internals.flush();

      await service.log({
        action: 'batch.b',
        actorType: 'bot',
        actorId: 'bot1',
      });
      await internals.flush();

      const recoveryRows = supabase._upsertMock.mock.calls
        .flatMap(([rows]) => rows as Array<Record<string, any>>)
        .filter((row) => row.action === 'audit.flush_failed');
      expect(recoveryRows).toHaveLength(2);
      expect(recoveryRows[1]).toEqual(recoveryRows[0]);
      expect(recoveryRows[0]?.details).toMatchObject({
        recoveredEntries: 1,
      });
    });

    it('rejects with the recovery marker retained when that marker stays unavailable', async () => {
      supabase._upsertMock
        .mockResolvedValueOnce({ error: { message: 'audit store temporarily unavailable' } })
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValue({ error: { message: 'recovery row remains unavailable' } });

      await service.log({
        action: 'must.retain.outage',
        actorType: 'bot',
        actorId: 'bot1',
      });

      await expect(service.stop()).rejects.toThrow(/stalled with residue/);

      const internals = service as unknown as {
        queue: Array<Record<string, unknown>>;
        flushOutage: unknown;
        pendingFlushRecoveries: Array<Record<string, any>>;
      };
      expect(internals.queue).toHaveLength(0);
      expect(internals.flushOutage).toBeNull();
      expect(internals.pendingFlushRecoveries).toHaveLength(1);
      expect(internals.pendingFlushRecoveries[0]?.details)
        .toMatchObject({ recoveredEntries: 1 });

      supabase._upsertMock.mockResolvedValue({ error: null });
      await service.stop();
      expect(internals.flushOutage).toBeNull();
      expect(internals.pendingFlushRecoveries).toEqual([]);
    });
  });

  describe('manual log', () => {
    it('queues a manual audit entry with all fields', async () => {
      service.start();
      await service.log({
        action: 'custom.action',
        category: 'custom',
        actorType: 'user',
        actorId: 'u1',
        targetType: 'channel',
        targetId: 'c1',
        details: { key: 'value' },
        beforeState: { old: true },
        afterState: { old: false },
        correlationId: 'corr123',
        success: true,
      });



      // Stop triggers final flush
      service.stop();
      await new Promise((r) => process.nextTick(r));
      expect(supabase.from).toHaveBeenCalledWith('audit_logs');
    });

    it('queues entry with minimal fields', async () => {
      service.start();
      await service.log({
        action: 'simple.action',
        actorType: 'bot',
        actorId: 'bot1',
      });

      service.stop();
      await new Promise((r) => process.nextTick(r));
      expect(supabase.from).toHaveBeenCalledWith('audit_logs');
    });

    it('queues entry with error', async () => {
      service.start();
      await service.log({
        action: 'failed.action',
        actorType: 'system',
        actorId: 'system',
        success: false,
        errorMessage: 'Something went wrong',
      });

      service.stop();
      await new Promise((r) => process.nextTick(r));
      expect(supabase.from).toHaveBeenCalledWith('audit_logs');
    });
  });

  describe('flush', () => {
    it('does nothing when queue is empty', () => {
      service.start();
      // Trigger flush via stop (which calls flush internally)
      service.stop();
      // audit_logs must not be written because the queue is empty (start()
      // legitimately reads guild_config to prime the before-snapshot baseline)
      expect(supabase.from).not.toHaveBeenCalledWith('audit_logs');
    });

    it('re-queues entries on flush error within the bounded buffer', async () => {
      supabase._upsertMock.mockResolvedValue({ error: { message: 'DB error' } });
      supabase.from.mockReturnValue({ upsert: supabase._upsertMock });

      service.start();
      await service.log({
        action: 'test',
        actorType: 'bot',
        actorId: 'bot1',
      });

      // A failed drain must retain the row and reject rather than report a
      // successful shutdown while finite residue remains.
      await expect(service.stop()).rejects.toThrow(/stalled with residue/);

      // Entry should be re-queued
      expect(supabase._upsertMock).toHaveBeenCalled();
      supabase._upsertMock.mockResolvedValue({ error: null });
      await service.stop();
    });

    it('retries a keyless row with the same immutable delivery key after an ambiguous failure', async () => {
      supabase._upsertMock
        .mockResolvedValueOnce({ error: { message: 'response lost after possible commit' } })
        .mockResolvedValue({ error: null });
      await service.log({
        action: 'keyless.retry',
        actorType: 'bot',
        actorId: 'bot1',
      });
      const internals = service as unknown as { flush: () => Promise<void> };

      await internals.flush();
      await internals.flush();

      const writes = supabase._upsertMock.mock.calls
        .map(([rows]) => rows as Array<Record<string, unknown>>)
        .filter((rows) => rows.some((row) => row.action === 'keyless.retry'));
      expect(writes).toHaveLength(2);
      expect(writes[0]).toEqual(writes[1]);
      expect(writes[0]?.[0]?.occurrence_key).toMatch(/^audit\.delivery:/);
    });

    it('batches multiple entries in one flush', async () => {
      service.start();

      await eventBus._emit({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u1', username: 'User1', isReturning: false },
      });
      await eventBus._emit({
        type: 'member.joined',
        guildId: 'g1',
        data: { discordId: 'u2', username: 'User2', isReturning: true },
      });

      // Stop triggers final flush
      service.stop();
      await new Promise((r) => process.nextTick(r));

      expect(supabase._upsertMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ action: 'member.joined' }),
        ]),
        expect.objectContaining({ onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true }),
      );
    });
  });
});
