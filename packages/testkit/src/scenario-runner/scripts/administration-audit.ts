/**
 * scenario-runner/scripts/administration-audit — the Audit Log domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven through the REAL production stack against LOCAL Supabase. The
 * audit domain has NO member-facing slash command — every action is RECORDED via
 * the platform event bus (AuditService.onAny → batch flush → audit_logs) and
 * READ/EXPORTED through the dashboard. So the DB-observable evidence here is the
 * production audit machinery itself, exercised two ways:
 *
 *   1. LIVE PIPELINE (DEF / REPLAY / RACE): a real platform event is emitted on
 *      the SAME `client.eventBus` the bot uses, the REAL per-guild `AuditService`
 *      maps it (EVENT_TO_AUDIT) and we force its REAL batch `flush()`, then read
 *      the resulting `audit_logs` row back. This proves the real event→audit
 *      MAPPING (action/category/actor_type/actor_id/target_id), the per-guild
 *      event filter, and — where the bot diverges — surfaces FAILs.
 *   2. DB-LAYER CONTRACTS (SET-A / SET-B / INVALID / UNAUTH / RESTART / XGUILD /
 *      CLEANUP): rows are seeded exactly as `AuditService.flush()` inserts them
 *      (same columns, service role) as ARRANGEMENT, then the REAL production DB
 *      contracts are asserted against them: immutability (the BEFORE DELETE
 *      trigger + the `REVOKE UPDATE/DELETE FROM service_role` lockdown), the
 *      sanctioned anonymize-in-place retention scrub (`scrub_expired_audit_logs`),
 *      the `data_retention_days` CHECK floor, guild-scoped RLS, and the
 *      anonymize-over-delete cleanup contract.
 *
 * What is GATED (honest boundary, never faked): the dashboard `/audit` page,
 * `GET /api/audit`, CSV/JSON export + row-limit + `POST /api/retention` 400s +
 * the export/denial/retention-updated owner copy (all dashboard/API surfaces, not
 * reachable from the bot-only harness), the live-guild origination of a real
 * warn/role-change/config edit, the owner alert-channel readback, and the
 * dependency-outage (DEPFAIL) / transient-insert-fault (RETRY) fault lanes.
 *
 * Behavior-bug history (wave-2 fixes, 2026-07-24): three real divergences this
 * proof surfaced are now FIXED in the product and asserted as promises — (a) the
 * AuditService keeps a guild_config before-snapshot (advanced per change) so the
 * `config.updated` diff is two-sided even when the event carries no `before`;
 * (b) the retention scrub floor was lowered 60 → 30 days to match the catalog
 * minimum and guild_config's own CHECK (migration 20260724190000); (c) audit
 * writes are occurrence-deduped (`occurrence_key` + unique index + ON CONFLICT
 * DO NOTHING flush), so a redelivered event or re-flushed batch lands once.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── The audit_logs row shape this proof reads/seeds (the real table columns) ──

interface AuditRow {
  id: string;
  guild_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  category: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  correlation_id: string | null;
  success: boolean | null;
  timestamp: string;
}

const AUDIT_COLS =
  'id, guild_id, actor_type, actor_id, action, category, target_type, target_id, ' +
  'details, before_state, after_state, correlation_id, success, timestamp';

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/**
 * Seed one `audit_logs` row exactly as `AuditService.flush()` inserts it (same
 * columns, via the service role). This is ARRANGEMENT — the REAL production DB
 * contracts (immutability, scrub, RLS) are then asserted against these rows.
 * `ageDays` back-dates `timestamp` so the retention scrub's age window is testable.
 */
async function seedAuditRow(
  handle: LiveClientHandle,
  overrides: Partial<Omit<AuditRow, 'id'>> & { ageDays?: number } = {},
): Promise<AuditRow | null> {
  const { ageDays, ...rest } = overrides;
  const timestamp =
    ageDays != null ? new Date(Date.now() - ageDays * 86_400_000).toISOString() : new Date().toISOString();
  const row: Record<string, unknown> = {
    guild_id: handle.guildId,
    actor_type: 'user',
    actor_id: 'seed-actor',
    action: 'warn.issued',
    category: 'moderation',
    target_type: 'member',
    target_id: 'seed-target',
    details: { seeded: true },
    before_state: null,
    after_state: null,
    correlation_id: null,
    success: true,
    timestamp,
    ...rest,
  };
  const { data } = await handle.supabase.from('audit_logs').insert(row).select(AUDIT_COLS).single();
  return (data as AuditRow | null) ?? null;
}

/** Service-role read of one audit row by id (post-mutation / post-scrub readback). */
async function readAuditById(handle: LiveClientHandle, id: string): Promise<AuditRow | null> {
  const { data } = await handle.supabase.from('audit_logs').select(AUDIT_COLS).eq('id', id).maybeSingle();
  return (data as AuditRow | null) ?? null;
}

/** Service-role read of every audit row for a guild (optionally filtered by action). */
async function readAuditRows(
  handle: LiveClientHandle,
  guildId: string,
  filter?: { action?: string; category?: string; targetId?: string },
): Promise<AuditRow[]> {
  let query = handle.supabase.from('audit_logs').select(AUDIT_COLS).eq('guild_id', guildId);
  if (filter?.action) query = query.eq('action', filter.action);
  if (filter?.category) query = query.eq('category', filter.category);
  if (filter?.targetId) query = query.eq('target_id', filter.targetId);
  const { data } = await query;
  return (data as AuditRow[] | null) ?? [];
}

/** Count audit rows for a guild (immutability/no-delete counts). */
async function auditCount(handle: LiveClientHandle, guildId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);
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

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS owner-only policy → 0), null when inconclusive
 * (→ GATE). PostgREST surfaces a genuine authorization denial as SQLSTATE 42501 /
 * "permission denied" (the deny we want to prove); a rejected key is inconclusive.
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

// ── Live event→audit pipeline access ──────────────────────────────────────

/** Structural view of the per-guild AuditService — only the batch flush we drive. */
interface AuditFlusher {
  flush(): Promise<void>;
}

/**
 * Minimal view of the platform event bus. The bot's compiled `client.d.ts` erases
 * `eventBus` to `unknown`, so we assert this narrow shape to emit a real platform
 * event on the SAME bus the bot uses (the AuditService reads event fields loosely).
 */
interface PlatformBus {
  emit(type: string, guildId: string, data: Record<string, unknown>): void;
}

