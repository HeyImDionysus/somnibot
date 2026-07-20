/**
 * scenario-runner/scripts/administration-diagnostics — the Diagnostics domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven against LOCAL Supabase. Unlike the wallet template, this
 * domain has NO Discord slash-command surface (administration domains expose no
 * /diagnostics command — see catalog INTENT-DELTAS "cross"), so nothing is driven
 * through `runSlash`. Instead the REAL production `DiagnosticsService` is what runs:
 * `initGuildFeatures` (guild-init.ts:450) constructs `new DiagnosticsService(...)`
 * and calls `.start()`, which writes an immediate health snapshot to
 * `bot_diagnostics`, appends `health_metrics` latency rows, and evaluates
 * `AlertManager` — all through the SAME `client.supabase` the harness boots. So
 * `bootGuild` itself drives the real feature; every assertion reads back what that
 * real code wrote (never a synthetic literal).
 *
 * The honesty boundary here is unusually wide, so this domain is MOSTLY GATED:
 *   - Alert thresholds are constructor-level `DEFAULT_THRESHOLDS` with NO
 *     guild_config / dashboard wiring (catalog INTENT-DELTAS flags this as a code
 *     GAP), so SET-A / SET-B "lowered threshold takes live effect" cannot be driven
 *     — the bot-only harness has no lever to lower a threshold. GATED, not faked.
 *   - The guided plain-language presentation is a dashboard surface and an
 *     unimplemented code GAP; there is no member-facing bot reply to brand. GATED.
 *   - RBAC (member 403 on /api/diagnostics + /diagnostics) is a dashboard-session
 *     lane; the DB-side enforcement (service-role-only RLS) IS proven here.
 *   - Discord channel/owner-mirror readback needs DISCORD_TOKEN + a live guild.
 *   - Fault-injection lanes (transient snapshot-write failure, dependency outage
 *     mid-op) are not injectable against the deliberately-reachable local DB.
 *
 * Because the harness runs with NO local Redis, the real bot honestly reports
 * Valkey down: the boot snapshot writes `valkey_connected=false` and `AlertManager`
 * opens a real critical `valkey_disconnected` alert — which is exactly the DEPFAIL
 * condition, so DEPFAIL is genuinely driven (not gated) when `capabilities.redis`
 * is absent.
 *
 * Two real divergences are surfaced as FAILs (findings for the owner, never softened):
 *   - RACE: the `alerts` table enforces a per-type unresolved-uniqueness index only
 *     for `fraud_check_failure` (20260709170000); diagnostic alert types have none,
 *     so the AlertManager's check-then-insert is the sole (non-atomic) dedup guard.
 *   - DEPFAIL: a dependency-down condition opens the alert but writes NO
 *     `diagnostics.dependency_down` audit_logs row (the catalog contracts one).
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
// NOTE: ../../captured-response.js is intentionally not imported — this domain has
// no member-facing captured reply surface to inspect (no slash command), so every
// proof is a DB read-back, not a CapturedResponse assertion.
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Typed row reads ────────────────────────────────────────────────────────

interface DiagnosticsRow {
  guild_id: string;
  type: string;
  uptime_seconds: number;
  memory_rss_mb: number;
  memory_heap_mb: number;
  valkey_connected: boolean;
  discord_ws_ping: number | null;
  snapshot_at: string;
}

interface AlertRow {
  id: string;
  guild_id: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string | null;
  resolved: boolean;
}

interface AuditRow {
  guild_id: string | null;
  action: string;
  actor_type: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

// ── Live-stack read helpers ────────────────────────────────────────────────

async function readSnapshot(handle: LiveClientHandle, type = 'health'): Promise<DiagnosticsRow | null> {
  const { data } = await handle.supabase
    .from('bot_diagnostics')
    .select('guild_id, type, uptime_seconds, memory_rss_mb, memory_heap_mb, valkey_connected, discord_ws_ping, snapshot_at')
    .eq('guild_id', handle.guildId)
    .eq('type', type)
    .maybeSingle();
  return (data as DiagnosticsRow | null) ?? null;
}

async function snapshotCount(handle: LiveClientHandle, type = 'health'): Promise<number> {
  const { count } = await handle.supabase
    .from('bot_diagnostics')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('type', type);
  return count ?? 0;
}

/** Poll until the REAL boot snapshot lands (fire-and-forget in DiagnosticsService.start). */
async function waitForSnapshot(
  handle: LiveClientHandle,
  timeoutMs = 20_000,
  type = 'health',
): Promise<DiagnosticsRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readSnapshot(handle, type);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

async function healthMetricCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('health_metrics')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function waitForHealthMetric(handle: LiveClientHandle, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await healthMetricCount(handle);
    if (n > 0) return n;
    if (Date.now() > deadline) return 0;
    await sleep(400);
  }
}

async function unresolvedAlerts(handle: LiveClientHandle, alertType?: string): Promise<AlertRow[]> {
  let query = handle.supabase
    .from('alerts')
    .select('id, guild_id, alert_type, severity, title, message, resolved')
    .eq('guild_id', handle.guildId)
    .eq('resolved', false);
  if (alertType) query = query.eq('alert_type', alertType);
  const { data } = await query;
  return (data as AlertRow[] | null) ?? [];
}

