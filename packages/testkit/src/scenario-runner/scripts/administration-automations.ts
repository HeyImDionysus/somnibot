/**
 * scenario-runner/scripts/administration-automations — the Automations domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven against LOCAL Supabase. Like community-welcome-onboarding, this
 * domain is DELIBERATELY different in shape from the wallet-rewards template: the
 * automation ENGINE (packages/bot/src/features/automations/automation-engine.ts)
 * fires on live Discord gateway platform events (member.joined / message.sent /
 * role.gained …), matches loaded rules, checks the Valkey fire-limit + custom
 * rate-limit + DM cooldown (SET NX / INCR), the in-memory chain-depth guard and
 * the mass-action guard, then executes actions via Discord REST. Rule CRUD lives
 * on the dashboard (`/api/automations`, gated on dashboard.manage_automations).
 * The domain exposes NO slash command, so the bot-only local-Supabase harness
 * (which drives the production dispatcher via runSlash) can neither emit the
 * gateway events that trigger executions nor observe the Discord side effects, and
 * has no running Valkey for the atomic guards. This is a MOSTLY-GATED domain, and
 * that is the correct, honest boundary — mostlyGated = true.
 *
 * What DOES run now, against real state (the persisted model the engine loads):
 *   - The `automations` table the AutomationLoader reads (`.eq('guild_id', …)`):
 *     a fresh guild's EMPTY rule list (the 'unconfigured' initial state), a
 *     created rule persisting in the loader-consumable shape (enabled/exec-count
 *     DB defaults, trigger, actions, custom rate-limit columns, scope-filter
 *     arrays), and strict per-guild isolation (the guild-scoped load is what makes
 *     "automations never fire across guilds" hold).
 *   - Guild-scoped RLS on `automations` and `automation_executions` (anon-denial
 *     with a service-role positive control; owner_full_access policy + no anon
 *     GRANT), i.e. the data-layer backstop that "automation internals are never
 *     exposed to members" (UNAUTH).
 *   - The `automation_executions` FK to `automations` (ON DELETE CASCADE) and the
 *     cleanup sweep (operational rows deleted, `audit_logs` retained per the
 *     anonymize-over-delete contract; a second sweep is a safe no-op).
 *
 * Durable occurrence idempotency: the catalog contracts exactly-once-per-occurrence
 * execution (REPLAY/RESTART/RACE) keyed on an occurrence id. `automation_executions`
 * now has an occurrence_id column + UNIQUE(guild_id, automation_id, occurrence_id),
 * and the engine stakes a claim on it BEFORE running actions (deriving a STABLE
 * occurrence id from the event's durable Discord-native identity). REPLAY proves the
 * DB-level exactly-once dedup directly; the observable Discord-side "exactly once
 * after redelivery" still needs a live gateway and is gated.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface AutomationRow {
  id: string;
  guild_id: string;
  name: string;
  trigger_type: string;
  enabled: boolean;
  execution_count: number;
  rate_limit_per_user: number | null;
  rate_limit_window_seconds: number | null;
  target_channel_ids: string[];
  exclude_channel_ids: string[];
  actions: Record<string, unknown>[];
  conditions: Record<string, unknown>[];
}

/** Options for inserting an `automations` row through the SAME table/columns the
 *  dashboard `/api/automations` write path uses and the AutomationLoader reads. */
interface InsertAutomationOptions {
  suffix?: string;
  triggerType?: string;
  actions?: Record<string, unknown>[];
  conditions?: Record<string, unknown>[];
  enabled?: boolean;
  rateLimitPerUser?: number | null;
  rateLimitWindowSeconds?: number | null;
  targetChannelIds?: string[];
  excludeChannelIds?: string[];
}

/** Options for inserting an `automation_executions` row through the SAME columns
 *  the production ExecutionLogger writes. */
interface InsertExecutionOptions {
  triggeredBy?: string;
  triggerEvent?: string;
  conditionsPassed?: boolean;
  actionsExecuted?: number;
  actionsFailed?: number;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A single default action so an inserted rule parses as loader-valid. */
function defaultAction(ctx: ScenarioContext): Record<string, unknown> {
  return {
    type: 'send_message',
    config: { channel_id: `${ctx.runPrefix}chan`, message: 'Welcome {user}!' },
  };
}

/**
 * Insert an automation exactly the way the dashboard save path does (same table,
 * same columns the loader's `toLoaded` parses). Returns the new id + any error so
 * a caller can prove the DB accepts/rejects a shape without a DB CHECK guard.
 */
async function insertAutomation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  opts: InsertAutomationOptions = {},
): Promise<{ id: string | null; error: string | null }> {
  const row: Record<string, unknown> = {
    guild_id: handle.guildId,
    name: `${ctx.runPrefix}${opts.suffix ?? 'rule'}`,
    trigger_type: opts.triggerType ?? 'member.joined',
    trigger_config: {},
    actions: opts.actions ?? [defaultAction(ctx)],
    conditions: opts.conditions ?? [],
  };
  if (opts.enabled !== undefined) row.enabled = opts.enabled;
  if (opts.rateLimitPerUser !== undefined) row.rate_limit_per_user = opts.rateLimitPerUser;
  if (opts.rateLimitWindowSeconds !== undefined) row.rate_limit_window_seconds = opts.rateLimitWindowSeconds;
  if (opts.targetChannelIds !== undefined) row.target_channel_ids = opts.targetChannelIds;
  if (opts.excludeChannelIds !== undefined) row.exclude_channel_ids = opts.excludeChannelIds;

  const { data, error } = await handle.supabase
    .from('automations')
    .insert(row)
    .select('id')
    .maybeSingle();
  return { id: (data as { id: string } | null)?.id ?? null, error: error?.message ?? null };
}

