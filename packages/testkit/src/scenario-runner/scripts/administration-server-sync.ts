/**
 * scenario-runner/scripts/administration-server-sync — the Server-sync domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack proofs
 * driven against LOCAL Supabase. Like administration-automations, this domain is
 * DELIBERATELY different in shape from the wallet-rewards template: the sync ENGINE
 * (packages/bot/src/sync/sync-engine.ts) runs a periodic cycle (and live role/channel
 * events) against a REAL Discord guild — it snapshots live roles/channels, diffs them
 * against `guild_desired_state`, writes drift + `drift.detected`/`sync.completed`/
 * `sync.failed` audit rows, mirrors a debounced alert to the owner channel, and (when
 * auto-repair is on) re-applies desired state via Discord REST. Every drift accept /
 * repair / ignore and every sync-config change lives on the dashboard (`/api/sync`,
 * `/api/sync/action`, `/api/sync/config`) behind a manage_server session. The domain
 * exposes NO slash command (see catalog INTENT-DELTAS: "administration domains have no
 * Discord slash-command surfaces"), so the bot-only, gateway-less, slash-only harness
 * can neither emit external drift nor observe detection/repair. This is a MOSTLY-GATED
 * domain, and that is the correct, honest boundary — mostlyGated = true.
 *
 * What DOES run now, against real state:
 *   - The `guild_config` sync columns the scheduler reloads each cycle
 *     (`sync_enabled`, `sync_interval_minutes`, `sync_auto_repair`,
 *     `sync_auto_repair_everyone`): a fresh guild's shipped defaults, and distinct
 *     per-guild saved values (SET-A / SET-B) in the exact columns runSyncCycle reads.
 *   - Guild-scoped RLS on `guild_config` and `guild_desired_state` (anon-denial with a
 *     service-role positive control; owner_full_access policy + no anon GRANT after the
 *     RLS-pattern-sweep lockdown) — the data-layer backstop that "drift details are
 *     never exposed to unprivileged sessions" (UNAUTH).
 *   - The single-row-per-guild desired-state store (PK guild_id): re-storing a cycle's
 *     drift overwrites rather than appends (REPLAY), and two concurrent terminal writes
 *     settle to exactly one row with one winner (RACE) — the DB backbone of "one
 *     terminal resolution, never a flip-flop".
 *   - Cross-guild isolation of `guild_desired_state` + `guild_config` (XGUILD), desired
 *     state surviving a full restart (RESTART), and the cleanup sweep (drift/id-map rows
 *     deleted, `audit_logs` retained per the anonymize-over-delete contract).
 *
 * The proof follows the current hardening contract: sync intervals are accepted only in
 * the 5–1440 minute range at both the dashboard validation layer and the database CHECK
 * boundary. A direct service-role write outside that range must be rejected and leave the
 * prior configuration byte-identical.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

/** The exact `guild_config` sync columns `startSyncScheduler`'s cycle reloads. */
interface SyncConfigRow {
  sync_enabled: boolean;
  sync_interval_minutes: number;
  sync_auto_repair: boolean;
  sync_auto_repair_everyone: boolean;
}

interface DesiredStateRow {
  guild_id: string;
  drift_detected: boolean;
  drift_details: unknown;
  roles: unknown[];
  channels: unknown[];
}

/** Options for seeding a `guild_desired_state` row the SAME way the sync engine's
 *  step-8 store (`.update({ drift_detected, drift_details })`) and the deploy path
 *  write it (roles/channels JSONB + drift columns). */
interface SeedDesiredStateOptions {
  roles?: Record<string, unknown>[];
  channels?: Record<string, unknown>[];
  driftDetected?: boolean;
  driftDetails?: Record<string, unknown>[] | null;
}

// ── Long GATE reasons (the honest boundary this domain sits behind) ────────

const REASON_ENGINE =
  'the sync engine (packages/bot/src/sync/sync-engine.ts) runs its periodic cycle / live-event path against a REAL Discord guild — snapshotting live roles/channels, diffing them against guild_desired_state, and applying repairs via Discord REST; this domain exposes NO slash command, and the bot-only local-Supabase harness boots a gateway-less guild with empty caches, so it cannot make external changes, detect drift, or observe/apply a repair (needs DISCORD_TOKEN + a live guild + a second bot/admin to drive external edits)';
const REASON_DASHBOARD =
  'drift accept/repair/ignore and sync-config changes are driven by the dashboard API (/api/sync, /api/sync/action, /api/sync/config) behind a dashboard.manage_server session; the bot-only harness has no dashboard session and cannot drive those routes';
const REASON_FAULT =
  'requires a fault-injection lane (the drifted role moved above the bot’s highest role, or an injected transient Discord 500 during repair) plus a live guild — this harness runs against a reachable stack with no fault seam and no gateway';
const REASON_BRANDING =
  'this domain emits NO slash-command reply — every member-facing surface (the dashboard Sync page and the owner-notification mirror copy) is rendered outside the bot dispatcher, so verifying owner voice + subtle powered-by-SomniBot attribution needs a Sync-page / notification snapshot (DISCORD_TOKEN + live guild / dashboard render)';
