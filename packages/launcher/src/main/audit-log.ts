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

  try {
    const res = await fetchImpl(`${ctx.supabaseUrl.replace(/\/+$/, '')}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        apikey: ctx.supabaseSecretKey,
        Authorization: `Bearer ${ctx.supabaseSecretKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
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
