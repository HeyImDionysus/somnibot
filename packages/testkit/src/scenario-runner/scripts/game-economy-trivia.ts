/**
 * scenario-runner/scripts/game-economy-trivia — the Trivia domain proof.
 *
 * Binds the trivia domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. Every DB-observable /
 * RLS / owner-alert assertion runs NOW against the SAME production primitives the
 * bot reads; the live Discord round surfaces are GATED — the exact honesty
 * boundary the harness requires.
 *
 * ── What is DRIVEN LIVE vs what stays a genuine residual (since PR #331) ──
 * The domain's only member entrypoint is `/trivia start` — a slash SUBCOMMAND —
 * and answers are Discord BUTTON presses (`trivia:{channelId}:{i}`). Since PR #331
 * `ScenarioContext.runSlash` drives the subcommand and `ctx.injectorFor` drives the
 * answer buttons in-process against the REAL handlers, so these ARE driven live now:
 *   - `/trivia start` posts the question embed + four shuffled answer buttons; the
 *     start-path only touches Valkey for the per-channel cooldown breather, which
 *     `cooldownRemaining` SKIPS when the cooldown is 0 — so the round-drive guilds are
 *     booted with `economy_trivia_cooldown_seconds: 0` to keep the drive Redis-free
 *     (DEF alone keeps the catalog-default 30s cooldown, so its live drive is guarded
 *     on Redis for the breather probe);
 *   - a member answer is a BUTTON press into `handleAnswer`, whose per-member lock is
 *     an in-memory `Map` (no Valkey): repeated presses lock exactly one answer, the
 *     single-round-per-channel guard refuses a second `/trivia start` — both driven live;
 *   - the hosted cadence is now IMPLEMENTED (`TriviaScheduleRunner` + the
 *     `economy_trivia_schedule_*` guild_config columns), whose independent persistence
 *     is proven DB-observably in SET-B.
 * The genuine residuals that STAY gated:
 *   - streaks live entirely in Valkey (`trivia:streak:{guildId}:{userId}`, 24h TTL,
 *     `economy_trivia_sessions` dropped in v53), so the streak math + streak-scaled
 *     payout cannot run without a Redis;
 *   - the round is RESOLVED by a `setTimeout` firing `endRound` after 20s (no
 *     accelerated clock here), whose per-winner payout is `economy_add_balance`
 *     (mutates only `economy_wallets`, no ledger row) computed from config × Valkey
 *     streak — so the results embed + payout + the `trivia.completed`→AuditService
 *     audit row cannot be observed here;
 *   - the hosted round POSTS via `channel.send` to a live `TextChannel` on a
 *     minute-aligned timer (empty channel cache gateway-less) — needs DISCORD_TOKEN.
 *
 * ── What IS proven NOW, non-vacuously ──
 *   - dashboard config (base payout / streak bonus / hard multiplier / cooldown /
 *     enabled) lands in `guild_config` — the exact row `TriviaManager.getConfig()`
 *     reads live — proven by readback of DB defaults and saved overrides;
 *   - owner-curated custom question packs land in `economy_trivia_questions` in the
 *     exact shape `getCustomQuestions()` reads (`question` / `correct_answer` /
 *     `wrong_answers` / `category` / `difficulty`) and blend into the served pool —
 *     proven by the exact guild-scoped SELECT the bot runs;
 *   - `economy_trivia_questions` is guild-scoped AND locked to service_role (RLS
 *     pattern-sweep lockdown, Tier 1): the service role sees the seeded row an anon
 *     client must not, and an anon REST INSERT is denied — the exact "a non-admin
 *     cannot inject questions" guarantee;
 *   - the `trivia-enabled` master switch gates both command exposure and dispatch:
 *     with it OFF the real dispatcher refuses `/trivia` with the disabled reply
 *     (a REAL captured reply) and the `trivia` command is not exposed by init;
 *   - trivia config + custom packs survive a full stack restart (they live in
 *     Supabase), proven across two boots of the same guild id.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact). It never
 * forces green and never weakens the catalog.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import { buildButtonInteraction } from '../../interaction-builders.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface TriviaConfigRow {
  economy_trivia_enabled: boolean;
  economy_trivia_base_payout: number;
  economy_trivia_streak_multiplier_pct: number;
  economy_trivia_hard_multiplier: number;
  economy_trivia_cooldown_seconds: number;
}

interface TriviaQuestionRow {
  id: string;
  guild_id: string;
  question: string;
  correct_answer: string;
  wrong_answers: string[];
  category: string;
  difficulty: string;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readTriviaConfig(handle: LiveClientHandle): Promise<TriviaConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_trivia_enabled, economy_trivia_base_payout, economy_trivia_streak_multiplier_pct, economy_trivia_hard_multiplier, economy_trivia_cooldown_seconds',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as TriviaConfigRow | null) ?? null;
}

/**
 * Insert one run-prefixed custom question exactly as the dashboard trivia API
 * writes it (the shape `getCustomQuestions()` reads back). Surfaces the new id
 * plus any PostgREST error.
 */
async function insertCustomQuestion(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  q: { question: string; correct: string; wrong: string[]; category: string; difficulty: string },
): Promise<{ id: string | null; error: PgErr }> {
  const { data, error } = await handle.supabase
    .from('economy_trivia_questions')
    .insert({
      guild_id: handle.guildId,
      question: `${ctx.runPrefix}${q.question}`,
      correct_answer: q.correct,
      wrong_answers: q.wrong,
      category: q.category,
      difficulty: q.difficulty,
    })
    .select('id')
    .single();
  return { id: (data as { id: string } | null)?.id ?? null, error: (error as PgErr) ?? null };
}

/** The EXACT guild-scoped SELECT `TriviaManager.getCustomQuestions()` runs. */
async function readCustomQuestions(handle: LiveClientHandle): Promise<TriviaQuestionRow[]> {
  const { data } = await handle.supabase
    .from('economy_trivia_questions')
    .select('id, guild_id, question, correct_answer, wrong_answers, category, difficulty')
    .eq('guild_id', handle.guildId)
    .limit(1000);
  return (data as TriviaQuestionRow[] | null) ?? [];
}

/** Service-role count of the domain's core table — the RLS positive control. */
async function serviceQuestionCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_trivia_questions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/** Arrange a wallet via the REAL initializer the bot uses (payout target). */
async function seedWallet(handle: LiveClientHandle, userId: string, wallet: number): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
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

/** Read the last editReply/reply content string a handler produced. */
/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return payloadText(edits[edits.length - 1]!.payload);
  }
  return payloadText(captured.find('reply')?.payload);
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny → 0), or null when inconclusive (→ GATE).
 * PostgREST surfaces a genuine authorization denial as SQLSTATE 42501 / "permission
 * denied" (HTTP 401/403) which we treat as the deny; a rejected key or other error
 * is inconclusive.
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