const REASON_AUDIT =
  'drift.detected / sync.started / sync.completed / sync.failed audit rows (with per-cycle counts + correlation ids) are written by the sync engine as it processes a real cycle/repair; with no live guild to run a cycle here, no bot-driven sync-category audit row is produced (the DB-observable config/RLS/isolation/cleanup invariants are proven instead)';
const REASON_OWNER_MIRROR =
  'the drift/repair owner mirror is delivered by the engine to the owner notification channel on a real cycle/repair outcome — requires DISCORD_TOKEN + a live guild (a positive owner-alert branch, so "no alert" is deliberately NOT asserted here)';

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readSyncConfig(handle: LiveClientHandle): Promise<SyncConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as SyncConfigRow | null) ?? null;
}

async function guildConfigCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('guild_config')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Seed a desired-state row through the SAME table/columns the engine's store and the
 *  deploy/accept path write. Returns any error message (null on success). */
async function seedDesiredState(
  handle: LiveClientHandle,
  opts: SeedDesiredStateOptions = {},
): Promise<string | null> {
  const { error } = await handle.supabase.from('guild_desired_state').upsert(
    {
      guild_id: handle.guildId,
      roles: opts.roles ?? [],
      channels: opts.channels ?? [],
      drift_detected: opts.driftDetected ?? false,
      drift_details: opts.driftDetails ?? null,
    },
    { onConflict: 'guild_id' },
  );
  return error?.message ?? null;
}

async function readDesiredState(
  handle: LiveClientHandle,
  guildId: string = handle.guildId,
): Promise<DesiredStateRow | null> {
  const { data } = await handle.supabase
    .from('guild_desired_state')
    .select('guild_id, drift_detected, drift_details, roles, channels')
    .eq('guild_id', guildId)
    .maybeSingle();
  return (data as DesiredStateRow | null) ?? null;
}

async function desiredStateCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('guild_desired_state')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Seed a `discord_id_map` entry the SAME way the deploy/repair recreate path upserts. */
async function seedIdMap(
  handle: LiveClientHandle,
  entityType: 'role' | 'channel' | 'category',
  key: string,
  discordId: string,
): Promise<string | null> {
  const { error } = await handle.supabase.from('discord_id_map').upsert(
    { guild_id: handle.guildId, entity_type: entityType, template_key: key, discord_id: discordId },
    { onConflict: 'guild_id,entity_type,template_key' },
  );
  return error?.message ?? null;
}

async function idMapCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('discord_id_map')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Count of drift items recorded on the single desired-state row (drift_details is a
 *  JSONB array the engine overwrites each cycle). */
function driftItemCount(row: DesiredStateRow | null): number {
  return Array.isArray(row?.drift_details) ? (row!.drift_details as unknown[]).length : 0;
}

/** The `state` marker of the first drift item (used by RACE to read the winner). */
function firstDriftState(row: DesiredStateRow | null): string | undefined {
  if (!Array.isArray(row?.drift_details)) return undefined;
  const first = (row!.drift_details as Array<{ state?: unknown }>)[0];
  return typeof first?.state === 'string' ? first.state : undefined;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself errors,
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
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS / a missing GRANT →
 * 0), or null when no anon key / URL is available (→ GATE).
 */
async function anonReadCount(
  anonKey: string,
  table: string,
  guildId: string,
): Promise<number | null> {
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (the anon role is blocked from
    // the table by RLS / a missing GRANT — the deny we want to prove) from the key
    // itself being rejected before authz ran (inconclusive → GATE).
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // anon role denied the table — RLS / GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on a sync table: the service role reads `serviceRowsSeen` rows
 * for THIS guild while an anon client reads zero. Made non-vacuous by the positive
 * control — the caller has already created rows under the guild (serviceRowsSeen > 0),
 * so an anon read of ZERO is a real deny, not "nothing to read." GATEs (never fakes)
 * when no anon key is exported or the probe is inconclusive.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: 'guild_config' | 'guild_desired_state',
  serviceRowsSeen: number,
): Promise<void> {
  const label = table === 'guild_config' ? 'sync configuration' : 'drift / desired-state';
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero \`${table}\` rows (owner_full_access RLS; no anon GRANT — the ${label} data-layer backstop).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero \`${table}\` rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceRowsSeen > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      `The service role reads this guild’s \`${table}\` row while an anon (session-less) client reads zero of them (owner_full_access RLS / no anon GRANT) — the ${label} never leaks to an unprivileged session.`,
    observation:
      `service-role sees ${serviceRowsSeen} \`${table}\` row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} \`${table}\` row(s) for that guild.`,
    impact:
      `A \`${table}\` row visible to the service role was also readable with an anon key — RLS is not denying anon reads, so ${label} is exposed to non-members.`,
  });
}

/** Assert zero owner alerts — the CONTRACTED behavior for scenarios whose catalog
 *  owner-notification is negative ("no alert fires for …"). Never a soft pass: the
 *  promise text is the exact catalog contract for this scenario. */
async function proveNoOwnerAlert(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  promise: string,
): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      promise,
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise,
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised where the catalog contracts none — notification noise / a false alarm.',
  });
}

