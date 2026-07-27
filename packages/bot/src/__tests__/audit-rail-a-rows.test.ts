/**
 * Rail A (event rail) row shapes — drives the REAL AuditService.
 *
 * The event rail is: feature emits a platform event → AuditService maps it via
 * EVENT_TO_AUDIT → the batched flush writes audit_logs. These tests assert the
 * ROW a given event produces, which is the contract an owner reads on the
 * dashboard Audit page. Mapping tables are easy to add to and easy to get
 * subtly wrong; asserting the row (not the table) catches both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AuditService } from '../features/audit/audit-service.js';

type Row = Record<string, unknown>;

/** Minimal stand-in for PlatformEventBus: onAny + a synchronous emit. */
class FakeBus {
  private any: Array<(e: unknown) => void> = [];
  onAny(handler: (e: unknown) => void): void {
    this.any.push(handler);
  }
  emit(type: string, guildId: string, data: unknown): void {
    for (const h of this.any) h({ type, guildId, timestamp: Date.now(), data });
  }
}

function makeSupabase(rows: Row[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
      upsert: vi.fn().mockImplementation((batch: Row[]) => {
        rows.push(...batch);
        return Promise.resolve({ error: null });
      }),
      insert: vi.fn().mockImplementation((batch: Row | Row[]) => {
        rows.push(...(Array.isArray(batch) ? batch : [batch]));
        return Promise.resolve({ error: null });
      }),
    }),
  };
}

/** Emit one event through a live AuditService and return the flushed rows. */
async function rowsFor(type: string, data: Record<string, unknown>, guildId = 'g1'): Promise<Row[]> {
  const rows: Row[] = [];
  const bus = new FakeBus();
  const service = new AuditService(guildId, makeSupabase(rows) as never, bus as never);
  service.start();
  bus.emit(type, guildId, data);
  service.stop(); // stop() forces a final flush
  // stop()'s flush is fire-and-forget; drain the microtask queue.
  await new Promise((r) => setTimeout(r, 0));
  return rows;
}

describe('rail A rows — music', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('music.queued records the ADD side of the shared queue', async () => {
    const rows = await rowsFor('music.queued', {
      userId: 'u1',
      title: 'Song',
      author: 'Artist',
      uri: 'https://x/y',
      trackCount: 1,
      playlistName: null,
      queueLength: 3,
      sessionStarted: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guild_id: 'g1',
      action: 'music.queued',
      category: 'music',
      actor_type: 'user',
      actor_id: 'u1',
      target_type: 'music_queue',
      target_id: 'u1',
      success: true,
    });
    expect(rows[0]!.details).toMatchObject({ title: 'Song', trackCount: 1, sessionStarted: true });
  });

  it('music.control_applied and music.denied describe the same control identically', async () => {
    const [applied] = await rowsFor('music.control_applied', { userId: 'u1', action: 'volume', value: 80 });
    const [denied] = await rowsFor('music.denied', { userId: 'u1', action: 'volume' });

    // Same category and same target shape — the ONLY difference between the
    // two outcomes of one control is the action name and the success flag.
    expect(applied!.category).toBe(denied!.category);
    expect(applied!.target_type).toBe(denied!.target_type);
    expect(applied!.target_id).toBe(denied!.target_id);
    expect(applied!.success).toBe(true);
    expect(denied!.success).toBe(false);
    expect(applied!.details).toMatchObject({ userId: 'u1', action: 'volume', value: 80 });
  });
});
