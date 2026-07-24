/**
 * scenario-runner/scripts/administration-custom-commands — the custom-commands
 * domain proof.
 *
 * Binds the administration-custom-commands domain's 12 declarative catalog
 * scenarios to concrete real-stack proofs driven through the REAL production
 * dispatcher against LOCAL Supabase.
 *
 * ── How a custom command becomes drivable in this harness ──
 * A custom command is NOT a built-in slash handler. The production dispatcher
 * (events/interaction-handler.ts) routes it to `handleCustomCommand` only when it
 * is present in the in-memory `commandRegistry`, which the REAL production
 * `initGuildFeatures` populates via `loadCustomCommands(supabase, guild, rest)` at
 * guild boot (guild-init.ts). So this proof, for every INVOCATION scenario:
 *   1. boots the guild (creates the `guild` row),
 *   2. inserts a run-prefixed `custom_commands` row (the exact persisted shape the
 *      dashboard `POST /api/custom-commands` writes), then
 *   3. re-boots the SAME guild so the REAL `loadCustomCommands` loads it into the
 *      live registry — the same code path a bot restart / reload runs.
 * `runSlash` then drives the command through the REAL `handleInteraction`, and the
 * captured reply is asserted (content + allowedMentions + reply count).
 *
 * ── What runs NOW vs what is GATED ──
 *  - RUNS NOW: registry load + invocation reply (variable resolution, the LOCKED
 *    mention-safety allowedMentions.parse=[], role/denied-role denial replies),
 *    guild-scoped `custom_commands` rows + cross-guild isolation (the V10 C-2
 *    per-guild registry fix), the DB UNIQUE(guild_id,name) rejection, cooldown/
 *    ephemeral persistence, restart survival, and the cleanup sweep.
 *  - GATED (honest boundary): the dashboard management/validation/403 lane
 *    (create/edit/delete + Zod name-format reject), the Discord bulk registration
 *    PUT + role grants + picker readback (DISCORD_TOKEN + live guild), and the
 *    Valkey cooldown check-and-set (redis) plus its fault lanes.
 *
 * ── Behavior-bug discovery (surfaced as FAILs, never softened) ──
 * The command engine (features/custom-commands/command-engine.ts) writes NO
 * audit_logs row on an invoke-time permission denial and replies with a hardcoded
 * generic string ("❌ You don't have permission to use this command.") instead of
 * the catalog's branded `command-no-permission` template (which names the command
 * and guild). Both are contradicted by the catalog SET-A/UNAUTH assertions and are
 * recorded as FAILs (findings for the owner), driven through the REAL engine.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from LOCAL Supabase ──────────────────────────────

interface CustomCommandRow {
  id: string;
  guild_id: string;
  name: string;
  enabled: boolean;
  cooldown_seconds: number;
  ephemeral: boolean;
  allowed_roles: string[];
  denied_roles: string[];
  actions: Record<string, unknown>[];
}

/** The subset of a custom_commands row this proof seeds. */
interface CommandSeed {
  name: string;
  description?: string;
  actions?: Record<string, unknown>[];
  allowed_roles?: string[];
  allowed_channels?: string[];
  denied_roles?: string[];
  denied_channels?: string[];
  cooldown_seconds?: number;
  ephemeral?: boolean;
  enabled?: boolean;
}