/** GATE the branding class (no slash reply; Sync page + notification copy). */
function gateBrandingCopy(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Drift/repair copy renders in the owner voice with subtle powered-by-SomniBot attribution on the Sync page and the owner-notification mirror.',
    REASON_BRANDING,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — default behavior detects external drift without repairing silently.
 * The engine-driven detection is gated; what runs NOW is the shipped default config the
 * engine reloads each cycle — and TWO of those defaults diverge from the catalog
 * contract (surfaced as FAIL findings, never softened).
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  const wantAutoRepair = declaredDefault(ctx.domain, 'auto-repair') === true; // false
  const wantAutoRepairEveryone = declaredDefault(ctx.domain, 'auto-repair-everyone') === true; // false
  const wantInterval = Number(declaredDefault(ctx.domain, 'sync-interval-minutes')); // 60

  const cfg = await readSyncConfig(handle);

  // 1) Out of the box there is NO desired-state / drift row (the catalog initial state
  //    is "in-sync" — the engine idles until a template is deployed).
  const driftRows = await desiredStateCount(handle);
  ctx.expect(driftRows === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Out of the box a fresh guild has no desired-state / drift row — the catalog initial state is "in-sync".',
    observation: `fresh-guild guild_desired_state rows = ${driftRows} (expected 0).`,
    impact: 'A brand-new guild shipped with a pre-existing drift/desired-state row — the unconfigured "in-sync" initial state was violated.',
  });

  // 2) The "detect-and-report first, never repair silently" default: auto-repair OFF.
  ctx.expect(cfg?.sync_auto_repair === wantAutoRepair, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With defaults active, auto-repair is OFF — drift is surfaced for a per-item decision, nothing is repaired silently (catalog default auto-repair = false).',
    observation: `guild_config.sync_auto_repair = ${cfg?.sync_auto_repair} (catalog default ${wantAutoRepair}).`,
    impact: 'Auto-repair shipped ON by default — external changes would be reverted with no owner review, breaking the member-respectful detect-first contract.',
  });

  // 3) FINDING — the @everyone guard default is INVERTED. The catalog contracts
  //    auto-repair-everyone = false ("@everyone permission changes affect every member,
  //    so silent automatic reversion requires explicit opt-in"), but the schema column
  //    defaults to true and guild-init falls back to `?? true`.
  ctx.expect(cfg?.sync_auto_repair_everyone === wantAutoRepairEveryone, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The @everyone guard ships OFF by default: auto-repair may NOT touch @everyone permissions unless explicitly enabled (catalog default auto-repair-everyone = false).',
    observation: `guild_config.sync_auto_repair_everyone = ${cfg?.sync_auto_repair_everyone} (catalog default ${wantAutoRepairEveryone}); schema DEFAULT is true and guild-init falls back to \`?? true\`.`,
    impact: 'The @everyone auto-repair guard defaults ON (schema DEFAULT true + guild-init `?? true`), contradicting the catalog’s member-safety contract. With auto-repair also enabled, SomniBot would silently reset @everyone permissions — a guild-wide change affecting every member — without the owner opting in.',
  });

  // 4) FINDING — the periodic-cycle cadence default diverges. Catalog contracts 60 min;
  //    the schema/code default is 15 (guild-init falls back to `?? 15`).
  ctx.expect(cfg?.sync_interval_minutes === wantInterval, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Periodic sync cycles run on the contracted default cadence (catalog default sync-interval-minutes = ${wantInterval}).`,
    observation: `guild_config.sync_interval_minutes = ${cfg?.sync_interval_minutes} (catalog default ${wantInterval}); schema DEFAULT is 15 and guild-init falls back to \`?? 15\`.`,
    impact: `A fresh guild runs its periodic sync every 15 minutes (schema DEFAULT + guild-init \`?? 15\`), not the contracted ${wantInterval} — a divergence to reconcile (correct the column default or the catalog default).`,
  });

  // The sync-configuration row is guild-scoped and anon-denied (data-layer backstop).
  await proveRlsIsolation(ctx, handle, 'guild_config', await guildConfigCount(handle));

  // Detection itself, the drift.detected audit row, the one debounced owner alert, the
  // Sync-page copy, and "repeated cycles don't duplicate the item" are engine-driven.
  ctx.gate(
    'Discord',
    'discord-readback',
    'An external rename of a managed run-prefixed role and an external move of its hierarchy position each produce drift items on the Sync page; nothing is auto-repaired.',
    REASON_ENGINE,
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Drift details in guild_desired_state list both the rename and the hierarchy drift.',
    REASON_ENGINE,
  );
  ctx.gate('audit', 'audit-row', 'drift.detected rows record the drift count and critical count.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'Exactly one debounced drift alert reaches the owner.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated cycles do not duplicate the same drift item.',
    'the single-row-per-guild overwrite backbone of this is proven in REPLAY; observing repeated live cycles needs the engine + a live guild',
  );
}

