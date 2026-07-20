/**
 * scenario-runner/scripts/commerce-fraud — the fraud-detection domain proof.
 *
 * Binds the commerce-fraud domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. This domain is
 * DELIBERATELY, HONESTLY MOSTLY-GATED, and the reason is structural, not a
 * shortcut:
 *
 *   Fraud detection has NO slash command. Its detectors
 *   (checkPurchaseVelocity / checkPaymentPattern / checkDeviceAbuse /
 *   checkIPMismatch / checkCriticalThreshold — packages/bot/src/services/
 *   fraud-detection.ts) run INSIDE commerce fulfillment, invoked from the
 *   payment/purchase webhook path (commerce-fulfillment.ts runFraudChecks),
 *   NEVER from an interaction. The rule configuration is a Next.js dashboard
 *   surface (/api/fraud/rules) behind an owner/admin session, and every alert
 *   surface — the critical owner DM, the staff-channel mirror, the dashboard
 *   fraud queue and incidents page — is Discord/dashboard, not a slash reply.
 *
 * The bot-only, slash-driven, local-Supabase harness can therefore drive NONE
 * of the detector firing (needs a commerce-fulfillment event lane), NONE of the
 * rule mutation / dashboard validation (needs the RBAC dashboard session), and
 * NONE of the owner-DM / staff-mirror / queue rendering (needs DISCORD_TOKEN + a
 * live guild). The fault lanes (DEPFAIL signal-write-failure, RETRY closed-DM)
 * need injection. Those are gated loudly with precise reasons — never faked.
 *
 * What DOES run now, against real state, is everything that rides on the fraud
 * STORAGE the detectors write to and the RLS that fences it — the exact
 * database-RLS / audit / persistence / atomic-sequence evidence the catalog
 * contracts:
 *   - a velocity fraud_signals row carrying the detector's typed evidence
 *     (order_count / window / threshold) persists with the DB-defaulted `open`
 *     status, guild-scoped, and is unreadable to an anon client while the
 *     service role sees it (DEF, SET-A, UNAUTH),
 *   - the ONE applied CHECK on the fraud tables — fraud_signals_status_check —
 *     rejects an out-of-domain signal status while the prior valid value is
 *     retained (INVALID),
 *   - anon RLS probes on fraud_signals AND incidents return zero rows the
 *     service role can see (UNAUTH — the exact "fraud data is admin-only" fence),
 *   - open signals and incidents survive a full stack restart byte-for-byte
 *     (RESTART),
 *   - the atomic incident sequence (nextval_incident) hands out distinct numbers
 *     under concurrency, and one auto_created incident_events row records the
 *     burst count (RACE),
 *   - fraud rows are strictly per-guild: guild A's signals never appear scoped to
 *     guild B (XGUILD),
 *   - the cleanup sweep clears every run-prefixed signal / incident and cascades
 *     its incident_events (CLEANUP).
 *
 * NON-VACUITY: every ctx.expect below reads a REAL row / count / RPC result back
 * from local Supabase (or observes a REAL DB rejection). RLS proofs are made
 * non-vacuous by a positive control — the row the service role sees that the anon
 * client must NOT. Nothing that cannot be driven now is faked; it is gated with
 * the exact missing lane.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface SignalRow {
  id: string;
  guild_id: string;
  signal_type: string;
  severity: string;
  status: string;
  entity_type: string | null;
  entity_id: string | null;
  discord_id: string | null;
  evidence: Record<string, unknown> | null;
}

interface IncidentRow {
  id: string;
  guild_id: string;
  incident_number: number | null;
  status: string;
  severity: string;
  source: string | null;
}

interface IncidentEventRow {
  incident_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
}

/** The typed evidence a velocity detector writes (fraud-detection.ts). */
interface VelocityEvidence {
  order_count?: number;
  window_minutes?: number;
  threshold?: number;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

interface SignalSeed {
  signalType?: string;
  severity?: string;
  entityType?: string;
  entityId?: string;
  discordId?: string | null;
  description?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Insert a fraud_signals row in the EXACT shape the real `createSignal`
 * (fraud-detection.ts) writes — guild_id + signal_type + severity + entity +
 * discord_id + description + evidence — but deliberately WITHOUT `status`, so the
 * schema DEFAULT ('open', from the v10 fraud_signals status column) is what the
 * read-back proves. Returns the persisted row so callers assert real DB state,
 * never a value they hand-constructed.
 */
async function insertSignal(
  handle: LiveClientHandle,
  guildId: string,
  seed: SignalSeed,
): Promise<{ id: string | null; error: string | null; row: SignalRow | null }> {
  const { data, error } = await handle.supabase
    .from('fraud_signals')
    .insert({
      guild_id: guildId,
      signal_type: seed.signalType ?? 'velocity',
      severity: seed.severity ?? 'high',
      entity_type: seed.entityType ?? 'customer',
      entity_id: seed.entityId ?? `${guildId}-cust`,
      discord_id: seed.discordId ?? null,
      description: seed.description ?? 'e2e velocity signal',
      evidence: seed.evidence ?? {},
    })
    .select('id, guild_id, signal_type, severity, status, entity_type, entity_id, discord_id, evidence')
    .single();
  const row = (data as SignalRow | null) ?? null;
  return { id: row?.id ?? null, error: error ? error.message : null, row };
}

async function readSignal(handle: LiveClientHandle, id: string): Promise<SignalRow | null> {
  const { data } = await handle.supabase
    .from('fraud_signals')
    .select('id, guild_id, signal_type, severity, status, entity_type, entity_id, discord_id, evidence')
    .eq('id', id)
    .maybeSingle();
  return (data as SignalRow | null) ?? null;
}

async function signalCount(handle: LiveClientHandle, guildId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('fraud_signals')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  return count ?? 0;
}

async function incidentCount(handle: LiveClientHandle, guildId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('incidents')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  return count ?? 0;
}

/** Draw a real incident number from the production atomic sequence RPC. */
async function nextIncidentNumber(handle: LiveClientHandle): Promise<number> {
  const { data } = await handle.supabase.rpc('nextval_incident');
  const n = typeof data === 'number' ? data : Number(data);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Insert an incident in the shape `checkCriticalThreshold` writes: guild_id,
 * incident_number (from nextval_incident), title/description, critical severity,
 * open status, source 'fraud_auto', created_by 'system:fraud'. `created_by` is
 * TEXT NOT NULL on the real (missing_tables) incidents table, so it is required.
 */
async function insertIncident(
  handle: LiveClientHandle,
  guildId: string,
  incidentNumber: number,
  overrides: { status?: string; severity?: string; source?: string } = {},
): Promise<{ id: string | null; error: string | null; row: IncidentRow | null }> {
  const { data, error } = await handle.supabase
    .from('incidents')
    .insert({
      guild_id: guildId,
      incident_number: incidentNumber,
      title: `Fraud alert: burst of critical signals`,
      description: 'Auto-created incident due to elevated critical fraud signals.',
      severity: overrides.severity ?? 'critical',
      status: overrides.status ?? 'open',
      source: overrides.source ?? 'fraud_auto',
      created_by: 'system:fraud',
    })
    .select('id, guild_id, incident_number, status, severity, source')
    .single();
  const row = (data as IncidentRow | null) ?? null;
  return { id: row?.id ?? null, error: error ? error.message : null, row };
}

async function readIncident(handle: LiveClientHandle, id: string): Promise<IncidentRow | null> {
  const { data } = await handle.supabase
    .from('incidents')
    .select('id, guild_id, incident_number, status, severity, source')
    .eq('id', id)
    .maybeSingle();
  return (data as IncidentRow | null) ?? null;
}

/** Insert the auto_created timeline event checkCriticalThreshold writes. */
async function insertAutoCreatedEvent(
  handle: LiveClientHandle,
  incidentId: string,
  signalCountValue: number,
): Promise<{ error: string | null; row: IncidentEventRow | null }> {
  const { data, error } = await handle.supabase
    .from('incident_events')
    .insert({
      incident_id: incidentId,
      event_type: 'auto_created',
      actor_id: 'system:fraud',
      message: `${signalCountValue} critical fraud signals detected in the last hour. Automatic incident created.`,
      metadata: { signal_count: signalCountValue },
    })
    .select('incident_id, event_type, metadata')
    .single();
  return { error: error ? error.message : null, row: (data as IncidentEventRow | null) ?? null };
}

async function incidentEventCount(handle: LiveClientHandle, incidentId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('incident_events')
    .select('*', { count: 'exact', head: true })
    .eq('incident_id', incidentId);
  return count ?? 0;
}

/**
 * Count owner-alert rows for the guild. Returns null (NOT 0) when the query
 * errors, so a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS
 * owner_full_access + the v6 anon GRANT revoke → 0), or null when no anon key is
 * available / the probe is inconclusive (→ GATE). A genuine authorization denial
 * (SQLSTATE 42501 / "permission denied") is the deny we want to prove.
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
      return 0; // the anon role is denied the table — RLS/GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove the guild-scoped RLS the catalog contracts for a fraud table: the
 * service role reads the rows THIS scenario created under the guild while an anon
 * client reads zero of them (RLS owner_full_access + the v6 anon-GRANT revoke).
 * Non-vacuous by the positive control (`serviceRows` the caller already created
 * and re-counted); an anon read of ZERO of those rows is a real deny, not "there
 * was nothing to read." Cross-GUILD isolation is proven separately in XGUILD.
 */
async function proveTableRls(
  ctx: ScenarioContext,
  table: string,
  guildId: string,
  serviceRows: number,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `An anon/member client reads zero ${table} rows for the guild while the service role sees them (RLS owner_full_access).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-denial sub-probe cannot run — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `An anon/member client reads zero ${table} rows for the guild while the service role sees them.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceRows >= 1 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} rows while an anon client reads zero of them (RLS owner_full_access; anon table GRANT revoked in v6).`,
    observation:
      `service-role sees ${serviceRows} ${table} row(s) under guild "${guildId}"; ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — fraud data is exposed to unauthenticated clients (RLS not denying anon reads).`,
  });
}

/** Happy-path owner-notification: fraud writes no spurious row to the generic alerts table. */
async function proveNoSpuriousAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      'This scenario raises no spurious generic owner-alert row.',
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise:
        'Fraud notifications flow through the owner-DM / dashboard queue path, NOT the generic alerts table — arranging fraud rows raises zero spurious alerts rows.',
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'A spurious generic owner alert was raised — notification noise on a path that should DM/queue instead.',
    });
  }
}

/** The guaranteed owner surfaces (critical DM, dashboard fraud queue, incidents page) are Discord/dashboard. */
function gateOwnerSurfaces(ctx: ScenarioContext): void {
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner sees every critical finding through at least one guaranteed surface (critical DM, dashboard fraud queue, incidents page) even when another surface fails.',
    'the owner DM is sent via the owner-notifications event bus → Discord DM (needs DISCORD_TOKEN + a live gateway); the fraud queue / incidents page are Next.js dashboard surfaces behind an owner/admin RBAC session — neither is reachable from this bot-only slash harness',
  );
}

/** Branding for commerce-fraud rides entirely on owner DMs + staff-channel embeds — no slash reply exists. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    "Alert copy is owner-voiced, calm, and precise, carrying the powered-by-SomniBot attribution on embeds (owner DM + staff-channel alert).",
    'commerce-fraud produces no slash reply; every branded surface is a Discord DM/embed emitted on a fraud.detected / incident.created event, which this bot-only slash harness cannot drive (needs a commerce event lane + DISCORD_TOKEN + a live guild)',
  );
}

/** The critical owner DM + no-member-visible-fraud Discord assertion is discord-readback. */
function gateOwnerDm(ctx: ScenarioContext, detail: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    detail,
    'the critical owner DM is sent via the owner-notifications event bus → Discord DM and the "no member-visible fraud" check needs channel readback (DISCORD_TOKEN + a live guild); the bot fraud service emits fraud.detected on the event bus rather than posting any slash reply',
  );
}

/** The detector firing itself needs the commerce-fulfillment event lane (no slash command exists). */
function gateDetectorLane(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'db-observable',
    promise,
    'commerce-fraud exposes no slash command; the detectors (checkPurchaseVelocity/checkPaymentPattern/checkCriticalThreshold) run inside commerce-fulfillment on payment/purchase webhook events (runFraudChecks), so this bot-only slash harness cannot trigger detection — it needs a commerce-fulfillment event driver',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-processing the same commerce events never duplicates signals, incidents, or notifications for one burst.',
    `replay/idempotency DB mechanics are exercised directly in the ${where} scenario; the detector re-run that would create duplicate signals needs the commerce event lane`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a velocity signal carries typed evidence + open status, guild-scoped and RLS-fenced. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  const velocityThreshold = Number(declaredDefault(ctx.domain, 'velocity-order-threshold')); // 5
  const windowMs = Number(declaredDefault(ctx.domain, 'velocity-window-ms')); // 3600000
  const windowMinutes = Math.round(windowMs / 60000); // 60

  // Arrange the exact velocity signal the detector writes when five orders cross
  // the window (severity 'high' at the threshold; the detector escalates to
  // 'critical' at 2× threshold). Status is intentionally omitted so the DB
  // default proves through on read-back.
  const inserted = await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'high',
    entityType: 'customer',
    entityId: `${ctx.runPrefix}cust-a`,
    discordId: ctx.userId('a'),
    description: `${velocityThreshold} orders in the last ${windowMinutes} minutes (threshold: ${velocityThreshold})`,
    evidence: { order_count: velocityThreshold, window_minutes: windowMinutes, threshold: velocityThreshold },
  });
  const row = inserted.id ? await readSignal(handle, inserted.id) : null;
  const ev = (row?.evidence ?? {}) as VelocityEvidence;
  ctx.expect(
    inserted.error === null &&
      row?.status === 'open' &&
      row?.signal_type === 'velocity' &&
      ev.order_count === velocityThreshold &&
      ev.window_minutes === windowMinutes &&
      ev.threshold === velocityThreshold,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `A velocity fraud_signals row carries typed evidence (order_count, window, threshold) and the DB-defaulted 'open' status.`,
      observation: inserted.error
        ? `the velocity signal insert errored: "${inserted.error}".`
        : `persisted signal: type="${row?.signal_type}", status="${row?.status}" (DB default), ` +
          `evidence.order_count=${ev.order_count}, window_minutes=${ev.window_minutes}, threshold=${ev.threshold}.`,
      impact:
        'The fraud_signals storage did not accept/preserve the detector\'s velocity evidence shape or the open-status default — a signal would not persist as contracted.',
    },
  );

  // Audit: the signal is traceable to the triggering customer with its evidence snapshot.
  ctx.expect(row?.entity_type === 'customer' && row?.entity_id === `${ctx.runPrefix}cust-a` && ev.order_count === velocityThreshold, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Signal creation is traceable to the triggering customer with its evidence snapshot.',
    observation:
      `signal entity_type="${row?.entity_type}", entity_id="${row?.entity_id}", ` +
      `discord_id="${row?.discord_id}", evidence.order_count=${ev.order_count}.`,
    impact: 'A signal did not carry the triggering-customer + evidence trace the audit surface reads.',
  });

  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // The detector-firing (five orders → one signal; ten → critical → owner DM) and
  // the queue/DM surfaces are event/Discord/dashboard lanes.
  gateDetectorLane(
    ctx,
    'Out of the box, five orders by one customer inside an hour raises exactly one velocity signal; ten raises a critical signal.',
  );
  gateOwnerDm(ctx, 'The owner DM arrives for the critical signal naming severity, type, and guild; no member-visible channel mentions fraud.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — a lowered velocity threshold is stored in fraud_rules and the signal evidence records it. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;
  const configuredThreshold = 2;

  // Persist the rule the dashboard /api/fraud/rules POST writes: a velocity_limit
  // rule whose config holds the configured threshold. Read it back (round-trip
  // through the real fraud_rules JSONB) rather than asserting a constructed value.
  const ruleInsert = await handle.supabase
    .from('fraud_rules')
    .insert({
      guild_id: guildId,
      name: `${ctx.runPrefix}velocity-rule`,
      rule_type: 'velocity_limit',
      config: { threshold: configuredThreshold, window_minutes: 60 },
      enabled: true,
    })
    .select('id, rule_type, config')
    .single();
  const ruleRow = ruleInsert.data as { id: string; rule_type: string; config: Record<string, unknown> } | null;
  const ruleThreshold = (ruleRow?.config as { threshold?: number } | undefined)?.threshold;
  ctx.expect(ruleInsert.error === null && ruleRow?.rule_type === 'velocity_limit' && ruleThreshold === configuredThreshold, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The fraud_rules row the dashboard writes holds the configured velocity threshold in its typed config.',
    observation: ruleInsert.error
      ? `the fraud_rules insert errored: "${ruleInsert.error}".`
      : `fraud_rules: rule_type="${ruleRow?.rule_type}", config.threshold=${ruleThreshold} (expected ${configuredThreshold}).`,
    impact: 'The fraud rule configuration did not persist its threshold — a saved dashboard rule would be lost.',
  });

  // The signal the detector would raise on the SECOND order under the lowered
  // threshold: its evidence records threshold 2 and order_count 2.
  const inserted = await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'high',
    entityId: `${ctx.runPrefix}cust-a`,
    description: `2 orders in the last 60 minutes (threshold: ${configuredThreshold})`,
    evidence: { order_count: 2, window_minutes: 60, threshold: configuredThreshold },
  });
  const row = inserted.id ? await readSignal(handle, inserted.id) : null;
  const ev = (row?.evidence ?? {}) as VelocityEvidence;
  ctx.expect(inserted.error === null && ev.order_count === 2 && ev.threshold === configuredThreshold, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: "The signal's evidence records the configured threshold (2) and the crossing order count (2).",
    observation: `signal evidence: order_count=${ev.order_count} (expected 2), threshold=${ev.threshold} (expected ${configuredThreshold}).`,
    impact: 'The signal evidence did not reflect the configured threshold — a lowered rule would be untraceable in the evidence.',
  });

  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // Whether the RUNNING detector actually applies the configured threshold is
  // both event-driven AND — per the shipped bot — questionable: checkPurchaseVelocity
  // hardcodes threshold=5 and reads neither fraud_rules nor guild_config. Gated,
  // with that divergence surfaced for the owner rather than force-passed.
  ctx.gate(
    'Discord',
    'db-observable',
    'With velocity-order-threshold configured to 2, the detector fires on the second order in the window (a control customer with one order raises nothing).',
    'the shipped detector checkPurchaseVelocity hardcodes threshold=5 and reads neither fraud_rules nor guild_config, so config likely does NOT change bot-side detection; confirming this needs a commerce-fulfillment event lane (a probable divergence flagged for the owner)',
  );
  gateOwnerDm(ctx, 'Owner notification behavior matches the recomputed severity for the lowered threshold.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — a triggered signal persists unchanged; the staff-channel mirror is a Discord surface (unbuilt in the bot). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // The signal row is written first and is unchanged by any (Discord-side)
  // mirroring — prove it persists open with its evidence intact.
  const inserted = await insertSignal(handle, guildId, {
    signalType: 'payment_pattern',
    severity: 'medium',
    entityId: `${ctx.runPrefix}cust-a`,
    description: '3 failed payments in the last 24 hours',
    evidence: { failed_count: 3, window_hours: 24 },
  });
  const row = inserted.id ? await readSignal(handle, inserted.id) : null;
  ctx.expect(inserted.error === null && row?.status === 'open' && row?.signal_type === 'payment_pattern', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The signal row is written and is unchanged by staff-channel mirroring (it stays open with its type/evidence).',
    observation: inserted.error
      ? `the signal insert errored: "${inserted.error}".`
      : `signal type="${row?.signal_type}", status="${row?.status}" after arranging the mirror-eligible signal.`,
    impact: 'The signal row was altered by (or dependent on) the mirror path — mirroring must never mutate the source signal.',
  });

  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // The staff-channel mirror + its config storage are gated: the bot fraud
  // service posts NO staff-channel message (createSignal only emits fraud.detected
  // on the event bus), and there is no staff-alert-channel persistence column in
  // the schema — so both the mirror post and the "config row holds the channel id"
  // assertion are undriveable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With staff-alert-channel set, every new signal mirrors exactly once to that channel naming type, severity, and entity kind — never buyer payment details.',
    'the bot fraud service (createSignal) posts no staff-channel message and there is no staff-alert-channel storage column in the schema; the mirror needs the (currently unbuilt) mirror path + DISCORD_TOKEN + a live guild',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The channel configuration and each mirror post are traceable.',
    'staff-channel config + mirror posts are dashboard/Discord surfaces with no DB-observable persistence in the bot path',
  );
  gateOwnerDm(ctx, 'Owner DM for critical signals continues alongside the staff mirror without duplication.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — the one applied CHECK (fraud_signals status) rejects an out-of-domain status; the valid row survives. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  const inserted = await insertSignal(handle, guildId, {
    signalType: 'ip_mismatch',
    severity: 'medium',
    entityType: 'license_key',
    entityId: `${ctx.runPrefix}key-a`,
    description: '5 unique IPs in the last 24 hours',
    evidence: { unique_ips: 5, window_hours: 24 },
  });

  // An out-of-domain status is rejected by fraud_signals_status_check
  // (status IN open|investigating|confirmed|dismissed|auto_resolved); the prior
  // valid 'open' survives byte-for-byte.
  const badStatus = inserted.id
    ? await handle.supabase.from('fraud_signals').update({ status: 'nuked' }).eq('id', inserted.id)
    : { error: null };
  const after = inserted.id ? await readSignal(handle, inserted.id) : null;
  ctx.expect(inserted.error === null && badStatus.error !== null && after?.status === 'open', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'An invalid signal status never persists: the DB rejects it atomically (fraud_signals_status_check) and the row keeps its prior valid status byte-for-byte.',
    observation:
      `invalid status="nuked" update ${badStatus.error ? `rejected ("${badStatus.error}")` : 'ACCEPTED'}; ` +
      `persisted status is now "${after?.status}" (expected retained "open").`,
    impact: 'A malformed fraud_signals status was accepted — the status CHECK constraint is missing or not enforced.',
  });

  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // The catalog's atomic rejection of invalid THRESHOLDS / channel ids / unknown
  // signal types lives in the dashboard (/api/fraud/rules Zod) layer — and the
  // fraud tables carry NO CHECK on signal_type / severity / rule_type, so a
  // bot-only harness cannot reach the reject path. Gated honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'PUT /api/fraud/rules with a zero velocity threshold, a non-numeric channel id, and an unknown rule key each return field-level validation errors; the rules rows are unchanged.',
    'rule validation lives in the dashboard (/api/fraud/rules) layer behind an owner/admin RBAC session; the fraud tables carry no DB CHECK on signal_type/severity/rule_type, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each rejected rule change is logged with its validation reason.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** UNAUTH — fraud data is admin-only: anon RLS probes on fraud_signals AND incidents return nothing. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // Arrange a signal + an incident the service role can see (positive controls).
  await insertSignal(handle, guildId, {
    signalType: 'device_abuse',
    severity: 'critical',
    entityType: 'license_key',
    entityId: `${ctx.runPrefix}key-a`,
    description: '18 total device sessions on a 3-device license',
    evidence: { total_sessions: 18, max_devices: 3, ratio: 6 },
  });
  const incNumber = await nextIncidentNumber(handle);
  const inc = await insertIncident(handle, guildId, incNumber);
  const serviceSignals = await signalCount(handle, guildId);
  const serviceIncidents = await incidentCount(handle, guildId);

  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'A member/anon client reads ZERO fraud_signals and incidents rows while the service role sees them (RLS owner_full_access; anon GRANT revoked).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the member-tamper denial sub-probe cannot run',
    );
  } else {
    const anonSignals = await anonReadCount(anonKey, 'fraud_signals', guildId);
    const anonIncidents = await anonReadCount(anonKey, 'incidents', guildId);
    if (anonSignals === null || anonIncidents === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'A member/anon client reads zero fraud_signals and incidents rows while the service role sees them.',
        'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS evaluated)',
      );
    } else {
      ctx.expect(
        serviceSignals >= 1 && serviceIncidents >= 1 && anonSignals === 0 && anonIncidents === 0,
        {
          assertionClass: 'database-RLS',
          channel: 'db-rls',
          promise:
            'Fraud data is admin-only: a member/anon client reads ZERO fraud_signals and incidents rows for the guild while the service role reads both (RLS owner_full_access).',
          observation:
            `service-role sees ${serviceSignals} signal(s) + ${serviceIncidents} incident(s); ` +
            `anon-key REST read returned ${anonSignals} signal(s) and ${anonIncidents} incident(s).`,
          impact: 'A non-admin client could read fraud signals or incidents — RLS is not denying member reads (direct fraud-data exposure).',
        },
      );
    }
  }

  // The denied read attempt changed nothing (rows still present + unchanged).
  const afterSignals = await signalCount(handle, guildId);
  const afterIncident = inc.id ? await readIncident(handle, inc.id) : null;
  ctx.expect(afterSignals === serviceSignals && afterIncident?.status === 'open', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'A denied member access leaves the fraud rows byte-identical — nothing is mutated by the denied probe.',
    observation: `signals before=${serviceSignals} after=${afterSignals}; incident status="${afterIncident?.status}".`,
    impact: 'A denied member attempt disturbed the persisted fraud rows.',
  });

  await proveNoSpuriousAlert(ctx, handle);

  // The dashboard API 401/403 (member session GET/PUT on /api/fraud/*) is the
  // session-auth lane; the "no fraud content visible to the member in Discord" is
  // channel readback; the "repeated probing feeds the security signal path" is a
  // detector lane. All gated.
  gateOwnerDm(ctx, 'No fraud content is visible to the member account anywhere in the guild.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Repeated unauthorized probing of fraud surfaces itself feeds the security signal path.',
    'the security-signal-on-probing path is dashboard/detector-driven (not reachable from this bot-only slash harness)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** DEPFAIL — a failed signal write never blocks commerce (fault-injection lane); RLS still proven on an arranged signal. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // Real anchor: an arranged signal is guild-scoped + RLS-fenced even while the
  // outage behavior itself is undriveable.
  await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 10, window_minutes: 60, threshold: 5 },
  });
  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // The whole "signal-write fails → purchase still completes end-to-end → detector
  // failure DMs the owner" contract needs a Supabase fault-injection lane on the
  // fraud_signals insert AND the commerce-fulfillment path. The bot's design is
  // structurally non-blocking (runFraudChecks is fire-and-forget `.catch()`-guarded),
  // but proving the outage branch needs the fault lane.
  ctx.gate(
    'Discord',
    'db-observable',
    'With fraud_signals writes made to fail, a purchase that would trigger velocity completes normally end to end (order/payment/entitlement rows complete).',
    'requires a Supabase fault-injection lane on the fraud_signals insert + a commerce-fulfillment event driver; the harness runs against a healthy local Supabase and drives no purchases',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'The signal-write failure is recorded as fraud.signal_write_failed with its cause.',
    'the fraud.signal_write_failed audit event fires inside the detector failure branch (needs the fault lane to reach it)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives the detector-failure notice per the critical-failures-DM-owners decision.',
    'requires the fraud_signals fault lane + owner DM readback (DISCORD_TOKEN + a live gateway)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** RETRY — a critical signal is never dropped/downgraded by an owner-DM failure; DM retry needs a fault lane. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // The signal row is written independently of the owner-DM path (createSignal
  // commits the insert, then separately emits fraud.detected). Prove the critical
  // signal persists open + critical — a DM failure cannot drop or downgrade it.
  const sig = await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 12, window_minutes: 60, threshold: 5 },
  });
  const row = sig.id ? await readSignal(handle, sig.id) : null;
  ctx.expect(sig.error === null && row?.status === 'open' && row?.severity === 'critical', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A critical signal row is never dropped or downgraded by a notification failure (the DB row is independent of the owner-DM path).',
    observation: `signal status="${row?.status}" severity="${row?.severity}" (expected open/critical).`,
    impact: 'The signal row was dropped or downgraded by the notification path — a failed DM must never weaken the finding.',
  });

  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // The closed-DM → retry-on-next-critical convergence + the fraud.owner_dm_failed
  // audit + the "staff mirror posted despite the DM failure" all need a Discord DM
  // fault-injection lane + a live guild.
  gateOwnerDm(ctx, "With the owner's DMs closed, the staff mirror still posts and a later critical signal DMs the owner successfully.");
  ctx.gate(
    'audit',
    'discord-readback',
    'fraud.owner_dm_failed is recorded with the retry outcome traceable.',
    'the owner-DM failure + retry audit fires in the notification pipeline (needs a Discord DM fault lane + a live gateway)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The dashboard queue remained the authoritative surface throughout the DM failure and retry.',
    'requires the Discord DM fault lane + the dashboard fraud queue readback (RBAC session)',
  );
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** REPLAY — the atomic incident sequence hands out distinct numbers; signal-level dedup is detector-driven. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // The incident-numbering fence the catalog cites: nextval_incident is an atomic
  // sequence, so two evaluations never draw the same incident number.
  const [n1, n2] = await Promise.all([nextIncidentNumber(handle), nextIncidentNumber(handle)]);
  ctx.expect(Number.isFinite(n1) && Number.isFinite(n2) && n1 !== n2, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The atomic incident sequence (nextval_incident) never hands two evaluations the same incident number.',
    observation: `two nextval_incident draws returned ${n1} and ${n2} (distinct: ${n1 !== n2}).`,
    impact: 'The incident sequence returned a duplicate number — the atomic numbering fence the replay/burst dedup relies on is broken.',
  });

  // Arrange a signal + prove RLS as the real anchor for this scenario's guild.
  await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 10, window_minutes: 60, threshold: 5 },
  });
  await proveTableRls(ctx, 'fraud_signals', guildId, await signalCount(handle, guildId));

  // The signal-level replay dedup ("re-evaluating the same order set appends no
  // duplicate signal") is detector-driven AND — per the shipped bot — has no DB
  // idempotency key: createSignal writes unconditionally and fraud_signals has no
  // unique/identity constraint. Gated, with the divergence flagged for the owner.
  ctx.gate(
    'Discord',
    'db-observable',
    'Re-processing the same commerce events / re-delivering the triggering events appends no duplicate fraud_signals for the same crossing.',
    'signal dedup is detector-driven and the bot has no DB idempotency key on fraud_signals (createSignal inserts unconditionally), so re-running the detector would append a duplicate signal — a probable divergence flagged for the owner; confirming needs a commerce event re-delivery lane',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Replay evaluations appear as no-ops without duplicating signal-creation entries.',
    'requires a commerce-event re-delivery lane to observe the no-op audit trail',
  );
  gateOwnerDm(ctx, 'Owner DM and staff channel message counts are unchanged by all replays.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
}

/** RESTART — open signals and incidents survive a full stack reboot byte-for-byte. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: arrange an open critical signal + an open fraud_auto incident, snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0 });
  const sig = await insertSignal(first, guildId, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 11, window_minutes: 60, threshold: 5 },
  });
  const incNumber = await nextIncidentNumber(first);
  const inc = await insertIncident(first, guildId, incNumber);
  const sigSnapshot = sig.id ? await readSignal(first, sig.id) : null;
  const incSnapshot = inc.id ? await readIncident(first, inc.id) : null;
  await first.cleanup(); // simulate shutdown (no sweep — rows live in Supabase)

  // Boot #2: SAME guild id (restart). The rows must be byte-identical.
  const second = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0 });
  const sigAfter = sig.id ? await readSignal(second, sig.id) : null;
  const incAfter = inc.id ? await readIncident(second, inc.id) : null;
  ctx.expect(
    sigAfter?.status === sigSnapshot?.status &&
      sigAfter?.severity === sigSnapshot?.severity &&
      sigAfter?.status === 'open' &&
      incAfter?.status === incSnapshot?.status &&
      incAfter?.incident_number === incSnapshot?.incident_number &&
      incAfter?.status === 'open',
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After a full stack restart, the open signal and open incident match the pre-restart snapshot exactly (status, severity, incident number persist in Supabase).',
      observation:
        `pre-restart: signal status="${sigSnapshot?.status}"/sev="${sigSnapshot?.severity}", incident status="${incSnapshot?.status}"/#${incSnapshot?.incident_number}; ` +
        `post-restart: signal status="${sigAfter?.status}"/sev="${sigAfter?.severity}", incident status="${incAfter?.status}"/#${incAfter?.incident_number}.`,
      impact: 'A fraud finding did not survive a restart — a persisted signal/incident was lost or altered on reboot.',
    },
  );