/**
 * Anon-write probe: attempt an anon REST INSERT into a table. Returns 'denied'
 * (non-2xx with 42501 / "permission denied" — the deny we want), 'allowed' (a 2xx
 * — a real exposure the caller FAILs on), or null (inconclusive → GATE).
 */
async function anonInsertOutcome(
  anonKey: string,
  table: string,
  row: Record<string, unknown>,
): Promise<'denied' | 'allowed' | null> {
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
      body: JSON.stringify(row),
    });
    if (res.ok) return 'allowed';
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      // Non-JSON error body: a 401/403 without a parseable body is still a deny.
      return res.status === 401 || res.status === 403 ? 'denied' : null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 'denied';
    }
    return res.status === 401 || res.status === 403 ? 'denied' : null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

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
    'Failure-branch alerts (e.g. the payout-delayed owner alert) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus the fault-injected winner-payout-failed branch (Redis + round resolution)',
  );
}

/**
 * Prove `economy_trivia_questions` is guild-scoped AND anon-denied under RLS, made
 * non-vacuous by a positive control: the scenario has already seeded a real custom
 * question under the guild (the service role sees it), so an anon client reading
 * ZERO of those rows is a real deny. GATEs (never fakes) when there is no question
 * to isolate, no anon key, or the probe is inconclusive.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const svc = await serviceQuestionCount(handle);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_trivia_questions rows (service_role-only RLS lockdown).',
      'this scenario seeds no custom question to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed a question',
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_trivia_questions rows (service_role-only RLS lockdown).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_trivia_questions', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero economy_trivia_questions rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s custom trivia question rows while an anon client reads zero of them (service_role-only RLS lockdown).',
    observation:
      `service-role sees ${svc} question row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_trivia_questions row(s) for that guild.`,
    impact:
      'A custom question row (including its answers) visible to the service role was also readable with an anon key — RLS is not denying anon reads (answer-leak / data exposure).',
  });
}

interface RoundSurface {
  title: string;
  description: string;
  buttonIds: string[];
}

/** Read the /trivia start question embed (title/description) + answer-button row
 *  (customIds) from a captured reply. The reply payload is
 *  `{ embeds: [EmbedBuilder{data}], components: [ActionRowBuilder{components:[ButtonBuilder{data}]}] }`. */
function readRoundSurface(captured: CapturedResponse): RoundSurface {
  const reply = captured.allOf('reply').at(-1)?.payload as
    | {
        embeds?: Array<{ data?: { title?: string; description?: string } }>;
        components?: Array<{ components?: Array<{ data?: { custom_id?: string } }> }>;
      }
    | undefined;
  const embed = reply?.embeds?.[0]?.data;
  const row = reply?.components?.[0]?.components ?? [];
  return {
    title: String(embed?.title ?? ''),
    description: String(embed?.description ?? ''),
    buttonIds: row.map((b) => String(b?.data?.custom_id ?? '')),
  };
}

/**
 * Drive the REAL `/trivia start` subcommand (the #331 subcommand injector) and prove the
 * member-facing round surface it posts: the branded question embed and the four tappable
 * answer buttons whose customIds encode the channel (`trivia:{channelId}:{i}`) — the exact
 * surface a member answers. The round-start path only touches Valkey for the per-channel
 * cooldown breather, which `cooldownRemaining` SKIPS when the configured cooldown is 0 — so
 * the caller boots the round-drive guild with `economy_trivia_cooldown_seconds: 0` to keep
 * this Redis-free. The streak-scaled PAYOUT + results embed resolve in endRound on a
 * 20-second setTimeout that reads Valkey streaks — a genuine residual GATED separately
 * (gateResultsPayout / gatePayoutMath). Records the Discord (round surface) + branding
 * (member surface) PASSes and returns the surface so a caller can drive answer presses.
 */
async function proveRoundSurface(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
): Promise<RoundSurface | null> {
  const captured = await ctx.runSlash(handle, { commandName: 'trivia', userId, subcommand: 'start', options: {} });
  const surface = readRoundSurface(captured);
  const fourButtons =
    surface.buttonIds.length === 4 && surface.buttonIds.every((id) => /^trivia:[^:]+:[0-3]$/.test(id));

  ctx.expect(/trivia/i.test(surface.title) && fourButtons && /20 seconds/i.test(surface.description), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'A REAL /trivia start posts the question embed with four shuffled answer buttons (customId trivia:{channelId}:{i}) and a 20-second answer window.',
    observation:
      `/trivia start replied with an embed titled "${truncate(surface.title, 40)}" and ${surface.buttonIds.length} answer button(s) ` +
      `${JSON.stringify(surface.buttonIds)}; 20-second window text present=${/20 seconds/i.test(surface.description)}.`,
    impact: 'The /trivia start round surface did not render the question embed with its four answer buttons.',
  });

  ctx.expect(surface.title.length > 0 && surface.description.length > 0 && fourButtons, {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise:
      'The /trivia start member surface renders as the owner question-board embed (branded question + four answer buttons), never a stock refusal.',
    observation: `/trivia start question embed title="${truncate(surface.title, 40)}", answer buttons=${surface.buttonIds.length}.`,
    impact: 'The /trivia start surface did not render the branded question board.',
  });

  return fourButtons ? surface : null;
}

/**
 * Prove the in-memory per-member answer lock live: inject the SAME member's answer button
 * twice through the REAL dispatcher → handleAnswer — the first press locks the answer, every
 * later press returns the already-answered notice (round.answers is an in-memory Map keyed by
 * user id; no Valkey, no timer). The streak-scaled per-winner PAYOUT idempotency stays a
 * Valkey residual (gateStreakValkey).
 */
async function proveAnswerLock(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  buttonId: string,
  userId: string,
): Promise<void> {
  const injector = ctx.injectorFor(handle);
  const press = (): Promise<CapturedResponse> =>
    injector.inject(
      buildButtonInteraction({
        customId: buttonId,
        guildId: handle.guildId,
        client: handle.client,
        user: { id: userId, username: userId, displayName: userId },
      }),
    );
  const first = replyContent(await press());
  const second = replyContent(await press());
  ctx.expect(/locked in/i.test(first) && /already answered/i.test(second), {
    assertionClass: 'replay-safety',
    channel: 'captured-reply',
    promise:
      'A member’s repeated answer presses lock exactly one answer: the first press confirms the locked answer and every later press returns the already-answered notice (in-memory per-member answer lock — one effect per logical action).',
    observation: `first press reply="${truncate(first, 50)}", repeated press reply="${truncate(second, 50)}".`,
    impact: 'A member locked more than one answer — the per-member answer lock did not dedupe repeated presses.',
  });
}