const COMMAND_COLS =
  'id, guild_id, name, enabled, cooldown_seconds, ephemeral, allowed_roles, denied_roles, actions';

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function truncate(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A run-prefixed, Discord-name-shaped custom command name (lowercase, ≤32). */
function cmdName(ctx: ScenarioContext, suffix: string): string {
  return `${ctx.runPrefix}${suffix}`.toLowerCase().slice(0, 32);
}

async function readCommand(handle: LiveClientHandle, name: string): Promise<CustomCommandRow | null> {
  const { data } = await handle.supabase
    .from('custom_commands')
    .select(COMMAND_COLS)
    .eq('guild_id', handle.guildId)
    .eq('name', name)
    .maybeSingle();
  return (data as CustomCommandRow | null) ?? null;
}

async function commandCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('custom_commands')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Insert one custom_commands row (service role). Returns the row + any error message. */
async function insertCommand(
  handle: LiveClientHandle,
  guildId: string,
  seed: CommandSeed,
): Promise<{ row: CustomCommandRow | null; error: string | null }> {
  const { data, error } = await handle.supabase
    .from('custom_commands')
    .insert({
      guild_id: guildId,
      name: seed.name,
      description: seed.description ?? 'e2e custom command',
      actions: seed.actions ?? [],
      allowed_roles: seed.allowed_roles ?? [],
      allowed_channels: seed.allowed_channels ?? [],
      denied_roles: seed.denied_roles ?? [],
      denied_channels: seed.denied_channels ?? [],
      cooldown_seconds: seed.cooldown_seconds ?? 0,
      ephemeral: seed.ephemeral ?? false,
      enabled: seed.enabled ?? true,
    })
    .select(COMMAND_COLS)
    .single();
  return { row: (data as CustomCommandRow | null) ?? null, error: error ? error.message : null };
}

/**
 * Seed a command, then re-boot the SAME guild so the REAL
 * `initGuildFeatures`→`loadCustomCommands` loads it into the live registry (the
 * production path a restart/reload runs). Returns the second (live) handle.
 */
async function seedAndLoad(
  ctx: ScenarioContext,
  opts: { label?: string; guildId?: string; seed: CommandSeed },
): Promise<{ handle: LiveClientHandle; row: CustomCommandRow | null; error: string | null }> {
  const guildId = opts.guildId ?? ctx.scenarioGuildId(opts.label);
  const boot0 = await ctx.bootGuild({ guildId, label: opts.label });
  const { row, error } = await insertCommand(boot0, guildId, opts.seed);
  await boot0.cleanup(); // dispose the first client; the DB row persists
  const handle = await ctx.bootGuild({ guildId, label: opts.label });
  return { handle, row, error };
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors, so
 * a failed read can never masquerade as "no alert raised".
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Count audit_logs rows for the guild (optionally scoped to an actor). null on error. */
async function auditCount(handle: LiveClientHandle, actorId?: string): Promise<number | null> {
  let query = handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (actorId) query = query.eq('actor_id', actorId);
  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
}

/** The payload of the first captured `reply` (custom commands reply via `reply`). */
function replyPayload(captured: CapturedResponse): Record<string, unknown> | undefined {
  return captured.find('reply')?.payload as Record<string, unknown> | undefined;
}

function replyContent(captured: CapturedResponse): string {
  return String((replyPayload(captured) as { content?: string } | undefined)?.content ?? '');
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS deny → 0), or
 * null when inconclusive. Mirrors the wallet-rewards proof's probe exactly.
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
    // Distinguish a genuine AUTHORIZATION denial (RLS/GRANT blocks the anon role —
    // the deny we want, SQLSTATE 42501) from the key being rejected before authz
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove the guild's custom_commands rows are RLS-isolated: the service role reads
 * this guild's named command while an anon client reads zero of them. GATEs (never
 * fakes) when no anon key is exported — cross-guild scoping is still proven live in
 * XGUILD with two REAL guilds' distinct rows.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle, name: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero custom_commands rows (RLS on custom_commands).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven live in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'custom_commands', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero custom_commands rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readCommand(handle, name);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s custom command row while an anon client reads zero of them (RLS on custom_commands).',
    observation:
      `service-role sees command "${name}" under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} custom_commands row(s) for that guild.`,
    impact:
      'A custom_commands row visible to the service role was also readable with an anon key — RLS is not denying anon reads (cross-guild command exposure).',
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
    promise: "This scenario's routine path raises no owner alert (no false alarm / registration-failure notice).",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a routine path — a false alarm / notification noise.',
  });
}

/** The powered-by-SomniBot embed attribution + full brand kit need a live readback. */
function gateAttribution(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Embed replies carry the subtle powered-by-SomniBot attribution and the full white-label brand kit in the owner voice.',
    'send_message replies are plain content (no embed); the embed attribution + brand-kit readback need a live embed/message snapshot (DISCORD_TOKEN + live guild)',
  );
}

/** Command create/update/delete audit is written on the dashboard save path only. */
function gateLifecycleAudit(ctx: ScenarioContext, event: string): void {
  ctx.gate(
    'audit',
    'discord-readback',
    `The custom-command ${event} is recorded in audit_logs with the acting manager's id.`,
    `command ${event} is a dashboard save path (${event === 'creation' ? 'POST' : 'PUT/DELETE'} /api/custom-commands) not reachable in a bot-only harness; this proof inserts the row directly, bypassing that path`,
  );
}

