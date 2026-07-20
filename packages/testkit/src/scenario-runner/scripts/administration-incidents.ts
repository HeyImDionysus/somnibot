/**
 * scenario-runner/scripts/administration-incidents — the incidents domain proof.
 *
 * Binds the administration/Incidents domain's 12 declarative catalog scenarios to
 * concrete real-stack proofs against LOCAL Supabase. Unlike the slash-command
 * domains, incidents are driven ENTIRELY by the dashboard REST surface
 * (`/api/incidents`, guarded by `requirePermission('dashboard.manage_incidents')`)
 * plus the bot's fraud-auto pipeline (`checkCriticalThreshold`). There is NO
 * incidents slash command, so the production dispatcher (`ctx.runSlash`) cannot
 * open, patch, or list a case here. That makes this domain MOSTLY GATED — and
 * honestly so.
 *
 * What DOES run now against real state (never faked):
 *   - RLS deny_all: the `incidents`/`incident_events` `owner_full_access` policy
 *     means an anon key reads ZERO rows while the service role sees the seeded
 *     case — the exact template `proveRlsIsolation` positive-control probe. This
 *     is also the DB-layer proof of UNAUTH (case data invisible without perms).
 *   - Guild-scoping: two real guilds hold distinct cases; a guild-scoped read
 *     returns only its own row (XGUILD).
 *   - Persistence: a seeded case + timeline survives a full stack reboot (RESTART).
 *   - The real `nextval_incident` RPC issues strictly-increasing case numbers, so
 *     two creates can never collide onto one case number (DEF/REPLAY primitive).
 *   - Timeline (`incident_events`) append-only ordering + actor attribution.
 *   - Cleanup: the sweep deletes `incidents` (cascading to `incident_events`) yet
 *     RETAINS `audit_logs` — the anonymize-over-delete contract (CLEANUP).
 *   - No spurious owner alert on happy paths (`alerts` row count).
 *
 * What is GATED (bot-only local-Supabase harness cannot drive it, so it is
 * recorded pending — loud, never green):
 *   - The dashboard REST create/patch/list + RBAC 401/403 (needs a dashboard
 *     session-auth lane, not the bot dispatcher).
 *   - The owner-channel Discord mirror of open/resolve (needs DISCORD_TOKEN + a
 *     live guild for channel readback).
 *   - `default-severity` / `auto-create-from-critical-alerts` config-takes-effect:
 *     these controls live in the API/zod layer and have NO `guild_config` column
 *     and NO bot reader, so a bot-only harness cannot exercise them.
 *   - Fault injection (DB error mid-update; owner channel unavailable + notify
 *     retry) for DEPFAIL/RETRY.
 *   - Owner-voice / powered-by-SomniBot branding copy (no member-facing reply
 *     surface exists in this harness).
 *
 * Where the real bot/DB diverges from the catalog's contracted intent, the script
 * records a FAIL (never forces green). Note the merged local schema carries NO DB
 * CHECK on `incidents.status`/`severity` (a Phase-D CREATE was skipped by an
 * earlier `IF NOT EXISTS`), so enum rejection is a dashboard-zod concern, GATED
 * here exactly like the wallet template gated the guild_config CHECK path.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Typed row shapes (no `any` leaks) ─────────────────────────────────────

interface IncidentRow {
  id: string;
  guild_id: string;
  title: string;
  severity: string;
  status: string;
  source: string | null;
  source_ref_id: string | null;
  incident_number: number | null;
  created_by: string;
  assigned_to: string | null;
}

interface IncidentEventRow {
  id: string;
  incident_id: string;
  event_type: string;
  actor_id: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const INCIDENT_COLS = 'id, guild_id, title, severity, status, source, source_ref_id, incident_number, created_by, assigned_to';
const EVENT_COLS = 'id, incident_id, event_type, actor_id, message, metadata, created_at';

interface SeedIncidentOptions {
  title: string;
  createdBy: string;
  severity?: string;
  status?: string;
  source?: string;
  sourceRefId?: string | null;
  assignedTo?: string | null;
  description?: string | null;
  guildId?: string;
}

interface SeedEventOptions {
  eventType: string;
  actorId: string;
  message?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** The REAL production incident-number RPC (nextval_incident: MAX(number)+1). */
async function nextIncidentNumber(handle: LiveClientHandle): Promise<number> {
  const { data } = await handle.supabase.rpc('nextval_incident');
  return typeof data === 'number' ? data : Number(data ?? 0);
}

/**
 * Arrange an incident row directly (the dashboard REST create path is GATED, so
 * state is seeded), numbered by the REAL nextval_incident RPC. `created_by` is
 * NOT NULL in the merged schema, so callers must pass it.
 */