/**
 * Drive a second `/trivia start` in the same channel (runSlash reuses the default channel id)
 * and prove the single-round-per-channel refusal — the in-memory `activeRounds` guard — through
 * the REAL dispatcher. Precondition: a round is already live in the guild (proveRoundSurface ran).
 */
async function proveSecondStartRefused(ctx: ScenarioContext, handle: LiveClientHandle, userId: string): Promise<void> {
  const captured = await ctx.runSlash(handle, { commandName: 'trivia', userId, subcommand: 'start', options: {} });
  const text = replyContent(captured);
  ctx.expect(/already active/i.test(text), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'A second /trivia start in a channel with a live round is refused with the round-already-active notice (single round per channel).',
    observation: `the second /trivia start replied "${truncate(text, 60)}".`,
    impact: 'A second concurrent /trivia start opened a duplicate round instead of being refused.',
  });
}

/**
 * DEF alone keeps the catalog-default 30s cooldown, whose breather probe (valkey.ttl) needs a
 * Redis before /trivia start can post; when Redis is absent the branded round surface GATEs here
 * (it is driven Redis-free in the cooldown-0 scenarios). Records the Discord + branding
 * captured-reply gates with the honest Valkey-cooldown reason (never the stale injector reason).
 */
function gateRoundSurfaceCooldownRedis(ctx: ScenarioContext): void {
  const reason =
    'with the catalog-default 30s cooldown, /trivia start issues a Valkey breather probe (valkey.ttl) that ' +
    'needs Redis before it posts; the branded question embed + four answer buttons are driven live Redis-free ' +
    'in the cooldown-0 scenarios (SET-A / REPLAY / RACE / RESTART)';
  ctx.gate(
    'Discord',
    'captured-reply',
    'A REAL /trivia start posts the question embed with four shuffled answer buttons and a 20-second answer window.',
    reason,
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The /trivia start member surface renders as the owner question-board embed.',
    reason,
  );
}

/**
 * The member-facing trivia surfaces are proven live (proveRoundSurface); the FULL white-label
 * brand kit (owner brand name/colors, voice preset, powered-by-SomniBot attribution) is a
 * pixel/snapshot match that stays a live-guild readback residual — the current /trivia embeds
 * use generic "🧠 Trivia Time!"/blurple styling with no configured brand name or powered-by.
 */
function gateBrandKit(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (owner brand name, colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on trivia embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild); the current /trivia embeds use generic "🧠 Trivia Time!"/blurple styling with no configured brand name or powered-by attribution',
  );
}

/**
 * A trivia round IS audited: endRound emits `trivia.completed`, which the AuditService maps to
 * an append-only audit_logs row (action 'trivia.completed', category 'economy'). But endRound
 * fires only on the 20-second setTimeout (and its winner payout reads Valkey), and the harness
 * has no accelerated clock, so no trivia audit row is written to observe here.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every trivia round-completion lands one append-only audit row (actor, guild, correlation id) via the trivia.completed platform event.',
    'the audit row is written in endRound via the trivia.completed → AuditService mapping, but endRound fires only on the 20-second setTimeout (no accelerated clock here), so no DB-observable trivia audit row exists to read',
  );
}

/** The results embed + streak-scaled winner payout resolve in endRound on a 20-second
 *  setTimeout that reads Valkey streaks — no accelerated clock and no Redis here (the
 *  /trivia start question embed + answer-button presses ARE driven live above). */
function gateResultsPayout(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'redis-dependency',
    promise,
    'the results embed + streak-scaled payout are computed in endRound, fired by a 20-second setTimeout that reads the Valkey streak key (trivia:streak:{guildId}:{userId}); with no accelerated clock and no Redis the round cannot resolve here (the /trivia start question embed + answer-button presses ARE driven live)',
  );
}

function gatePayoutMath(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'redis-dependency',
    promise,
    'the payout is floor(base × difficulty/hard × (1 + streak×streakPct/100)) computed in endRound, where the streak is a Valkey key (trivia:streak:*, 24h TTL); endRound fires on a 20-second setTimeout and reads that Valkey streak, so with no Redis and no accelerated clock the streak-scaled payout cannot run (the /trivia start question embed + answer-button presses ARE driven live)',
  );
}