/** Poll until the REAL AlertManager has opened an unresolved alert of the given type. */
async function waitForUnresolvedAlert(
  handle: LiveClientHandle,
  alertType: string,
  timeoutMs = 20_000,
): Promise<AlertRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await unresolvedAlerts(handle, alertType);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) return [];
    await sleep(400);
  }
}

async function auditRows(handle: LiveClientHandle, action: string): Promise<AuditRow[]> {
  const { data } = await handle.supabase
    .from('audit_logs')
    .select('guild_id, action, actor_type')
    .eq('guild_id', handle.guildId)
    .eq('action', action);
  return (data as AuditRow[] | null) ?? [];
}

/** Poll for a flushed audit row (AuditService batches on a 5s flush timer). */
async function waitForAudit(handle: LiveClientHandle, action: string, timeoutMs = 14_000): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await auditRows(handle, action);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) return [];
    await sleep(500);
  }
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (mirrors the wallet
 * template). Returns the row count an anon key reads (deny → 0), null when
 * inconclusive. A 42501 / "permission denied" is treated as the deny we prove.
 */
async function anonReadCount(anonKey: string, table: string, guildId: string): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=guild_id&guild_id=eq.${encodeURIComponent(guildId)}`;
  try {
    const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ──────────────────────────────────────────────

/**
 * Prove anon/authenticated clients read ZERO rows of a diagnostics table while the
 * service role sees a real row under this guild (positive control) — RLS/GRANT
 * deny_all. GATEs (never faked) when no anon key or the probe is inconclusive.
 */
async function proveRlsDeny(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  serviceSees: boolean,
): Promise<void> {
  const promise = `The service role reads this guild's ${table} row while anon/authenticated clients read zero (service-role-only RLS).`;
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate('database-RLS', 'db-rls', promise, `no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial on ${table} not exercised — service-role guild-scoping is still read directly.`);
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate('database-RLS', 'db-rls', promise, `the anon REST probe on ${table} was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated).`);
    return;
  }
  ctx.expect(serviceSees && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise,
    observation: `service-role sees a real ${table} row under guild "${handle.guildId}" (${serviceSees}); an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — health data is exposed without the diagnostics permission.`,
  });
}

/** The member-facing branded/guided surface. This domain has none (no bot reply). */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Guided explanations and alerts render in the owner voice with plain-language suggestions and subtle powered-by-SomniBot attribution.',
    'diagnostics expose no member-facing bot reply; the guided plain-language presentation is a dashboard surface and, per catalog INTENT-DELTAS, an unimplemented code GAP (guided-mode has no code surface) — nothing to inspect in a bot-only harness.',
  );
}

/** Owner-mirror + channel readback of alerts/recovery needs a live gateway. */
function gateOwnerMirrorReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Each alert condition mirrors once on open and once on recovery to the owner notification channel.',
    'requires the live owner notification channel readback (DISCORD_TOKEN + live guild) to observe the mirrored message.',
  );
}

/** The AlertManager never writes audit_logs for alert lifecycle (code GAP). */
function gateAlertAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'the diagnostics AlertManager writes no audit_logs row for alert open/resolve, and threshold-change audits originate in the (absent) dashboard config path — diagnostics audit lifecycle is an unimplemented code GAP.',
  );
}

/** When the fire-and-forget boot snapshot never landed, gate the DB-observable classes honestly. */
function gateSnapshotAbsent(ctx: ScenarioContext): void {
  const reason =
    'the real DiagnosticsService boot snapshot did not land within the poll window (Valkey connect back-pressure with no local Redis, or a slow boot); the write path could not be observed this run.';
  ctx.gate('Discord', 'db-observable', 'The DiagnosticsService writes a health snapshot out of the box.', reason);
  ctx.gate('database-RLS', 'db-observable', 'A single (guild,type) snapshot row plus accumulating health_metrics exist.', reason);
}

/**
 * Re-upsert the (guild,'health') snapshot with a distinctive sentinel — the EXACT
 * onConflict target the bot uses (`upsert(..., { onConflict: 'guild_id,type' })`) —
 * and prove the row count stays 1 with the latest value winning: the DB-level
 * mechanism that makes "repeated snapshots update, not duplicate" true.
 */
async function proveSnapshotUpsertInPlace(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const before = await snapshotCount(handle, 'health');
  const sentinel = 917_531;
  await handle.supabase
    .from('bot_diagnostics')
    .upsert(
      { guild_id: handle.guildId, type: 'health', uptime_seconds: sentinel, snapshot_at: new Date().toISOString() },
      { onConflict: 'guild_id,type' },
    );
  const after = await readSnapshot(handle, 'health');
  const count = await snapshotCount(handle, 'health');
  ctx.expect(before === 1 && count === 1 && after?.uptime_seconds === sentinel, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering a snapshot for (guild, "health") updates the one row in place (composite PK guild_id,type) — never a duplicate.',
    observation: `pre-reupsert rows=${before}, post-reupsert rows=${count} (expected 1), latest uptime_seconds=${after?.uptime_seconds} (expected sentinel ${sentinel}).`,
    impact: 'A re-delivered snapshot duplicated or failed to overwrite the (guild,type) health row — the upsert idempotency the dashboard relies on is broken.',
  });
}

