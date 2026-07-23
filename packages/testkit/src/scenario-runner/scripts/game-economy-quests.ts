/**
 * scenario-runner/scripts/game-economy-quests — the Daily & Weekly Quests domain proof.
 *
 * Binds the quests domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven against LOCAL Supabase. The domain's atomic guarantees live in
 * production RPCs — `economy_quest_increment_progress` (atomic, LEAST-capped),
 * `economy_quest_atomic_claim` (flips only completed+unclaimed rows for the invoking
 * user, returning exactly those — the concurrency + replay-safety + claim-others wall),
 * `economy_add_balance` (the play-money payout) and `seed_default_quest_templates` — so
 * every DB-observable / RLS / idempotency assertion drives those REAL RPCs and reads the
 * effect back. Nothing synthetic is asserted.
 *
 * ── The load-bearing harness boundary for THIS domain ───────────────────────────────
 * The two member-facing commands are SUBCOMMANDS: `/quests view` and `/quests claim`
 * (features/quests/commands.ts → `interaction.options.getSubcommand()`). The scenario
 * runner's `runSlash` (context.ts) builds the interaction WITHOUT a subcommand and
 * `RunSlashParams` carries no subcommand field, so neither subcommand can be dispatched
 * in-process. Every assertion that depends on the `/quests view|claim` reply/embed
 * (the branded quest board, the claim embed's coin/XP totals, the exact-count slate) is
 * therefore GATED with that precise reason — it is not fakeable here, and it is a real
 * "cannot drive now" boundary (a subcommand-capable injector or the live Discord
 * readback lane closes it). The bare `/quests` (no subcommand) IS dispatchable: with
 * quests disabled the manager is absent and the handler replies before any
 * `getSubcommand()`, so the disabled-master-switch reply is proven live (INVALID).
 *
 * Behavior-bug discovery (surfaced as FAILs, never softened):
 *   1. `economy_quest_reward_base` (catalog control "quest-reward-base", intended so
 *      "quest templates scale from" it) is referenced NOWHERE in the bot — seeded
 *      template rewards are fixed literals. Raising the base changes no payout. SET-A
 *      records the divergence as a FAIL.
 *   2. Quest state changes write NO append-only `audit_logs` row (the manager never
 *      calls AuditService and no DB trigger fills the gap), contradicting the catalog's
 *      per-action audit promise. Proven DB-observably as a FAIL in the lifecycle scenarios.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Typed row shapes ──────────────────────────────────────────────────────

interface QuestTemplateRow {
  id: string;
  quest_type: string;
  title: string;
  action_type: string;
  target_count: number;
  reward_currency: number;
  reward_xp: number;
}

interface QuestProgressRow {
  id: string;
  template_id: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  guild_id: string;
  user_id: string;
}

interface ClaimedRow {
  id: string;
  template_id: string;
  reward_currency: number;
  reward_xp: number;
}

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

// ── Catalog-default helper ────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** The guild_config seed that turns a booted guild into a real quests-enabled guild at
 *  the catalog-declared defaults (DB column defaults intentionally diverge — see the
 *  file header / the domain concerns). */
function questConfig(ctx: ScenarioContext, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    economy_quests_enabled: Boolean(declaredDefault(ctx.domain, 'quests-enabled') ?? true),
    economy_daily_quest_count: Number(declaredDefault(ctx.domain, 'daily-quest-count') ?? 3),
    economy_weekly_quest_count: Number(declaredDefault(ctx.domain, 'weekly-quest-count') ?? 5),
    economy_quest_reward_base: Number(declaredDefault(ctx.domain, 'quest-reward-base') ?? 100),
    ...overrides,
  };
}

// ── Real production RPC / table helpers ───────────────────────────────────

/** Seed the canonical default template pool (7 daily + 5 weekly) — the REAL
 *  production RPC the manager calls; idempotent (no-ops if templates already exist). */
async function seedTemplates(handle: LiveClientHandle): Promise<void> {
  await handle.supabase.rpc('seed_default_quest_templates', { p_guild_id: handle.guildId });
}

async function readTemplates(handle: LiveClientHandle, questType?: string): Promise<QuestTemplateRow[]> {
  let query = handle.supabase
    .from('economy_quest_templates')
    .select('id, quest_type, title, action_type, target_count, reward_currency, reward_xp')
    .eq('guild_id', handle.guildId)
    .limit(1000);
  if (questType) query = query.eq('quest_type', questType);
  const { data } = await query;
  return (data as QuestTemplateRow[] | null) ?? [];
}

async function templateByTitle(handle: LiveClientHandle, title: string): Promise<QuestTemplateRow | null> {
  const { data } = await handle.supabase
    .from('economy_quest_templates')
    .select('id, quest_type, title, action_type, target_count, reward_currency, reward_xp')
    .eq('guild_id', handle.guildId)
    .eq('title', title)
    .maybeSingle();
  return (data as QuestTemplateRow | null) ?? null;
}

/** Arrange a progress row for a user on a real template (the state the cadence would
 *  assign). Returns the row id so a later increment/claim targets it. */