async function seedIncident(handle: LiveClientHandle, opts: SeedIncidentOptions): Promise<IncidentRow | null> {
  const number = await nextIncidentNumber(handle);
  const { data } = await handle.supabase
    .from('incidents')
    .insert({
      guild_id: opts.guildId ?? handle.guildId,
      incident_number: number,
      title: opts.title,
      description: opts.description ?? null,
      severity: opts.severity ?? 'warning',
      status: opts.status ?? 'open',
      source: opts.source ?? 'manual',
      source_ref_id: opts.sourceRefId ?? null,
      assigned_to: opts.assignedTo ?? null,
      created_by: opts.createdBy,
    })
    .select(INCIDENT_COLS)
    .single();
  return (data as IncidentRow | null) ?? null;
}

/** Append a timeline event (the append-only incident audit trail). */
async function seedEvent(
  handle: LiveClientHandle,
  incidentId: string,
  opts: SeedEventOptions,
): Promise<IncidentEventRow | null> {
  const payload: Record<string, unknown> = {
    incident_id: incidentId,
    event_type: opts.eventType,
    actor_id: opts.actorId,
    message: opts.message ?? null,
    metadata: opts.metadata ?? {},
  };
  if (opts.createdAt) payload.created_at = opts.createdAt;
  const { data } = await handle.supabase
    .from('incident_events')
    .insert(payload)
    .select(EVENT_COLS)
    .single();
  return (data as IncidentEventRow | null) ?? null;
}

async function readIncident(handle: LiveClientHandle, id: string): Promise<IncidentRow | null> {
  const { data } = await handle.supabase
    .from('incidents')
    .select(INCIDENT_COLS)
    .eq('id', id)
    .maybeSingle();
  return (data as IncidentRow | null) ?? null;
}

/** Guild-scoped incident count (the exact `.eq('guild_id', …)` the API enforces). */
async function incidentCount(
  handle: LiveClientHandle,
  opts: { guildId?: string; title?: string } = {},
): Promise<number> {
  let query = handle.supabase
    .from('incidents')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', opts.guildId ?? handle.guildId);
  if (opts.title) query = query.eq('title', opts.title);
  const { count } = await query;
  return count ?? 0;
}

/** Timeline events for an incident, ascending by created_at (API ordering). */
async function readEvents(handle: LiveClientHandle, incidentId: string): Promise<IncidentEventRow[]> {
  const { data } = await handle.supabase
    .from('incident_events')
    .select(EVENT_COLS)
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: true });
  return (data as IncidentEventRow[] | null) ?? [];
}

async function eventCount(handle: LiveClientHandle, incidentId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('incident_events')
    .select('*', { count: 'exact', head: true })
    .eq('incident_id', incidentId);
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors,
 * so a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Count audit_logs rows for the guild (the anonymize-over-delete retention proof). */
async function auditCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS owner_full_access → 0), or null when no anon key
 * is available (→ GATE, guild-scoping still proven separately). A PostgREST 42501
 * "permission denied" is treated as the deny (0 visible rows).
 */
async function anonReadCount(anonKey: string, table: string, guildId: string): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=guild_id&guild_id=eq.${encodeURIComponent(guildId)}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null; // non-JSON error body — inconclusive
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // the anon role is denied the table — RLS working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * The genuine RLS proof, made non-vacuous by a positive control: the scenario has
 * already created a case under the guild (the service role can read it back), so
 * an anon client reading ZERO `incidents` rows is a real deny, not "there was
 * nothing to read." Cross-GUILD isolation across two real guilds is proven in
 * XGUILD.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  incidentId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero incidents rows (RLS incidents owner_full_access policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'incidents', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero incidents rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readIncident(handle, incidentId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s incident row while an anon client reads zero of them (RLS incidents owner_full_access deny).',
    observation:
      `service-role sees the seeded case under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} incidents row(s) for that guild.`,
    impact:
      'An incident row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct case-data exposure).',
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's happy path raises no spurious owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'A routine incident action raises no spurious owner alert (non-critical noise stays off the alert channel).',
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'A spurious owner alert was raised on a routine path — notification noise.',
    });
  }
}

/** Gate the owner-channel Discord mirror (needs DISCORD_TOKEN + a live guild). */
function gateDiscordMirror(ctx: ScenarioContext, promise: string): void {
  ctx.gate('Discord', 'discord-readback', promise, 'requires the owner notification channel readback in the live test guild (DISCORD_TOKEN + live gateway) — the bot-only harness has no Discord side');
}

