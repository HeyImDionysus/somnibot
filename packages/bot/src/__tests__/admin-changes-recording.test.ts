/**
 * recordAdminChange — bot-driven mutations must be explained, and only claim
 * to be undoable when the reversal actually runs against Discord.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  recordAdminChange,
  undoByDeleting,
  undoByRestoring,
  REVERSIBLE_DISCORD_ACTIONS,
} from '../services/admin-changes.js';

function makeSupabase() {
  const rows: Record<string, unknown>[] = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    rows.push(row);
    return { error: null };
  });
  return {
    rows,
    insert,
    client: { from: vi.fn(() => ({ insert })) } as never,
  };
}

describe('recordAdminChange', () => {
  it('records a Discord create as undoable by deletion', async () => {
    const supa = makeSupabase();

    await recordAdminChange(supa.client, {
      guildId: 'g1',
      actorId: 'deployer',
      action: 'server_deploy.role_created',
      targetType: 'role',
      targetId: '555',
      description: 'Server setup created the role "Moderator".',
      before: null,
      after: { name: 'Moderator', discord_id: '555' },
      blastRadius: 'medium',
      undo: undoByDeleting('role', '555'),
    });

    expect(supa.rows).toHaveLength(1);
    const row = supa.rows[0];
    expect(row.is_undoable).toBe(true);
    expect(row.blast_radius).toBe('medium');
    expect(row.description).toBe('Server setup created the role "Moderator".');
    expect(row.undo_payload).toEqual({
      kind: 'discord',
      action: 'delete_role',
      payload: { discord_id: '555', id: '555' },
    });
  });

  it('records a destructive change as NOT undoable and says why', async () => {
    const supa = makeSupabase();

    await recordAdminChange(supa.client, {
      guildId: 'g1',
      actorId: 'sync-engine',
      action: 'drift_repair.channel_deleted',
      targetType: 'channel',
      targetId: '777',
      description: 'Drift repair deleted the channel "old-general".',
      blastRadius: 'critical',
      undoReason: 'the channel and its message history no longer exist',
    });

    const row = supa.rows[0];
    expect(row.is_undoable).toBe(false);
    expect(row.undo_payload).toBeNull();
    // The reason has to reach the operator, not just the code review.
    expect(row.description).toContain('cannot be undone');
    expect(row.description).toContain('message history no longer exist');
  });

  it('refuses an undo action outside the reversible allowlist', async () => {
    const supa = makeSupabase();

    await recordAdminChange(supa.client, {
      guildId: 'g1',
      actorId: 'someone',
      action: 'suspicious',
      targetType: 'role',
      description: 'Tried to smuggle a non-structural action into undo.',
      // bulk_send_dm is a real queue action, but it is not a reversal.
      undo: { kind: 'discord', action: 'bulk_send_dm', payload: {} },
    });

    const row = supa.rows[0];
    // Recorded (the change still happened) but explicitly not undoable.
    expect(row.is_undoable).toBe(false);
    expect(row.undo_payload).toBeNull();
    expect(REVERSIBLE_DISCORD_ACTIONS).not.toContain('bulk_send_dm');
  });

  it('never throws when the insert fails — bookkeeping must not break the caller', async () => {
    const insert = vi.fn(async () => ({ error: { message: 'db down' } }));
    const client = { from: vi.fn(() => ({ insert })) } as never;

    await expect(
      recordAdminChange(client, {
        guildId: 'g1',
        actorId: 'deployer',
        action: 'server_deploy.role_created',
        targetType: 'role',
        description: 'created something',
      }),
    ).resolves.toBeUndefined();
  });

  it('builds a restore undo carrying the previous field values', () => {
    const undo = undoByRestoring('role', '900', { name: 'Old Name', hoist: false });
    expect(undo).toEqual({
      kind: 'discord',
      action: 'update_role',
      payload: { discord_id: '900', id: '900', name: 'Old Name', hoist: false },
    });
  });

  it('requires confirmation only for high-impact reversals', async () => {
    const supa = makeSupabase();

    await recordAdminChange(supa.client, {
      guildId: 'g1',
      actorId: 'deployer',
      action: 'server_deploy.channel_created',
      targetType: 'channel',
      targetId: '1',
      description: 'created a channel',
      blastRadius: 'high',
      undo: undoByDeleting('channel', '1'),
    });
    await recordAdminChange(supa.client, {
      guildId: 'g1',
      actorId: 'deployer',
      action: 'server_deploy.role_created',
      targetType: 'role',
      targetId: '2',
      description: 'created a role',
      blastRadius: 'low',
      undo: undoByDeleting('role', '2'),
    });

    expect(supa.rows[0].requires_confirmation).toBe(true);
    expect(supa.rows[1].requires_confirmation).toBe(false);
  });
});