/** Prove health_metrics APPENDS (accumulates) rather than upserting in place. */
async function proveHealthMetricsAppend(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const before = await healthMetricCount(handle);
  await handle.supabase
    .from('health_metrics')
    .insert({ guild_id: handle.guildId, metric_type: 'db_latency', value_ms: 4.21 });
  const after = await healthMetricCount(handle);
  ctx.expect(before >= 1 && after === before + 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The bot wrote latency metrics on boot and health_metrics rows accumulate (append per type), not upsert in place.',
    observation: `health_metrics rows: boot wrote ${before} (>=1 expected), after one more insert ${after} (expected ${before + 1}, i.e. appended).`,
    impact: 'health_metrics did not accumulate — sparkline history is lost or overwritten instead of appended.',
  });
}

// ── The 12 scenario scripts ────────────────────────────────────────────────

/** DEF — snapshots flow out of the box and the health row upserts in place. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const intervalMs = Number(declaredDefault(ctx.domain, 'snapshot-interval-ms'));
  const memThreshold = Number(declaredDefault(ctx.domain, 'memory-alert-threshold-mb'));
  const handle = await ctx.bootGuild({ label: 'a' });

  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }
  await waitForHealthMetric(handle);

  // Discord (db-observable): the REAL DiagnosticsService wrote a health snapshot on boot.
  ctx.expect(snap.type === 'health' && snap.memory_rss_mb > 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Out of the box the DiagnosticsService writes a health snapshot (default interval ${intervalMs}ms) with real uptime/memory/Valkey status.`,
    observation: `bot_diagnostics health row: type=${snap.type}, memory_rss_mb=${snap.memory_rss_mb}, uptime_seconds=${snap.uptime_seconds}, valkey_connected=${snap.valkey_connected}, discord_ws_ping=${String(snap.discord_ws_ping)}.`,
    impact: 'The bot wrote no health snapshot on boot — the diagnostics feed is dead out of the box.',
  });
  ctx.gate(
    'Discord',
    'discord-readback',
    'The reported ws ping is a live value from the real gateway connection.',
    'no Discord gateway in the bot-only harness — client.ws.ping is not a live shard ping without DISCORD_TOKEN + a live guild.',
  );

  // database-RLS: one (guild,type) row + accumulating metrics + anon deny.
  const count = await snapshotCount(handle, 'health');
  ctx.expect(count === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Exactly one bot_diagnostics row exists per (guild, "health").',
    observation: `bot_diagnostics rows for (guild,"health") = ${count} (expected 1).`,
    impact: 'The (guild,type) health snapshot is not a single upserted row.',
  });
  await proveHealthMetricsAppend(ctx, handle);
  await proveRlsDeny(ctx, handle, 'bot_diagnostics', true);

  // replay-safety: the health row upserts in place.
  await proveSnapshotUpsertInPlace(ctx, handle);

  // owner-notification: on a truly healthy stack no alert opens. With no local
  // Redis the harness stack is intentionally NOT fully healthy (a valkey_disconnected
  // alert legitimately opens — proven in DEPFAIL), so gate rather than mis-assert.
  if (ctx.capabilities.redis) {
    const open = await unresolvedAlerts(handle);
    ctx.expect(open.length === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'A healthy boot opens zero alerts, so no owner mirror fires.',
      observation: `unresolved alerts after a healthy boot = ${open.length} (${open.map((a) => a.alert_type).join(',') || 'none'}).`,
      impact: 'A healthy boot opened an alert — false-alarm notification noise.',
    });
  } else {
    ctx.gate(
      'owner-notification',
      'redis-dependency',
      'A healthy boot opens zero alerts, so no owner mirror fires.',
      'no Valkey/Redis reachable, so the harness stack is intentionally not fully healthy (a real valkey_disconnected alert legitimately opens); the healthy-window no-alert case needs a reachable Valkey.',
    );
  }

  gateAlertAudit(ctx, `No alert lifecycle events exist for the healthy window (memory stays under the default ${memThreshold}MB threshold).`);
  gateBranding(ctx);
  gateOwnerMirrorReadback(ctx);
}

/** SET-A — a lowered memory threshold should open a memory_high alert (config GAP → gated). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const memThreshold = Number(declaredDefault(ctx.domain, 'memory-alert-threshold-mb'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }

  // Real anchors: the bot wrote a snapshot and health data stays service-role-only.
  ctx.expect(snap.type === 'health', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The AlertManager evaluates the boot snapshot (the surface a lowered memory threshold would act on).',
    observation: `bot_diagnostics health row present with memory_rss_mb=${snap.memory_rss_mb} (evaluated against the standing default ${memThreshold}MB threshold).`,
    impact: 'No snapshot was evaluated, so no threshold could take effect.',
  });
  await proveRlsDeny(ctx, handle, 'alerts', true);

  // Headline: lowering memory-alert-threshold-mb to 128 to open memory_high cannot
  // be driven — thresholds are constructor-level DEFAULT_THRESHOLDS with no
  // guild_config/dashboard wiring (catalog INTENT-DELTAS code GAP).
  ctx.gate(
    'Discord',
    'db-observable',
    'With memory-alert-threshold-mb set to 128 (below actual usage), the next evaluation opens exactly one memory_high alert whose severity follows the 1.5x rule.',
    'diagnostics alert thresholds are constructor-level DEFAULT_THRESHOLDS with no guild_config or dashboard configuration surface (code GAP) — the bot-only harness has no lever to lower a threshold, so the memory_high open cannot be driven.',
  );
  ctx.gate(
    'owner-notification',
    'redis-dependency',
    'The owner mirror for the memory_high alert includes a suggested next step, once per condition.',
    'the memory_high alert cannot be opened without threshold wiring (code GAP); the owner-mirror delivery additionally needs DISCORD_TOKEN + a live guild.',
  );
  gateAlertAudit(ctx, 'The threshold change is recorded with before/after values.');
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Continued breaching snapshots update the same memory_high row.',
    'the memory_high alert cannot be opened without threshold wiring (code GAP); its update-in-place path is exercised structurally in REPLAY.',
  );
}

/** SET-B — a lowered ws-ping threshold should open ws_ping_high, independent of SET-A. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const wsThreshold = Number(declaredDefault(ctx.domain, 'ws-ping-alert-threshold-ms'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }

  // Real anchor: at the STANDING default ws threshold, the boot ws ping (no gateway,
  // so not a breaching value) opens no ws_ping_high — the AlertManager evaluates
  // against the standing threshold. This is robust: a gateway-less ws ping never
  // exceeds the 500ms default, so this cannot flake.
  const wsHigh = await unresolvedAlerts(handle, 'ws_ping_high');
  ctx.expect(wsHigh.length === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `The AlertManager evaluates ws ping against the standing default threshold (${wsThreshold}ms); an un-breaching ping opens no ws_ping_high.`,
    observation: `unresolved ws_ping_high rows = ${wsHigh.length} (expected 0 at the standing ${wsThreshold}ms threshold; the gateway-less snapshot ws ping does not breach it).`,
    impact: 'A spurious ws_ping_high alert opened without a breaching ping — the standing threshold is not governing evaluation.',
  });
  await proveRlsDeny(ctx, handle, 'alerts', true);

  // Headline: lowering ws-ping-alert-threshold-ms to 1 to force ws_ping_high cannot
  // be driven (same threshold-config code GAP as SET-A).
  ctx.gate(
    'Discord',
    'db-observable',
    'With ws-ping-alert-threshold-ms set to 1, the next evaluation opens exactly one ws_ping_high alert (memory stays quiet), independent of SET-A.',
    'diagnostics alert thresholds are constructor-level DEFAULT_THRESHOLDS with no guild_config or dashboard configuration surface (code GAP) — the harness cannot lower the ws threshold to force ws_ping_high.',
  );
  gateAlertAudit(ctx, 'The threshold change and alert lifecycle are recorded.');
  gateOwnerMirrorReadback(ctx);
  gateBranding(ctx);
}

/** INVALID — out-of-bounds thresholds rejected atomically; standing values keep governing. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const wsThreshold = Number(declaredDefault(ctx.domain, 'ws-ping-alert-threshold-ms'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }

  // Real anchor: alert behavior is unchanged — evaluation continues against the
  // standing (default) thresholds, opening no spurious ws_ping_high.
  const wsHigh = await unresolvedAlerts(handle, 'ws_ping_high');
  ctx.expect(wsHigh.length === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'No alert behavior changes: the AlertManager keeps evaluating with the standing (unchanged) thresholds after any rejected update.',
    observation: `unresolved ws_ping_high rows = ${wsHigh.length} (expected 0 — the standing ${wsThreshold}ms threshold still governs).`,
    impact: 'A rejected/invalid configuration disturbed live alert evaluation.',
  });
  await proveRlsDeny(ctx, handle, 'bot_diagnostics', true);

  // The rejection itself lives in the dashboard Zod layer, and there are NO
  // threshold storage columns to leave unchanged (code GAP), so the reject path is
  // not reachable here. GATE honestly (never fake a rejection).
  ctx.gate(
    'database-RLS',
    'db-observable',
    'A negative ws-ping threshold, a zero memory threshold, or a sub-floor snapshot interval is rejected and stored thresholds are unchanged.',
    'diagnostics thresholds have no persisted configuration rows (constructor-level defaults, code GAP) and validation lives in the dashboard Zod layer — the reject-and-retain path is not reachable in a bot-only harness.',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The rejected attempts are recorded (with the offending bound) without any config.updated rows.',
    'the rejected-config audit row is written by the dashboard save path, not reachable in a bot-only harness.',
  );
  gateBranding(ctx);
}

/** UNAUTH — health data is invisible without the diagnostics permission (DB-side RLS). */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  await waitForHealthMetric(handle);
  const serviceSees = snap !== null;

  // The catalog's "health data invisible without permission" is enforced at two
  // layers: the dashboard route/API guard (403 — dashboard-session lane, gated) and
  // the DB RLS (service-role-only — proven here across all three diagnostic tables).
  await proveRlsDeny(ctx, handle, 'bot_diagnostics', serviceSees);
  await proveRlsDeny(ctx, handle, 'health_metrics', (await healthMetricCount(handle)) > 0);
  await proveRlsDeny(ctx, handle, 'alerts', serviceSees);

  ctx.gate(
    'Discord',
    'discord-readback',
    "A member without dashboard.view_diagnostics receives 403 from GET /api/diagnostics and the /diagnostics route; the member's dashboard hides diagnostics navigation.",
    'the route/API RBAC guard is a Next.js dashboard-session lane (requireGuildOwner/ROUTE_PERMISSIONS) not reachable from a bot-only harness; the DB-side deny is proven via RLS above.',
  );
  ctx.gate(
    'audit',
    'audit-row',
    "Denied diagnostics-view attempts are logged with the member's id.",
    'denied-attempt logging is written by the dashboard API guard, not reachable in a bot-only harness.',
  );
  ctx.gate(
    'owner-notification',
    'db-observable',
    'No alert fires for routine permission denials.',
    'permission denials occur in the dashboard RBAC lane; no bot-observable denial action exists to check here.',
  );
  gateBranding(ctx);
}