/**
 * SET-A — enabling auto-repair reverts external changes hands-free.
 * The revert is engine-driven (gated); what runs NOW is that auto-repair is a distinct,
 * per-guild, engine-loaded config: the scheduler loads true for the enabled guild and
 * false for a default guild (two REAL rows, not an echo of one input).
 */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const enabled = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { sync_auto_repair: true } });
  const plain = await ctx.bootGuild({ label: 'b' });

  const enabledCfg = await readSyncConfig(enabled);
  const plainCfg = await readSyncConfig(plain);
  ctx.expect(
    enabledCfg?.sync_auto_repair === true && plainCfg?.sync_auto_repair === false,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Auto-repair is a distinct per-guild config the scheduler loads each cycle: the enabled guild reads sync_auto_repair=true, a default guild reads false (so the enabled guild would revert external changes hands-free).',
      observation:
        `enabled-guild sync_auto_repair=${enabledCfg?.sync_auto_repair}, ` +
        `default-guild sync_auto_repair=${plainCfg?.sync_auto_repair} (populated & distinct in the exact column runSyncCycle reads).`,
      impact:
        'A saved auto-repair setting did not persist distinctly in the sync_auto_repair column the engine loads — the hands-free revert would silently never engage.',
    },
  );

  await proveRlsIsolation(ctx, enabled, 'guild_config', await guildConfigCount(enabled));

  // The hands-free revert itself + its completion audit/owner-mirror are engine-driven.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The external role rename is reverted to the desired name by the next detection without any dashboard click.',
    REASON_ENGINE,
  );
  ctx.gate('database-RLS', 'db-observable', 'The drift item is closed as repaired; desired state is unchanged.', REASON_ENGINE);
  ctx.gate('audit', 'audit-row', 'sync.completed records itemsRepaired of one for the cycle.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'The repair-complete mirror reaches the owner once.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'Subsequent cycles find nothing to repair — no oscillation.', REASON_ENGINE);
}

/**
 * SET-B — accepting drift updates the design (interval set to 5 proves distinct config).
 * The accept transition is dashboard-driven (gated); what runs NOW is that
 * sync-interval-minutes is a distinct, per-guild, engine-loaded config value.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const fast = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { sync_interval_minutes: 5 } });
  const plain = await ctx.bootGuild({ label: 'b' });

  const fastCfg = await readSyncConfig(fast);
  const plainCfg = await readSyncConfig(plain);
  ctx.expect(
    fastCfg?.sync_interval_minutes === 5 &&
      typeof plainCfg?.sync_interval_minutes === 'number' &&
      fastCfg?.sync_interval_minutes !== plainCfg?.sync_interval_minutes,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The sync interval is a distinct per-guild config the scheduler reloads each cycle: the fast guild reads a 5-minute interval, distinct from a default guild — proving the interval is real per-guild config, not a global constant.',
      observation:
        `fast-guild sync_interval_minutes=${fastCfg?.sync_interval_minutes} (saved 5), ` +
        `default-guild sync_interval_minutes=${plainCfg?.sync_interval_minutes} (distinct).`,
      impact:
        'A saved sync interval did not persist distinctly in the sync_interval_minutes column the scheduler reloads — the configured cadence would silently never take effect.',
    },
  );

  await proveRlsIsolation(ctx, fast, 'guild_config', await guildConfigCount(fast));

  // The accept path (desired state adopts the live value; drift closes as accepted; the
  // next 5-minute cycle reports in-sync) is driven by /api/sync/action + the engine.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The owner accepts an external channel-topic drift item; the live channel keeps its externally set topic (nothing reverts).',
    REASON_DASHBOARD,
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'guild_desired_state stores the accepted value; the drift item is closed as accepted (accept-drift transition).',
    REASON_DASHBOARD,
  );
  ctx.gate('audit', 'audit-row', 'sync.completed records itemsAccepted of one.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'The completion mirror reports the accepted count.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'The next 5-minute cycle reports no drift for the accepted entity.', REASON_ENGINE);
}

/**
 * INVALID — invalid sync configuration is rejected without partial application.
 * The dashboard's 400 response remains gated in this bot-only lane, but the underlying
 * defense-in-depth boundary runs now: guild_config rejects an out-of-range interval and
 * preserves the previously valid scheduler configuration.
 */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { sync_interval_minutes: 30, sync_auto_repair: true },
  });

  // A valid baseline persists in the exact columns the scheduler reloads.
  const baseline = await readSyncConfig(handle);
  ctx.expect(baseline?.sync_interval_minutes === 30 && baseline?.sync_auto_repair === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A valid sync configuration persists byte-for-byte in the guild_config sync columns (a rejected invalid save must leave these untouched).',
    observation: `guild_config holds sync_interval_minutes=${baseline?.sync_interval_minutes} (expected 30), sync_auto_repair=${baseline?.sync_auto_repair} (expected true).`,
    impact: 'A valid sync configuration was not retained in the columns the engine reloads.',
  });

  // The database mirrors the dashboard's 5..1440 contract. This is intentionally a
  // direct service-role write so the proof cannot pass merely because Zod rejected it.
  const { error: outOfRangeErr } = await handle.supabase
    .from('guild_config')
    .update({ sync_interval_minutes: 2000 })
    .eq('guild_id', handle.guildId);
  const afterRejectedUpdate = await readSyncConfig(handle);
  ctx.expect(
    outOfRangeErr !== null &&
      afterRejectedUpdate?.sync_interval_minutes === baseline?.sync_interval_minutes &&
      afterRejectedUpdate?.sync_auto_repair === baseline?.sync_auto_repair,
    {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Sync-config validity is enforced at the database boundary: an interval outside 5–1440 is rejected atomically and the prior valid scheduler configuration remains unchanged.',
    observation:
      `direct sync_interval_minutes=2000 update rejected=${outOfRangeErr !== null} ` +
      `(error: ${outOfRangeErr?.message ?? 'NONE — invalid value persisted'}); ` +
      `after rejection interval=${afterRejectedUpdate?.sync_interval_minutes}, auto-repair=${afterRejectedUpdate?.sync_auto_repair} ` +
      `(expected ${baseline?.sync_interval_minutes}/${baseline?.sync_auto_repair}).`,
    impact:
      'An invalid scheduler interval crossed the database boundary or partially changed the saved configuration, allowing non-dashboard writers to create unsafe timer state.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'guild_config', await guildConfigCount(handle));
  await proveNoOwnerAlert(ctx, handle, 'No owner alert fires for a validation rejection.');

  // The actual 400 with the offending field named, and "no partial write", belong to
  // the dashboard PUT /api/sync/config. (Catalog INTENT-DELTA: /api/sync/config clamps
  // out-of-range intervals while /api/sync update_config Zod-rejects — a code
  // inconsistency the contract resolves to reject-with-400-and-no-partial-write.)
  ctx.gate(
    'Discord',
    'discord-readback',
    'PUT sync config with interval 0, interval 2000, or a non-boolean auto-repair returns 400 naming the offending field; guild_config is byte-identical before and after and the engine keeps its previous schedule.',
    `${REASON_DASHBOARD}; note the catalog INTENT-DELTA that /api/sync/config currently clamps out-of-range intervals while /api/sync update_config Zod-rejects`,
  );
  ctx.gate('audit', 'audit-row', 'The rejected attempts are recorded without config.updated rows.', REASON_AUDIT);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'Repeated invalid updates keep failing with zero writes.', REASON_DASHBOARD);
}

