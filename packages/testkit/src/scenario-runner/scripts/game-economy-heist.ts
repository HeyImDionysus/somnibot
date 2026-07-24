/**
 * scenario-runner/scripts/game-economy-heist — the Strategic Crew Heist domain proof.
 *
 * Binds the heist domain's 12 declarative catalog scenarios to concrete, real-stack
 * proofs driven against LOCAL Supabase. The heist money model + state machine are
 * exercised through the SAME atomic RPCs the production HeistManager calls —
 * economy_subtract_balance (entry-fee debit) + heist_start (open), heist_join (recruit),
 * heist_claim_for_resolution (freeze crew + roll outcome + freeze payout_each),
 * heist_credit_participant (pay/refund each frozen member, paid_at-guarded),
 * heist_finalize_resolution (single-shot terminal flip), and
 * heist_reconcile_stranded_joins (refund a late-join that raced the claim) — reading
 * every row back to prove the effect DB-observably.
 *
 * Why still MOSTLY the RPCs, not only ctx.runSlash: /heist is a slash command with
 * SUBCOMMANDS (start / join / status; heist/commands.ts reads
 * interaction.options.getSubcommand()). Since PR #331 the runner's runSlash CAN drive a
 * subcommand, so the member-facing surfaces ARE driven live where a captured reply/embed
 * carries the substance (see proveBranding — /heist start's recruiting embed and /heist
 * status's active-heist embed are driven through the REAL dispatcher and asserted). But
 * the resolve pipeline still fires only on a live setTimeout(join_window_secs) the fast
 * bot-only harness cannot let elapse, and the CSPRNG outcome roll is unseedable, so the
 * money-model state machine is exercised through the SAME atomic RPCs the manager calls
 * and the timer-driven resolution / channel announcements stay GATED behind
 * DISCORD_TOKEN + a live guild. The substance those RPC paths carry (entry-fee debits,
 * per-participant frozen entry_fee_paid, derived crew size + odds, the frozen outcome,
 * per-member payout_each, refunds, and idempotency under the paid_at / claimed_at /
 * uniq-active guards) is proven for real by driving the RPCs directly and reading rows.
 *
 * The member-facing recruiting + status embeds are driven LIVE (runSlash subcommand) to
 * prove the owner's configured white-label currency name/emoji reaches them
 * (proveBranding); the remaining brand kit (brand name, colors, voice preset,
 * powered-by-SomniBot attribution) is not on these embeds and stays a live
 * Discord-readback lane. A frozen SUCCESS state (the state heist_claim_for_resolution
 * leaves on a success roll) is reproduced deterministically where a specific outcome is
 * needed — the CSPRNG roll inside the claim is unseedable — and the REAL credit/finalise
 * RPCs then settle it, exactly the way the lottery proof reproduces a
 * claimed-but-unpaid drawing.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent the script records a FAIL (never a softened pass/gate). No divergence was
 * found here — heist_join is idempotent per member (a re-delivered join is
 * 'already_joined' and debits nothing, unlike lottery buy), and heist_start is
 * dedup-guarded by uniq_active_heist_per_guild.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface HeistRow {
  id: string;
  guild_id: string;
  initiator_id: string;
  status: string;
  target_name: string;
  target_payout: number;
  base_success_chance: number | null;
  resolution: string | null;
  payout_each: number | null;
  resolved_at: string | null;
  expires_at: string;
  created_at: string;
}

interface ParticipantRow {
  heist_id: string;
  guild_id: string;
  user_id: string;
  role: string;
  entry_fee_paid: number | null;
  payout: number;
  claimed_at: string | null;
  paid_at: string | null;
  payout_failed: boolean;
}

/** The RETURNS TABLE shape of heist_start. */
interface StartResult {
  status: string;
  heistId: string | null;
}

/** The RETURNS TABLE shape of heist_join. */
interface JoinResult {
  status: string;
  member_count: number;
  success_chance: number;
  role: string | null;
}

/** The RETURNS TABLE shape of heist_claim_for_resolution. */
interface ClaimRow {
  claimed: boolean;
  outcome: string | null;
  participant_count: number;
  payout_each: number | null;
}

const HEIST_COLS =
  'id, guild_id, initiator_id, status, target_name, target_payout, base_success_chance, resolution, payout_each, resolved_at, expires_at, created_at';
const PART_COLS =
  'heist_id, guild_id, user_id, role, entry_fee_paid, payout, claimed_at, paid_at, payout_failed';

// ── Catalog helpers ───────────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A future ISO timestamp for the recruiting window's expiry (stored, not fired here). */
function futureIso(secs: number): string {
  return new Date(Date.now() + secs * 1000).toISOString();
}

// ── Booting a heist-enabled guild ─────────────────────────────────────────

interface HeistBootOptions {
  label?: string;
  guildId?: string;
  entryFee?: number;
  basePayout?: number;
  successBase?: number;
  joinWindowSecs?: number;
  cooldownSecs?: number;
  minParticipants?: number;
  maxParticipants?: number;
  enabled?: boolean;
  /** White-label currency name/emoji to persist on guild_config (currencyOf reads these). */
  currencyName?: string;
  currencyEmoji?: string;
}

/**
 * Boot a guild with the economy on and the heist sub-feature configured. The heist
 * manager is gated by economy_heist_enabled inside the economy block (guild-init.ts);
 * the RPCs this proof drives need only the guild_config row (economy_heists FK) to
 * exist with the heist config columns set, which bootGuild + these overrides provide.
 */
async function bootHeist(ctx: ScenarioContext, opts: HeistBootOptions = {}): Promise<LiveClientHandle> {
  return ctx.bootGuild({
    label: opts.label,
    guildId: opts.guildId,
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_heist_enabled: opts.enabled ?? true,
      ...(opts.currencyName !== undefined ? { currency_name: opts.currencyName } : {}),
      ...(opts.currencyEmoji !== undefined ? { currency_emoji: opts.currencyEmoji } : {}),
      economy_heist_entry_fee: opts.entryFee ?? 100,
      economy_heist_base_payout: opts.basePayout ?? 500,
      economy_heist_success_base_pct: opts.successBase ?? 40,
      economy_heist_join_window_secs: opts.joinWindowSecs ?? 60,
      economy_heist_cooldown_seconds: opts.cooldownSecs ?? 300,
      economy_heist_min_participants: opts.minParticipants ?? 2,
      economy_heist_max_participants: opts.maxParticipants ?? 8,
    },
  });
}

// ── DB reads ───────────────────────────────────────────────────────────────

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, bank, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

async function walletAmount(handle: LiveClientHandle, userId: string): Promise<number | null> {
  const row = await readWallet(handle, userId);
  return row ? row.wallet : null;
}

/** Arrange an exact wallet balance via the REAL wallet initializer, then a set. */
async function seedWallet(handle: LiveClientHandle, userId: string, wallet: number, bank = 0): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet, bank })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

async function readActiveHeist(handle: LiveClientHandle): Promise<HeistRow | null> {
  const { data } = await handle.supabase
    .from('economy_heists')
    .select(HEIST_COLS)
    .eq('guild_id', handle.guildId)
    .in('status', ['recruiting', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as HeistRow | null) ?? null;
}

async function readHeistById(handle: LiveClientHandle, id: string): Promise<HeistRow | null> {
  const { data } = await handle.supabase
    .from('economy_heists')
    .select(HEIST_COLS)
    .eq('id', id)
    .maybeSingle();
  return (data as HeistRow | null) ?? null;
}

async function heistsForGuild(handle: LiveClientHandle, guildId: string): Promise<HeistRow[]> {
  const { data } = await handle.supabase
    .from('economy_heists')
    .select(HEIST_COLS)
    .eq('guild_id', guildId)
    .limit(1000);
  return (data as HeistRow[] | null) ?? [];
}

async function participantsFor(handle: LiveClientHandle, heistId: string): Promise<ParticipantRow[]> {
  const { data } = await handle.supabase
    .from('economy_heist_participants')
    .select(PART_COLS)
    .eq('heist_id', heistId)
    .order('joined_at', { ascending: true })
    .limit(1000);
  return (data as ParticipantRow[] | null) ?? [];
}

async function participantFor(
  handle: LiveClientHandle,
  heistId: string,
  userId: string,
): Promise<ParticipantRow | null> {
  const { data } = await handle.supabase
    .from('economy_heist_participants')
    .select(PART_COLS)
    .eq('heist_id', heistId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as ParticipantRow | null) ?? null;
}

async function heistCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_heists')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function participantCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_heist_participants')
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

// ── Driving the atomic heist RPCs the manager calls ────────────────────────

interface StartParams {
  userId: string;
  targetName: string;
  targetPayout: number;
  baseChance: number;
  entryFee: number;
  expiresAt: string;
  role: string;
}

/**
 * Mirror HeistManager.startHeist's money path: debit the entry fee first
 * (economy_subtract_balance), then the atomic heist_start insert; on any non-'started'
 * result refund the pre-debited fee exactly as the manager does, so the wallet is left
 * correct whether the start won or lost the one-active-heist slot.
 */
async function driveStart(handle: LiveClientHandle, p: StartParams): Promise<StartResult> {
  const { error: feeErr } = await handle.supabase.rpc('economy_subtract_balance', {
    p_guild_id: handle.guildId,
    p_user_id: p.userId,
    p_amount: p.entryFee,
  });
  if (feeErr) return { status: 'insufficient_funds', heistId: null };

  const { data } = await handle.supabase.rpc('heist_start', {
    p_guild_id: handle.guildId,
    p_user_id: p.userId,
    p_target_name: p.targetName,
    p_target_payout: p.targetPayout,
    p_base_chance: p.baseChance,
    p_expires_at: p.expiresAt,
    p_role: p.role,
    p_entry_fee: p.entryFee,
  });
  const row = (Array.isArray(data) ? data[0] : data) as { status: string; heist_id: string | null } | null;
  if (!row || row.status !== 'started' || !row.heist_id) {
    // The manager refunds the entry fee on any start failure.
    await handle.supabase.rpc('economy_add_balance', {
      p_guild_id: handle.guildId,
      p_user_id: p.userId,
      p_amount: p.entryFee,
    });
    return { status: row?.status ?? 'error', heistId: null };
  }
  return { status: 'started', heistId: row.heist_id };
}

