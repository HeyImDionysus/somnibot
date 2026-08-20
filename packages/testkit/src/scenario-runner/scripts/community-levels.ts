/**
 * scenario-runner/scripts/community-levels — the Levels & XP domain proof.
 *
 * Binds the community-levels domain's 12 declarative catalog scenarios to
 * concrete, real-stack proof scripts driven through the REAL production
 * dispatcher against LOCAL Supabase. Every DB-observable / captured-reply /
 * RLS assertion runs NOW; anything needing a real Discord effect, a message /
 * voice gateway event, or a Valkey cooldown slot is GATED — never faked.
 *
 * ── What is DB-observable / drivable NOW (bot-only, gateway-less) ──
 *   - /leaderboard is a subcommand-free slash command that reads member_levels
 *     and edits a text reply, so its ranked standings are captured and asserted
 *     against the REAL rows the scenario seeded (order, level, xp).
 *   - /rank view and /xp add|remove|set|reset are subcommand-routed and driven
 *     live through the subcommand injector: /rank view renders the real canvas
 *     rank-card PNG (captured attachment) or the "no XP yet" fallback, and the
 *     /xp admin subcommands round-trip the member_levels DB effect + confirmation
 *     reply (add/remove via the atomic increment_member_xp RPC).
 *   - member_levels / level_rewards / member_rank_settings are guild-scoped
 *     under RLS, so anon-denial (+ a service-role positive control) and
 *     cross-guild isolation are proven exactly like the wallet-rewards template.
 *   - guild_config levels columns round-trip (the exact row the bot's
 *     loadLevelConfig reads), proving a saved dashboard config reaches the bot.
 *   - Restart persistence, cross-guild isolation, and the cleanup sweep are all
 *     real reads against Supabase.
 *
 * ── What is GATED (honestly, never faked) ──
 *   - Message / voice XP ACCRUAL: the earning path (processMessageXp /
 *     grantVoiceXp) is triggered by gateway messageCreate / voiceStateUpdate
 *     events (no runSlash driver) AND claims its anti-spam cooldown with a
 *     Valkey `SET … NX` (no local Redis). Both are absent here → GATE.
 *   - The rank card's PIXELS (brand-kit colors, avatar, powered-by attribution)
 *     are a @napi-rs/canvas PNG a bot-only harness cannot inspect — the card path
 *     executing + the attachment name are asserted; the brand-kit match gates.
 *   - Reward-role grants + level-up / reward announcements post to a live guild
 *     channel via the gateway → discord-readback GATE.
 *   - Levels writes NO append-only audit row and NO owner alert on any path, so
 *     the audit class GATEs (nothing append-only to read) while the
 *     owner-notification HAPPY path is positively proven (zero alerts).
 *
 * ── Behavior-bug discovery (a real FAIL, not softened) ──
 *   DEF replicates the EXACT `increment_member_xp` RPC call the production XP
 *   tracker and /xp admin issue (named args p_xp_amount / p_increment_messages /
 *   p_voice_minutes). Migrations 20260522600000 + 20260611000000 changed the
 *   live function signature to (p_guild_id, p_member_id, p_xp_gain, p_username,
 *   p_avatar), so that call resolves to NO function (PostgREST PGRST202). The
 *   probe asserts the call SUCCEEDS; when it errors it is recorded as a FAIL —
 *   the owner-facing finding that message, voice, and /xp-add XP writes are all
 *   broken against the current schema. If the owner later realigns the
 *   signature, the same assertion passes. It is never forced green.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface MemberLevelRow {
  guild_id: string;
  member_id: string;
  xp: number;
  level: number;
  total_messages: number;
  voice_minutes: number;
}

interface LevelsConfigRow {
  levels_enabled: boolean;
  xp_min: number;
  xp_max: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  no_xp_role_id: string | null;
  xp_channel_mode: string;
  xp_channel_list: string[] | null;
}

interface LevelRewardRow {
  guild_id: string;
  level: number;
  role_id: string;
  announce: boolean;
}

async function seedRoleReward(
  handle: LiveClientHandle,
  level: number,
  roleId: string,
): Promise<void> {
  const { error } = await handle.supabase.from('level_rewards').insert({
    guild_id: handle.guildId,
    level,
    reward_type: 'role',
    role_id: roleId,
    announce: true,
  });
  if (error) {
    throw new Error(`Unable to seed the level-${level} role reward: ${error.message}`);
  }
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readMemberLevel(
  handle: LiveClientHandle,
  memberId: string,
): Promise<MemberLevelRow | null> {
  const { data } = await handle.supabase
    .from('member_levels')
    .select('guild_id, member_id, xp, level, total_messages, voice_minutes')
    .eq('guild_id', handle.guildId)
    .eq('member_id', memberId)
    .maybeSingle();
  return (data as MemberLevelRow | null) ?? null;
}

/**
 * Arrange an exact member_levels row via a direct service-role upsert. Direct
 * seeding (not the earning path) is deliberate: the XP-earning RPC is broken
 * against the current schema (see DEF's finding) and message/voice accrual is
 * un-drivable here, so state is arranged the way the wallet template seeds
 * wallets — the seeded row is the REAL row every readback/RLS/isolation proof
 * then observes.
 */
async function seedMemberLevel(
  handle: LiveClientHandle,
  memberId: string,
  fields: { xp: number; level: number; totalMessages?: number; voiceMinutes?: number },
): Promise<void> {
  const { error } = await handle.supabase.from('member_levels').upsert(
    {
      guild_id: handle.guildId,
      member_id: memberId,
      xp: fields.xp,
      level: fields.level,
      total_messages: fields.totalMessages ?? 0,
      voice_minutes: fields.voiceMinutes ?? 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'guild_id,member_id' },
  );
  if (error) {
    throw new Error(`Unable to seed member level for ${memberId}: ${error.message}`);
  }
}

