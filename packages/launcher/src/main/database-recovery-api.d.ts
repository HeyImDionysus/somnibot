export type DatabaseCredentials = {
  readonly projectUrl: string;
  readonly password: string;
  readonly template?: string;
};
export type RecoverySource = DatabaseCredentials & { readonly guildId: string };
export type RehearsalRequest = DatabaseCredentials & { readonly backupId?: string; readonly confirmation: string };
export type RecoveryResult = {
  readonly status: 'backed-up' | 'rehearsed' | 'blocked' | 'needs-prerequisite' | 'failed' | 'busy';
  readonly message: string;
  readonly backupId?: string;
};