/**
 * UNAUTH — sync management is denied without the server-management privilege.
 * The HTTP 401/403 lives in the dashboard session-auth lane (gated); the DB-observable
 * backstop is that an anon (session-less) client cannot read a single guild_desired_state
 * OR guild_config row (owner_full_access RLS + no anon GRANT) — no drift detail leaks.
 */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Real drift + config that MUST NOT leak to a non-manager. The dashboard 403 is one
  // layer; the DB-observable backstop is the anon-denial for BOTH tables.
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });

  await proveRlsIsolation(ctx, handle, 'guild_desired_state', await desiredStateCount(handle));
  await proveRlsIsolation(ctx, handle, 'guild_config', await guildConfigCount(handle));
  await proveNoOwnerAlert(ctx, handle, 'No owner alert fires for a routine permission denial.');

  // The route/API 401/403 gating on dashboard.manage_server, and the logged denial with
  // the member's id, are dashboard session-auth surfaces.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A member without sync management access receives 401/403 from GET, POST /api/sync and PUT /api/sync/config; the Sync page is hidden and no drift details leak in any denied response.',
    `${REASON_DASHBOARD} (the DB-layer anon-denial backstop for drift + config is proven above)`,
  );
  ctx.gate('audit', 'audit-row', 'Denied attempts are logged with the member’s id.', REASON_AUDIT);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'Repeated denied calls write nothing.', REASON_DASHBOARD);
}

/**
 * DEPFAIL — repairs fail safe when Discord rejects them (hierarchy).
 * The whole scenario is a repair FAILURE branch requiring the drifted role above the
 * bot's highest role + a live guild — no fault seam / gateway here. GATE every behavior
 * honestly (never fabricate the failure); the seeded drift row keeps the RLS proof
 * non-vacuous, and the catalog owner-notification here is POSITIVE (repair-failed
 * mirror) so "no alert" is deliberately NOT asserted.
 */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'HIERARCHY_DRIFT', state: 'open' }],
  });

  await proveRlsIsolation(ctx, handle, 'guild_desired_state', await desiredStateCount(handle));

  ctx.gate(
    'Discord',
    'discord-readback',
    'With the drifted role moved above the bot’s highest role, clicking repair fails cleanly: the error names the hierarchy cause, the item stays open, no other entity is modified, and after the order is fixed the same repair succeeds.',
    REASON_FAULT,
  );
  ctx.gate('database-RLS', 'db-observable', 'The drift item remains open with the recorded error until the successful retry.', REASON_FAULT);
  ctx.gate('audit', 'audit-row', 'sync.failed and the eventual sync.completed are both recorded.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'The repair-failed mirror reaches the owner once.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'The failed repair applied nothing, so the retry is a clean first application.', REASON_FAULT);
}