async function countGuildRows(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function readLevelsConfig(handle: LiveClientHandle): Promise<LevelsConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, no_xp_role_id, xp_channel_mode, xp_channel_list',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as LevelsConfigRow | null) ?? null;
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

/** The text of a captured reply/editReply payload — discord.js accepts either a raw
 *  string or a `{ content }` object, so normalise both (a string payload otherwise
 *  reads as empty). */
/**
 * Flatten a reply payload to searchable text.
 *
 * Reads embeds as well as `content`. The branding sweep moved several
 * member-facing surfaces — /leaderboard among them — from plain text to branded
 * embeds, and a content-only reader silently returns '' for those. Every
 * Discord-class assertion in this scenario then fails for a product that is
 * working, which is exactly the kind of false signal that teaches people to
 * ignore the harness.
 */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const p = payload as {
    content?: string;
    embeds?: Array<{ data?: { title?: string; description?: string; footer?: { text?: string } } }>;
  } | undefined;
  const parts: string[] = [];
  if (p?.content) parts.push(p.content);
  for (const embed of p?.embeds ?? []) {
    const d = embed?.data;
    if (d?.title) parts.push(d.title);
    if (d?.description) parts.push(d.description);
    if (d?.footer?.text) parts.push(d.footer.text);
  }
  return parts.join('\n');
}

/** Read the last editReply/reply content string a handler produced. */
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return payloadText(edits[edits.length - 1]!.payload);
  }
  const reply = captured.find('reply');
  return payloadText(reply?.payload);
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS → 0), or null
 * when no anon key / an inconclusive gateway error (→ GATE, service-role scoping
 * still proven separately).
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (anon blocked by RLS /
    // missing GRANT — the deny we want) from the KEY being rejected before authz
    // ran (inconclusive → GATE). PostgREST surfaces the former as SQLSTATE 42501.
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
 * Prove member_levels rows are guild-scoped under RLS. The anon-denial probe is
 * made non-vacuous by a positive control: the scenario has already seeded this
 * member's row under the guild (the service role sees it), so an anon client
 * reading ZERO of those rows is a REAL deny, not "nothing to read". Cross-GUILD
 * isolation across two real guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  memberId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero member_levels rows (guild-scoped RLS).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'member_levels', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero member_levels rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readMemberLevel(handle, memberId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s member_levels row while an anon client reads zero of them (guild-scoped RLS).',
    observation:
      `service-role sees the member's XP row under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} member_levels row(s) for that guild.`,
    impact:
      'A member_levels row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
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
      impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch alerts (e.g. reward-grant-failed) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected reward-grant failure branch',
  );
}

/**
 * Branding for levels. The one drivable member-facing surface (/leaderboard)
 * carries only generic wording ("🏆 Server Leaderboard") with NO owner-
 * configurable brand token to positively verify, so this GATEs rather than
 * record a hollow pass — the full white-label brand-kit / voice-preset /
 * powered-by-SomniBot match needs the embed snapshot inspector.
 */
function gateBranding(ctx: ScenarioContext, captured?: CapturedResponse): void {
  const surface = captured ? replyContent(captured) : '';
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing levels surface shows the owner’s configured brand name, colors, and voice preset with zero stock-bot wording.',
    surface
      ? `the drivable /leaderboard reply ("${truncate(surface)}") carries only generic wording with no owner-configurable brand token to check; brand-kit/voice match needs the embed snapshot inspector`
      : 'this scenario produced no member-facing levels reply carrying an owner-configurable brand token to check',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'Captured rank cards, level-up embeds, and reward announcements match the owner brand kit + voice preset (powered-by-SomniBot attribution).',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

function gateMessageVoiceAccrual(ctx: ScenarioContext, detail: string): void {
  ctx.gate(
    'Discord',
    'redis-dependency',
    detail,
    'the XP-earning path fires on gateway messageCreate/voiceStateUpdate events (no runSlash driver) AND claims its anti-spam cooldown with a Valkey SET NX — neither a message/voice event driver nor a local Redis is present',
  );
}

/**
 * Drive REAL message-XP accrual through a synthetic `messageCreate` (the exported
 * gateway handler `handleMessageCreateEvent`) — the earning path that fires ONLY
 * on a gateway event, never a slash command. It claims a Valkey SET-NX anti-spam
 * cooldown, so it GATES honestly when no local Redis is present. When present it
 * proves BOTH facets of the out-of-the-box promise:
 *   (1) a qualifying message accrues XP within [xp_min, xp_max] and increments
 *       total_messages, and
 *   (2) a second message inside the cooldown window earns nothing (the SET-NX
 *       single-claim anti-spam fence).
 * The range check (not an exact value) keeps this deterministic despite the
 * per-message randomXp roll — no casino-style flakiness.
 */
async function proveMessageXpAccrual(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  opts: { xpMin: number; xpMax: number },
): Promise<void> {
  if (!ctx.capabilities.redis) {
    ctx.gate(
      'Discord',
      'redis-dependency',
      `Chatting earns ${opts.xpMin}-${opts.xpMax} XP/message under the anti-spam cooldown; a second message inside the window earns nothing.`,
      'the message-XP path claims its anti-spam cooldown with a Valkey SET NX; no local Redis/Valkey is reachable (start Valkey to drive this leg)',
    );
    return;
  }

  const chatter = ctx.userId('chatter');

  // (1) First qualifying message → XP accrues in range; total_messages = 1.
  await ctx.runMessageCreate(handle, { userId: chatter });
  const afterFirst = await readMemberLevel(handle, chatter);
  const first = afterFirst?.xp ?? -1;
  ctx.expect(
    afterFirst != null && first >= opts.xpMin && first <= opts.xpMax && afterFirst.total_messages === 1,
    {
      assertionClass: 'Discord',
      channel: 'redis-dependency',
      promise:
        'A qualifying gateway message accrues XP within the configured per-message range via the REAL messageCreate pipeline (processMessageXp → increment_member_xp) and increments total_messages.',
      observation:
        `after one driven messageCreate: member_levels xp=${afterFirst?.xp} (expected ${opts.xpMin}..${opts.xpMax}), ` +
        `total_messages=${afterFirst?.total_messages} (expected 1).`,
      impact:
        'A qualifying gateway message did not accrue XP in range — the message-XP earning path is broken (no XP is ever earned by chatting).',
    },
  );

  // (2) Second message inside the cooldown window → SET-NX blocks it, XP frozen.
  await ctx.runMessageCreate(handle, { userId: chatter });
  const afterSecond = await readMemberLevel(handle, chatter);
  ctx.expect(
    afterSecond?.xp === first && afterSecond?.total_messages === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'redis-dependency',
      promise:
        'A second message inside the cooldown window earns no additional XP (the Valkey SET-NX single-claim anti-spam fence).',
      observation:
        `after a second immediate messageCreate: xp=${afterSecond?.xp} (expected unchanged ${first}), ` +
        `total_messages=${afterSecond?.total_messages} (expected 1).`,
      impact: 'A second rapid message accrued extra XP — the anti-spam cooldown does not single-claim (XP farming by message spam).',
    },
  );
}