function gateReplay(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s interaction never double-executes (double reply / double role grant).',
    `interaction-redelivery idempotency is exercised in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a default command registers and replies with resolved variables + mention safety. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'greet');
  const userA = ctx.userId('a');
  const marker = `${ctx.runPrefix}def-ok`;
  const cooldownDefault = Number(declaredDefault(ctx.domain, 'cooldown-seconds') ?? 0);
  const ephemeralDefault = Boolean(declaredDefault(ctx.domain, 'ephemeral-replies') ?? false);

  const { handle, row, error } = await seedAndLoad(ctx, {
    label: 'a',
    seed: {
      name,
      description: 'DEF greet command',
      actions: [{ type: 'send_message', message: `Hi {user}! @everyone welcome — ${marker}` }],
      cooldown_seconds: cooldownDefault,
      ephemeral: ephemeralDefault,
    },
  });

  // DB: exactly one enabled, guild-scoped row that round-trips the catalog defaults.
  const count = await commandCount(handle);
  ctx.expect(
    error === null &&
      count === 1 &&
      row?.enabled === true &&
      row?.cooldown_seconds === cooldownDefault &&
      row?.ephemeral === ephemeralDefault,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `One enabled custom command row exists for the run guild at the catalog defaults (cooldown ${cooldownDefault}, ephemeral ${ephemeralDefault}).`,
      observation:
        `insert error=${error ?? 'none'}; rows=${count}, enabled=${row?.enabled}, ` +
        `cooldown_seconds=${row?.cooldown_seconds}, ephemeral=${row?.ephemeral}.`,
      impact: 'The default command row was not persisted as a single enabled row at the catalog defaults.',
    },
  );

  // Invoke through the REAL dispatcher (loaded by the production loadCustomCommands path).
  const captured = await ctx.runSlash(handle, { commandName: name, userId: userA, displayName: 'DEF A' });
  const payload = replyPayload(captured);
  const content = replyContent(captured);

  ctx.expect(content.includes(`<@${userA}>`) && content.includes(marker), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Invoking the command replies with {user} resolved to the caller mention and the configured template rendered.',
    observation: `reply content = "${truncate(content)}" (expected to contain "<@${userA}>" and "${marker}").`,
    impact: 'The command reply did not render its variables / configured template — the created command did not register or execute.',
  });

  const parse = (payload?.allowedMentions as { parse?: unknown } | undefined)?.parse;
  const parseEmpty = Array.isArray(parse) && parse.length === 0;
  ctx.expect(parseEmpty && content.includes('@everyone'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Command output suppresses mention parsing (allowedMentions.parse=[]) so an @everyone string can never mass-ping (the LOCKED mention-safety control).',
    observation:
      `reply allowedMentions.parse = ${JSON.stringify(parse)} (expected []); ` +
      `the content still carries the literal "@everyone" = ${content.includes('@everyone')}.`,
    impact: 'The reply did not force empty allowedMentions — an admin template containing @everyone could mass-ping (mention-safety broken).',
  });

  const replies = captured.allOf('reply').length;
  ctx.expect(replies === 1, {
    assertionClass: 'replay-safety',
    channel: 'captured-reply',
    promise: 'One invocation yields exactly one reply (no duplicate output).',
    observation: `reply count for one invocation = ${replies} (expected 1).`,
    impact: 'A single invocation produced a duplicate reply.',
  });

  ctx.expect(content.includes(marker), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The reply uses the owner-configured template (not stock-bot wording).',
    observation: `reply content "${truncate(content)}" ${content.includes(marker) ? 'contains' : 'omits'} the configured template marker "${marker}".`,
    impact: 'The command reply did not render the owner-configured template.',
  });
  gateAttribution(ctx);

  await proveRlsIsolation(ctx, handle, name);
  await proveNoOwnerAlert(ctx, handle);
  gateLifecycleAudit(ctx, 'creation');
}

/** SET-A — role restrictions gate who can use a command. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'gated');
  const userA = ctx.userId('a'); // role holder
  const userB = ctx.userId('b'); // non-holder
  const roleAllowed = `${ctx.runPrefix}role-allowed`;
  const marker = `${ctx.runPrefix}seta-ok`;

  const { handle, row, error } = await seedAndLoad(ctx, {
    label: 'a',
    seed: {
      name,
      description: 'SET-A role-gated command',
      actions: [{ type: 'send_message', message: `Members-only {user} — ${marker}` }],
      allowed_roles: [roleAllowed],
    },
  });

  ctx.expect(
    error === null &&
      Array.isArray(row?.allowed_roles) &&
      row?.allowed_roles.length === 1 &&
      row?.allowed_roles[0] === roleAllowed,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'The command row stores the allowed role id list exactly.',
      observation: `insert error=${error ?? 'none'}; allowed_roles=${JSON.stringify(row?.allowed_roles)} (expected ["${roleAllowed}"]).`,
      impact: 'The allowed_roles list was not persisted exactly as configured.',
    },
  );

  // Holder → gets the command's reply.
  const holder = await ctx.runSlash(handle, {
    commandName: name,
    userId: userA,
    member: { id: userA, roles: [roleAllowed], permissions: { has: () => true } },
  });
  const holderContent = replyContent(holder);
  ctx.expect(holderContent.includes(marker) && holderContent.includes(`<@${userA}>`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A member holding the allowed role receives the command reply.',
    observation: `holder reply = "${truncate(holderContent)}" (expected the configured template with the caller mention).`,
    impact: 'A role-holder was wrongly denied the command reply.',
  });

  // Non-holder → ONLY the ephemeral denial; no action runs.
  const denied = await ctx.runSlash(handle, {
    commandName: name,
    userId: userB,
    member: { id: userB, roles: [], permissions: { has: () => true } },
  });
  const deniedPayload = replyPayload(denied);
  const deniedContent = replyContent(denied);
  ctx.expect(
    deniedContent.toLowerCase().includes('permission') &&
      deniedPayload?.ephemeral === true &&
      denied.count === 1 &&
      !deniedContent.includes(marker),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A member without the allowed role receives ONLY the ephemeral no-permission denial; the command action never runs.',
      observation:
        `non-holder reply = "${truncate(deniedContent)}", ephemeral=${deniedPayload?.ephemeral}, ` +
        `calls=${denied.count} (expected a single ephemeral denial with no action output).`,
      impact: 'A non-holder executed the action or received a non-ephemeral/duplicate reply — the role gate leaked.',
    },
  );

  // BEHAVIOR BUG (branding): the catalog contracts the branded command-no-permission
  // template naming the command; the engine emits a fixed generic string.
  ctx.expect(deniedContent.includes(name), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The no-permission denial renders the branded command-no-permission template naming the command (/{command-name}) in the owner voice.',
    observation:
      `denial copy = "${truncate(deniedContent)}" — ${deniedContent.includes(name) ? 'names' : 'does NOT name'} "/${name}"; ` +
      'the engine emits a fixed generic "You don\'t have permission to use this command." string.',
    impact: 'The denial uses a hardcoded generic string instead of the branded command-no-permission template with {command-name}/{guild-name} — the configured denial voice never reaches the member.',
  });

  // BEHAVIOR BUG (audit): the catalog contracts the denial is recorded with the
  // denied member's id; the engine writes no audit_logs row on an invoke-time denial.
  const denialAudit = await auditCount(handle, userB);
  if (denialAudit === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'The permission denial is recorded in audit_logs with the denied member id.',
      'the audit_logs read errored, so the denial-audit gap cannot be asserted (never a false-clean pass)',
    );
  } else {
    ctx.expect(denialAudit > 0, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The permission denial is recorded in audit_logs with the denied member id.',
      observation:
        `audit_logs rows for the denied member "${userB}" on the run guild = ${denialAudit} (expected ≥1). ` +
        'The command engine writes no audit row on an invoke-time denial.',
      impact: 'Invoke-time permission denials are not audited — the contracted denial audit trail (with actor id) is missing.',
    });
  }

  // Repeated denied invocations execute zero actions / write nothing.
  const beforeCount = await commandCount(handle);
  await ctx.runSlash(handle, {
    commandName: name,
    userId: userB,
    member: { id: userB, roles: [], permissions: { has: () => true } },
  });
  const afterCount = await commandCount(handle);
  ctx.expect(afterCount === beforeCount, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated denied invocations execute zero actions and write nothing.',
    observation: `custom_commands rows before/after a repeated denied invocation = ${beforeCount}/${afterCount} (expected unchanged).`,
    impact: 'A repeated denied invocation mutated persistent state.',
  });

  await proveRlsIsolation(ctx, handle, name);
  await proveNoOwnerAlert(ctx, handle);
}

/** SET-B — cooldown plus ephemeral configuration changes behavior observably. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'cool');
  const cooldown = 30;
  const boot = await ctx.bootGuild({ label: 'a' });
  const { row, error } = await insertCommand(boot, boot.guildId, {
    name,
    description: 'SET-B cooldown+ephemeral command',
    actions: [{ type: 'send_message', message: 'cooled {user}' }],
    cooldown_seconds: cooldown,
    ephemeral: true,
  });

  ctx.expect(error === null && row?.cooldown_seconds === cooldown && row?.ephemeral === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The command row stores cooldown_seconds=30 and ephemeral=true exactly as configured.',
    observation: `insert error=${error ?? 'none'}; cooldown_seconds=${row?.cooldown_seconds} (expected 30), ephemeral=${row?.ephemeral} (expected true).`,
    impact: 'The cooldown/ephemeral configuration was not persisted.',
  });

  await proveRlsIsolation(ctx, boot, name);
  await proveNoOwnerAlert(ctx, boot);

  // The cooldown check-and-set and the ephemeral countdown reply live entirely on the
  // Valkey path (valkey.get/ttl/set); without a reachable Valkey the cooldown branch
  // cannot run (it would throw). GATE the behavioral assertions honestly.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'The first invocation replies ephemerally; a second within 30s shows the cooldown notice with a live seconds-left countdown; after the window it works again.',
    'no Valkey/Redis reachable — the per-command cooldown (valkey.get/ttl/set) path cannot run',
  );
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'The Valkey cooldown key admits no second execution within the window.',
    'no Valkey/Redis reachable — the cooldown key cannot be exercised',
  );
  ctx.gate(
    'branding',
    'redis-dependency',
    'The cooldown copy is the playful default-voice command-cooldown template with a live {seconds-left}.',
    'no Valkey/Redis reachable — the cooldown branch that renders the countdown copy cannot run',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'Both invocations and the cooldown block are traceable in audit_logs.',
    'requires the Valkey cooldown path plus a live invocation lane; the engine writes no invoke-time execution/cooldown audit row',
  );
}

/** INVALID — invalid command definitions are rejected before touching Discord. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'dupe');
  const boot = await ctx.bootGuild({ label: 'a' });

  // Arrange one valid command.
  const first = await insertCommand(boot, boot.guildId, {
    name,
    description: 'INVALID base',
    actions: [{ type: 'send_message', message: 'hi' }],
  });
  ctx.expect(first.error === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The initial valid command persists.',
    observation: `baseline insert error=${first.error ?? 'none'}.`,
    impact: 'Could not arrange the baseline valid command.',
  });
  const baseCount = await commandCount(boot);

  // A colliding definition (same guild_id+name) is rejected by the DB
  // UNIQUE(guild_id,name) — no second row is written.
  const dup1 = await insertCommand(boot, boot.guildId, { name, description: 'INVALID dup', actions: [] });
  const afterDup1 = await commandCount(boot);
  ctx.expect(dup1.error !== null && afterDup1 === baseCount, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A command whose name collides with an existing one is rejected and no row is written.',
    observation: `duplicate insert error=${dup1.error ?? 'none (UNEXPECTED)'}; row count ${baseCount}→${afterDup1} (expected unchanged).`,
    impact: 'A duplicate command name was accepted — the UNIQUE(guild_id,name) guarantee did not hold; a second row was written.',
  });

  // Repeated invalid submissions keep failing with zero writes.
  const dup2 = await insertCommand(boot, boot.guildId, { name, description: 'INVALID dup2', actions: [] });
  const afterDup2 = await commandCount(boot);
  ctx.expect(dup2.error !== null && afterDup2 === baseCount, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated invalid (colliding) submissions keep failing with zero writes.',
    observation: `second duplicate insert error=${dup2.error ?? 'none (UNEXPECTED)'}; row count still ${afterDup2} (expected ${baseCount}).`,
    impact: 'A repeated colliding submission eventually wrote a row — rejection is not idempotent.',
  });

  await proveNoOwnerAlert(ctx, boot);
  await proveRlsIsolation(ctx, boot, name);

  // The name-FORMAT rejection (uppercase/spaces/built-in collision/>32 chars) is
  // enforced in the dashboard Zod/route layer (regex ^[\w-]{1,32}$ + built-in check);
  // custom_commands carries no such DB CHECK, so a bot-only harness cannot drive the
  // 400 reject path.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Creating a command with an invalid name (uppercase/spaces/built-in collision/>32 chars) returns 400 and the guild command list is unchanged.',
    'name-format validation lives in the dashboard (Zod/route regex + built-in-collision check); no DB CHECK enforces it, so the 400 reject path is not reachable in a bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The rejection is recorded without command artifacts.',
    'the rejected-create audit row is written on the dashboard save path (not reachable in a bot-only harness)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The validation copy names the offending field in the owner voice.',
    'validation copy is rendered by the dashboard form, not the bot',
  );
}

/** UNAUTH — command management requires the automations permission; denied roles are gated. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'denied');
  const userA = ctx.userId('a'); // holds a denied role
  const roleDenied = `${ctx.runPrefix}role-denied`;

  const { handle, row, error } = await seedAndLoad(ctx, {
    label: 'a',
    seed: {
      name,
      description: 'UNAUTH denied-role command',
      actions: [{ type: 'send_message', message: 'should-not-run {user}' }],
      denied_roles: [roleDenied],
    },
  });

  ctx.expect(error === null && Array.isArray(row?.denied_roles) && row?.denied_roles[0] === roleDenied, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The command row stores the denied role id list exactly.',
    observation: `insert error=${error ?? 'none'}; denied_roles=${JSON.stringify(row?.denied_roles)} (expected ["${roleDenied}"]).`,
    impact: 'The denied_roles list was not persisted as configured.',
  });

  const denied = await ctx.runSlash(handle, {
    commandName: name,
    userId: userA,
    member: { id: userA, roles: [roleDenied], permissions: { has: () => true } },
  });
  const dPayload = replyPayload(denied);
  const dContent = replyContent(denied);
  ctx.expect(
    dContent.toLowerCase().includes('permission') &&
      dPayload?.ephemeral === true &&
      denied.count === 1 &&
      !dContent.includes('should-not-run'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A member holding a denied role receives ONLY the ephemeral denial; the command action never runs.',
      observation:
        `reply = "${truncate(dContent)}", ephemeral=${dPayload?.ephemeral}, calls=${denied.count} ` +
        '(expected one ephemeral denial, action suppressed).',
      impact: 'A denied-role member executed the action or got a non-ephemeral/duplicate reply — the deny gate leaked.',
    },
  );

  const cnt = await commandCount(handle);
  ctx.expect(cnt === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'No command rows are created or changed by denied invocations.',
    observation: `custom_commands rows for the run guild after the denied call = ${cnt} (expected 1, unchanged).`,
    impact: 'A denied invocation created/changed a command row.',
  });

  // BEHAVIOR BUG (audit): the Discord (invoke-time) denied-role denial is not audited.
  const dAudit = await auditCount(handle, userA);
  if (dAudit === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'The Discord denied-role denial is logged in audit_logs with the denied member id.',
      'the audit_logs read errored — the denial-audit gap cannot be asserted',
    );
  } else {
    ctx.expect(dAudit > 0, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The Discord (invoke-time) denied-role denial is logged in audit_logs with the denied member id.',
      observation:
        `audit_logs rows for the denied member "${userA}" = ${dAudit} (expected ≥1); ` +
        'the engine writes no audit row on a denied-role denial.',
      impact: 'Invoke-time denied-role denials are not audited — the contracted denial trail is missing.',
    });
  }

  // Repeated denied attempts write nothing.
  await ctx.runSlash(handle, {
    commandName: name,
    userId: userA,
    member: { id: userA, roles: [roleDenied], permissions: { has: () => true } },
  });
  const cnt2 = await commandCount(handle);
  ctx.expect(cnt2 === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Repeated denied attempts write nothing.',
    observation: `custom_commands rows after a repeated denied attempt = ${cnt2} (expected 1).`,
    impact: 'A repeated denied attempt mutated state.',
  });

  // BEHAVIOR BUG (branding): the denial should render the branded template naming the command.
  ctx.expect(dContent.includes(name), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The denied-role denial renders the branded command-no-permission template naming the command.',
    observation:
      `denial copy = "${truncate(dContent)}" — ${dContent.includes(name) ? 'names' : 'does NOT name'} "/${name}" ` +
      '(engine emits a fixed generic string).',
    impact: 'The denied-role denial uses a hardcoded generic string instead of the branded template — the configured denial voice never reaches the member.',
  });

  await proveNoOwnerAlert(ctx, handle);
  await proveRlsIsolation(ctx, handle, name);

  // Dashboard management authorization (403 on POST /api/custom-commands + /commands
  // without dashboard.manage_automations) is a dashboard session-auth lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A member without dashboard.manage_automations receives 403 from POST /api/custom-commands and the /commands page.',
    'the dashboard session-auth (manage_automations) lane is not reachable in a bot-only harness',
  );
}

/** DEPFAIL — losing Valkey never lets cooldowns be bypassed (Valkey leg honestly gated). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The premise is a controlled "stop Valkey mid-run" outage: the contracted fault
  // severs VALKEY (the cooldown check-and-set), not Supabase — a Supabase sever
  // would not model this contract (invocation reads the in-memory registry loaded
  // at boot; the cooldown is the Valkey branch). The fault-proxy lane severs
  // SUPABASE only this wave, so the Valkey sever leg stays honestly gated. The
  // engine's cooldown branch also has no branded temporarily-unavailable fallback
  // yet — fixing + proving that belongs to the Valkey-sever wave, where the fix
  // can be driven for real instead of shipped unproven.
  const valkeyLane = ctx.faults?.valkey
    ? 'the contracted outage severs VALKEY; its fault proxy is registered but deliberately not severed this wave (Supabase-sever only) — the cooldown-branch degradation (and its missing branded temporarily-unavailable fallback) is proven on the Valkey-sever wave'
    : 'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane); the contracted outage severs Valkey, not Supabase';
  ctx.gate(
    'Discord',
    'redis-dependency',
    'With Valkey stopped, a cooldown-protected command replies with the branded temporarily-unavailable ephemeral message instead of executing (fail-safe: the cooldown is never bypassed); zero-cooldown message-only commands keep working.',
    valkeyLane,
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one dependency-loss alert for the outage window.',
    `${valkeyLane}; the alert additionally needs the owner alert-channel readback`,
  );
  ctx.gate(
    'audit',
    'db-observable',
    'The degraded refusals are recorded for the outage window.',
    valkeyLane,
  );
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'No cooldown window is bypassed at any point during the outage.',
    valkeyLane,
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The unavailable copy is calm and branded.',
    `${valkeyLane}; the temporarily-unavailable branch does not exist in the engine yet (a real gap to surface on that wave, never faked green here)`,
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'No command state is corrupted during the outage.',
    valkeyLane,
  );
}

/** RETRY — failed Discord registration retries to exactly one live command. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'retry');
  const boot = await ctx.bootGuild({ label: 'a' });
  const { row, error } = await insertCommand(boot, boot.guildId, {
    name,
    description: 'RETRY command',
    actions: [{ type: 'send_message', message: 'x' }],
  });

  // DB-observable core: the saved definition is preserved (untouched) regardless of
  // registration outcome — the catalog's "the command row is unchanged through the
  // retry / the saved definition is preserved".
  ctx.expect(error === null && row?.enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The saved command definition is preserved (an enabled guild-scoped row) regardless of the registration outcome.',
    observation: `insert error=${error ?? 'none'}; enabled=${row?.enabled}.`,
    impact: 'The saved definition was not preserved through a registration attempt.',
  });

  // Everything else in RETRY is the Discord bulk-registration PUT + its transient-fault
  // retry — omitted in the gateway-less harness (no bulk PUT is performed here).
  ctx.gate(
    'Discord',
    'discord-readback',
    'With an injected transient failure on the first bulk registration PUT, the retry converges to exactly one live command with no duplicate picker entries.',
    'the bulk command PUT to Discord is omitted in the gateway-less harness; a registration fault lane needs DISCORD_TOKEN + a live guild',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The registration failure and eventual success are both recorded.',
    'requires the Discord bulk-registration fault lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner sees the failure alert and no repeat after recovery.',
    'requires the Discord registration fault lane + owner alert-channel readback',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The recovered command replies normally with branded output.',
    'requires the Discord registration fault lane then a live invocation readback',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Retried registration is idempotent via the bulk PUT semantics.',
    'requires the Discord bulk-registration fault lane',
  );
}

/** REPLAY — a redelivered interaction cannot double-execute role grants. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'grant');
  const roleGrant = `${ctx.runPrefix}role-grant`;
  const boot = await ctx.bootGuild({ label: 'a' });
  const { row, error } = await insertCommand(boot, boot.guildId, {
    name,
    description: 'REPLAY give_role command',
    actions: [{ type: 'give_role', roleId: roleGrant }],
  });

  ctx.expect(error === null && row?.enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The give_role command definition persists as a single enabled, guild-scoped row.',
    observation: `insert error=${error ?? 'none'}; enabled=${row?.enabled}.`,
    impact: 'The give_role command was not persisted.',
  });

  // Custom-command execution writes NO per-interaction side-effect row to the DB (a
  // role grant is a Discord mutation), so "no duplicate side-effect record" is proven
  // by the singular command row; the actual grant + its idempotency need a live guild.
  const cnt = await commandCount(boot);
  ctx.expect(cnt === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Exactly one command row backs the interaction; no duplicate side-effect rows exist.',
    observation: `custom_commands rows = ${cnt} (expected 1).`,
    impact: 'Duplicate command rows existed for the interaction.',
  });

  await proveRlsIsolation(ctx, boot, name);
  await proveNoOwnerAlert(ctx, boot);

  // The role grant runs guild.members.fetch(...).roles.add(...) against the LIVE guild;
  // idempotency under redelivery rests on Discord interaction-token semantics — neither
  // is observable without DISCORD_TOKEN + a live guild.
  ctx.gate(
    'Discord',
    'discord-readback',
    'After a redelivered interaction the member holds the granted role exactly once and exactly one reply exists.',
    'the give_role action + redelivery dedup need a live Discord guild (members.fetch/roles.add) and real interaction-token semantics',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'A redelivered interaction cannot double-apply the role grant.',
    'redelivery idempotency rests on Discord interaction-token semantics — requires a live gateway',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One grant is recorded and the replay is visible as deduplicated.',
    'the grant + its audit require the live guild; the engine writes no grant audit row in-process',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'No duplicated branded output appears on replay.',
    'requires the live invocation/readback lane for the give_role reply',
  );
}

/** RESTART — custom commands survive restarts through the merged bulk registration. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const name = cmdName(ctx, 'persist');
  const userA = ctx.userId('a');
  const marker = `${ctx.runPrefix}restart-ok`;

  // Boot #1: create the guild + save the command, then "shut down".
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const { row: savedRow, error } = await insertCommand(first, guildId, {
    name,
    description: 'RESTART command',
    actions: [{ type: 'send_message', message: `still here {user} — ${marker}` }],
  });
  ctx.expect(error === null && savedRow?.enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The command definition is saved as an enabled guild-scoped row before the restart.',
    observation: `insert error=${error ?? 'none'}; enabled=${savedRow?.enabled}.`,
    impact: 'Could not arrange the pre-restart command.',
  });
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The REAL initGuildFeatures→loadCustomCommands
  // re-registers the enabled command into the live registry from Supabase.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRow = await readCommand(second, name);
  ctx.expect(afterRow !== null && afterRow.enabled === true && afterRow.name === name, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Command rows are unchanged across the restart.',
    observation: `post-restart row: name="${afterRow?.name}", enabled=${afterRow?.enabled} (expected the same enabled row).`,
    impact: 'The command row changed or vanished across the restart.',
  });

  // Invoke post-restart → registered + behaves identically (variables resolved, one reply).
  const captured = await ctx.runSlash(second, { commandName: name, userId: userA });
  const content = replyContent(captured);
  const replies = captured.allOf('reply').length;
  ctx.expect(content.includes(marker) && content.includes(`<@${userA}>`) && replies === 1, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'After a full restart the custom command is still registered and invocations behave identically (one reply, variables resolved, template rendered).',
    observation: `post-restart reply = "${truncate(content)}", reply count = ${replies} (expected the rendered template, exactly one reply).`,
    impact: 'A run-prefixed custom command did not survive the restart / re-registration — it failed to load or reply after reboot.',
  });
  ctx.expect(replies === 1, {
    assertionClass: 'replay-safety',
    channel: 'captured-reply',
    promise: 'Re-registration on restart does not duplicate the command (one invocation → one reply).',
    observation: `post-restart reply count = ${replies} (expected 1; a duplicate registration would double-handle).`,
    impact: 'Restart re-registration duplicated the command handling.',
  });
  ctx.expect(content.includes(marker), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'Replies render identically (owner template) after restart.',
    observation: `post-restart reply ${content.includes(marker) ? 'renders' : 'does not render'} the configured template marker "${marker}".`,
    impact: 'Post-restart reply lost the owner-configured template.',
  });

  await proveNoOwnerAlert(ctx, second); // no false registration-failure alert
  await proveRlsIsolation(ctx, second, name);
  ctx.gate(
    'audit',
    'discord-readback',
    'No spurious registration churn is logged around the restart.',
    'registration audit needs the Discord bulk-PUT path (omitted in the gateway-less harness)',
  );
}

/** RACE — simultaneous invocations respect the cooldown atomically. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'race');
  const boot = await ctx.bootGuild({ label: 'a' });
  const { row, error } = await insertCommand(boot, boot.guildId, {
    name,
    description: 'RACE cooldown command',
    actions: [{ type: 'send_message', message: 'race {user}' }],
    cooldown_seconds: 30,
  });

  ctx.expect(error === null && row?.cooldown_seconds === 30, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The 30s-cooldown command persists cooldown_seconds=30.',
    observation: `insert error=${error ?? 'none'}; cooldown_seconds=${row?.cooldown_seconds} (expected 30).`,
    impact: 'The cooldown configuration was not persisted for the race command.',
  });

  await proveRlsIsolation(ctx, boot, name);
  await proveNoOwnerAlert(ctx, boot);

  // The single-execution-under-concurrency guarantee is the cooldown check-and-set on
  // Valkey. NOTE for the readback lane: the engine's cooldown is a NON-ATOMIC
  // get-then-set (valkey.get then valkey.set 'EX'), NOT an atomic SET NX, so two truly
  // simultaneous invocations could both read "no key" before either sets it. This can
  // only be exercised (and that atomicity risk confirmed) with a reachable Valkey.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Two simultaneous invocations of the 30s-cooldown command yield exactly one execution and one cooldown notice.',
    'no Valkey/Redis reachable — the cooldown check-and-set cannot run (and its non-atomic get-then-set can only be probed with Valkey present)',
  );
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'The cooldown key admits exactly one invocation per window under concurrency.',
    'no Valkey/Redis reachable — cannot exercise the concurrent cooldown check-and-set',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'One execution and one cooldown block are recorded.',
    'requires the Valkey cooldown path plus a live invocation lane; the engine writes no invoke-time audit row',
  );
  ctx.gate(
    'branding',
    'redis-dependency',
    'Both replies are branded and consistent.',
    'requires the Valkey cooldown path to reach the cooldown-notice branch',
  );
}

/** XGUILD — custom commands are strictly guild-scoped in registry and registration. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'scoped');
  const userA = ctx.userId('a');
  const marker = `${ctx.runPrefix}xg-ok`;
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  // Guild A: create + load the command via the production load path (double-boot).
  const boot0A = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const { error: insErr } = await insertCommand(boot0A, guildA, {
    name,
    description: 'XGUILD A command',
    actions: [{ type: 'send_message', message: `A-only {user} — ${marker}` }],
  });
  await boot0A.cleanup();
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });

  // A invocation works.
  const aFirst = await ctx.runSlash(handleA, { commandName: name, userId: userA });
  const aFirstContent = replyContent(aFirst);
  ctx.expect(insErr === null && aFirstContent.includes(marker), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: "Guild A's custom command executes in guild A.",
    observation: `guild A reply = "${truncate(aFirstContent)}" (expected the configured template).`,
    impact: "Guild A's own command failed to execute.",
  });

  // Guild B initializes its OWN per-guild registry — must NOT see A's command and must
  // NOT wipe A's (the V10 audit C-2 fix: per-guild sub-maps, not one flat cleared map).
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });
  const bInvoke = await ctx.runSlash(handleB, { commandName: name, userId: userA });
  ctx.expect(bInvoke.count === 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: "The same command name in guild B resolves to nothing — guild B never shows guild A's command.",
    observation: `invoking "/${name}" in guild B produced ${bInvoke.count} response call(s) (expected 0 — not in B's per-guild registry).`,
    impact: 'Guild B routed a command that belongs only to guild A — cross-guild registry leakage.',
  });

  // A still works after B initialized (registry isolation held).
  const aSecond = await ctx.runSlash(handleA, { commandName: name, userId: userA });
  const aSecondContent = replyContent(aSecond);
  ctx.expect(aSecondContent.includes(marker), {
    assertionClass: 'replay-safety',
    channel: 'captured-reply',
    promise: "Initializing guild B does not wipe or alter guild A's registry; guild A's command keeps working throughout.",
    observation: `guild A reply after guild B init = "${truncate(aSecondContent)}" (expected still working).`,
    impact: "Guild B initialization wiped guild A's command registry — the per-guild registry isolation regressed.",
  });

  // DB scoping: A holds the row; B holds none. Distinct real rows under distinct guild_ids.
  const aRow = await readCommand(handleA, name);
  const bRow = await readCommand(handleB, name);
  const aCount = await commandCount(handleA);
  const bCount = await commandCount(handleB);
  ctx.expect(aRow?.guild_id === guildA && bRow === null && aCount === 1 && bCount === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Command rows are strictly guild-scoped: guild A holds its row; guild B holds none.',
    observation:
      `guild A: row guild_id="${aRow?.guild_id}", count=${aCount}; ` +
      `guild B: row=${bRow === null ? 'none' : 'PRESENT'}, count=${bCount} (expected A=1 under "${guildA}", B=0).`,
    impact: 'A command row was visible in the wrong guild — cross-guild registry/row leakage.',
  });

  ctx.expect(aFirstContent.includes(marker), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: "Guild A's reply carries its own configured template.",
    observation: `guild A reply ${aFirstContent.includes(marker) ? 'renders' : 'omits'} the configured template.`,
    impact: "Guild A's branded template did not render.",
  });

  await proveNoOwnerAlert(ctx, handleA);
  await proveRlsIsolation(ctx, handleA, name);
  ctx.gate(
    'audit',
    'discord-readback',
    "Each guild's audit trail contains only its own command events.",
    'lifecycle audit is written on the dashboard save path (not reachable in a bot-only harness)',
  );
}

