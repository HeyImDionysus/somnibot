/**
 * scenario-runner/scripts/community-reaction-roles — the Reaction Roles domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts against LOCAL Supabase. Unlike the wallet-rewards domain (whose
 * slash commands write straight through `client.supabase`), reaction roles is
 * driven ENTIRELY by Discord component/reaction interactions:
 *   - Buttons  → `handleButtonRoleInteraction` (features/reaction-roles/button-roles.ts)
 *     toggles the role with `guild.members.fetch(...).roles.add/remove` and an
 *     ephemeral `interaction.reply`.
 *   - Reactions → `handleReactionAdd/Remove` (features/reaction-roles/reaction-engine.ts)
 *     reads a VALKEY-cached binding, then grants/removes via `member.roles.add/remove`.
 * There is NO reaction-roles slash command, and role grants are never persisted to
 * a DB "grants" table — they live in Discord. The gateway-less bot-only harness
 * boots a minimal guild with EMPTY member/role caches (live-runner.makeMinimalGuild)
 * and no Valkey, so NONE of the grant/toggle/gate/swap behavior — nor the ephemeral
 * replies the branding class inspects — can be driven here. That behavior is GATED
 * honestly behind DISCORD_TOKEN + a live guild (+ Valkey for the reaction engine).
 *
 * What DOES run now, real and non-vacuous, is everything the DASHBOARD persists and
 * the DATABASE enforces about a published binding — the reaction_roles / button_roles
 * config rows (both locked to service_role only by the W2 RLS-pattern sweep):
 *   - a published binding stores its role mappings, guild-scoped and active;
 *   - the reaction-binding removal default equals the catalog remove-on-unreact default;
 *   - the button_roles `style` CHECK and reaction_roles UNIQUE(message_id, emoji)
 *     reject malformed/duplicate bindings atomically (INVALID);
 *   - anon clients read/write ZERO binding rows while the service role sees them
 *     (database-RLS, positive-control paired);
 *   - two guilds keep strictly distinct binding rows (XGUILD);
 *   - binding config survives a full stack restart (RESTART);
 *   - the run-prefixed sweep removes every binding row (CLEANUP).
 *
 * mostlyGated = true: this domain's contracted BEHAVIOR is Discord-interaction and
 * Valkey heavy, so most cells GATE. Every gate carries a precise reason; no cell is
 * ever forced green and no synthetic literal is ever asserted.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface ReactionRoleRow {
  id: string;
  guild_id: string | null;
  message_id: string;
  emoji: string;
  role_id: string;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  max_per_group: number | null;
  remove_on_unreact: boolean;
  active: boolean;
}

interface ButtonRoleRow {
  id: string;
  guild_id: string | null;
  panel_id: string;
  role_id: string;
  label: string;
  style: string;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  active: boolean;
  message_id: string | null;
}

/** A PostgREST error, narrowed to the fields the proofs read. */
interface InsertError {
  message: string;
  code?: string;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** Insert a run-prefixed button-roles panel (simulates the dashboard publish). */
async function seedButtonPanel(
  handle: LiveClientHandle,
  panelId: string,
  channelId: string,
  entries: ReadonlyArray<{
    roleId: string;
    label: string;
    style?: string;
    exclusiveGroup?: string | null;
    requireRole?: string | null;
    requireLevel?: number | null;
    sortOrder?: number;
    messageId?: string | null;
  }>,
): Promise<void> {
  const rows = entries.map((e, i) => ({
    guild_id: handle.guildId,
    panel_id: panelId,
    channel_id: channelId,
    message_id: e.messageId ?? null,
    label: e.label,
    style: e.style ?? 'primary',
    role_id: e.roleId,
    sort_order: e.sortOrder ?? i,
    exclusive_group: e.exclusiveGroup ?? null,
    require_role: e.requireRole ?? null,
    require_level: e.requireLevel ?? null,
    active: true,
  }));
  await handle.supabase.from('button_roles').insert(rows);
}

async function readButtonRoles(handle: LiveClientHandle, panelId: string): Promise<ButtonRoleRow[]> {
  const { data } = await handle.supabase
    .from('button_roles')
    .select(
      'id, guild_id, panel_id, role_id, label, style, exclusive_group, require_role, require_level, active, message_id',
    )
    .eq('guild_id', handle.guildId)
    .eq('panel_id', panelId);
  return (data as ButtonRoleRow[] | null) ?? [];
}

/**
 * Insert a reaction-style binding. `removeOnUnreact` is OMITTED unless supplied so
 * the DB DEFAULT applies (the DEF scenario asserts that default equals the catalog
 * remove-on-unreact default). Returns the raw insert error so INVALID can prove the
 * UNIQUE(message_id, emoji) constraint fires.
 */
async function seedReactionBinding(
  handle: LiveClientHandle,
  args: {
    channelId: string;
    messageId: string;
    emoji: string;
    roleId: string;
    exclusiveGroup?: string | null;
    requireRole?: string | null;
    requireLevel?: number | null;
    maxPerGroup?: number | null;
    removeOnUnreact?: boolean;
  },
): Promise<{ error: InsertError | null }> {
  const row: Record<string, unknown> = {
    guild_id: handle.guildId,
    channel_id: args.channelId,
    message_id: args.messageId,
    emoji: args.emoji,
    role_id: args.roleId,
    exclusive_group: args.exclusiveGroup ?? null,
    require_role: args.requireRole ?? null,
    require_level: args.requireLevel ?? null,
    max_per_group: args.maxPerGroup ?? null,
    active: true,
  };
  if (args.removeOnUnreact !== undefined) row.remove_on_unreact = args.removeOnUnreact;
  const { error } = await handle.supabase.from('reaction_roles').insert(row);
  return { error: error ? { message: error.message, code: (error as { code?: string }).code } : null };
}

async function readReactionRole(
  handle: LiveClientHandle,
  messageId: string,
  emoji: string,
): Promise<ReactionRoleRow | null> {
  const { data } = await handle.supabase
    .from('reaction_roles')
    .select(
      'id, guild_id, message_id, emoji, role_id, exclusive_group, require_role, require_level, max_per_group, remove_on_unreact, active',
    )
    .eq('guild_id', handle.guildId)
    .eq('message_id', messageId)
    .eq('emoji', emoji)
    .maybeSingle();
  return (data as ReactionRoleRow | null) ?? null;
}

async function countBindings(handle: LiveClientHandle): Promise<{ buttons: number; reactions: number }> {
  const { count: b } = await handle.supabase
    .from('button_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  const { count: r } = await handle.supabase
    .from('reaction_roles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return { buttons: b ?? 0, reactions: r ?? 0 };
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
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
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (post-lockdown these tables revoke anon → 0 via a
 * 42501 permission-denied), or null when inconclusive (→ GATE).
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
    // Non-2xx: SQLSTATE 42501 "permission denied for table" (the anon role is
    // revoked by the lockdown — the deny we want) vs a rejected key before authz
    // (inconclusive → GATE).
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

/**
 * Anon-WRITE denial probe: attempt an anon INSERT via PostgREST. Returns true when
 * the write is DENIED (401/403 or SQLSTATE 42501), false when it unexpectedly
 * SUCCEEDS (2xx — an exposure), or null when inconclusive (e.g. a NOT NULL / schema
 * error raised before authz ran → GATE).
 */
async function anonInsertDenied(
  anonKey: string,
  table: string,
  body: Record<string, unknown>,
): Promise<boolean | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/rest/v1/${table}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) return true;
    if (res.ok) return false;
    let parsed: { code?: string; message?: string } = {};
    try {
      parsed = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (parsed.code === '42501' || (parsed.message ?? '').toLowerCase().includes('permission denied')) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

/** Every member-facing text surface of a captured reply (content + embed). */
function brandingSurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const reply = captured.find('reply');
  const content = payloadText(reply?.payload);
  if (content) parts.push(content);
  const embed = (reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined)?.embeds?.[0]
    ?.data;
  if (embed) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
  }
  return parts.join('\n');
}

/**
 * Branding is checked against a REAL captured reply when one exists; in this
 * gateway-less harness the reaction-role handlers never run, so no member-facing
 * reply is producible and branding GATEs (never a hollow PASS).
 */
function proveBranding(ctx: ScenarioContext, captured: CapturedResponse | null): void {
  const surface = captured ? brandingSurface(captured) : '';
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      "Every member-facing reaction-role surface shows the owner's configured brand name and voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.",
      'reaction-role feedback is an ephemeral reply to a live button/select interaction (or a silent grant for the reaction style); no member-facing reply is producible in the gateway-less bot-only harness',
    );
  } else {
    ctx.expect(!/\bdiscord\.js\b|stock-bot/i.test(surface), {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'The reaction-role reply is rendered in the owner voice with no stock-bot wording.',
      observation: `captured reaction-role reply surface = "${surface.slice(0, 90)}".`,
      impact: 'A reaction-role reply leaked stock-bot wording instead of the owner brand voice.',
    });
  }
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on the captured reaction-role embeds/messages.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/** A happy path raises no owner alert (real read of the alerts table). */
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
    promise: "This scenario's happy path raises no owner (binding-alert) notification.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a reaction-roles happy path — a false alarm / notification noise.',
  });
}

