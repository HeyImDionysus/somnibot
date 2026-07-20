/**
 * scenario-runner/scripts/administration-rbac — the Dashboard RBAC domain proof.
 *
 * Binds the administration-rbac domain's 12 declarative catalog scenarios to
 * concrete real-stack proofs driven against LOCAL Supabase. Unlike the wallet
 * domain, RBAC has NO bot slash commands: every contracted behavior (role
 * create/assign, priority-escalation guard, permission-denied gating, audit
 * rows, owner degradation notifications, brand-voiced denial copy) is enforced
 * by the Next.js dashboard HTTP API (`/api/rbac/roles`, `/api/rbac/users`,
 * guarded by `requirePermission('dashboard.manage_team')`) behind a Discord
 * OAuth session. The bot-only, gateway-less harness cannot mint that session or
 * call those routes, so this domain is MOSTLY GATED — that is the honest
 * boundary, and every gate below names the exact missing lane.
 *
 * What still runs NOW, non-vacuously, against local Supabase:
 *   - database-RLS: `dashboard_roles` / `dashboard_user_roles` are RLS-locked and
 *     anon is blanket-REVOKEd (20260710010000), so an anon REST read of a row the
 *     service role CAN see returns zero / 42501 — a real deny with a positive
 *     control (proveRlsIsolation), exactly like the wallet template.
 *   - replay-safety: the `UNIQUE(guild_id, name)` role constraint and the
 *     `UNIQUE(guild_id, discord_id, role_id)` assignment constraint are the real
 *     dedup mechanism the dashboard route relies on; a second identical insert is
 *     observed to leave exactly one row (REPLAY / RACE).
 *   - referential integrity: `dashboard_user_roles.role_id … ON DELETE CASCADE`
 *     is proven by deleting a role and observing its assignment vanish (RACE).
 *   - cross-guild isolation: two real guilds hold distinct role rows; a guild-B
 *     scope never returns guild A's row (XGUILD).
 *   - persistence: a role written by one booted stack is read back by a second
 *     boot of the same guild id (RESTART); the sweep removes every run-prefixed
 *     row (CLEANUP).
 *
 * Behavior-bug discovery (NOT forced green): DEF records a FAIL because no
 * reachable runtime path seeds the five system dashboard roles for a
 * newly-provisioned guild — only a one-time historical migration seeds guilds
 * that existed at migration time, and it seeds Owner/Admin/Moderator/Viewer/
 * Support, not the catalog's owner/admin/moderator/support/finance. A guild
 * provisioned after that migration opens /settings/team to an empty role list.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface RoleView {
  id: string;
  guild_id: string;
  name: string;
  permissions: string[];
  priority: number;
  is_system: boolean;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function runName(ctx: ScenarioContext, suffix: string): string {
  return `${ctx.runPrefix}${suffix}`;
}

/**
 * Insert a dashboard role exactly as the production `/api/rbac/roles` POST would
 * (guild_id + name + permissions + is_system + priority — the columns the route
 * writes), via the service role. Returns the new row id and any DB error string
 * so callers never mask a failure as success.
 */