/**
 * RETRY — transient Discord errors during repair converge to one applied fix.
 * The injected-transient-500 retry needs a mid-repair Discord fault lane + a live guild
 * (gated). The seeded drift keeps RLS non-vacuous; the catalog owner-notification here is
 * NEGATIVE ("no alert for a self-recovering transient failure") → asserted as PASS.
 */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });

  await proveRlsIsolation(ctx, handle, 'guild_desired_state', await desiredStateCount(handle));
  await proveNoOwnerAlert(ctx, handle, 'No owner alert fires for a self-recovering transient repair failure.');

  ctx.gate(
    'Discord',
    'discord-readback',
    'A repair that receives an injected transient Discord 500 is retried and converges: the entity matches the desired state exactly once, with no double-application (e.g. no duplicate permission overwrites).',
    REASON_FAULT,
  );
  ctx.gate('database-RLS', 'db-observable', 'The drift item closes exactly once after the converged retry.', REASON_FAULT);
  ctx.gate('audit', 'audit-row', 'The transient failure and the converged repair are recorded distinctly.', REASON_AUDIT);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'The retried repair is idempotent on the final entity state.', REASON_FAULT);
}

/**
 * REPLAY — replaying a repair request is a no-op.
 * The repair-POST-twice no-op is dashboard-driven (gated). What runs NOW is the
 * single-row-per-guild store backbone: guild_desired_state is keyed on guild_id, so
 * re-storing a cycle's drift OVERWRITES rather than appends — a redelivered store cannot
 * duplicate the drift row.
 */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Store the same drift twice (a re-delivered cycle store). The PK guild_id keeps it to
  // ONE row; the second store overwrites the first.
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  const rows = await desiredStateCount(handle);
  const row = await readDesiredState(handle);
  ctx.expect(rows === 1 && driftItemCount(row) === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'The desired-state store is a single row per guild (PK guild_id): re-storing a cycle’s drift overwrites rather than appends, so a redelivered store cannot duplicate the drift item.',
    observation: `after two identical desired-state stores: guild_desired_state rows=${rows} (expected 1), drift items on the row=${driftItemCount(row)} (expected 1).`,
    impact: 'Re-storing the same cycle’s drift created a second desired-state row or duplicated the drift item — the store is not idempotent on redelivery.',
  });

  await proveRlsIsolation(ctx, handle, 'guild_desired_state', rows);

  // The observable "second repair POST reports already-resolved and modifies nothing"
  // needs the dashboard action route + the engine.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Sending the same repair POST twice applies the correction once; the second request reports the item already resolved and modifies nothing in Discord.',
    REASON_DASHBOARD,
  );
  ctx.gate('database-RLS', 'db-observable', 'The drift item has exactly one resolution record.', REASON_DASHBOARD);
  ctx.gate('audit', 'audit-row', 'One repair is audited; the replay is visible as a no-op.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'No duplicate completion mirror is sent.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
}

