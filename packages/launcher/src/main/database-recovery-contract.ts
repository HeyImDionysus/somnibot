import type { DatabaseCredentials } from './database-recovery-api.js';
export type { DatabaseCredentials, RecoverySource, RehearsalRequest, RecoveryResult } from './database-recovery-api.js';
export type RecoveryCommand = { readonly tool: 'docker' | 'psql'; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly directory?: string; readonly outputFile?: string; readonly outputLimit?: number; readonly input?: Buffer };
export class DatabaseRecoveryError extends Error {
  public constructor(public readonly code: string) { super(code); this.name = 'DatabaseRecoveryError'; }
}
export function databaseConnection(input: DatabaseCredentials): { readonly projectRef: string; readonly url: string; readonly env: NodeJS.ProcessEnv } {
  const project = new URL(input.projectUrl);
  const projectRef = project.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!projectRef || project.protocol !== 'https:' || project.port || project.username || project.password
    || project.search || project.hash || project.pathname !== '/' || !input.password || input.password.includes('\0')) {
    throw new DatabaseRecoveryError('invalid-connection');
  }
  const connection = new URL(input.template || `postgresql://postgres@db.${projectRef}.supabase.co:5432/postgres`);
  const direct = connection.hostname === `db.${projectRef}.supabase.co` && connection.username === 'postgres';
  const pooler = /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(connection.hostname) && connection.username === `postgres.${projectRef}`;
  if (connection.protocol !== 'postgresql:' || connection.port !== '5432' || connection.pathname !== '/postgres'
    || connection.password || connection.search || connection.hash || (!direct && !pooler)) {
    throw new DatabaseRecoveryError('invalid-connection');
  }
  return { projectRef, url: connection.toString(), env: {
    PGHOST: connection.hostname, PGPORT: connection.port, PGUSER: connection.username, PGDATABASE: 'postgres',
    PGPASSWORD: input.password, PGCONNECT_TIMEOUT: '10', PGSSLMODE: 'require',
    PGAPPNAME: 'somnibot-database-recovery', PGOPTIONS: '-c statement_timeout=120000 -c lock_timeout=5000',
  } };
}