function eventBusOf(handle: LiveClientHandle): PlatformBus {
  return handle.client.eventBus as PlatformBus;
}

/** The REAL per-guild AuditService the production init wired via ctx.setManager. */
function getAuditService(handle: LiveClientHandle): AuditFlusher | undefined {
  return handle.client.router.getContextSync(handle.guildId)?.getManager<AuditFlusher>('auditService');
}

/**
 * Let the event bus deliver queued entries to the AuditService's onAny listener
 * (dispatched via setImmediate), then force its REAL batch `flush()` so the row
 * lands NOW instead of on the 5s timer. Returns false when the service is absent
 * (→ caller GATEs rather than mis-reads an empty table as a bug).
 */
async function flushAuditQueue(handle: LiveClientHandle): Promise<boolean> {
  const svc = getAuditService(handle);
  if (!svc) return false;
  await new Promise((resolve) => setTimeout(resolve, 20)); // drain onAny listeners
  await svc.flush();
  return true;
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on `audit_logs`: an anon client reads ZERO of the
 * scenario guild's rows while the service role sees the seeded row (a positive
 * control that makes the anon-zero a real deny, not "nothing to read"). The caller
 * MUST have seeded at least one audit row for `guildId` first.
 */
async function proveAnonDenial(ctx: ScenarioContext, handle: LiveClientHandle, guildId: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero audit_logs rows (RLS owner_full_access policy: owner-only, anon denied).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'audit_logs', guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero audit_logs rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceRows = await readAuditRows(handle, guildId);
  ctx.expect(serviceRows.length > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s audit rows while an anon client reads zero of them (RLS owner_full_access on audit_logs).',
    observation:
      `service-role sees ${serviceRows.length} audit row(s) under guild "${guildId}"; ` +
      `an anon-key REST read returned ${anonRows} audit_logs row(s) for that guild.`,
    impact:
      'An audit row visible to the service role was also readable with an anon key — RLS is not denying anon reads (audit trail exposure).',
  });
}

/**
 * Prove `audit_logs` immutability: the BEFORE DELETE trigger and the
 * `REVOKE UPDATE/DELETE FROM service_role` lockdown mean even the highest-privilege
 * application credential (the service role) cannot alter or remove a row — the
 * "never updated or deleted by anyone" promise. Asserts the row is byte-identical
 * and still present after real UPDATE + DELETE attempts.
 */
async function proveImmutable(ctx: ScenarioContext, handle: LiveClientHandle, row: AuditRow): Promise<void> {
  const { error: updErr } = await handle.supabase
    .from('audit_logs')
    .update({ actor_id: 'tampered', action: 'tampered.action' })
    .eq('id', row.id);
  const afterUpd = await readAuditById(handle, row.id);
  const { error: delErr } = await handle.supabase.from('audit_logs').delete().eq('id', row.id);
  const afterDel = await readAuditById(handle, row.id);

  const updateBlocked = afterUpd?.actor_id === row.actor_id && afterUpd?.action === row.action;
  const deleteBlocked = delErr !== null && afterDel !== null && afterDel?.actor_id === row.actor_id;
  ctx.expect(updateBlocked && deleteBlocked, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'audit_logs rows are immutable to the service role: UPDATE and DELETE both fail and the row is byte-identical afterwards (BEFORE DELETE trigger + REVOKE UPDATE/DELETE FROM service_role).',
    observation:
      `after a service-role UPDATE attempt actor_id="${afterUpd?.actor_id}"/action="${afterUpd?.action}" ` +
      `(seed actor_id="${row.actor_id}", updErr=${updErr ? 'yes' : 'no'}); ` +
      `after a service-role DELETE attempt the row is ${afterDel ? 'still present' : 'GONE'} (delErr=${delErr ? 'yes' : 'no'}).`,
    impact:
      'An audit row was altered or deleted through the service role — the tamper-evident, never-updated/deleted contract is broken.',
  });
}

async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's happy path raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'Nominal audit recording/retention/export raises no owner degradation alert (the alerts table stays empty for the guild).',
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false degradation alarm / notification noise.',
  });
}