function gateStreakValkey(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    promise,
    'trivia streaks + winner payouts are keyed in Valkey (economy_trivia_sessions was dropped in v53) and applied in endRound on a 20-second setTimeout; with no Redis and no accelerated clock the per-streak / per-winner-payout idempotency cannot be exercised (the in-memory per-answer lock IS driven live via button injection where relevant)',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box defaults; a first-win winner is paid exactly 55 (50 × 1.1). */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const basePayoutDefault = Number(declaredDefault(ctx.domain, 'trivia-base-payout')); // 50
  const streakPctDefault = Number(declaredDefault(ctx.domain, 'trivia-streak-multiplier-pct')); // 10
  const hardMultDefault = Number(declaredDefault(ctx.domain, 'trivia-hard-multiplier')); // 2
  const cooldownDefault = Number(declaredDefault(ctx.domain, 'trivia-cooldown-seconds')); // 30

  // Enable trivia (registers the manager + exposes the command) but DO NOT override
  // the numeric columns, so they take their DB defaults — proving the live defaults
  // TriviaManager.getConfig() reads equal the catalog-declared defaults.
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
  });

  const cfg = await readTriviaConfig(handle);
  ctx.expect(
    cfg?.economy_trivia_base_payout === basePayoutDefault &&
      cfg?.economy_trivia_streak_multiplier_pct === streakPctDefault &&
      Number(cfg?.economy_trivia_hard_multiplier) === hardMultDefault &&
      cfg?.economy_trivia_cooldown_seconds === cooldownDefault,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: `Out of the box the live guild_config holds the catalog defaults: base payout ${basePayoutDefault}, streak bonus ${streakPctDefault}%, hard multiplier ${hardMultDefault}, cooldown ${cooldownDefault}s.`,
      observation:
        `guild_config holds base_payout=${cfg?.economy_trivia_base_payout}, streak_pct=${cfg?.economy_trivia_streak_multiplier_pct}, ` +
        `hard_multiplier=${cfg?.economy_trivia_hard_multiplier}, cooldown=${cfg?.economy_trivia_cooldown_seconds}.`,
      impact: 'The live trivia defaults diverged from the catalog-declared defaults.',
    },
  );

  // The `trivia-enabled` master switch exposes the /trivia command through the REAL
  // initGuildFeatures (the exact set the bot would register to Discord).
  ctx.expect(handle.commands.some((c) => c.name === 'trivia'), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With trivia enabled, the REAL per-guild init exposes the /trivia command.',
    observation: `the exposed command set ${handle.commands.some((c) => c.name === 'trivia') ? 'includes' : 'omits'} "trivia" (${handle.commands.length} commands total).`,
    impact: 'Trivia was enabled but its command was not exposed by the production init path.',
  });

  // A run-prefixed built-in-equivalent custom question blends into the served pool:
  // the exact guild-scoped SELECT getCustomQuestions() runs returns it in the shape
  // the manager maps (correct_answer → correct, wrong_answers → wrong).
  const q = await insertCustomQuestion(ctx, handle, {
    question: 'What is 2 + 2?',
    correct: '4',
    wrong: ['3', '5', '22'],
    category: 'math',
    difficulty: 'easy',
  });
  const pool = await readCustomQuestions(handle);
  const served = pool.find((p) => p.id === q.id);
  ctx.expect(
    q.id !== null &&
      served?.correct_answer === '4' &&
      Array.isArray(served?.wrong_answers) &&
      served!.wrong_answers.length === 3 &&
      served?.difficulty === 'easy',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'An owner-curated custom question is readable by the exact getCustomQuestions() query and blends into the built-in pool with its answers intact.',
      observation:
        `inserted id=${q.id ?? '(null)'}; pool read back correct="${served?.correct_answer}", ` +
        `wrong=${JSON.stringify(served?.wrong_answers)}, difficulty="${served?.difficulty}".`,
      impact: 'A custom question did not persist / read back in the shape the round-builder consumes.',
    },
  );

  // The branded question embed + four answer buttons are driven live via /trivia start.
  // DEF keeps the catalog-default 30s cooldown, so the round-start path issues a Valkey
  // breather probe (valkey.ttl) — the live drive is therefore guarded on Redis here; the
  // cooldown-0 scenarios (SET-A / REPLAY / RACE / RESTART) drive the same surface Redis-free.
  if (ctx.capabilities.redis) {
    const surface = await proveRoundSurface(ctx, handle, ctx.userId('a'));
    if (surface) await proveAnswerLock(ctx, handle, surface.buttonIds[0]!, ctx.userId('lock'));
  } else {
    gateRoundSurfaceCooldownRedis(ctx);
  }
  gateResultsPayout(
    ctx,
    '/trivia start’s results embed lists the first-win winner paid exactly 55 play coins.',
  );
  gatePayoutMath(
    ctx,
    `A first-win winner on an easy question is paid exactly 55 play coins (base ${basePayoutDefault} × 1.0 easy × 1.1 first-win streak), and a hard question pays double (110).`,
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateStreakValkey(
    ctx,
    'Each correct answerer is paid exactly once (one streak-scaled payout per winner).',
  );
}