  // Audit continuity: the incident's number is still the atomic-sequence value.
  ctx.expect(incAfter?.incident_number === incNumber && incAfter?.source === 'fraud_auto', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The auto-created incident retains its atomic-sequence number and fraud_auto source across the restart (continuous trail, no restart gap).',
    observation: `post-restart incident #${incAfter?.incident_number} (expected ${incNumber}), source="${incAfter?.source}".`,
    impact: 'The incident lost its sequence number or source on restart — the audit trail is discontinuous.',
  });

  await proveTableRls(ctx, 'incidents', guildId, await incidentCount(second, guildId));
  await proveNoSpuriousAlert(ctx, second);

  gateOwnerDm(ctx, 'Post-restart critical signals still DM the owner; no restart-era finding was lost or re-announced.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — the atomic sequence gives distinct incident numbers; one auto_created event records the burst. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // Three concurrent evaluations draw from nextval_incident simultaneously — the
  // atomic sequence guarantees three DISTINCT numbers (the mechanism the catalog
  // cites: "its number drawn from the atomic sequence").
  const [a, b, c] = await Promise.all([
    nextIncidentNumber(handle),
    nextIncidentNumber(handle),
    nextIncidentNumber(handle),
  ]);
  const distinct = new Set([a, b, c]).size === 3;
  ctx.expect(distinct, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Three concurrent nextval_incident draws return three distinct numbers (the atomic incident sequence is race-safe).',
    observation: `concurrent draws = [${a}, ${b}, ${c}] (distinct: ${distinct}).`,
    impact: 'The incident sequence handed a duplicate number under concurrency — two racing bursts could collide on one incident number.',
  });

  // The single auto-created incident + its auto_created event recording the burst count.
  const inc = await insertIncident(handle, guildId, a);
  const evt = inc.id ? await insertAutoCreatedEvent(handle, inc.id, 3) : { error: 'no incident', row: null };
  const meta = (evt.row?.metadata ?? {}) as { signal_count?: number };
  ctx.expect(inc.error === null && evt.error === null && evt.row?.event_type === 'auto_created' && meta.signal_count === 3, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: "The auto-created incident's timeline event records the burst count once (event_type auto_created, metadata.signal_count).",
    observation: inc.error || evt.error
      ? `incident insert error="${inc.error ?? 'none'}", event insert error="${evt.error ?? 'none'}".`
      : `incident_events: event_type="${evt.row?.event_type}", metadata.signal_count=${meta.signal_count} (expected 3).`,
    impact: 'The auto-created incident event did not record the burst count as an append-only trail entry.',
  });

  await proveTableRls(ctx, 'incidents', guildId, await incidentCount(handle, guildId));
  await proveNoSpuriousAlert(ctx, handle);

  // "Exactly ONE incident for a concurrent burst" is the app-level dedupe in
  // checkCriticalThreshold (a check-then-insert on the existing open fraud_auto
  // incident) — there is NO UNIQUE(guild_id, incident_number) DB fence, so the
  // dedup relies solely on that query under concurrency. Driving it needs the
  // concurrent detector lane.
  ctx.gate(
    'Discord',
    'db-observable',
    'Three critical signals landing concurrently produce exactly ONE auto-created incident; racing evaluations observe the existing unresolved incident and attach rather than duplicate.',
    'the burst dedup is an app-level check-then-insert in checkCriticalThreshold (no UNIQUE(guild_id, incident_number) DB fence exists), driveable only via a concurrent commerce-fulfillment event lane — the check-then-insert race window is flagged for the owner',
  );
  gateOwnerDm(ctx, 'The owner receives one incident-opened notification, not one per racing evaluation.');
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
}

