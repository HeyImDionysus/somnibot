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
});