/** SET-A — dashboard config (base 200 / streak 50% / hard 3 + custom pack) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_trivia_enabled: true,
      economy_trivia_cooldown_seconds: 0, // skip the Valkey breather probe so the round drives Redis-free
      economy_trivia_base_payout: 200,
      economy_trivia_streak_multiplier_pct: 50,
      economy_trivia_hard_multiplier: 3,
    },
  });

  // The saved values land in guild_config — the exact row getConfig() reads live.
  const cfg = await readTriviaConfig(handle);
  ctx.expect(
    cfg?.economy_trivia_base_payout === 200 &&
      cfg?.economy_trivia_streak_multiplier_pct === 50 &&
      Number(cfg?.economy_trivia_hard_multiplier) === 3,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'A dashboard save of base payout 200, streak bonus 50%, and hard multiplier 3 persists to guild_config and is what the bot reads live (no restart).',
      observation:
        `guild_config holds base_payout=${cfg?.economy_trivia_base_payout} (expected 200), ` +
        `streak_pct=${cfg?.economy_trivia_streak_multiplier_pct} (expected 50), hard_multiplier=${cfg?.economy_trivia_hard_multiplier} (expected 3).`,
      impact: 'A saved trivia payout configuration did not persist / would not take live effect.',
    },
  );

  // A run-prefixed custom HARD question is added on the dashboard trivia page — the
  // next round would draw it from the pool the bot builds.
  const q = await insertCustomQuestion(ctx, handle, {
    question: 'Which trench is the deepest?',
    correct: 'Mariana Trench',
    wrong: ['Tonga Trench', 'Java Trench', 'Puerto Rico Trench'],
    category: 'geography',
    difficulty: 'hard',
  });
  const pool = await readCustomQuestions(handle);
  const served = pool.find((p) => p.id === q.id);
  ctx.expect(q.id !== null && served?.difficulty === 'hard' && served?.correct_answer === 'Mariana Trench', {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The custom hard-difficulty question added on the dashboard is served from the guild’s pool with its correct answer intact.',
    observation: `custom question id=${q.id ?? '(null)'}, difficulty="${served?.difficulty}", correct="${served?.correct_answer}".`,
    impact: 'The dashboard-added custom question did not reach the pool the round-builder reads.',
  });

  // The next round's branded question embed + answer buttons drive live under the saved config.
  const surface = await proveRoundSurface(ctx, handle, ctx.userId('a'));
  if (surface) await proveAnswerLock(ctx, handle, surface.buttonIds[0]!, ctx.userId('lock'));
  gatePayoutMath(
    ctx,
    'Under the new math a hard-question first win pays exactly 900 play coins (base 200 × 3 hard × 1.5 first-win streak from streak bonus 50%).',
  );
  gateResultsPayout(
    ctx,
    'After the save the hard-difficulty results embed pays the winner exactly 900 play coins from the run-prefixed custom question pool.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'The new payout math applies exactly once per winner (no double credit under the raised numbers).');
}

/**
 * SET-B — the `trivia-enabled` master switch gates command exposure + dispatch, and
 * the hosted cadence toggles independently.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  // Enabled guild: the command is exposed and the config records enabled=true. The hosted
  // cadence is configured (interval + channel) but its schedule switch is left OFF, so the
  // TriviaScheduleRunner tick no-ops (no post, no alert) while its config still persists —
  // proving the hosted-cadence settings toggle independently of the trivia master switch.
  const scheduleChannelId = `${ctx.runPrefix}sched-chan`;
  const enabled = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_trivia_enabled: true,
      economy_trivia_cooldown_seconds: 0, // skip the Valkey breather probe so the round drives Redis-free
      economy_trivia_schedule_enabled: false,
      economy_trivia_schedule_interval_minutes: 30,
      economy_trivia_schedule_channel_id: scheduleChannelId,
    },
  });
  const enabledCfg = await readTriviaConfig(enabled);
  ctx.expect(enabledCfg?.economy_trivia_enabled === true && enabled.commands.some((c) => c.name === 'trivia'), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With trivia enabled, guild_config records enabled=true and the REAL init exposes the /trivia command (on-command trivia works).',
    observation: `enabled config=${enabledCfg?.economy_trivia_enabled}; exposed set ${enabled.commands.some((c) => c.name === 'trivia') ? 'includes' : 'omits'} "trivia".`,
    impact: 'On-command trivia was not wired when enabled.',
  });
  // Seed a question so the RLS positive control holds on the enabled guild.
  await insertCustomQuestion(ctx, enabled, {
    question: 'Capital of Australia?',
    correct: 'Canberra',
    wrong: ['Sydney', 'Melbourne', 'Brisbane'],
    category: 'geography',
    difficulty: 'medium',
  });

  // Disabled guild (economy_trivia_enabled explicitly OFF → manager unregistered):
  // trivia now SHIPS ON by default (catalog trivia-enabled=true, guild_config
  // column DEFAULT flipped to true), so the owner-opts-out path is exercised with
  // an explicit false override rather than the old ship-OFF default. The REAL
  // dispatcher refuses /trivia with the disabled reply (a REAL captured reply)
  // and the command is not exposed.
  const disabled = await ctx.bootGuild({
    label: 'b',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: false },
  });
  const refusal = await ctx.runSlash(disabled, { commandName: 'trivia', userId: ctx.userId('a') });
  const refusalText = replyContent(refusal);
  ctx.expect(refusalText.toLowerCase().includes('not enabled'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With trivia disabled, the real dispatcher refuses /trivia with the disabled explanation rather than opening a round.',
    observation: `disabled-guild /trivia captured reply = "${truncate(refusalText)}".`,
    impact: 'A disabled guild did not refuse /trivia — the trivia-enabled master switch was not honored.',
  });
  ctx.expect(!disabled.commands.some((c) => c.name === 'trivia'), {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A disabled guild does not expose the /trivia command through init.',
    observation: `disabled-guild exposed set ${disabled.commands.some((c) => c.name === 'trivia') ? 'still includes' : 'omits'} "trivia".`,
    impact: 'The /trivia command was exposed even though trivia was disabled.',
  });

  // The hosted cadence IS implemented now (TriviaScheduleRunner + the economy_trivia_schedule_*
  // guild_config columns the runner reads). Prove DB-observably that the hosted-cadence config
  // toggles independently of the master switch: with trivia (command) ON, the schedule switch is
  // OFF while its interval + channel persist — the exact row TriviaScheduleRunner.loadConfig reads.
  const { data: schedRow } = await enabled.supabase
    .from('guild_config')
    .select(
      'economy_trivia_enabled, economy_trivia_schedule_enabled, economy_trivia_schedule_interval_minutes, economy_trivia_schedule_channel_id',
    )
    .eq('guild_id', enabled.guildId)
    .maybeSingle();
  const sched = schedRow as
    | {
        economy_trivia_enabled: boolean;
        economy_trivia_schedule_enabled: boolean;
        economy_trivia_schedule_interval_minutes: number;
        economy_trivia_schedule_channel_id: string | null;
      }
    | null;
  ctx.expect(
    sched?.economy_trivia_enabled === true &&
      sched?.economy_trivia_schedule_enabled === false &&
      sched?.economy_trivia_schedule_interval_minutes === 30 &&
      sched?.economy_trivia_schedule_channel_id === scheduleChannelId,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The hosted-cadence config (schedule switch, interval, channel) persists to guild_config independently of the trivia master switch — the exact columns the TriviaScheduleRunner reads; disabling the schedule leaves on-command /trivia enabled.',
      observation:
        `guild_config: trivia_enabled=${sched?.economy_trivia_enabled} (expected true), schedule_enabled=${sched?.economy_trivia_schedule_enabled} (expected false), ` +
        `interval=${sched?.economy_trivia_schedule_interval_minutes} (expected 30), channel="${sched?.economy_trivia_schedule_channel_id}" (expected "${scheduleChannelId}").`,
      impact: 'The hosted-cadence config did not persist independently of the master switch (the scheduled piece is not toggleable as contracted).',
    },
  );

  // On-command trivia is untouched while the schedule is off: the branded question surface drives live.
  await proveRoundSurface(ctx, enabled, ctx.userId('a'));

  // The actual automatic POST still needs a live gateway + accelerated clock (GATED, corrected reason).
  ctx.gate(
    'Discord',
    'discord-readback',
    'With the schedule switch on and a channel configured, hosted rounds post automatically on the interval and resolve/pay normally.',
    'the hosted cadence IS implemented (TriviaScheduleRunner + economy_trivia_schedule_* guild_config columns, proven to persist above), but a hosted round posts via channel.send to a live TextChannel on a minute-aligned timer — guild.channels.cache is empty gateway-less, so it needs a live Discord gateway + an accelerated clock to observe the automatic post',
  );
  await proveRlsIsolation(ctx, enabled);
  await proveNoOwnerAlert(ctx, enabled);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'Re-delivering a hosted round’s events yields no duplicate payouts.');
}

/** INVALID — a rejected invalid config never persists; the next round uses prior valid math. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_trivia_enabled: true,
      economy_trivia_cooldown_seconds: 0, // skip the Valkey breather probe so the round drives Redis-free
      economy_trivia_base_payout: 75,
      economy_trivia_hard_multiplier: 2,
    },
  });

  // guild_config keeps its prior valid values byte-for-byte (nothing invalid persisted).
  const cfg = await readTriviaConfig(handle);
  ctx.expect(cfg?.economy_trivia_base_payout === 75 && Number(cfg?.economy_trivia_hard_multiplier) === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected negative base payout / a hard multiplier below one never persists).',
    observation: `guild_config holds base_payout=${cfg?.economy_trivia_base_payout} (expected 75), hard_multiplier=${cfg?.economy_trivia_hard_multiplier} (expected 2).`,
    impact: 'A valid trivia configuration was not retained after a rejected save.',
  });

  // A question seeded now still reads back under the unchanged config (behavior
  // unchanged on the next round after the rejected save; RLS positive control).
  const q = await insertCustomQuestion(ctx, handle, {
    question: 'Who wrote 1984?',
    correct: 'George Orwell',
    wrong: ['Aldous Huxley', 'Ray Bradbury', 'H.G. Wells'],
    category: 'literature',
    difficulty: 'medium',
  });
  ctx.expect(q.id !== null && (await readCustomQuestions(handle)).some((p) => p.id === q.id), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The next round after the rejected save draws from the unchanged pool under the previous valid payout math.',
    observation: `the question pool ${q.id !== null ? 'contains' : 'is missing'} the seeded question (id=${q.id ?? '(null)'}).`,
    impact: 'A rejected config attempt disturbed the live trivia pool the bot reads.',
  });

  // The trivia config columns now carry DB CHECK constraints (migration 20260723180100:
  // guild_config_trivia_base_payout_check ≥ 0, guild_config_trivia_hard_mult_check ≥ 1), so an
  // invalid save is rejected AT THE DB — drive the reject path directly: a service-role write of
  // a negative base payout / a hard multiplier below one is refused and the prior valid values
  // are retained byte-for-byte.
  const { error: negErr } = await handle.supabase
    .from('guild_config')
    .update({ economy_trivia_base_payout: -1 })
    .eq('guild_id', handle.guildId);
  const { error: hardErr } = await handle.supabase
    .from('guild_config')
    .update({ economy_trivia_hard_multiplier: 0 })
    .eq('guild_id', handle.guildId);
  const afterReject = await readTriviaConfig(handle);
  ctx.expect(
    negErr !== null &&
      hardErr !== null &&
      afterReject?.economy_trivia_base_payout === 75 &&
      Number(afterReject?.economy_trivia_hard_multiplier) === 2,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'A negative base payout / a hard multiplier below one is rejected by the guild_config CHECK constraints and never persists; the prior valid values are retained byte-for-byte.',
      observation:
        `negative base_payout write rejected=${negErr !== null}, hard-multiplier-below-1 write rejected=${hardErr !== null}; ` +
        `after both attempts: base_payout=${afterReject?.economy_trivia_base_payout} (expected 75), hard_multiplier=${afterReject?.economy_trivia_hard_multiplier} (expected 2).`,
      impact: 'An invalid trivia config value persisted — the DB CHECK constraint did not reject the out-of-range write.',
    },
  );

  // The DB rejects the value (proven above); the dashboard's owner-facing validation-error COPY
  // (the Zod message) is the remaining surface — still a live-dashboard readback.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard trivia page surfaces a clear validation-error message for a negative base payout / a hard multiplier below one.',
    'the DB-level rejection is proven above via the guild_config CHECK constraints; the owner-facing Zod validation-error COPY is rendered by the dashboard save path (not reachable in this bot-only harness)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected trivia configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness); the DB rejects the invalid value directly (proven above)',
  );

  // Live behavior is unchanged after the rejected save: the next /trivia start still posts the
  // branded question surface under the retained valid config.
  await proveRoundSurface(ctx, handle, ctx.userId('a'));
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateStreakValkey(ctx, 'Re-running a round after the rejected save pays under the prior valid math exactly once.');
}

/** UNAUTH — a non-admin cannot change payouts or inject questions into the pool. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0 },
  });

  // Baseline pool (an admin-curated question) + RLS positive control.
  const legit = await insertCustomQuestion(ctx, handle, {
    question: 'Chemical symbol for gold?',
    correct: 'Au',
    wrong: ['Ag', 'Fe', 'Cu'],
    category: 'science',
    difficulty: 'easy',
  });
  const countBefore = await serviceQuestionCount(handle);

  // A non-admin has NO surface to alter the pool; the table is locked to service_role
  // (RLS pattern-sweep lockdown, Tier 1). Prove it directly: an anon REST INSERT is
  // denied and the pool is unchanged.
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-observable',
      'A non-admin (anon) cannot inject a trivia question: an anon REST INSERT into economy_trivia_questions is denied and the pool is unchanged.',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-write-denial probe cannot run — anon-read denial is still proven in proveRlsIsolation',
    );
  } else {
    const outcome = await anonInsertOutcome(anonKey, 'economy_trivia_questions', {
      guild_id: handle.guildId,
      question: `${ctx.runPrefix}anon-injected`,
      correct_answer: 'hacked',
      wrong_answers: ['a', 'b', 'c'],
      category: 'general',
      difficulty: 'easy',
    });
    const countAfter = await serviceQuestionCount(handle);
    if (outcome === null) {
      ctx.gate(
        'database-RLS',
        'db-observable',
        'A non-admin (anon) cannot inject a trivia question.',
        'the anon-insert probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
      );
    } else {
      ctx.expect(outcome === 'denied' && countAfter === countBefore, {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise:
          'A non-admin (anon) cannot inject a question into the pool: an anon REST INSERT into economy_trivia_questions is denied and the pool row-count is unchanged.',
        observation: `anon INSERT outcome=${outcome}; question count before=${countBefore}, after=${countAfter}.`,
        impact:
          'An anon client could write to economy_trivia_questions — a member with no dashboard access could inject questions (RLS/GRANT lockdown breached).',
      });
    }
  }
  ctx.expect(legit.id !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The admin-curated pool remains intact and is what the next round draws from (unmodified pool, unmodified payout math).',
    observation: `admin-curated question id=${legit.id ?? '(null)'} present in the guild pool.`,
    impact: 'The admin-curated question was lost — the pool is not the one the next round would serve.',
  });

  // The non-admin dashboard save refusal + its permission-denied audit row live on the
  // dashboard session-auth lane (RLS + session role), not reachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot change trivia payouts or add questions (returns an authorization error); the next round still draws from the prior pool with the prior payout math.',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied trivia configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  // The admin-curated pool still drives the branded question surface (unmodified pool + math).
  await proveRoundSurface(ctx, handle, ctx.userId('a'));
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateStreakValkey(ctx, 'A refused write leaves the pool and payout math byte-identical (no partial effect).');
}

/** DEPFAIL — Supabase/Valkey-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database/Valkey outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'During the outage /trivia start replies with the branded trivia-unavailable template in the owner’s voice and no question embed posts; after restoration a full round resolves and pays with pre-outage streaks honored.',
    'requires a Supabase/Valkey dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB); /trivia start itself is driven live in the happy-path scenarios',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed round start).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh round runs end-to-end with streaks intact, logged with the run-prefixed correlation id.',
    'requires the outage fault lane; trivia also writes no DB-observable audit/ledger row (economy_add_balance touches only economy_wallets) and streaks live in Valkey',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No corrupted streaks or double payouts survive the outage/restore cycle.',
    'requires a Supabase/Valkey dependency-outage fault-injection lane; trivia streaks + answer locks are Valkey/in-memory',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded trivia-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the trivia-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Trivia rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a winner payout that fails transiently converges safely (results flag it, operator retry pays once). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
  });

  // The winner-payout-failed branch triggers only when economy_add_balance fails for a
  // correct answerer at round end — a mid-resolution fault that requires injection at
  // the wallet-RPC boundary, plus a resolved round (subcommand + buttons + 20s window +
  // Valkey streak). GATE the fault-dependent proof; do not fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault on the winner credit, the results embed lists the winner under the payout-failed notice (not as paid), and the operator retry credits exactly the computed payout once.',
    'requires a mid-resolution fault-injection lane (fail economy_add_balance for a correct answerer at round end) plus the 20-second endRound window + Valkey; the /trivia start subcommand and answer-button presses ARE driven live in the happy-path scenarios',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The flagged payout and its operator retry resolve under one idempotency key to exactly one play-money credit; the streak increment is applied once.',
    'requires the mid-resolution fault-injection lane plus the 20-second endRound timer + Valkey; endRound now queues a bot_action_queue "trivia_payout_retry" job on the failed branch, but the payout itself carries no idempotency key and that branch is only reachable via the fault lane (flagged for owner review)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one reasoned payout-delayed alert for the flagged winner.',
    'requires the fault lane plus owner alert channel readback; endRound now writes a trivia_payout_failed row to the alerts table and queues a bot_action_queue retry on the failed branch, but that branch is only reachable via the mid-resolution fault lane + the 20-second endRound timer',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The results embed honestly separates paid winners from the flagged payout in the owner voice.',
    'requires the mid-resolution fault-injection lane to reach the payout-degraded results embed',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The flagged payout and retry touch only the winner’s guild-scoped wallet.',
    'requires the mid-resolution fault-injection lane',
  );
  gateAudit(ctx);
}

/** REPLAY — repeated button presses lock one answer; re-delivered round events don’t double-pay. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0 },
  });

  // Seed a question so the RLS positive control + no-alert reads are real.
  await insertCustomQuestion(ctx, handle, {
    question: 'Largest organ in the human body?',
    correct: 'Skin',
    wrong: ['Liver', 'Brain', 'Heart'],
    category: 'science',
    difficulty: 'easy',
  });

  // The per-member answer lock is an in-memory Map (round.answers) — drive it LIVE: a real
  // /trivia start posts the question surface, then run-member-a's repeated button presses lock
  // exactly one answer (first press confirms, every later press returns the already-answered notice).
  const surface = await proveRoundSurface(ctx, handle, ctx.userId('a'));
  if (surface) await proveAnswerLock(ctx, handle, surface.buttonIds[0]!, ctx.userId('a'));
  // The channel keeping a single results embed + the streak/payout dedup resolve in endRound
  // (20-second timer) and are Valkey-native — genuine residuals.
  gateResultsPayout(
    ctx,
    'Re-delivering the recorded round events leaves the wallet, streak, and the single results embed byte-identical.',
  );
  gateStreakValkey(ctx, 'The streak update and winner payout each apply exactly one effect; replayed deliveries are deduplicated no-ops.');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateAudit(ctx);
}

/** RESTART — trivia config + custom packs survive a full stack restart. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: enable, save a distinctive config, seed a run-prefixed custom question, snapshot.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0, economy_trivia_base_payout: 123 },
  });
  const q = await insertCustomQuestion(ctx, first, {
    question: 'Speed of light (km/s approx)?',
    correct: '300,000',
    wrong: ['150,000', '500,000', '1,000,000'],
    category: 'science',
    difficulty: 'hard',
  });
  const snapshot = await readTriviaConfig(first);
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). Config + custom pack live in Supabase, so they
  // must be byte-identical.
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0, economy_trivia_base_payout: 123 },
  });
  const afterRestart = await readTriviaConfig(second);
  const poolAfter = await readCustomQuestions(second);
  ctx.expect(
    afterRestart?.economy_trivia_base_payout === snapshot?.economy_trivia_base_payout &&
      afterRestart?.economy_trivia_base_payout === 123 &&
      poolAfter.some((p) => p.id === q.id),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the trivia config (base payout 123) and the custom question pack persist exactly (they live in Supabase).',
      observation:
        `pre-restart base_payout=${snapshot?.economy_trivia_base_payout}; post-restart base_payout=${afterRestart?.economy_trivia_base_payout} (expected 123); ` +
        `custom question ${poolAfter.some((p) => p.id === q.id) ? 'survived' : 'was lost'} (id=${q.id ?? '(null)'}).`,
      impact: 'Trivia config or the custom question pack did not survive a restart — persisted state was lost or altered.',
    },
  );

  // Post-restart the in-memory active rounds are gone, so /trivia start opens a FRESH round
  // (no stuck round-already-active refusal) — driven live on the restarted guild, and the
  // in-memory per-member answer lock still applies.
  const surface = await proveRoundSurface(ctx, second, ctx.userId('a'));
  if (surface) await proveAnswerLock(ctx, second, surface.buttonIds[0]!, ctx.userId('lock'));
  // The streak persisted in Valkey (24h TTL) that a post-restart win would reflect is a residual.
  gateResultsPayout(ctx, 'A post-restart win’s payout reflects the streak value persisted in Valkey before the restart.');
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'No post-restart double payout occurs for the interrupted round.');
}

/** RACE — concurrent trivia actions are safe (one round, one already-active refusal). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0 },
  });

  // Seed a question so the RLS positive control + no-alert reads are real.
  await insertCustomQuestion(ctx, handle, {
    question: 'Hardest natural substance?',
    correct: 'Diamond',
    wrong: ['Titanium', 'Quartz', 'Sapphire'],
    category: 'science',
    difficulty: 'easy',
  });

  // The single-round-per-channel and one-answer-per-member guards are process-local in-memory
  // checks — drive them LIVE: a first /trivia start posts one question surface, a SECOND start
  // in the same channel is refused (round-already-active), and repeated presses lock one answer.
  const surface = await proveRoundSurface(ctx, handle, ctx.userId('a'));
  await proveSecondStartRefused(ctx, handle, ctx.userId('b'));
  if (surface) await proveAnswerLock(ctx, handle, surface.buttonIds[0]!, ctx.userId('a'));
  // Whether those guards serialize across shards, and paying each winner exactly once under the
  // answer race, resolve in endRound (20-second timer + Valkey streak) — genuine residuals. The
  // in-memory guard also does not serialize across shards/restarts (flagged for owner review).
  gateResultsPayout(ctx, 'Under a simultaneous-answer race every correct answerer is paid exactly once (one streak-scaled payout per winner).');
  gateStreakValkey(ctx, 'Two deliveries of one answer / one round apply exactly one effect (one lock, one payout per winner).');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx);
  gateAudit(ctx);
}

/** XGUILD — trivia is strictly per-guild (custom packs + payout config never cross). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0, economy_trivia_base_payout: 100 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0, economy_trivia_base_payout: 25 },
  });

  // Each guild gets its OWN distinct custom question pack.
  const qa = await insertCustomQuestion(ctx, handleA, {
    question: 'Guild-A-only: first iPhone year?',
    correct: '2007',
    wrong: ['2005', '2008', '2010'],
    category: 'technology',
    difficulty: 'medium',
  });
  const qb = await insertCustomQuestion(ctx, handleB, {
    question: 'Guild-B-only: longest river?',
    correct: 'Nile',
    wrong: ['Amazon', 'Mississippi', 'Yangtze'],
    category: 'geography',
    difficulty: 'medium',
  });

  const poolA = await readCustomQuestions(handleA);
  const poolB = await readCustomQuestions(handleB);
  ctx.expect(
    poolA.some((p) => p.id === qa.id) &&
      !poolA.some((p) => p.id === qb.id) &&
      poolB.some((p) => p.id === qb.id) &&
      !poolB.some((p) => p.id === qa.id),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each guild’s round draws only its OWN custom question pack; a second guild’s pack never appears in the first guild’s pool.',
      observation:
        `guild A pool has A’s question=${poolA.some((p) => p.id === qa.id)} / B’s question=${poolA.some((p) => p.id === qb.id)}; ` +
        `guild B pool has B’s question=${poolB.some((p) => p.id === qb.id)} / A’s question=${poolB.some((p) => p.id === qa.id)}.`,
      impact: 'A custom question pack leaked across guilds — trivia is not strictly per-guild.',
    },
  );

  // Payout config is per-guild too (A base 100, B base 25).
  const cfgA = await readTriviaConfig(handleA);
  const cfgB = await readTriviaConfig(handleB);
  ctx.expect(cfgA?.economy_trivia_base_payout === 100 && cfgB?.economy_trivia_base_payout === 25, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Each guild’s trivia payout config is scoped to that guild (A base 100, B base 25).',
    observation: `guild A base_payout=${cfgA?.economy_trivia_base_payout} (expected 100), guild B base_payout=${cfgB?.economy_trivia_base_payout} (expected 25).`,
    impact: 'A guild’s trivia payout configuration leaked across guilds.',
  });

  // Each guild scope reads its OWN distinct question row and never the other’s.
  const { data: bScoped } = await handleB.supabase
    .from('economy_trivia_questions')
    .select('id, guild_id')
    .eq('guild_id', guildB)
    .eq('id', qb.id ?? '')
    .maybeSingle();
  const { data: aCross } = await handleB.supabase
    .from('economy_trivia_questions')
    .select('id, guild_id')
    .eq('guild_id', guildB)
    .eq('id', qa.id ?? '') // guild A's question id, but scoped to guild B → must be absent
    .maybeSingle();
  const bRow = bScoped as { id: string; guild_id: string } | null;
  const crossRow = aCross as { id: string; guild_id: string } | null;
  ctx.expect(bRow?.guild_id === guildB && bRow?.id === qb.id && crossRow === null, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'A read scoped to guild B returns guild B’s own question and never guild A’s: guild-B scope → B’s row; guild A’s question id under guild B → no row.',
    observation:
      `guild-B-scoped read of B’s question=${bRow?.id ?? '(null)'} under "${bRow?.guild_id}"; ` +
      `guild A’s question id under guild B scope=${crossRow === null ? '(no row, correct)' : crossRow.id}.`,
    impact: 'A guild-scoped read returned another guild’s trivia question — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA);

  // Each guild's on-command round posts its OWN branded question surface (config + pack isolation
  // proven DB-observably above); drive guild A's live.
  await proveRoundSurface(ctx, handleA, ctx.userId('a'));
  // Per-guild streaks are Valkey keys (trivia:streak:{guildId}:{userId}) applied in endRound, and
  // guild B's payout math (base 25) resolves there too — genuine residuals.
  gateResultsPayout(ctx, 'Guild B’s rounds pay out under guild B’s payout math (base 25) and never touch guild A’s wallet or streak.');
  await proveNoOwnerAlert(ctx, handleA);
  gateBrandKit(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'Each guild’s streak keys and per-winner payouts evolve independently (Valkey-keyed, applied in endRound).');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_cooldown_seconds: 0 },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: custom questions + a wallet (payout target).
  await insertCustomQuestion(ctx, handle, {
    question: 'Cleanup Q1: capital of France?',
    correct: 'Paris',
    wrong: ['Lyon', 'Nice', 'Marseille'],
    category: 'geography',
    difficulty: 'easy',
  });
  await insertCustomQuestion(ctx, handle, {
    question: 'Cleanup Q2: 12 squared?',
    correct: '144',
    wrong: ['124', '154', '169'],
    category: 'math',
    difficulty: 'medium',
  });
  await seedWallet(handle, userA, 250);

  const questionsBefore = await serviceQuestionCount(handle);
  const walletsBefore = await walletCount(handle, userA);
  ctx.expect(questionsBefore >= 2 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed custom-question and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: questions=${questionsBefore}, wallets=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep). The branded
  // question surface drives live from the seeded pool (the round creates no DB rows, so the
  // post-sweep zero-leftover count is unaffected).
  await proveRoundSurface(ctx, handle, userA);
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const questionsAfter = await serviceQuestionCount(handle);
  const walletsAfter = await walletCount(handle, userA);
  ctx.expect(questionsAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed custom-question and wallet rows are deleted; a final sweep finds zero run-prefixed trivia resources.',
    observation: `post-sweep: questions=${questionsAfter}, wallets=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed trivia rows behind — the suite leaves residue.',
  });

  gateBrandKit(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed trivia question embeds or results embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the trivia operational rows are the DB-observable evidence here',
  );
  gateStreakValkey(ctx, 'Run-prefixed Valkey streak keys are cleared by cleanup and verified absent.');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Trivia domain proof: the guild_id-scoped tables the sweep must clear (child →
 * parent so FK-constrained rows are removed before their parents and the guild row),
 * plus the 12 scenario scripts.
 *
 * Notes on tables:
 *   - `economy_trivia_questions` FK-references guild_config(guild_id) ON DELETE
 *     CASCADE, so it is swept before guild_config (which context.ts always sweeps).
 *   - `economy_trivia_sessions` was DROPPED in v53 (trivia streaks are Valkey-backed),
 *     so it is intentionally NOT listed — a delete-by-guild_id would target a
 *     non-existent table.
 *   - `economy_wallets` (payout target) and `alerts` (owner-notification) are the
 *     other guild-scoped tables this domain touches.
 */
export const gameEconomyTriviaProof: DomainProof = {
  domainId: 'game-economy-trivia',
  guildScopedTables: ['economy_trivia_questions', 'economy_wallets', 'alerts'],
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
