/**
 * Launcher Audit Log — persists launcher-side lifecycle/security operations to
 * the shared Supabase `audit_logs` table.
 *
 * [infrastructure-launcher] The launcher runs in its own Electron process and
 * has no access to the bot's in-process EventBus/AuditService, so it cannot
 * emit platform events. Instead it writes durable audit rows directly via the
 * Supabase REST API (mirroring supabase-sync.ts) using the operator's service
 * secret key. This gives VPS remote execution, deployment approval decisions,
 * update installs, and OS-keychain failures a durable, DB-observable trail.
 *
 * All writes are best-effort — a failed audit insert never blocks the operation
 * it is recording.
 */

/** A launcher-originated audit entry (maps onto one audit_logs row). */
export interface LauncherAuditEntry {
  /** e.g. 'launcher.vps_deployment.executed' — namespaced under launcher.* */
  action: string;
  /** audit_logs.category — e.g. 'launcher' / 'security'. */
  category: string;
  /** audit_logs.actor_id — defaults to 'launcher'. */
  actorId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  /** false for denied/failed operations. */
  success?: boolean;
  errorMessage?: string;
  correlationId?: string;
  occurrenceKey?: string;
}

export const LauncherAttemptPhases = [
  'updater-check',
  'updater-download',
  'vps-preflight',
] as const;

export type LauncherAttemptPhase = typeof LauncherAttemptPhases[number];

export const LauncherAttemptResults = ['success', 'retry', 'failure'] as const;

export type LauncherAttemptResult = typeof LauncherAttemptResults[number];

export interface LauncherAttemptIdentity {
  readonly operationId: string;
  readonly attempt: number;
}

export type LauncherAttemptCode =
  | 'updater_check_completed'
  | 'updater_check_failed'
  | 'updater_download_completed'
  | 'updater_download_failed'
  | 'updater_unavailable'
  | 'vps_preflight_succeeded'
  | 'vps_preflight_retryable_failure'
  | 'vps_preflight_terminal_failure'
  | 'vps_preflight_blocked';

export interface LauncherAttemptAuditInput {
  readonly operationId: string;
  readonly attempt: number;
  readonly phase: LauncherAttemptPhase;
  readonly result: LauncherAttemptResult;
  readonly code: LauncherAttemptCode;
  readonly message: string;
  readonly timestamp: string;
}

export class LauncherAttemptTracker {
  private readonly active = new Map<LauncherAttemptPhase, LauncherAttemptIdentity>();

  public constructor(private readonly createOperationId: () => string) {}

  public next(phase: LauncherAttemptPhase): LauncherAttemptIdentity {
    const previous = this.active.get(phase);
    const identity: LauncherAttemptIdentity = previous
      ? { operationId: previous.operationId, attempt: previous.attempt + 1 }
      : { operationId: this.createOperationId(), attempt: 1 };
    this.active.set(phase, identity);
    return identity;
  }

  public finish(phase: LauncherAttemptPhase, result: LauncherAttemptResult): void {
    switch (result) {
      case 'retry':
        return;
      case 'success':
      case 'failure':
        this.active.delete(phase);
    }
  }
}

function attemptAction(phase: LauncherAttemptPhase): string {
  switch (phase) {
    case 'updater-check':
      return 'launcher.updater.check_attempt';
    case 'updater-download':
      return 'launcher.updater.download_attempt';
    case 'vps-preflight':
      return 'launcher.vps_preflight.attempt';
  }
}

export function buildLauncherAttemptAuditEntry(input: LauncherAttemptAuditInput): LauncherAuditEntry {
  const sanitizedMessage = input.result === 'success'
    ? undefined
    : input.message.trim() ? '[redacted]' : 'Attempt failed.';

  return {
    action: attemptAction(input.phase),
    category: 'infrastructure',
    targetType: 'launcher_operation',
    targetId: input.operationId,
    details: {
      operationId: input.operationId,
      attempt: input.attempt,
      phase: input.phase,
      result: input.result,
      code: input.code,
      timestamp: input.timestamp,
    },
    correlationId: input.operationId,
    occurrenceKey: `launcher.attempt:${input.operationId}:${input.phase}:${input.attempt}`,
    success: input.result === 'success',
    ...(sanitizedMessage ? { errorMessage: sanitizedMessage } : {}),
  };
}

/** Supabase connection + guild scope needed to write a launcher audit row. */
export interface LauncherAuditContext {
  supabaseUrl: string;
  supabaseSecretKey: string;
  guildId: string;
}

/** Minimal config shape needed to resolve the audit target guild. */
export interface LauncherAuditConfigLike {
  discordGuildId: string;
  guilds: Array<{ discordGuildId: string; enabled: boolean }>;
}

/**
 * Resolve the guild an audit row should be scoped to: the first enabled guild
 * in the multi-guild list, else the first configured guild, else the legacy
 * single-guild id.
 */
export function resolveLauncherGuildId(config: LauncherAuditConfigLike): string {
  const enabled = config.guilds.find((g) => g.enabled)?.discordGuildId;
  return enabled || config.guilds[0]?.discordGuildId || config.discordGuildId || '';
}

/** Build the audit_logs row payload for a launcher entry. Pure — no I/O. */
export function buildLauncherAuditRow(
  guildId: string,
  entry: LauncherAuditEntry,
): Record<string, unknown> {
  return {
    guild_id: guildId,
    actor_type: 'system',
    actor_id: entry.actorId ?? 'launcher',
    action: entry.action,
    category: entry.category,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    details: entry.details ?? {},
    correlation_id: entry.correlationId ?? null,
    occurrence_key: entry.occurrenceKey ?? null,
    success: entry.success ?? true,
    error_message: entry.errorMessage ?? null,
  };
}

export interface WriteLauncherAuditDeps {
  /** Injectable fetch (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/**
 * Write a launcher audit entry to Supabase `audit_logs`. Best-effort: returns
 * `{ ok: false }` (without throwing) when credentials/guild are missing or the
 * request fails, so callers can fire-and-forget.
 */
export async function writeLauncherAuditLog(
  ctx: LauncherAuditContext,
  entry: LauncherAuditEntry,
  deps: WriteLauncherAuditDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.supabaseUrl || !ctx.supabaseSecretKey || !ctx.guildId) {
    return { ok: false, error: 'Missing Supabase credentials or guild id for launcher audit log.' };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const row = buildLauncherAuditRow(ctx.guildId, entry);
  const endpoint = `${ctx.supabaseUrl.replace(/\/+$/, '')}/rest/v1/audit_logs${entry.occurrenceKey ? '?on_conflict=guild_id,occurrence_key' : ''}`;
  const prefer = entry.occurrenceKey ? 'return=minimal,resolution=ignore-duplicates' : 'return=minimal';

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        apikey: ctx.supabaseSecretKey,
        Authorization: `Bearer ${ctx.supabaseSecretKey}`,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Supabase returned ${res.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