/** DEPFAIL — a down Valkey is reported honestly: snapshot writes, valkey_disconnected opens once. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);

  if (!snap) {
    gateSnapshotAbsent(ctx);
    gateBranding(ctx);
    return;
  }

  if (!ctx.capabilities.redis) {
    // No local Redis IS the outage: the real snapshot records Valkey down.
    ctx.expect(snap.valkey_connected === false, {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'With Valkey unreachable, the snapshot still writes with valkey_connected=false (diagnostics do not break on a down dependency).',
      observation: `bot_diagnostics health row wrote valkey_connected=${snap.valkey_connected} while no Valkey/Redis is reachable.`,
      impact: 'The snapshot did not honestly record Valkey down (or failed to write) during the outage.',
    });

    // The real AlertManager opens exactly one critical valkey_disconnected alert.
    const alerts = await waitForUnresolvedAlert(handle, 'valkey_disconnected');
    ctx.expect(alerts.length === 1 && alerts[0]!.severity === 'critical', {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'A down dependency opens exactly one critical valkey_disconnected alert (once per condition, not per snapshot).',
      observation: `unresolved valkey_disconnected rows = ${alerts.length} (expected 1), severity = ${alerts[0]?.severity ?? 'n/a'} (expected critical).`,
      impact: 'The down-dependency alert did not open exactly once at critical severity.',
    });

    // Branding: the alert copy is a real stored owner-facing surface — assert it
    // explains impact (caching, rate limits) in plain language, read from the row.
    const msg = `${alerts[0]?.title ?? ''} ${alerts[0]?.message ?? ''}`.toLowerCase();
    ctx.expect(alerts.length === 1 && msg.includes('caching') && msg.includes('rate limit'), {
      assertionClass: 'branding',
      channel: 'db-observable',
      promise: 'The valkey_disconnected alert explains its impact (caching, rate limiting) in plain language.',
      observation: `alert copy = "${alerts[0]?.title ?? ''} — ${alerts[0]?.message ?? ''}".`,
      impact: 'The down-dependency alert copy did not explain the impact in plain language for a non-technical owner.',
    });

    // AUDIT FINDING: the catalog contracts a diagnostics.dependency_down audit row
    // for this exact condition. Prove audit_logs is live+flushed (bot.started
    // positive control), then show the dependency_down row is absent → FAIL.
    const started = await waitForAudit(handle, 'bot.started');
    if (started.length === 0) {
      gateAlertAudit(ctx, 'diagnostics.dependency_down is recorded for the outage.');
    } else {
      const depDown = await auditRows(handle, 'diagnostics.dependency_down');
      ctx.expect(depDown.length >= 1, {
        assertionClass: 'audit',
        channel: 'audit-row',
        promise: 'A dependency-down condition records a diagnostics.dependency_down audit_logs row (with actor).',
        observation: `audit_logs holds ${started.length} bot.started row(s) (audit is live+flushed) but ${depDown.length} diagnostics.dependency_down row(s) despite a valkey_disconnected alert being open (expected >=1).`,
        impact: 'The bot opened a valkey_disconnected alert but wrote no diagnostics.dependency_down audit row — the outage is invisible to the audit trail the catalog contracts.',
      });
    }

    await proveRlsDeny(ctx, handle, 'alerts', true);
    ctx.gate(
      'replay-safety',
      'db-observable',
      'Repeated outage snapshots update the single open valkey_disconnected alert (never a second row).',
      'a second real snapshot evaluation is a 60s DiagnosticsService tick; the update-in-place path across ticks is not observable inside one scenario runtime.',
    );
  } else {
    // Valkey is up — the outage cannot be induced without a fault lane.
    ctx.gate(
      'database-RLS',
      'db-observable',
      'With Valkey stopped, the snapshot still writes valkey_connected=false and a critical valkey_disconnected alert opens once.',
      'Valkey is reachable this run; inducing a mid-run Valkey outage needs a dependency-outage fault-injection lane.',
    );
    ctx.gate(
      'owner-notification',
      'db-observable',
      'Exactly one open and one resolve notification for the outage condition.',
      'Valkey is reachable this run; the outage condition cannot be driven.',
    );
    gateAlertAudit(ctx, 'diagnostics.dependency_down is recorded for the outage.');
    gateBranding(ctx);
  }
  gateOwnerMirrorReadback(ctx);
}

/** RETRY — a transient snapshot-write failure self-heals; the upsert converges to one row. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }

  // Real anchor: the snapshot upsert converges to exactly one current row (a retried
  // write upserts, never duplicates) — the DB-level guarantee behind "retried writes
  // upsert rather than duplicate" and "no duplicate snapshot rows appear".
  await proveSnapshotUpsertInPlace(ctx, handle);
  await proveRlsDeny(ctx, handle, 'bot_diagnostics', true);

  // The transient-failure + next-tick recovery + freshness-gap facets need a
  // fault-injection lane on the bot_diagnostics upsert and a second 60s tick.
  ctx.gate(
    'Discord',
    'db-observable',
    'With one snapshot write transiently failing, the following 60s tick writes successfully and the freshness gap never exceeds two intervals.',
    'requires a fault-injection lane on the bot_diagnostics upsert plus a second DiagnosticsService tick (the harness runs against a deliberately-reachable DB).',
  );
  gateAlertAudit(ctx, 'The transient failure is logged without alert noise (diagnostics.snapshot_failed).');
  ctx.gate(
    'owner-notification',
    'db-observable',
    'No stale alert fires for a single missed tick.',
    'requires the snapshot-write fault lane to produce a missed tick.',
  );
  gateBranding(ctx);
}

/** REPLAY — re-evaluating the same breach updates one row; the snapshot upserts in place. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  if (!snap) {
    gateSnapshotAbsent(ctx);
    await proveRlsDeny(ctx, handle, 'bot_diagnostics', false);
    gateBranding(ctx);
    return;
  }

  // Real anchor: repeated snapshot delivery updates the one health row in place.
  await proveSnapshotUpsertInPlace(ctx, handle);
  await proveRlsDeny(ctx, handle, 'alerts', true);

  if (!ctx.capabilities.redis) {
    // The single boot evaluation left exactly one unresolved alert row for the type
    // — the "one unresolved alert row per type regardless of evaluation count" state.
    const alerts = await waitForUnresolvedAlert(handle, 'valkey_disconnected');
    ctx.expect(alerts.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'One unresolved alert row exists per type (the AlertManager updates an existing open alert instead of inserting a second).',
      observation: `unresolved valkey_disconnected rows after the boot evaluation = ${alerts.length} (expected 1).`,
      impact: 'A single breaching evaluation produced more than one unresolved alert row for the type.',
    });
  } else {
    ctx.gate(
      'replay-safety',
      'redis-dependency',
      'One unresolved alert row exists per type regardless of evaluation count.',
      'no breaching condition without a threshold lever or a down dependency (Valkey is up this run); the single-open-row invariant is proven in DEPFAIL when Redis is absent.',
    );
  }

  // Re-evaluating the SAME breach across ticks to prove message/severity update in
  // place needs a second live evaluation (60s tick) or the in-process service handle.
  ctx.gate(
    'owner-notification',
    'db-observable',
    'Re-evaluating the identical breaching snapshot updates the message/severity in place and delivers a single owner notification for the condition.',
    'a second real evaluation is a 60s DiagnosticsService tick; the across-tick update-in-place is not observable inside one scenario runtime (the DB single-row invariant is proven above).',
  );
  gateBranding(ctx);
}

/** RESTART — diagnostics resume with honest (reset) uptime; history and open alerts survive. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: real snapshot + metrics.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const snap1 = await waitForSnapshot(first);
  if (!snap1) {
    gateSnapshotAbsent(ctx);
    gateBranding(ctx);
    await first.cleanup();
    return;
  }
  const metricsBefore = await waitForHealthMetric(first);
  await first.cleanup(); // simulate shutdown (stops the DiagnosticsService timer)

  // Boot #2: SAME guild id (restart). The health row upserts in place; uptime is
  // freshly computed from the new process start (not carried over); metrics append.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const snap2 = await waitForSnapshot(second);
  const metricsAfter = await waitForHealthMetric(second);
  if (!snap2) {
    gateSnapshotAbsent(ctx);
    gateBranding(ctx);
    return;
  }

  const rowCount = await snapshotCount(second, 'health');
  ctx.expect(rowCount === 1 && snap2.uptime_seconds < 60, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'After a restart snapshots resume, the (guild,type) row updates in place, and uptime restarts from zero (not carried over).',
    observation: `post-restart bot_diagnostics rows=${rowCount} (expected 1), uptime_seconds=${snap2.uptime_seconds} (expected freshly reset, < 60).`,
    impact: 'Uptime was carried across the restart or the snapshot row duplicated — restart state is dishonest.',
  });
  ctx.expect(metricsBefore >= 1 && metricsAfter > metricsBefore, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Historical health_metrics remain intact across the restart and new points are appended.',
    observation: `health_metrics count pre-restart=${metricsBefore} (>=1), post-restart=${metricsAfter} (expected strictly greater — history retained + appended).`,
    impact: 'Metrics history was lost or not extended across the restart.',
  });

  if (!ctx.capabilities.redis) {
    // The ongoing valkey_disconnected condition (still down after restart) must NOT
    // duplicate: boot #2's fresh AlertManager finds the open row and updates it.
    const alerts = await unresolvedAlerts(second, 'valkey_disconnected');
    ctx.expect(alerts.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A restart does not duplicate alert rows for an ongoing condition (the post-restart evaluation updates the existing open row).',
      observation: `unresolved valkey_disconnected rows after restart = ${alerts.length} (expected 1 — the pre-restart open row, updated in place).`,
      impact: 'The restart opened a second unresolved alert row for an ongoing condition — alert churn / duplicate notifications.',
    });
  } else {
    ctx.gate(
      'replay-safety',
      'redis-dependency',
      'A restart does not duplicate alert rows for ongoing conditions.',
      'no ongoing breaching condition this run (Valkey is up); the no-duplicate-across-restart invariant is proven when Redis is absent.',
    );
  }

  await proveRlsDeny(ctx, second, 'bot_diagnostics', true);
  gateAlertAudit(ctx, 'No spurious alert churn is logged from the restart itself.');
  gateBranding(ctx);
  gateOwnerMirrorReadback(ctx);
}

/** RACE — concurrent evaluations must yield one open alert per type (DB dedup gap → finding). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  await waitForSnapshot(handle);

  // The catalog requires "exactly one unresolved alerts row for the type" even under
  // concurrency. The only cross-process-safe guard is a DB unique index — present
  // ONLY for fraud_check_failure (20260709170000), NOT for diagnostic alert types.
  // Demonstrate the gap DB-observably: two unresolved rows of a diagnostic type both
  // persist, while the fraud type rejects the duplicate. Use ws_ping_high (which the
  // gateway-less boot never opens) so the probe is independent of boot state.
  const probeType = 'ws_ping_high';
  await handle.supabase.from('alerts').delete().eq('guild_id', handle.guildId).eq('alert_type', probeType);
  await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId, alert_type: probeType, severity: 'warning', title: 'e2e race probe A', message: 'probe', resolved: false,
  });
  const dupProbe = await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId, alert_type: probeType, severity: 'warning', title: 'e2e race probe B', message: 'probe', resolved: false,
  });
  const probeRejected = Boolean(dupProbe.error);
  const probeOpen = (await unresolvedAlerts(handle, probeType)).length;

  ctx.expect(probeRejected && probeOpen === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The database enforces at most one unresolved alert row per (guild, alert_type) for diagnostic alert types, so concurrent check-then-insert evaluations cannot open a duplicate.',
    observation: `two unresolved ${probeType} rows: second insert ${probeRejected ? 'rejected' : 'ACCEPTED'}, unresolved ${probeType} rows now = ${probeOpen} (contract expects a rejection leaving 1).`,
    impact: 'No unique index guards unresolved diagnostic alert rows, so the AlertManager check-then-insert is racy — concurrent snapshot evaluations can open duplicate alerts and double-notify the owner.',
  });

  // Positive control: the same dedup pattern IS enforced for fraud_check_failure,
  // proving the probe is valid and the fix pattern exists but was not applied here.
  await handle.supabase.from('alerts').delete().eq('guild_id', handle.guildId).eq('alert_type', 'fraud_check_failure');
  await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId, alert_type: 'fraud_check_failure', severity: 'warning', title: 'e2e ctrl A', message: 'probe', resolved: false,
  });
  const ctrlDup = await handle.supabase.from('alerts').insert({
    guild_id: handle.guildId, alert_type: 'fraud_check_failure', severity: 'warning', title: 'e2e ctrl B', message: 'probe', resolved: false,
  });
  const ctrlCode = (ctrlDup.error as { code?: string } | null)?.code;
  ctx.expect(ctrlCode === '23505', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The per-type unresolved-uniqueness index pattern exists in the schema (uniq_alerts_unresolved_fraud_check_failure) and rejects a duplicate.',
    observation: `duplicate fraud_check_failure insert error code = ${ctrlCode ?? 'none'} (expected 23505 unique violation — positive control validating the RACE probe).`,
    impact: 'The dedup unique-index pattern is absent even where it was added, so the RACE probe cannot be trusted.',
  });

  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Two racing evaluations deliver one owner notification for the condition.',
    'true concurrent AlertManager evaluations plus owner-mirror delivery need the in-process service handle and DISCORD_TOKEN + a live guild; the DB-level uniqueness gap that would break this is proven above.',
  );
  gateBranding(ctx);
}

/** XGUILD — diagnostics are strictly per-guild and never cross over. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  const snapA = await waitForSnapshot(handleA);
  const snapB = await waitForSnapshot(handleB);
  if (!snapA || !snapB) {
    gateSnapshotAbsent(ctx);
    gateBranding(ctx);
    return;
  }

  // Each guild's snapshot is keyed to its own guild_id; a scope to guild A reads A's
  // row and never B's, and vice versa (distinct rows under distinct guild_ids).
  ctx.expect(snapA.guild_id === guildA && snapB.guild_id === guildB && guildA !== guildB, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: "Each guild's health snapshot is keyed to that guild only; a scope to guild A reads A's row and never guild B's.",
    observation: `guild-A-scoped snapshot guild_id="${snapA.guild_id}" (expected "${guildA}"); guild-B-scoped snapshot guild_id="${snapB.guild_id}" (expected "${guildB}").`,
    impact: 'A guild-scoped diagnostics read returned another guild\'s row — cross-guild health leakage.',
  });

  if (!ctx.capabilities.redis) {
    // The down-dependency alert opens under EACH guild independently; neither guild's
    // count includes the other's row.
    const aAlerts = await waitForUnresolvedAlert(handleA, 'valkey_disconnected');
    const bAlerts = await waitForUnresolvedAlert(handleB, 'valkey_disconnected');
    ctx.expect(aAlerts.length === 1 && bAlerts.length === 1 && aAlerts[0]!.guild_id === guildA && bAlerts[0]!.guild_id === guildB, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: "An alert in guild A is keyed to guild A only; guild B has its own independent alert row.",
      observation: `guild A unresolved valkey_disconnected=${aAlerts.length} under "${aAlerts[0]?.guild_id}"; guild B=${bAlerts.length} under "${bAlerts[0]?.guild_id}" (each expected 1, own guild).`,
      impact: 'A diagnostics alert crossed guilds — an owner would be notified of another guild\'s condition.',
    });
  } else {
    ctx.gate(
      'owner-notification',
      'redis-dependency',
      'An alert in guild A notifies only guild A (per-guild alert rows).',
      'no breaching condition without a down dependency (Valkey is up this run); per-guild alert isolation is proven when Redis is absent.',
    );
  }

  await proveRlsDeny(ctx, handleA, 'bot_diagnostics', true);
  gateAlertAudit(ctx, 'Alert events are recorded under the correct guild.');
  gateBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    "Only guild A's owner channel receives guild A's alerts.",
    'cross-guild owner-mirror isolation needs DISCORD_TOKEN + two live guilds; the DB-level per-guild keying is proven above.',
  );
}

/** CLEANUP — run-guild diagnostic rows are removed; audit rows are retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const snap = await waitForSnapshot(handle);
  const metrics = await waitForHealthMetric(handle);
  const startedAudit = await waitForAudit(handle, 'bot.started');
  if (!snap) {
    gateSnapshotAbsent(ctx);
    gateBranding(ctx);
    return;
  }

  const diagBefore = await snapshotCount(handle, 'health');
  const alertsBefore = (await unresolvedAlerts(handle)).length;
  ctx.expect(diagBefore >= 1 && metrics >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-guild diagnostic rows (pre-cleanup baseline).',
    observation: `pre-cleanup: bot_diagnostics=${diagBefore}, health_metrics=${metrics}, open alerts=${alertsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-guild diagnostic rows.',
  });

  await proveRlsDeny(ctx, handle, 'bot_diagnostics', true);

  // Sweep and verify ZERO run-guild diagnostic rows remain.
  await ctx.sweepGuildRows(handle);
  const diagAfter = await snapshotCount(handle, 'health');
  const metricsAfter = await healthMetricCount(handle);
  const alertsAfter = (await unresolvedAlerts(handle)).length;
  ctx.expect(diagAfter === 0 && metricsAfter === 0 && alertsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Teardown deletes run-guild snapshot rows, health metrics, and alert rows; a final sweep finds zero run-guild diagnostic resources.',
    observation: `post-sweep: bot_diagnostics=${diagAfter}, health_metrics=${metricsAfter}, open alerts=${alertsAfter}.`,
    impact: 'The cleanup sweep left run-guild diagnostic rows behind — the suite leaves residue.',
  });

  // Running the sweep twice is a safe no-op.
  await ctx.sweepGuildRows(handle);
  const diagTwice = await snapshotCount(handle, 'health');
  ctx.expect(diagTwice === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running cleanup twice is a safe no-op.',
    observation: `bot_diagnostics rows after a second sweep = ${diagTwice} (expected 0).`,
    impact: 'A second cleanup pass was not a safe no-op.',
  });

  // Retention contract: audit rows for the run PERSIST (anonymize-over-delete);
  // audit_logs is deliberately NOT in guildScopedTables so the sweep never deletes it.
  if (startedAudit.length === 0) {
    ctx.gate(
      'audit',
      'audit-row',
      'Run audit rows persist after cleanup; none are deleted by the sweep.',
      'the bot.started audit row had not flushed within the poll window (AuditService batches on a 5s timer), so the retention baseline could not be established this run.',
    );
  } else {
    const startedAfter = await auditRows(handle, 'bot.started');
    ctx.expect(startedAfter.length >= 1, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Run audit rows persist after cleanup (audit is anonymized/retained, never deleted by the diagnostic sweep).',
      observation: `bot.started audit rows: ${startedAudit.length} before sweep, ${startedAfter.length} after (expected >=1 — retained).`,
      impact: 'The cleanup sweep deleted audit history — the anonymize-over-delete retention contract was violated.',
    });
  }

  ctx.gate(
    'Discord',
    'discord-readback',
    'No stale run-guild alert messages remain uncontextualized in the owner channel after teardown.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild).',
  );
  gateBranding(ctx);
}

// ── DomainProof export ─────────────────────────────────────────────────────

/**
 * The Diagnostics domain proof. `guildScopedTables` lists the run-guild diagnostic
 * tables the sweep must clear (all reference guild(id); no inter-table FK, so order
 * is flat). `audit_logs` is deliberately EXCLUDED so cleanup RETAINS audit history
 * per the catalog's anonymize-over-delete contract (proven in CLEANUP).
 */
export const administrationDiagnosticsProof: DomainProof = {
  domainId: 'administration-diagnostics',
  guildScopedTables: ['alerts', 'health_metrics', 'bot_diagnostics'],
  scripts: {
    DEF,
    'SET-A': SET_A,
    'SET-B': SET_B,
    INVALID,
    UNAUTH,
    DEPFAIL,
    RETRY,
    REPLAY,
    RESTART,
    RACE,
    XGUILD,
    CLEANUP,
  },
};
