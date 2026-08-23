/**
 * scenario-runner/scripts/administration-team-management — the dashboard-team
 * (RBAC) domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios (DEF … CLEANUP) to
 * concrete real-stack proofs driven against LOCAL Supabase. Unlike the wallet
 * domain, THIS domain has NO slash commands: every mutation (invite, accept,
 * decline, revoke, expiry sweep) is a Next.js dashboard HTTP route guarded by a
 * Supabase session (OAuth), so the bot-only harness cannot invoke ANY of it —
 * `ctx.runSlash` has nothing to call here. That makes this domain MOSTLY GATED,
 * and the gates are precise (they name the missing dashboard-session / Discord /
 * time-sweep / fault lane).
 *
 * What the harness CAN observe is the DATABASE, using the SAME service-role
 * client the real dashboard route uses (`createAdminSupabase()` ≡
 * `handle.supabase`). Seeding a `dashboard_user_roles` row through it faithfully
 * reproduces the production assignment write, so the RLS/anon-denial,
 * cross-guild isolation, UNIQUE-constraint idempotency, restart-persistence and
 * cleanup properties are all proven live.
 *
 * DEF carries two probes that once surfaced FAIL findings and now pin the fixed
 * behavior (never softened — they still FAIL if the product regresses):
 *   1. The consent-based INVITATION model: probed live for an invitation entity
 *      (`team_invitations` now exists) rather than assumed.
 *   2. The grant path (POST /api/rbac/users): its EXACT insert shape is replayed
 *      against the live schema (the reconciled schema accepts it — `user_id` is
 *      backfill-nullable and `assigned_by` is text carrying the actor snowflake).
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface AssignmentRow {
  id: string;
  guild_id: string;
  discord_id: string | null;
  role_id: string;
  user_id: string;
}

interface PgErr {
  code?: string;
  message?: string;
}

// Candidate names/columns the invitation-model probe looks for. If NONE of the
// tables exist and NONE of the lifecycle columns exist, the consent/invitation
// model is absent (the DEF finding). Probed live, never assumed.
const CANDIDATE_INVITE_TABLES = [
  'team_invitations',
  'invitations',
  'dashboard_invitations',
  'team_invites',
  'dashboard_team_invitations',
] as const;
const LIFECYCLE_COLUMNS = ['status', 'accepted_at', 'expires_at', 'invitation_id', 'invite_token'] as const;

// ── Catalog helpers ───────────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

// ── Seed helpers (service role — the same client the dashboard route uses) ──

/** Insert a run-prefixed dashboard role for the guild; returns its id (or null). */
async function seedRole(
  handle: LiveClientHandle,
  name: string,
  permissions: string[],
  priority = 10,
): Promise<string | null> {
  const { data, error } = await handle.supabase
    .from('dashboard_roles')
    .insert({ guild_id: handle.guildId, name, description: 'e2e team role', permissions, priority })
    .select('id')
    .single();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Ensure a `users` row exists for a run-prefixed discord id and return its uuid.
 * `dashboard_user_roles.user_id` is NOT NULL and FKs to `users(id)`, so an
 * assignment needs a real identity row. Upsert-on-discord_id keeps it idempotent.
 * These rows are NOT guild-scoped, so scripts delete them explicitly (see
 * `deleteUsers`) — they are never left as residue.
 */
async function ensureUser(handle: LiveClientHandle, discordId: string): Promise<string | null> {
  const { data, error } = await handle.supabase
    .from('users')
    .upsert(
      { discord_id: discordId, discord_username: `team-e2e-${discordId}`.slice(0, 60) },
      { onConflict: 'discord_id' },
    )
    .select('id')
    .single();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

/** Delete the run-prefixed identity rows a script created (kept out of the sweep). */
async function deleteUsers(handle: LiveClientHandle, discordIds: string[]): Promise<void> {
  if (discordIds.length === 0) return;
  await handle.supabase.from('users').delete().in('discord_id', discordIds);
}

async function usersRemaining(handle: LiveClientHandle, discordIds: string[]): Promise<number> {
  if (discordIds.length === 0) return 0;
  const { count } = await handle.supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .in('discord_id', discordIds);
  return count ?? 0;
}

/**
 * Insert a schema-valid role assignment (the post-acceptance state the catalog
 * calls the "grant"): guild + real user_id + discord_id + role_id. Returns the
 * PostgREST error (if any) so callers can prove UNIQUE-constraint idempotency.
 */
async function seedAssignment(
  handle: LiveClientHandle,
  userId: string,
  discordId: string,
  roleId: string,
): Promise<PgErr | null> {
  const { error } = await handle.supabase.from('dashboard_user_roles').insert({
    guild_id: handle.guildId,
    user_id: userId,
    discord_id: discordId,
    role_id: roleId,
  });
  return (error as PgErr | null) ?? null;
}

/**
 * Reproduce the EXACT insert the production route (POST /api/rbac/users) performs:
 * `{ guild_id, discord_id, role_id, assigned_by: <discord snowflake> }` — no
 * user_id (backfill-nullable) and the actor snowflake in the text `assigned_by`
 * column. Returns whether it succeeded plus the DB error, so DEF proves the
 * add-member path works against the live schema (and fails loudly on drift).
 */
async function routeFaithfulInsert(
  handle: LiveClientHandle,
  discordId: string,
  roleId: string,
): Promise<{ ok: boolean; err: PgErr | null }> {
  const { error } = await handle.supabase.from('dashboard_user_roles').insert({
    guild_id: handle.guildId,
    discord_id: discordId,
    role_id: roleId,
    // The route sets assigned_by = ctx.discordId (a Discord snowflake string,
    // stored in the text assigned_by column) and omits user_id entirely
    // (backfill-nullable), exactly as the route does.
    assigned_by: '100000000000000001',
  });
  return { ok: !error, err: (error as PgErr | null) ?? null };
}

async function readAssignment(
  handle: LiveClientHandle,
  roleId: string,
  userId: string,
): Promise<AssignmentRow | null> {
  const { data } = await handle.supabase
    .from('dashboard_user_roles')
    .select('id, guild_id, discord_id, role_id, user_id')
    .eq('guild_id', handle.guildId)
    .eq('role_id', roleId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as AssignmentRow | null) ?? null;
}

async function assignmentCount(handle: LiveClientHandle, roleId: string, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('dashboard_user_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('role_id', roleId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function guildTableCount(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Count owner degradation alerts for the guild. Returns null (NOT 0) on a read
 * error so a failed read can never masquerade as "no alert raised".
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
 * Probe the live DB for any invitation entity: candidate invitation tables and
 * lifecycle columns on `dashboard_user_roles`. Under the service role (which
 * bypasses RLS) a select errors ONLY when the table/column is absent, so a
 * truthy error means "does not exist". Returns what actually exists.
 */
async function probeInvitationModel(
  handle: LiveClientHandle,
): Promise<{ tables: string[]; columns: string[]; present: boolean }> {
  const tables: string[] = [];
  for (const t of CANDIDATE_INVITE_TABLES) {
    const { error } = await handle.supabase.from(t).select('*', { head: true, count: 'exact' }).limit(1);
    if (!error) tables.push(t);
  }
  const columns: string[] = [];
  for (const c of LIFECYCLE_COLUMNS) {
    const { error } = await handle.supabase.from('dashboard_user_roles').select(c).limit(1);
    if (!error) columns.push(c);
  }
  return { tables, columns, present: tables.length > 0 || columns.length > 0 };
}

// ── Anon-denial RLS probe (verbatim shape from the wallet-domain proof) ─────

/**
 * Number of rows an anon key can read from `table` for the guild (RLS/GRANT
 * deny → 0), or null when inconclusive (→ GATE). A PostgREST 42501
 * "permission denied" (the v6 hardening REVOKEd anon/authenticated on the
 * dashboard tables) is the deny we want, mapped to 0.
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Anon clients read zero assignment rows while the service role sees the seeded
 * one (positive control). GATEs (never fakes) when no anon key is available or
 * the probe is inconclusive.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  roleId: string,
  userId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero dashboard_user_roles rows (v6 hardening REVOKEd anon/authenticated).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'dashboard_user_roles', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero dashboard_user_roles rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS/GRANT evaluated)',
    );
    return;
  }
  const serviceSees = await readAssignment(handle, roleId, userId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s assignment row while an anon client reads zero of them (dashboard_user_roles is service-role-only).',
    observation:
      `service-role sees the seeded assignment under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} dashboard_user_roles row(s) for that guild.`,
    impact:
      'A dashboard assignment row visible to the service role was also readable with an anon key — a privileged RBAC grant is exposed to unauthenticated clients.',
  });
}

/** Happy paths raise no spurious owner degradation alert; the positive owner
 *  MIRROR (acceptance/expiry/DM-failure) is a live-guild readback → GATED. */
async function proveOwnerNotification(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      'This scenario raises no spurious owner degradation alert.',
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: 'This scenario raises no spurious owner degradation alert.',
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner degradation alert was raised where none was expected — notification noise / a false alarm.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Acceptance / DM-failure / expiry each mirror to the owner exactly once in the owner notification channel.',
    'the owner mirror is delivered to a live Discord channel by the dashboard invitation flow (DISCORD_TOKEN + live guild), which is not reachable in this bot-only harness',
  );
}

/**
 * Branding here lives entirely in the Discord DM and the dashboard invitation
 * card — this domain produces NO member-facing bot reply the harness can
 * capture — so both branding channels GATE honestly (never a hollow pass).
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'All invitation copy speaks in the owner’s configured voice with subtle powered-by-SomniBot attribution.',
    'invitation copy is emitted as a Discord DM and a dashboard card (no member-facing bot slash reply exists in this domain) — needs the DM/dashboard capture lane',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The DM/dashboard brand kit (voice preset, attribution) matches the owner brand kit.',
    'requires a DM + dashboard snapshot readback against the live brand kit (DISCORD_TOKEN + live guild + dashboard session)',
  );
}

function gateAudit(ctx: ScenarioContext, event: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    `An audit_logs row (${event}) is written with actor + target for this transition.`,
    'team invitation transitions write team.* audit rows through the dashboard invitation APIs and atomic acceptance RPC; proving this event requires the authenticated dashboard action followed by audit_logs readback',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Replaying this scenario’s trigger yields exactly one assignment (no duplicate grant).',
    `assignment idempotency is exercised directly in the ${where} scenario (UNIQUE(guild_id,user_id,role_id))`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The invitation DM arrives and post-accept the member reaches the granted dashboard routes.',
    'requires a live Discord gateway + dashboard session (DISCORD_TOKEN + live guild) for DM and post-accept access readback',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — the catalog's default invite → DM → accept → grant flow. The invitation
 * entity (team_invitations) and the route-shaped grant insert are both probed
 * LIVE (they were FAIL findings before the model landed and the schema was
 * reconciled; the probes stay to catch regressions). The assignment table's
 * RLS/owner-alert properties prove out on a schema-valid seeded grant.
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('def-m');
  const directDefault = declaredDefault(ctx.domain, 'direct-assignment-enabled');

  const roleId = await seedRole(handle, `${ctx.runPrefix}moderator`, ['dashboard.manage_moderation']);
  ctx.expect(roleId !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a dashboard role the member can be invited to exists.',
    observation: `seeded dashboard_roles id=${roleId ?? '(insert failed)'} under guild "${handle.guildId}".`,
    impact: 'Could not seed the dashboard role — the team-management proof setup is invalid.',
  });

  // The consent/invitation model exists live (a former FAIL finding — probed,
  // never assumed; the probe stays to catch the model regressing away).
  const model = await probeInvitationModel(handle);
  ctx.expect(model.present, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A consent-based invitation precedes any grant: an invitation is created (pending) and the invitee must accept before permissions apply ' +
      `(direct-assignment-enabled defaults to ${JSON.stringify(directDefault)} → consent required).`,
    observation:
      `probed invitation entities [${CANDIDATE_INVITE_TABLES.join(', ')}] → present: ` +
      `[${model.tables.join(', ') || 'none'}]; dashboard_user_roles lifecycle columns present: ` +
      `[${model.columns.join(', ') || 'none'}].`,
    impact:
      'The invitation/consent model from the catalog is unimplemented: there is no pending state, no DM/accept step, and no expiry/decline/revoke. Roles would be granted with no acceptance — direct-assignment-enabled=false is not honored.',
  });

  // The implemented grant path (POST /api/rbac/users) records the grant: replay
  // its EXACT insert shape against the live schema (a former FAIL finding — the
  // probe stays to catch schema drift regressing the route).
  const route = await routeFaithfulInsert(handle, memberDiscord, roleId ?? '');
  ctx.expect(route.ok, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The one implemented add-member path (POST /api/rbac/users) successfully records the role grant.',
    observation: route.ok
      ? 'the exact insert the route performs succeeded against the live schema (backfill-nullable user_id; text assigned_by carrying the actor snowflake).'
      : `the exact insert the route performs failed: [${route.err?.code ?? '?'}] ${route.err?.message ?? ''} ` +
        '(the route omits user_id and writes the actor’s Discord snowflake into assigned_by).',
    impact:
      'The only implemented path to grant a dashboard role errors against the live schema, so no team member can be added — team management is non-functional end-to-end.',
  });

  // The route-shaped row above occupies UNIQUE(guild_id, discord_id, role_id).
  // Clear it before seeding the identity-linked post-acceptance grant below —
  // otherwise that seed hits 23505 and leaves NO row matching readAssignment's
  // user_id filter, falsely tripping the RLS probe's positive control.
  await handle.supabase
    .from('dashboard_user_roles')
    .delete()
    .eq('guild_id', handle.guildId)
    .eq('discord_id', memberDiscord);

  // Seed a SCHEMA-VALID assignment (the post-acceptance "grant" state) so the
  // off-theme classes have a real row to observe.
  const userId = await ensureUser(handle, memberDiscord);
  if (userId && roleId) await seedAssignment(handle, userId, memberDiscord, roleId);

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'team.invite_sent + team.invite_accepted');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);

  await deleteUsers(handle, [memberDiscord]);
}

async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('seta-m');
  const expiryDefault = declaredDefault(ctx.domain, 'invitation-expiry-ms');

  const roleId = await seedRole(handle, `${ctx.runPrefix}support`, ['dashboard.manage_tickets']);
  const userId = await ensureUser(handle, memberDiscord);
  if (userId && roleId) await seedAssignment(handle, userId, memberDiscord, roleId);

  ctx.gate(
    'Discord',
    'db-observable',
    `A pending invitation transitions to expired exactly once after its configured window (default ${JSON.stringify(expiryDefault)} ms), then grants nothing.`,
    'the invitation row, expiry column, and periodic sweeper exist; proving the shortened expiry requires saving the dashboard setting, creating a real invitation, running the live sweep, and reading back the terminal state',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated late-accept attempts on an expired invitation remain rejected with zero grants.',
    'the durable invitation expiry lifecycle exists, but proving repeated late acceptance requires an authenticated dashboard attempt after the real expiry sweep runs',
  );

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'team.invite_expired');
  gateLiveGuildReadback(ctx);

  await deleteUsers(handle, [memberDiscord]);
}

async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('setb-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}editor`, ['dashboard.manage_automations']);
  const userId = await ensureUser(handle, memberDiscord);
  if (userId && roleId) await seedAssignment(handle, userId, memberDiscord, roleId);

  ctx.gate(
    'Discord',
    'discord-readback',
    'With invite-dm-enabled false, sending an invitation delivers NO DM; the invitee discovers and accepts it on dashboard sign-in.',
    'invite-dm-enabled is persisted and enforced by the invitation flow; proving DM suppression requires DISCORD_TOKEN plus the authenticated dashboard invitation path and live invitee readback',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The invitation row records the dm-disabled delivery mode.',
    'the invitation model persists the DM preference; proving the stored delivery choice requires the authenticated dashboard invitation flow and database readback',
  );

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'team.invite_sent (no DM-delivery event)');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  gateLiveGuildReadback(ctx);

  await deleteUsers(handle, [memberDiscord]);
}

/** INVALID — malformed invitations are rejected atomically with no row created.
 *  The route's Zod validation (snowflake / uuid / cross-guild role / pending cap)
 *  is HTTP-layer and undrivable; the DB's own atomic rejection of a DUPLICATE
 *  assignment (UNIQUE) is the real, DB-observable analog and is proven live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('inv-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}analyst`, ['dashboard.view_analytics']);
  const userId = await ensureUser(handle, memberDiscord);
  const first = userId && roleId ? await seedAssignment(handle, userId, memberDiscord, roleId) : { code: 'setup' };
  const dup = userId && roleId ? await seedAssignment(handle, userId, memberDiscord, roleId) : null;
  const countAfter = userId && roleId ? await assignmentCount(handle, roleId, userId) : -1;

  ctx.expect(first === null && dup !== null && countAfter === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A rejected (duplicate) assignment request is rejected atomically — the row count is unchanged, no partial write.',
    observation:
      `first insert error=${first === null ? 'none' : JSON.stringify(first)}; duplicate insert error code=${dup?.code ?? 'none'}; ` +
      `assignment rows after the rejected duplicate = ${countAfter} (expected 1).`,
    impact: 'A duplicate/invalid assignment either double-wrote or was not rejected atomically — the UNIQUE(guild_id,user_id,role_id) guard failed.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-snowflake discord id, a role id from another guild, or exceeding max-pending-invitations each returns 400/409 with no invitation row and no DM.',
    'these rejections are enforced in the dashboard route (Zod + the role guild-match + pending-cap checks); a bot-only harness cannot invoke the HTTP route',
  );

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'validation rejection (no invitation artifact)');
  gateLiveGuildReadback(ctx);

  await deleteUsers(handle, [memberDiscord]);
}

/** UNAUTH — only manage_team holders can invite; only the invitee can accept.
 *  RBAC + accept-binding are dashboard-session enforcement (undrivable); the
 *  real DB-observable guarantee is that anon/authenticated cannot touch the
 *  assignment table at all (v6 hardening) — proven live as the positive control. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('unauth-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}mod2`, ['dashboard.manage_moderation']);
  const userId = await ensureUser(handle, memberDiscord);
  if (userId && roleId) await seedAssignment(handle, userId, memberDiscord, roleId);

  // The core UNAUTH guarantee that IS DB-observable: the assignment table is
  // service-role-only, so no anon/authenticated actor can read or grant.
  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');

  ctx.gate(
    'Discord',
    'discord-readback',
    'A support-role member’s invite attempt returns 403; a different signed-in user accepting someone else’s invitation gets 403/404 and grants nothing.',
    'invite authorization (requirePermission dashboard.manage_team + role-priority ceiling) and accept-binding (session OAuth id must equal the invited discord id) are enforced in the dashboard session layer — not reachable in a bot-only harness',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A foreign-accept attempt raises an owner notification.',
    'requires the dashboard accept path plus the live owner notification channel readback',
  );

  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'denied invite / denied foreign-accept (actor id logged)');
  gateReplayDeferredTo(ctx, 'REPLAY');

  await deleteUsers(handle, [memberDiscord]);
}

async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  ctx.gate(
    'Discord',
    'discord-readback',
    'When the invitee’s DMs are closed the DM send fails; the invitation stays pending and the member can still accept via the dashboard link.',
    'requires a real Discord DM failure plus readback of the durable pending invitation through the authenticated dashboard flow; neither live surface is reachable in this bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The invitation row records the failed delivery and remains pending.',
    'the durable invitation records pending delivery failure; proving it requires driving the real failed DM branch and reading the invitation back from Supabase',
  );
  gateAudit(ctx, 'team.invite_dm_failed');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The DM-failure mirror reaches the owner exactly once.',
    'requires the DM-failure path + live owner notification channel readback',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The share-link fallback copy is helpful and branded (invitation-dm-failed template), not an error dump.',
    'requires the dashboard Team-page fallback render + the DM-failure branch',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Resending the DM later does not create a second invitation.',
    'the resend path reuses the durable pending invitation; proving it requires a real DM failure followed by the authenticated dashboard resend action and database readback',
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'The pending invitation is removed at teardown.',
    'requires creating the real pending invitation through the dashboard, then running cleanup and confirming its row is gone',
  );
}

/** RETRY — a transient DB failure during acceptance converges to exactly one
 *  assignment (never half-accepted). Needs a mid-write fault-injection lane AND
 *  the accept flow; fully GATED. Convergence-to-one is separately proven at the
 *  DB layer (UNIQUE) in REPLAY / RACE. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  ctx.gate(
    'Discord',
    'db-observable',
    'An acceptance whose DB write transiently fails is retried and yields exactly one assignment and one accepted invitation.',
    'requires a mid-acceptance database fault lane plus the authenticated dashboard accept flow to exercise the atomic invitation-acceptance RPC',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Exactly one assignment row and one accepted invitation row exist after the retry.',
    'requires the fault-injection lane + the invitation lifecycle; DB convergence-to-one is proven via UNIQUE in REPLAY / RACE',
  );
  gateAudit(ctx, 'failed attempt + successful acceptance (distinct rows)');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner acceptance mirror is delivered exactly once, not per retry.',
    'requires the accept flow + live owner channel readback',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'Interim retry copy stays calm and branded.',
    'requires the dashboard accept UI + the fault-injection lane',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried acceptance is idempotent on the final state.',
    'requires the fault-injection lane; DB-level idempotency is proven in REPLAY / RACE',
  );
}

/** REPLAY — replaying an acceptance never duplicates the grant. Proven live via
 *  the UNIQUE(guild_id,user_id,role_id) constraint: a second identical insert is
 *  rejected and the count stays one. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('replay-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}mod3`, ['dashboard.manage_moderation']);
  const userId = await ensureUser(handle, memberDiscord);

  const first = userId && roleId ? await seedAssignment(handle, userId, memberDiscord, roleId) : { code: 'setup' };
  const replay = userId && roleId ? await seedAssignment(handle, userId, memberDiscord, roleId) : null;
  const count = userId && roleId ? await assignmentCount(handle, roleId, userId) : -1;

  ctx.expect(first === null && replay?.code === '23505' && count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-applying the same acceptance (guild_id + user_id + role_id) leaves exactly one assignment — the replay is a no-op.',
    observation:
      `first insert error=${first === null ? 'none' : JSON.stringify(first)}; ` +
      `replayed insert error code=${replay?.code ?? 'none'} (expected 23505 unique_violation); ` +
      `assignment rows after replay = ${count} (expected 1).`,
    impact: 'A replayed acceptance duplicated the grant — the UNIQUE(guild_id,user_id,role_id) idempotency guard did not hold.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'A replayed accept shows an already-accepted notice; accepting a revoked invitation shows a revoked notice.',
    'the friendly already-accepted and revoked notices are authenticated dashboard renders that require a real invitation transition and browser capture',
  );

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'replay recorded as a no-op (not a second acceptance)');

  await deleteUsers(handle, [memberDiscord]);
}

async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const memberDiscord = ctx.userId('restart-m');

  const first = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const roleId = await seedRole(first, `${ctx.runPrefix}mod4`, ['dashboard.manage_moderation']);
  const userId = await ensureUser(first, memberDiscord);
  if (userId && roleId) await seedAssignment(first, userId, memberDiscord, roleId);
  const snapshot = roleId && userId ? await readAssignment(first, roleId, userId) : null;
  await first.cleanup(); // simulate shutdown

  const second = await ctx.bootGuild({ guildId, label: 'a', economyEnabled: false });
  const afterRestart = roleId && userId ? await readAssignment(second, roleId, userId) : null;
  ctx.expect(
    snapshot !== null && afterRestart !== null && afterRestart.id === snapshot.id && afterRestart.role_id === roleId,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'After a full stack restart the grant is unchanged (the assignment row survives, same id and role).',
      observation:
        `pre-restart assignment id=${snapshot?.id ?? '(none)'}; ` +
        `post-restart assignment id=${afterRestart?.id ?? '(none)'}, role_id match=${afterRestart?.role_id === roleId}.`,
      impact: 'A dashboard grant did not survive a restart — persisted RBAC state was lost or altered.',
    },
  );

  ctx.gate(
    'Discord',
    'discord-readback',
    'A pending invitation created before restart is still pending and acceptable after, with its original expiry timestamp honored (not reset), and no DM is re-sent.',
    'requires creating a real pending invitation through the dashboard, restarting the deployed stack, and reading back its original expiry plus DM state; only the assignment persistence is observable in this bot-only harness',
  );

  await proveRlsIsolation(ctx, second, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, second);
  gateBranding(ctx);
  gateAudit(ctx, 'no spurious invitation events around the restart');
  gateReplayDeferredTo(ctx, 'REPLAY');

  await deleteUsers(second, [memberDiscord]);
}

/** RACE — a concurrent accept-vs-revoke settles in exactly one terminal state.
 *  The accept/revoke dashboard concurrency is undrivable; the DB-level guarantee
 *  that concurrent identical grants collapse to one row (UNIQUE) is proven live
 *  by racing two identical inserts. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('race-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}mod5`, ['dashboard.manage_moderation']);
  const userId = await ensureUser(handle, memberDiscord);

  const [r1, r2] =
    userId && roleId
      ? await Promise.all([
          seedAssignment(handle, userId, memberDiscord, roleId),
          seedAssignment(handle, userId, memberDiscord, roleId),
        ])
      : [{ code: 'setup' }, { code: 'setup' }];
  const count = userId && roleId ? await assignmentCount(handle, roleId, userId) : -1;
  const oneSucceeded = (r1 === null) !== (r2 === null); // exactly one insert won
  const oneConflicted = r1?.code === '23505' || r2?.code === '23505';

  ctx.expect(oneSucceeded && oneConflicted && count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two concurrent identical grants settle in exactly one terminal effect — one insert wins, the other is rejected, one row exists.',
    observation:
      `insert A error=${r1?.code ?? 'none'}, insert B error=${r2?.code ?? 'none'} ` +
      `(exactly one 23505 unique_violation expected); assignment rows after the race = ${count} (expected 1).`,
    impact: 'A concurrent double-grant produced two rows (or lost both) — the UNIQUE(guild_id,user_id,role_id) guard did not serialize the race.',
  });

  ctx.gate(
    'Discord',
    'discord-readback',
    'An invitee accepting while the inviter revokes concurrently ends in exactly one of accepted/revoked; the losing actor sees a clear branded notice.',
    'the atomic accept-vs-revoke state machine and losing-actor notice require concurrent authenticated dashboard actions plus database and browser readback',
  );

  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx, 'both attempts logged; exactly one applied transition');

  await deleteUsers(handle, [memberDiscord]);
}

/** XGUILD — invitations/grants are strictly guild-scoped. Proven live: the same
 *  member is granted DISTINCT roles in guild A and guild B, and each guild scope
 *  reads only its own assignment; anon reads neither. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const memberDiscord = ctx.userId('xg-m');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyEnabled: false });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyEnabled: false });

  const roleA = await seedRole(handleA, `${ctx.runPrefix}mod-a`, ['dashboard.manage_moderation']);
  const roleB = await seedRole(handleB, `${ctx.runPrefix}mod-b`, ['dashboard.manage_tickets']);
  const userId = await ensureUser(handleA, memberDiscord); // one identity, two guilds
  if (userId && roleA) await seedAssignment(handleA, userId, memberDiscord, roleA);
  if (userId && roleB) await seedAssignment(handleB, userId, memberDiscord, roleB);

  // Each guild scope reads its OWN assignment row and never the other guild's.
  const { data: aScoped } = await handleA.supabase
    .from('dashboard_user_roles')
    .select('role_id, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userId ?? '')
    .maybeSingle();
  const { data: bScoped } = await handleB.supabase
    .from('dashboard_user_roles')
    .select('role_id, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userId ?? '')
    .maybeSingle();
  const aRow = aScoped as { role_id: string; guild_id: string } | null;
  const bRow = bScoped as { role_id: string; guild_id: string } | null;
  // Cross-guild leakage probe: guild B scoped to guild A's role id returns nothing.
  const { count: crossCount } = await handleB.supabase
    .from('dashboard_user_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildB)
    .eq('role_id', roleA ?? '');

  ctx.expect(
    aRow?.guild_id === guildA &&
      aRow?.role_id === roleA &&
      bRow?.guild_id === guildB &&
      bRow?.role_id === roleB &&
      (crossCount ?? 0) === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A grant in guild A is invisible in guild B: each guild scope reads only its own assignment and cross-guild queries return zero.',
      observation:
        `guild-A scope → role ${aRow?.role_id} under "${aRow?.guild_id}"; ` +
        `guild-B scope → role ${bRow?.role_id} under "${bRow?.guild_id}"; ` +
        `guild B queried for guild A's role id returned ${crossCount ?? 0} row(s) (expected 0).`,
      impact: 'A cross-guild query returned another guild’s assignment — per-guild RBAC isolation is broken.',
    },
  );

  ctx.expect(aRow?.role_id !== bRow?.role_id, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'The same member’s two guild grants are distinct rows under distinct guild_ids — neither guild sees the other’s.',
    observation: `guild A role_id=${aRow?.role_id}, guild B role_id=${bRow?.role_id} (distinct rows under "${guildA}" vs "${guildB}").`,
    impact: 'The two per-guild grants collapsed into one — guild scoping leaked.',
  });

  await proveRlsIsolation(ctx, handleA, roleA ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handleA);
  gateBranding(ctx);
  gateAudit(ctx, 'all invitation events logged under guild A only');
  gateReplayDeferredTo(ctx, 'REPLAY');
  gateLiveGuildReadback(ctx);

  await deleteUsers(handleA, [memberDiscord]);
}

/** CLEANUP — the suite leaves no trace: run-prefixed roles + assignments are
 *  removed by the guild sweep and the seeded identity rows by the script; audit
 *  history is retained (anonymize-over-delete). Verified all absent live. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', economyEnabled: false });
  const memberDiscord = ctx.userId('cleanup-m');

  const roleId = await seedRole(handle, `${ctx.runPrefix}mod6`, ['dashboard.manage_moderation']);
  const userId = await ensureUser(handle, memberDiscord);
  if (userId && roleId) await seedAssignment(handle, userId, memberDiscord, roleId);

  const rolesBefore = await guildTableCount(handle, 'dashboard_roles');
  const assignmentsBefore = await guildTableCount(handle, 'dashboard_user_roles');
  ctx.expect(rolesBefore >= 1 && assignmentsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed role + assignment rows (pre-cleanup baseline).',
    observation: `pre-cleanup: dashboard_roles=${rolesBefore}, dashboard_user_roles=${assignmentsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, roleId ?? '', userId ?? '');
  await proveOwnerNotification(ctx, handle);

  // Run the surgical guild sweep (the same one teardown uses) then verify zero.
  await ctx.sweepGuildRows(handle);
  await deleteUsers(handle, [memberDiscord]); // identity rows are not guild-scoped
  const rolesAfter = await guildTableCount(handle, 'dashboard_roles');
  const assignmentsAfter = await guildTableCount(handle, 'dashboard_user_roles');
  const usersAfter = await usersRemaining(handle, [memberDiscord]);
  ctx.expect(rolesAfter === 0 && assignmentsAfter === 0 && usersAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed roles, assignments, and seeded identity rows are removed; a final sweep finds zero run-prefixed team resources.',
    observation: `post-sweep: dashboard_roles=${rolesAfter}, dashboard_user_roles=${assignmentsAfter}, seeded users=${usersAfter}.`,
    impact: 'The cleanup sweep left run-prefixed team rows behind — the suite leaves residue.',
  });

  gateBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard Team page shows no run-prefixed members or invitations after teardown.',
    'requires a dashboard-session render of the Team page (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Run audit rows persist through cleanup (anonymize-over-delete); none are deleted.',
    'team.* audit rows are written by the invitation flow; proving anonymize-over-delete retention requires real dashboard invitation transitions followed by the cleanup and audit readback lanes',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The administration-team-management proof. `guildScopedTables` lists the
 * guild_id-scoped tables the sweep must clear in child→parent order
 * (dashboard_user_roles FKs dashboard_roles ON DELETE CASCADE). The `users` rows
 * an assignment requires are NOT guild-scoped, so each script deletes its own via
 * `deleteUsers`; `audit_logs` is intentionally NOT swept (anonymize-over-delete).
 */
export const administrationTeamManagementProof: DomainProof = {
  domainId: 'administration-team-management',
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