/**
 * Branding is honestly GATED for every audit scenario: the catalog's branding
 * observer is the "Audit page, export UI, and notification copy" — ALL dashboard
 * surfaces. The audit domain emits NO member-facing bot reply/embed to inspect, so
 * there is nothing captured to check the owner voice / powered-by-SomniBot
 * attribution against here. We never fabricate a brand pass.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The audit page, export UI, and owner-notification copy render in the owner voice with subtle powered-by-SomniBot attribution.',
    'audit has no member-facing bot reply; its surfaces are the dashboard audit page / export UI / owner-notification mirror — matching them needs a dashboard render + brand-kit snapshot readback (not reachable in the bot-only harness)',
  );
}

/** GATE the dashboard/API read+export surfaces this bot-only harness cannot drive. */
function gateDashboard(ctx: ScenarioContext, assertionClass: 'Discord' | 'audit' | 'owner-notification', promise: string): void {
  ctx.gate(
    assertionClass,
    'discord-readback',
    promise,
    'the /audit page, GET /api/audit, the CSV/JSON export + row-limit, and POST /api/retention live in the dashboard/API layer — not reachable from the bot-only harness',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — real actions appear in the audit trail with diffs and correlation, OOTB. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const flushMs = Number(declaredDefault(ctx.domain, 'flush-interval-ms'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const guildId = handle.guildId;
  const targetId = ctx.userId('target');
  const modId = ctx.userId('mod');
  const ownerId = ctx.userId('owner');

  // Drive the REAL event bus the bot uses: a warn (moderation action) and a config
  // edit. The per-guild AuditService maps each (EVENT_TO_AUDIT) and we force its
  // REAL batch flush so the rows land now instead of on the 5s timer.
  eventBusOf(handle).emit('infraction.created', guildId, {
    infractionId: `${ctx.runPrefix}inf-def`,
    userId: targetId,
    moderatorId: modId,
    type: 'warn',
    reason: `${ctx.runPrefix}spam`,
    totalInfractions: 1,
  });
  eventBusOf(handle).emit('config.changed', guildId, {
    section: 'audit',
    changes: { data_retention_days: 30 },
    changedBy: ownerId,
  });
  const flushed = await flushAuditQueue(handle);

  if (!flushed) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'A driven warn and config edit each land their mapped audit_logs row under the run guild.',
      'the per-guild AuditService manager was not resolvable from the booted context, so the live event→audit pipeline could not be flushed deterministically',
    );
    ctx.gate('audit', 'audit-row', 'The config row includes before/after diffs.', 'live pipeline not flushable this run');
  } else {
    const warnRows = await readAuditRows(handle, guildId, { action: 'warn.issued' });
    const cfgRows = await readAuditRows(handle, guildId, { action: 'config.updated' });
    const warn = warnRows[0];
    const cfg = cfgRows[0];

    // database-RLS: both rows exist under the run guild with correct category + actor type.
    ctx.expect(
      warnRows.length === 1 &&
        cfgRows.length === 1 &&
        warn?.category === 'moderation' &&
        warn?.actor_type === 'user' &&
        warn?.actor_id === modId &&
        warn?.target_id === targetId &&
        cfg?.category === 'system' &&
        cfg?.actor_type === 'user' &&
        cfg?.actor_id === ownerId,
      {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise:
          `The driven warn and config edit each land exactly one mapped audit_logs row under the run guild with correct category + actor type, within one flush interval (${flushMs}ms).`,
        observation:
          `warn.issued rows=${warnRows.length} (category=${warn?.category}, actor_type=${warn?.actor_type}, actor=${warn?.actor_id}, target=${warn?.target_id}); ` +
          `config.updated rows=${cfgRows.length} (category=${cfg?.category}, actor_type=${cfg?.actor_type}, actor=${cfg?.actor_id}).`,
        impact: 'A real driven action did not produce its correctly-mapped audit entry — the event→audit recording pipeline is broken.',
      },
    );

    // audit (positive): the config row carries the AFTER side of the diff.
    const afterHasChange = Boolean(cfg && cfg.after_state && typeof cfg.after_state === 'object' && 'data_retention_days' in cfg.after_state);
    ctx.expect(afterHasChange, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The config.updated audit row records the changed values in after_state.',
      observation: `config.updated after_state=${JSON.stringify(cfg?.after_state)}.`,
      impact: 'The config change was recorded without the changed values — the audit trail loses what changed.',
    });

    // audit: the diff is two-sided. When the event carries no `before`, the
    // AuditService fills before_state from its guild_config snapshot (loaded at
    // start, advanced per change) — the "before/after diffs" tamper-evidence.
    ctx.expect(cfg?.before_state != null, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The config.updated audit row includes a before_state snapshot so the diff is two-sided (before AND after).',
      observation: `config.updated before_state=${JSON.stringify(cfg?.before_state)} (expected a non-null prior-value snapshot).`,
      impact:
        'config.changed events carry no before-snapshot (only {section, changes, changedBy}), so every config audit row has before_state=null — the promised before/after diff is one-sided (after only).',
    });

    // replay-safety: each driven action produced exactly one row (dedupe within the flush).
    ctx.expect(warnRows.length === 1 && cfgRows.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Each driven action produced exactly one audit row (no duplicate within a single delivery+flush).',
      observation: `warn.issued rows=${warnRows.length}, config.updated rows=${cfgRows.length} (expected 1 each).`,
      impact: 'A single driven action produced duplicate audit rows.',
    });

    await proveAnonDenial(ctx, handle, guildId);
  }

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'The originating warn/config-edit completes normally in the live Discord guild while being recorded, and the owner can filter by category on /audit.');
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run identifiers are anonymized at teardown while the rows remain.',
    'the anonymize-over-delete teardown contract is exercised end-to-end in the CLEANUP scenario',
  );
}