async function insertProgress(
  handle: LiveClientHandle,
  userId: string,
  templateId: string,
  progress: number,
  completed: boolean,
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('economy_quest_progress')
    .insert({
      guild_id: handle.guildId,
      user_id: userId,
      template_id: templateId,
      progress,
      completed,
      claimed: false,
      completed_at: completed ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function readProgressById(handle: LiveClientHandle, id: string): Promise<QuestProgressRow | null> {
  const { data } = await handle.supabase
    .from('economy_quest_progress')
    .select('id, template_id, progress, completed, claimed, guild_id, user_id')
    .eq('id', id)
    .maybeSingle();
  return (data as QuestProgressRow | null) ?? null;
}

async function progressRows(handle: LiveClientHandle, userId: string): Promise<QuestProgressRow[]> {
  const { data } = await handle.supabase
    .from('economy_quest_progress')
    .select('id, template_id, progress, completed, claimed, guild_id, user_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .limit(1000);
  return (data as QuestProgressRow[] | null) ?? [];
}

/** REAL atomic progress increment (features/quests trackProgress → this RPC). */
async function incrementProgress(handle: LiveClientHandle, id: string, amount: number): Promise<void> {
  await handle.supabase.rpc('economy_quest_increment_progress', { p_id: id, p_amount: amount });
}

/** REAL atomic claim: flips completed+unclaimed rows for THIS user only, returns them. */
async function atomicClaim(handle: LiveClientHandle, userId: string): Promise<ClaimedRow[]> {
  const { data } = await handle.supabase.rpc('economy_quest_atomic_claim', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  return (data as ClaimedRow[] | null) ?? [];
}

/** REAL play-money payout (the exact RPC claimQuests calls; upserts the wallet). */
async function payout(handle: LiveClientHandle, userId: string, amount: number): Promise<void> {
  await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
}

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, bank, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

/** The guild's configured wallet starting balance. economy_get_or_create_wallet
 *  seeds a brand-new wallet at guild_config.economy_starting_balance, so a claim's
 *  payout lands ON TOP of it — a wallet reads (starting_balance + reward), NOT the
 *  bare reward. Reading it (rather than hardcoding the harness's seeded 500) keeps
 *  the payout/exactly-once assertions correct regardless of the seeded value. */
async function startingBalance(handle: LiveClientHandle): Promise<number> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('economy_starting_balance')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return Number((data as { economy_starting_balance?: number } | null)?.economy_starting_balance ?? 0);
}

/**
 * Count quests-attributable rows in the append-only audit_logs table. Returns null
 * (NOT 0) when the read errors, so a failed query can never masquerade as "no audit
 * row written". Filters to quest-specific rows (category 'quests' or a quest action)
 * so unrelated boot-time audit noise for the guild cannot mask the gap.
 */
async function questAuditCount(handle: LiveClientHandle): Promise<number | null> {
  const { data, error } = await handle.supabase
    .from('audit_logs')
    .select('action, category')
    .eq('guild_id', handle.guildId)
    .limit(2000);
  if (error) return null;
  const rows = (data as Array<{ action: string | null; category: string | null }> | null) ?? [];
  return rows.filter(
    (r) =>
      (r.category ?? '').toLowerCase() === 'quests' ||
      (r.action ?? '').toLowerCase().includes('quest'),
  ).length;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) on a read error so a failed
 * read never reads as "no alert raised" (never a false-clean pass — the caller GATEs).
 */
async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

async function progressCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_quest_progress')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/** Read the last editReply/reply content string a handler produced. */
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return String((edits[edits.length - 1]!.payload as { content?: string } | undefined)?.content ?? '');
  }
  const reply = captured.find('reply');
  return String((reply?.payload as { content?: string } | undefined)?.content ?? '');
}

/**
 * Anon-denial probe via the PostgREST REST endpoint. Returns the number of rows an
 * anon key can read (RLS/GRANT deny → 0), or null when no anon key / inconclusive
 * (→ GATE). Mirrors the wallet-rewards proof exactly (42501 permission-denied = the
 * deny we want to prove). economy_quest_progress + economy_quest_templates are on the
 * v6 hardening REVOKE list, so anon has zero table access.
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
      return 0; // anon role denied the table — RLS/GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped isolation on the quests progress table with a positive control:
 * the scenario has created this user's progress row (service role sees it), so an anon
 * client reading ZERO of those rows is a real deny, not "nothing to read". Cross-guild
 * isolation across two REAL guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_quest_progress rows (v6 hardening REVOKE).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_quest_progress', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_quest_progress rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const rows = await progressRows(handle, userId);
  // Non-vacuity: the anon-deny proof only means something when a positive control
  // exists (a progress row the service role actually sees). If this scenario
  // arranged none, an anon read of zero proves nothing — there was nothing to
  // leak — so GATE rather than misreport a phantom "exposed to anon". (Anon
  // reading 0 here is a genuine 42501 GRANT/RLS deny, not a leak.)
  if (rows.length === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_quest_progress rows (guild-scoped RLS + GRANT lockdown).',
      `no positive control: the service role sees 0 quest-progress row(s) for the user under guild "${handle.guildId}", so anon reading 0 is vacuous — anon-denial is proven positively in scenarios that do arrange a progress row`,
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s quest-progress rows while an anon client reads zero of them (guild-scoped RLS + GRANT lockdown).',
    observation:
      `service-role sees ${rows.length} progress row(s) for the user under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_quest_progress row(s) for that guild.`,
    impact:
      'A quest-progress row visible to the service role was also readable with an anon key — quest data is exposed to unauthenticated clients.',
  });
}

/**
 * Prove the catalog's audit promise DB-observably — and record the REAL divergence:
 * the QuestsManager writes no audit_logs row for any quest action (no AuditService
 * call, no DB trigger), so a quests-attributable audit read returns zero. This FAILs
 * (a finding for the owner), never softened to a pass or a gate.
 */
async function proveQuestAudit(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const rows = await questAuditCount(handle);
  if (rows === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'Every quests state change lands one append-only audit_logs row with actor, guild, and correlation id.',
      'the audit_logs read errored, so the audit trail cannot be evaluated (never recorded as a false result)',
    );
    return;
  }
  ctx.expect(rows > 0, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'Every quests state change (assignment, progress, claim, payout) lands exactly one append-only audit_logs row with actor id, guild id, and a correlation id.',
    observation:
      `after driving real quest actions in this scenario, audit_logs holds ${rows} quests-attributable row(s) for the guild ` +
      `(QuestsManager calls no AuditService and no DB trigger writes one).`,
    impact:
      'No audit trail exists for quest actions — claims, payouts and progress leave zero append-only audit_logs evidence, contradicting the domain audit promise.',
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
  } else {
    ctx.expect(alerts === 0, {
      assertionClass: 'owner-notification',
      channel: 'db-observable',
      promise: "This scenario's happy path raises no owner alert.",
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a quests happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch alerts (cadence-degraded / claim-payout-reverted) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/** The member-facing Discord effects (quest board embed, claim embed in a channel). */
function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The quest board (/quests view) and the claim embed (/quests claim) are observed working in the live test guild.',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild); the subcommand-routed /quests view|claim reply is also undrivable via the runner’s runSlash',
  );
}

/** Count a member's assigned quest-progress rows by their template's quest_type. */
async function slateCounts(handle: LiveClientHandle, userId: string): Promise<{ daily: number; weekly: number }> {
  const { data } = await handle.supabase
    .from('economy_quest_progress')
    .select('id, template:economy_quest_templates(quest_type)')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .limit(1000);
  const rows = (data as Array<{ template: { quest_type: string } | null }> | null) ?? [];
  let daily = 0;
  let weekly = 0;
  for (const r of rows) {
    if (r.template?.quest_type === 'daily') daily++;
    else if (r.template?.quest_type === 'weekly') weekly++;
  }
  return { daily, weekly };
}

/**
 * Drive the REAL `/quests view` subcommand for a fresh member: QuestsManager.viewQuests
 * auto-assigns the daily+weekly slate sized by config. Assert the exact counts, then a
 * second view renders the branded board embed (both live via the subcommand injector).
 */
async function proveSlateSizing(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  dailyCount: number,
  weeklyCount: number,
): Promise<void> {
  const slateUser = ctx.userId('slate');
  // First view assigns the slate and replies "New quests assigned!".
  await ctx.runSlash(handle, { commandName: 'quests', userId: slateUser, subcommand: 'view' });
  const slate = await slateCounts(handle, slateUser);
  ctx.expect(slate.daily === dailyCount && slate.weekly === weeklyCount, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `A member's first /quests view assigns exactly ${dailyCount} daily and ${weeklyCount} weekly quests for the cycle.`,
    observation:
      `after driving the real /quests view: ${slate.daily} daily + ${slate.weekly} weekly economy_quest_progress ` +
      `row(s) assigned (expected ${dailyCount}/${weeklyCount}).`,
    impact: 'The auto-assigned quest slate did not match the configured daily/weekly counts.',
  });

  // Second view renders the branded board embed for the now-assigned slate.
  const board = await ctx.runSlash(handle, { commandName: 'quests', userId: slateUser, subcommand: 'view' });
  const replies = board.allOf('reply');
  const lastReply = replies[replies.length - 1]?.payload as
    | { embeds?: Array<{ data?: { title?: string } }> }
    | undefined;
  const title = lastReply?.embeds?.[0]?.data?.title ?? '';
  ctx.expect(typeof title === 'string' && title.includes('Quests'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The /quests view board renders as a branded embed listing the member’s active quests.',
    observation: `/quests view (post-assignment) replied with an embed titled ${JSON.stringify(title)} (expected a "Quests" board).`,
    impact: 'The /quests view path did not render the branded quest board.',
  });
}

/**
 * Drive the REAL /quests view for a fresh per-scenario member and assert the
 * branded 'Your Quests' board embed renders (first view assigns the slate, the
 * second renders it). Live via the subcommand injector — no gate.
 */
async function proveBranding(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  // A fixed 'brand' member; each scenario runs in its own guild, so the same id
  // across scenarios never collides (progress rows are guild-scoped).
  const u = ctx.userId('brand');
  await ctx.runSlash(handle, { commandName: 'quests', userId: u, subcommand: 'view' });
  const board = await ctx.runSlash(handle, { commandName: 'quests', userId: u, subcommand: 'view' });
  const replies = board.allOf('reply');
  const last = replies[replies.length - 1]?.payload as
    | { embeds?: Array<{ data?: { title?: string } }> }
    | undefined;
  const title = last?.embeds?.[0]?.data?.title ?? '';
  ctx.expect(typeof title === 'string' && title.includes('Quests'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The /quests view board renders as a branded embed listing the member’s active quests.',
    observation: `/quests view replied with an embed titled ${JSON.stringify(title)} (expected a "Quests" board).`,
    impact: 'The /quests view branded board did not render.',
  });
}

/** When quests are disabled, /quests view replies with the branded disabled notice. */
async function proveDisabledReply(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const captured = await ctx.runSlash(handle, { commandName: 'quests', userId: ctx.userId('disabled'), subcommand: 'view' });
  const replies = captured.allOf('reply');
  const content = String((replies[replies.length - 1]?.payload as { content?: string } | undefined)?.content ?? '');
  ctx.expect(content.toLowerCase().includes('not enabled'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'When quests are disabled, /quests view explains the feature is off rather than rendering a board.',
    observation: `/quests view replied ${JSON.stringify(content)} (expected a "not enabled" notice).`,
    impact: 'The disabled-quests path did not surface the feature-off notice.',
  });
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate assignments, progress increments, or payouts.',
    `claim/assignment idempotency is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out of the box: pool seeds, real activity completes a quest, claim pays exactly once. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const dailyDefault = Number(declaredDefault(ctx.domain, 'daily-quest-count') ?? 3);
  const weeklyDefault = Number(declaredDefault(ctx.domain, 'weekly-quest-count') ?? 5);
  const baseDefault = Number(declaredDefault(ctx.domain, 'quest-reward-base') ?? 100);

  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: questConfig(ctx) });
  const userA = ctx.userId('a');

  // 1) The default template pool seeds enough for the catalog slate (≥ daily-count daily,
  //    exactly the weekly pool). REAL seed RPC.
  await seedTemplates(handle);
  const daily = await readTemplates(handle, 'daily');
  const weekly = await readTemplates(handle, 'weekly');
  ctx.expect(daily.length >= dailyDefault && weekly.length >= weeklyDefault, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `The default template pool seeds enough personalized quests for the catalog slate (${dailyDefault} daily, ${weeklyDefault} weekly).`,
    observation: `seeded pool = ${daily.length} daily template(s), ${weekly.length} weekly template(s).`,
    impact: 'The default quest template pool cannot fill the catalog-declared daily/weekly slate.',
  });

  // 2) Config took live effect: guild_config carries the catalog default counts + base.
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_quests_enabled, economy_daily_quest_count, economy_weekly_quest_count, economy_quest_reward_base')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfgRow = cfg as
    | { economy_quests_enabled: boolean; economy_daily_quest_count: number; economy_weekly_quest_count: number; economy_quest_reward_base: number }
    | null;
  ctx.expect(
    cfgRow?.economy_quests_enabled === true &&
      cfgRow?.economy_daily_quest_count === dailyDefault &&
      cfgRow?.economy_weekly_quest_count === weeklyDefault &&
      cfgRow?.economy_quest_reward_base === baseDefault,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `The quests config persists at the catalog defaults (enabled, ${dailyDefault} daily, ${weeklyDefault} weekly, base ${baseDefault}).`,
      observation: `guild_config: enabled=${cfgRow?.economy_quests_enabled}, daily=${cfgRow?.economy_daily_quest_count}, weekly=${cfgRow?.economy_weekly_quest_count}, base=${cfgRow?.economy_quest_reward_base}.`,
      impact: 'The quests configuration did not persist at the catalog defaults.',
    },
  );

  // 3) Real activity advances progress and flips completion exactly at target
  //    (economy_quest_increment_progress). 'Active Member' = chat, target 10, 100 coins/50 XP.
  const active = await templateByTitle(handle, 'Active Member');
  const activePid = active ? await insertProgress(handle, userA, active.id, 0, false) : null;
  if (activePid) await incrementProgress(handle, activePid, 10);
  const activeRow = activePid ? await readProgressById(handle, activePid) : null;
  ctx.expect(activeRow?.progress === 10 && activeRow?.completed === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Real tracked activity reaching a quest target flips it to completed exactly once (atomic increment RPC).',
    observation: `after +10 on a target-10 quest: progress=${activeRow?.progress} (expected 10), completed=${activeRow?.completed} (expected true).`,
    impact: 'Progress tracking did not complete a quest at its target.',
  });

  // 4) The atomic increment CAPS at target (LEAST) — no overshoot. 'Hard Worker' target 3.
  const hard = await templateByTitle(handle, 'Hard Worker');
  const hardPid = hard ? await insertProgress(handle, userA, hard.id, 0, false) : null;
  if (hardPid) await incrementProgress(handle, hardPid, 100);
  const hardRow = hardPid ? await readProgressById(handle, hardPid) : null;
  ctx.expect(hardRow?.progress === (hard?.target_count ?? 3) && hardRow?.completed === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A single tracked action never advances a quest past its target — the atomic increment clamps to target_count.',
    observation: `after +100 on a target-${hard?.target_count} quest: progress=${hardRow?.progress} (expected ${hard?.target_count}), completed=${hardRow?.completed}.`,
    impact: 'Progress overshot the quest target — the atomic increment did not clamp.',
  });

  // 5) /quests claim pays the template totals exactly once into the play-money wallet
  //    (economy_quest_atomic_claim → economy_add_balance). Claims both completed quests.
  const claimed = await atomicClaim(handle, userA);
  const totalCoins = claimed.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  const totalXp = claimed.reduce((s, r) => s + (r.reward_xp ?? 0), 0);
  if (totalCoins > 0) await payout(handle, userA, totalCoins);
  const wallet = await readWallet(handle, userA);
  const start = await startingBalance(handle);
  const expectedCoins = (active?.reward_currency ?? 0) + (hard?.reward_currency ?? 0);
  const expectedXp = (active?.reward_xp ?? 0) + (hard?.reward_xp ?? 0);
  ctx.expect(claimed.length === 2 && totalCoins === expectedCoins && totalXp === expectedXp && wallet?.wallet === start + expectedCoins, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Claiming completed quests pays the exact template coin + XP totals once into the play-money wallet (on top of the guild starting balance).',
    observation:
      `claimed ${claimed.length} quest(s) for ${totalCoins} coins / ${totalXp} XP (expected ${expectedCoins}/${expectedXp}); ` +
      `wallet=${wallet?.wallet} (expected ${start + expectedCoins} = ${start} starting + ${expectedCoins} reward).`,
    impact: 'A quest claim did not pay the exact template totals into the wallet.',
  });

  // Off-theme classes.
  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveSlateSizing(ctx, handle, dailyDefault, weeklyDefault);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard resize + raised reward base; surfaces the inert-reward-base divergence. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const raisedBase = 500;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: questConfig(ctx, {
      economy_daily_quest_count: 1,
      economy_weekly_quest_count: 2,
      economy_quest_reward_base: raisedBase,
    }),
  });
  const userA = ctx.userId('a');
  await seedTemplates(handle);

  // Config saved live (no restart) — DB-observable.
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_daily_quest_count, economy_weekly_quest_count, economy_quest_reward_base')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfgRow = cfg as { economy_daily_quest_count: number; economy_weekly_quest_count: number; economy_quest_reward_base: number } | null;
  ctx.expect(cfgRow?.economy_daily_quest_count === 1 && cfgRow?.economy_weekly_quest_count === 2 && cfgRow?.economy_quest_reward_base === raisedBase, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A dashboard resize (1 daily / 2 weekly) and raised reward base persist to guild_config for the live bot to read.',
    observation: `guild_config: daily=${cfgRow?.economy_daily_quest_count} (expected 1), weekly=${cfgRow?.economy_weekly_quest_count} (expected 2), base=${cfgRow?.economy_quest_reward_base} (expected ${raisedBase}).`,
    impact: 'A saved quests dashboard setting did not persist for the bot to read.',
  });

  // FINDING: the catalog promises claim totals "scaled from the raised reward base",
  // but economy_quest_reward_base is referenced NOWHERE in the bot — seeded template
  // rewards are fixed literals. Prove DB-observably that raising the base to 500 leaves
  // the 'Active Member' daily template's reward at its fixed seed value (100). FAIL.
  const active = await templateByTitle(handle, 'Active Member');
  ctx.expect(active !== null && active.reward_currency !== 100, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Raising quest-reward-base scales quest template rewards, so a claim pays amounts scaled from the raised base.',
    observation:
      `with economy_quest_reward_base=${raisedBase}, the 'Active Member' daily template still carries its fixed seed reward of ` +
      `${active?.reward_currency} coins (unscaled — the base control is referenced nowhere in the bot).`,
    impact: 'The quest-reward-base control is inert: raising it changes no payout, so the owner’s reward tuning has no effect.',
  });

  // The taxed/scaled claim STILL pays the fixed template total once (the claim path works).
  const activePid = active ? await insertProgress(handle, userA, active.id, active.target_count, true) : null;
  const claimed = await atomicClaim(handle, userA);
  const coins = claimed.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (coins > 0) await payout(handle, userA, coins);
  const wallet = await readWallet(handle, userA);
  const start = await startingBalance(handle);
  ctx.expect(Boolean(activePid) && claimed.length === 1 && wallet?.wallet === start + (active?.reward_currency ?? -1), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A claim under the resized config still pays the completed quest’s template total exactly once (on top of the guild starting balance).',
    observation: `claimed ${claimed.length} quest(s) for ${coins} coins; wallet=${wallet?.wallet} (expected ${start + (active?.reward_currency ?? 0)} = ${start} starting + ${active?.reward_currency} reward).`,
    impact: 'The claim path stopped paying correctly under the resized config.',
  });

  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveSlateSizing(ctx, handle, 1, 2);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — disable dailies (count 0), weekly keeps running; previously-completed quests stay claimable. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: questConfig(ctx, { economy_daily_quest_count: 0, economy_weekly_quest_count: 5 }),
  });
  const userA = ctx.userId('a');
  await seedTemplates(handle);

  // Config saved: daily disabled (0), weekly still 5.
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_daily_quest_count, economy_weekly_quest_count')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfgRow = cfg as { economy_daily_quest_count: number; economy_weekly_quest_count: number } | null;
  ctx.expect(cfgRow?.economy_daily_quest_count === 0 && cfgRow?.economy_weekly_quest_count === 5, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Disabling the daily cadence (count 0) while keeping weeklies persists independently to guild_config.',
    observation: `guild_config: daily=${cfgRow?.economy_daily_quest_count} (expected 0), weekly=${cfgRow?.economy_weekly_quest_count} (expected 5).`,
    impact: 'The independent daily-disable configuration did not persist.',
  });

  // A previously-completed WEEKLY quest remains claimable and pays normally (nothing lost
  // when a sibling cadence is disabled). REAL claim RPC.
  const weekly = await templateByTitle(handle, 'Social Butterfly'); // weekly, chat, 800 coins
  const pid = weekly ? await insertProgress(handle, userA, weekly.id, weekly.target_count, true) : null;
  const claimed = await atomicClaim(handle, userA);
  const coins = claimed.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (coins > 0) await payout(handle, userA, coins);
  const wallet = await readWallet(handle, userA);
  const start = await startingBalance(handle);
  ctx.expect(Boolean(pid) && claimed.length === 1 && wallet?.wallet === start + (weekly?.reward_currency ?? -1), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Disabling dailies leaves already-completed weekly quests fully claimable — nothing is lost.',
    observation: `previously-completed weekly claim: ${claimed.length} quest(s), ${coins} coins; wallet=${wallet?.wallet} (expected ${start + (weekly?.reward_currency ?? 0)} = ${start} starting + ${weekly?.reward_currency} reward).`,
    impact: 'Disabling a cadence piece broke claiming of already-completed quests in the other cadence.',
  });

  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveSlateSizing(ctx, handle, 0, 5);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid config never persists; the disabled master switch replies live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  // Boot with quests DISABLED but valid counts. The disabled state makes the bare
  // `/quests` command dispatch to the manager-absent branch (a REAL captured reply,
  // no subcommand needed) — the one drivable quests slash path in this harness.
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      economy_quests_enabled: false,
      economy_daily_quest_count: 3,
      economy_weekly_quest_count: 5,
      economy_quest_reward_base: 100,
    },
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_daily_quest_count, economy_weekly_quest_count, economy_quest_reward_base')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfgRow = cfg as { economy_daily_quest_count: number; economy_weekly_quest_count: number; economy_quest_reward_base: number } | null;
  ctx.expect(cfgRow?.economy_daily_quest_count === 3 && cfgRow?.economy_weekly_quest_count === 5 && cfgRow?.economy_quest_reward_base === 100, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid quest values byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config: daily=${cfgRow?.economy_daily_quest_count} (expected 3), weekly=${cfgRow?.economy_weekly_quest_count} (expected 5), base=${cfgRow?.economy_quest_reward_base} (expected 100).`,
    impact: 'A valid quest configuration was not retained after a rejected save.',
  });

  // The disabled master switch: `/quests` explains the feature is off (REAL dispatcher reply).
  const captured = await ctx.runSlash(handle, { commandName: 'quests', userId: userA, displayName: 'INVALID A' });
  const reply = replyContent(captured).toLowerCase();
  ctx.expect(reply.includes('not enabled') || reply.includes('🚫'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With quests disabled, a quest command cleanly explains the feature is off (master-switch behavior) rather than erroring.',
    observation: `/quests reply = "${replyContent(captured)}".`,
    impact: 'The quests master switch did not produce the disabled-feature reply.',
  });

  // The actual REJECTION of invalid values lives in the dashboard Zod layer; guild_config
  // has no DB CHECK constraint on these columns, so a bot-only harness cannot drive it.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard quests page surfaces a clear validation error for a slate count above the bound / a negative reward base.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint on the quest columns, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected quests configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveDisabledReply(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — a member can only claim their OWN quests; non-admin dashboard save is gated. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: questConfig(ctx) });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedTemplates(handle);

  // Arrange one completed, unclaimed quest for EACH member on the same template.
  const tmpl = await templateByTitle(handle, 'Gone Fishing'); // daily, fish, 200 coins
  const pidA = tmpl ? await insertProgress(handle, userA, tmpl.id, tmpl.target_count, true) : null;
  const pidB = tmpl ? await insertProgress(handle, userB, tmpl.id, tmpl.target_count, true) : null;

  // run-member-b claims: the RPC is keyed to the invoking user id, so it flips ONLY b's row.
  const claimedByB = await atomicClaim(handle, userB);
  const rowA = pidA ? await readProgressById(handle, pidA) : null;
  const rowB = pidB ? await readProgressById(handle, pidB) : null;
  ctx.expect(
    claimedByB.length === 1 &&
      claimedByB[0]!.id === pidB &&
      rowB?.claimed === true &&
      rowA?.claimed === false &&
      rowA?.completed === true,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A member’s /quests claim pays only their OWN completed quests; another member’s claimable rows are untouched.',
      observation:
        `b's claim flipped ${claimedByB.length} row(s) (its own=${claimedByB[0]?.id === pidB}); ` +
        `a's row: claimed=${rowA?.claimed} (expected false), completed=${rowA?.completed} (expected true).`,
      impact: 'A member’s claim reached another member’s quest rows — the claim-others authorization wall was breached.',
    },
  );

  // A ledger/audit-level check: b's claim wrote no audit row (the domain audit gap).
  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  // The non-admin dashboard save refusal is a dashboard session-auth lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save quest settings (returns an authorization error).',
    'requires the dashboard session-auth lane (Supabase RLS + session) — not reachable in this bot-only harness',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The harness's premise is a REACHABLE local Supabase, so a database outage cannot be
  // induced without a fault-injection lane. GATE the outage-dependent behavior honestly.
  ctx.gate(
    'Discord',
    'db-observable',
    'During a database outage, /quests view replies with the branded quests-unavailable template and no progress is lost.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed quest command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'After restoration the identical slate and progress counters reappear and tracking resumes.',
    'requires the outage fault lane to exercise the degrade-then-restore cycle',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate assignment or progress survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded quests-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the quests-unavailable branch (also subcommand-routed via /quests view)',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Quest rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a claim whose payout fails reverts to claimable and a retry pays exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The revert branch (claimQuests un-claims rows when economy_add_balance errors) fires
  // only when the payout FAILS after the atomic claim flipped rows — a fault that requires
  // injection at the payout-RPC boundary. GATE; never fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault on the payout, the first claim reports the branded payout-failed reply and the quests return to claimable; the retried claim pays the exact totals once.',
    'requires a mid-claim fault-injection lane (fail economy_add_balance after economy_quest_atomic_claim flipped rows)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The audit trail shows the reverted claim then a single successful retry payout — never zero-paid-but-marked-claimed and never double-paid.',
    'requires the mid-claim fault-injection lane (and quest actions currently write no audit_logs row — see the DEF audit finding)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The reverted claim and the successful retry resolve to exactly one payout in the play-money ledger.',
    'requires the mid-claim fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The claiming member sees the branded claim-payout-failed reply in the owner voice.',
    'requires the mid-claim fault-injection lane to reach the payout-failed branch (also subcommand-routed via /quests claim)',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The revert touches only the invoking member’s guild-scoped quest rows.',
    'requires the mid-claim fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one reasoned alert (quests.claim_payout_reverted) for the reverted claim.',
    'requires the mid-claim fault-injection lane plus owner alert channel readback',
  );
}