async function insertRole(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  opts: { suffix: string; permissions?: string[]; priority?: number; isSystem?: boolean },
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('dashboard_roles')
    .insert({
      guild_id: handle.guildId,
      name: runName(ctx, opts.suffix),
      description: `${ctx.runPrefix} e2e rbac role`,
      permissions: opts.permissions ?? ['dashboard.view_audit'],
      is_system: opts.isSystem ?? false,
      priority: opts.priority ?? 10,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: error ? error.message : null };
}

async function readRoleByName(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  suffix: string,
): Promise<RoleView | null> {
  const { data } = await handle.supabase
    .from('dashboard_roles')
    .select('id, guild_id, name, permissions, priority, is_system')
    .eq('guild_id', handle.guildId)
    .eq('name', runName(ctx, suffix))
    .maybeSingle();
  return (data as RoleView | null) ?? null;
}

async function readRoleById(handle: LiveClientHandle, id: string): Promise<RoleView | null> {
  const { data } = await handle.supabase
    .from('dashboard_roles')
    .select('id, guild_id, name, permissions, priority, is_system')
    .eq('guild_id', handle.guildId)
    .eq('id', id)
    .maybeSingle();
  return (data as RoleView | null) ?? null;
}

async function roleCountByName(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  suffix: string,
): Promise<number> {
  const { count } = await handle.supabase
    .from('dashboard_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('name', runName(ctx, suffix));
  return count ?? 0;
}

async function guildRoleCount(
  handle: LiveClientHandle,
  opts: { isSystem?: boolean } = {},
): Promise<number> {
  let query = handle.supabase
    .from('dashboard_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (opts.isSystem !== undefined) query = query.eq('is_system', opts.isSystem);
  const { count } = await query;
  return count ?? 0;
}

async function deleteRoleById(handle: LiveClientHandle, id: string): Promise<void> {
  await handle.supabase.from('dashboard_roles').delete().eq('guild_id', handle.guildId).eq('id', id);
}

/**
 * Insert an assignment as the production `/api/rbac/users` POST would (guild_id +
 * discord_id + role_id). Returns the DB error string (or null). The route omits
 * the legacy `user_id`, so we do too; if a mis-reconciled local schema still
 * carries `user_id NOT NULL` the insert errors and the caller GATEs on it rather
 * than fabricating an assignment.
 */
async function insertAssignment(
  handle: LiveClientHandle,
  opts: { discordId: string; roleId: string },
): Promise<{ error: string | null }> {
  const { error } = await handle.supabase
    .from('dashboard_user_roles')
    .insert({ guild_id: handle.guildId, discord_id: opts.discordId, role_id: opts.roleId });
  return { error: error ? error.message : null };
}

async function assignmentCount(
  handle: LiveClientHandle,
  opts: { discordId: string; roleId: string },
): Promise<number> {
  const { count } = await handle.supabase
    .from('dashboard_user_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', opts.discordId)
    .eq('role_id', opts.roleId);
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
 * rows an anon key can read (RLS/GRANT deny → 0), or null when no anon key /
 * SUPABASE_URL is available or the key is rejected before authz (→ GATE).
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
    // Distinguish a genuine AUTHORIZATION denial (anon blocked from the table by
    // RLS / revoked GRANT — SQLSTATE 42501, the deny we want) from the key being
    // rejected before authz ran (inconclusive → GATE).
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove RLS isolation on `dashboard_roles`: the service role reads the given role
 * row while an anon client reads zero of them. The positive control (a role the
 * scenario really created under the guild) makes the anon zero a real deny, not
 * "there was nothing to read". GATEs (never fakes) when no anon key is exported
 * or the REST probe is inconclusive.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  roleId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero dashboard_roles rows (RLS + blanket anon REVOKE).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'dashboard_roles', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero dashboard_roles rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readRoleById(handle, roleId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s dashboard_roles row while an anon client reads zero of them (RLS + anon REVOKE).',
    observation:
      `service-role sees the run-prefixed role under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} dashboard_roles row(s) for that guild.`,
    impact:
      'A dashboard_roles row visible to the service role was also readable with an anon key — RLS/GRANT is not denying anon reads (direct RBAC data exposure).',
  });
}

/** Prove a happy path raised NO owner alert (real alerts-table read). */
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
    promise: "This scenario's happy path raises no owner alert.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
  });
}

/** RBAC surfaces are dashboard pages + denial copy, never a bot reply — GATE branding. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'All RBAC surfaces (denial copy, team-page chrome, role-assigned toast) render the owner white-label brand and voice with powered-by-SomniBot attribution.',
    'RBAC has no member-facing bot reply; its surfaces are rendered dashboard pages captured by the E2E browser (needs the dashboard + Discord OAuth session lane)',
  );
}

/** The role create/assign/deny audit rows are written by the dashboard route — GATE. */
function gateDashboardAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'discord-readback',
    promise,
    'RBAC audit rows are written by the dashboard /api/rbac route (actor/target/before-after); not reachable from a bot-only harness with no OAuth session',
  );
}