/**
 * The service role reads this guild's binding row while an anon client reads zero
 * (positive-control-paired: the scenario has really seeded the row). Made against a
 * concrete table (button_roles / reaction_roles), both locked to service_role only.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  serviceSeesRow: boolean,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (post-lockdown ${table} is service_role-only).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon clients read zero ${table} rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceSeesRow && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} binding row while an anon client reads zero of them (post-lockdown ${table} is service_role-only).`,
    observation:
      `service-role sees the seeded binding under guild "${handle.guildId}" (${serviceSeesRow}); ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} binding row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct config exposure).`,
  });
}

/** Gate the interactive grant/toggle behavior (needs a live guild member + Valkey). */
function gateInteractiveDiscord(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'reaction-role grants/removals run through discord.js member.roles.add/remove against a live guild member (buttons) or the Valkey-cached reaction engine — neither is reachable in the gateway-less bot-only harness',
  );
}

/** Gate the append-only audit row (no reaction-role action can run to write one). */
function gateAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'a reaction-role audit row is written only when a grant/removal/degrade actually runs (or by the dashboard save path); none of those are reachable in the bot-only harness, and grant history lives in Discord, not a DB grants table',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    "Re-delivering this scenario's triggering events yields no duplicate role grants, removals, or feedback replies.",
    `replay/idempotency of reaction-role interactions requires the live event re-delivery harness (${where}); no DB idempotency-key row exists to read in the bot-only harness`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a published default-style (buttons) binding stores its toggle config. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleOne = `${ctx.runPrefix}role-1`;
  const roleTwo = `${ctx.runPrefix}role-2`;

  // The owner publishes a default-style (buttons) binding with two roles. The
  // dashboard writes button_roles; assert exactly those two mappings persisted,
  // guild-scoped and active — the state a live click would toggle against.
  await seedButtonPanel(handle, panelId, channelId, [
    { roleId: roleOne, label: 'Role One', style: 'primary', sortOrder: 0 },
    { roleId: roleTwo, label: 'Role Two', style: 'secondary', sortOrder: 1 },
  ]);
  const panel = await readButtonRoles(handle, panelId);
  ctx.expect(
    panel.length === 2 &&
      panel.every((r) => r.guild_id === handle.guildId && r.active === true) &&
      panel.some((r) => r.role_id === roleOne) &&
      panel.some((r) => r.role_id === roleTwo),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A published default-style (buttons) binding stores exactly its two role mappings, guild-scoped and active, ready to serve toggles.',
      observation: `button_roles rows=${panel.length} under guild "${handle.guildId}"; roles=[${panel.map((r) => r.role_id).join(', ')}].`,
      impact: 'The published buttons binding did not persist its two role mappings as configured.',
    },
  );

  // A reaction-style binding seeded WITHOUT remove_on_unreact takes the schema
  // DEFAULT, which must equal the catalog remove-on-unreact default (symmetric
  // toggle: unreacting removes the role). This FAILs if the schema drifts from the
  // catalog contract.
  const emoji = '✅';
  const messageId = `${ctx.runPrefix}rmsg`;
  const { error: rErr } = await seedReactionBinding(handle, { channelId, messageId, emoji, roleId: roleOne });
  const rr = await readReactionRole(handle, messageId, emoji);
  const catalogRemoveDefault = declaredDefault(ctx.domain, 'remove-on-unreact');
  ctx.expect(rErr === null && rr !== null && rr.remove_on_unreact === (catalogRemoveDefault === true), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `A reaction-style binding defaults remove_on_unreact to the catalog remove-on-unreact default (${String(catalogRemoveDefault)}) — removing the reaction removes the role.`,
    observation: `insert error=${rErr ? rErr.message : 'none'}; reaction_roles.remove_on_unreact=${rr?.remove_on_unreact}; catalog default=${String(catalogRemoveDefault)}.`,
    impact: 'The reaction-binding removal default diverged from the catalog remove-on-unreact default (asymmetric toggle out of the box).',
  });

  // The actual click/react grant + branded ephemeral is a live-guild + Valkey path.
  gateInteractiveDiscord(
    ctx,
    'A member clicking the buttons binding is granted the run role with a branded ephemeral and toggled off on a second click; the reaction binding grants on react and removes on unreact.',
  );
  gateAudit(ctx, 'Each grant/removal in this scenario lands exactly one append-only audit row with actor, guild, and correlation id.');

  await proveRlsIsolation(ctx, handle, 'button_roles', panel.length > 0);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — an exclusive-group-capped-at-one binding persists its swap config. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleA = `${ctx.runPrefix}color-a`;
  const roleB = `${ctx.runPrefix}color-b`;
  const group = `${ctx.runPrefix}colors`;

  // Dashboard config: two color roles in ONE exclusive group. This is the config
  // the engine reads to swap picks instead of stacking them.
  await seedButtonPanel(handle, panelId, channelId, [
    { roleId: roleA, label: 'Color A', style: 'primary', exclusiveGroup: group, sortOrder: 0 },
    { roleId: roleB, label: 'Color B', style: 'primary', exclusiveGroup: group, sortOrder: 1 },
  ]);
  const panel = await readButtonRoles(handle, panelId);
  const grouped = panel.filter((r) => r.exclusive_group === group);
  ctx.expect(
    grouped.length === 2 &&
      grouped.every((r) => r.guild_id === handle.guildId) &&
      grouped.some((r) => r.role_id === roleA) &&
      grouped.some((r) => r.role_id === roleB),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A dashboard-configured exclusive group persists both color roles under one exclusive_group — the config the engine reads to swap (not stack) picks.',
      observation: `button_roles rows in group "${group}" = ${grouped.length}; roles=[${grouped.map((r) => r.role_id).join(', ')}].`,
      impact: 'The exclusive-group configuration did not persist — a saved dashboard grouping was lost.',
    },
  );

  // The actual swap (pick B while holding A → holds only B, with the
  // exclusive-swapped ephemeral naming both) is a live-guild member-roles path.
  gateInteractiveDiscord(
    ctx,
    'After picking Color A then Color B, the member holds only Color B and receives the exclusive-swapped ephemeral naming both roles; the group never holds two.',
  );
  gateAudit(ctx, 'The swap records append-only audit rows for the removal and the grant with actor and guild.');

  await proveRlsIsolation(ctx, handle, 'button_roles', grouped.length > 0);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — a level+role-gated, remove-on-unreact-off binding persists its config. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const channelId = `${ctx.runPrefix}chan`;
  const messageId = `${ctx.runPrefix}gate-msg`;
  const emoji = '🔒';
  const roleGated = `${ctx.runPrefix}gated-role`;
  const requireRole = `${ctx.runPrefix}required-role`;
  const requireLevel = 5;

  // A second distinct configuration: a level-5 gate + a required role, and
  // remove_on_unreact=OFF (unreacting keeps the role). Assert every gate column
  // persisted exactly — the config the engine checks per interaction.
  const { error: sErr } = await seedReactionBinding(handle, {
    channelId,
    messageId,
    emoji,
    roleId: roleGated,
    requireLevel,
    requireRole,
    removeOnUnreact: false,
  });
  const rr = await readReactionRole(handle, messageId, emoji);
  ctx.expect(
    sErr === null &&
      rr !== null &&
      rr.require_level === requireLevel &&
      rr.require_role === requireRole &&
      rr.remove_on_unreact === false,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A gated binding persists require_level=5, its required role, and remove_on_unreact=false — the config the engine enforces per interaction.',
      observation: `insert error=${sErr ? sErr.message : 'none'}; require_level=${rr?.require_level}, require_role=${rr?.require_role === requireRole}, remove_on_unreact=${rr?.remove_on_unreact}.`,
      impact: 'A saved gate/removal configuration did not persist — the second dashboard configuration was lost.',
    },
  );

  // Enforcement (below-level member blocked with the gate-blocked ephemeral; a
  // qualifying member granted; role preserved after unreact) reads member_levels +
  // grants via a live guild member.
  gateInteractiveDiscord(
    ctx,
    'A level-0 member is blocked with the friendly gate-blocked ephemeral and no role; a qualifying member is granted; unreacting leaves the role in place (remove-on-unreact off).',
  );
  gateAudit(ctx, 'The gate block and the qualifying grant each land an append-only audit row with actor and guild.');

  await proveRlsIsolation(ctx, handle, 'reaction_roles', rr !== null);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — malformed/duplicate bindings are rejected atomically by DB constraints. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const messageId = `${ctx.runPrefix}inv-msg`;
  const emoji = '⭐';
  const roleOk = `${ctx.runPrefix}role-ok`;
  const roleOther = `${ctx.runPrefix}role-other`;

  // Baseline: one valid button binding + one valid reaction binding publish fine.
  await seedButtonPanel(handle, panelId, channelId, [{ roleId: roleOk, label: 'OK', style: 'primary' }]);
  const { error: validErr } = await seedReactionBinding(handle, { channelId, messageId, emoji, roleId: roleOk });

  // (1) A malformed style never publishes — the button_roles style CHECK rejects it.
  const { error: badStyleErr } = await handle.supabase.from('button_roles').insert({
    guild_id: handle.guildId,
    panel_id: panelId,
    channel_id: channelId,
    label: 'Bad',
    role_id: `${ctx.runPrefix}role-bad`,
    style: 'rainbow', // not in ('primary','secondary','success','danger')
    active: true,
  });
  ctx.expect(validErr === null && badStyleErr !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A binding with a malformed style never publishes — the button_roles style CHECK constraint rejects it atomically while the valid binding stands.',
    observation: `valid-binding error=${validErr ? validErr.message : 'none'}; malformed-style insert error=${badStyleErr ? ((badStyleErr as { code?: string }).code ?? badStyleErr.message) : 'NONE (accepted!)'}.`,
    impact: 'A malformed button-role style was accepted into button_roles — an invalid binding can publish.',
  });

  // (2) A duplicate (message_id, emoji) never publishes — the reaction_roles UNIQUE
  //     constraint rejects the second mapping atomically.
  const { error: dupErr } = await seedReactionBinding(handle, {
    channelId,
    messageId,
    emoji,
    roleId: roleOther, // same message+emoji, different role → UNIQUE violation
  });
  ctx.expect(dupErr !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A second binding on the same message+emoji never publishes — the reaction_roles UNIQUE(message_id, emoji) constraint rejects the duplicate atomically.',
    observation: `duplicate reaction-binding insert error=${dupErr ? (dupErr.code ?? dupErr.message) : 'NONE (accepted!)'}.`,
    impact: 'A duplicate reaction binding on one message+emoji was accepted — two conflicting mappings can publish.',
  });

  // No invalid/partial row persisted: only the two valid rows remain.
  const { buttons, reactions } = await countBindings(handle);
  ctx.expect(buttons === 1 && reactions === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A rejected invalid binding leaves the store byte-for-byte at its valid state; no partial/invalid row persists.',
    observation: `button_roles=${buttons} (expected 1 valid), reaction_roles=${reactions} (expected 1 valid).`,
    impact: 'A rejected invalid binding left a partial/invalid row behind — the reject was not atomic.',
  });

  // The dashboard-layer rejections (nonexistent role id, malformed emoji) live in
  // the Zod validation + the rejected-attempt audit row — not reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard reaction-roles page surfaces a clear validation error for a nonexistent role / malformed emoji, and the target channel receives no binding message.',
    'binding-shape validation beyond DB constraints (nonexistent role id, malformed emoji) lives in the dashboard Zod layer + a live channel post; not reachable in a bot-only harness',
  );
  gateAudit(ctx, 'One audit row records the rejected binding attempt with its validation reason (written by the dashboard save path).');

  await proveRlsIsolation(ctx, handle, 'button_roles', buttons > 0);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** UNAUTH — binding management is admin-only; anon cannot read or write bindings. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleLive = `${ctx.runPrefix}live-role`;

  // A live published binding exists.
  await seedButtonPanel(handle, panelId, channelId, [{ roleId: roleLive, label: 'Live', style: 'primary' }]);
  const before = await readButtonRoles(handle, panelId);

  // The admin-only guarantee is backed by RLS: after the W2 lockdown anon holds NO
  // privilege on button_roles, so an anon INSERT (a non-admin trying to create a
  // binding straight through PostgREST) is denied.
  const anonKey = ctx.capabilities.anonKey;
  if (anonKey) {
    const denied = await anonInsertDenied(anonKey, 'button_roles', {
      guild_id: handle.guildId,
      panel_id: `${ctx.runPrefix}anon-panel`,
      channel_id: channelId,
      label: 'Anon',
      role_id: `${ctx.runPrefix}anon-role`,
      style: 'primary',
    });
    if (denied === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'A non-admin (anon) client cannot create a button-roles binding.',
        'the anon INSERT probe was inconclusive (no SUPABASE_URL, a network error, or a pre-authz schema error)',
      );
    } else {
      ctx.expect(denied === true, {
        assertionClass: 'database-RLS',
        channel: 'db-rls',
        promise: 'A non-admin (anon) client cannot create a button-roles binding — the write is denied at the RLS/grant layer (the DB backing of the admin-only guarantee).',
        observation: `anon INSERT into button_roles was ${denied ? 'DENIED' : 'ACCEPTED (exposure!)'}.`,
        impact: 'An anon client could insert a reaction-role binding — binding management is not admin-only (privilege exposure).',
      });
    }
  } else {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'A non-admin (anon) client cannot create a button-roles binding.',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-write-denial probe was not exercised',
    );
  }

  // Live bindings behave exactly as before: the row is unchanged after the denied write.
  const after = await readButtonRoles(handle, panelId);
  ctx.expect(
    after.length === before.length && after.length === 1 && after[0]?.role_id === roleLive,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A denied non-admin write changes no binding row; the live binding is byte-identical afterward.',
      observation: `button_roles for the panel before=${before.length}, after=${after.length}; role=${after[0]?.role_id === roleLive}.`,
      impact: 'A binding row changed around a denied non-admin write — the admin-only invariant was breached.',
    },
  );

  // The dashboard session-auth refusal (a logged-in non-admin session) + its audited
  // denial run through the dashboard API, not reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard SESSION receives a permission error when it tries to create or edit a binding.',
    'the dashboard session-auth lane (a non-admin authenticated session) is not reachable in a bot-only harness',
  );
  gateAudit(ctx, 'The denied dashboard write is audited with actor and reason (written by the dashboard API).');

  await proveRlsIsolation(ctx, handle, 'button_roles', before.length > 0);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** DEPFAIL — missing-permission grant failure fails safe (Discord-fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleId = `${ctx.runPrefix}depfail-role`;

  // A published binding exists; its config stays guild-scoped through the fault
  // window (the one class observable without the live-guild fault lane).
  await seedButtonPanel(handle, panelId, channelId, [{ roleId, label: 'Grant Me', style: 'primary' }]);
  const panel = await readButtonRoles(handle, panelId);
  await proveRlsIsolation(ctx, handle, 'button_roles', panel.length > 0);

  // The fail-safe BEHAVIOR (a member's click gets a branded apology + no role, the
  // binding degrades, exactly one owner alert, then repair resumes service) needs
  // the bot to hit a Discord "missing Manage Roles" rejection — a live-guild fault
  // that this harness cannot inject.
  gateInteractiveDiscord(
    ctx,
    'With the bot missing Manage Roles, a member click yields a branded apology and no partial state; after the permission is restored a click grants normally.',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one binding-alert names the missing permission and the affected binding.',
    'requires a live-guild missing-permission fault plus owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  gateAudit(ctx, 'One reaction_roles.grant_permission_failed audit row records the failed grant with actor and guild.');
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** RETRY — a transient grant error converges to exactly one grant (fault lane). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleId = `${ctx.runPrefix}retry-role`;

  // The binding config is observable + guild-scoped; the retry BEHAVIOR is not.
  await seedButtonPanel(handle, panelId, channelId, [{ roleId, label: 'Retry Me', style: 'primary' }]);
  const panel = await readButtonRoles(handle, panelId);
  await proveRlsIsolation(ctx, handle, 'button_roles', panel.length > 0);

  // A first-attempt transient failure that retries to exactly one grant + one
  // confirmation requires injecting a transient fault at the member.roles.add call
  // on a live guild member — not reachable here (and the code path itself is only
  // observable once it runs).
  gateInteractiveDiscord(
    ctx,
    'With a transient fault on the first grant call, the retry succeeds; the member holds the role once and received exactly one confirmation.',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The interaction-scoped idempotency record shows a single applied grant despite the injected failure.',
    'requires the transient-grant fault lane on a live guild member; no DB idempotency-key row exists to read in the bot-only harness',
  );
  gateAudit(ctx, 'The grant retry lands exactly one reaction_roles.grant_retried / role-granted audit row (never two).');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A self-healing transient retry raises no owner alert.',
    'requires the transient-grant fault lane plus owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  proveBranding(ctx, null);
}

/** REPLAY — re-delivered click/reaction events grant nothing twice (re-delivery lane). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const messageId = `${ctx.runPrefix}replay-msg`;
  const emoji = '♻️';
  const roleId = `${ctx.runPrefix}replay-role`;

  // A published binding (button + reaction) exists; its config is observable.
  await seedButtonPanel(handle, panelId, channelId, [{ roleId, label: 'Once', style: 'primary', messageId }]);
  await seedReactionBinding(handle, { channelId, messageId, emoji, roleId });
  const reactionRow = await readReactionRole(handle, messageId, emoji);
  await proveRlsIsolation(ctx, handle, 'reaction_roles', reactionRow !== null);

  // The replay BEHAVIOR (re-delivering the recorded interaction + reaction-add
  // yields byte-identical member roles / no duplicate confirmation) needs the live
  // event re-delivery harness against a real guild member. Reaction roles persist
  // no DB idempotency-key row to read here.
  gateInteractiveDiscord(
    ctx,
    'After replaying the recorded click + reaction-add events, the member holds exactly one instance of the role and received no additional confirmations.',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Interaction and reaction dedupe keys show the replays were ignored as no-ops.',
    'requires the live event re-delivery harness against a real guild member; reaction roles persist no DB idempotency-key row to read in the bot-only harness',
  );
  gateAudit(ctx, 'A replayed interaction writes no additional audit row (exactly one per logical action).');

  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
}

/** RESTART — binding config survives a full stack restart (DB-observable). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const messageId = `${ctx.runPrefix}restart-msg`;
  const roleId = `${ctx.runPrefix}restart-role`;

  // Boot #1: publish a binding whose message id is fixed, snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await seedButtonPanel(first, panelId, channelId, [{ roleId, label: 'Persist', style: 'primary', messageId }]);
  const snapshot = await readButtonRoles(first, panelId);
  await first.cleanup(); // simulate shutdown (rows live in Supabase, not the process)

  // Boot #2: SAME guild id. The binding must serve from the SAME message id with no
  // republish — its config lives in Supabase and is unchanged.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readButtonRoles(second, panelId);
  ctx.expect(
    afterRestart.length === 1 &&
      afterRestart.length === snapshot.length &&
      afterRestart[0]?.role_id === roleId &&
      afterRestart[0]?.message_id === messageId,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the pre-restart binding still serves from the SAME message id with no republish and no duplicate row.',
      observation: `pre-restart rows=${snapshot.length} (msg=${snapshot[0]?.message_id}); post-restart rows=${afterRestart.length} (msg=${afterRestart[0]?.message_id}, role=${afterRestart[0]?.role_id === roleId}).`,
      impact: 'Binding config did not survive a restart — a published binding was lost, altered, or duplicated.',
    },
  );

  // Re-serving the pre-restart message (a live click still toggles) + the Valkey
  // cache reload are the live-guild parts.
  gateInteractiveDiscord(
    ctx,
    'Clicking the pre-restart binding message still toggles roles correctly after restart, and the channel contains no duplicate binding message.',
  );
  gateAudit(ctx, 'Post-restart grants continue to land append-only audit rows with actor and guild.');

  await proveRlsIsolation(ctx, second, 'button_roles', afterRestart.length > 0);
  await proveNoOwnerAlert(ctx, second);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** RACE — concurrent interactions resolve to one coherent state (live-guild lane). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleA = `${ctx.runPrefix}race-a`;
  const roleB = `${ctx.runPrefix}race-b`;
  const group = `${ctx.runPrefix}race-group`;

  // An exclusive-group binding is the config a racing pair of picks resolves against.
  await seedButtonPanel(handle, panelId, channelId, [
    { roleId: roleA, label: 'A', style: 'primary', exclusiveGroup: group, sortOrder: 0 },
    { roleId: roleB, label: 'B', style: 'primary', exclusiveGroup: group, sortOrder: 1 },
  ]);
  const panel = await readButtonRoles(handle, panelId);
  await proveRlsIsolation(ctx, handle, 'button_roles', panel.length > 0);

  // A rapid click storm / two concurrent exclusive picks resolving to exactly one
  // held role is a concurrency property of member.roles.add/remove on a live guild
  // member (plus the reaction engine's Valkey cache) — not reachable here.
  gateInteractiveDiscord(
    ctx,
    'A rapid alternating click storm ends with the role state matching the last interaction and no orphan roles; two concurrent exclusive picks end with exactly one group role held.',
  );
  gateAudit(ctx, 'The concurrent interactions each land at most one append-only audit row; no duplicate grant row appears.');
  gateReplayDeferredTo(ctx, 'the live event re-delivery harness');

  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);
}

/** XGUILD — bindings are strictly per-guild (two real guilds, distinct rows). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const roleA = `${ctx.runPrefix}guildA-role`;
  const roleB = `${ctx.runPrefix}guildB-role`;

  // A matching-looking binding is published in each guild, each mapping ITS OWN role.
  await seedButtonPanel(handleA, panelId, channelId, [{ roleId: roleA, label: 'A', style: 'primary' }]);
  await seedButtonPanel(handleB, panelId, channelId, [{ roleId: roleB, label: 'B', style: 'primary' }]);

  const aScoped = await readButtonRoles(handleA, panelId);
  const bScoped = await readButtonRoles(handleB, panelId);
  ctx.expect(
    aScoped.length === 1 &&
      bScoped.length === 1 &&
      aScoped[0]?.active === true &&
      aScoped[0]?.role_id === roleA &&
      bScoped[0]?.role_id === roleB,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        "Each guild's binding is published under its own guild and maps its OWN role — guild A's binding maps role A, guild B's maps role B.",
      observation:
        `guild A published ${aScoped.length} binding mapping ${aScoped[0]?.role_id}; ` +
        `guild B published ${bScoped.length} binding mapping ${bScoped[0]?.role_id}.`,
      impact: 'A guild published a binding that did not map its own role — cross-guild binding config bled.',
    },
  );

  // database-RLS: each guild scope reads its OWN binding row under its OWN guild_id
  // and never the other's — distinct real rows under distinct guild_ids (the same
  // scoped-read isolation the wallet domain proves). Anon-denial is proven below.
  ctx.expect(
    aScoped[0]?.guild_id === guildA &&
      bScoped[0]?.guild_id === guildB &&
      guildA !== guildB &&
      aScoped[0]?.role_id !== bScoped[0]?.role_id,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        "A guild-A-scoped read returns A's row under guild_id A; a guild-B-scoped read returns B's row under guild_id B — neither scope ever returns the other guild's binding row.",
      observation:
        `guild-A-scoped read = ${aScoped[0]?.role_id} under "${aScoped[0]?.guild_id}"; ` +
        `guild-B-scoped read = ${bScoped[0]?.role_id} under "${bScoped[0]?.guild_id}" (distinct rows, distinct guild_ids).`,
      impact: 'A guild-scoped binding read returned the other guild’s row — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA, 'button_roles', aScoped.length > 0);

  // The live-guild guarantee (interacting in B never touches A's roles/members) is
  // a member-roles path.
  gateInteractiveDiscord(
    ctx,
    "Interactions in guild B grant only B's roles and never touch guild A's roles or members.",
  );
  gateAudit(ctx, 'Each guild keeps its own audit trail; a B interaction writes only B-scoped audit rows.');

  await proveNoOwnerAlert(ctx, handleA);
  proveBranding(ctx, null);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** CLEANUP — the run-prefixed sweep removes every binding row and verifies absence. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const panelId = `${ctx.runPrefix}panel`;
  const channelId = `${ctx.runPrefix}chan`;
  const messageId = `${ctx.runPrefix}cleanup-msg`;
  const emoji = '🧹';
  const roleOne = `${ctx.runPrefix}cleanup-1`;
  const roleTwo = `${ctx.runPrefix}cleanup-2`;

  // Create run-prefixed binding rows: a two-button panel + a reaction binding.
  await seedButtonPanel(handle, panelId, channelId, [
    { roleId: roleOne, label: 'One', style: 'primary', sortOrder: 0 },
    { roleId: roleTwo, label: 'Two', style: 'secondary', sortOrder: 1 },
  ]);
  await seedReactionBinding(handle, { channelId, messageId, emoji, roleId: roleOne });

  const before = await countBindings(handle);
  ctx.expect(before.buttons >= 2 && before.reactions >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed button + reaction binding rows (pre-cleanup baseline).',
    observation: `pre-cleanup: button_roles=${before.buttons}, reaction_roles=${before.reactions}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed binding rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, 'button_roles', before.buttons > 0);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, null);

  // Run the sweep (the same one teardown uses) and verify ZERO binding rows remain.
  await ctx.sweepGuildRows(handle);
  const after = await countBindings(handle);
  ctx.expect(after.buttons === 0 && after.reactions === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed button + reaction binding rows are deleted; a final sweep finds zero run-prefixed reaction-role resources.',
    observation: `post-sweep: button_roles=${after.buttons}, reaction_roles=${after.reactions}.`,
    impact: 'The cleanup sweep left run-prefixed binding rows behind — the suite leaves residue.',
  });

  // Removed binding messages / run roles in the live guild, and audit-history
  // anonymization (operational rows deleted, audit rows retained anonymized), are
  // separate live-guild / audit_logs lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed binding messages or self-assignable run roles remain in either test guild after cleanup.',
    'requires a live Discord channel/role readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Reaction-role audit history is anonymized rather than deleted (operational binding rows deleted, audit rows retained).',
    'requires an audit_logs anonymization readback lane (the binding config rows are the DB-observable evidence here)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The reaction-roles domain proof: the guild_id-scoped tables the sweep must clear
 * (both binding-config tables plus the alerts table the owner-notification proof
 * reads — all FK to `guild`, so child→parent order is simply binding tables then
 * alerts, with guild_config + guild always swept by the runner), plus the 12
 * scenario scripts.
 */
export const communityReactionRolesProof: DomainProof = {
  domainId: 'community-reaction-roles',
  guildScopedTables: ['button_roles', 'reaction_roles', 'alerts'],
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
