/**
 * audit — coverage tests
 *
 * Tests writeAuditLog and writeAuditBatch with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { writeAuditLog, writeAuditBatch } from '../services/audit.js';

function chainBuilder(resolveValue: any = { error: null }) {
  const chain: any = {};
  for (const m of ['insert']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(error: any = null) {
  return {
    from: vi.fn().mockReturnValue(chainBuilder({ error })),
  };
}

describe('writeAuditLog', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes a full audit entry', async () => {
    const supabase = makeSupabase();
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'bot',
      actorId: 'deployer',
      action: 'deploy.create.role',
      targetType: 'role',
      targetId: 'r123',
      details: { name: 'Admin' },
      beforeState: { color: 'red' },
      afterState: { color: 'blue' },
      success: true,
    });
    expect(supabase.from).toHaveBeenCalledWith('audit_logs');
  });

  it('writes a minimal audit entry (no optional fields)', async () => {
    const supabase = makeSupabase();
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'system',
      actorId: 'cron',
      action: 'cleanup',
    });
    expect(supabase.from).toHaveBeenCalledWith('audit_logs');
  });

  it('handles DB error gracefully', async () => {
    const supabase = makeSupabase({ message: 'insert failed' });
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'bot',
      actorId: 'deployer',
      action: 'deploy.create.role',
    });
    // Should not throw
  });

  it('handles exception gracefully', async () => {
    const supabase = {
      from: vi.fn().mockImplementation(() => { throw new Error('crash'); }),
    };
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'bot',
      actorId: 'deployer',
      action: 'test',
    });
    // Should not throw
  });
});

describe('writeAuditBatch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes a batch of deployment actions', async () => {
    const supabase = makeSupabase();
    await writeAuditBatch(supabase as any, 'g1', 'deploy-1', [
      { action: 'create', entityType: 'role', entityName: 'Admin', discordId: 'r1', success: true },
      { action: 'update', entityType: 'channel', entityName: 'General', success: true },
      { action: 'delete', entityType: 'role', entityName: 'Old', success: false, error: 'not found' },
    ]);
    expect(supabase.from).toHaveBeenCalledWith('audit_logs');
  });

  it('handles DB error in batch', async () => {
    const supabase = makeSupabase({ message: 'batch failed' });
    await writeAuditBatch(supabase as any, 'g1', 'deploy-2', [
      { action: 'create', entityType: 'role', entityName: 'Test', success: true },
    ]);
    // Should not throw
  });

  it('handles exception in batch', async () => {
    const supabase = {
      from: vi.fn().mockImplementation(() => { throw new Error('crash'); }),
    };
    await writeAuditBatch(supabase as any, 'g1', 'deploy-3', [
      { action: 'create', entityType: 'role', entityName: 'Test', success: true },
    ]);
    // Should not throw
  });

  it('stamps deploy batch rows with the sync category', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn().mockReturnValue({ insert }) };
    await writeAuditBatch(supabase as any, 'g1', 'deploy-4', [
      { action: 'create', entityType: 'role', entityName: 'Admin', success: true },
    ]);
    expect(insert.mock.calls[0][0][0]).toMatchObject({ category: 'sync', action: 'deploy.create.role' });
  });
});

// ── E-B: category / correlationId / occurrenceKey threading ──

describe('writeAuditLog — rail B fields', () => {
  function makeCapturingSupabase() {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    return { from: vi.fn(() => ({ insert, upsert })), _insert: insert, _upsert: upsert };
  }

  beforeEach(() => { vi.clearAllMocks(); });

  it('plain-inserts keyless entries with category defaulting to system', async () => {
    const supabase = makeCapturingSupabase();
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'bot',
      actorId: 'onboarding',
      action: 'member.onboarding_completed',
    });
    expect(supabase._insert).toHaveBeenCalledTimes(1);
    expect(supabase._upsert).not.toHaveBeenCalled();
    expect(supabase._insert.mock.calls[0][0]).toMatchObject({
      category: 'system',
      correlation_id: null,
      occurrence_key: null,
    });
  });

  it('threads category and correlationId into the row', async () => {
    const supabase = makeCapturingSupabase();
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'discord',
      actorId: 'u1',
      action: 'profiles.title_updated',
      category: 'profiles',
      correlationId: 'profile-u1',
    });
    expect(supabase._insert.mock.calls[0][0]).toMatchObject({
      actor_type: 'discord',
      category: 'profiles',
      correlation_id: 'profile-u1',
    });
  });

  it('upserts occurrence-keyed entries with ON CONFLICT DO NOTHING semantics', async () => {
    const supabase = makeCapturingSupabase();
    await writeAuditLog(supabase as any, {
      guildId: 'g1',
      actorType: 'system',
      actorId: 'sweeper',
      action: 'team.invite_expired',
      category: 'rbac',
      occurrenceKey: 'team.invite_expired:inv-1',
    });
    expect(supabase._insert).not.toHaveBeenCalled();
    expect(supabase._upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = supabase._upsert.mock.calls[0];
    expect(rows[0]).toMatchObject({
      category: 'rbac',
      occurrence_key: 'team.invite_expired:inv-1',
    });
    expect(opts).toEqual({ onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true });
  });

  it('accepts the unified actorType union (dashboard/user/webhook/automation)', async () => {
    const supabase = makeCapturingSupabase();
    for (const actorType of ['dashboard', 'user', 'webhook', 'automation'] as const) {
      await writeAuditLog(supabase as any, {
        guildId: 'g1',
        actorType,
        actorId: 'a1',
        action: 'test.action',
      });
    }
    expect(supabase._insert).toHaveBeenCalledTimes(4);
    expect(supabase._insert.mock.calls.map((c) => c[0].actor_type))
      .toEqual(['dashboard', 'user', 'webhook', 'automation']);
  });
});