async function readAutomation(handle: LiveClientHandle, id: string): Promise<AutomationRow | null> {
  const { data } = await handle.supabase
    .from('automations')
    .select(
      'id, guild_id, name, trigger_type, enabled, execution_count, rate_limit_per_user, ' +
        'rate_limit_window_seconds, target_channel_ids, exclude_channel_ids, actions, conditions',
    )
    .eq('guild_id', handle.guildId)
    .eq('id', id)
    .maybeSingle();
  return (data as AutomationRow | null) ?? null;
}

async function automationCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('automations')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Insert an automation_executions row the way the production ExecutionLogger does. */
async function insertExecution(
  handle: LiveClientHandle,
  automationId: string,
  opts: InsertExecutionOptions = {},
): Promise<string | null> {
  const { error } = await handle.supabase.from('automation_executions').insert({
    automation_id: automationId,
    guild_id: handle.guildId,
    triggered_by: opts.triggeredBy ?? 'system',
    trigger_event: opts.triggerEvent ?? 'member.joined',
    conditions_passed: opts.conditionsPassed ?? true,
    actions_executed: opts.actionsExecuted ?? 1,
    actions_failed: opts.actionsFailed ?? 0,
    errors: [],
    duration_ms: 5,
  });
  return error?.message ?? null;
}

/** Insert an execution row carrying a durable occurrence_id (the dedup claim). */
async function insertExecutionWithOccurrence(
  handle: LiveClientHandle,
  automationId: string,
  occurrenceId: string,
): Promise<string | null> {
  const { error } = await handle.supabase.from('automation_executions').insert({
    automation_id: automationId,
    guild_id: handle.guildId,
    triggered_by: 'system',
    trigger_event: 'member.joined',
    conditions_passed: true,
    actions_executed: 1,
    actions_failed: 0,
    errors: [],
    duration_ms: 5,
    occurrence_id: occurrenceId,
  });
  return error?.message ?? null;
}

async function occurrenceRowCount(
  handle: LiveClientHandle,
  automationId: string,
  occurrenceId: string,
): Promise<number> {
  const { count } = await handle.supabase
    .from('automation_executions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('automation_id', automationId)
    .eq('occurrence_id', occurrenceId);
  return count ?? 0;
}

async function executionCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('automation_executions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
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
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS / a missing
 * GRANT → 0), or null when no anon key / URL is available (→ GATE).
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (the anon role is blocked
    // from the table by RLS / a missing GRANT — the deny we want to prove) from the
    // key itself being rejected before authz ran (inconclusive → GATE).
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
 * Prove guild-scoped RLS on an automations table: the service role reads
 * `serviceRowsSeen` rows for THIS guild while an anon client reads zero. Made
 * non-vacuous by the positive control — the caller has already created rows under
 * the guild (serviceRowsSeen > 0), so an anon read of ZERO is a real deny, not
 * "nothing to read." GATEs (never fakes) when no anon key is exported or the probe
 * is inconclusive.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: 'automations' | 'automation_executions',
  serviceRowsSeen: number,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero \`${table}\` rows (guild-scoped owner_full_access RLS; no anon GRANT).`,
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
      `The service role reads this guild’s \`${table}\` rows while an anon client reads zero of them (owner_full_access RLS / no anon GRANT).`,
    observation:
      `service-role sees ${serviceRowsSeen} \`${table}\` row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} \`${table}\` row(s) for that guild.`,
    impact:
      `An automation row visible to the service role was also readable with an anon key — RLS is not denying anon reads (automation internals exposed to non-members).`,
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
    promise: "This scenario's nominal automation run raises no owner alert (failure/guard alerts are silent by default).",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
  });
}

/** The engine fires on live gateway events + Valkey guards + Discord REST — none
 *  drivable from this bot-only, slash-only, Redis-less, gateway-less harness. */
function gateEngineExecution(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'the automation engine fires on live Discord gateway events (member.joined/message.sent/role.gained) and executes actions via Discord REST; this domain exposes NO slash command, so the bot-only local-Supabase harness cannot emit those events or observe the executed side effects (needs DISCORD_TOKEN + a live guild, plus a running Valkey for the fire-limit/cooldown SET-NX/INCR guard paths)',
  );
}