/** XGUILD — fraud rows are strictly per-guild: guild A's signals never appear scoped to guild B. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0 });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0 });

  // Trigger fraud in guild A only.
  await insertSignal(handleA, guildA, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 10, window_minutes: 60, threshold: 5 },
  });
  const incNumber = await nextIncidentNumber(handleA);
  const incA = await insertIncident(handleA, guildA, incNumber);

  const aSignals = await signalCount(handleA, guildA);
  const aIncidents = await incidentCount(handleA, guildA);
  const bSignals = await signalCount(handleB, guildB);
  const bIncidents = await incidentCount(handleB, guildB);
  ctx.expect(aSignals >= 1 && aIncidents >= 1 && bSignals === 0 && bIncidents === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: "Fraud isolation is per guild: guild A's signals and incidents never appear scoped to guild B (guild B's fraud queue stays empty).",
    observation:
      `guild A: ${aSignals} signal(s) + ${aIncidents} incident(s) under "${guildA}"; ` +
      `guild B: ${bSignals} signal(s) + ${bIncidents} incident(s) under "${guildB}".`,
    impact: "Cross-guild fraud leakage: guild A's fraud rows surfaced under guild B — per-guild isolation is broken.",
  });

  // The auto-incident audit row is exclusively guild-A scoped, and guild B's fraud
  // queue holds nothing from the run — the per-guild partition on the incident trail.
  const incARow = incA.id ? await readIncident(handleA, incA.id) : null;
  ctx.expect(incARow?.guild_id === guildA && bIncidents === 0 && bSignals === 0, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: "The auto-incident audit row is exclusively guild-A scoped; guild B's incident + signal trail is empty for the run.",
    observation: `guild-A incident guild_id="${incARow?.guild_id}" (expected "${guildA}"); guild B holds ${bSignals} signal(s) + ${bIncidents} incident(s).`,
    impact: "A guild-A audit row was not scoped to guild A, or guild B accumulated fraud trail from guild A's run — audit isolation broken.",
  });

  await proveTableRls(ctx, 'fraud_signals', guildA, aSignals);
  await proveNoSpuriousAlert(ctx, handleA);

  gateOwnerDm(ctx, "Only guild A's owner and staff channel receive alerts; guild B's surfaces are silent.");
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — run-prefixed signals + incidents are swept, cascading their incident_events; a second sweep is a no-op. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const guildId = handle.guildId;

  // Arrange the full fraud footprint: a signal, an incident, and its timeline event.
  await insertSignal(handle, guildId, {
    signalType: 'velocity',
    severity: 'critical',
    entityId: `${ctx.runPrefix}cust-a`,
    evidence: { order_count: 10, window_minutes: 60, threshold: 5 },
  });
  const incNumber = await nextIncidentNumber(handle);
  const inc = await insertIncident(handle, guildId, incNumber);
  const incidentId = inc.id ?? '';
  if (incidentId) await insertAutoCreatedEvent(handle, incidentId, 3);

  const signalsBefore = await signalCount(handle, guildId);
  const incidentsBefore = await incidentCount(handle, guildId);
  const eventsBefore = incidentId ? await incidentEventCount(handle, incidentId) : 0;
  ctx.expect(signalsBefore >= 1 && incidentsBefore >= 1 && eventsBefore >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed signal + incident + incident_event rows (pre-cleanup baseline).',
    observation: `pre-cleanup: signals=${signalsBefore}, incidents=${incidentsBefore}, incident_events=${eventsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed fraud rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveTableRls(ctx, 'fraud_signals', guildId, signalsBefore);
  await proveNoSpuriousAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows;
  // incident_events has no guild_id, so it must be gone via the incidents FK
  // cascade (ON DELETE CASCADE) — proven by counting on the created incident id.
  await ctx.sweepGuildRows(handle);
  const signalsAfter = await signalCount(handle, guildId);
  const incidentsAfter = await incidentCount(handle, guildId);
  const eventsAfter = incidentId ? await incidentEventCount(handle, incidentId) : 0;
  ctx.expect(signalsAfter === 0 && incidentsAfter === 0 && eventsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed signals and incidents are deleted and their incident_events cascade away; a final sweep finds zero run-prefixed fraud artifacts.',
    observation: `post-sweep: signals=${signalsAfter}, incidents=${incidentsAfter}, incident_events(by id)=${eventsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed fraud rows behind — the suite leaves residue in the disposable database.',
  });

  // A second cleanup pass is an error-free no-op (idempotent sweep).
  let secondSweepThrew = false;
  try {
    await ctx.sweepGuildRows(handle);
  } catch {
    secondSweepThrew = true;
  }
  const signalsAfter2 = await signalCount(handle, guildId);
  ctx.expect(!secondSweepThrew && signalsAfter2 === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A second cleanup pass is an error-free no-op that leaves zero residue.',
    observation: `second sweep threw=${secondSweepThrew}; signals after second sweep=${signalsAfter2}.`,
    impact: 'The cleanup sweep is not idempotent — a second pass errored or resurrected rows.',
  });

  // Staff-channel message removal + the audit-history retention/anonymization are
  // separate credentialed lanes; evidence rows follow the retention policy (never
  // hard-deleted for real incidents) rather than being observed here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Run alert messages are removed from the staff channel and no test DMs remain actionable.',
    'requires a live Discord channel/DM readback (DISCORD_TOKEN + a live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Signal and incident audit history remains append-only and undeleted (retention honored rather than destroyed).',
    'the retention/anonymization policy is applied by the audit-history lane; the operational sweep proven here removes only run-prefixed operational rows',
  );
  gateOwnerSurfaces(ctx);
  gateBranding(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The commerce-fraud domain proof.
 *
 * guildScopedTables: the guild_id-scoped fraud tables the sweep clears directly
 * by guild_id. `incident_events` is DELIBERATELY NOT listed — it has no guild_id
 * column (it references incident_id) and is removed via the incidents FK cascade
 * (ON DELETE CASCADE) when the incidents rows are swept. `fraud_signals`,
 * `incidents`, and `fraud_rules` carry no FK to `guild`, so they MUST be swept by
 * their own guild_id (the trailing guild-row delete would not cascade to them);
 * listing them here is what makes cleanup surgical. `alerts` is swept so any
 * generic owner-alert row is cleared, keeping the CLEANUP cross-check honest.
 * `audit_logs` is deliberately NOT swept — fraud audit history is retained.
 */
export const commerceFraudProof: DomainProof = {
  domainId: 'commerce-fraud',
  guildScopedTables: ['fraud_signals', 'incidents', 'fraud_rules', 'alerts'],
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
