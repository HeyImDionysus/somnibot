import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

type KeyStatus = 'pending_activation' | 'active' | 'expired' | 'revoked' | 'suspended';
type HealthQueryResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count: number | null;
};

const LICENSE_KEY_FILTER_CHUNK = 100;

async function queryKeyChunks<T>(
  keyIds: string[],
  query: (chunk: string[]) => PromiseLike<HealthQueryResult<T>>,
): Promise<HealthQueryResult<T>> {
  const rows: T[] = [];
  let count = 0;
  for (let offset = 0; offset < keyIds.length; offset += LICENSE_KEY_FILTER_CHUNK) {
    const result = await query(keyIds.slice(offset, offset + LICENSE_KEY_FILTER_CHUNK));
    if (result.error) return { data: null, error: result.error, count: null };
    if (!Array.isArray(result.data)) {
      return {
        data: null,
        error: { message: 'License health chunk returned malformed data' },
        count: null,
      };
    }
    rows.push(...result.data);
    count += typeof result.count === 'number' ? result.count : result.data.length;
  }
  return { data: rows.slice(0, 5_000), error: null, count };
}

function countBy<T extends string>(values: T[], allowed: readonly T[]): Record<T, number> {
  return Object.fromEntries(allowed.map((value) => [
    value,
    values.filter((candidate) => candidate === value).length,
  ])) as Record<T, number>;
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;
  const supabase = createAdminSupabase();

  const { data: keys, error: keyError, count: keyTotal } = await supabase
    .from('license_keys')
    .select('id, product_id, status, activated_at, created_at', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(5_000);
  if (keyError) return dbError(keyError, 'license/health/keys');
  if (!Array.isArray(keys)) {
    return NextResponse.json(
      { success: false, error: 'License health key data is malformed' },
      { status: 500 },
    );
  }

  const keyIds = keys
    .map((key) => key.id)
    .filter((id): id is string => typeof id === 'string');
  const keyStatuses = keys
    .map((key) => key.status)
    .filter((status): status is KeyStatus =>
      ['pending_activation', 'active', 'expired', 'revoked', 'suspended'].includes(status),
    );
  if (keyIds.length !== keys.length || keyStatuses.length !== keys.length) {
    return NextResponse.json(
      { success: false, error: 'License health key data is malformed' },
      { status: 500 },
    );
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const [sessionsResult, validationsResult, alertsResult] = await Promise.all([
    keyIds.length === 0
      ? Promise.resolve({ data: [], error: null, count: 0 })
      : queryKeyChunks(keyIds, (chunk) => supabase
        .from('license_sessions')
        .select('id, license_key_id, active, last_seen_at', { count: 'exact' })
        .in('license_key_id', chunk)
        .limit(5_000)),
    keyIds.length === 0
      ? Promise.resolve({ data: [], error: null, count: 0 })
      : queryKeyChunks(keyIds, (chunk) => supabase
        .from('license_validations')
        .select('id, license_key_id, result, created_at', { count: 'exact' })
        .in('license_key_id', chunk)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(5_000)),
    supabase
      .from('alerts')
      .select('id, alert_type, severity, title, created_at')
      .eq('guild_id', guildId)
      .is('resolved_at', null)
      .or('alert_type.ilike.license%,alert_type.eq.commerce_missing_license_delivery')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (sessionsResult.error) return dbError(sessionsResult.error, 'license/health/sessions');
  if (validationsResult.error) return dbError(validationsResult.error, 'license/health/validations');
  if (alertsResult.error) return dbError(alertsResult.error, 'license/health/alerts');
  if (
    !Array.isArray(sessionsResult.data)
    || !Array.isArray(validationsResult.data)
    || !Array.isArray(alertsResult.data)
  ) {
    return NextResponse.json(
      { success: false, error: 'License health data is malformed' },
      { status: 500 },
    );
  }

  const validationResults = validationsResult.data
    .map((row) => row.result)
    .filter((result): result is string => typeof result === 'string');
  if (validationResults.length !== validationsResult.data.length) {
    return NextResponse.json(
      { success: false, error: 'License health validation data is malformed' },
      { status: 500 },
    );
  }

  const keyCounts = countBy(keyStatuses, [
    'pending_activation',
    'active',
    'expired',
    'revoked',
    'suspended',
  ] as const);
  const pendingOlderThanDay = keys.filter((key) =>
    key.status === 'pending_activation'
    && typeof key.created_at === 'string'
    && Date.now() - Date.parse(key.created_at) > 24 * 60 * 60 * 1_000,
  ).length;
  const activeSessions = sessionsResult.data.filter((session) => session.active === true).length;
  // An ACTIVE session attached to a revoked/expired key means a device is
  // still validating against a licence the owner terminated -- reachable
  // because admin revocation deactivates sessions in a separate write whose
  // failure is tolerated before the key itself is revoked. Healthy must never
  // paper over that.
  const terminalKeyIds = new Set(
    keys.filter((key) => key.status === 'revoked' || key.status === 'expired').map((key) => key.id),
  );
  const sessionsOnTerminalKeys = sessionsResult.data.filter(
    (session) => session.active === true && terminalKeyIds.has(session.license_key_id),
  ).length;
  const unavailable24h = validationResults.filter((result) => result === 'unavailable').length;
  const deviceLimit24h = validationResults.filter((result) => result === 'over_device_limit').length;
  const invalid24h = validationResults.filter((result) =>
    ['invalid_key', 'product_mismatch', 'device_fingerprint_required'].includes(result),
  ).length;
  const issueCount =
    pendingOlderThanDay
    + keyCounts.suspended
    + unavailable24h
    + deviceLimit24h
    + invalid24h
    + sessionsOnTerminalKeys
    + alertsResult.data.length;
  const totalKeys = keyTotal ?? keys.length;
  const keySampleTruncated = totalKeys > keys.length;
  const validationSampleTruncated =
    (validationsResult.count ?? validationsResult.data.length) > validationsResult.data.length;
  const sessionSampleTruncated =
    (sessionsResult.count ?? sessionsResult.data.length) > sessionsResult.data.length;

  return NextResponse.json({
    success: true,
    data: {
      // A partial sample can never establish whole-guild health — and that
      // includes SESSIONS: a truncated session sample under-reports the
      // active-device count, so declaring 'healthy' beside an admittedly
      // incomplete number would be the green banner lying.
      state:
        totalKeys === 0 && issueCount === 0
          ? 'empty'
          : issueCount > 0
              || keySampleTruncated
              || validationSampleTruncated
              || sessionSampleTruncated
            ? 'needs_attention'
            : 'healthy',
      keyCounts,
      sampledKeys: keys.length,
      totalKeys,
      activeSessions,
      sessionsOnTerminalKeys,
      totalSessions: sessionsResult.count ?? sessionsResult.data.length,
      validationWindowHours: 24,
      validationCount: validationsResult.count ?? validationsResult.data.length,
      unavailable24h,
      deviceLimit24h,
      invalid24h,
      pendingOlderThanDay,
      unresolvedAlerts: alertsResult.data,
      truncated:
        keySampleTruncated
        || sessionSampleTruncated
        || validationSampleTruncated,
      checkedAt: new Date().toISOString(),
    },
  });
}
