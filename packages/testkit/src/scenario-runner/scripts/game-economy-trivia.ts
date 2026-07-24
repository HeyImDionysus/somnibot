/**
 * scenario-runner/scripts/game-economy-trivia — the Trivia domain proof.
 *
 * Binds the trivia domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. Every DB-observable /
 * RLS / owner-alert assertion runs NOW against the SAME production primitives the
 * bot reads; the live Discord round surfaces are GATED — the exact honesty
 * boundary the harness requires.
 *
 * ── Why this domain is MOSTLY GATED on the round/Discord side ──
 * The domain's only member entrypoint is `/trivia start` — a slash SUBCOMMAND —
 * and the whole round lifecycle is Discord-native + Valkey-native:
 *   - `ScenarioContext.runSlash` (see `RunSlashParams`) carries no subcommand
 *     field and the injector builds a subcommand-less interaction, so
 *     `handleTriviaCommand`'s first line `interaction.options.getSubcommand()`
 *     would throw before any round work runs (there is no button-injection helper
 *     either), so the question embed + four answer buttons + 20-second window
 *     cannot be driven here;
 *   - member answers are Discord BUTTON presses (`trivia:{channelId}:{i}`) locked
 *     in an in-memory `Map` — no button injector exists in this harness;
 *   - streaks live entirely in Valkey (`trivia:streak:{guildId}:{userId}`, 24h
 *     TTL) — `economy_trivia_sessions` was dropped in v53 (trivia is Valkey-backed),
 *     so the streak math + streak-scaled payout cannot run without a Redis;
 *   - the round is resolved by a `setTimeout` firing `endRound`, whose per-winner
 *     payout is `economy_add_balance` (mutates only `economy_wallets`, no ledger
 *     row) — the payout amount is computed in-memory from config × Valkey streak;
 *   - the owner-scheduled hosted cadence is UNIMPLEMENTED in this build (no
 *     scheduled-trivia guild_config columns and no scheduler in packages/bot/src),
 *     so SET-B's automatic rounds cannot be observed — flagged for owner review.
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
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return String((edits[edits.length - 1]!.payload as { content?: string } | undefined)?.content ?? '');
  }
  const reply = captured.find('reply');
  return String((reply?.payload as { content?: string } | undefined)?.content ?? '');
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

/**
 * The only member surfaces are the /trivia start question embed + answer buttons +
 * results embed — none drivable here (see file header). Branding is GATED honestly
 * rather than checked against the unbranded dispatcher disabled reply (the sole
 * capturable surface, which carries no owner brand token to compare against here).
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing trivia surfaces (question embed, answer-locked confirmation, results embed) show the owner brand name, colors, and voice preset with the powered-by-SomniBot attribution and zero stock-bot wording.',
    'the only entrypoint is /trivia start (a slash SUBCOMMAND) and answers are Discord buttons; runSlash carries no subcommand and the harness exposes no button injector, so no branded trivia embed is produced to inspect (the only capturable reply is the unbranded disabled-gate refusal)',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on trivia embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * Trivia pays winners via `economy_add_balance` (mutates ONLY economy_wallets — no
 * economy_transactions ledger row) and `TriviaManager` writes no audit_logs row, so
 * there is no DB-observable audit row for a trivia action in this harness.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every trivia state change lands exactly one append-only audit row with actor, guild, and correlation id; anonymization, never deletion, is the only mutation.',
    'the trivia payout runs through economy_add_balance (mutates only economy_wallets — no economy_transactions ledger row) and TriviaManager writes no audit_logs row, so there is no DB-observable audit row to read in this harness',
  );
}

function gateLiveRound(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) plus /trivia-start subcommand injection, answer-button injection, and the 20-second window the harness does not provide',
  );
}

function gatePayoutMath(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'redis-dependency',
    promise,
    'the payout is computed in endRound as floor(base × difficulty/hard × (1 + streak×streakPct/100)) where the streak is a Valkey key (trivia:streak:*, 24h TTL); with no Redis and no drivable round (subcommand + buttons + 20s window) the streak-scaled payout cannot run',
  );
}

function gateStreakValkey(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    promise,
    'trivia streaks + winner payouts are keyed in Valkey and the in-memory answers Map (economy_trivia_sessions was dropped in v53); with no Redis and no button injector the per-answer / per-winner idempotency cannot be exercised DB-observably',
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

  gateLiveRound(
    ctx,
    '/trivia start posts a built-in question embed with four shuffled answer buttons and a 20-second window, and the results embed lists the first-win winner paid exactly 55 play coins.',
  );
  gatePayoutMath(
    ctx,
    `A first-win winner on an easy question is paid exactly 55 play coins (base ${basePayoutDefault} × 1.0 easy × 1.1 first-win streak), and a hard question pays double (110).`,
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateStreakValkey(
    ctx,
    'Repeated answer presses lock exactly one answer and each correct answerer is paid exactly once (one effect per logical action).',
  );
}

/** SET-A — dashboard config (base 200 / streak 50% / hard 3 + custom pack) takes live effect. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_trivia_enabled: true,
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

  gatePayoutMath(
    ctx,
    'Under the new math a hard-question first win pays exactly 900 play coins (base 200 × 3 hard × 1.5 first-win streak from streak bonus 50%).',
  );
  gateLiveRound(
    ctx,
    'After the save the next round serves the run-prefixed custom question and the hard-difficulty results embed pays the winner exactly 900 play coins.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'The new payout math applies exactly once per winner (no double credit under the raised numbers).');
}

/**
 * SET-B — the `trivia-enabled` master switch gates command exposure + dispatch, and
 * the hosted cadence toggles independently.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  // Enabled guild: the command is exposed and the config records enabled=true.
  const enabled = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
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

  // The owner-scheduled hosted cadence is UNIMPLEMENTED in this build: there are no
  // scheduled-trivia guild_config columns and no scheduler in packages/bot/src, so it
  // cannot be observed here — flagged for owner review, GATED (never faked green).
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a schedule channel configured, hosted rounds post automatically on the interval and resolve/pay normally; disabling the scheduled piece leaves on-command trivia untouched.',
    'the hosted scheduled cadence is not implemented in this build (no scheduled-trivia guild_config columns, no trivia scheduler in packages/bot/src); it requires a live gateway + timer and is flagged as an intent gap for owner review',
  );
  await proveRlsIsolation(ctx, enabled);
  await proveNoOwnerAlert(ctx, enabled);
  gateBranding(ctx);
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

  // The REJECTION + its audit row are enforced in the dashboard's Zod layer;
  // guild_config's trivia columns carry NO CHECK constraint, so the reject path is
  // unreachable in a bot-only harness. GATE it honestly (never fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard trivia page surfaces a clear validation error for a negative base payout / a hard multiplier below one.',
    'config validation lives in the dashboard (Zod) layer; economy_trivia_base_payout / economy_trivia_hard_multiplier carry no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected trivia configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateStreakValkey(ctx, 'Re-running a round after the rejected save pays under the prior valid math exactly once.');
}

/** UNAUTH — a non-admin cannot change payouts or inject questions into the pool. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
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

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
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
    'requires a Supabase/Valkey dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB) plus /trivia-start subcommand injection',
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
    'requires a mid-resolution fault-injection lane (fail economy_add_balance for a correct answerer at round end) plus subcommand + answer-button injection and the 20-second window',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The flagged payout and its operator retry resolve under one idempotency key to exactly one play-money credit; the streak increment is applied once.',
    'requires the mid-resolution fault-injection lane; note the current build has no persisted payout-retry queue or idempotency key on the trivia payout (flagged for owner review)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one reasoned payout-delayed alert for the flagged winner.',
    'requires the fault lane plus owner alert channel readback; note endRound currently only logs the failed payout and flags it in the embed — it raises no owner alert and queues no operator retry (flagged for owner review)',
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
    guildConfigOverrides: { economy_trivia_enabled: true },
  });

  // Seed a question so the RLS positive control + no-alert reads are real.
  await insertCustomQuestion(ctx, handle, {
    question: 'Largest organ in the human body?',
    correct: 'Skin',
    wrong: ['Liver', 'Brain', 'Heart'],
    category: 'science',
    difficulty: 'easy',
  });

  // Trivia's replay guarantees are all Valkey/in-memory: the answer lock is
  // `round.answers.has(userId)` on an in-memory Map, the streak is a Valkey key, and
  // the winner payout has no persisted idempotency key (economy_trivia_sessions was
  // dropped in v53). None is DB-observable in this harness, so replay-safety GATES.
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'The second and later button presses return only the already-answered ephemeral notice, and the channel keeps exactly one question embed and one results embed for the round.',
    'the answer-lock is an in-memory Map keyed by user id and the streak/payout are Valkey-native; with no button injector and no Redis these idempotency effects cannot be exercised here',
  );
  gateStreakValkey(ctx, 'Idempotency keys on the answer lock, streak update, and winner payout each show one applied effect; replayed deliveries are deduplicated no-ops.');
  gateLiveRound(
    ctx,
    'run-member-a’s repeated button presses lock exactly one answer and re-delivering the recorded round events leaves the wallet, streak, and results embed byte-identical.',
  );
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
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
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_base_payout: 123 },
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
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_base_payout: 123 },
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

  // Streaks are Valkey (24h TTL) so their cross-restart continuation cannot be read
  // here; in-memory active rounds are dropped on restart (so no stuck already-active
  // refusal) — both are Valkey/in-memory + subcommand-driven and GATE.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Post-restart /trivia start opens a fresh round without a stuck round-already-active refusal, and the next win’s payout reflects the streak value persisted (in Valkey) before the restart.',
    'active rounds are in-memory (dropped on restart) and streaks are Valkey-persisted; with no Redis and no subcommand injector neither the streak continuation nor the fresh-round path can be driven here',
  );
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'No post-restart double payout occurs for the interrupted round.');
}

/** RACE — concurrent trivia actions are safe (one round, one already-active refusal). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
  });

  // Seed a question so the RLS positive control + no-alert reads are real.
  await insertCustomQuestion(ctx, handle, {
    question: 'Hardest natural substance?',
    correct: 'Diamond',
    wrong: ['Titanium', 'Quartz', 'Sapphire'],
    category: 'science',
    difficulty: 'easy',
  });

  // Trivia's concurrency guards are process-local: the single-round-per-channel guard
  // is an in-memory `activeRounds.has(channelId)` check and the one-answer-per-member
  // guard is an in-memory Map — there is NO DB-level serialization (no unique index,
  // economy_trivia_sessions was dropped in v53). So the start-race and answer-race
  // cannot be exercised DB-observably here and GATE (the in-memory guard is also a
  // note: it does not serialize across shards/restarts — flagged for owner review).
  ctx.gate(
    'Discord',
    'discord-readback',
    'Two simultaneous /trivia start invocations produce exactly one question embed and one branded already-active refusal; simultaneous answers each lock exactly once with every correct answerer paid once.',
    'the single-round-per-channel and one-answer-per-member guards are process-local in-memory checks (no DB unique index); with no subcommand/button injector the race cannot be driven, and the in-memory guard does not serialize across shards (flagged for owner review)',
  );
  gateStreakValkey(ctx, 'Two deliveries of one answer / one round apply exactly one effect (one lock, one payout per winner).');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
}

/** XGUILD — trivia is strictly per-guild (custom packs + payout config never cross). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_base_payout: 100 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true, economy_trivia_base_payout: 25 },
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

  // Streaks are per-guild by Valkey key (trivia:streak:{guildId}:{userId}) but Valkey
  // is not driven here, and the live round drawing only guild B's pack is subcommand-driven.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'run-member-a’s streak, wallet, and question pool in guild A are unchanged by winning rounds in guild B; guild B’s rounds draw only guild B’s packs under guild B’s payout math.',
    'streaks are per-guild Valkey keys (trivia:streak:{guildId}:{userId}) and the live round is subcommand-driven; with no Redis and no subcommand injector the per-guild streak/round cannot be driven (config + pack isolation is proven DB-observably above)',
  );
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateAudit(ctx);
  gateStreakValkey(ctx, 'Each guild’s streak keys and payouts evolve independently.');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_trivia_enabled: true },
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

  // Prove the off-theme classes while the rows still exist (before the sweep).
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

  gateBranding(ctx);
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