function gateAudit(ctx: ScenarioContext, reason: string): void {
  ctx.gate('audit', 'audit-row', 'Every levels state change lands exactly one append-only audit row with actor, guild, and correlation id.', reason);
}

function gateRewardReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'Level rewards land as roles with playful announcements; exactly one level-up + one reward message appear in the announcement channel.',
    'reward-role grants and level-up/reward announcements post to a live guild channel via the gateway (DISCORD_TOKEN + live guild)',
  );
}

function gateReplayDeferred(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s message/level-up events yields no duplicate XP, announcement, or reward-role grant.',
    `replay/idempotency of the earning path requires the gateway event re-delivery harness + a working XP-write path; ${where}`,
  );
}

/**
 * Drive the REAL `/rank view` subcommand live through the injector (no gate). Proves
 * both card-path branches: a member WITH recorded XP renders the @napi-rs/canvas
 * rank-card PNG (the attachment is captured — its bytes are a Discord-readback artifact,
 * but the card path having executed end-to-end IS asserted), and a member with no XP
 * gets the branded "no XP yet" text fallback instead of an error.
 */
async function proveRankView(ctx: ScenarioContext, handle: LiveClientHandle, memberId: string): Promise<void> {
  // (1) A member WITH recorded XP → the rank card PNG renders.
  const withXp = await ctx.runSlash(handle, { commandName: 'rank', userId: memberId, subcommand: 'view' });
  const edits = withXp.allOf('editReply');
  const files =
    (edits[edits.length - 1]?.payload as { files?: Array<{ name?: string }> } | undefined)?.files ?? [];
  ctx.expect(files.length === 1 && files[0]?.name === 'rank-card.png', {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/rank view renders the rank-card PNG for a member with recorded XP (the real canvas card path).',
    observation: `/rank view (member with XP) replied with ${files.length} file(s): ${
      files.map((f) => f?.name ?? '?').join(', ') || '(none)'
    } (expected one rank-card.png).`,
    impact: 'The /rank view card path did not render a rank-card attachment.',
  });

  // (2) A member with NO recorded XP → the "no XP yet" text fallback, never an error.
  const noXp = await ctx.runSlash(handle, { commandName: 'rank', userId: ctx.userId('norank'), subcommand: 'view' });
  const content = replyContent(noXp).toLowerCase();
  ctx.expect(content.includes('xp yet'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A member with no recorded XP gets a "no XP yet" notice from /rank view rather than an error.',
    observation: `/rank view (no XP) replied ${JSON.stringify(truncate(replyContent(noXp)))} (expected a "no XP yet" notice).`,
    impact: 'The /rank view no-data path did not surface the expected notice.',
  });
}

/**
 * Drive the REAL `/xp` admin subcommands (add/remove/set/reset) live through the injector
 * and assert BOTH the member_levels DB effect and the confirmation reply. add/remove issue
 * the exact atomic increment_member_xp RPC the deployed handler uses; set/reset upsert the
 * member_levels row directly. The acting member carries Manage-Guild (permissions.has → true)
 * so this stays a happy-path drive even once the handler adds an in-handler authz re-check.
 */