/**
 * RESTART — desired state and open drift survive restarts.
 * A REAL persistence proof: seed desired state + an open drift item, tear the whole
 * stack down (router + client), reboot the SAME guild id, and read the row back
 * identical — it lives in Supabase, so it survives.
 */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: seed desired state + an open drift item, snapshot, shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await seedDesiredState(first, {
    roles: [{ key: `${ctx.runPrefix}mod`, name: 'Moderator' }],
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}mod`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  const snapshot = await readDesiredState(first, guildId);
  await first.cleanup(); // simulate a full stack shutdown

  // Boot #2: SAME guild id (restart). The desired-state row lives in Supabase.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readDesiredState(second, guildId);
  ctx.expect(
    afterRestart !== null &&
      snapshot !== null &&
      afterRestart.drift_detected === true &&
      driftItemCount(afterRestart) === driftItemCount(snapshot) &&
      driftItemCount(afterRestart) === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the saved desired state and the open drift item are intact (they live in Supabase, not memory).',
      observation:
        `pre-restart drift_detected=${snapshot?.drift_detected}/items=${driftItemCount(snapshot)}; ` +
        `post-restart drift_detected=${afterRestart?.drift_detected}/items=${driftItemCount(afterRestart)} (expected true/1).`,
      impact: 'Desired state or open drift did not survive a restart — the scheduler would resume from a lost/altered state.',
    },
  );

  await proveRlsIsolation(ctx, second, 'guild_desired_state', await desiredStateCount(second));
  // Catalog owner-notification here is NEGATIVE ("no duplicate drift alert for
  // already-known items") → assert zero alerts across the restart.
  await proveNoOwnerAlert(ctx, second, 'No duplicate drift alert fires for already-known items after a restart.');

  // "The scheduler resumes on its interval and the next cycle reaches the same
  // conclusions" needs the engine + a live guild.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The scheduler resumes on its configured interval and the next cycle reaches the same conclusions as before the restart, re-opening nothing already resolved.',
    REASON_ENGINE,
  );
  ctx.gate('audit', 'audit-row', 'No spurious drift or repair events are logged around the restart.', REASON_AUDIT);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'The post-restart cycle does not re-open resolved items.', REASON_ENGINE);
}

/**
 * RACE — concurrent repair and accept settle in a single terminal state.
 * A REAL DB concurrency proof: two concurrent terminal writes to the single-row-per-guild
 * desired-state store settle to exactly ONE row with ONE winner (never both, never a
 * duplicate). The Discord entity outcome (reverted vs adopted) is engine-driven (gated).
 */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // An open drift item, then repair + accept fired CONCURRENTLY as the two terminal
  // stores the dashboard action route would apply.
  await seedDesiredState(handle, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  const repair = seedDesiredState(handle, {
    driftDetected: false,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'repaired' }],
  });
  const accept = seedDesiredState(handle, {
    driftDetected: false,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'accepted' }],
  });
  await Promise.all([repair, accept]);

  const rows = await desiredStateCount(handle);
  const row = await readDesiredState(handle);
  const winner = firstDriftState(row);
  ctx.expect(rows === 1 && (winner === 'repaired' || winner === 'accepted') && row?.drift_detected === false, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Concurrent repair and accept on one drift item settle to exactly ONE terminal resolution: the single desired-state row (PK guild_id) holds one winner (repaired OR accepted), never both and never a duplicate row.',
    observation:
      `after concurrent repair+accept stores: guild_desired_state rows=${rows} (expected 1), ` +
      `terminal drift state="${winner ?? '(none)'}" (expected repaired|accepted), drift_detected=${row?.drift_detected} (expected false).`,
    impact:
      'Concurrent terminal writes produced two rows or an incoherent/merged state — the desired-state store did not settle to a single terminal resolution.',
  });

  await proveRlsIsolation(ctx, handle, 'guild_desired_state', rows);

  // Which action wins on the actual Discord entity (reverted vs live-value adopted), and
  // the single outcome mirror, are engine + owner-channel effects.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The entity ends in exactly one coherent state matching the winning action: either reverted (repair won) or the desired state adopts the live value (accept won) — never both, never a flip-flop.',
    REASON_ENGINE,
  );
  ctx.gate('audit', 'audit-row', 'Both attempts are logged; exactly one records an applied change.', REASON_AUDIT);
  ctx.gate('owner-notification', 'discord-readback', 'At most one outcome mirror is delivered.', REASON_OWNER_MIRROR);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-observable', 'Re-driving either action after the race changes nothing.', REASON_DASHBOARD);
}

/**
 * XGUILD — drift and repairs never cross guild boundaries.
 * Two guilds, each with a DISTINCT seeded desired-state row: each guild scope reads its
 * OWN row and never the other's (distinct rows under distinct guild_ids), and cross-guild
 * config is independent. Only guild B's absence-of-alert is asserted; guild A's positive
 * drift alert is engine-driven (gated).
 */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  await seedDesiredState(handleA, {
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}A-role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  await seedDesiredState(handleB, {
    driftDetected: false,
    driftDetails: null,
  });

  const rowA = await readDesiredState(handleA, guildA);
  const rowB = await readDesiredState(handleB, guildB);
  // Leak probe: the store is ONE row keyed on guild_id, and the engine's scoping
  // IS the `.eq('guild_id', <own guild>)` filter every sync read applies —
  // handle.supabase is the SAME unscoped service-role client for both handles,
  // so there is no ambient per-guild scope beyond that filter. The probe
  // therefore reads EVERYTHING the guild-B scope returns and asserts it is
  // exactly guild B's one clean row and zero rows of any other guild. (A probe
  // that filters on guild A's key "via handle B" just reads guild A's row with
  // the service role — null is impossible by construction, indicting the probe.)
  const { data: bScopedData } = await handleB.supabase
    .from('guild_desired_state')
    .select('guild_id, drift_detected')
    .eq('guild_id', guildB);
  const bScopedRows = (bScopedData ?? []) as Array<{ guild_id: string; drift_detected: boolean }>;
  const leakedRows = bScopedRows.filter((r) => r.guild_id !== guildB).length;
  ctx.expect(
    rowA?.guild_id === guildA &&
      rowB?.guild_id === guildB &&
      rowA?.drift_detected === true &&
      rowB?.drift_detected === false &&
      bScopedRows.length === 1 &&
      leakedRows === 0,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN desired-state row and never the other’s: guild A → its drifting row, guild B → its clean row (distinct rows under distinct guild_ids); the guild-B-scoped read returns exactly guild B’s row and zero rows of any other guild.',
      observation:
        `guild A row drift_detected=${rowA?.drift_detected} under "${rowA?.guild_id}", ` +
        `guild B row drift_detected=${rowB?.drift_detected} under "${rowB?.guild_id}"; ` +
        `the guild-B-scoped read returned ${bScopedRows.length} row(s), ${leakedRows} of them belonging to another guild (expected 1 / 0).`,
      impact: 'A guild-scoped desired-state read returned another guild’s row — the per-guild scoping that prevents cross-guild drift/repair is broken.',
    },
  );

  // Cross-guild sync CONFIG is independent too (each guild has its own guild_config row).
  const cfgA = await readSyncConfig(handleA);
  const cfgB = await readSyncConfig(handleB);
  ctx.expect(cfgA !== null && cfgB !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Each guild has its own sync configuration row — guild A’s drift/repair reads only guild A’s config.',
    observation: `guild A guild_config present=${cfgA !== null}, guild B guild_config present=${cfgB !== null} (independent rows).`,
    impact: 'A guild was missing its own sync configuration row — cross-guild config independence broken.',
  });

  await proveRlsIsolation(ctx, handleA, 'guild_desired_state', await desiredStateCount(handleA));
  // Negative half of the cross-guild alert contract: guild B's owner is NOT alerted for
  // guild A's drift (the positive "guild A's owner IS alerted" half is engine-gated).
  await proveNoOwnerAlert(ctx, handleB, 'Guild B’s owner is not alerted about guild A’s drift.');

  ctx.gate(
    'Discord',
    'discord-readback',
    'Repairing guild A’s drift touches zero entities in guild B; only guild A’s owner is alerted about guild A’s drift.',
    REASON_ENGINE,
  );
  ctx.gate('audit', 'audit-row', 'Sync events are recorded under the correct guild only.', REASON_AUDIT);
  gateBrandingCopy(ctx);
  ctx.gate('replay-safety', 'db-rls', 'Cross-guild repair attempts are rejected before any Discord call.', REASON_ENGINE);
}

/**
 * CLEANUP — all run-prefixed sync artifacts are removed after the suite; audit retained.
 * Seed run-prefixed desired-state + id-map rows and a sync-category audit row, run the
 * SAME sweep teardown uses, and verify zero operational rows remain while the audit row
 * is RETAINED (anonymize-over-delete). A second sweep is a safe no-op.
 */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Run-prefixed operational rows the sweep must clear …
  await seedDesiredState(handle, {
    roles: [{ key: `${ctx.runPrefix}role`, name: 'Runner' }],
    driftDetected: true,
    driftDetails: [{ entity: `${ctx.runPrefix}role`, type: 'EXTERNAL_CHANGE', state: 'open' }],
  });
  await seedIdMap(handle, 'role', `${ctx.runPrefix}role`, `${ctx.runPrefix}discord-role-id`);
  // … and a sync-category audit row the anonymize-over-delete contract says is RETAINED.
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'system',
    actor_id: 'sync-engine',
    action: 'drift.detected',
    target_type: 'guild',
    target_id: handle.guildId,
    category: 'sync',
    correlation_id: `${ctx.runPrefix}corr`,
  });

  const desiredBefore = await desiredStateCount(handle);
  const idMapBefore = await idMapCount(handle);
  ctx.expect(desiredBefore >= 1 && idMapBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed desired-state + id-map rows (pre-cleanup baseline).',
    observation: `pre-cleanup: guild_desired_state rows=${desiredBefore}, discord_id_map rows=${idMapBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed sync rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, 'guild_desired_state', desiredBefore);
  await proveNoOwnerAlert(ctx, handle, 'Cleanup emits no owner notifications.');

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const desiredAfter = await desiredStateCount(handle);
  const idMapAfter = await idMapCount(handle);
  ctx.expect(desiredAfter === 0 && idMapAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed desired-state and id-map rows are deleted; a final sweep finds zero run-prefixed sync resources.',
    observation: `post-sweep: guild_desired_state rows=${desiredAfter}, discord_id_map rows=${idMapAfter} (expected 0/0).`,
    impact: 'The cleanup sweep left run-prefixed sync rows behind — the suite leaves residue.',
  });

  // Running cleanup twice is a safe no-op.
  await ctx.sweepGuildRows(handle);
  const desiredAfter2 = await desiredStateCount(handle);
  ctx.expect(desiredAfter2 === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running cleanup twice is a safe no-op.',
    observation: `guild_desired_state rows after a second sweep = ${desiredAfter2} (expected 0, no error).`,
    impact: 'A second cleanup sweep was not a safe no-op.',
  });

  // Audit history is RETAINED, not deleted (anonymize-over-delete): the sync-category
  // audit row survives the operational sweep (audit_logs is intentionally NOT swept).
  const { count: auditAfter } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('category', 'sync');
  ctx.expect((auditAfter ?? 0) >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Run audit rows persist after cleanup — the sync-category audit_logs row is retained (anonymize-over-delete), never deleted by the operational sweep.',
    observation: `sync-category audit_logs rows for the guild after the sweep = ${auditAfter ?? 0} (expected ≥1, retained).`,
    impact: 'The cleanup sweep deleted audit history — violating the anonymize-over-delete retention contract.',
  });

  // Discord/channel readback of removed run-prefixed roles/channels is a live-guild lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed roles or channels remain in the test guild after cleanup.',
    REASON_ENGINE,
  );
  gateBrandingCopy(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Server-sync domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus the 12
 * scenario scripts. `audit_logs` is intentionally NOT swept — audit history is retained
 * (anonymize-over-delete), which CLEANUP proves. All listed tables reference only the
 * `guild` row (deleted last by the sweep), so the order among them is not FK-constrained.
 */
export const administrationServerSyncProof: DomainProof = {
  domainId: 'administration-server-sync',
  guildScopedTables: [
    'guild_desired_state', // drift + desired state (PK guild_id)
    'discord_id_map', // template_key → discord_id mappings
    'sync_reports', // auto-repair reports (engine-written)
    'alerts', // owner-notification rows this domain would raise
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