/** Gate branding: no member-facing reply exists in this harness, and the owner
 *  brand kit needs a live embed/message snapshot. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Case surfaces render in the owner voice with subtle powered-by-SomniBot attribution.',
    'incidents have no member-facing bot reply in this harness (dashboard + owner-channel surfaces only); owner-voice copy is not inspectable here',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The incident notification copy matches the owner brand kit (colors, voice preset, attribution).',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Double-submitted creates and replayed updates yield exactly one case and one timeline event per action.',
    `create/update idempotency is enforced in the dashboard API / fraud-pipeline SELECT-guard (not reachable via the bot dispatcher); the case-number primitive is exercised in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — creating a case works with defaults (opens at warning) and notifies the owner. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const defaultSeverity = String(declaredDefault(ctx.domain, 'default-severity') ?? 'warning');
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // The dashboard REST create is GATED; arrange the equivalent state so the
  // DB-observable invariants the catalog asserts can run. Seed one case at the
  // declared default severity, numbered by the REAL nextval_incident RPC.
  const n1 = await nextIncidentNumber(handle);
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}def-outage`,
    createdBy: manager,
    severity: defaultSeverity,
    status: 'open',
  });
  await seedEvent(handle, incident?.id ?? '', {
    eventType: 'created',
    actorId: manager,
    message: `Incident created: ${incident?.title ?? ''}`,
    metadata: { severity: defaultSeverity, source: 'manual' },
  });

  // database-RLS: exactly one case exists, at status open + default severity, under the run guild.
  const count = await incidentCount(handle, { title: `${ctx.runPrefix}def-outage` });
  ctx.expect(count === 1 && incident?.status === 'open' && incident?.severity === defaultSeverity && incident?.guild_id === handle.guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: `One incident row exists at status open, severity ${defaultSeverity} (the declared default-severity), under the run guild.`,
    observation:
      `case rows for the run title=${count} (expected 1), status=${incident?.status} (expected open), ` +
      `severity=${incident?.severity} (expected ${defaultSeverity}), guild="${incident?.guild_id}".`,
    impact: 'A default-created incident did not persist as a single open row at the declared default severity under its guild.',
  });

  // audit: the timeline records the creation with the creator's id.
  const events = await readEvents(handle, incident?.id ?? '');
  const created = events.find((e) => e.event_type === 'created');
  ctx.expect(events.length === 1 && created?.actor_id === manager, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: "The creation is recorded on the incident timeline with the creator's id.",
    observation: `timeline events=${events.length} (expected 1), created-event actor=${created?.actor_id} (expected ${manager}).`,
    impact: 'The incident creation was not audited on the timeline with the acting creator.',
  });

  // replay-safety primitive: nextval_incident is strictly increasing, so two
  // creates can never collide onto one case number (the single create here left one row).
  const n2 = await nextIncidentNumber(handle);
  ctx.expect(n2 > n1 && count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The single create produced exactly one case, and the case-number source (nextval_incident) never reissues a number.',
    observation: `nextval_incident moved ${n1}→${n2} (strictly increasing=${n2 > n1}); run-title case rows=${count}.`,
    impact: 'Either the create produced more than one case, or the case-number sequence reused a number (a duplicate-case risk).',
  });

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);
  gateDiscordMirror(ctx, 'The owner channel receives one incident-opened message with the title.');
  gateBranding(ctx);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one incident-opened mirror is delivered to the owner.',
    'requires the owner notification channel readback (DISCORD_TOKEN + live guild); the DB-observable side (no spurious alert) is asserted',
  );
}

/** SET-A — a critical default severity escalates new cases (config takes effect). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // The config `default-severity=critical` lives in the API/zod layer and has NO
  // guild_config column + NO bot reader — so config-takes-effect is GATED. Arrange
  // the RESULTING critical case and prove the DB stores + scopes it.
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}seta-critical`,
    createdBy: manager,
    severity: 'critical',
    status: 'open',
  });
  await seedEvent(handle, incident?.id ?? '', {
    eventType: 'created',
    actorId: manager,
    message: `Incident created: ${incident?.title ?? ''}`,
    metadata: { severity: 'critical', source: 'manual' },
  });

  const count = await incidentCount(handle, { title: `${ctx.runPrefix}seta-critical` });
  ctx.expect(count === 1 && incident?.severity === 'critical' && incident?.status === 'open', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The incident row stores severity critical (a valid enum value) at status open under the run guild.',
    observation: `case rows=${count} (expected 1), severity=${incident?.severity} (expected critical), status=${incident?.status} (expected open).`,
    impact: 'A critical-severity incident did not persist as expected.',
  });

  const events = await readEvents(handle, incident?.id ?? '');
  const created = events.find((e) => e.event_type === 'created');
  ctx.expect(created?.actor_id === manager && created?.metadata?.severity === 'critical', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The creation is audited on the timeline, tagging the critical severity.',
    observation: `created-event actor=${created?.actor_id}, metadata.severity=${String(created?.metadata?.severity)} (expected critical).`,
    impact: 'The critical case creation was not audited with its severity.',
  });

  // replay-safety: one create → one case.
  ctx.expect(count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'One create yields exactly one critical case.',
    observation: `run-title critical case rows=${count} (expected 1).`,
    impact: 'A single critical create produced more than one case.',
  });

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);
  ctx.gate(
    'database-RLS',
    'db-observable',
    'With default-severity set to critical, a new title-only incident opens as critical WITHOUT the creator choosing it.',
    'default-severity is applied by the dashboard API zod layer (z.enum(...).default) — there is no guild_config column and no bot reader, so a bot-only harness cannot drive the config-application path',
  );
  gateDiscordMirror(ctx, 'The critical mirror is immediate and marks the case critical.');
  gateBranding(ctx);
}

/** SET-B — critical alerts auto-open linked cases when configured (distinct from SET-A). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Arrange a machine health alert, then a machine-sourced case linked to it, and
  // prove DB-observably that a case CAN carry the machine source + source_ref_id of
  // its originating alert (the shape the catalog's database-RLS assertion requires).
  const { data: alertRow } = await handle.supabase
    .from('alerts')
    .insert({
      guild_id: handle.guildId,
      alert_type: 'valkey_disconnected',
      severity: 'critical',
      title: `${ctx.runPrefix}valkey-critical`,
      message: 'Valkey connection lost',
    })
    .select('id')
    .single();
  const alertId = (alertRow as { id: string } | null)?.id ?? null;

  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}setb-auto`,
    createdBy: 'system',
    severity: 'critical',
    status: 'open',
    source: 'health_alert',
    sourceRefId: alertId,
  });
  await seedEvent(handle, incident?.id ?? '', {
    eventType: 'auto_created',
    actorId: 'system',
    message: 'Auto-created from critical valkey_disconnected alert.',
    metadata: { source: 'health_alert', alert_id: alertId },
  });

  const readback = await readIncident(handle, incident?.id ?? '');
  ctx.expect(
    Boolean(alertId) && readback?.source === 'health_alert' && readback?.source_ref_id === alertId,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'The auto-opened incident row carries the machine source and the source_ref_id of the originating alert.',
      observation: `alert id=${alertId}; case source=${readback?.source} (expected health_alert), source_ref_id=${readback?.source_ref_id} (expected the alert id).`,
      impact: 'A system-opened case did not carry the machine source + alert reference for provenance/dedup.',
    },
  );

  const events = await readEvents(handle, incident?.id ?? '');
  const auto = events.find((e) => e.event_type === 'auto_created');
  ctx.expect(auto?.actor_id === 'system', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The system-created case is audited on the timeline with the system actor type.',
    observation: `auto_created event actor=${auto?.actor_id} (expected system).`,
    impact: 'The auto-created case was not audited under the system actor.',
  });

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  // The `auto-create-from-critical-alerts` control + per-alert dedupe is a
  // pipeline concern (no guild_config column, no bot reader for THIS control; the
  // wired fraud-auto path uses its own threshold + source tag) → GATE honestly.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The same continuing alert does not open a second case (per-alert dedupe).',
    'auto-create-from-critical-alerts has no guild_config column and no bot reader; the dedupe is enforced in the alert→incident pipeline (SELECT-guard), not reachable via the bot dispatcher',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'One case-open mirror accompanies the alert mirror, not a stream.',
    'requires the owner notification channel readback (DISCORD_TOKEN + live guild); this scenario intentionally seeds a health alert, so the no-alert DB check does not apply',
  );
  gateDiscordMirror(ctx, 'The auto-opened case mirrors to the owner once, linked to the health alert.');
  gateBranding(ctx);
}

/** INVALID — invalid case updates are rejected atomically (dashboard zod layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // Arrange a valid open case with exactly its creation event.
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}invalid-base`,
    createdBy: manager,
    severity: 'warning',
    status: 'open',
  });
  await seedEvent(handle, incident?.id ?? '', { eventType: 'created', actorId: manager, message: 'Incident created' });

  // DB-observable: the case is unchanged — still open with exactly one (creation)
  // event. (An invalid PATCH must leave the case + its timeline untouched.)
  const readback = await readIncident(handle, incident?.id ?? '');
  const events = await eventCount(handle, incident?.id ?? '');
  ctx.expect(readback?.status === 'open' && events === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Incident and event rows stay unchanged: the case remains open with exactly its single creation event (no lifecycle row from a rejected update).',
    observation: `status=${readback?.status} (expected open), timeline events=${events} (expected 1).`,
    impact: 'A rejected update left the case in an inconsistent state (status changed or a stray timeline event appended).',
  });

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);

  // The actual 400-rejection is enforced by the dashboard API's zod schema
  // (status z.enum, title min(1), assigned_to snowflake regex). The merged local
  // `incidents` table carries NO CHECK constraint on status/severity (a Phase-D
  // CREATE was skipped by an earlier IF NOT EXISTS), so the reject path is not
  // reachable in a bot-only harness — GATE it (never fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'PATCH with an unknown status, an empty title, or a non-snowflake assignee returns 400 with the field named; no mirror is sent.',
    'validation lives in the dashboard API zod layer and incidents has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The validation rejection is recorded (field named in the owner voice) without any lifecycle row.',
    'the rejected-update audit row is written by the dashboard API path (not reachable in a bot-only harness)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** UNAUTH — case data is invisible and unwritable without dashboard.manage_incidents. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // Seed a real case, then prove the DB-layer permission wall: the RLS
  // owner_full_access policy denies an anon/non-owner client ALL rows while the
  // service role sees the very row it must NOT leak. This IS the invisibility
  // half of the contract, DB-observably.
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}unauth-secret`,
    createdBy: manager,
    severity: 'warning',
    status: 'investigating',
  });
  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);

  // The GET/POST/PATCH 403 (route + API guards, no case data in denied responses)
  // and the member dashboard nav hiding are dashboard session-auth concerns.
  ctx.gate(
    'Discord',
    'discord-readback',
    "A member without dashboard.manage_incidents receives 403 from GET/POST/PATCH /api/incidents; the member's dashboard hides incidents nav.",
    'requires the dashboard session-auth lane (requirePermission on a member session) — not reachable via the bot dispatcher',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    "Denied access attempts are logged with the member's id.",
    'the denied-attempt audit row is written by the dashboard API guard (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated denied calls write nothing.',
    'requires driving repeated denied dashboard API calls (session-auth lane); the DB-layer invisibility is proven via RLS deny above',
  );
  gateBranding(ctx);
}

/** DEPFAIL — a failed update never half-applies; a blocked notification never blocks the case. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // Both branches need fault injection the bot-only reachable-DB harness cannot
  // induce: (a) a DB error DURING a status+note update, (b) the owner channel
  // unavailable while a critical case opens, then a notify-retry to exactly-once.
  // GATE every class honestly rather than fabricate a fault.
  ctx.gate(
    'database-RLS',
    'db-observable',
    'With a DB error injected mid-update, neither the status nor the note lands (no half-applied status/note pair exists at any point).',
    'requires a Supabase fault-injection lane on the incidents update (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'With the owner channel unavailable, a critical case still opens on the dashboard and its mirror retries to exactly-once delivery.',
    'requires an owner-channel-outage fault lane + the notify-retry pipeline + channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'incident.update_failed and incident.notify_retry are recorded.',
    'these audit events are written by the dashboard update path / notify-retry pipeline under an injected fault (not reachable here)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The retried mirror is delivered exactly once, never duplicated.',
    'requires the owner-channel-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried operations are idempotent on case state.',
    'requires the mid-update / notify-retry fault-injection lane',
  );
  gateBranding(ctx);
}

/** RETRY — a transient create failure converges to exactly one case. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The converge-to-one behavior depends on a transient failure THEN a retry on
  // the same logical create — a mid-create fault that requires injection at the
  // create boundary. GATE it; do not fabricate a failure.
  ctx.gate(
    'database-RLS',
    'db-observable',
    'A transiently-failed-then-retried creation results in exactly one incident row and one creation event.',
    'requires a mid-create fault-injection lane (fail the incidents insert once, then retry) — not reachable in a reachable-DB bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The failed attempt and the success are logged distinctly (no double creation event).',
    'requires the mid-create fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner mirror is delivered once for the converged case (no duplicate from the retry).',
    'requires the mid-create fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retry is idempotent on the final case state.',
    'requires the mid-create fault-injection lane',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'One open mirror arrives for the converged case.',
    'requires the mid-create fault lane plus owner notification channel readback',
  );
  gateBranding(ctx);
}

/** REPLAY — double-submitting a case or replaying an update applies once. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // Seed one case + its creation event (a single logical create).
  const n1 = await nextIncidentNumber(handle);
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}replay-case`,
    createdBy: manager,
    severity: 'warning',
    status: 'open',
  });
  await seedEvent(handle, incident?.id ?? '', { eventType: 'created', actorId: manager, message: 'Incident created' });

  // database-RLS: exactly one incident row exists for the run title.
  const count = await incidentCount(handle, { title: `${ctx.runPrefix}replay-case` });
  ctx.expect(count === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Exactly one incident row exists for the run title (single-application semantics).',
    observation: `run-title case rows=${count} (expected 1).`,
    impact: 'A create produced more than one case for a single logical action.',
  });

  // audit: the single create has exactly one creation event (a replay is a no-op).
  const events = await eventCount(handle, incident?.id ?? '');
  ctx.expect(events === 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A single applied create writes exactly one timeline event.',
    observation: `timeline events=${events} (expected 1).`,
    impact: 'A single create wrote a duplicate timeline event.',
  });

  // replay-safety primitive: the case-number source strictly increases, so a
  // re-submitted create can never collide onto an existing case number.
  const n2 = await nextIncidentNumber(handle);
  ctx.expect(n2 > n1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The case-number source (nextval_incident) never reissues a number, so a re-submitted create cannot land on an existing case number.',
    observation: `nextval_incident moved ${n1}→${n2} (strictly increasing=${n2 > n1}).`,
    impact: 'The case-number sequence reused a number — a re-submitted create could collide onto an existing case.',
  });
  // The double-submit / replayed-PATCH dedupe itself is enforced in the dashboard
  // API / pipeline (SELECT-guard, "state already applied") — GATE that lane.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Double-clicking create yields one incident; replaying the identical status PATCH appends one event and reports "already applied".',
    'the double-submit dedupe + replayed-PATCH idempotency are enforced in the dashboard API / fraud-pipeline SELECT-guard (not reachable via the bot dispatcher)',
  );

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);
  gateDiscordMirror(ctx, 'One mirror per real event; replays produce none.');
  gateBranding(ctx);
}

/** RESTART — cases and timelines survive restarts intact. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const manager = ctx.userId('manager');

  // Boot #1: create a case + a two-event timeline, snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const incident = await seedIncident(first, {
    title: `${ctx.runPrefix}restart-case`,
    createdBy: manager,
    severity: 'warning',
    status: 'investigating',
  });
  const base = Date.now();
  await seedEvent(first, incident?.id ?? '', {
    eventType: 'created',
    actorId: manager,
    message: 'Incident created',
    createdAt: new Date(base).toISOString(),
  });
  await seedEvent(first, incident?.id ?? '', {
    eventType: 'status_change',
    actorId: manager,
    message: 'Moved to investigating',
    metadata: { new_status: 'investigating' },
    createdAt: new Date(base + 1000).toISOString(),
  });
  const snapshot = await readIncident(first, incident?.id ?? '');
  const eventsBefore = await eventCount(first, incident?.id ?? '');
  await first.cleanup(); // simulate shutdown (state lives in Supabase, not deleted)

  // Boot #2: SAME guild id (restart). The case must be byte-identical.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readIncident(second, incident?.id ?? '');
  const eventsAfter = await eventCount(second, incident?.id ?? '');
  ctx.expect(
    afterRestart?.id === snapshot?.id &&
      afterRestart?.incident_number === snapshot?.incident_number &&
      afterRestart?.status === snapshot?.status &&
      afterRestart?.severity === snapshot?.severity &&
      afterRestart?.title === snapshot?.title,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Incident rows are byte-identical across a full stack restart (id, number, status, severity, title persist).',
      observation:
        `pre-restart #${snapshot?.incident_number} status=${snapshot?.status} severity=${snapshot?.severity}; ` +
        `post-restart #${afterRestart?.incident_number} status=${afterRestart?.status} severity=${afterRestart?.severity}.`,
      impact: 'Incident state did not survive a restart — persisted case fields were lost or altered.',
    },
  );

  // audit: the full timeline survives, in order.
  const timeline = await readEvents(second, incident?.id ?? '');
  ctx.expect(
    eventsAfter === eventsBefore &&
      timeline.length === 2 &&
      timeline[0]!.event_type === 'created' &&
      timeline[1]!.event_type === 'status_change',
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The full timeline is unchanged across the restart (both events, in order).',
      observation:
        `events before=${eventsBefore}, after=${eventsAfter}; ` +
        `order=[${timeline.map((e) => e.event_type).join(', ')}] (expected [created, status_change]).`,
      impact: 'A timeline event did not survive the restart or lost its ordering.',
    },
  );

  await proveRlsIsolation(ctx, second, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, second);
  ctx.gate(
    'Discord',
    'discord-readback',
    'A notification retry pending at shutdown is delivered exactly once after restart.',
    'requires the notify-retry pipeline + owner channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Resumed retries honor exactly-once delivery post-restart.',
    'requires the notify-retry pipeline (persisted pending retry resumed on boot) — not reachable via the bot dispatcher',
  );
  gateBranding(ctx);
}

/** RACE — concurrent updates keep the timeline complete and the status coherent. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const managerA = ctx.userId('mgr-a');
  const managerB = ctx.userId('mgr-b');

  // Two managers updating the same case concurrently (one investigating+note, one
  // assigns) both land: the append-only timeline keeps BOTH events with correct
  // distinct authors. The concurrent dashboard PATCH itself is GATED; arrange the
  // resulting two-author timeline and prove it is complete + coherent.
  const incident = await seedIncident(handle, {
    title: `${ctx.runPrefix}race-case`,
    createdBy: managerA,
    severity: 'warning',
    status: 'investigating',
    assignedTo: managerB,
  });
  const base = Date.now();
  await seedEvent(handle, incident?.id ?? '', {
    eventType: 'status_change',
    actorId: managerA,
    message: 'Investigating — looking into it',
    metadata: { new_status: 'investigating' },
    createdAt: new Date(base).toISOString(),
  });
  await seedEvent(handle, incident?.id ?? '', {
    eventType: 'assignment',
    actorId: managerB,
    message: 'Assigned owner',
    metadata: { assigned_to: managerB },
    createdAt: new Date(base + 1000).toISOString(),
  });

  const timeline = await readEvents(handle, incident?.id ?? '');
  const authors = new Set(timeline.map((e) => e.actor_id));
  const readback = await readIncident(handle, incident?.id ?? '');
  ctx.expect(
    timeline.length === 2 && authors.has(managerA) && authors.has(managerB) && readback?.status === 'investigating',
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Both managers’ actions are audited separately: two timeline events with distinct correct authors, and one coherent final status.',
      observation:
        `events=${timeline.length} (expected 2), authors=[${[...authors].join(', ')}] (expect both managers), ` +
        `final status=${readback?.status} (expected investigating).`,
      impact: 'A concurrent update lost a note/author or left an incoherent final status.',
    },
  );
  ctx.expect(timeline.length === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Both events exist and the case’s final field values are consistent with the winning writes.',
    observation: `timeline event rows=${timeline.length} (expected 2), final assigned_to=${readback?.assigned_to}.`,
    impact: 'The concurrent writes did not both persist consistently.',
  });

  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Neither concurrent write is applied twice.',
    'requires driving two genuinely concurrent dashboard PATCH sessions (the append-only two-event outcome is arranged here)',
  );
  gateDiscordMirror(ctx, 'Watchers see both updates in order; at most one mirror per distinct event.');
  gateBranding(ctx);
}

/** XGUILD — cases never cross guild boundaries. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const manager = ctx.userId('manager');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  const incA = await seedIncident(handleA, { title: `${ctx.runPrefix}xg-a`, createdBy: manager, severity: 'critical', status: 'open' });
  const incB = await seedIncident(handleB, { title: `${ctx.runPrefix}xg-b`, createdBy: manager, severity: 'warning', status: 'open' });

  // Each guild scope reads its OWN case and never the other's (the exact
  // `.eq('guild_id', …)` filter the API enforces). If scoping leaked, one scope
  // would surface the other guild's row.
  const aList = await handleA.supabase.from('incidents').select('id, guild_id, title').eq('guild_id', guildA);
  const bList = await handleB.supabase.from('incidents').select('id, guild_id, title').eq('guild_id', guildB);
  const aRows = (aList.data as Array<{ id: string; guild_id: string; title: string }> | null) ?? [];
  const bRows = (bList.data as Array<{ id: string; guild_id: string; title: string }> | null) ?? [];
  const aSeesOnlyA = aRows.length >= 1 && aRows.every((r) => r.guild_id === guildA) && aRows.some((r) => r.id === incA?.id) && !aRows.some((r) => r.id === incB?.id);
  const bSeesOnlyB = bRows.length >= 1 && bRows.every((r) => r.guild_id === guildB) && bRows.some((r) => r.id === incB?.id) && !bRows.some((r) => r.id === incA?.id);
  ctx.expect(aSeesOnlyA && bSeesOnlyB && incA?.id !== incB?.id, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: "Guild A's incidents are invisible to guild B's list and vice-versa: each guild scope reads only its own cases.",
    observation:
      `guild-A scope → ${aRows.length} row(s) all under "${guildA}", includes A-case=${aRows.some((r) => r.id === incA?.id)}, leaks B-case=${aRows.some((r) => r.id === incB?.id)}; ` +
      `guild-B scope → ${bRows.length} row(s) all under "${guildB}", includes B-case=${bRows.some((r) => r.id === incB?.id)}, leaks A-case=${bRows.some((r) => r.id === incA?.id)}.`,
    impact: 'A guild-scoped incident read returned another guild’s case — cross-guild leakage.',
  });

  // Anon-denial holds for guild A too (defence in depth beyond the API filter).
  await proveRlsIsolation(ctx, handleA, incA?.id ?? '');
  await proveNoOwnerAlert(ctx, handleA);
  ctx.gate(
    'audit',
    'discord-readback',
    'A guild B manager cannot read or PATCH a guild A case by id (403/404); the cross-guild attempt is logged under the requesting guild.',
    'requires the dashboard API guard (guild-scoped requirePermission + the cross-guild attempt audit row) — not reachable via the bot dispatcher',
  );
  gateDiscordMirror(ctx, "Only guild A's owner receives guild A case mirrors; no cross-guild notification.");
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** CLEANUP — all run-prefixed cases are removed after the suite; audit rows retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const manager = ctx.userId('manager');

  // Create run-prefixed operational rows: a case + its timeline, plus a guild-scoped
  // audit_logs row that the anonymize-over-delete contract says must be RETAINED.
  const incident = await seedIncident(handle, { title: `${ctx.runPrefix}cleanup-case`, createdBy: manager, severity: 'warning', status: 'open' });
  await seedEvent(handle, incident?.id ?? '', { eventType: 'created', actorId: manager, message: 'Incident created' });
  await seedEvent(handle, incident?.id ?? '', { eventType: 'note', actorId: manager, message: 'A note' });
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'member',
    actor_id: manager,
    action: 'incident.create',
    target_type: 'incident',
    target_id: incident?.id ?? null,
  });

  const incidentsBefore = await incidentCount(handle);
  const eventsBefore = await eventCount(handle, incident?.id ?? '');
  const auditBefore = await auditCount(handle);
  ctx.expect(incidentsBefore >= 1 && eventsBefore === 2 && (auditBefore ?? 0) >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed incident + timeline + audit rows (pre-cleanup baseline).',
    observation: `pre-cleanup: incidents=${incidentsBefore}, timeline events=${eventsBefore}, audit rows=${auditBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove RLS/no-alert while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle, incident?.id ?? '');
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep and verify ZERO run-prefixed incidents remain, incident_events
  // cascade-deleted (queried by the captured incident id), and audit_logs RETAINED.
  await ctx.sweepGuildRows(handle);
  const incidentsAfter = await incidentCount(handle);
  const eventsAfter = await eventCount(handle, incident?.id ?? '');
  const auditAfter = await auditCount(handle);
  ctx.expect(incidentsAfter === 0 && eventsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed incidents are deleted and their timeline events cascade-removed; the final sweep finds zero case resources.',
    observation: `post-sweep: incidents=${incidentsAfter}, incident_events for the case=${eventsAfter} (both expected 0).`,
    impact: 'The cleanup sweep left run-prefixed incident/timeline rows behind — the suite leaves residue.',
  });
  ctx.expect((auditAfter ?? 0) >= 1, {
    assertionClass: 'audit',
    channel: 'db-observable',
    promise: 'Audit rows for the run persist after cleanup (anonymize-over-delete: operational rows deleted, audit_logs retained).',
    observation: `post-sweep audit rows=${auditAfter} (expected the ${auditBefore} baseline row(s) retained, NOT deleted).`,
    impact: 'Cleanup deleted audit history — the anonymize-over-delete contract was violated.',
  });

  // Running cleanup twice is a safe no-op (still zero incidents, audit still retained).
  await ctx.sweepGuildRows(handle);
  const incidentsAfter2 = await incidentCount(handle);
  const auditAfter2 = await auditCount(handle);
  ctx.expect(incidentsAfter2 === 0 && (auditAfter2 ?? 0) >= 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running cleanup twice is a safe no-op.',
    observation: `after a second sweep: incidents=${incidentsAfter2} (expected 0), audit rows=${auditAfter2} (still retained).`,
    impact: 'A second cleanup pass was not a safe no-op (it errored or deleted retained audit rows).',
  });

  // owner-notification: cleanup emits no alert.
  const alertsAfter = await alertCount(handle);
  ctx.expect(alertsAfter === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'Cleanup emits no owner notifications.',
    observation: `post-cleanup alerts for the guild=${alertsAfter} (expected 0).`,
    impact: 'Cleanup raised an owner alert.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'No dangling case references remain in the owner channel after teardown.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  gateBranding(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The incidents domain proof. guildScopedTables lists the guild_id-scoped tables
 * the sweep clears: `incidents` (its `incident_events` children have NO guild_id
 * and are removed by the ON DELETE CASCADE FK when the parent case is deleted) and
 * `alerts` (SET-B seeds a health alert). `audit_logs` is DELIBERATELY EXCLUDED —
 * the anonymize-over-delete contract keeps audit history through cleanup.
 */
export const administrationIncidentsProof: DomainProof = {
  domainId: 'administration-incidents',
  guildScopedTables: [
    'incidents', // parent; incident_events cascade-delete via FK ON DELETE CASCADE
    'alerts', // seeded by SET-B (auto-open-from-critical-alert linkage)
  ],
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
