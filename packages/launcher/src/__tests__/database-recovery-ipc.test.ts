import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  confirm: vi.fn(async () => ({ response: 0 })),
  backup: vi.fn(async () => ({ status: 'backed-up' })),
  rehearse: vi.fn(async () => ({ status: 'rehearsed' })),
}));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/private-fixture' },
  dialog: { showMessageBox: fixtures.confirm }, ipcMain: { handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => fixtures.handlers.set(name, callback) } }));
vi.mock('../main/config-store.js', () => ({ getConfig: () => ({ supabaseUrl: 'https://sourceproject.supabase.co', supabaseDbPassword: 'source-secret', supabaseSecretKey: 'audit-secret', discordGuildId: '123456789012345678', guilds: [] }) }));
vi.mock('../main/database-recovery.js', () => ({ createDatabaseRecovery: () => ({ backup: fixtures.backup, rehearse: fixtures.rehearse }) }));
import { registerDatabaseRecoveryIpc } from '../main/database-recovery-ipc.js';

beforeEach(() => { vi.clearAllMocks(); fixtures.handlers.clear(); fixtures.confirm.mockResolvedValue({ response: 0 }); registerDatabaseRecoveryIpc(); });

describe('database recovery native approval', () => {
  it('does not bypass a cancelled native backup confirmation', async () => {
    // Given an owner who cancels the native confirmation.
    // When the renderer invokes backup IPC.
    await fixtures.handlers.get('database:backup')?.();
    // Then no backup runner is entered and the safe default is Cancel.
    expect(fixtures.backup).not.toHaveBeenCalled();
    expect(fixtures.confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0 }));
  });

  it('rejects a source-alias restore request before presenting approval', async () => {
    // Given a renderer request targeting the source project.
    const request = { projectUrl: 'https://sourceproject.supabase.co', password: 'secret', backupId: '11111111-1111-4111-8111-111111111111', confirmation: 'sourceproject' };
    // When rehearsal IPC is invoked directly.
    await fixtures.handlers.get('database:rehearse')?.({}, request);
    // Then no dialog or restore execution can approve that source target.
    expect(fixtures.confirm).not.toHaveBeenCalled();
    expect(fixtures.rehearse).not.toHaveBeenCalled();
  });

  it('executes an isolated request only after native approval', async () => {
    // Given an explicit different target and an affirmative native decision.
    fixtures.confirm.mockResolvedValue({ response: 1 });
    const request = { projectUrl: 'https://targetproject.supabase.co', password: 'secret', backupId: '11111111-1111-4111-8111-111111111111', confirmation: 'targetproject' };
    // When rehearsal is requested.
    await fixtures.handlers.get('database:rehearse')?.({}, request);
    // Then the approved parsed request reaches the owned-backup runner.
    expect(fixtures.rehearse).toHaveBeenCalledWith(expect.objectContaining({ guildId: '123456789012345678' }), { ...request, template: '' });
    expect(JSON.stringify(fixtures.confirm.mock.calls)).not.toContain('source-secret');
  });
});
