export type RetainedBackupAuditContext = {
  readonly supabaseUrl: string;
  readonly supabaseSecretKey: string;
  readonly guildId: string;
};

export type RetainedBackupAuditAnchor = {
  readonly backupId: string;
  readonly sourceProjectRef: string;
  readonly checksumSha256: string;
};

export type RetainedBackupAuditDependencies = {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

const MAX_AUDIT_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_AUDIT_TIMEOUT_MS = 2_500;
const AUDIT_OCCURRENCE_PREFIX = 'launcher.backup.database_succeeded';

async function readBoundedResponse(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let raw = '';
  while (true) {
    const result = await reader.read();
    if (result.done) return raw + decoder.decode();
    bytes += result.value.byteLength;
    if (bytes > MAX_AUDIT_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(result.value, { stream: true });
  }
}

export function retainedBackupAuditOccurrenceKey(anchor: RetainedBackupAuditAnchor): string {
  return `${AUDIT_OCCURRENCE_PREFIX}:${anchor.backupId}:${anchor.sourceProjectRef}:${anchor.checksumSha256}`;
}

function isExactReceipt(value: unknown, occurrenceKey: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length === 1
    && 'occurrence_key' in value && value.occurrence_key === occurrenceKey);
}

export async function verifyRetainedBackupAudit(
  context: RetainedBackupAuditContext,
  anchor: RetainedBackupAuditAnchor,
  dependencies: RetainedBackupAuditDependencies = {},
): Promise<boolean> {
  if (!context.supabaseUrl || !context.supabaseSecretKey || !/^\d{17,20}$/.test(context.guildId)
    || !/^[a-z0-9]{1,63}$/.test(anchor.sourceProjectRef)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(anchor.backupId)
    || !/^[0-9a-f]{64}$/.test(anchor.checksumSha256)) return false;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) return false;
  const occurrenceKey = retainedBackupAuditOccurrenceKey(anchor);
  try {
    const endpoint = new URL('/rest/v1/audit_logs', context.supabaseUrl);
    endpoint.searchParams.set('select', 'occurrence_key');
    endpoint.searchParams.set('guild_id', `eq.${context.guildId}`);
    endpoint.searchParams.set('action', 'eq.launcher.backup.database_succeeded');
    endpoint.searchParams.set('success', 'eq.true');
    endpoint.searchParams.set('target_type', 'eq.database_backup');
    endpoint.searchParams.set('occurrence_key', `eq.${occurrenceKey}`);
    endpoint.searchParams.set('limit', '2');
    const response = await (dependencies.fetchImpl ?? fetch)(endpoint, {
      method: 'GET',
      headers: {
        apikey: context.supabaseSecretKey,
        Authorization: `Bearer ${context.supabaseSecretKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const raw = await readBoundedResponse(response);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 1 && isExactReceipt(parsed[0], occurrenceKey);
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
}