/** A guard enforced atomically in Valkey (fire-limit INCR / custom-rate-limit /
 *  DM-cooldown SET NX) — cannot run without a reachable Redis. */
function gateValkeyGuard(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    promise,
    'no Valkey/Redis reachable — the atomic per-user fire-limit (INCR), custom per-automation rate limit, and DM-cooldown (SET NX) guards cannot run, so the rate-limited / single-claim behavior is not exercisable',
  );
}

/** Automation content is rendered by the engine and posted to Discord channels/DMs
 *  — there is no slash-command reply to inspect for branding here. */
function gateBrandingNoReply(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Automation-sent content uses the owner’s configured voice + template variables and system notices carry the powered-by-SomniBot attribution.',
    'this domain emits no slash-command reply — all member-facing surfaces (posted messages, DMs, the loop-guard/mass-action owner notices) are engine-rendered Discord messages needing a live embed/message snapshot (DISCORD_TOKEN + live guild) to inspect',
  );
}

/** automation.created/updated/deleted rows are written by the dashboard save path;
 *  automation.executed/loop_blocked/mass_action_held rows by the engine — neither
 *  reachable from a bot-only slash harness. */
function gateAuditEngine(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'automation.created/updated/deleted audit rows are written by the dashboard `/api/automations` save path and automation.executed/loop_blocked/mass_action_held rows by the engine as it processes gateway events; with no dashboard session and no emittable gateway events here, no bot-driven automations-category audit row is produced (the DB-observable rule/RLS/isolation/cleanup invariants are proven instead)',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s event occurrence yields no duplicate executions/roles/messages/DMs.',
    `the DB-observable replay backbone (execution-log dedup shape + the occurrence-id gap) is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — empty out of the box; a first previewed member.joined welcome rule persists. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // 1) Out of the box a fresh guild has ZERO automations (the 'unconfigured' initial
  //    state — the engine idles on events until a rule is enabled).
  const initialCount = await automationCount(handle);
  ctx.expect(initialCount === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Out of the box a fresh guild has zero automations (the engine idles on incoming events).',
    observation: `fresh-guild automations rows = ${initialCount} (expected 0).`,
    impact: 'A brand-new guild shipped with pre-existing automations — the unconfigured initial state was violated.',
  });

  // 2) A previewed member.joined welcome rule persists in the loader-consumable shape:
  //    enabled by DB default (true), zero executions by DB default, one parsed action.
  //    (These are DB-applied defaults, not values we wrote — so this proves the create
  //    LANDED loader-ready, not that Supabase echoes our input.)
  const { id, error } = await insertAutomation(ctx, handle, { suffix: 'welcome', triggerType: 'member.joined' });
  const row = id ? await readAutomation(handle, id) : null;
  ctx.expect(
    error === null &&
      row !== null &&
      row.enabled === true &&
      row.execution_count === 0 &&
      row.trigger_type === 'member.joined' &&
      row.actions.length === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A previewed member.joined welcome rule persists in the loader-consumable shape (enabled by default, zero executions, one action) so the engine can hot-load it.',
      observation:
        `insert error=${error ?? 'none'}, enabled=${row?.enabled} (DB default true), ` +
        `execution_count=${row?.execution_count} (DB default 0), trigger_type=${row?.trigger_type}, actions=${row?.actions.length}.`,
      impact:
        'A created automation did not persist in the shape the loader reads (enabled/exec-count defaults, trigger, actions), so the engine could not hot-load it.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The actual welcome POST (member mention resolved), and the default guardrails
  // (dm-cooldown 300s, per-user fire limit 5/min, mass-action threshold 25,
  // max-chain-depth 3, preview-required) are engine + Valkey + gateway effects.
  const dmCooldown = declaredDefault(ctx.domain, 'dm-cooldown-seconds');
  const fireLimit = declaredDefault(ctx.domain, 'user-fire-limit-per-minute');
  gateEngineExecution(
    ctx,
    `The welcome message posts exactly once in the configured channel with {user} resolved, one automation_executions row records the success, and the default guardrails hold (dm-cooldown=${String(dmCooldown)}s, fire-limit=${String(fireLimit)}/min).`,
  );
  gateAuditEngine(ctx, 'automation.created and automation.executed audit rows exist with actor ids and before/after state.');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** SET-A — a custom per-automation rate limit is a distinct, loader-visible config. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // A default rule (no custom limit → both columns null, the loader maps them to
  // rateLimitPerUser/rateLimitWindowSeconds = null) …
  const plain = await insertAutomation(ctx, handle, { suffix: 'plain', triggerType: 'message.sent' });
  const plainRow = plain.id ? await readAutomation(handle, plain.id) : null;
  // … versus a SET-A rule configured to fire at most once per 60s per user (the
  //    exact rate_limit_per_user / rate_limit_window_seconds columns the engine's
  //    AutomationRateLimiter.allowCustom consumes).
  const limited = await insertAutomation(ctx, handle, {
    suffix: 'ratelimited',
    triggerType: 'message.sent',
    rateLimitPerUser: 1,
    rateLimitWindowSeconds: 60,
  });
  const limitedRow = limited.id ? await readAutomation(handle, limited.id) : null;

  // Prove the two configs are STRUCTURALLY DISTINCT (not that Supabase echoes input):
  // the default rule carries a null custom limit, the SET-A rule a populated one.
  ctx.expect(
    plainRow?.rate_limit_per_user === null &&
      plainRow?.rate_limit_window_seconds === null &&
      limitedRow?.rate_limit_per_user !== null &&
      limitedRow?.rate_limit_window_seconds !== null &&
      limitedRow?.rate_limit_per_user !== plainRow?.rate_limit_per_user,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A custom per-automation rate limit persists as loader-visible config distinct from an unlimited rule (rate_limit_per_user/window populated vs null).',
      observation:
        `plain rule custom-limit=${plainRow?.rate_limit_per_user}/${plainRow?.rate_limit_window_seconds}; ` +
        `SET-A rule custom-limit=${limitedRow?.rate_limit_per_user}/${limitedRow?.rate_limit_window_seconds} (populated & distinct).`,
      impact:
        'A saved per-automation rate limit did not persist in the rate_limit_per_user/window columns the engine reads — the custom limit would silently never apply.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The BEHAVIOR change (two triggers in the window → one execution; a third after
  // → a second) is enforced by the atomic Valkey counter under the engine.
  gateValkeyGuard(
    ctx,
    'Two qualifying triggers from the same member inside the 60s window produce exactly one execution; a third after the window produces a second (atomic Valkey rate-limit counter).',
  );
  gateEngineExecution(
    ctx,
    'The action lands once during the window and once after it; two automation_executions rows exist, and the suppressed fire writes no row.',
  );
  gateAuditEngine(ctx, 'Both executions are audited; the rate-suppressed fire is absent by design.');
  gateBrandingNoReply(ctx);
}

/** SET-B — a scope-filtered rule (channel Y) whose action re-emits a matching event. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const channelY = `${ctx.runPrefix}chan-Y`;
  const maxDepth = declaredDefault(ctx.domain, 'max-chain-depth');

  // A message.sent rule scoped to channel Y (the target_channel_ids array the
  // engine's checkScope reads) whose action posts a message that would re-trigger
  // the same rule — the loop-prone chain the max-chain-depth guard must cut.
  const scoped = await insertAutomation(ctx, handle, {
    suffix: 'chain',
    triggerType: 'message.sent',
    targetChannelIds: [channelY],
    actions: [{ type: 'send_message', config: { channel_id: channelY, message: 'chain {content}' } }],
  });
  const row = scoped.id ? await readAutomation(handle, scoped.id) : null;

  // Prove this second configuration is DISTINCT from SET-A and loader-visible: a
  // message.sent trigger scoped to exactly one channel (SET-A was unscoped).
  ctx.expect(
    row !== null &&
      row.trigger_type === 'message.sent' &&
      row.target_channel_ids.length === 1 &&
      row.target_channel_ids[0] === channelY,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A scope-filtered rule persists with its channel-scope array (target_channel_ids) so the engine only matches events in the scoped channel — distinct from SET-A.',
      observation:
        `trigger_type=${row?.trigger_type}, target_channel_ids=[${(row?.target_channel_ids ?? []).join(', ')}] ` +
        `(exactly the one scoped channel).`,
      impact:
        'A saved channel scope did not persist in target_channel_ids — the engine would match the rule server-wide instead of only in channel Y.',
    },
  );

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The positive loop-guard behavior — channel X fires nothing, channel Y chains, the
  // hop at max-chain-depth is dropped before any action runs, one loop-guard notice,
  // one automation.loop_blocked audit row — lives in the engine's in-memory chain-depth
  // guard (there is no durable occurrence/chain-depth table to observe here).
  gateEngineExecution(
    ctx,
    `The channel-X message fires nothing (scope exclusion) while channel Y chains; hops below max-chain-depth (${String(maxDepth)}) execute and the depth-ceiling hop is dropped before any further action runs.`,
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one loop-guard-notice for the cut chain and no alert for the scope-filtered non-match.',
    'the loop-guard notice is mirrored to the owner alert channel by the engine when the in-memory chain-depth guard trips — requires DISCORD_TOKEN + a live guild + emittable chain-reaction events',
  );
  gateAuditEngine(ctx, 'Exactly one automation.loop_blocked audit row records the dropped event with its source automation and depth.');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** INVALID — rule-shape validity is enforced ABOVE the DB (no DB CHECK guard). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // A valid baseline rule that must keep existing untouched through the rejection.
  const valid = await insertAutomation(ctx, handle, { suffix: 'valid', triggerType: 'member.joined' });

  // The catalog rejects an automation with 11 actions (> MAX_ACTIONS_PER_AUTOMATION=10)
  // at the dashboard/loader layer. The `automations` table carries NO CHECK constraint
  // on the actions JSONB, so a direct insert of an over-limit rule is ACCEPTED by the
  // database — proving the ONLY thing that stops an invalid definition reaching the
  // engine is the dashboard Zod validation + the loader's parseActions guard (both
  // gated below). This mirrors the wallet template's "guild_config has no DB CHECK".
  const elevenActions: Record<string, unknown>[] = Array.from({ length: 11 }, (_, i) => ({
    type: 'send_message',
    config: { channel_id: `${ctx.runPrefix}c${i}`, message: `a${i}` },
  }));
  const overLimit = await insertAutomation(ctx, handle, { suffix: 'overlimit', actions: elevenActions });
  ctx.expect(valid.error === null && overLimit.error === null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Rule-shape validity (≤10 actions, ≤5 conditions, known trigger) is enforced above the database — the automations table has no DB CHECK, so an invalid definition can only be stopped by the dashboard Zod layer + the loader’s parse guard.',
    observation:
      `valid insert error=${valid.error ?? 'none'}; 11-action (over-limit) insert error=${overLimit.error ?? 'none (DB accepts it — no CHECK constraint)'}.`,
    impact:
      'If the DB unexpectedly rejected/accepted these, the validation boundary assumed by the dashboard + loader would be wrong; the loader would still refuse the 11-action rule (parseActions returns null) so the engine never loads it.',
  });

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The actual 400-rejection + "the loader never sees it" belong to the dashboard/loader.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Creating an automation with eleven actions, an unknown trigger type, or six conditions returns 400 from validation; no side effects occur and existing rules keep running.',
    'automation-shape validation lives in the dashboard (Zod) + the loader’s parseActions/parseConditions/isTriggerType guards; the bot-only harness has no dashboard session and cannot drive the /api/automations reject path (the DB has no CHECK to reject it either)',
  );
  gateAuditEngine(ctx, 'Rejections are recorded (dashboard audit) without an automation.created row.');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** UNAUTH — automation internals never leak to a member/anon (RLS data-layer backstop). */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Real rule + execution content that MUST NOT leak to a non-manager. The dashboard
  // 403 is one layer; the DB-observable backstop is that an anon (session-less) client
  // cannot read a single automations OR automation_executions row (owner_full_access
  // RLS + no anon GRANT). Prove that deny for BOTH tables.
  const { id } = await insertAutomation(ctx, handle, { suffix: 'secret', triggerType: 'member.joined' });
  if (id) await insertExecution(handle, id, { triggeredBy: `${ctx.runPrefix}u-a` });

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveRlsIsolation(ctx, handle, 'automation_executions', await executionCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The route/API 403 gating on dashboard.manage_automations, and the logged denial
  // with the member's id, are dashboard session-auth surfaces.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A member without dashboard.manage_automations receives 403 from GET and POST /api/automations and the /automations route; navigation is hidden and no rule/execution content leaks in any response body.',
    'the route guard + API permission check (dashboard.manage_automations) live in the dashboard session-auth lane — not reachable from a bot-only harness (the DB-layer anon-denial backstop is proven above)',
  );
  gateAuditEngine(ctx, 'The denied attempts are logged with the member’s id (dashboard-written audit rows).');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** DEPFAIL — Valkey rate-limiter outage → fail-safe suppression (Valkey leg honestly gated). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The whole scenario is a VALKEY-outage failure branch: with the rate limiter down,
  // the engine must SUPPRESS fires (never run unlimited), alert the owner ONCE, and
  // resume without retroactive replays after recovery. The fault-proxy lane severs
  // SUPABASE only this wave — the contracted Valkey sever is deliberately not
  // exercised (a Supabase sever would not model this contract), and the engine's
  // triggers additionally need drivable gateway events. GATE every class honestly
  // (never fake an outage, never force-pass the failure-branch owner alert).
  const valkeyLane = ctx.faults?.valkey
    ? 'the contracted outage severs VALKEY; its fault proxy is registered but deliberately not severed this wave (Supabase-sever only), and the engine additionally needs drivable gateway events to observe suppression'
    : 'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane); the contracted Valkey-outage leg additionally needs the engine driving gateway events';
  ctx.gate(
    'Discord',
    'redis-dependency',
    'With Valkey stopped, qualifying triggers produce zero executions (fail-safe suppression, never unlimited firing); post-recovery triggers act normally.',
    valkeyLane,
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'No execution rows exist for the outage window, and rule rows stay guild-scoped through it.',
    valkeyLane,
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One automation.rate_limiter_down audit row is recorded for the outage.',
    `the rate_limiter_down audit row is written by the engine on the Valkey-outage branch — ${valkeyLane}`,
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one degradation alert is delivered to the owner (not one per suppressed fire), and it explains the fail-safe choice.',
    `${valkeyLane}; the alert additionally needs the owner alert channel readback (this is a failure branch where a single alert is expected, so "no alert" is deliberately NOT asserted)`,
  );
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'Suppressed occurrences are not fired retroactively after Valkey recovers.',
    valkeyLane,
  );
  gateBrandingNoReply(ctx);
}

/** RETRY — a transient Discord 500 on give_role converges to exactly one grant. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Positive-control rule so the RLS + no-alert proofs are non-vacuous. The catalog
  // RETRY owner-notification is "No alert fires for a self-recovering transient error",
  // so asserting zero owner alerts here is the contracted behavior (not a soft pass).
  const { id } = await insertAutomation(ctx, handle, {
    suffix: 'grant',
    triggerType: 'member.joined',
    actions: [{ type: 'give_role', config: { role_id: `${ctx.runPrefix}role` } }],
  });

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The give_role action is a Discord REST call, not a DB write; its injected-transient
  // -500 retry + single-grant convergence and the occurrence-id-keyed no-double-apply
  // need a mid-execution Discord fault lane + a live gateway.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A give_role action that receives an injected transient Discord 500 is retried and converges: the member holds the role exactly once with no duplicate grant or message.',
    'requires a mid-execution Discord fault-injection lane + a live gateway (the role grant is a Discord REST call executed by the engine, not a DB write)',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'One execution row records the eventual success with its error history.',
    `requires the engine to run the give_role action to write its execution row (automation id ${id ?? 'n/a'}) — not drivable without a gateway + Valkey`,
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retry reuses the occurrence id and cannot double-apply the grant.',
    'the durable-occurrence dedup is not backed by the schema (see the REPLAY finding) and the retry needs the fault lane',
  );
  gateAuditEngine(ctx, 'The audit trail shows the failed attempt and the converged outcome.');
  gateBrandingNoReply(ctx);
}

/** REPLAY — the exactly-once-per-occurrence contract is backed by the occurrence-id unique claim. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Positive-control rule + execution for the RLS proof and the schema probe.
  const { id } = await insertAutomation(ctx, handle, { suffix: 'replay', triggerType: 'member.joined' });
  if (id) await insertExecution(handle, id, { triggerEvent: 'member.joined' });

  // The exactly-once-per-occurrence contract is now backed by the schema: a
  // durable occurrence_id column + UNIQUE(guild_id, automation_id, occurrence_id).
  // Prove it directly — two execution rows for the SAME occurrence: the first
  // inserts, the second is rejected by the unique index (23505), leaving exactly
  // one row. (The engine stakes this claim BEFORE running actions, so a
  // redelivered gateway occurrence dedups to a single execution.)
  let dedupProven = false;
  let dedupObservation = 'no automation available to probe occurrence dedup';
  if (id) {
    const occ = `${ctx.runPrefix}occ-1`;
    const first = await insertExecutionWithOccurrence(handle, id, occ);
    const second = await insertExecutionWithOccurrence(handle, id, occ);
    const rows = await occurrenceRowCount(handle, id, occ);
    dedupProven = first === null && second !== null && rows === 1;
    dedupObservation =
      `first insert=${first ?? 'ok'}, ` +
      `replay insert=${second ?? 'ok (UNEXPECTED — duplicate accepted)'}, ` +
      `rows for the occurrence=${rows} (expected 1).`;
  }
  ctx.expect(dedupProven, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'The execution log persists a durable occurrence id per event occurrence so a redelivered occurrence dedups to exactly one execution row (never double-executing roles/messages/DMs).',
    observation: dedupObservation,
    impact:
      'automation_executions does not enforce one execution per occurrence id, so a redelivered gateway occurrence would write a SECOND execution row and re-run its actions — a replay-safety regression on side effects including grant_entitlement.',
  });

  await proveRlsIsolation(ctx, handle, 'automation_executions', await executionCount(handle));
  await proveNoOwnerAlert(ctx, handle);

  // The observable Discord-side "exactly once after redelivery" needs the durable
  // occurrence pipeline (above) + a live gateway to redeliver against.
  gateEngineExecution(
    ctx,
    'Redelivering the same platform-event occurrence produces no second execution: role grants, messages, and DMs for that occurrence id appear exactly once.',
  );
  gateAuditEngine(ctx, 'One automation.executed row exists; the replay is visible as deduplicated.');
  gateBrandingNoReply(ctx);
}

/** RESTART — enabled rules reload from the DB after a reboot (the durable rule state). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: create + enable a rule, snapshot its id, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const { id } = await insertAutomation(ctx, first, { suffix: 'persist', triggerType: 'member.joined' });
  const snapshot = id ? await readAutomation(first, id) : null;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The rule row lives in Supabase, so the loader
  // reloads it byte-identical — still enabled, same id, same trigger (this is what
  // makes "enabled automations reload from the database and keep firing" hold).
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = id ? await readAutomation(second, id) : null;
  ctx.expect(
    afterRestart !== null &&
      snapshot !== null &&
      afterRestart.id === snapshot.id &&
      afterRestart.enabled === true &&
      afterRestart.trigger_type === snapshot.trigger_type,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the enabled automation reloads from the database identical to its pre-restart state (rules survive a reboot and keep firing).',
      observation:
        `pre-restart id=${snapshot?.id}/enabled=${snapshot?.enabled}; ` +
        `post-restart id=${afterRestart?.id}/enabled=${afterRestart?.enabled}/trigger=${afterRestart?.trigger_type}.`,
      impact: 'An enabled automation did not survive a restart — the loader would not reload it and the rule would stop firing.',
    },
  );

  await proveRlsIsolation(ctx, second, 'automations', await automationCount(second));
  // The catalog RESTART owner-notification is "No false failure alert fires from a
  // clean restart" — assert zero alerts (the contracted behavior).
  await proveNoOwnerAlert(ctx, second);

  // The "durable occurrence recorded just before the restart completes exactly once
  // afterwards" facet is NOT backed by any persisted occurrence record (see REPLAY):
  // an in-flight occurrence is in-memory and does not survive a reboot. Gate it, with
  // the root cause pointed at the same durable-occurrence gap.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'A durable occurrence recorded just before the restart completes exactly once afterwards — not zero times and not twice.',
    'there is no durable occurrence/held table (the engine’s occurrenceId is in-memory only, see the REPLAY finding), so an in-flight occurrence cannot survive a reboot to be completed exactly once — the durable-occurrence pipeline is not yet wired',
  );
  gateEngineExecution(ctx, 'The pre-restart occurrence’s action lands exactly once post-restart; new triggers fire normally.');
  gateAuditEngine(ctx, 'The execution audit rows show no gap-induced duplicates.');
  gateBrandingNoReply(ctx);
}

/** RACE — both runaway guardrails (Valkey fire-limit + mass-action hold) under load. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const fireLimit = declaredDefault(ctx.domain, 'user-fire-limit-per-minute');
  const massThreshold = declaredDefault(ctx.domain, 'mass-action-threshold');

  // Positive-control rule so RLS + "no alert for normal rate limiting" are non-vacuous.
  await insertAutomation(ctx, handle, { suffix: 'burst', triggerType: 'message.sent' });

  await proveRlsIsolation(ctx, handle, 'automations', await automationCount(handle));
  // The catalog RACE owner-notification: "No alert fires for normal rate limiting"
  // (the mass-action approval card is gated separately below).
  await proveNoOwnerAlert(ctx, handle);

  // Guardrail 1 — the atomic per-user fire limit under a burst: needs Valkey INCR.
  gateValkeyGuard(
    ctx,
    `Six qualifying triggers from one member within a minute yield at most ${String(fireLimit)} executions; the atomic Valkey INCR never lets two concurrent fires share one budget slot.`,
  );
  // Guardrail 2 — the mass-action hold: needs the engine's guard + a durable held state.
  gateEngineExecution(
    ctx,
    `A rule whose one occurrence resolves to more than the mass-action threshold (${String(massThreshold)}) members halts in HELD before any member past the guardrail is touched.`,
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The held occurrence is recorded in the held state with no completed action rows past the threshold, scoped to the run guild.',
    'there is no durable occurrence/held table to record a held occurrence (see the REPLAY finding); the mass-action hold state is not persisted, so this is not DB-observable — the durable/held pipeline is not yet wired',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one mass-action approval card is delivered to the owner for the held occurrence — never one per affected member.',
    'the approval card is delivered by the engine mass-action guard to the owner channel — requires DISCORD_TOKEN + a live guild + the (unpersisted) held-occurrence path',
  );
  gateAuditEngine(ctx, 'Exactly one automation.mass_action_held audit row records the held occurrence with its member-count and threshold.');
  gateBrandingNoReply(ctx);
}

/** XGUILD — automations are strictly per-guild (the loader loads only its own guild). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // A member.joined rule in guild A and a DIFFERENT one in guild B, each with an
  // execution row. The AutomationLoader queries `.eq('guild_id', <its guild>)`, so a
  // guild-scoped read returns ONLY that guild's rule — which is exactly why a rule in
  // guild A fires nothing for a join in guild B.
  const a = await insertAutomation(ctx, handleA, { suffix: 'ruleA', triggerType: 'member.joined' });
  const b = await insertAutomation(ctx, handleB, { suffix: 'ruleB', triggerType: 'member.joined' });
  if (a.id) await insertExecution(handleA, a.id, { triggerEvent: 'member.joined' });
  if (b.id) await insertExecution(handleB, b.id, { triggerEvent: 'member.joined' });

  const rowA = a.id ? await readAutomation(handleA, a.id) : null;
  const rowB = b.id ? await readAutomation(handleB, b.id) : null;
  // Each guild scope reads its OWN rule and never the other's: two REAL distinct rows
  // under distinct guild_ids (not a count>=0). Cross-reads return nothing.
  const crossAinB = a.id ? await readAutomation(handleB, a.id) : null;
  ctx.expect(
    rowA?.guild_id === guildA &&
      rowB?.guild_id === guildB &&
      rowA?.id !== rowB?.id &&
      crossAinB === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN automation and never the other guild’s: guild A → rule A, guild B → rule B (distinct rows under distinct guild_ids); a guild-B-scoped read of guild A’s rule returns nothing.',
      observation:
        `guild A rule under "${rowA?.guild_id}", guild B rule under "${rowB?.guild_id}", distinct ids=${rowA?.id !== rowB?.id}; ` +
        `guild-B-scoped read of guild A’s rule = ${crossAinB === null ? 'none (isolated)' : 'LEAKED'}.`,
      impact: 'A guild-scoped automation read returned another guild’s rule — the per-guild load that prevents cross-guild firing is broken.',
    },
  );

  // Per-guild execution isolation: each guild's execution count reflects only its own.
  const execA = await executionCount(handleA);
  const execB = await executionCount(handleB);
  ctx.expect(execA === 1 && execB === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Execution logs are guild-scoped: each guild sees only its own execution rows.',
    observation: `guild A execution rows=${execA}, guild B execution rows=${execB} (each expected exactly its own 1).`,
    impact: 'Execution rows crossed a guild boundary — per-guild execution isolation broken.',
  });

  await proveRlsIsolation(ctx, handleA, 'automations', await automationCount(handleA));
  await proveNoOwnerAlert(ctx, handleA);

  // The observable "no action lands in guild A for guild B's event" needs the engine +
  // gateway; each guild's audit trail containing only its own events is engine-written.
  gateEngineExecution(ctx, 'A member.joined in guild B lands no action in guild A (and vice versa); neither owner is alerted about the other guild.');
  gateAuditEngine(ctx, 'Each guild’s audit trail contains only its own automation events.');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** CLEANUP — run-prefixed rules + executions are swept (FK cascade); audit is retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Create run-prefixed operational rows: an automation + one execution (FK child,
  // ON DELETE CASCADE), plus a run-prefixed automations-category audit row that the
  // anonymize-over-delete contract says must be RETAINED (not swept).
  const { id } = await insertAutomation(ctx, handle, { suffix: 'cleanup', triggerType: 'member.joined' });
  if (id) await insertExecution(handle, id, { triggerEvent: 'member.joined' });
  await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'automation',
    actor_id: `${ctx.runPrefix}engine`,
    action: 'automation.executed',
    target_type: 'automation',
    target_id: id ?? `${ctx.runPrefix}auto`,
    category: 'automations',
  });

  const rulesBefore = await automationCount(handle);
  const execBefore = await executionCount(handle);
  ctx.expect(rulesBefore >= 1 && execBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed automation + execution rows (pre-cleanup baseline).',
    observation: `pre-cleanup: automation rows=${rulesBefore}, execution rows=${execBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed automation rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(ctx, handle, 'automations', rulesBefore);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed automation
  // and execution rows remain (the execution row also confirms the FK cascade).
  await ctx.sweepGuildRows(handle);
  const rulesAfter = await automationCount(handle);
  const execAfter = await executionCount(handle);
  ctx.expect(rulesAfter === 0 && execAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed automation and execution rows are deleted; a final sweep finds zero run-prefixed automation resources (the execution rows cascade with their automation).',
    observation: `post-sweep: automation rows=${rulesAfter}, execution rows=${execAfter} (expected 0/0).`,
    impact: 'The cleanup sweep left run-prefixed automation rows behind — the suite leaves residue.',
  });

  // Running cleanup twice is a safe no-op (idempotent sweep).
  await ctx.sweepGuildRows(handle);
  const rulesAfter2 = await automationCount(handle);
  ctx.expect(rulesAfter2 === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running cleanup twice is a safe no-op.',
    observation: `automation rows after a second sweep = ${rulesAfter2} (expected 0, no error).`,
    impact: 'A second cleanup sweep was not a safe no-op.',
  });

  // Audit history is RETAINED, not deleted (anonymize-over-delete): the automations-
  // category audit row survives the operational sweep.
  const { count: auditAfter } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('category', 'automations');
  ctx.expect((auditAfter ?? 0) >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'Run audit rows persist after cleanup — the automations-category audit_logs row is retained (anonymize-over-delete), never deleted by the operational sweep.',
    observation: `automations-category audit_logs rows for the guild after the sweep = ${auditAfter ?? 0} (expected ≥1, retained).`,
    impact: 'The cleanup sweep deleted audit history — violating the anonymize-over-delete retention contract.',
  });

  // Discord/channel readback of removed run-prefixed posts/roles/DMs is a live-guild lane.
  gateEngineExecution(ctx, 'No run-prefixed messages, roles, or DM residue remain in the test guild after cleanup.');
  gateBrandingNoReply(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Automations domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus the
 * 12 scenario scripts. `automation_executions` is listed before `automations` (it is
 * an FK child, ON DELETE CASCADE). `audit_logs` is intentionally NOT swept — audit
 * history is retained (anonymize-over-delete), which CLEANUP proves.
 */
export const administrationAutomationsProof: DomainProof = {
  domainId: 'administration-automations',
  guildScopedTables: [
    // child → parent: executions FK-reference automations (ON DELETE CASCADE).
    'automation_executions',
    'automations',
    // owner-notification rows this domain would raise.
    'alerts',
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