/** The gated dashboard access/authz lane (route guard + Discord OAuth session). */
function gateDashboardAccess(ctx: ScenarioContext, promise: string, extra = ''): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    `requires the dashboard HTTP API + a Discord OAuth session (requirePermission('dashboard.manage_team') / getAuthContext owner resolution)${extra ? `; ${extra}` : ''}`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out of the box the owner has full access and everyone else has none. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // FINDING (real, DB-observable): the catalog contracts that first dashboard
  // setup seeds exactly the five system roles (owner/admin/moderator/support/
  // finance) for the guild. No reachable runtime path does this — only a
  // one-time historical migration seeds guilds that pre-existed it (and it seeds
  // Owner/Admin/Moderator/Viewer/Support, a different set). A guild provisioned
  // now gets zero. Assert the contract; a mismatch is a finding for the owner.
  const systemRoles = await guildRoleCount(handle, { isSystem: true });
  ctx.expect(systemRoles === 5, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'After first setup, dashboard_roles contains exactly the five seeded system roles (owner/admin/moderator/support/finance) for the run guild.',
    observation:
      `a freshly-provisioned guild holds ${systemRoles} is_system role row(s) (expected 5). No runtime code path seeds ` +
      `system roles on guild setup — only a one-time historical migration seeds pre-existing guilds, and it seeds ` +
      `Owner/Admin/Moderator/Viewer/Support (not the contracted owner/admin/moderator/support/finance).`,
    impact:
      'A guild provisioned after the historical seed migration has no dashboard system roles: the owner opens /settings/team to an empty role list, so the "five system roles seeded exactly once" contract is unmet.',
  });

  // Positive control for the RLS probe: a real run-prefixed custom role.
  const probeRole = await insertRole(handle, ctx, { suffix: 'def-probe' });
  if (probeRole.id) {
    await proveRlsIsolation(ctx, handle, probeRole.id);
  } else {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero dashboard_roles rows (positive-control role).',
      `could not create the positive-control role for the RLS probe: ${probeRole.error ?? 'unknown insert error'}`,
    );
  }

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateDashboardAudit(ctx, 'Seeding and the denied access attempt are recorded in audit_logs with actor ids.');
  gateDashboardAccess(
    ctx,
    'Owner OAuth sign-in resolves dashboard.full_access; a member with no dashboard role receives 403 from /api/audit and a branded denial page on gated routes.',
    'the branded denial page + 403 are produced by hasRouteAccess/requirePermission behind the browser',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-running setup or re-signing-in does not duplicate system roles.',
    'role-create idempotency (UNIQUE(guild_id,name)) is exercised directly in REPLAY / RACE',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run-prefixed guild and role data are removed at teardown.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** SET-A — a custom role grants exactly its configured permissions and nothing else. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Create the run-prefixed auditor role with only dashboard.view_audit.
  const role = await insertRole(handle, ctx, { suffix: 'auditor', permissions: ['dashboard.view_audit'] });
  ctx.expect(role.id !== null && role.error === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a run-prefixed auditor dashboard role persists under the run guild.',
    observation: `insert id=${role.id ?? '(none)'}, error=${role.error ?? 'none'}.`,
    impact: 'Could not persist the auditor role — the SET-A configuration proof setup is invalid.',
  });

  if (role.id) {
    await proveRlsIsolation(ctx, handle, role.id);
  }
  await proveNoOwnerAlert(ctx, handle);

  // The MEANINGFUL "grants exactly its one permission and nothing else" is
  // enforced by rbac.ts hasPermission + the route guard on each gated API; a raw
  // insert bypasses that whitelist, so the differential-access proof is GATED.
  gateDashboardAccess(
    ctx,
    'The auditor assignee can GET /api/audit and open /audit but receives 403 from /api/rbac/roles and /settings/team (role grants exactly dashboard.view_audit).',
  );
  gateDashboardAudit(
    ctx,
    'Role creation and assignment appear as audit rows with before/after permission state.',
  );
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Submitting the same assignment again leaves exactly one assignment row.',
    'assignment idempotency (UNIQUE(guild_id,discord_id,role_id)) is exercised directly in REPLAY',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'The run-prefixed auditor role and its assignment are removed at teardown.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** SET-B — a differently configured custom role produces observably different access. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // A DISTINCT configuration from SET-A: incident-manager with only manage_incidents.
  const role = await insertRole(handle, ctx, {
    suffix: 'incident-manager',
    permissions: ['dashboard.manage_incidents'],
    priority: 20,
  });
  ctx.expect(role.id !== null && role.error === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a run-prefixed incident-manager dashboard role persists under the run guild.',
    observation: `insert id=${role.id ?? '(none)'}, error=${role.error ?? 'none'}.`,
    impact: 'Could not persist the incident-manager role — the SET-B differentiation proof setup is invalid.',
  });

  if (role.id) {
    await proveRlsIsolation(ctx, handle, role.id);
  }

  // The DIFFERENTIATION itself — a manage_incidents role grants /api/incidents but
  // is denied /api/audit, observably different from the SET-A auditor — is enforced
  // by rbac.ts hasPermission + each route guard; a raw insert bypasses that gating,
  // so the observable-difference proof is GATED (reading back the permission column
  // we just wrote would prove only that Postgres stores JSONB, not that access differs).
  gateDashboardAccess(
    ctx,
    'The incident-manager assignee can POST /api/incidents but receives 403 from /api/audit (the second config takes distinct effect, observably different from the SET-A auditor role).',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The new-incident owner notification fires; no RBAC degradation alert fires.',
    'the new-incident notification is emitted by the incidents feature via the dashboard route (needs the dashboard + owner notification channel readback)',
  );
  gateDashboardAudit(ctx, 'The incident creation and the audit-route denial are both logged.');
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-sending the role update request does not stack duplicate permissions.',
    'role-update idempotency runs through the dashboard PATCH /api/rbac/roles route (not reachable here)',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run-prefixed role, assignment, and incident are removed at teardown.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** INVALID — invalid role definitions are rejected atomically. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const maxPerms = Number(declaredDefault(ctx.domain, 'max-permissions-per-role') ?? 100);

  // A valid control role exists and is the ONLY run-prefixed role for the guild;
  // this is the DB-observable baseline that a rejected invalid POST must not disturb.
  const control = await insertRole(handle, ctx, { suffix: 'valid-control', permissions: ['dashboard.view_audit'] });
  const before = await guildRoleCount(handle);
  ctx.expect(control.id !== null && before === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A valid role exists and is the only dashboard_roles row for the guild (byte-stable baseline).',
    observation: `control insert id=${control.id ?? '(none)'}; guild dashboard_roles count=${before} (expected 1).`,
    impact: 'Could not establish the pre-rejection baseline of valid roles.',
  });

  if (control.id) {
    await proveRlsIsolation(ctx, handle, control.id);
  }
  await proveNoOwnerAlert(ctx, handle);

  // The actual REJECTION (priority 2000 / 150 permissions → 400) is enforced in
  // the dashboard rbacRoleCreate Zod schema (priority.max(999), permissions
  // .max(100)); the dashboard_roles columns carry NO DB CHECK, so the reject
  // path is not reachable from a bot-only harness. GATE it honestly.
  gateDashboardAccess(
    ctx,
    `POST /api/rbac/roles with priority 2000 and 150 permissions returns 400 from schema validation (permissions cap ${maxPerms}, priority max 999); no row is inserted.`,
    'config validation lives in the dashboard Zod layer; dashboard_roles has no DB CHECK, so a bot-only harness cannot drive the reject path',
  );
  gateDashboardAudit(ctx, 'The rejected attempt is recorded without creating any role artifact.');
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeating the invalid request produces repeated 400s and still zero writes.',
    'the invalid-request reject path runs through the dashboard route (not reachable here)',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Nothing invalid was created, so teardown verifies zero residue.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** UNAUTH — team management is denied to anyone without dashboard.manage_team. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Positive control + the DB-observable baseline the denied calls must not change.
  const control = await insertRole(handle, ctx, { suffix: 'mod-role', permissions: ['dashboard.manage_moderation'] });
  const before = await guildRoleCount(handle);
  ctx.expect(control.id !== null && before === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The guild holds exactly the one seeded control role before any unauthorized call (baseline for "denied calls write nothing").',
    observation: `control insert id=${control.id ?? '(none)'}; guild dashboard_roles count=${before} (expected 1).`,
    impact: 'Could not establish the pre-denial baseline.',
  });

  if (control.id) {
    await proveRlsIsolation(ctx, handle, control.id);
  }

  // The 403 denials (moderator/admin member → POST /api/rbac/roles, GET
  // /api/rbac/users) and the priority-escalation block are enforced by
  // requirePermission('dashboard.manage_team') and the /api/rbac/users priority
  // comparison — dashboard route + OAuth session, unreachable here.
  gateDashboardAccess(
    ctx,
    'A member holding the moderator system role calls POST /api/rbac/roles and GET /api/rbac/users and receives 403 on both; a priority-escalation assignment by an admin-role member is also rejected with 403.',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The blocked escalation attempt raises exactly one owner notification.',
    'the rbac.escalation_blocked owner notification is emitted by the dashboard route (needs dashboard + owner notification channel readback)',
  );
  gateDashboardAudit(
    ctx,
    'rbac.escalation_blocked and the 403 denials are recorded with the acting member’s id.',
  );
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated denied attempts remain denied and write nothing.',
    'the denied write path runs through the dashboard route (not reachable here)',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'No residue exists; teardown verifies unchanged role tables.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** DEPFAIL — when the database is unreachable, access fails closed, never open. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This harness's whole premise is a REACHABLE local Supabase, and the
  // fail-closed permission-lookup path lives in the dashboard's getAuthContext /
  // requirePermission behind an OAuth session. Neither the outage nor the route
  // is reachable here — GATE every facet honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With Supabase connectivity blocked, every gated dashboard request returns 401/403 and no stale permission grant is served (fail-closed).',
    'requires a Supabase dependency-outage fault-injection lane AND the dashboard permission-lookup route (getAuthContext) behind an OAuth session',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one degradation alert is delivered (the rbac-degraded owner notification), not one per denied request.',
    'requires the outage fault lane plus the owner notification channel + dashboard banner readback',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'rbac.lookup_failed is recorded once connectivity returns.',
    'the rbac.lookup_failed audit row is written by the dashboard route after recovery (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'After recovery, role and assignment rows are exactly as before the outage.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The degradation banner uses the rbac-degraded template in the owner voice.',
    'requires the outage fault lane to reach the degraded dashboard banner',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Requests retried during the outage cause no duplicate writes after recovery.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Outage simulation artifacts are fully reverted at teardown.',
    'no outage artifacts are created in this gated scenario',
  );
}