/** SET-A — a shortened retention window scrubs old personal data while preserving rows. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const retentionDefault = Number(declaredDefault(ctx.domain, 'retention-days'));
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { data_retention_days: 30 } });
  const guildId = handle.guildId;

  // Seed an EXPIRED row (200 days old) carrying real run identifiers.
  const seeded = await seedAuditRow(handle, {
    actor_id: ctx.userId('actor'),
    target_id: ctx.userId('target'),
    action: 'member.role_granted',
    category: 'members',
    details: { role: `${ctx.runPrefix}role` },
    before_state: { hasRole: false },
    after_state: { hasRole: true },
    correlation_id: `${ctx.runPrefix}corr`,
    ageDays: 200,
  });

  const countBefore = await auditCount(handle, guildId);
  // Drive the REAL sanctioned retention scrub at its minimum window (60 days).
  const { error: scrubErr } = await handle.supabase.rpc('scrub_expired_audit_logs', { retention_days: 60 });
  const afterScrub = seeded ? await readAuditById(handle, seeded.id) : null;
  const countAfter = await auditCount(handle, guildId);

  // database-RLS: the expired row is anonymized IN PLACE — identifiers scrubbed,
  // the row (action/category/timestamp) preserved, and the row count unchanged.
  ctx.expect(
    scrubErr === null &&
      afterScrub != null &&
      afterScrub.actor_id === 'anonymized' &&
      afterScrub.target_id === 'anonymized' &&
      afterScrub.before_state === null &&
      afterScrub.after_state === null &&
      afterScrub.correlation_id === null &&
      afterScrub.action === seeded?.action &&
      afterScrub.category === seeded?.category &&
      countAfter === countBefore,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'The retention scrub replaces the expired row’s actor/target identifiers with anonymized tokens and clears payload snapshots, while its action/category/timestamp stay queryable and the row count is unchanged.',
      observation:
        `scrubErr=${scrubErr ? scrubErr.message : 'none'}; post-scrub actor_id=${afterScrub?.actor_id}, target_id=${afterScrub?.target_id}, ` +
        `before_state=${JSON.stringify(afterScrub?.before_state)}, action=${afterScrub?.action} (kept=${afterScrub?.action === seeded?.action}); ` +
        `row count ${countBefore}→${countAfter}.`,
      impact: 'The retention scrub either deleted the row, failed to anonymize identifiers, or lost the historical skeleton.',
    },
  );

  // Discord (FINDING): the catalog SET-A window (30 days — also the guild_config
  // data_retention_days minimum) CANNOT take effect — scrub_expired_audit_logs
  // rejects any window under 60 days, so a 30-day retention preference scrubs nothing.
  const { error: floorErr } = await handle.supabase.rpc('scrub_expired_audit_logs', {
    retention_days: retentionDefault < 60 ? retentionDefault : 30,
  });
  ctx.expect(floorErr === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The retention window the owner configures (down to the catalog/guild_config 30-day minimum) is honored by the retention scrub.',
    observation:
      `calling scrub_expired_audit_logs(30) — the SET-A retention window and guild_config's minimum — returned error: ${floorErr ? floorErr.message : 'none'}.`,
    impact:
      'scrub_expired_audit_logs enforces a hard 60-day floor, so a 30-day retention window (the catalog minimum and guild_config’s own CHECK floor) can never scrub any row — the shortened-retention promise is unmet, and the nightly cron scrubs at a fixed 90 days ignoring per-guild data_retention_days entirely.',
  });

  // replay-safety: running the scrub again changes nothing (actor_id='anonymized' guard).
  await handle.supabase.rpc('scrub_expired_audit_logs', { retention_days: 60 });
  const afterSecond = seeded ? await readAuditById(handle, seeded.id) : null;
  const countSecond = await auditCount(handle, guildId);
  ctx.expect(
    afterSecond != null && afterSecond.actor_id === 'anonymized' && countSecond === countAfter,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Running the retention scrub again changes nothing further (idempotent: already-anonymized rows are skipped).',
      observation: `after a second scrub: actor_id=${afterSecond?.actor_id}, row count ${countAfter}→${countSecond}.`,
      impact: 'A repeat retention scrub re-processed or altered already-anonymized rows — the scrub is not idempotent.',
    },
  );

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboard(ctx, 'audit', 'The scrub run is itself recorded as an audit event with the anonymized-row count.');
  gateDashboard(ctx, 'owner-notification', 'The retention-updated owner mirror was delivered when data_retention_days changed.');
  ctx.gate(
    'cleanup',
    'db-observable',
    'Seeded rows follow the anonymize-over-delete contract at teardown.',
    'exercised end-to-end in the CLEANUP scenario (audit_logs is never swept — it is anonymized in place)',
  );
}

/** SET-B — a filtered (category + guild) audit query returns exactly the matching slice. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const exportLimit = Number(declaredDefault(ctx.domain, 'export-row-limit'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const guildId = handle.guildId;

  // Seed a mixed trail: 3 moderation rows + 2 system rows under the run guild.
  for (let i = 0; i < 3; i++) {
    await seedAuditRow(handle, { action: 'warn.issued', category: 'moderation', actor_id: ctx.userId('mod'), target_id: `${ctx.runPrefix}m${i}` });
  }
  for (let i = 0; i < 2; i++) {
    await seedAuditRow(handle, { action: 'config.updated', category: 'system', actor_id: ctx.userId('owner') });
  }

  // database-RLS: the export's guild+category filter returns EXACTLY the matching
  // slice — the same guild-scoped, category-filtered SELECT the export runs.
  const modSlice = await readAuditRows(handle, guildId, { category: 'moderation' });
  const sysSlice = await readAuditRows(handle, guildId, { category: 'system' });
  const total = await auditCount(handle, guildId);
  ctx.expect(
    modSlice.length === 3 &&
      modSlice.every((r) => r.category === 'moderation' && r.guild_id === guildId) &&
      sysSlice.length === 2 &&
      sysSlice.every((r) => r.category === 'system'),
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        `A category-filtered, guild-scoped audit query returns exactly the matching rows (the export slice), capped at the export row limit (${exportLimit}).`,
      observation:
        `category=moderation returned ${modSlice.length} rows (all moderation+run-guild=${modSlice.every((r) => r.category === 'moderation' && r.guild_id === guildId)}); ` +
        `category=system returned ${sysSlice.length} rows; total run-guild rows=${total}.`,
      impact: 'The filtered audit slice returned the wrong rows — an export/filter would leak or omit rows.',
    },
  );

  // replay-safety: re-running the same filtered read returns identical content and
  // writes nothing (a SELECT-only export mutates no state).
  const modAgain = await readAuditRows(handle, guildId, { category: 'moderation' });
  const totalAfter = await auditCount(handle, guildId);
  ctx.expect(modAgain.length === modSlice.length && totalAfter === total, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-running the export query returns identical content and writes nothing (row count unchanged).',
    observation: `second filtered read=${modAgain.length} rows (first=${modSlice.length}); total ${total}→${totalAfter}.`,
    impact: 'Re-running an export changed the audit trail — export is not read-only/idempotent.',
  });

  await proveAnonDenial(ctx, handle, guildId);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'The CSV/JSON export renders columns for actor/action/target/timestamp, truncates at the export row limit with a clear indicator, and produces no Discord-side effect.');
  gateDashboard(ctx, 'audit', 'The export action itself is recorded with the requesting owner’s id.');
  ctx.gate(
    'cleanup',
    'db-observable',
    'Downloaded export artifacts are removed from the run workspace at teardown.',
    'no export artifact/workspace file exists in the bot-only DB harness (the export is a dashboard download)',
  );
}

/** INVALID — an invalid retention value is rejected atomically (DB CHECK floor). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { data_retention_days: 180 } });
  const guildId = handle.guildId;

  const readRetention = async (): Promise<number | null> => {
    const { data } = await handle.supabase
      .from('guild_config')
      .select('data_retention_days')
      .eq('guild_id', guildId)
      .maybeSingle();
    return (data as { data_retention_days: number } | null)?.data_retention_days ?? null;
  };
  const before = await readRetention();

  // database-RLS: a below-floor retention (7 < 30) is rejected atomically by the
  // guild_config chk_retention_min CHECK; the stored value is unchanged.
  const { error: lowErr } = await handle.supabase
    .from('guild_config')
    .update({ data_retention_days: 7 })
    .eq('guild_id', guildId);
  const afterLow = await readRetention();
  ctx.expect(lowErr !== null && afterLow === before && before === 180, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Setting data_retention_days below the 30-day minimum is rejected atomically (guild_config chk_retention_min CHECK) and the stored value is unchanged.',
    observation: `update to 7 → error=${lowErr ? lowErr.message : 'none'}; data_retention_days ${before}→${afterLow} (expected unchanged at 180).`,
    impact: 'A below-minimum retention value persisted — invalid config was accepted, weakening the retention floor.',
  });

  // replay-safety: repeating the invalid update keeps failing with zero writes.
  const { error: lowErr2 } = await handle.supabase
    .from('guild_config')
    .update({ data_retention_days: 10 })
    .eq('guild_id', guildId);
  const afterLow2 = await readRetention();
  ctx.expect(lowErr2 !== null && afterLow2 === 180, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated invalid retention updates keep failing with zero writes.',
    observation: `second below-floor update → error=${lowErr2 ? 'yes' : 'no'}; data_retention_days=${afterLow2} (expected 180).`,
    impact: 'A repeated invalid retention update eventually persisted.',
  });

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  // The 5000-day (above-max) case has NO DB upper bound (chk_retention_min only
  // floors at 30), so the max (3650) and the 400 response are dashboard/Zod-only.
  gateDashboard(ctx, 'Discord', 'POST /api/retention returns 400 for 7 (below min) and 5000 (above the 3650 max); guild_config has no upper-bound CHECK so the max is enforced only in the dashboard Zod layer.');
  gateDashboard(ctx, 'audit', 'The rejected retention attempts are recorded without a config.updated row.');
  ctx.gate('cleanup', 'db-observable', 'Nothing changed, so teardown verifies zero residue.', 'no rows were written by the rejected updates');
}

/** UNAUTH — audit data is invisible without the view permission, and immutable to everyone. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const guildId = handle.guildId;

  // Seed a row that carries real identity (also the RLS + immutability subject).
  const seeded = await seedAuditRow(handle, {
    actor_id: ctx.userId('mod'),
    target_id: ctx.userId('target'),
    action: 'ban.executed',
    category: 'moderation',
  });
  ctx.expect(seeded !== null, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Test arrangement: a real audit row exists to attempt mutation against.',
    observation: `seeded audit row id=${seeded?.id ?? '(none)'}.`,
    impact: 'Could not arrange the audit row — the immutability proof setup is invalid.',
  });

  // database-RLS: even the service role (the highest-privilege app credential)
  // cannot UPDATE or DELETE the row — "immutable to everyone" — and anon reads zero.
  if (seeded) {
    await proveImmutable(ctx, handle, seeded);
    // replay-safety: repeated mutation attempts keep failing with zero effect.
    await handle.supabase.from('audit_logs').update({ success: false }).eq('id', seeded.id);
    const { error: delErr2 } = await handle.supabase.from('audit_logs').delete().eq('id', seeded.id);
    const still = await readAuditById(handle, seeded.id);
    ctx.expect(delErr2 !== null && still !== null && still.success === seeded.success, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Repeated UPDATE/DELETE attempts against an audit row keep failing with zero effect.',
      observation: `second delete error=${delErr2 ? 'yes' : 'no'}; row still present=${still !== null}, success unchanged=${still?.success === seeded.success}.`,
      impact: 'A repeated mutation attempt eventually altered or removed an audit row.',
    });
  }
  await proveAnonDenial(ctx, handle, guildId);

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'A member without dashboard.view_audit gets 403 from GET /api/audit and the audit page is hidden / direct navigation denied.');
  gateDashboard(ctx, 'audit', 'The denied read and the blocked mutation attempts are themselves recorded as audit events.');
  gateDashboard(ctx, 'owner-notification', 'The blocked mutation attempt raises an owner notification.');
  ctx.gate('cleanup', 'db-observable', 'No residue exists; teardown verifies unchanged rows.', 'exercised in CLEANUP (audit rows are anonymized, never deleted)');
}

/** DEPFAIL — a database outage buffers audit entries without dropping any. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The harness's whole premise is a REACHABLE local Supabase, so a database
  // outage cannot be induced without a fault-injection lane. The AuditService
  // buffers in-memory and re-queues the batch on flush error (max 500), but that
  // branch is only reachable when the insert fails. GATE honestly.
  ctx.gate(
    'Discord',
    'db-observable',
    'With audit batch inserts failing, entries are retained in the durable buffer with zero drops and flushed in order once connectivity returns; guild activity continues normally.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Post-recovery the audit row count equals the driven action count with no gaps.',
    'requires the outage fault lane to force the buffered-degraded → recording transition',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'audit.flush_failed is recorded once connectivity returns.',
    'requires the outage fault lane to reach the flush-failure branch',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one buffering notice (audit-write-degraded) reaches the owner for the outage window.',
    'requires the outage fault lane plus the owner alert-channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation banner uses the audit-write-degraded template with {guild-name} and {queued-count}.',
    'requires the outage fault lane to reach the degradation branch (a dashboard/owner surface)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Retried flushes never insert an entry twice across the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Outage simulation state is fully reverted at teardown.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a transient insert failure on one flush converges to exactly-once delivery. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The re-queue/convergence branch fires only when a flush's batch INSERT fails
  // transiently — a fault that requires injection at the audit_logs insert boundary.
  // The batch insert is atomic (all-or-nothing), so the whole batch re-queues, but
  // that path is not reachable against a healthy local DB. GATE honestly.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a transient insert failure injected on one flush, the re-queued batch lands on a subsequent flush with no user-visible disruption.',
    'requires a transient-insert-fault lane at the audit_logs batch-insert boundary',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Entry count matches driven events exactly after convergence.',
    'requires the transient-insert-fault lane',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The converged trail shows no duplicate or missing entries and preserves in-batch ordering.',
    'requires the transient-insert-fault lane; NOTE: occurrence-keyed entries are now idempotent per entry (occurrence_key + ON CONFLICT DO NOTHING), so a re-flush after a post-commit error cannot duplicate them — keyless entries still rely on the batch INSERT being atomic',
  );
  ctx.gate(
    'owner-notification',
    'db-observable',
    'No owner alert fires for a single self-recovered flush.',
    'requires the transient-insert-fault lane to reach the self-recovery path',
  );
  ctx.gate('branding', 'discord-readback', 'The converged dashboard audit view renders normally.', 'requires the transient-insert-fault lane (a dashboard surface)');
  ctx.gate('replay-safety', 'db-observable', 'Re-queue plus flush is idempotent per entry.', 'requires the transient-insert-fault lane');
  ctx.gate('cleanup', 'db-observable', 'Run entries follow the anonymize-over-delete contract at teardown.', 'exercised in CLEANUP');
}

/** REPLAY — a redelivered platform event. Surfaces a REAL finding: no occurrence dedupe. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const guildId = handle.guildId;
  const targetId = ctx.userId('target');
  const modId = ctx.userId('mod');

  // Redeliver the SAME event occurrence twice through the real event bus, then flush.
  const occurrence = {
    infractionId: `${ctx.runPrefix}occ-replay`,
    userId: targetId,
    moderatorId: modId,
    type: 'warn' as const,
    reason: `${ctx.runPrefix}replay`,
    totalInfractions: 1,
  };
  eventBusOf(handle).emit('infraction.created', guildId, occurrence);
  eventBusOf(handle).emit('infraction.created', guildId, occurrence); // redelivery
  const flushed = await flushAuditQueue(handle);

  if (!flushed) {
    ctx.gate(
      'replay-safety',
      'db-observable',
      'A redelivered event occurrence yields exactly one audit row, not two.',
      'the per-guild AuditService manager was not resolvable from the booted context, so the replay could not be driven+flushed',
    );
  } else {
    const rows = await readAuditRows(handle, guildId, { action: 'warn.issued', targetId });
    // Occurrence dedupe: the AuditService keys the row on the infractionId
    // occurrence (in-queue dedupe + uq_audit_logs_guild_occurrence ON CONFLICT
    // DO NOTHING), so the redelivered event lands exactly one row.
    ctx.expect(rows.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Redelivering the same event occurrence through the event bus produces exactly one audit row for that occurrence (occurrence-level dedupe on audit writes).',
      observation: `after TWO deliveries of one infraction.created occurrence: warn.issued rows for the target = ${rows.length} (exactly-once expects 1).`,
      impact:
        'The AuditService has no occurrence/idempotency key and audit_logs has no uniqueness constraint, so a redelivered platform event writes a DUPLICATE audit row — occurrence-level dedupe is missing.',
    });
    ctx.expect(rows.length === 1, {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Exactly one audit row exists for the redelivered occurrence.',
      observation: `warn.issued rows for the target under the run guild = ${rows.length} (expected 1).`,
      impact: 'A redelivered occurrence produced more than one audit row — the trail over-counts the event.',
    });
    await proveAnonDenial(ctx, handle, guildId);
  }

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'The underlying action’s Discord effect exists exactly once, and the audit view shows a single clean entry.');
  ctx.gate('cleanup', 'db-observable', 'Run entries follow the anonymize-over-delete contract at teardown.', 'exercised in CLEANUP');
}

/** RESTART — buffered entries survive shutdown and history survives restart. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const seededActions = ['warn.issued', 'mute.applied', 'config.updated'] as const;

  // Boot #1: record history (seed rows exactly as flush() writes), snapshot, shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await seedAuditRow(first, { actor_id: ctx.userId('mod'), target_id: ctx.userId('t1'), action: 'warn.issued', category: 'moderation' });
  await seedAuditRow(first, { actor_id: ctx.userId('mod'), target_id: ctx.userId('t2'), action: 'mute.applied', category: 'moderation' });
  await seedAuditRow(first, { actor_id: ctx.userId('owner'), action: 'config.updated', category: 'system', after_state: { changed: true } });

  // Drain the REAL AuditService queue BEFORE snapshotting: the production init
  // logs a `bot.started` lifecycle row on EVERY boot (guild-init →
  // auditService.log), and shutdown's catalog-promised final flush lands that
  // row asynchronously AFTER cleanup() returns. Snapshotting without draining
  // made the boot-time entry surface post-restart as a phantom "duplicate"
  // (the earlier exact-count-3 assertions failed against CORRECT product
  // behavior). Forcing the real flush here makes boot #1's own entries part
  // of the snapshot deterministically; boot #2's are drained symmetrically
  // below so "new events append normally" is observed, not raced.
  const drainedFirst = await flushAuditQueue(first);
  const snapshotIds = (await readAuditRows(first, guildId)).map((r) => r.id).sort();
  const snapCount = snapshotIds.length;
  await first.cleanup(); // simulate shutdown (rows persist in Supabase)

  // Boot #2: SAME guild id (restart). Audit history lives in Supabase → intact.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const drainedSecond = await flushAuditQueue(second);

  if (!drainedFirst || !drainedSecond) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'After a full stack restart the complete audit history is intact — no rows lost or duplicated across the restart boundary.',
      'a per-guild AuditService manager was not resolvable from a booted context, so the boot-time queues could not be drained deterministically around the restart',
    );
    ctx.gate('audit', 'audit-row', 'Pre- and post-restart entries form one continuous, ordered history.', 'audit queues not drainable this run');
    ctx.gate('replay-safety', 'db-observable', 'The final flush is not repeated on startup.', 'audit queues not drainable this run');
  } else {
    const afterRows = await readAuditRows(second, guildId);
    const afterIds = afterRows.map((r) => r.id).sort();
    const survivors = snapshotIds.filter((id) => afterIds.includes(id));
    const newRows = afterRows.filter((r) => !snapshotIds.includes(r.id));
    // Any post-restart row repeating a pre-restart action would be a re-flush
    // of already-persisted history; legitimate new rows are boot #2's own
    // lifecycle events (bot.started) only.
    const reflushedHistory = newRows.filter((r) => (seededActions as readonly string[]).includes(r.action));
    const seededCounts = seededActions.map(
      (action) => afterRows.filter((r) => r.action === action).length,
    );
    const botStartedRows = afterRows.filter((r) => r.action === 'bot.started').length;

    // database-RLS: no rows lost or duplicated across the restart boundary.
    ctx.expect(
      survivors.length === snapCount &&
        snapCount >= 4 && // 3 seeded + boot #1's flushed bot.started
        reflushedHistory.length === 0 &&
        seededCounts.every((n) => n === 1),
      {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise:
          'After a full stack restart the complete audit history is intact — every pre-restart row survives, none is re-written, and the only additions are the restart’s own lifecycle entries.',
        observation:
          `pre-restart rows=${snapCount}, surviving post-restart=${survivors.length}; ` +
          `new rows repeating pre-restart actions=${reflushedHistory.length}; ` +
          `seeded actions [${seededActions.join(', ')}] appear ${JSON.stringify(seededCounts)} time(s) (expected 1 each).`,
        impact: 'Audit history did not survive the restart — persisted rows were lost, duplicated, or altered.',
      },
    );

    // audit: pre- and post-restart entries form one continuous, ordered history.
    const ordered = await second.supabase
      .from('audit_logs')
      .select(AUDIT_COLS)
      .eq('guild_id', guildId)
      .order('timestamp', { ascending: true });
    const orderedRows = (ordered.data as AuditRow[] | null) ?? [];
    const orderedIds = orderedRows.map((r) => r.id);
    const historyContinuous =
      orderedRows.length === afterIds.length && snapshotIds.every((id) => orderedIds.includes(id));
    ctx.expect(historyContinuous && orderedRows.filter((r) => (seededActions as readonly string[]).includes(r.action)).length === 3, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Pre- and post-restart entries form one continuous, queryable, ordered history.',
      observation:
        `ordered post-restart read=${orderedRows.length} rows containing all ${snapCount} pre-restart rows=${historyContinuous}; ` +
        `seeded rows present=${orderedRows.filter((r) => (seededActions as readonly string[]).includes(r.action)).length} (expected 3).`,
      impact: 'The audit history was not continuous/ordered after the restart.',
    });

    // replay-safety: the final flush is not repeated on startup. Each boot
    // records exactly ONE bot.started lifecycle row — a re-flushed shutdown
    // batch would surface as a third bot.started or a repeated seeded action.
    ctx.expect(botStartedRows === 2 && reflushedHistory.length === 0, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'The final flush is not repeated on startup — restart adds no duplicate audit rows (exactly one bot.started per boot, no re-flushed history).',
      observation: `bot.started rows across both boots=${botStartedRows} (expected 2); re-flushed pre-restart actions=${reflushedHistory.length} (expected 0).`,
      impact: 'The restart re-flushed already-persisted entries, duplicating audit rows.',
    });
  }

  await proveAnonDenial(ctx, second, guildId);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'An action driven just before shutdown appears in the trail after restart via the AuditService final flush.');
  ctx.gate('cleanup', 'db-observable', 'Run entries follow the anonymize-over-delete contract at teardown.', 'exercised in CLEANUP');
}

/** RACE — concurrent multi-guild activity records exactly one row per event in the right guild. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });
  const targetA = ctx.userId('ta');
  const targetB = ctx.userId('tb');
  const modId = ctx.userId('mod');

  // Emit one event in EACH guild on the SHARED singleton bus concurrently. Each
  // per-guild AuditService's onAny filters `event.guildId !== this.guildId`, so the
  // shared bus must NOT cross-write. Then flush both and count each guild's rows.
  eventBusOf(handleA).emit('infraction.created', guildA, {
    infractionId: `${ctx.runPrefix}race-a`, userId: targetA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}a`, totalInfractions: 1,
  });
  eventBusOf(handleB).emit('infraction.created', guildB, {
    infractionId: `${ctx.runPrefix}race-b`, userId: targetB, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}b`, totalInfractions: 1,
  });
  const [flushedA, flushedB] = await Promise.all([flushAuditQueue(handleA), flushAuditQueue(handleB)]);

  if (!flushedA || !flushedB) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'Each guild’s audit trail records exactly its own event and no cross-guild rows.',
      'a per-guild AuditService manager was not resolvable from a booted context, so the concurrent multi-guild drive could not be flushed',
    );
  } else {
    const aRows = await readAuditRows(handleA, guildA, { action: 'warn.issued' });
    const bRows = await readAuditRows(handleB, guildB, { action: 'warn.issued' });
    const aHasOwn = aRows.some((r) => r.target_id === targetA);
    const aHasForeign = aRows.some((r) => r.target_id === targetB);
    const bHasOwn = bRows.some((r) => r.target_id === targetB);
    const bHasForeign = bRows.some((r) => r.target_id === targetA);

    // database-RLS: each guild's count equals its own event count; no cross-guild rows.
    ctx.expect(aRows.length === 1 && bRows.length === 1 && aHasOwn && bHasOwn && !aHasForeign && !bHasForeign, {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'Simultaneous events in guild A and guild B each produce exactly one audit row in their OWN guild’s trail — the per-guild event filter prevents any cross-write from the shared process-level bus.',
      observation:
        `guild A warn.issued rows=${aRows.length} (own target present=${aHasOwn}, foreign=${aHasForeign}); ` +
        `guild B warn.issued rows=${bRows.length} (own target present=${bHasOwn}, foreign=${bHasForeign}).`,
      impact: 'The shared event bus cross-wrote or duplicated audit rows across guilds — the per-guild filter (the N² dedup fix) failed.',
    });

    // replay-safety / audit: no duplicated rows despite the shared bus.
    ctx.expect(aRows.length === 1 && bRows.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Concurrency does not defeat occurrence-level uniqueness — one row per driven event in the correct guild.',
      observation: `guild A rows=${aRows.length}, guild B rows=${bRows.length} (expected 1 each).`,
      impact: 'Concurrent multi-guild recording produced duplicate audit rows.',
    });
    ctx.expect(!aHasForeign && !bHasForeign, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'No duplicated/foreign rows exist despite the shared process-level bus.',
      observation: `guild A foreign target present=${aHasForeign}; guild B foreign target present=${bHasForeign} (expected false).`,
      impact: 'A guild’s audit trail contained the other guild’s event — cross-guild audit leakage.',
    });
    await proveAnonDenial(ctx, handleA, guildA);
  }

  await proveNoOwnerAlert(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'Both guilds’ actions complete normally and concurrently in the live guilds.');
  ctx.gate('cleanup', 'db-observable', 'Both guilds’ run entries follow the anonymize-over-delete contract at teardown.', 'exercised in CLEANUP');
}

/** XGUILD — audit trails are strictly guild-scoped in reads and exports. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // Guild A accrues three rows; guild B accrues one — distinct real rows.
  await seedAuditRow(handleA, { action: 'warn.issued', category: 'moderation', actor_id: ctx.userId('modA'), target_id: `${ctx.runPrefix}xa1` });
  await seedAuditRow(handleA, { action: 'ban.executed', category: 'moderation', actor_id: ctx.userId('modA'), target_id: `${ctx.runPrefix}xa2` });
  await seedAuditRow(handleA, { action: 'config.updated', category: 'system', actor_id: ctx.userId('ownerA') });
  await seedAuditRow(handleB, { action: 'warn.issued', category: 'moderation', actor_id: ctx.userId('modB'), target_id: `${ctx.runPrefix}xb1` });

  // database-RLS: a guild-scoped query returns ZERO foreign rows (both directions).
  const aScoped = await readAuditRows(handleA, guildA);
  const bScoped = await readAuditRows(handleB, guildB);
  const aForeign = aScoped.filter((r) => r.guild_id === guildB).length;
  const bForeign = bScoped.filter((r) => r.guild_id === guildA).length;
  ctx.expect(
    aScoped.length === 3 && bScoped.length === 1 && aForeign === 0 && bForeign === 0 &&
      aScoped.every((r) => r.guild_id === guildA) && bScoped.every((r) => r.guild_id === guildB),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Guild-scoped audit queries return zero foreign rows: guild A’s scope holds only its 3 rows, guild B’s only its 1 — distinct rows under distinct guild_ids.',
      observation:
        `guild-A-scoped read=${aScoped.length} rows (foreign=${aForeign}); guild-B-scoped read=${bScoped.length} rows (foreign=${bForeign}).`,
      impact: 'A guild-scoped audit read returned another guild’s rows — cross-guild audit leakage in reads/exports.',
    },
  );

  // replay-safety: repeated cross-scoped reads leak nothing.
  const aScopedAgain = await readAuditRows(handleA, guildA);
  ctx.expect(aScopedAgain.filter((r) => r.guild_id === guildB).length === 0 && aScopedAgain.length === 3, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated cross-read attempts leak nothing — guild A’s scope never surfaces guild B’s rows.',
    observation: `second guild-A-scoped read=${aScopedAgain.length} rows, foreign=${aScopedAgain.filter((r) => r.guild_id === guildB).length}.`,
    impact: 'A repeated guild-scoped read eventually leaked a foreign guild’s audit rows.',
  });

  await proveAnonDenial(ctx, handleA, guildA);
  await proveNoOwnerAlert(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB);
  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'A cross-guild dashboard session sees only its active guild’s entries; switching the guild header cannot read another guild’s trail.');
  gateDashboard(ctx, 'audit', 'The cross-read attempts are themselves recorded under the requesting guild.');
  ctx.gate('cleanup', 'db-observable', 'Both guilds verified independently at teardown.', 'exercised in CLEANUP');
}

/** CLEANUP — teardown honors anonymize-over-delete: identifiers scrubbed, rows kept. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const guildId = handle.guildId;

  // Seed run-prefixed audit rows, one EXPIRED so the anonymize pass has a target.
  const expired = await seedAuditRow(handle, {
    actor_id: ctx.userId('actor'),
    target_id: ctx.userId('target'),
    action: 'member.role_removed',
    category: 'members',
    before_state: { hasRole: true },
    after_state: { hasRole: false },
    correlation_id: `${ctx.runPrefix}corr`,
    ageDays: 200,
  });
  await seedAuditRow(handle, { action: 'warn.issued', category: 'moderation', actor_id: ctx.userId('actor'), target_id: ctx.userId('target') });
  const countBefore = await auditCount(handle, guildId);

  // Prove immutability while the rows exist (the sweep cannot delete them).
  if (expired) await proveImmutable(ctx, handle, expired);
  await proveAnonDenial(ctx, handle, guildId);
  await proveNoOwnerAlert(ctx, handle);

  // The anonymize pass: scrub the expired row in place (identifiers → tokens).
  await handle.supabase.rpc('scrub_expired_audit_logs', { retention_days: 60 });
  const scrubbed = expired ? await readAuditById(handle, expired.id) : null;

  // replay-safety: running the anonymization pass twice changes nothing further.
  await handle.supabase.rpc('scrub_expired_audit_logs', { retention_days: 60 });
  const scrubbedTwice = expired ? await readAuditById(handle, expired.id) : null;
  ctx.expect(
    scrubbed?.actor_id === 'anonymized' &&
      scrubbedTwice?.actor_id === 'anonymized' &&
      scrubbedTwice?.timestamp === scrubbed?.timestamp,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Running the anonymization pass twice changes nothing further (idempotent).',
      observation: `after 1st scrub actor_id=${scrubbed?.actor_id}; after 2nd scrub actor_id=${scrubbedTwice?.actor_id}, timestamp stable=${scrubbedTwice?.timestamp === scrubbed?.timestamp}.`,
      impact: 'A second anonymization pass altered already-anonymized rows.',
    },
  );

  // database-RLS: the anonymized row carries no run identity (identifiers are tokens).
  ctx.expect(
    scrubbed != null &&
      scrubbed.actor_id === 'anonymized' &&
      scrubbed.target_id === 'anonymized' &&
      !JSON.stringify(scrubbed.details ?? {}).includes(ctx.runPrefix) &&
      scrubbed.before_state === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After the anonymization pass the row’s identifiers are anonymized tokens and no surface references the run identity, while the row remains.',
      observation: `post-scrub actor_id=${scrubbed?.actor_id}, target_id=${scrubbed?.target_id}, details=${JSON.stringify(scrubbed?.details)}, before_state=${JSON.stringify(scrubbed?.before_state)}.`,
      impact: 'Run identifiers survived the anonymization pass — the anonymize-over-delete contract leaks identity.',
    },
  );

  // cleanup: the sweep DELETES zero audit rows (anonymize-over-delete) while
  // removing the non-audit run resource (guild_config). This is the sweep report
  // distinguishing deleted resources from anonymized-in-place audit rows.
  const { data: cfgBefore } = await handle.supabase.from('guild_config').select('guild_id').eq('guild_id', guildId).maybeSingle();
  await ctx.sweepGuildRows(handle);
  const countAfterSweep = await auditCount(handle, guildId);
  const { data: cfgAfter } = await handle.supabase.from('guild_config').select('guild_id').eq('guild_id', guildId).maybeSingle();
  ctx.expect(countAfterSweep === countBefore && countBefore >= 2 && cfgBefore != null && cfgAfter == null, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Teardown deletes ZERO audit rows (they are anonymized in place) while removing the non-audit run resources (guild_config) — the sweep distinguishes deleted resources from anonymized-in-place audit rows.',
    observation:
      `audit row count ${countBefore} → ${countAfterSweep} (unchanged=${countAfterSweep === countBefore}); ` +
      `guild_config present before=${cfgBefore != null}, after sweep=${cfgAfter != null} (expected removed).`,
    impact: 'The teardown either deleted audit rows (violating anonymize-over-delete) or failed to remove the non-audit run resources.',
  });

  gateBranding(ctx);
  gateDashboard(ctx, 'Discord', 'No Discord residue from audited run actions remains after teardown.');
  gateDashboard(ctx, 'audit', 'The anonymization pass is itself recorded as an audit event.');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Audit Log domain proof. `guildScopedTables` deliberately EXCLUDES audit_logs:
 * audit rows are NEVER deleted (BEFORE DELETE trigger + service_role lockdown) —
 * they are anonymized in place — so sweeping them would both violate the contract
 * and (since the delete is rejected) falsely fail the runner's teardown cleanup
 * check. Only the domain's deletable owner-notification surface (`alerts`) is swept;
 * `guild_config` + `guild` are always swept by the runner in addition.
 */
export const administrationAuditProof: DomainProof = {
  domainId: 'administration-audit',
  guildScopedTables: ['alerts'],
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
