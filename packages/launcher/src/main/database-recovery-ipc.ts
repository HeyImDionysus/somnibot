import path from 'node:path';
import { app, dialog, ipcMain } from 'electron';
import { getConfig } from './config-store.js';
import { resolveLauncherGuildId, writeLauncherAuditLog } from './audit-log.js';
import { verifyRetainedBackupAudit } from './database-recovery-audit-anchor.js';
import { manifestChecksum } from './database-recovery-artifacts.js';
import { createDatabaseRecovery } from './database-recovery.js';
import type { RecoveryBackupSummary } from './database-recovery-api.js';
import { databaseConnection, type RecoveryResult, type RecoverySource, type RehearsalRequest } from './database-recovery-contract.js';
import { runRecoveryCommand } from './database-recovery-process.js';

function currentSource(): RecoverySource {
  const config = getConfig();
  return { projectUrl: config.supabaseUrl, password: config.supabaseDbPassword,
    template: config.supabaseDbUrlTemplate, guildId: resolveLauncherGuildId(config) };
}

export function parseRehearsalRequest(raw: unknown): RehearsalRequest | null {
  if (!raw || typeof raw !== 'object' || !('projectUrl' in raw) || typeof raw.projectUrl !== 'string' || raw.projectUrl.length > 200
    || !('password' in raw) || typeof raw.password !== 'string' || raw.password.length > 4096
    || !('backupId' in raw) || typeof raw.backupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.backupId)
    || !('confirmation' in raw) || typeof raw.confirmation !== 'string' || !/^[a-z0-9]+$/.test(raw.confirmation)
    || ('template' in raw && (typeof raw.template !== 'string' || raw.template.length > 300))) return null;
  return { projectUrl: raw.projectUrl, password: raw.password, backupId: raw.backupId,
    confirmation: raw.confirmation, template: 'template' in raw && typeof raw.template === 'string' ? raw.template : '' };
}

export function registerDatabaseRecoveryIpc(): void {
  const recovery = createDatabaseRecovery(path.join(app.getPath('userData'), 'backups', 'database'), {
    run: runRecoveryCommand,
    audit: async (entry, source) => {
      const config = getConfig();
      if (config.supabaseUrl !== source.projectUrl || resolveLauncherGuildId(config) !== source.guildId) return false;
      const result = await writeLauncherAuditLog({ supabaseUrl: source.projectUrl,
        supabaseSecretKey: config.supabaseSecretKey, guildId: source.guildId }, entry);
      return result.ok;
    },
    authenticate: async (manifest, source, timeoutMs) => {
      const config = getConfig();
      if (config.supabaseUrl !== source.projectUrl || resolveLauncherGuildId(config) !== source.guildId) return false;
      return await verifyRetainedBackupAudit({ supabaseUrl: source.projectUrl,
        supabaseSecretKey: config.supabaseSecretKey, guildId: source.guildId }, {
        backupId: manifest.backupId, sourceProjectRef: databaseConnection(source).projectRef,
        checksumSha256: manifestChecksum(manifest),
      }, { timeoutMs });
    },
  });
  ipcMain.handle('database:backup', async (): Promise<RecoveryResult> => {
    try {
      const source = currentSource();
      const connection = databaseConnection(source);
      const answer = await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Back up source database'], defaultId: 0, cancelId: 0,
        title: 'Capture a logical database backup', message: `Back up saved source project ${connection.projectRef}?`,
        detail: 'Reads the source database using installed Docker and PostgreSQL clients, a required cached image, and bundled Supabase dump scripts. Saves sensitive logical dump files on this machine (512 MiB limit, 2 GiB free reserve). Does not restore or change production data. Storage object bytes and provider settings are excluded.' });
      if (answer.response !== 1) return { status: 'blocked', message: 'Backup cancelled. No database action was run.' };
      return await recovery.backup(source);
    } catch (error) {
      return { status: 'blocked', message: error instanceof Error ? 'Source connection is unavailable. Review saved database credentials and retry.' : 'Source configuration could not be read.' };
    }
  });
  ipcMain.handle('database:retained-backup', async (): Promise<RecoveryBackupSummary | null> => {
    try {
      return await recovery.latestBackup(currentSource());
    } catch {
      return null;
    }
  });
  ipcMain.handle('database:rehearse', async (_event, raw: unknown): Promise<RecoveryResult> => {
    const request = parseRehearsalRequest(raw);
    if (!request) return { status: 'blocked', message: 'Choose a current backup and explicitly confirm an unused target project.' };
    try {
      const source = currentSource();
      const target = databaseConnection(request);
      if (databaseConnection(source).projectRef === target.projectRef || request.confirmation !== target.projectRef) return { status: 'blocked', message: 'Rehearsal target must be a different, explicitly confirmed project.' };
      const answer = await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Restore into isolated target'], defaultId: 0, cancelId: 0,
        title: 'Confirm isolated restore rehearsal', message: `Restore captured backup into ${target.projectRef}?`,
        detail: 'This writes sensitive source data into that target. You must own it, designate it unused and isolated, and keep applications/external writers disconnected. Existing application relations, auth users, or storage objects are refused. No project is created or paid for. Successful target data is retained; source data is never restored or deleted.' });
      if (answer.response !== 1) return { status: 'blocked', message: 'Rehearsal cancelled. No target action was run.' };
      return await recovery.rehearse(source, request);
    } catch (error) {
      return { status: 'blocked', message: error instanceof Error ? 'Rehearsal could not start. Review the explicit target and retry.' : 'Rehearsal request could not be read.' };
    }
  });
}