/** CLEANUP — all run-prefixed command artifacts are removed after the suite. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const name = cmdName(ctx, 'sweep');
  const boot = await ctx.bootGuild({ label: 'a' });
  const { error } = await insertCommand(boot, boot.guildId, {
    name,
    description: 'CLEANUP command',
    actions: [{ type: 'send_message', message: 'sweep me' }],
  });
  const before = await commandCount(boot);
  ctx.expect(error === null && before >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created a run-prefixed custom_commands row (pre-cleanup baseline).',
    observation: `insert error=${error ?? 'none'}; pre-cleanup custom_commands rows = ${before}.`,
    impact: 'The cleanup scenario could not establish a baseline row.',
  });

  // Prove the off-theme classes while the row still exists.
  await proveRlsIsolation(ctx, boot, name);
  await proveNoOwnerAlert(ctx, boot);

  // Run the sweep (the same routine teardown uses) and verify ZERO run-prefixed rows.
  await ctx.sweepGuildRows(boot);
  const after = await commandCount(boot);
  ctx.expect(after === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'The sweep deletes every run-prefixed custom_commands row; a final sweep finds zero.',
    observation: `post-sweep custom_commands rows = ${after} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed command rows behind — the suite leaves residue.',
  });

  // Running cleanup twice is a safe no-op.
  await ctx.sweepGuildRows(boot);
  const afterTwice = await commandCount(boot);
  ctx.expect(afterTwice === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running cleanup twice is a safe no-op (idempotent sweep).',
    observation: `custom_commands rows after a second sweep = ${afterTwice} (expected 0, no error).`,
    impact: 'A second cleanup pass was not a safe no-op.',
  });

  // Discord deregistration + granted-role removal + cooldown-key clear, and the
  // anonymize-over-delete audit retention, are separate credentialed lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed commands remain in the guild command picker and no granted roles linger after teardown.',
    'requires a live Discord registration + role-state readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Run audit rows persist (none deleted by cleanup) per the anonymize-over-delete contract.',
    'invoke/lifecycle audit rows are written on paths not driven here (dashboard/live guild); the sweep intentionally excludes audit_logs — retention is verified on the audit lane',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'No member-facing surface references run artifacts after teardown.',
    'requires a live Discord channel readback for lingering command replies/embeds',
  );
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The custom-commands domain proof: the guild_id-scoped tables the sweep must
 * clear (custom_commands has no child tables; alerts is swept for owner-alert
 * hygiene) — guild_config + guild are always swept in addition — plus the 12
 * scenario scripts. audit_logs is deliberately NOT swept (anonymize-over-delete
 * retention).
 */
export const administrationCustomCommandsProof: DomainProof = {
  domainId: 'administration-custom-commands',
  guildScopedTables: ['custom_commands', 'alerts'],
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