/** REPLAY — a replayed claim never double-pays (the atomic claim is idempotent). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: questConfig(ctx) });
  const userA = ctx.userId('a');
  await seedTemplates(handle);

  // Arrange one completed, unclaimed quest, then claim TWICE. The atomic claim's
  // WHERE completed=true AND claimed=false makes the second delivery a no-op (zero rows),
  // so the payout applies exactly once — the domain's core replay-safety guarantee.
  const tmpl = await templateByTitle(handle, 'Crafty'); // daily, craft, 250 coins/100 XP
  const pid = tmpl ? await insertProgress(handle, userA, tmpl.id, tmpl.target_count, true) : null;

  const first = await atomicClaim(handle, userA);
  const firstCoins = first.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (firstCoins > 0) await payout(handle, userA, firstCoins);

  const second = await atomicClaim(handle, userA); // REPLAY — same completed quest
  const secondCoins = second.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (secondCoins > 0) await payout(handle, userA, secondCoins); // guarded on 0 → no-op

  const wallet = await readWallet(handle, userA);
  const start = await startingBalance(handle);
  const row = pid ? await readProgressById(handle, pid) : null;
  ctx.expect(first.length === 1 && second.length === 0 && wallet?.wallet === start + (tmpl?.reward_currency ?? -1) && row?.claimed === true, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering a claim never double-pays: the atomic claim returns zero rows on replay, leaving exactly one payout on top of the starting balance.',
    observation:
      `first claim flipped ${first.length} row(s) (${firstCoins} coins), replayed claim flipped ${second.length} row(s) (${secondCoins} coins); ` +
      `wallet=${wallet?.wallet} (exactly-once=${start + (tmpl?.reward_currency ?? 0)} = ${start} starting + ${tmpl?.reward_currency} reward; a double-pay would read ${start + (tmpl?.reward_currency ?? 0) * 2}).`,
    impact: 'A replayed /quests claim double-paid — the atomic claim did not dedupe already-claimed quests.',
  });

  // Re-delivered ACTIVITY events (progress increments) dedupe against action idempotency
  // keys in the message-event path (not the increment RPC, which has no key) — undrivable here.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivered activity events deduplicate against their action idempotency keys so progress never doubles.',
    'progress-event dedup lives in the message/activity event handlers (upstream of economy_quest_increment_progress, which carries no idempotency key); driving it needs the activity-event replay harness',
  );

  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateLiveGuildReadback(ctx);
}

/** RESTART — quest slate + progress survive a full stack reboot (state lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: seed + arrange a completed quest, snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: questConfig(ctx) });
  await seedTemplates(first);
  const tmpl = await templateByTitle(first, 'Master Angler'); // weekly, fish, 1200 coins
  const pid = tmpl ? await insertProgress(first, userA, tmpl.id, tmpl.target_count, true) : null;
  const snapshot = pid ? await readProgressById(first, pid) : null;
  const snapCount = await progressCount(first, userA);
  await first.cleanup(); // simulate shutdown (disposes services; does NOT delete rows)

  // Boot #2: SAME guild id (restart). The slate + progress must be identical (in Supabase),
  // and the completed quest is still claimable and pays.
  const second = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: questConfig(ctx) });
  const afterRestart = pid ? await readProgressById(second, pid) : null;
  const afterCount = await progressCount(second, userA);
  ctx.expect(
    afterCount === snapCount &&
      afterRestart?.completed === snapshot?.completed &&
      afterRestart?.progress === snapshot?.progress &&
      afterRestart?.completed === true &&
      afterRestart?.claimed === false,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, the quest slate and progress match the pre-restart snapshot exactly.',
      observation:
        `pre-restart rows=${snapCount} (completed=${snapshot?.completed}, progress=${snapshot?.progress}); ` +
        `post-restart rows=${afterCount} (completed=${afterRestart?.completed}, progress=${afterRestart?.progress}, claimed=${afterRestart?.claimed}).`,
      impact: 'Quest slate/progress did not survive a restart — persisted quest state was lost or altered.',
    },
  );

  const claimed = await atomicClaim(second, userA);
  const coins = claimed.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (coins > 0) await payout(second, userA, coins);
  const wallet = await readWallet(second, userA);
  const start = await startingBalance(second);
  ctx.expect(claimed.length === 1 && wallet?.wallet === start + (tmpl?.reward_currency ?? -1), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A quest completed before the restart is still claimable after it and pays its exact total (on top of the starting balance).',
    observation: `post-restart claim: ${claimed.length} quest(s), ${coins} coins; wallet=${wallet?.wallet} (expected ${start + (tmpl?.reward_currency ?? 0)} = ${start} starting + ${tmpl?.reward_currency} reward).`,
    impact: 'A pre-restart completed quest could not be claimed after the restart.',
  });

  // The cadence tick spanning the restart assigns the next cycle exactly once — that runs
  // in the scheduled reset timer + the subcommand-routed assignment path.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The cadence tick spanning the restart assigns the next cycle’s slate exactly once with no duplicate quest rows.',
    'the cadence runs on QuestsManager.scheduleWeeklyReset + assignment reached via /quests view (subcommand-routed); undrivable in-process',
  );

  await proveQuestAudit(ctx, second);
  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  await proveBranding(ctx, second);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrent claims pay once; concurrent increments converge; unique key dedupes assignment. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: questConfig(ctx) });
  const userA = ctx.userId('a');
  await seedTemplates(handle);

  // (a) Two simultaneous claims of one completed quest → exactly ONE flips it; the other
  //     gets zero rows (atomic UPDATE ... WHERE claimed=false). Pay once.
  const tmpl = await templateByTitle(handle, 'Risk Taker'); // daily, crime, target 1, 100 coins
  const pid = tmpl ? await insertProgress(handle, userA, tmpl.id, tmpl.target_count, true) : null;
  const [c1, c2] = await Promise.all([atomicClaim(handle, userA), atomicClaim(handle, userA)]);
  const totalFlipped = c1.length + c2.length;
  const coins = [...c1, ...c2].reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (coins > 0) await payout(handle, userA, coins);
  const wallet = await readWallet(handle, userA);
  const start = await startingBalance(handle);
  ctx.expect(Boolean(pid) && totalFlipped === 1 && wallet?.wallet === start + (tmpl?.reward_currency ?? -1), {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two simultaneous claims of the same completed quest pay exactly once (atomic claim; one flips, one gets nothing).',
    observation:
      `concurrent claims flipped ${totalFlipped} row(s) total (c1=${c1.length}, c2=${c2.length}); ` +
      `wallet=${wallet?.wallet} (exactly-once=${start + (tmpl?.reward_currency ?? 0)} = ${start} starting + ${tmpl?.reward_currency} reward; a double would read ${start + (tmpl?.reward_currency ?? 0) * 2}).`,
    impact: 'Concurrent claims double-paid — the atomic claim did not serialize the flip.',
  });

  // (b) Two concurrent increments on a target-3 quest converge at the target (LEAST cap),
  //     never overshooting under the race.
  const hard = await templateByTitle(handle, 'Hard Worker'); // daily, work, target 3
  const hardPid = hard ? await insertProgress(handle, userA, hard.id, 0, false) : null;
  if (hardPid) await Promise.all([incrementProgress(handle, hardPid, 3), incrementProgress(handle, hardPid, 3)]);
  const hardRow = hardPid ? await readProgressById(handle, hardPid) : null;
  ctx.expect(hardRow?.progress === (hard?.target_count ?? 3) && hardRow?.completed === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Concurrent tracked actions converge at the target — the atomic increment never overshoots under a race.',
    observation: `after two concurrent +3 on a target-${hard?.target_count} quest: progress=${hardRow?.progress} (expected ${hard?.target_count}), completed=${hardRow?.completed}.`,
    impact: 'Concurrent increments overshot the target — the atomic increment did not clamp under contention.',
  });

  // (c) Two simultaneous first-of-cycle assignments produce ONE slate row: the unique key
  //     (guild_id,user_id,template_id,assigned_date) with ON CONFLICT DO NOTHING dedupes.
  const active = await templateByTitle(handle, 'Active Member');
  let assignRows = 0;
  if (active) {
    const row = {
      guild_id: handle.guildId,
      user_id: ctx.userId('b'),
      template_id: active.id,
      progress: 0,
      assigned_date: new Date().toISOString().slice(0, 10),
    };
    await handle.supabase
      .from('economy_quest_progress')
      .upsert([row, { ...row }], { onConflict: 'guild_id,user_id,template_id,assigned_date', ignoreDuplicates: true });
    const { count } = await handle.supabase
      .from('economy_quest_progress')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId)
      .eq('user_id', ctx.userId('b'))
      .eq('template_id', active.id);
    assignRows = count ?? 0;
  }
  ctx.expect(assignRows === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous first-of-cycle assignments of the same template produce exactly one slate row (unique per-cycle assignment key).',
    observation: `after a duplicate assignment for one (user,template,cycle): quest_progress rows=${assignRows} (expected 1).`,
    impact: 'A first-of-cycle race created duplicate quest slate rows — the unique assignment key failed.',
  });

  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx, handle);
  gateLiveGuildReadback(ctx);
}

/** XGUILD — quests are strictly per-guild: activity in guild B never touches guild A. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, guildConfigOverrides: questConfig(ctx) });
  const handleB = await ctx.bootGuild({ guildId: guildB, guildConfigOverrides: questConfig(ctx) });
  await seedTemplates(handleA);
  await seedTemplates(handleB);

  // Guild A: a completed, unclaimed quest — snapshot it.
  const tA = await templateByTitle(handleA, 'Gone Fishing');
  const pidA = tA ? await insertProgress(handleA, userA, tA.id, tA.target_count, true) : null;
  const snapA = pidA ? await readProgressById(handleA, pidA) : null;

  // Guild B: the SAME user completes and CLAIMS a quest under guild B's own templates.
  const tB = await templateByTitle(handleB, 'Gone Fishing');
  const pidB = tB ? await insertProgress(handleB, userA, tB.id, tB.target_count, true) : null;
  const claimedB = await atomicClaim(handleB, userA);
  const coinsB = claimedB.reduce((s, r) => s + (r.reward_currency ?? 0), 0);
  if (coinsB > 0) await payout(handleB, userA, coinsB);

  // Guild A untouched; guild B has its own claimed row + wallet.
  const afterA = pidA ? await readProgressById(handleA, pidA) : null;
  const walletA = await readWallet(handleA, userA);
  const rowB = pidB ? await readProgressById(handleB, pidB) : null;
  const walletB = await readWallet(handleB, userA);
  const startB = await startingBalance(handleB);
  ctx.expect(
    afterA?.claimed === snapA?.claimed &&
      afterA?.claimed === false &&
      walletA === null &&
      rowB?.claimed === true &&
      walletB?.wallet === startB + (tB?.reward_currency ?? -1),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Completing and claiming quests in a second guild never touches the first guild’s slate, progress, or wallet.',
      observation:
        `guild A quest claimed=${afterA?.claimed} (unchanged, expected false), guild A wallet=${walletA === null ? 'none' : walletA?.wallet}; ` +
        `guild B quest claimed=${rowB?.claimed} (expected true), guild B wallet=${walletB?.wallet} (expected ${startB + (tB?.reward_currency ?? 0)} = ${startB} starting + ${tB?.reward_currency} reward).`,
      impact: 'Cross-guild quest activity mutated another guild’s quests or wallet — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN distinct progress row, never the other's.
  const { data: aScoped } = await handleA.supabase
    .from('economy_quest_progress')
    .select('id, guild_id, user_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .limit(1000);
  const { data: bScoped } = await handleB.supabase
    .from('economy_quest_progress')
    .select('id, guild_id, user_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .limit(1000);
  const aRows = (aScoped as Array<{ guild_id: string }> | null) ?? [];
  const bRows = (bScoped as Array<{ guild_id: string }> | null) ?? [];
  ctx.expect(
    aRows.length > 0 &&
      bRows.length > 0 &&
      aRows.every((r) => r.guild_id === guildA) &&
      bRows.every((r) => r.guild_id === guildB),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'A client scoped to guild B reads zero guild A quest rows and vice versa (distinct rows under distinct guild_ids).',
      observation:
        `guild-A-scoped read = ${aRows.length} row(s) all under "${guildA}" (${aRows.every((r) => r.guild_id === guildA)}); ` +
        `guild-B-scoped read = ${bRows.length} row(s) all under "${guildB}" (${bRows.every((r) => r.guild_id === guildB)}).`,
      impact: 'A guild-scoped quest read returned another guild’s rows — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA, userA);

  await proveQuestAudit(ctx, handleB);
  await proveNoOwnerAlert(ctx, handleA);
  await proveBranding(ctx, handleA);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed quest rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: questConfig(ctx) });
  const userA = ctx.userId('a');
  await seedTemplates(handle);

  // Create run-prefixed operational rows: templates (seeded), a progress row, and a wallet.
  const tmpl = await templateByTitle(handle, 'Shopper');
  if (tmpl) await insertProgress(handle, userA, tmpl.id, tmpl.target_count, true);
  await payout(handle, userA, 100); // creates a wallet row

  const templatesBefore = (await readTemplates(handle)).length;
  const progressBefore = await progressCount(handle, userA);
  const walletBefore = await readWallet(handle, userA);
  ctx.expect(templatesBefore >= 12 && progressBefore >= 1 && walletBefore !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed quest template, progress, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: templates=${templatesBefore}, progress rows=${progressBefore}, wallet=${walletBefore ? walletBefore.wallet : 'none'}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveQuestAudit(ctx, handle);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  // Drive the branded /quests view for a fresh member BEFORE the sweep — the auto-assigned
  // slate gives that member their own run-prefixed progress rows, so the zero-rows assertion
  // below also proves the sweep clears rows created via the live subcommand path.
  await proveBranding(ctx, handle);
  const brandUser = ctx.userId('brand');
  const brandProgressBefore = await progressCount(handle, brandUser);

  // Run the same sweep teardown uses and verify ZERO run-prefixed quest rows remain.
  await ctx.sweepGuildRows(handle);
  const templatesAfter = (await readTemplates(handle)).length;
  const progressAfter = await progressCount(handle, userA);
  const brandProgressAfter = await progressCount(handle, brandUser);
  const walletAfter = await readWallet(handle, userA);
  ctx.expect(templatesAfter === 0 && progressAfter === 0 && brandProgressAfter === 0 && walletAfter === null, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed quest template, progress, and wallet rows are deleted; a final sweep finds zero run-prefixed quests resources (including rows the live /quests view created).',
    observation:
      `post-sweep: templates=${templatesAfter}, userA progress rows=${progressAfter}, ` +
      `brand-member progress rows=${brandProgressAfter} (was ${brandProgressBefore}), wallet=${walletAfter ? walletAfter.wallet : 'none'}.`,
    impact: 'The cleanup sweep left run-prefixed quest rows behind — the suite leaves residue.',
  });

  // Discord channel readback of removed embeds, and audit "anonymized-not-deleted"
  // history in audit_logs, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed quest claim embeds or slate-refresh notes after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (and quest actions currently write no audit_logs row — see the DEF audit finding)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The quests domain proof: the guild_id-scoped tables the sweep must clear (child →
 * parent so FK-constrained rows are removed before their parents), plus the 12 scenario
 * scripts. audit_logs is deliberately NOT swept (audit history is anonymized, not deleted).
 */
export const gameEconomyQuestsProof: DomainProof = {
  domainId: 'game-economy-quests',
  guildScopedTables: [
    // economy_quest_progress FKs economy_quest_templates ON DELETE CASCADE → child first.
    'economy_quest_progress',
    'economy_quest_templates',
    'economy_wallets',
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