async function proveXpAdmin(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const admin = ctx.userId('xpadmin');
  const target = ctx.userId('xptarget');
  const adminMember = { id: admin, roles: [], permissions: { has: () => true } };
  const userOpt = { id: target, username: target, displayAvatarURL: () => 'https://cdn.example/avatar.png' };
  const drive = (subcommand: string, options: Record<string, unknown>) =>
    ctx.runSlash(handle, { commandName: 'xp', userId: admin, member: adminMember, subcommand, options });

  // /xp add 250 → a member_levels row is created at exactly 250 XP; reply confirms the total.
  const added = await drive('add', { user: userOpt, amount: 250 });
  const afterAdd = await readMemberLevel(handle, target);
  ctx.expect(afterAdd?.xp === 250 && replyContent(added).includes('Added'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/xp add credits the target member the exact amount via the atomic RPC and confirms the new total.',
    observation: `after /xp add 250: member_levels xp=${afterAdd?.xp} (expected 250); reply "${truncate(replyContent(added))}".`,
    impact: '/xp add did not credit the member or confirm the new total.',
  });

  // /xp remove 100 → 150 XP.
  const removed = await drive('remove', { user: userOpt, amount: 100 });
  const afterRemove = await readMemberLevel(handle, target);
  ctx.expect(afterRemove?.xp === 150 && replyContent(removed).includes('Removed'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/xp remove debits the exact amount via the atomic RPC and confirms the reduced total.',
    observation: `after /xp remove 100: member_levels xp=${afterRemove?.xp} (expected 150); reply "${truncate(replyContent(removed))}".`,
    impact: '/xp remove did not debit the member correctly.',
  });

  // /xp set 1000 → XP overwritten to exactly 1000 at the derived level.
  const set = await drive('set', { user: userOpt, amount: 1000 });
  const afterSet = await readMemberLevel(handle, target);
  ctx.expect(afterSet?.xp === 1000 && replyContent(set).includes('Set'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/xp set overwrites the member’s XP to the exact value and confirms it.',
    observation: `after /xp set 1000: member_levels xp=${afterSet?.xp} (expected 1000); reply "${truncate(replyContent(set))}".`,
    impact: '/xp set did not overwrite the member’s XP.',
  });

  // /xp reset → XP and level zeroed.
  const reset = await drive('reset', { user: userOpt });
  const afterReset = await readMemberLevel(handle, target);
  ctx.expect(afterReset?.xp === 0 && afterReset?.level === 0 && replyContent(reset).toLowerCase().includes('reset'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/xp reset zeroes the member’s XP and level and confirms the reset.',
    observation: `after /xp reset: member_levels xp=${afterReset?.xp}/level=${afterReset?.level} (expected 0/0); reply "${truncate(replyContent(reset))}".`,
    impact: '/xp reset did not zero the member’s XP.',
  });
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box levels: leaderboard reflects recorded totals; the
 *  production XP-write RPC is exercised (surfaces the signature-mismatch bug). */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const xpMin = Number(declaredDefault(ctx.domain, 'xp-per-message-min'));
  const xpMax = Number(declaredDefault(ctx.domain, 'xp-per-message-max'));
  const cooldown = Number(declaredDefault(ctx.domain, 'xp-cooldown-seconds'));

  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      levels_enabled: true,
      xp_min: xpMin,
      xp_max: xpMax,
      xp_cooldown_seconds: cooldown,
      voice_xp_enabled: true,
    },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  // Arrange two known standings (A ahead of B), then read them back via the REAL
  // /leaderboard handler (reads member_levels, edits a text reply).
  await seedMemberLevel(handle, userA, { xp: 300, level: 2, totalMessages: 12 });
  await seedMemberLevel(handle, userB, { xp: 50, level: 0, totalMessages: 3 });

  const lb = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
  const content = replyContent(lb);
  const idxA = content.indexOf(userA);
  const idxB = content.indexOf(userB);
  ctx.expect(idxA >= 0 && idxB >= 0 && idxA < idxB && content.includes('300') && content.includes('Level 2'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      '/leaderboard lists members at the position implied by their recorded member_levels totals (highest XP first), with level + XP.',
    observation:
      `leaderboard reply "${truncate(content)}" — member-a index=${idxA}, member-b index=${idxB} ` +
      `(a must precede b at 300 XP / Level 2).`,
    impact: 'The /leaderboard reply did not reflect the recorded member_levels standings.',
  });

  // FINDING probe: replicate the EXACT increment_member_xp call the production XP
  // tracker (message + voice) and /xp admin issue. Assert it SUCCEEDS. Against the
  // migrated (p_xp_gain,p_username,p_avatar) signature the named args
  // p_xp_amount/p_increment_messages/p_voice_minutes match no function → this
  // FAILs, surfacing that ALL XP writes are broken. Never forced green.
  const { error: xpWriteErr } = await handle.supabase.rpc('increment_member_xp', {
    p_guild_id: handle.guildId,
    p_member_id: userC,
    p_xp_amount: 20,
    p_increment_messages: true,
    p_voice_minutes: 0,
  });
  ctx.expect(xpWriteErr == null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A qualifying message/voice interval writes XP through the production increment_member_xp RPC (the exact call the tracker and /xp admin issue).',
    observation:
      `the production RPC call increment_member_xp(p_guild_id,p_member_id,p_xp_amount,p_increment_messages,p_voice_minutes) ` +
      `returned error=${xpWriteErr ? `${xpWriteErr.code ?? ''} ${xpWriteErr.message ?? ''}`.trim() : 'none'}.`,
    impact:
      'The deployed bot calls increment_member_xp with p_xp_amount/p_increment_messages/p_voice_minutes, but the live function signature is ' +
      '(p_guild_id,p_member_id,p_xp_gain,p_username,p_avatar) — every message, voice, and /xp-add XP write fails, so no XP is ever earned.',
  });

  // Message ACCRUAL is now DRIVEN for real through the exported messageCreate
  // gateway handler (redis-gated: it claims a Valkey SET-NX cooldown). Voice
  // accrual still needs a voiceStateUpdate driver — a later gateway slice.
  await proveMessageXpAccrual(ctx, handle, { xpMin, xpMax });
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Voice earns voice_xp_per_interval XP per voice_xp_interval_minutes interval of connected time.',
    'the voice-XP path fires on gateway voiceStateUpdate events (a voiceStateUpdate driver is a later gateway slice) and claims a Valkey interval slot',
  );
  // /rank view + /xp add|remove|set|reset are subcommand-routed — driven live now.
  await proveRankView(ctx, handle, userA);
  await proveXpAdmin(ctx, handle);

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, 'the drivable levels read paths (/leaderboard) write no append-only audit row, and an XP-state-change that would be audited is not drivable here (no message/voice driver + the XP-write RPC is broken)');
  gateBranding(ctx, lb);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** SET-A — dashboard config takes live effect: XP pinned to 50/msg @ 5s, a
 *  run-prefixed reward role bound at level 2. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const rewardRole = ctx.snowflake('reward-lvl2');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      levels_enabled: true,
      xp_min: 50,
      xp_max: 50,
      xp_cooldown_seconds: 5,
      voice_xp_enabled: true,
    },
  });
  const userA = ctx.snowflake('member-a');

  // Bind a reward role at level 2 (the real level_rewards binding the announcer reads).
  await seedRoleReward(handle, 2, rewardRole);

  // Config round-trips into the exact guild_config row the bot's loadLevelConfig reads.
  const cfg = await readLevelsConfig(handle);
  ctx.expect(cfg?.xp_min === 50 && cfg?.xp_max === 50 && cfg?.xp_cooldown_seconds === 5, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'The saved levels config (50 XP/message, 5s cooldown) round-trips in guild_config — the exact row the bot reads live, no restart.',
    observation: `guild_config holds xp_min=${cfg?.xp_min}/xp_max=${cfg?.xp_max} (expected 50/50), xp_cooldown_seconds=${cfg?.xp_cooldown_seconds} (expected 5).`,
    impact: 'A saved dashboard levels configuration did not reach the bot’s config row.',
  });

  const { data: rewardRow } = await handle.supabase
    .from('level_rewards')
    .select('guild_id, level, role_id, announce')
    .eq('guild_id', handle.guildId)
    .eq('level', 2)
    .maybeSingle();
  const reward = rewardRow as LevelRewardRow | null;
  ctx.expect(reward?.role_id === rewardRole && reward?.announce === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The level-2 reward role binding persists with its announce flag set.',
    observation: `level_rewards@level2 role_id=${reward?.role_id ?? '(missing)'} (expected ${rewardRole}), announce=${reward?.announce}.`,
    impact: 'The reward-role binding was not persisted as configured.',
  });

  // A member seeded at level 2 renders at level 2 on /leaderboard (the deterministic
  // standing the config + threshold produce; the accrual + grant paths gate below).
  await seedMemberLevel(handle, userA, { xp: 300, level: 2, totalMessages: 4 });
  const lb = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
  ctx.expect(replyContent(lb).includes('Level 2') && replyContent(lb).includes(userA), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A member who reached level 2 is shown at Level 2 on /leaderboard.',
    observation: `leaderboard reply "${truncate(replyContent(lb))}".`,
    impact: '/leaderboard did not reflect the level-2 standing.',
  });

  gateMessageVoiceAccrual(ctx, 'After saving, each qualifying message earns exactly 50 XP on the 5s cooldown, reaching level 2 deterministically.');
  gateRewardReadback(ctx);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, 'the level-up + reward-grant that would be audited are not drivable here (no message driver + broken XP-write RPC + gateway role grant)');
  gateBranding(ctx, lb);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** SET-B — a second config: no-XP role + a denylisted channel suppress accrual,
 *  voice XP off. Proven at the config-persistence layer (accrual gates). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const noXpRole = ctx.snowflake('no-xp-role');
  const deniedChannel = ctx.snowflake('denied-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      levels_enabled: true,
      voice_xp_enabled: false,
      no_xp_role_id: noXpRole,
      xp_channel_mode: 'blacklist',
      xp_channel_list: [deniedChannel],
    },
  });
  const userA = ctx.userId('a');

  const cfg = await readLevelsConfig(handle);
  ctx.expect(
    cfg?.no_xp_role_id === noXpRole &&
      cfg?.voice_xp_enabled === false &&
      cfg?.xp_channel_mode === 'blacklist' &&
      (cfg?.xp_channel_list ?? []).includes(deniedChannel),
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'The suppression config (no-XP role, denylisted channel, voice XP off) round-trips in guild_config — the exact row the XP tracker reads to skip accrual.',
      observation:
        `guild_config: no_xp_role_id=${cfg?.no_xp_role_id} (expected ${noXpRole}), voice_xp_enabled=${cfg?.voice_xp_enabled} (expected false), ` +
        `xp_channel_mode=${cfg?.xp_channel_mode} (expected blacklist), xp_channel_list=${JSON.stringify(cfg?.xp_channel_list)}.`,
      impact: 'A saved suppression configuration did not reach the bot’s config row.',
    },
  );

  // Seed a baseline row so the RLS positive control is real (the member exists;
  // whether accrual is correctly suppressed is the gated behavior below).
  await seedMemberLevel(handle, userA, { xp: 0, level: 0 });

  gateMessageVoiceAccrual(
    ctx,
    'Messages in the denylisted channel and from the no-XP-role holder earn ZERO XP; 5 minutes of voice earns zero (voice XP off); totals stay frozen.',
  );
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, 'no accrual/suppression event is drivable here (no message/voice event driver), so no levels state-change audit row is produced to read');
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** INVALID — a rejected invalid config never persists (dashboard Zod layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      levels_enabled: true,
      xp_min: 15,
      xp_max: 25,
      xp_cooldown_seconds: 60,
    },
  });
  const userA = ctx.userId('a');

  // DB-observable core: guild_config keeps its prior VALID values (nothing invalid persisted).
  const cfg = await readLevelsConfig(handle);
  ctx.expect(cfg?.xp_min === 15 && cfg?.xp_max === 25 && cfg?.xp_cooldown_seconds === 60, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid levels values byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config holds xp_min=${cfg?.xp_min} (expected 15), xp_max=${cfg?.xp_max} (expected 25), xp_cooldown_seconds=${cfg?.xp_cooldown_seconds} (expected 60).`,
    impact: 'A valid levels configuration was not retained.',
  });

  // Behavior unchanged on the next command: /leaderboard still renders normally.
  await seedMemberLevel(handle, userA, { xp: 120, level: 1, totalMessages: 6 });
  const lb = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
  ctx.expect(replyContent(lb).includes(userA) && replyContent(lb).includes('120'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged on the very next command after a rejected config save.',
    observation: `/leaderboard reply "${truncate(replyContent(lb))}" still renders the member’s standing.`,
    impact: 'A rejected config attempt disturbed live bot behavior.',
  });

  // The REJECTION (min-XP above max-XP, negative cooldown) is enforced in the
  // dashboard's Zod layer; the guild_config columns carry NO CHECK constraint for
  // these, so the reject path is not reachable in a bot-only harness. GATE honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard levels page surfaces a clear validation error for min-XP above max-XP / a negative cooldown.',
    'levels config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK for xp_min≤xp_max / cooldown≥0, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected levels-config attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, lb);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** UNAUTH — /xp administration is denied to members without Manage Guild. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const userA = ctx.userId('a'); // target
  const userB = ctx.userId('b'); // unprivileged actor

  // Positive control for RLS + a stable target total.
  await seedMemberLevel(handle, userA, { xp: 300, level: 3, totalMessages: 15 });
  const before = await readMemberLevel(handle, userA);

  // DRIVE the real deny: member B WITHOUT Manage-Guild (memberPermissions.has→false)
  // invokes `/xp add` on member A. handleXpAdminCommand performs an in-handler
  // Manage-Guild RE-CHECK (defense-in-depth beyond Discord's setDefaultMemberPermissions
  // gate) — it must refuse the attempt, leave the target's XP untouched, and write
  // a `levels.xp_admin.denied` audit row. All three are asserted for real.
  const unprivileged = { id: userB, roles: [], permissions: { has: () => false } };
  const targetOpt = { id: userA, username: userA, displayAvatarURL: () => 'https://cdn.example/avatar.png' };
  const denied = await ctx.runSlash(handle, {
    commandName: 'xp',
    userId: userB,
    member: unprivileged,
    subcommand: 'add',
    options: { user: targetOpt, amount: 100 },
  });
  const denialText = replyContent(denied);
  ctx.expect(denialText.includes('Manage Server') || denialText.includes('🚫'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'run-member-b invoking /xp add is refused with an ephemeral permission denial (the handler’s Manage-Guild re-check).',
    observation: `/xp add as an unprivileged member replied "${truncate(denialText)}" (expected a Manage-Server denial).`,
    impact: 'The /xp handler did not refuse an unprivileged member — server-side authorization re-check is missing (XP-mutation privilege escalation).',
  });

  // An append-only audit row records the denied attempt (actor = member B, denied path).
  const { data: denialAudits } = await handle.supabase
    .from('audit_logs')
    .select('action, actor_id, success')
    .eq('guild_id', handle.guildId)
    .eq('action', 'levels.xp_admin.denied');
  const auditRows = (denialAudits as Array<{ action: string; actor_id: string; success: boolean }> | null) ?? [];
  ctx.expect(auditRows.length >= 1 && auditRows.some((r) => r.actor_id === userB && r.success === false), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'An audit row records the denied /xp attempt with actor id and success=false.',
    observation: `audit_logs holds ${auditRows.length} levels.xp_admin.denied row(s); actor_ids=[${auditRows.map((r) => r.actor_id).join(', ')}] (expected one for ${userB}).`,
    impact: 'The denied /xp attempt left no audit trail — a privileged-command refusal went unrecorded.',
  });

  // The target total is observably untouched by the denied attempt.
  const after = await readMemberLevel(handle, userA);
  ctx.expect(after?.xp === before?.xp && after?.xp === 300, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The target member’s recorded XP is unchanged across the (denied) admin path.',
    observation: `target member_levels xp before=${before?.xp} / after=${after?.xp} (expected 300 unchanged).`,
    impact: 'The target member’s XP changed on a path that should have been denied.',
  });

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** DEPFAIL — Supabase-unreachable fail-safe, driven through the REAL fault
 *  proxy (ctx.faults severs the actual network path run-one-domain routed the
 *  stack through). Falls back to honest gates when no proxy is registered
 *  (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
    const userA = ctx.userId('a');
    await seedMemberLevel(handle, userA, { xp: 300, level: 2, totalMessages: 12 });

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let severedReply = '';
    try {
      const cap = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
      severedReply = replyContent(cap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SAFE: the dispatcher must reply, never crash the pipeline.
    ctx.expect(threw === null && severedReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'With database access blocked, a levels command still replies (fail-safe) instead of crashing the interaction pipeline.',
      observation: `during the outage window /leaderboard ${threw === null ? `replied ${JSON.stringify(truncate(severedReply))}` : `THREW ${truncate(threw)}`}.`,
      impact: 'A database outage crashed the levels command pipeline instead of degrading to a reply.',
    });

    // (2) The catalog contracts a branded UNAVAILABLE notice — not a data-shaped
    //     answer. Replying "No one has earned XP yet!" during an outage is a lie
    //     about state the bot could not read. Recorded honestly; never softened.
    const looksUnavailable = /unavailable|try again|temporar|later|degraded|issue|problem/i.test(severedReply);
    const dataShapedLie = /no one has earned xp/i.test(severedReply);
    ctx.expect(looksUnavailable && !dataShapedLie, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'With the database blocked, the levels reply is the branded levels-unavailable notice — never a data-shaped answer fabricated from the failed read.',
      observation: `outage-window reply ${JSON.stringify(truncate(severedReply))} — looksUnavailable=${looksUnavailable}, dataShapedLie=${dataShapedLie}.`,
      impact: 'During a database outage the levels command replied with a fabricated data-shaped answer ("no XP yet") instead of a degradation notice — members are told a lie about state the bot could not read.',
    });

    // (3) No corruption: the persisted row is byte-identical after restore.
    const after = await readMemberLevel(handle, userA);
    ctx.expect(after?.xp === 300 && after?.level === 2 && after?.total_messages === 12, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'No totals corrupt across the outage window — the persisted member_levels row is unchanged after restoration.',
      observation: `post-restore member_levels: xp=${after?.xp}/level=${after?.level}/messages=${after?.total_messages} (expected 300/2/12).`,
      impact: 'A database outage corrupted persisted level totals.',
    });

    // (4) Recovery: the very next command works against the restored stack.
    const recovered = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
    ctx.expect(replyContent(recovered).includes(userA) && replyContent(recovered).includes('300'), {
      assertionClass: 'replay-safety',
      channel: 'captured-reply',
      promise: 'After restoration the very next levels command serves the real standings again (no lingering degradation).',
      observation: `post-restore /leaderboard replied ${JSON.stringify(truncate(replyContent(recovered)))}.`,
      impact: 'The levels pipeline did not recover after the outage ended.',
    });

    await proveRlsIsolation(ctx, handle, userA);
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'With the database blocked, /rank replies with the branded levels-unavailable message and no totals corrupt; after restoration accrual resumes.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded levels-unavailable template in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'No duplicate XP survives the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'member_levels rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed event).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  gateAudit(ctx, 'requires the degraded/recovered levels state transitions to write audit rows (owner alert channel lane)');
}

/** RETRY — a transient XP-write fault converges to exactly one grant. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const userA = ctx.userId('a');
  await seedMemberLevel(handle, userA, { xp: 40, level: 0, totalMessages: 2 });

  // The retry/converge behavior triggers only when increment_member_xp fails
  // transiently on the first attempt — a mid-op fault that requires injection at
  // the RPC boundary (and a working RPC). GATE the fault-dependent proof.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a transient fault on the first increment, the retry succeeds and /rank shows a total consistent with exactly one grant for the message.',
    'requires a mid-op fault-injection lane on increment_member_xp (and a working XP-write RPC — see DEF’s finding)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried increment reuses the original idempotent event key, so member_levels shows one grant, not two.',
    'requires the mid-op fault-injection lane on the XP-write path',
  );
  gateAudit(ctx, 'requires the fault lane to produce the levels.xp_write_retried audit trail');
  // The off-theme classes are still proven against the seeded baseline row.
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** REPLAY — re-delivering message/level-up events must not double-apply. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const userA = ctx.userId('a');

  await seedMemberLevel(handle, userA, { xp: 250, level: 2, totalMessages: 10 });

  // The genuine replay proof re-delivers the recorded messageCreate + level-up
  // gateway events and asserts no duplicate XP / announcement / reward role. That
  // needs the gateway event re-delivery harness AND a working earning path (the
  // XP-write RPC is broken — see DEF). GATE the replay-safety class specifically.
  gateReplayDeferred(ctx, 'the gateway event re-delivery harness is a later, credentialed lane');
  gateRewardReadback(ctx);
  gateAudit(ctx, 'the idempotency-keyed XP/reward audit rows are written by the earning path, which is not drivable here');

  // What IS observable now: the recorded standing reads back deterministically
  // (a stable base state for the replay diff) and its guild-scoping holds.
  const lb = await ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA });
  ctx.expect(replyContent(lb).includes(userA) && replyContent(lb).includes('250'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The recorded pre-replay standing reads back deterministically on /leaderboard.',
    observation: `leaderboard reply "${truncate(replyContent(lb))}" (expected member-a at 250 XP).`,
    impact: 'The recorded standing did not read back as seeded — an unstable base for the replay diff.',
  });
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, lb);
}

/** RESTART — levels state survives a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: seed + snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: { levels_enabled: true } });
  await seedMemberLevel(first, userA, { xp: 800, level: 4, totalMessages: 30, voiceMinutes: 25 });
  const snapshot = await readMemberLevel(first, userA);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State must be identical (it lives in Supabase).
  const second = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const lb = await ctx.runSlash(second, { commandName: 'leaderboard', userId: userA });
  const after = await readMemberLevel(second, userA);
  ctx.expect(
    after?.xp === snapshot?.xp && after?.level === snapshot?.level && after?.xp === 800 && after?.level === 4,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, member_levels totals + level match the pre-restart snapshot exactly.',
      observation:
        `pre-restart xp=${snapshot?.xp}/level=${snapshot?.level}; ` +
        `post-restart xp=${after?.xp}/level=${after?.level} (expected 800/4).`,
      impact: 'Levels state did not survive a restart — persisted totals were lost or altered.',
    },
  );
  ctx.expect(replyContent(lb).includes('800') && replyContent(lb).includes('Level 4'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /leaderboard renders the persisted total.',
    observation: `/leaderboard reply "${truncate(replyContent(lb))}".`,
    impact: 'Post-restart /leaderboard failed to render the persisted standing.',
  });

  // The "voice session spanning the restart earns its interval exactly once" facet
  // needs a voice event driver + the Valkey interval slot.
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'A voice session spanning the restart neither loses nor double-earns its interval XP.',
    'requires a voiceStateUpdate event driver + the Valkey voice-interval slot to span the restart',
  );
  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  gateAudit(ctx, 'no auditable levels state-change is driven across the restart (state is seeded directly; the earning path is un-drivable/broken)');
  gateBranding(ctx, lb);
}

/** RACE — concurrent activity is safe. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const userA = ctx.userId('a');
  await seedMemberLevel(handle, userA, { xp: 180, level: 1, totalMessages: 9 });

  // Concurrent reads through the REAL handler are safe (both reply, same standing).
  const [c1, c2] = await Promise.all([
    ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA }),
    ctx.runSlash(handle, { commandName: 'leaderboard', userId: userA }),
  ]);
  ctx.expect(replyContent(c1).includes('180') && replyContent(c2).includes('180'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Concurrent /leaderboard reads both reply with the same consistent standing.',
    observation: `two concurrent /leaderboard replies both render 180 XP (c1=${replyContent(c1).includes('180')}, c2=${replyContent(c2).includes('180')}).`,
    impact: 'A concurrent /leaderboard read produced no reply or an inconsistent standing.',
  });

  // The load-bearing race — one XP grant per cooldown window under simultaneous
  // messages, and exactly one level-up announcement + one reward grant at a
  // threshold crossing — depends on the Valkey SET NX cooldown, a message/voice
  // driver, and the (broken) XP-write RPC. GATE.
  gateMessageVoiceAccrual(ctx, 'Simultaneous messages yield exactly one XP grant per cooldown window (Valkey SET NX single-claim).');
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'A concurrent threshold crossing announces exactly once and grants the reward role exactly once (idempotency keys show one effect each).',
    'requires the Valkey SET NX cooldown + a gateway event driver + a working XP-write path to drive the concurrent level-up',
  );
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, 'the concurrent level-up that would be audited is not drivable here (Valkey + gateway driver + broken XP-write RPC)');
  gateBranding(ctx, c1);
}

/** XGUILD — levels are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, guildConfigOverrides: { levels_enabled: true } });
  const handleB = await ctx.bootGuild({ guildId: guildB, guildConfigOverrides: { levels_enabled: true } });

  // Fund + snapshot guild A's total.
  await seedMemberLevel(handleA, userA, { xp: 700, level: 6, totalMessages: 40 });
  const snapA = await readMemberLevel(handleA, userA);

  // Same member is active in guild B: a SEPARATE row is created under guild B.
  await seedMemberLevel(handleB, userA, { xp: 123, level: 1, totalMessages: 8 });
  const lbA = await ctx.runSlash(handleA, { commandName: 'leaderboard', userId: userA });
  const aAfter = await readMemberLevel(handleA, userA);
  const bRow = await readMemberLevel(handleB, userA);

  ctx.expect(
    aAfter?.xp === snapA?.xp && snapA?.xp === 700 && bRow?.xp === 123 && bRow?.guild_id === guildB,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Activity in a second guild never touches the first guild’s total; each guild’s member_levels evolves independently.',
      observation:
        `guild A xp=${aAfter?.xp} (unchanged at ${snapA?.xp}=700); guild B xp=${bRow?.xp} under guild_id="${bRow?.guild_id}".`,
      impact: 'Cross-guild activity mutated another guild’s levels total — per-guild isolation broken.',
    },
  );
  ctx.expect(replyContent(lbA).includes('700'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Guild A’s /leaderboard is unaffected by the guild B activity burst.',
    observation: `guild A /leaderboard reply "${truncate(replyContent(lbA))}" (expected member-a at 700 XP).`,
    impact: 'Guild A’s leaderboard changed after activity in guild B.',
  });

  // Each guild scope reads its OWN distinct row and never the other's.
  const aScoped = await readMemberLevel(handleA, userA);
  const bScoped = await readMemberLevel(handleB, userA);
  ctx.expect(
    aScoped?.guild_id === guildA && aScoped?.xp === 700 && bScoped?.guild_id === guildB && bScoped?.xp === 123,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN member_levels row and never the other’s: guild A → its 700-XP row, guild B → its 123-XP row.',
      observation:
        `guild-A-scoped read = ${aScoped?.xp} under "${aScoped?.guild_id}"; ` +
        `guild-B-scoped read = ${bScoped?.xp} under "${bScoped?.guild_id}" (distinct rows under distinct guild_ids).`,
      impact: 'A guild-scoped read returned the other guild’s levels row — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA, userA);

  await proveNoOwnerAlert(ctx, handleA);
  gateAudit(ctx, 'this isolation scenario seeds rows directly and drives no auditable levels state change; per-guild audit scoping would ride the earning path (un-drivable here)');
  gateBranding(ctx, lbA);
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { levels_enabled: true } });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const rewardRole = ctx.snowflake('cleanup-reward');

  // Create run-prefixed operational rows across the levels tables.
  await seedMemberLevel(handle, userA, { xp: 500, level: 5, totalMessages: 25 });
  await seedMemberLevel(handle, userB, { xp: 60, level: 0, totalMessages: 4 });
  await handle.supabase
    .from('member_rank_settings')
    .upsert(
      { guild_id: handle.guildId, member_id: userA, accent_color: 0xff1493, overlay_opacity: 0.5 },
      { onConflict: 'guild_id,member_id' },
    );
  await seedRoleReward(handle, 5, rewardRole);

  const levelsBefore = await countGuildRows(handle, 'member_levels');
  const rankBefore = await countGuildRows(handle, 'member_rank_settings');
  const rewardsBefore = await countGuildRows(handle, 'level_rewards');
  ctx.expect(levelsBefore >= 2 && rankBefore >= 1 && rewardsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed member_levels, rank-card, and reward rows (pre-cleanup baseline).',
    observation: `pre-cleanup: member_levels=${levelsBefore}, member_rank_settings=${rankBefore}, level_rewards=${rewardsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);

  // Run the same sweep teardown uses and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const levelsAfter = await countGuildRows(handle, 'member_levels');
  const rankAfter = await countGuildRows(handle, 'member_rank_settings');
  const rewardsAfter = await countGuildRows(handle, 'level_rewards');
  ctx.expect(levelsAfter === 0 && rankAfter === 0 && rewardsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed member_levels, rank-card, and reward rows are deleted; a final sweep finds zero run-prefixed levels resources.',
    observation: `post-sweep: member_levels=${levelsAfter}, member_rank_settings=${rankAfter}, level_rewards=${rewardsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord-side removal of reward roles + announcement messages, and the
  // "audit anonymized not deleted" history, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guild contains no run-prefixed reward roles or levels announcement messages after cleanup.',
    'requires a live Discord channel/role readback (DISCORD_TOKEN + live guild)',
  );
  gateAudit(ctx, 'audit history is anonymized (not deleted) in the dedicated audit lane; the levels operational rows are the DB-observable cleanup evidence here');
  gateReplayDeferred(ctx, 'exercised in REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The community-levels domain proof: the guild_id-scoped tables the sweep must
 * clear (child→parent so FK-constrained rows go before the guild row) plus the
 * 12 scenario scripts. Reward deliveries precede their queue and reward
 * parents, and `alerts` is included so the owner-notification proof’s guild is
 * swept clean.
 */
export const communityLevelsProof: DomainProof = {
  domainId: 'community-levels',
  guildScopedTables: [
    'level_reward_deliveries',
    'bot_action_queue',
    'member_rank_settings',
    'member_levels',
    'level_rewards',
    'xp_multipliers',
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