/** RETRY — transient failures during role writes converge to exactly one applied change. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // The injected-500-on-first-attempt fault is a dashboard-route concern and
  // cannot be induced here. GATE the fault lane. But the DB-observable CONVERGENCE
  // invariant the retry relies on IS provable: a retried create of the same
  // (guild, name) can never duplicate, because UNIQUE(guild_id, name) rejects the
  // second write — so two "attempts" of the same role leave exactly one row.
  const first = await insertRole(handle, ctx, { suffix: 'retry-role', permissions: ['dashboard.manage_incidents'] });
  const second = await insertRole(handle, ctx, { suffix: 'retry-role', permissions: ['dashboard.manage_incidents'] });
  const count = await roleCountByName(handle, ctx, 'retry-role');
  ctx.expect(first.error === null && second.error !== null && count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'A retried role create converges to exactly one dashboard_roles row (UNIQUE(guild_id, name) rejects the duplicate) — no orphan or duplicate.',
    observation:
      `first create error=${first.error ?? 'none'}, retried create error=${second.error ?? 'none (UNEXPECTED — duplicate accepted)'}, ` +
      `rows for the name=${count} (expected exactly 1).`,
    impact:
      'A retried role create produced a second row — the transient-failure retry is not convergent, leaving duplicate roles.',
  });

  if (first.id) {
    await proveRlsIsolation(ctx, handle, first.id);
  }
  await proveNoOwnerAlert(ctx, handle);

  gateDashboardAccess(
    ctx,
    'A role creation that fails transiently (injected 500 on first attempt) and is retried results in exactly one role row via the dashboard route.',
    'requires a mid-write fault-injection lane on the dashboard POST /api/rbac/roles handler',
  );
  gateDashboardAudit(ctx, 'The audit trail shows the failed attempt and the successful creation distinctly.');
  gateBranding(ctx);
  ctx.gate(
    'cleanup',
    'db-observable',
    'The run-prefixed role is removed at teardown.',
    'the run-prefixed sweep is exercised directly in CLEANUP',
  );
}

/** REPLAY — replaying assignment/create requests never duplicates grants. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  // (a) Role-create replay: the same (guild, name) inserted twice → exactly one
  //     row (UNIQUE(guild_id, name) is the real dedup the route relies on).
  const roleFirst = await insertRole(handle, ctx, { suffix: 'replay-role', permissions: ['dashboard.view_audit'] });
  const roleSecond = await insertRole(handle, ctx, { suffix: 'replay-role', permissions: ['dashboard.view_audit'] });
  const roleRows = await roleCountByName(handle, ctx, 'replay-role');
  ctx.expect(roleFirst.error === null && roleSecond.error !== null && roleRows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Replaying a role-create request yields exactly one dashboard_roles row (UNIQUE(guild_id, name)).',
    observation:
      `first=${roleFirst.error ?? 'ok'}, replay=${roleSecond.error ?? 'ok (UNEXPECTED)'}, rows for the name=${roleRows} (expected 1).`,
    impact: 'A replayed role-create produced a duplicate role row — the create is not idempotent.',
  });

  // (b) Assignment replay: the same (guild, discord_id, role_id) inserted twice →
  //     exactly one row (UNIQUE(guild_id, discord_id, role_id)). If the local
  //     schema rejects the production-shaped assignment insert (legacy user_id
  //     NOT NULL), GATE on the real error rather than fabricate an assignment.
  if (roleFirst.id) {
    const assignFirst = await insertAssignment(handle, { discordId: userA, roleId: roleFirst.id });
    if (assignFirst.error) {
      ctx.gate(
        'replay-safety',
        'db-observable',
        'Replaying the assignment leaves exactly one dashboard_user_roles row (UNIQUE(guild_id, discord_id, role_id)).',
        `the production-shaped assignment insert was rejected by the local schema (${assignFirst.error}); assignment dedup runs through the dashboard POST /api/rbac/users route`,
      );
    } else {
      const assignSecond = await insertAssignment(handle, { discordId: userA, roleId: roleFirst.id });
      const assignRows = await assignmentCount(handle, { discordId: userA, roleId: roleFirst.id });
      ctx.expect(assignSecond.error !== null && assignRows === 1, {
        assertionClass: 'replay-safety',
        channel: 'db-observable',
        promise:
          'The exact same assignment sent twice leaves exactly one dashboard_user_roles row (UNIQUE(guild_id, discord_id, role_id) rejects the duplicate).',
        observation:
          `replay insert error=${assignSecond.error ?? 'none (UNEXPECTED — duplicate accepted)'}, ` +
          `assignment rows for (guild, discord_id, role)=${assignRows} (expected 1).`,
        impact:
          'A replayed identical assignment created a duplicate grant — the assignment dedup constraint is not enforced (a replay-safety regression on privilege grants).',
      });
    }
  }

  if (roleFirst.id) {
    await proveRlsIsolation(ctx, handle, roleFirst.id);
  }
  await proveNoOwnerAlert(ctx, handle);
  gateDashboardAudit(ctx, 'One assignment audit row exists; the replay is visible as a rejected duplicate, not a second grant.');
  gateBranding(ctx);
  gateDashboardAccess(ctx, 'The team page lists the member’s role once, not twice.');
}

/** RESTART — RBAC state survives a full stack restart. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: create a run-prefixed role (and best-effort assignment), snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const role = await insertRole(first, ctx, {
    suffix: 'restart-role',
    permissions: ['dashboard.manage_incidents'],
    priority: 15,
  });
  let assignmentPersisted: boolean | null = null;
  if (role.id) {
    const assign = await insertAssignment(first, { discordId: userA, roleId: role.id });
    assignmentPersisted = assign.error === null ? true : null; // null → schema rejected the insert (GATE later)
  }
  const snapshot = role.id ? await readRoleById(first, role.id) : null;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State must be identical (it lives in Supabase).
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readRoleByName(second, ctx, 'restart-role');
  ctx.expect(
    afterRestart !== null &&
      afterRestart.priority === 15 &&
      afterRestart.permissions.length === 1 &&
      afterRestart.permissions[0] === 'dashboard.manage_incidents' &&
      afterRestart.id === snapshot?.id,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'After a full stack restart, the custom role is byte-identical: same id, priority (15), and permission set persist (state lives in Supabase).',
      observation:
        `pre-restart id=${snapshot?.id ?? '(none)'} priority=${snapshot?.priority}; ` +
        `post-restart id=${afterRestart?.id ?? '(none)'} priority=${afterRestart?.priority} permissions=${JSON.stringify(afterRestart?.permissions ?? null)}.`,
      impact: 'RBAC role state did not survive a restart — persisted role/permission data was lost or altered.',
    },
  );

  // Assignment persistence across the restart (only when the insert was accepted).
  if (assignmentPersisted && role.id) {
    const rows = await assignmentCount(second, { discordId: userA, roleId: role.id });
    ctx.expect(rows === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'The pre-restart assignment persists across the restart with no duplication (exactly one row).',
      observation: `assignment rows after restart = ${rows} (expected 1).`,
      impact: 'The assignment did not survive the restart, or was duplicated by a re-seed.',
    });
  } else {
    ctx.gate(
      'replay-safety',
      'db-observable',
      'The pre-restart assignment persists across the restart with no duplication.',
      'the production-shaped assignment insert was not accepted by the local schema; assignment persistence runs through the dashboard route',
    );
  }

  if (afterRestart?.id) {
    await proveRlsIsolation(ctx, second, afterRestart.id);
  }
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateDashboardAudit(ctx, 'No spurious role churn is logged around the restart.');
  gateDashboardAccess(ctx, 'The limited member’s post-restart session has exactly the same access as pre-restart.');
}

/** RACE — concurrent identical assignments/creates collapse to one grant. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  // (a) Two CONCURRENT creates of the same (guild, name) → exactly one row: one
  //     wins, the other hits UNIQUE(guild_id, name). Real concurrency + constraint.
  const [c1, c2] = await Promise.all([
    insertRole(handle, ctx, { suffix: 'race-role', permissions: ['dashboard.view_audit'] }),
    insertRole(handle, ctx, { suffix: 'race-role', permissions: ['dashboard.view_audit'] }),
  ]);
  const rows = await roleCountByName(handle, ctx, 'race-role');
  const winners = [c1, c2].filter((r) => r.error === null).length;
  ctx.expect(rows === 1 && winners === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two concurrent identical role creates collapse to exactly one dashboard_roles row (UNIQUE(guild_id, name)).',
    observation: `concurrent creates that succeeded=${winners}; rows for the name=${rows} (expected exactly 1 of each).`,
    impact: 'A concurrent create race produced duplicate role rows — the unique constraint did not serialize the writers.',
  });

  // (b) Referential integrity: an assignment for a role that is then deleted must
  //     leave NO dangling assignment (role_id … ON DELETE CASCADE).
  const roleId = c1.error === null ? c1.id : c2.error === null ? c2.id : null;
  if (roleId) {
    const assign = await insertAssignment(handle, { discordId: userA, roleId });
    if (assign.error) {
      ctx.gate(
        'database-RLS',
        'db-observable',
        'Concurrent create+delete of a role settles with no assignment referencing a deleted role (ON DELETE CASCADE).',
        `the production-shaped assignment insert was rejected by the local schema (${assign.error}); the cascade path is enforced by the dashboard route + FK`,
      );
    } else {
      await deleteRoleById(handle, roleId);
      const dangling = await assignmentCount(handle, { discordId: userA, roleId });
      const roleGone = (await readRoleById(handle, roleId)) === null;
      ctx.expect(roleGone && dangling === 0, {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise:
          'Deleting a role removes its assignments (role_id … ON DELETE CASCADE): no assignment references a deleted role.',
        observation: `after role delete: role present=${!roleGone}, dangling assignment rows=${dangling} (expected role gone, 0 assignments).`,
        impact: 'A deleted role left a dangling dashboard_user_roles assignment — the ON DELETE CASCADE FK is not enforced.',
      });
    }
  }

  if (roleId) {
    await proveRlsIsolation(ctx, handle, roleId);
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'At most one notification is emitted for the applied change.',
    'the applied-change notification is emitted by the dashboard route (needs the owner notification channel readback)',
  );
  gateDashboardAudit(ctx, 'Both attempts are logged; exactly one records an applied change.');
  gateBranding(ctx);
  gateDashboardAccess(ctx, 'The team page reflects one coherent final state after the race.');
}

/** XGUILD — RBAC state never leaks across guilds. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // Each guild gets a role that shares the SAME run-prefixed name but a DISTINCT
  // permission set — so a leak would be unmistakable.
  const roleA = await insertRole(handleA, ctx, { suffix: 'xg-role', permissions: ['dashboard.view_audit'] });
  const roleB = await insertRole(handleB, ctx, { suffix: 'xg-role', permissions: ['dashboard.manage_incidents'] });

  const aRow = await readRoleByName(handleA, ctx, 'xg-role');
  const bRow = await readRoleByName(handleB, ctx, 'xg-role');
  ctx.expect(
    aRow !== null &&
      bRow !== null &&
      aRow.guild_id === guildA &&
      bRow.guild_id === guildB &&
      aRow.id !== bRow.id &&
      aRow.permissions[0] === 'dashboard.view_audit' &&
      bRow.permissions[0] === 'dashboard.manage_incidents',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each guild owns its OWN dashboard role; the same-named role in guild A and guild B are distinct rows with distinct permissions.',
      observation:
        `guild A row id=${aRow?.id} perms=${JSON.stringify(aRow?.permissions ?? null)} under "${aRow?.guild_id}"; ` +
        `guild B row id=${bRow?.id} perms=${JSON.stringify(bRow?.permissions ?? null)} under "${bRow?.guild_id}".`,
      impact: 'Cross-guild activity surfaced another guild’s role — per-guild RBAC isolation broken.',
    },
  );

  // A guild-B scope must return ZERO of guild A's specific role row.
  const { count: aRowUnderB } = await handleB.supabase
    .from('dashboard_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildB)
    .eq('id', roleA.id ?? '00000000-0000-0000-0000-000000000000');
  ctx.expect((aRowUnderB ?? -1) === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'A guild-B-scoped select for guild A’s role id returns zero rows (cross-guild selects see nothing of the other guild).',
    observation: `guild-B-scoped read for guild A’s role id returned ${aRowUnderB ?? '(error)'} row(s) (expected 0).`,
    impact: 'A guild-scoped read returned another guild’s role row — cross-guild RBAC leakage.',
  });

  if (roleA.id) {
    await proveRlsIsolation(ctx, handleA, roleA.id);
  }
  // Guild A’s owner is not alerted about guild B activity: guild A has no alert row.
  await proveNoOwnerAlert(ctx, handleA);
  gateDashboardAudit(ctx, 'Denied cross-guild attempts are logged under the correct guild.');
  gateBranding(ctx);
  gateDashboardAccess(
    ctx,
    'A guild B member holding a powerful guild B role gets 403 on every guild A resource (x-guild-id switched).',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Cross-guild replays write nothing in either guild.',
    'cross-guild write attempts run through the dashboard route with an x-guild-id the session is not authorized for',
  );
}

/** CLEANUP — every run-prefixed RBAC artifact is removed after the suite. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: a role and a best-effort assignment.
  const role = await insertRole(handle, ctx, { suffix: 'cleanup-role', permissions: ['dashboard.view_audit'] });
  if (role.id) {
    await insertAssignment(handle, { discordId: userA, roleId: role.id });
  }
  const rolesBefore = await guildRoleCount(handle);
  ctx.expect(rolesBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed dashboard role rows (pre-cleanup baseline).',
    observation: `pre-cleanup: dashboard_roles rows for the guild=${rolesBefore} (expected >= 1).`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  if (role.id) {
    await proveRlsIsolation(ctx, handle, role.id);
  }
  await proveNoOwnerAlert(ctx, handle);

  // Run the same sweep teardown uses and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const rolesAfter = await guildRoleCount(handle);
  const assignmentsAfter = role.id ? await assignmentCount(handle, { discordId: userA, roleId: role.id }) : 0;
  ctx.expect(rolesAfter === 0 && assignmentsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed dashboard role and assignment rows are deleted; a final sweep finds zero run-prefixed RBAC resources.',
    observation: `post-sweep: dashboard_roles rows=${rolesAfter}, dashboard_user_roles rows for the tuple=${assignmentsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed RBAC rows behind — the suite leaves residue.',
  });

  // Audit history is anonymized-not-deleted (audit_logs is NOT in guildScopedTables,
  // so the sweep never touches it) — but proving retention needs the production
  // anonymization path plus dashboard-written audit rows, neither reachable here.
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit rows for the run persist; none were deleted by cleanup (anonymize-over-delete contract).',
    'RBAC audit rows are written by the dashboard route and retained/anonymized by the production guild-purge path; not reachable in a bot-only harness',
  );
  gateBranding(ctx);
  gateDashboardAccess(ctx, 'The team page shows no run-prefixed roles after teardown.');
  ctx.gate(
    'owner-notification',
    'db-observable',
    'Cleanup emits no user-facing notifications.',
    'the "no alert" happy path is proven above; user-facing cleanup notifications would surface on the dashboard (not reachable here)',
  );
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Dashboard RBAC domain proof. `guildScopedTables` lists the guild_id-scoped
 * tables the sweep must clear in child→parent order (assignments reference roles
 * via role_id … ON DELETE CASCADE, both reference the guild). `audit_logs` is
 * deliberately EXCLUDED so the anonymize-over-delete contract (audit retained
 * across cleanup) is not violated by the sweep. This domain is mostly gated:
 * every behavioral cell runs through the dashboard HTTP API + Discord OAuth,
 * which the bot-only harness cannot drive — the DB-observable RLS / dedup /
 * cascade / persistence / cross-guild / sweep proofs above are the honest core.
 */
export const administrationRbacProof: DomainProof = {
  domainId: 'administration-rbac',
  guildScopedTables: ['dashboard_user_roles', 'dashboard_roles', 'alerts'],
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