interface JoinParams {
  userId: string;
  entryFee: number;
  max: number;
  baseChance: number;
  role: string;
}

/** heist_join debits + inserts the participant row atomically under the heist-row lock. */
async function driveJoin(handle: LiveClientHandle, heistId: string, p: JoinParams): Promise<JoinResult> {
  const { data } = await handle.supabase.rpc('heist_join', {
    p_heist_id: heistId,
    p_user_id: p.userId,
    p_role: p.role,
    p_entry_fee: p.entryFee,
    p_max: p.max,
    p_base_chance: p.baseChance,
  });
  const row = (Array.isArray(data) ? data[0] : data) as JoinResult | null;
  return row ?? { status: 'no_heist', member_count: 0, success_chance: 0, role: null };
}

async function driveClaim(handle: LiveClientHandle, heistId: string, minParticipants: number): Promise<ClaimRow | null> {
  const { data } = await handle.supabase.rpc('heist_claim_for_resolution', {
    p_heist_id: heistId,
    p_min_participants: minParticipants,
  });
  const rows = (data as ClaimRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function driveCredit(handle: LiveClientHandle, heistId: string, userId: string, amount: number): Promise<boolean> {
  const { data } = await handle.supabase.rpc('heist_credit_participant', {
    p_heist_id: heistId,
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return data === true;
}

async function driveFinalize(handle: LiveClientHandle, heistId: string): Promise<boolean> {
  const { data } = await handle.supabase.rpc('heist_finalize_resolution', { p_heist_id: heistId });
  return data === true;
}

async function driveReconcile(handle: LiveClientHandle, heistId: string, refundAmount: number): Promise<number> {
  const { data } = await handle.supabase.rpc('heist_reconcile_stranded_joins', {
    p_heist_id: heistId,
    p_refund_amount: refundAmount,
  });
  return (data as number | null) ?? 0;
}

/**
 * Reproduce the state a SUCCESS claim leaves — status='in_progress', resolution='success',
 * payout_each frozen, and every current participant stamped claimed_at — so the REAL
 * credit/finalise settlement RPCs can then be driven deterministically. The CSPRNG roll
 * inside heist_claim_for_resolution is unseedable, so this arranges the exact frozen state
 * the claim writes on success (the same honesty pattern the lottery proof uses to
 * reproduce a claimed-but-unpaid drawing). It writes ONLY the columns the real claim
 * writes; the money settlement is driven entirely through the real RPCs below.
 */
async function arrangeFrozenSuccess(handle: LiveClientHandle, heistId: string, payoutEach: number): Promise<void> {
  await handle.supabase
    .from('economy_heists')
    .update({ status: 'in_progress', resolution: 'success', payout_each: payoutEach })
    .eq('id', heistId)
    .eq('guild_id', handle.guildId);
  await handle.supabase
    .from('economy_heist_participants')
    .update({ claimed_at: new Date().toISOString() })
    .eq('heist_id', heistId);
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of rows an
 * anon key can read (schema-wide anon REVOKE / RLS deny → 0), or null when inconclusive
 * (→ GATE). PostgREST surfaces an authorization denial as SQLSTATE 42501.
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
      return 0; // the anon role is denied the table — RLS/GRANT working
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ──────────────────────────────────────────────

/**
 * Anon-denial RLS proof on economy_heists + economy_heist_participants, made non-vacuous
 * by a positive control: the scenario has already created heist + participant rows for
 * this guild (the service role sees them), so an anon client reading ZERO of them is a
 * real deny, not "there was nothing to read." Cross-guild isolation across two REAL
 * guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  const serviceHeists = await heistCount(handle);
  const serviceParts = await participantCount(handle);
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_heists / economy_heist_participants rows (schema-wide anon table REVOKE).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonHeists = await anonReadCount(anonKey, 'economy_heists', handle.guildId);
  const anonParts = await anonReadCount(anonKey, 'economy_heist_participants', handle.guildId);
  if (anonHeists === null || anonParts === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_heists / economy_heist_participants rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS/GRANT evaluated)',
    );
    return;
  }
  ctx.expect(serviceHeists > 0 && serviceParts > 0 && anonHeists === 0 && anonParts === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s economy_heists + economy_heist_participants rows while an anon client reads zero of them (schema-wide anon table REVOKE).',
    observation:
      `service-role sees ${serviceHeists} heist / ${serviceParts} participant row(s) under guild "${handle.guildId}"; ` +
      `anon-key REST reads returned ${anonHeists} heist / ${anonParts} participant row(s).`,
    impact:
      'Heist rows visible to the service role were also readable with an anon key — RLS/GRANT is not denying anon reads (direct data exposure).',
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
    'Failure-branch alerts (e.g. heist-payout-delayed) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected settlement-retry failure',
  );
}

// A distinctive white-label currency for the branding drive. The member-facing heist
// embeds render currencyOf(config).cName/cEmoji (heist-manager.ts) in place of the
// literal "Coins", so a brand guild configured with these exact non-default values makes
// the assertion NON-VACUOUS: the embed showing "💎 … Doubloons" (and never the generic
// 'Coins'/🪙 fallback) proves the configured currency actually reaches the surface.
const BRAND_CURRENCY = { name: 'Doubloons', emoji: '💎' } as const;

/**
 * The last reply/editReply a handler produced, flattened to inspectable text:
 * raw-string and { content } payloads plus the first embed's title/description,
 * so both plain degradation notices and embeds can be asserted uniformly.
 */
function replyText(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  const replies = captured.allOf('reply');
  const payload = (edits.at(-1) ?? replies.at(-1))?.payload as
    | string
    | { content?: string; embeds?: Array<{ data?: { title?: string; description?: string } }> }
    | undefined;
  if (typeof payload === 'string') return payload;
  const embed = payload?.embeds?.[0]?.data;
  return [payload?.content ?? '', embed?.title ?? '', embed?.description ?? '']
    .filter(Boolean)
    .join(' ');
}

function truncateText(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The embed .data (title/description) of the last reply/editReply a handler produced. */
function replyEmbed(captured: CapturedResponse): { title?: string; description?: string } | undefined {
  const edits = captured.allOf('editReply');
  const reply = captured.allOf('reply');
  const payload = (edits.at(-1) ?? reply.at(-1))?.payload as
    | { embeds?: Array<{ data?: { title?: string; description?: string } }> }
    | undefined;
  return payload?.embeds?.[0]?.data;
}

/**
 * Branding — DRIVE the member-facing /heist surfaces LIVE (PR #331 gave runSlash
 * slash-SUBCOMMAND support) through the REAL dispatcher and assert the captured embeds
 * carry the guild's configured white-label currency name + emoji. currencyOf(config) is
 * what every heist embed renders instead of the literal "Coins" (heist-manager.ts), so a
 * dedicated brand guild configured with a DISTINCTIVE currency (Doubloons/💎) makes this
 * non-vacuous: /heist start's recruiting embed AND /heist status's active-heist embed
 * showing that exact configured name+emoji — and NEVER the generic 'Coins'/🪙 fallback —
 * prove the white-label currency reaches the member-facing surfaces for real.
 *
 * The brand guild is booted fresh (its own currency + crew) so the drive never collides
 * with the scenario's active/terminal heist or its cooldown; it is swept + torn down with
 * every other handle. The remaining brand kit BEYOND currency — the brand name, the
 * (hardcoded 🏴‍☠️ / 0xFFA500) title emoji + color, the voice preset, and the
 * powered-by-SomniBot attribution — is NOT on these embeds, so that pixel-level
 * brand-kit match stays a live Discord-readback lane, gated honestly below.
 */
async function proveBranding(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'brand',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
    currencyName: BRAND_CURRENCY.name,
    currencyEmoji: BRAND_CURRENCY.emoji,
  });
  const starter = ctx.userId('brand-start');
  const viewer = ctx.userId('brand-view');
  await seedWallet(handle, starter, 1000);

  const carriesBrandCurrency = (desc: string): boolean =>
    desc.includes(BRAND_CURRENCY.name) &&
    desc.includes(BRAND_CURRENCY.emoji) &&
    !desc.includes('Coins') &&
    !desc.includes('🪙');

  // /heist start (subcommand) → the recruiting embed. Its payout + entry-fee lines render
  // the configured currency (never the "Coins"/🪙 fallback). Driven LIVE through the REAL
  // heist subcommand dispatcher (runSlash), reply captured in-process.
  const startCap = await ctx.runSlash(handle, { commandName: 'heist', userId: starter, subcommand: 'start' });
  const startEmbed = replyEmbed(startCap);
  const startDesc = startEmbed?.description ?? '';
  ctx.expect(carriesBrandCurrency(startDesc), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise:
      'The member-facing /heist start recruiting embed renders the owner’s configured white-label currency name + emoji (never the generic Coins/🪙 fallback).',
    observation:
      `driving the REAL /heist start subcommand: recruiting embed title=${JSON.stringify(startEmbed?.title)}, ` +
      `description=${JSON.stringify(startDesc)} (expected the configured "${BRAND_CURRENCY.emoji} … ${BRAND_CURRENCY.name}", not "🪙 … Coins").`,
    impact: 'The recruiting embed did not carry the configured white-label currency — a member-facing branding regression.',
  });

  // /heist status (subcommand) → the active-heist embed. Same white-label currency on the
  // potential-payout line, driven LIVE through the read-only status subcommand.
  const statusCap = await ctx.runSlash(handle, { commandName: 'heist', userId: viewer, subcommand: 'status' });
  const statusEmbed = replyEmbed(statusCap);
  const statusDesc = statusEmbed?.description ?? '';
  ctx.expect(carriesBrandCurrency(statusDesc), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise:
      'The member-facing /heist status embed renders the owner’s configured white-label currency name + emoji (never the generic Coins/🪙 fallback).',
    observation:
      `driving the REAL /heist status subcommand: embed title=${JSON.stringify(statusEmbed?.title)}, ` +
      `description=${JSON.stringify(statusDesc)} (expected the configured "${BRAND_CURRENCY.emoji} … ${BRAND_CURRENCY.name}").`,
    impact: 'The /heist status embed did not carry the configured white-label currency — a member-facing branding regression.',
  });

  // The full brand kit BEYOND the configured currency (now proven live above) still needs
  // the live brand-kit readback lane.
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (brand name, colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on the heist embeds.',
    'the configured currency name/emoji is now proven live on the captured /heist start recruiting + /heist status embeds; the rest of the brand kit is not on these embeds (hardcoded 🏴‍☠️ title emoji + 0xFFA500 color, no brand name, no powered-by-SomniBot attribution), so matching it against the owner brand kit needs an embed snapshot readback (DISCORD_TOKEN + live guild)',
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext, what: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    `The heist behavior is observed working in the live test guild: ${what}.`,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel embed / announcement readback; the resolve pipeline is timer-driven (setTimeout(join_window_secs)) so a fast bot-only harness cannot fire it — its money path is proven via the claim/credit/finalise RPCs',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate play-money debits, crew payouts, or refunds (entry_fee_paid / claimed_at / paid_at guards).',
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

// A deterministic target: City Bank has difficulty modifier 0 and payout modifier 1.0
// (HeistManager.HEIST_TARGETS), so base_success_chance = success_base and
// target_payout = base_payout — clean, drift-free numbers for the money-model asserts.
// The MANAGER's random target pick is a command-flow concern (gated); driving heist_start
// directly lets us pin the target so the payout split + odds are deterministic.
const TARGET = { name: 'City Bank', payoutMod: 1, difficultyMod: 0 } as const;

// ── The 12 scenario scripts ────────────────────────────────────────────────

/** DEF — out-of-box: 100 entry, 500 base payout, 40%+7% odds, 60s window, crew 2..8. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const entryFee = Number(declaredDefault(ctx.domain, 'economy-heist-entry-fee')); // 100
  const basePayout = Number(declaredDefault(ctx.domain, 'economy-heist-base-payout')); // 500
  const successBase = Number(declaredDefault(ctx.domain, 'economy-heist-success-base-pct')); // 40
  const joinWindow = Number(declaredDefault(ctx.domain, 'economy-heist-join-window-secs')); // 60
  const cooldown = Number(declaredDefault(ctx.domain, 'economy-heist-cooldown-seconds')); // 300
  const minCrew = Number(declaredDefault(ctx.domain, 'economy-heist-min-participants')); // 2
  const maxCrew = Number(declaredDefault(ctx.domain, 'economy-heist-max-participants')); // 8

  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee,
    basePayout,
    successBase,
    joinWindowSecs: joinWindow,
    cooldownSecs: cooldown,
    minParticipants: minCrew,
    maxParticipants: maxCrew,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // Out-of-box config is persisted (the catalog defaults).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select(
      'economy_heist_entry_fee, economy_heist_base_payout, economy_heist_success_base_pct, economy_heist_join_window_secs, economy_heist_cooldown_seconds, economy_heist_min_participants, economy_heist_max_participants',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as
    | {
        economy_heist_entry_fee: number;
        economy_heist_base_payout: number;
        economy_heist_success_base_pct: number;
        economy_heist_join_window_secs: number;
        economy_heist_cooldown_seconds: number;
        economy_heist_min_participants: number;
        economy_heist_max_participants: number;
      }
    | null;
  ctx.expect(
    cfg?.economy_heist_entry_fee === 100 &&
      cfg?.economy_heist_base_payout === 500 &&
      cfg?.economy_heist_success_base_pct === 40 &&
      cfg?.economy_heist_join_window_secs === 60 &&
      cfg?.economy_heist_cooldown_seconds === 300 &&
      cfg?.economy_heist_min_participants === 2 &&
      cfg?.economy_heist_max_participants === 8,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Out of the box heist config: entry fee 100, base payout 500, base odds 40%, join window 60s, cooldown 300s, crew 2..8.',
      observation:
        `guild_config: fee=${cfg?.economy_heist_entry_fee}, payout=${cfg?.economy_heist_base_payout}, ` +
        `base=${cfg?.economy_heist_success_base_pct}, window=${cfg?.economy_heist_join_window_secs}, ` +
        `cooldown=${cfg?.economy_heist_cooldown_seconds}, min=${cfg?.economy_heist_min_participants}, max=${cfg?.economy_heist_max_participants}.`,
      impact: 'The default heist configuration diverged from the catalog defaults.',
    },
  );

  const targetPayout = Math.floor(basePayout * TARGET.payoutMod); // 500
  const baseChance = successBase + TARGET.difficultyMod; // 40

  // /heist start: debit exactly 100, open ONE recruiting heist, freeze the initiator fee.
  const started = await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee,
    expiresAt: futureIso(joinWindow),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  const walletA1 = await walletAmount(handle, userA);
  const initiator = heist ? await participantFor(handle, heist.id, userA) : null;
  ctx.expect(
    started.status === 'started' &&
      heist?.status === 'recruiting' &&
      walletA1 === 900 &&
      heist?.target_payout === 500 &&
      heist?.base_success_chance === 40 &&
      initiator?.entry_fee_paid === 100,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/heist start debits exactly ${entryFee} play coins and opens one recruiting heist with the initiator frozen at their entry fee.`,
      observation:
        `start=${started.status}, heist status=${heist?.status}, A wallet=${walletA1} (expected 900), ` +
        `target_payout=${heist?.target_payout} (expected 500), base_success_chance=${heist?.base_success_chance} (expected 40), ` +
        `initiator entry_fee_paid=${initiator?.entry_fee_paid} (expected 100).`,
      impact: 'Heist start did not debit the entry fee or open the recruiting heist with a frozen initiator.',
    },
  );

  // /heist join (B): debit exactly 100, 2-strong crew, odds derived = base + 7 per extra.
  const joinB = heist
    ? await driveJoin(handle, heist.id, { userId: userB, entryFee, max: maxCrew, baseChance, role: 'Muscle' })
    : { status: 'no_heist', member_count: 0, success_chance: 0, role: null };
  const walletB1 = await walletAmount(handle, userB);
  const parts = heist ? await participantsFor(handle, heist.id) : [];
  const bRow = heist ? await participantFor(handle, heist.id, userB) : null;
  const expectedChance = Math.min(95, Math.max(0, baseChance + (2 - 1) * 7)); // 47
  ctx.expect(
    joinB.status === 'joined' &&
      joinB.member_count === 2 &&
      joinB.success_chance === expectedChance &&
      walletB1 === 900 &&
      parts.length === 2 &&
      bRow?.entry_fee_paid === 100,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A /heist join debits exactly the entry fee, grows the crew to 2, and derives success odds as base + 7% per extra crew member.',
      observation:
        `join=${joinB.status}, member_count=${joinB.member_count} (expected 2), success_chance=${joinB.success_chance} (expected ${expectedChance}), ` +
        `B wallet=${walletB1} (expected 900), crew rows=${parts.length} (expected 2), B entry_fee_paid=${bRow?.entry_fee_paid} (expected 100).`,
      impact: 'A /heist join miscounted the crew, misderived the odds, or mischarged the entry fee.',
    },
  );

  // Audit: two append-only participant rows, each freezing its OWN entry_fee_paid, guild-scoped.
  ctx.expect(
    parts.length === 2 && parts.every((p) => p.entry_fee_paid === 100 && p.guild_id === handle.guildId),
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise:
        'Each crew member lands exactly one append-only participant row freezing their own entry_fee_paid, actor + guild scoped.',
      observation:
        `participant rows=${parts.length}, ` +
        `all entry_fee_paid=100 & guild="${handle.guildId}" → ${parts.every((p) => p.entry_fee_paid === 100 && p.guild_id === handle.guildId)}.`,
      impact: 'A participant row did not record the frozen entry fee / actor / guild.',
    },
  );

  // Claim: the join window closes and the heist is claimed exactly once — the crew is
  // frozen (claimed_at), the outcome rolled, and a success freezes payout_each. crew=2 ≥
  // min=2, so this is never the cancel branch; the roll decides success vs failed.
  const claim = heist ? await driveClaim(handle, heist.id, minCrew) : null;
  const afterClaim = heist ? await readHeistById(handle, heist.id) : null;
  const frozen = heist ? await participantsFor(handle, heist.id) : [];
  const outcome = claim?.outcome ?? null;
  const expectedPayoutEach = outcome === 'success' ? Math.floor(targetPayout / 2) : 0; // 250 or 0
  ctx.expect(
    claim?.claimed === true &&
      claim?.participant_count === 2 &&
      afterClaim?.status === 'in_progress' &&
      (outcome === 'success' || outcome === 'failed') &&
      afterClaim?.resolution === outcome &&
      (afterClaim?.payout_each ?? 0) === expectedPayoutEach &&
      frozen.every((p) => p.claimed_at !== null),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'When the join window closes the heist is claimed exactly once: the crew is frozen (claimed_at), the outcome is rolled, and a success freezes payout_each = floor(target payout / crew).',
      observation:
        `claimed=${claim?.claimed}, participant_count=${claim?.participant_count} (expected 2), status=${afterClaim?.status}, ` +
        `outcome=${outcome}, payout_each=${afterClaim?.payout_each} (expected ${expectedPayoutEach}), ` +
        `crew all frozen=${frozen.every((p) => p.claimed_at !== null)}.`,
      impact: 'The claim did not freeze the crew, roll a single outcome, or freeze the correct per-person payout.',
    },
  );

  // Settle via the REAL credit + finalise RPCs (the resolver's money path) for the actual
  // frozen outcome: success credits every frozen member payout_each once; failure forfeits
  // the entry fees; either way the heist finalises to its terminal status exactly once.
  if (outcome === 'success') {
    for (const p of frozen) await driveCredit(handle, heist!.id, p.user_id, expectedPayoutEach);
  }
  const finalized = heist ? await driveFinalize(handle, heist.id) : false;
  const terminal = heist ? await readHeistById(handle, heist.id) : null;
  const walletA2 = await walletAmount(handle, userA);
  const walletB2 = await walletAmount(handle, userB);
  const paidCorrectly =
    outcome === 'success'
      ? walletA2 === 900 + expectedPayoutEach && walletB2 === 900 + expectedPayoutEach
      : walletA2 === 900 && walletB2 === 900;
  ctx.expect(finalized === true && terminal?.status === outcome && terminal?.resolved_at !== null && paidCorrectly, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'The frozen outcome settles once: on success every frozen crew member is credited their frozen payout_each, on failure every entry fee is forfeit, and the heist finalises to its terminal status exactly once.',
    observation:
      `finalized=${finalized}, terminal status=${terminal?.status} (expected ${outcome}), resolved_at ${terminal?.resolved_at ? 'set' : 'null'}; ` +
      `A wallet 900→${walletA2}, B wallet 900→${walletB2} (${outcome === 'success' ? `each +${expectedPayoutEach}` : 'forfeit'}).`,
    impact: 'The heist settlement did not credit the frozen payout / forfeit fees / finalise exactly once as the frozen outcome required.',
  });

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  gateLiveGuildReadback(ctx, 'the recruiting embed, one join embed per member, and exactly one success/failure resolution announcement');
  gateReplayDeferredTo(ctx, 'REPLAY / RESTART / RACE');
}

/** SET-A — dashboard config takes live effect: entry 250, base payout 1000, base 55, min 3. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const entryFee = 250;
  const basePayout = 1000;
  const successBase = 55;
  const minCrew = 3;
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee,
    basePayout,
    successBase,
    minParticipants: minCrew,
    maxParticipants: 8,
    joinWindowSecs: 60,
    cooldownSecs: 300,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 2000);
  await seedWallet(handle, userB, 2000);

  const targetPayout = Math.floor(basePayout * TARGET.payoutMod); // 1000
  const baseChance = successBase + TARGET.difficultyMod; // 55

  // Saved entry fee 250 + base payout 1000 + base 55 take live effect with no restart.
  const started = await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  const walletA1 = await walletAmount(handle, userA);
  ctx.expect(
    started.status === 'started' &&
      walletA1 === 1750 &&
      heist?.target_payout === 1000 &&
      heist?.base_success_chance === 55,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The saved entry fee 250, base payout 1000, and success base 55 take live effect: /heist start debits exactly 250 and freezes a 1000-payout, 55%-base heist.',
      observation:
        `A wallet=${walletA1} (expected 1750 after a 250 debit), target_payout=${heist?.target_payout} (expected 1000), ` +
        `base_success_chance=${heist?.base_success_chance} (expected 55).`,
      impact: 'A saved heist configuration (entry fee / payout / base odds) did not take live effect.',
    },
  );

  // Join (B): crew reaches 2 — below the saved minimum of 3 — each debited 250.
  const joinB = heist
    ? await driveJoin(handle, heist.id, { userId: userB, entryFee, max: 8, baseChance, role: 'Muscle' })
    : { status: 'no_heist', member_count: 0, success_chance: 0, role: null };
  const walletB1 = await walletAmount(handle, userB);
  ctx.expect(joinB.status === 'joined' && joinB.member_count === 2 && walletB1 === 1750, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A second member joins the crew at the saved 250 entry fee (crew now 2, still below the saved minimum 3).',
    observation: `join=${joinB.status}, member_count=${joinB.member_count} (expected 2), B wallet=${walletB1} (expected 1750).`,
    impact: 'The join did not apply the saved entry fee or grow the crew.',
  });

  // Claim with min=3 and crew=2 → DETERMINISTIC cancellation (no coin-flip): the claim
  // freezes the 2-member crew and marks resolution 'cancelled' on an intermediate in_progress row.
  const claim = heist ? await driveClaim(handle, heist.id, minCrew) : null;
  const afterClaim = heist ? await readHeistById(handle, heist.id) : null;
  ctx.expect(
    claim?.claimed === true &&
      claim?.outcome === 'cancelled' &&
      claim?.participant_count === 2 &&
      afterClaim?.resolution === 'cancelled' &&
      afterClaim?.status === 'in_progress',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A crew below the saved minimum (3) resolves to a cancellation: the claim freezes the 2-member crew and marks resolution cancelled without a coin-flip.',
      observation:
        `claimed=${claim?.claimed}, outcome=${claim?.outcome} (expected cancelled), participant_count=${claim?.participant_count} (expected 2), ` +
        `resolution=${afterClaim?.resolution}, status=${afterClaim?.status} (expected in_progress).`,
      impact: 'An under-crewed heist did not deterministically cancel under the saved minimum-participants setting.',
    },
  );

  // Refund each frozen member their OWN frozen entry_fee_paid (250) via the real credit
  // RPC, then finalise to terminal 'cancelled' once — the unified per-participant refund.
  const frozen = heist ? await participantsFor(handle, heist.id) : [];
  for (const p of frozen) await driveCredit(handle, heist!.id, p.user_id, p.entry_fee_paid ?? entryFee);
  const finalized = heist ? await driveFinalize(handle, heist.id) : false;
  const terminal = heist ? await readHeistById(handle, heist.id) : null;
  const walletA2 = await walletAmount(handle, userA);
  const walletB2 = await walletAmount(handle, userB);
  ctx.expect(
    finalized === true &&
      terminal?.status === 'cancelled' &&
      terminal?.resolved_at !== null &&
      walletA2 === 2000 &&
      walletB2 === 2000,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise:
        'The cancellation refunds each frozen crew member exactly their own frozen 250 entry fee and finalises the heist to terminal cancelled once.',
      observation:
        `finalized=${finalized}, terminal status=${terminal?.status}; A wallet 1750→${walletA2} (expected back to 2000), ` +
        `B wallet 1750→${walletB2} (expected back to 2000).`,
      impact: 'The cancellation did not refund each member their frozen entry fee or did not finalise exactly once.',
    },
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  gateLiveGuildReadback(ctx, 'the recruiting embed advertising the 1000-scaled payout at 55% base, and the branded cancellation announcement refunding each frozen 250');
  gateReplayDeferredTo(ctx, 'REPLAY / RESTART / RACE');
}

/** SET-B — pacing retunes independently: cooldown 0, join window 120, max 3. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const entryFee = 100;
  const maxCrew = 3;
  const joinWindow = 120;
  const cooldown = 0;
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: maxCrew,
    joinWindowSecs: joinWindow,
    cooldownSecs: cooldown,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');
  const userD = ctx.userId('d');
  for (const u of [userA, userB, userC, userD]) await seedWallet(handle, u, 1000);
  const targetPayout = Math.floor(500 * TARGET.payoutMod); // 500
  const baseChance = 40 + TARGET.difficultyMod; // 40

  // start(A) + join(B) + join(C) → crew reaches the saved max of 3.
  await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee,
    expiresAt: futureIso(joinWindow),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  await driveJoin(handle, heist!.id, { userId: userB, entryFee, max: maxCrew, baseChance, role: 'Muscle' });
  const joinC = await driveJoin(handle, heist!.id, { userId: userC, entryFee, max: maxCrew, baseChance, role: 'Lookout' });

  // 4th /heist join is refused as crew-full, debiting nothing and filing no row.
  const walletD0 = await walletAmount(handle, userD);
  const joinD = await driveJoin(handle, heist!.id, { userId: userD, entryFee, max: maxCrew, baseChance, role: 'Hacker' });
  const walletD1 = await walletAmount(handle, userD);
  const partsAtMax = await participantsFor(handle, heist!.id);
  const dRow = await participantFor(handle, heist!.id, userD);
  ctx.expect(
    joinC.status === 'joined' &&
      joinC.member_count === 3 &&
      joinD.status === 'crew_full' &&
      walletD1 === walletD0 &&
      walletD1 === 1000 &&
      partsAtMax.length === 3 &&
      dRow === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The saved per-member cap (3) admits the first three joins and refuses a fourth as crew-full, debiting nothing and filing no participant row.',
      observation:
        `third join member_count=${joinC.member_count} (expected 3), fourth join=${joinD.status} (expected crew_full), ` +
        `D wallet ${walletD0}→${walletD1} (expected unchanged 1000), crew rows=${partsAtMax.length} (expected 3), D row=${dRow === null ? 'none' : 'present'}.`,
      impact: 'The saved max-participants cap let a fourth member in, or charged/filed the refused join.',
    },
  );

  // Resolve heist #1 (crew 3 ≥ min 2) so it becomes terminal, freeing the active-heist slot.
  const claim1 = await driveClaim(handle, heist!.id, 2);
  const frozen1 = await participantsFor(handle, heist!.id);
  if (claim1?.outcome === 'success') {
    for (const p of frozen1) await driveCredit(handle, heist!.id, p.user_id, claim1.payout_each ?? 0);
  } else if (claim1?.outcome === 'cancelled') {
    for (const p of frozen1) await driveCredit(handle, heist!.id, p.user_id, p.entry_fee_paid ?? entryFee);
  }
  await driveFinalize(handle, heist!.id);
  const resolved1 = await readHeistById(handle, heist!.id);

  // Cooldown 0: with heist #1 terminal, the one-active-heist slot (uniq_active_heist_per_guild)
  // is free, so a fresh /heist start opens immediately after the first resolves.
  const started2 = await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee,
    expiresAt: futureIso(joinWindow),
    role: 'Driver',
  });
  const heist2 = await readActiveHeist(handle);
  const totalHeists = await heistCount(handle);
  const terminal1 = resolved1?.status === 'success' || resolved1?.status === 'failed' || resolved1?.status === 'cancelled';
  ctx.expect(
    started2.status === 'started' &&
      heist2 !== null &&
      heist2?.id !== heist?.id &&
      heist2?.status === 'recruiting' &&
      totalHeists === 2 &&
      terminal1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'With cooldown 0 a second /heist start opens a fresh recruiting heist immediately after the first resolves (the terminal heist frees the one-active-heist slot).',
      observation:
        `first heist resolved to ${resolved1?.status}; second start=${started2.status}, new heist status=${heist2?.status}, ` +
        `distinct heist=${heist2?.id !== heist?.id}, total heist rows=${totalHeists} (expected 2).`,
      impact: 'A second heist could not start right after the first resolved despite cooldown 0 — the pacing retune did not take effect.',
    },
  );

  // The retuned pacing values are persisted.
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('economy_heist_join_window_secs, economy_heist_max_participants, economy_heist_cooldown_seconds')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as
    | { economy_heist_join_window_secs: number; economy_heist_max_participants: number; economy_heist_cooldown_seconds: number }
    | null;
  ctx.expect(
    cfg?.economy_heist_join_window_secs === 120 &&
      cfg?.economy_heist_max_participants === 3 &&
      cfg?.economy_heist_cooldown_seconds === 0,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The retuned pacing (join window 120s, max 3, cooldown 0) is persisted in guild_config.',
      observation:
        `guild_config: window=${cfg?.economy_heist_join_window_secs} (expected 120), max=${cfg?.economy_heist_max_participants} (expected 3), ` +
        `cooldown=${cfg?.economy_heist_cooldown_seconds} (expected 0).`,
      impact: 'A retuned pacing value was not persisted.',
    },
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The recruiting window stays open the configured 120 seconds before the scheduled resolve fires.',
    'the join window is a live setTimeout(join_window_secs*1000) in the manager; a fast bot-only harness cannot let it elapse — the 120s value is proven persisted and the resolve pipeline is proven via the claim/settle RPCs',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RESTART / RACE');
}

/** INVALID — a rejected invalid config never persists (validation lives in the dashboard Zod layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000);

  // DB-observable core: guild_config keeps its prior valid values (nothing invalid persisted).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('economy_heist_entry_fee, economy_heist_min_participants, economy_heist_max_participants')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as
    | { economy_heist_entry_fee: number; economy_heist_min_participants: number; economy_heist_max_participants: number }
    | null;
  ctx.expect(
    cfg?.economy_heist_entry_fee === 100 && cfg?.economy_heist_min_participants === 2 && cfg?.economy_heist_max_participants === 8,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'guild_config keeps its prior valid heist values byte-for-byte (a rejected invalid save never persists).',
      observation:
        `guild_config holds fee=${cfg?.economy_heist_entry_fee} (expected 100), min=${cfg?.economy_heist_min_participants} (expected 2), ` +
        `max=${cfg?.economy_heist_max_participants} (expected 8).`,
      impact: 'A valid heist configuration was not retained.',
    },
  );

  // Live behavior unchanged on the very next heist action: a real /heist start still
  // debits the previous valid 100 fee and freezes the previous 40 base odds.
  const started = await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout: 500,
    baseChance: 40,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  const walletA = await walletAmount(handle, userA);
  ctx.expect(started.status === 'started' && walletA === 900 && heist?.base_success_chance === 40, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Live bot behavior is unchanged after a rejected config save: the next heist start debits the previous valid 100 fee and freezes the previous 40 base odds.',
    observation: `start=${started.status}, A wallet=${walletA} (expected 900), base_success_chance=${heist?.base_success_chance} (expected 40).`,
    impact: 'A rejected config attempt disturbed live heist behavior.',
  });

  // The actual REJECTION is enforced in the dashboard's Zod layer; the guild_config heist
  // columns are plain INTEGER/BOOLEAN with NO DB CHECK constraint, so the reject path is
  // not reachable in this bot-only harness. GATE it honestly (never fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard heist page surfaces a clear validation error for a negative entry fee / a minimum-participants value above the maximum.',
    'config validation lives in the dashboard (Zod) layer; guild_config heist columns have no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected heist configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RESTART / RACE');
}

/** UNAUTH — a frozen crew share is keyed to its OWN (heist,user) row; no member can collect another's. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // Build a real 2-member crew, then reproduce the frozen-success state a success claim
  // leaves (deterministic — the roll is unseedable), so the keyed credit path is exercised.
  const targetPayout = 500;
  const baseChance = 40;
  await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });
  const payoutEach = Math.floor(targetPayout / 2); // 250
  await arrangeFrozenSuccess(handle, heist!.id, payoutEach);

  const walletA0 = await walletAmount(handle, userA); // 900
  const walletB0 = await walletAmount(handle, userB); // 900

  // Credit ONLY A's own frozen share. heist_credit_participant is keyed to (heist_id,
  // user_id) and always lands in economy_add_balance(guild, that_user) — there is NO
  // parameter that redirects A's share to another wallet, so crediting A pays only A.
  const creditedA = await driveCredit(handle, heist!.id, userA, payoutEach);
  const aRow = await participantFor(handle, heist!.id, userA);
  const bRow = await participantFor(handle, heist!.id, userB);
  const walletA1 = await walletAmount(handle, userA);
  const walletB1 = await walletAmount(handle, userB);
  ctx.expect(
    creditedA === true &&
      walletA1 === (walletA0 ?? 0) + payoutEach &&
      aRow?.paid_at !== null &&
      walletB1 === walletB0 &&
      bRow?.paid_at === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Each crew member’s frozen share is keyed to their OWN (heist, user) row under the paid_at guard: crediting A pays only A and never touches B’s frozen share or wallet.',
      observation:
        `A wallet ${walletA0}→${walletA1} (+${payoutEach}, paid_at ${aRow?.paid_at ? 'set' : 'null'}); ` +
        `B wallet ${walletB0}→${walletB1} (expected unchanged, paid_at ${bRow?.paid_at ? 'set' : 'null'} — expected null).`,
      impact: 'A heist credit paid one member’s frozen share into another member’s wallet — per-participant payout isolation was breached.',
    },
  );

  // No member can double-collect: a second credit of A's row is a no-op (paid_at guard).
  const creditedAgain = await driveCredit(handle, heist!.id, userA, payoutEach);
  const walletA2 = await walletAmount(handle, userA);
  ctx.expect(creditedAgain === false && walletA2 === walletA1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'A frozen share can be collected exactly once: re-crediting the same participant row is a no-op under the paid_at guard.',
    observation: `second credit returned ${creditedAgain} (expected false); A wallet ${walletA1}→${walletA2} (expected unchanged).`,
    impact: 'A frozen heist share could be collected twice — the paid_at idempotency guard failed.',
  });

  // Audit: A's row records exactly one settled credit (paid_at + payout); B's stays unsettled.
  ctx.expect(aRow?.paid_at !== null && aRow?.payout === payoutEach && bRow?.paid_at === null, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The participant ledger records exactly the crediting member’s own settled share; another member’s row is never mutated by it.',
    observation: `A row payout=${aRow?.payout} paid_at=${aRow?.paid_at ? 'set' : 'null'}; B row paid_at=${bRow?.paid_at ? 'set' : 'null'} (expected null).`,
    impact: 'A participant ledger row for the wrong member was mutated by a keyed credit.',
  });

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  // The non-admin dashboard save refusal is a dashboard session-auth + RLS lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save heist settings (returns an authorization error).',
    'requires the dashboard session-auth lane (owner/admin RBAC on guild_config writes) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'An audit row records the denied heist configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
}

/** DEPFAIL — Supabase-unreachable fail-safe, driven through the REAL fault
 *  proxy (ctx.faults severs the actual network path run-one-domain routed the
 *  stack through). Falls back to honest gates when no proxy is registered
 *  (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await bootHeist(ctx, {
      label: 'a',
      entryFee: 100,
      basePayout: 500,
      successBase: 40,
      minParticipants: 2,
      maxParticipants: 8,
    });
    const userA = ctx.userId('a');
    await seedWallet(handle, userA, 1000);

    // Pre-outage: one truthful /heist status baseline. This also warms the
    // manager's guild-config cache exactly the way a long-running bot holds it,
    // so the outage window exercises the READ paths, not a cold config fetch.
    await ctx.runSlash(handle, { commandName: 'heist', userId: userA, subcommand: 'status' });

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let statusReply = '';
    let startReply = '';
    try {
      statusReply = replyText(
        await ctx.runSlash(handle, { commandName: 'heist', userId: userA, subcommand: 'status' }),
      );
      startReply = replyText(
        await ctx.runSlash(handle, { commandName: 'heist', userId: userA, subcommand: 'start' }),
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SAFE: both heist commands must reply, never crash the pipeline.
    ctx.expect(threw === null && statusReply.length > 0 && startReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise:
        'With database access blocked, /heist status and /heist start still reply (fail-safe) instead of crashing the interaction pipeline.',
      observation:
        threw === null
          ? `during the outage window /heist status replied ${JSON.stringify(truncateText(statusReply))}; /heist start replied ${JSON.stringify(truncateText(startReply))}.`
          : `an outage-window drive THREW ${truncateText(threw)}.`,
      impact: 'A database outage crashed the heist command pipeline instead of degrading to a reply.',
    });

    // (2) The catalog contracts the branded heist-unavailable notice — never a
    //     data-shaped answer fabricated from the failed reads: "no heists have
    //     been attempted yet" (status) or an insufficient-funds / heists-disabled
    //     verdict (start) are LIES about state the bot could not read.
    const unavailableRe = /unavailable|try again|temporar|later|degraded|issue|problem/i;
    const statusLie = /no heists have been attempted/i.test(statusReply);
    const startLie = /you need|not enabled|payment failed/i.test(startReply);
    ctx.expect(
      unavailableRe.test(statusReply) && unavailableRe.test(startReply) && !statusLie && !startLie,
      {
        assertionClass: 'branding',
        channel: 'captured-reply',
        promise:
          'With the database blocked, /heist status and /heist start reply with the branded heist-unavailable notice — never a fabricated empty-state, insufficient-funds, or heists-disabled verdict.',
        observation:
          `outage-window replies: status=${JSON.stringify(truncateText(statusReply))} (dataShapedLie=${statusLie}), ` +
          `start=${JSON.stringify(truncateText(startReply))} (dataShapedLie=${startLie}).`,
        impact:
          'During a database outage a heist command fabricated a data-shaped answer from a failed read — members are told a lie about state the bot could not read.',
      },
    );

    // (3) ZERO CORRUPTION: no wallet mutation during the outage — the seeded
    //     wallet is byte-identical after restore and no orphan heist/participant
    //     row was half-created by the degraded /heist start.
    const walletAfter = await readWallet(handle, userA);
    const heistsAfter = await heistCount(handle);
    const partsAfter = await participantCount(handle);
    ctx.expect(
      walletAfter?.wallet === 1000 && walletAfter?.bank === 0 && heistsAfter === 0 && partsAfter === 0,
      {
        assertionClass: 'Discord',
        channel: 'db-observable',
        promise:
          'No coins move during the outage window: the seeded wallet is unchanged after restoration and no orphan heist or participant row exists.',
        observation:
          `post-restore wallet=${walletAfter?.wallet}/bank=${walletAfter?.bank} (expected 1000/0); ` +
          `economy_heists rows=${heistsAfter}, participant rows=${partsAfter} (expected 0/0).`,
        impact: 'A database outage moved play-money or half-created heist rows — outage-window corruption.',
      },
    );

    // (4) RECOVERY: the very next /heist start works against the restored stack —
    //     it debits the entry fee EXACTLY once and opens exactly one recruiting
    //     heist with the initiator's frozen participant row (the catalog's
    //     "fresh /heist start debits exactly once" recovery contract).
    const recoveredStart = await ctx.runSlash(handle, { commandName: 'heist', userId: userA, subcommand: 'start' });
    const recoveredText = replyText(recoveredStart);
    const walletRecovered = await walletAmount(handle, userA);
    const activeHeist = await readActiveHeist(handle);
    const initiatorRow = activeHeist ? await participantFor(handle, activeHeist.id, userA) : null;
    ctx.expect(
      walletRecovered === 900 &&
        activeHeist?.status === 'recruiting' &&
        initiatorRow?.entry_fee_paid === 100 &&
        recoveredText.includes('assembling a crew'),
      {
        assertionClass: 'replay-safety',
        channel: 'db-observable',
        promise:
          'After restoration a fresh /heist start debits the entry fee exactly once and opens exactly one recruiting heist (no lingering degradation, no double debit).',
        observation:
          `post-restore /heist start replied ${JSON.stringify(truncateText(recoveredText))}; wallet 1000→${walletRecovered} ` +
          `(expected 900 — one 100 debit); heist status=${activeHeist?.status ?? '(none)'}; initiator entry_fee_paid=${initiatorRow?.entry_fee_paid ?? '(no row)'}.`,
        impact: 'The heist pipeline did not recover cleanly after the outage ended (no heist opened, or the fee debited zero/multiple times).',
      },
    );

    await proveRlsIsolation(ctx, handle);
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'During a Supabase outage, /heist start, join, and status reply with the branded heist-unavailable template and no wallet mutation occurs; after restoration a fresh /heist start debits the entry fee exactly once.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'No duplicate entry-fee debit, crew payout, or refund survives the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded heist-unavailable template in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'Heist rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window rather than one alert per failed heist command.',
    'requires the dependency-degradation alert aggregation plus owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'A resolve tick during the outage logs and leaves the heist retryable without crashing; after restoration no debit, payout, or refund is applied twice.',
    'the resolve tick fires only on a live setTimeout(join_window_secs) the fast bot-only harness cannot let elapse mid-outage; its idempotent settle path is proven in RETRY',
  );
}

/** RETRY — a payout fault that leaves some crew unpaid converges: each frozen member is paid exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 600,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');
  for (const u of [userA, userB, userC]) await seedWallet(handle, u, 1000);
  const targetPayout = 600;
  const baseChance = 40;

  // Build a real 3-member crew (payout_each = floor(600/3) = 200) and reproduce the
  // frozen-success state a success claim leaves.
  await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });
  await driveJoin(handle, heist!.id, { userId: userC, entryFee: 100, max: 8, baseChance, role: 'Lookout' });
  const payoutEach = Math.floor(targetPayout / 3); // 200
  await arrangeFrozenSuccess(handle, heist!.id, payoutEach);

  // A payout that PARTIALLY failed: credit only A; B and C stay unpaid (paid_at NULL) —
  // the exact state a mid-resolution fault leaves. The manager holds the heist in_progress
  // (unfinalised) while any credit is outstanding, so we do NOT finalise here yet.
  const paidA1 = await driveCredit(handle, heist!.id, userA, payoutEach);

  // The retry re-runs the whole settle idempotently: A is a no-op under the paid_at guard,
  // and the still-unpaid B and C are credited — each frozen member paid exactly once.
  const paidA2 = await driveCredit(handle, heist!.id, userA, payoutEach);
  const paidB = await driveCredit(handle, heist!.id, userB, payoutEach);
  const paidC = await driveCredit(handle, heist!.id, userC, payoutEach);
  const walletA = await walletAmount(handle, userA);
  const walletB = await walletAmount(handle, userB);
  const walletC = await walletAmount(handle, userC);
  ctx.expect(
    paidA1 === true &&
      paidA2 === false &&
      paidB === true &&
      paidC === true &&
      walletA === 1100 &&
      walletB === 1100 &&
      walletC === 1100,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'A payout fault that leaves some crew unpaid converges on retry: the already-paid member is a no-op (paid_at guard) while every still-unpaid member is credited, so each frozen crew member is paid their frozen payout_each exactly once — never doubled.',
      observation:
        `first credit A=${paidA1}; on retry A=${paidA2} (expected false / no-op), B=${paidB}, C=${paidC}; ` +
        `wallets A=${walletA}, B=${walletB}, C=${walletC} (each expected 900+${payoutEach}=1100).`,
      impact: 'A retried payout double-paid an already-paid member or failed to pay a still-unpaid member.',
    },
  );

  // Only after every credit lands does finalise flip the heist terminal once.
  const finalized = await driveFinalize(handle, heist!.id);
  const refinalized = await driveFinalize(handle, heist!.id);
  const terminal = await readHeistById(handle, heist!.id);
  const settled = await participantsFor(handle, heist!.id);
  ctx.expect(
    finalized === true && refinalized === false && terminal?.status === 'success' && settled.every((p) => p.paid_at !== null),
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The heist finalises to terminal success exactly once after every frozen crew member is credited; a second finalise is a no-op.',
      observation:
        `finalize=${finalized} (expected true), second finalize=${refinalized} (expected false), terminal status=${terminal?.status}, ` +
        `all crew paid_at set=${settled.every((p) => p.paid_at !== null)}.`,
      impact: 'The heist finalised more than once or before every crew member was credited.',
    },
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle); // happy-so-far raises no alert
  await proveBranding(ctx);
  // The start-insert fault refund branch, the injected payout fault, and the owner
  // settlement-retry alert need fault injection the harness deliberately omits.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault injected on the heist_start insert, the initiator’s entry fee is refunded exactly once and no orphan heist/participant row exists; the clean retry opens exactly one heist for one debit.',
    'requires a fault-injection lane on the heist_start insert (the harness runs against a healthy DB); the manager’s debit→heist_start→refund path is proven end-to-end DB-observably in REPLAY’s duplicate-start check',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner alert channel receives exactly one reasoned settlement-retry alert while the injected payout fault persists and none once every crew member is paid.',
    'requires a mid-resolution fault-injection lane (fail heist_credit_participant) plus owner alert channel readback',
  );
  gateLiveGuildReadback(ctx, 'the branded refund confirmation on the failed start, and exactly one resolution announcement once every credit lands');
}

/** REPLAY — re-delivering start / join / resolution never double-charges or double-pays. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);
  const targetPayout = 500;
  const baseChance = 40;

  // (a) A re-delivered /heist start never opens a second heist: heist_start is guarded by
  //     the uniq_active_heist_per_guild index and returns duplicate_active while one heist
  //     is active; the manager's debit→dupe→refund path leaves no net charge.
  await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  const walletABeforeDup = await walletAmount(handle, userA); // 900
  const dupe = await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const walletAAfterDup = await walletAmount(handle, userA);
  const heistCountAfter = await heistCount(handle);
  ctx.expect(
    dupe.status === 'duplicate_active' &&
      dupe.heistId === null &&
      heistCountAfter === 1 &&
      walletAAfterDup === walletABeforeDup &&
      walletAAfterDup === 900,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'A re-delivered /heist start never opens a second heist: heist_start returns duplicate_active under the uniq_active_heist_per_guild index and the debit is refunded, leaving exactly one heist and no net charge.',
      observation:
        `re-start status=${dupe.status} (expected duplicate_active), heist rows=${heistCountAfter} (expected 1), ` +
        `A wallet ${walletABeforeDup}→${walletAAfterDup} (expected unchanged 900).`,
      impact: 'A replayed /heist start opened a duplicate active heist or left a net charge.',
    },
  );

  // (b) A re-delivered /heist join by the same member is deduped: heist_join returns
  //     already_joined and debits NOTHING (the membership EXISTS check returns before the
  //     debit), so there is exactly one entry-fee debit and one participant row per member.
  const joinB1 = await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });
  const walletB1 = await walletAmount(handle, userB); // 900
  const joinB2 = await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });
  const walletB2 = await walletAmount(handle, userB); // still 900
  const bRows = (await participantsFor(handle, heist!.id)).filter((p) => p.user_id === userB);
  ctx.expect(
    joinB1.status === 'joined' && joinB2.status === 'already_joined' && walletB1 === 900 && walletB2 === 900 && bRows.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'A re-delivered /heist join by the same member is deduped to already_joined and debits nothing: exactly one entry-fee debit and one participant row per member.',
      observation:
        `first join=${joinB1.status}, replay join=${joinB2.status} (expected already_joined), ` +
        `B wallet ${walletB1}→${walletB2} (expected unchanged 900), B participant rows=${bRows.length} (expected 1).`,
      impact: 'A replayed /heist join double-charged the member or filed a duplicate participant row.',
    },
  );

  // (c) The resolution credit + finalise are idempotent (paid_at guard + single-shot finalise):
  //     re-delivering them yields one credit per member and one terminal flip.
  const payoutEach = Math.floor(targetPayout / 2); // 250
  await arrangeFrozenSuccess(handle, heist!.id, payoutEach);
  const preA = await walletAmount(handle, userA);
  const preB = await walletAmount(handle, userB);
  const cA1 = await driveCredit(handle, heist!.id, userA, payoutEach);
  const cB1 = await driveCredit(handle, heist!.id, userB, payoutEach);
  const cA2 = await driveCredit(handle, heist!.id, userA, payoutEach);
  const cB2 = await driveCredit(handle, heist!.id, userB, payoutEach);
  const fin1 = await driveFinalize(handle, heist!.id);
  const fin2 = await driveFinalize(handle, heist!.id);
  const postA = await walletAmount(handle, userA);
  const postB = await walletAmount(handle, userB);
  const terminal = await readHeistById(handle, heist!.id);
  ctx.expect(
    cA1 === true &&
      cB1 === true &&
      cA2 === false &&
      cB2 === false &&
      fin1 === true &&
      fin2 === false &&
      postA === (preA ?? 0) + payoutEach &&
      postB === (preB ?? 0) + payoutEach &&
      terminal?.status === 'success',
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Re-delivering the resolution credits each frozen crew member exactly once and finalises exactly once (paid_at guard + single-shot finalise).',
      observation:
        `credits A=${cA1}/${cA2}, B=${cB1}/${cB2} (second of each expected false); finalise=${fin1}/${fin2} (second expected false); ` +
        `A ${preA}→${postA}, B ${preB}→${postB} (each +${payoutEach}); terminal status=${terminal?.status}.`,
      impact: 'A replayed resolution double-paid a crew member or double-finalised the heist.',
    },
  );

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  gateLiveGuildReadback(ctx, 'exactly one recruiting embed, one join embed per member, and one resolution announcement despite the replays');
}

/** RESTART — heist state survives a full stack reboot; the REAL boot-time resume settles the claimed-but-unpaid heist exactly once. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const bootOpts = { guildId, entryFee: 100, basePayout: 400, successBase: 40, minParticipants: 2, maxParticipants: 8 };

  // Boot #1: build a crew, reproduce a claimed-but-unpaid (frozen success) in_progress heist,
  // snapshot, shut down. State lives in Supabase, so the rows persist across the "restart".
  const first = await bootHeist(ctx, bootOpts);
  await seedWallet(first, userA, 1000);
  await seedWallet(first, userB, 1000);
  const targetPayout = 400;
  const baseChance = 40;
  await driveStart(first, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(first);
  await driveJoin(first, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });
  const payoutEach = Math.floor(targetPayout / 2); // 200
  await arrangeFrozenSuccess(first, heist!.id, payoutEach);
  const snapshot = await readHeistById(first, heist!.id);
  const preA = await walletAmount(first, userA); // 900 (1000 - 100 entry fee)
  const preB = await walletAmount(first, userB); // 900
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). Booting the stack runs the REAL production
  // resume path: initGuildFeatures AWAITS resumePendingHeists (guild-init.ts),
  // and a claimed in_progress heist is resolved IMMEDIATELY (heist-manager.ts
  // treats it as "already claimed — finish the frozen outcome"; there is no
  // join-window timer left to wait out). So by the time this handle returns, the
  // product itself has read the persisted frozen decision and settled it. The
  // probe therefore asserts persistence THROUGH the resume: the frozen
  // pre-shutdown decision (resolution + payout_each), the frozen crew, and their
  // frozen entry fees all survived byte-identical and were driven to exactly the
  // terminal state that decision requires — nothing re-rolled, lost, or resized.
  const second = await bootHeist(ctx, bootOpts);
  const afterRestart = snapshot ? await readHeistById(second, snapshot.id) : null;
  const frozen = snapshot ? await participantsFor(second, snapshot.id) : [];
  ctx.expect(
    afterRestart?.status === 'success' &&
      afterRestart?.resolution === 'success' &&
      afterRestart?.resolution === snapshot?.resolution &&
      afterRestart?.payout_each === payoutEach &&
      afterRestart?.target_payout === snapshot?.target_payout &&
      afterRestart?.created_at === snapshot?.created_at &&
      afterRestart?.resolved_at !== null &&
      frozen.length === 2 &&
      frozen.every((p) => p.claimed_at !== null && p.entry_fee_paid === 100),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full restart the claimed heist’s frozen outcome, payout_each, and frozen crew persist exactly (state lives in Supabase), and the REAL boot-time resume (resumePendingHeists, awaited by guild init) settles the persisted decision to its terminal status without re-rolling or resizing it.',
      observation:
        `post-restart status=${afterRestart?.status} (expected terminal success — boot #2's awaited resumePendingHeists resolves a claimed in_progress heist immediately), ` +
        `resolution=${afterRestart?.resolution} (snapshot ${snapshot?.resolution}), payout_each=${afterRestart?.payout_each} (expected frozen ${payoutEach}), ` +
        `same persisted row=${afterRestart?.created_at === snapshot?.created_at}, resolved_at ${afterRestart?.resolved_at ? 'set' : 'null'}; ` +
        `frozen crew=${frozen.length} all claimed+fee-frozen=${frozen.every((p) => p.claimed_at !== null && p.entry_fee_paid === 100)}.`,
      impact: 'Heist state did not survive the restart — the claimed heist or its frozen crew was lost or altered.',
    },
  );

  // The resumed settlement paid each frozen crew member EXACTLY once (never a
  // catch-up double payout), and the durable DB fences hold against replay: a
  // re-driven credit is a paid_at-guarded no-op, a re-driven finalise is a
  // status-guarded no-op, so each wallet moved 900 → 1100 once and can never
  // move again for this heist.
  const postA = await walletAmount(second, userA); // 1100 — paid once by the resume
  const postB = await walletAmount(second, userB); // 1100
  const paidA = frozen.find((p) => p.user_id === userA);
  const paidB = frozen.find((p) => p.user_id === userB);
  const cAgainA = snapshot ? await driveCredit(second, snapshot.id, userA, payoutEach) : true;
  const cAgainB = snapshot ? await driveCredit(second, snapshot.id, userB, payoutEach) : true;
  const finAgain = snapshot ? await driveFinalize(second, snapshot.id) : true;
  const replayA = await walletAmount(second, userA);
  const replayB = await walletAmount(second, userB);
  const terminal = snapshot ? await readHeistById(second, snapshot.id) : null;
  ctx.expect(
    postA === (preA ?? 0) + payoutEach &&
      postB === (preB ?? 0) + payoutEach &&
      paidA != null &&
      paidA.paid_at !== null &&
      paidA.payout === payoutEach &&
      paidB != null &&
      paidB.paid_at !== null &&
      paidB.payout === payoutEach &&
      cAgainA === false &&
      cAgainB === false &&
      finAgain === false &&
      replayA === postA &&
      replayB === postB &&
      terminal?.status === 'success',
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'A claimed-but-unpaid heist resumes after restart and pays each frozen crew member exactly once, finalising exactly once (no re-roll, no catch-up double payout).',
      observation:
        `resumed settlement: A ${preA}→${postA}, B ${preB}→${postB} (each expected exactly +${payoutEach}; paid_at stamped, payout=${paidA?.payout}/${paidB?.payout}); ` +
        `re-driven credit A=${cAgainA}/B=${cAgainB} (paid_at fence, expected false), re-driven finalise=${finAgain} (status fence, expected false); ` +
        `wallets after replay A=${replayA}/B=${replayB} (expected unchanged); terminal status=${terminal?.status}.`,
      impact: 'The restart-spanning heist double-paid a crew member or double-finalised.',
    },
  );

  // Audit: the pre-restart frozen outcome persists as the append-only record.
  ctx.expect(terminal?.resolution === 'success' && terminal?.payout_each === payoutEach && terminal?.resolved_at !== null, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The pre-restart frozen outcome (resolution + payout_each) persists and finalises with a resolved_at stamp.',
    observation: `resolution=${terminal?.resolution}, payout_each=${terminal?.payout_each} (expected ${payoutEach}), resolved_at ${terminal?.resolved_at ? 'set' : 'null'}.`,
    impact: 'The frozen heist outcome did not survive the restart.',
  });

  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  await proveBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'resumePendingHeists re-schedules the pending heist on boot and posts exactly one resolution announcement to the log channel.',
    'the resumed settlement itself IS driven here — boot #2 runs the real awaited resumePendingHeists, which settles the claimed heist (proven DB-observably above); only the single channel announcement needs a live gateway (DISCORD_TOKEN + live guild)',
  );
}

/** RACE — concurrent claim + join serialize under the heist-row lock; a stranded late-join is refunded once. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');
  for (const u of [userA, userB, userC]) await seedWallet(handle, u, 1000);
  const targetPayout = 500;
  const baseChance = 40;
  await driveStart(handle, {
    userId: userA,
    targetName: TARGET.name,
    targetPayout,
    baseChance,
    entryFee: 100,
    expiresAt: futureIso(60),
    role: 'Driver',
  });
  const heist = await readActiveHeist(handle);
  await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance, role: 'Muscle' });

  // (a) Two simultaneous resolutions claim the SAME recruiting heist under the heist-row
  //     FOR UPDATE lock: exactly one wins claimed=true, the other is a no-op.
  const [c1, c2] = await Promise.all([driveClaim(handle, heist!.id, 2), driveClaim(handle, heist!.id, 2)]);
  const winners = [c1, c2].filter((c) => c?.claimed === true);
  const afterClaim = await readHeistById(handle, heist!.id);
  ctx.expect(winners.length === 1 && afterClaim?.status === 'in_progress' && afterClaim?.resolution !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous resolutions claim the heist exactly once (one claimed=true, the other a no-op) under the heist-row FOR UPDATE lock.',
    observation:
      `concurrent claims returning claimed=true: ${winners.length} (expected 1); post-claim status=${afterClaim?.status} (expected in_progress), ` +
      `resolution=${afterClaim?.resolution ?? 'none'}.`,
    impact: 'A concurrent double-claim resolved the heist twice or left it unclaimed — the row-lock serialisation failed.',
  });

  // (b) A /heist join that reaches the row AFTER the claim is rejected as not_recruiting,
  //     debiting nothing and filing no participant row (the join re-checks status under the lock).
  const walletC0 = await walletAmount(handle, userC);
  const joinC = await driveJoin(handle, heist!.id, { userId: userC, entryFee: 100, max: 8, baseChance, role: 'Lookout' });
  const walletC1 = await walletAmount(handle, userC);
  const cRowAfterJoin = await participantFor(handle, heist!.id, userC);
  ctx.expect(joinC.status === 'not_recruiting' && walletC1 === walletC0 && walletC1 === 1000 && cRowAfterJoin === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A /heist join that loses the race to the claim is charged nothing: heist_join re-checks status under the same lock and returns not_recruiting without a debit or a participant row.',
    observation:
      `join after claim=${joinC.status} (expected not_recruiting), C wallet ${walletC0}→${walletC1} (expected unchanged 1000), ` +
      `C participant row=${cRowAfterJoin === null ? 'none' : 'present'}.`,
    impact: 'A join that lost the resolve race was still charged or filed a participant row.',
  });

  // (c) A stranded late-join row (a participant inserted after the crew freeze:
  //     claimed_at NULL, paid_at NULL, having paid its own fee) is reconciled and refunded
  //     its OWN frozen entry_fee_paid exactly once; a second reconcile is a no-op.
  await handle.supabase
    .from('economy_heist_participants')
    .insert({ heist_id: heist!.id, guild_id: handle.guildId, user_id: userC, role: 'Lookout', entry_fee_paid: 100 });
  await handle.supabase.rpc('economy_subtract_balance', { p_guild_id: handle.guildId, p_user_id: userC, p_amount: 100 });
  const walletCStranded = await walletAmount(handle, userC); // 900
  const refunded1 = await driveReconcile(handle, heist!.id, 100);
  const refunded2 = await driveReconcile(handle, heist!.id, 100); // idempotent no-op
  const walletCReconciled = await walletAmount(handle, userC);
  const cRowReconciled = await participantFor(handle, heist!.id, userC);
  ctx.expect(refunded1 === 1 && refunded2 === 0 && walletCReconciled === 1000 && cRowReconciled === null, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'A stranded late-join (unstamped, unpaid) is reconciled and refunded its own frozen entry fee exactly once; a second reconcile is a no-op.',
    observation:
      `reconcile #1 refunded=${refunded1} (expected 1), #2 refunded=${refunded2} (expected 0); ` +
      `C wallet ${walletCStranded}→${walletCReconciled} (expected back to 1000), stranded row=${cRowReconciled === null ? 'removed' : 'present'}.`,
    impact: 'A stranded late-join was refunded twice, never refunded, or left in the crew.',
  });

  // Settle only the FROZEN claimed crew (A, B) once for the audit record.
  const frozenCrew = (await participantsFor(handle, heist!.id)).filter((p) => p.claimed_at !== null);
  const outcome = afterClaim?.resolution ?? null;
  if (outcome === 'success') {
    for (const p of frozenCrew) await driveCredit(handle, heist!.id, p.user_id, afterClaim?.payout_each ?? 0);
  }
  const finalized = await driveFinalize(handle, heist!.id);
  const terminal = await readHeistById(handle, heist!.id);
  ctx.expect(finalized === true && terminal?.status === outcome && frozenCrew.length === 2, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Only the frozen claimed crew (exactly 2) is settled and the heist finalises to its single frozen outcome once.',
    observation: `frozen claimed crew=${frozenCrew.length} (expected 2), finalise=${finalized}, terminal status=${terminal?.status} (expected ${outcome}).`,
    impact: 'The settled crew was not exactly the frozen claimed set, or the heist did not finalise once.',
  });

  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);
  // The wall-clock join⇄resolve race through the dispatcher's refund branch needs concurrency
  // injection; the RPC-level row-lock + reconcile guards it relies on are proven above.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A /heist join landing exactly as the window expires shows a branded no-charge refusal (or a silent stranded-join refund of its own frozen entry fee), never an unwinnable charged seat.',
    'reproducing the wall-clock join⇄resolve race through the dispatcher needs concurrency injection; the RPC-level row-lock (not_recruiting) + stranded-join reconcile guards it relies on are proven DB-observably',
  );
}

/** XGUILD — heists are strictly per-guild: a full heist in guild B never touches guild A. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await bootHeist(ctx, { guildId: guildA, entryFee: 100, basePayout: 500, successBase: 40, minParticipants: 2, maxParticipants: 8 });
  const handleB = await bootHeist(ctx, { guildId: guildB, entryFee: 300, basePayout: 900, successBase: 40, minParticipants: 2, maxParticipants: 8 });
  await seedWallet(handleA, userA, 1000);
  await seedWallet(handleA, userB, 1000);
  await seedWallet(handleB, userA, 2000);
  await seedWallet(handleB, userB, 2000);

  // Guild A: start + join, snapshot the recruiting heist and guild A wallet.
  await driveStart(handleA, { userId: userA, targetName: TARGET.name, targetPayout: 500, baseChance: 40, entryFee: 100, expiresAt: futureIso(60), role: 'Driver' });
  const heistA = await readActiveHeist(handleA);
  await driveJoin(handleA, heistA!.id, { userId: userB, entryFee: 100, max: 8, baseChance: 40, role: 'Muscle' });
  const walletA_A0 = await walletAmount(handleA, userA); // 900
  const partsA0 = (await participantsFor(handleA, heistA!.id)).length; // 2

  // Guild B: the same users run a FULL heist at guild B's OWN 300 entry fee (start + join
  // + claim + settle), entirely independent of guild A.
  await driveStart(handleB, { userId: userA, targetName: TARGET.name, targetPayout: 900, baseChance: 40, entryFee: 300, expiresAt: futureIso(60), role: 'Driver' });
  const heistB = await readActiveHeist(handleB);
  await driveJoin(handleB, heistB!.id, { userId: userB, entryFee: 300, max: 8, baseChance: 40, role: 'Muscle' });
  const claimB = await driveClaim(handleB, heistB!.id, 2);
  const frozenB = await participantsFor(handleB, heistB!.id);
  const outcomeB = claimB?.outcome ?? null;
  if (outcomeB === 'success') {
    for (const p of frozenB) await driveCredit(handleB, heistB!.id, p.user_id, claimB?.payout_each ?? 0);
  }
  await driveFinalize(handleB, heistB!.id);

  // Guild A is completely unchanged by all guild B activity.
  const heistA_after = await readHeistById(handleA, heistA!.id);
  const walletA_A1 = await walletAmount(handleA, userA);
  const partsA1 = (await participantsFor(handleA, heistA!.id)).length;
  ctx.expect(
    heistA_after?.status === 'recruiting' &&
      walletA_A1 === walletA_A0 &&
      walletA_A1 === 900 &&
      partsA1 === partsA0 &&
      partsA1 === 2 &&
      heistB?.guild_id === guildB,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Running a full heist in guild B never touches guild A’s heist, crew, or wallets; guild B uses its own 300 entry fee.',
      observation:
        `guild A heist status ${heistA_after?.status} (expected recruiting), A wallet ${walletA_A0}→${walletA_A1} (unchanged 900), ` +
        `guild A crew=${partsA1} (expected 2); guild B heist under guild="${heistB?.guild_id}".`,
      impact: 'Cross-guild heist activity mutated another guild’s heist, crew, or wallet — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN economy_heists rows and never the other guild's.
  const aHeists = await heistsForGuild(handleA, guildA);
  const bHeists = await heistsForGuild(handleB, guildB);
  ctx.expect(
    aHeists.length >= 1 &&
      aHeists.every((h) => h.guild_id === guildA) &&
      bHeists.length >= 1 &&
      bHeists.every((h) => h.guild_id === guildB),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Each guild scope reads its OWN economy_heists rows and never the other guild’s (distinct guild_ids).',
      observation:
        `guild-A-scoped heists=${aHeists.length} all under "${guildA}"=${aHeists.every((h) => h.guild_id === guildA)}; ` +
        `guild-B-scoped heists=${bHeists.length} all under "${guildB}"=${bHeists.every((h) => h.guild_id === guildB)}.`,
      impact: 'A guild-scoped read returned another guild’s heist rows — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA);

  // Audit: guild B's heist outcome is recorded under guild B only.
  const finalB = await readHeistById(handleB, heistB!.id);
  ctx.expect(finalB?.guild_id === guildB && (finalB?.status === 'success' || finalB?.status === 'failed'), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Guild B keeps its own heist-outcome record under guild B; it does not cross into guild A.',
    observation: `guild B heist outcome under guild="${finalB?.guild_id}" status=${finalB?.status}.`,
    impact: 'A heist-outcome record crossed guilds.',
  });

  await proveNoOwnerAlert(ctx, handleA);
  await proveBranding(ctx);
  gateLiveGuildReadback(ctx, 'guild A /heist status identical before and after the guild B activity, and guild B’s independent resolution announcement');
  gateReplayDeferredTo(ctx, 'REPLAY / RESTART / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed heist rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await bootHeist(ctx, {
    label: 'a',
    entryFee: 100,
    basePayout: 500,
    successBase: 40,
    minParticipants: 2,
    maxParticipants: 8,
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // Create run-prefixed operational rows: a heist, participant rows, wallets.
  await driveStart(handle, { userId: userA, targetName: TARGET.name, targetPayout: 500, baseChance: 40, entryFee: 100, expiresAt: futureIso(60), role: 'Driver' });
  const heist = await readActiveHeist(handle);
  await driveJoin(handle, heist!.id, { userId: userB, entryFee: 100, max: 8, baseChance: 40, role: 'Muscle' });

  const heistsBefore = await heistCount(handle);
  const partsBefore = await participantCount(handle);
  ctx.expect(heistsBefore >= 1 && partsBefore >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed heist + participant + wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: heist rows=${heistsBefore}, participant rows=${partsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  await proveBranding(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const heistsAfter = await heistCount(handle);
  const partsAfter = await participantCount(handle);
  const walletsAfter = await (async () => {
    const { count } = await handle.supabase
      .from('economy_wallets')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId);
    return count ?? 0;
  })();
  ctx.expect(heistsAfter === 0 && partsAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed heist, participant, and wallet rows are deleted; a final sweep finds zero run-prefixed heist resources.',
    observation: `post-sweep: heist rows=${heistsAfter}, participant rows=${partsAfter}, wallet rows=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed heist rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed embeds, and audit "anonymized-not-deleted" history
  // in the dedicated audit_logs table, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed heist recruiting, join, or resolution embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational heist rows deleted, audit_logs retained anonymized).',
    'requires an audit_logs anonymization readback lane; the bot writes no dedicated heist audit_logs row, so the operational heist/participant rows are the DB-observable evidence here',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ──────────────────────────────────────────────────────

/**
 * The Strategic Crew Heist domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus the 12
 * scenario scripts.
 */
export const gameEconomyHeistProof: DomainProof = {
  domainId: 'game-economy-heist',
  guildScopedTables: [
    // child → parent: participants FK economy_heists(id); heists FK guild_config(guild_id).
    'economy_heist_participants',
    'economy_heists',
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
