/**
 * scenario-runner/scripts/game-economy-lottery — the Transparent Lottery domain proof.
 *
 * Binds the lottery domain's 12 declarative catalog scenarios to concrete,
 * real-stack proofs driven against LOCAL Supabase. The two member-facing surfaces
 * — /lottery buy and /lottery view — run through the REAL production dispatcher
 * (handleInteraction, via the capability-bound injector). The lottery has NO
 * member draw command: the winner is picked and paid by the always-on scheduler
 * through four atomic RPCs (lottery_buy_tickets, lottery_claim_drawing,
 * lottery_award_jackpot, lottery_cancel_drawing_if_empty). The scheduler tick is a
 * setTimeout(≥60s)+setInterval(≥6h) that a fast bot-only harness cannot fire, so
 * the draw pipeline is proven DB-observably by exercising those SAME atomic RPCs
 * the scheduler drives (a single stored stable winner, paid the whole pot exactly
 * once, empty draws cancelled) — while the timer orchestration and the channel
 * winner-announcement embed are GATED behind DISCORD_TOKEN + a live guild.
 *
 * Why the injector (not ctx.runSlash) for the commands: /lottery is a
 * subcommand command and the handler reads interaction.options.getSubcommand();
 * ctx.runSlash does not set a subcommand, so the scripts build the subcommand
 * interaction with buildSlashInteraction and drive it through ctx.injectorFor —
 * the same real in-process dispatcher ingress ctx.runSlash uses.
 *
 * Fault lanes (a mid-draw payout failure, a Supabase outage, a wall-clock buy⇄draw
 * race) are GATED: they need fault injection the harness deliberately omits. But
 * the claimed-but-unpaid state a payout failure LEAVES is reproduced honestly by
 * claiming without awarding, so the RETRY convergence (stable winner, paid once,
 * never re-rolled) is proven for real.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's
 * contracted intent the script records a FAIL (never a softened pass/gate). The
 * headline finding here: /lottery buy is NOT idempotent on the interaction id
 * (unlike /pay, PR #301), so a re-delivered buy double-charges — surfaced in
 * REPLAY as a FAIL for the owner to adjudicate.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import { buildSlashInteraction, type OptionValue } from '../../interaction-builders.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface DrawingRow {
  id: string;
  guild_id: string;
  status: string;
  jackpot: number;
  winner_user_id: string | null;
  winning_number: number | null;
  winner_paid_at: string | null;
  created_at: string;
}

interface TicketRow {
  user_id: string;
  guild_id: string;
  drawing_id: string;
  ticket_number: number;
}

/** The RETURNS TABLE shape of lottery_claim_drawing / lottery_award_jackpot. */
interface DrawRpcRow {
  id: string;
  guild_id: string;
  jackpot: number;
  winner_user_id: string | null;
  winning_number: number | null;
}

// ── Catalog helpers ───────────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

// ── Booting a lottery-enabled guild ───────────────────────────────────────

interface LotteryBootOptions {
  label?: string;
  guildId?: string;
  ticketPrice?: number;
  maxTickets?: number;
  schedule?: string;
  enabled?: boolean;
}

/**
 * Boot a guild with the economy on and the lottery sub-feature wired. The
 * lottery manager is gated by economy_lottery_enabled INSIDE the economy_enabled
 * block (guild-init.ts), so both flags must be set for the real dispatcher to
 * resolve the manager.
 */
async function bootLottery(ctx: ScenarioContext, opts: LotteryBootOptions = {}): Promise<LiveClientHandle> {
  return ctx.bootGuild({
    label: opts.label,
    guildId: opts.guildId,
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_lottery_enabled: opts.enabled ?? true,
      economy_lottery_ticket_price: opts.ticketPrice ?? 100,
      economy_lottery_max_tickets: opts.maxTickets ?? 10,
      economy_lottery_schedule: opts.schedule ?? 'weekly',
    },
  });
}

// ── Driving the subcommand command through the REAL dispatcher ─────────────

interface RunLotteryParams {
  sub: string;
  userId: string;
  options?: Record<string, OptionValue>;
  interactionId?: string;
  displayName?: string;
  member?: unknown;
}

/**
 * Drive /lottery <sub> through the production dispatcher. Uses ctx.injectorFor
 * (the capability-bound real ingress) with a subcommand interaction, because
 * ctx.runSlash cannot set getSubcommand().
 */
async function runLottery(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  params: RunLotteryParams,
): Promise<CapturedResponse> {
  const injector = ctx.injectorFor(handle);
  const interaction = buildSlashInteraction({
    commandName: 'lottery',
    subcommand: params.sub,
    guildId: handle.guildId,
    client: handle.client,
    id: params.interactionId,
    user: {
      id: params.userId,
      username: params.userId,
      displayName: params.displayName ?? params.userId,
    },
    member: params.member,
    options: params.options ?? {},
  });
  return injector.inject(interaction);
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
async function seedWallet(
  handle: LiveClientHandle,
  userId: string,
  wallet: number,
  bank = 0,
): Promise<void> {
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

async function readActiveDrawing(handle: LiveClientHandle): Promise<DrawingRow | null> {
  const { data } = await handle.supabase
    .from('economy_lottery_drawings')
    .select('id, guild_id, status, jackpot, winner_user_id, winning_number, winner_paid_at, created_at')
    .eq('guild_id', handle.guildId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as DrawingRow | null) ?? null;
}

async function readDrawingById(handle: LiveClientHandle, id: string): Promise<DrawingRow | null> {
  const { data } = await handle.supabase
    .from('economy_lottery_drawings')
    .select('id, guild_id, status, jackpot, winner_user_id, winning_number, winner_paid_at, created_at')
    .eq('id', id)
    .maybeSingle();
  return (data as DrawingRow | null) ?? null;
}

async function ticketsForDrawing(handle: LiveClientHandle, drawingId: string): Promise<TicketRow[]> {
  const { data } = await handle.supabase
    .from('economy_lottery_tickets')
    .select('user_id, guild_id, drawing_id, ticket_number')
    .eq('drawing_id', drawingId)
    .limit(1000);
  return (data as TicketRow[] | null) ?? [];
}

async function guildTicketCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_lottery_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function guildDrawingCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_lottery_drawings')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

// ── The atomic draw RPCs the scheduler drives (proven directly, DB-observable) ─

async function claimDrawing(handle: LiveClientHandle, drawingId: string): Promise<DrawRpcRow | null> {
  const { data } = await handle.supabase.rpc('lottery_claim_drawing', { p_drawing_id: drawingId });
  const rows = (data as DrawRpcRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function awardJackpot(handle: LiveClientHandle, drawingId: string): Promise<DrawRpcRow | null> {
  const { data } = await handle.supabase.rpc('lottery_award_jackpot', { p_drawing_id: drawingId });
  const rows = (data as DrawRpcRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function cancelIfEmpty(handle: LiveClientHandle, drawingId: string): Promise<string | null> {
  const { data } = await handle.supabase.rpc('lottery_cancel_drawing_if_empty', { p_drawing_id: drawingId });
  return (data as string | null) ?? null;
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

// ── Live event→audit pipeline (the REAL per-guild AuditService) ────────────

/** Structural view of the per-guild AuditService — only the batch flush we drive. */
interface AuditFlusher {
  flush(): Promise<void>;
}

/** The append-only audit_logs columns this proof reads. */
interface AuditRow {
  action: string | null;
  category: string | null;
  actor_type: string | null;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  guild_id: string | null;
}

/**
 * Resolve the REAL per-guild AuditService the production init wired via
 * ctx.setManager('auditService') (guild-init.ts). Returns undefined when the booted
 * context carries no such manager (→ caller GATEs rather than mis-read the table).
 */
function getAuditService(handle: LiveClientHandle): AuditFlusher | undefined {
  return handle.client.router.getContextSync(handle.guildId)?.getManager<AuditFlusher>('auditService');
}

/**
 * Let the platform event bus deliver a driven buy's emitted `lottery.ticket_purchased`
 * event to the AuditService's onAny listener (dispatched via setImmediate), then force
 * its REAL batch flush() so the audit_logs row lands NOW instead of on the 5s timer.
 * Returns false when the service is absent (→ caller GATEs, never mis-reads empty as a bug).
 */
async function flushAuditQueue(handle: LiveClientHandle): Promise<boolean> {
  const svc = getAuditService(handle);
  if (!svc) return false;
  await new Promise((resolve) => setTimeout(resolve, 20)); // drain the onAny setImmediate listeners
  await svc.flush();
  return true;
}

/**
 * Read the guild's lottery-attributable audit_logs rows (action prefixed 'lottery.').
 * Returns null (NOT []) on a read error so a failed query can never masquerade as
 * "no audit row written" (the caller GATEs instead of recording a false result).
 */
async function readLotteryAuditRows(handle: LiveClientHandle): Promise<AuditRow[] | null> {
  const { data, error } = await handle.supabase
    .from('audit_logs')
    .select('action, category, actor_type, actor_id, target_type, target_id, details, guild_id')
    .eq('guild_id', handle.guildId)
    .limit(2000);
  if (error) return null;
  const rows = (data as AuditRow[] | null) ?? [];
  return rows.filter((r) => (r.action ?? '').toLowerCase().startsWith('lottery.'));
}

// ── Captured-reply helpers ─────────────────────────────────────────────────

/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

function replyContent(captured: CapturedResponse): string {
  return payloadText(captured.find('reply')?.payload);
}

function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const reply = captured.find('reply');
  const payload = reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

/** Every member-facing text surface of a reply: content + embed title/description/fields/footer. */
function brandingSurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const content = replyContent(captured);
  if (content) parts.push(content);
  const embed = replyEmbedData(captured);
  if (embed) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
    const fields = embed.fields as Array<{ name?: string; value?: string }> | undefined;
    for (const f of fields ?? []) {
      if (typeof f.name === 'string') parts.push(f.name);
      if (typeof f.value === 'string') parts.push(f.value);
    }
    const footer = (embed.footer as { text?: string } | undefined)?.text;
    if (typeof footer === 'string') parts.push(footer);
  }
  return parts.join('\n');
}

function truncate(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS/GRANT deny → 0), or null when inconclusive
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
 * Prove the member-facing reply is the real branded lottery embed rendering the
 * guild's live state — checked by finding a REAL DB-derived token (`mustInclude`,
 * e.g. the live jackpot number or configured schedule) inside the captured
 * surface, never a synthetic literal. When a scenario produced no reply the
 * captured-reply branding GATEs. The full brand kit (currency name/emoji, colors,
 * voice, powered-by attribution) is a snapshot comparison → GATED.
 */
function proveBranding(
  ctx: ScenarioContext,
  captured: CapturedResponse,
  mustInclude: string,
  tokenLabel: string,
): void {
  const surface = brandingSurface(captured);
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      'Member-facing lottery surfaces render as the owner-branded embed reflecting the guild’s live state.',
      'this scenario produced no member-facing reply/embed to inspect for branding',
    );
  } else {
    const includes = surface.includes(mustInclude);
    ctx.expect(includes, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise:
        'Member-facing lottery surfaces render as the owner-branded embed carrying the guild’s live state (not a stock/placeholder reply).',
      observation:
        `reply surface "${truncate(surface)}" ${includes ? 'includes' : 'omits'} the live ${tokenLabel} "${mustInclude}".`,
      impact: 'A lottery reply did not render the guild’s live state in its branded embed (stock/placeholder wording leaked).',
    });
  }
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (brand name, configured currency name/emoji, colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit.',
    'requires an embed snapshot compared against the live brand kit (DISCORD_TOKEN + live guild): the lottery embeds already render the configured currency name/emoji, but the remaining brand-kit facets (brand name, embed colors — currently hardcoded blurple/gold, voice preset, powered-by-SomniBot attribution) can only be verified by reading the rendered embed back from a live guild',
  );
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
    'Failure-branch alerts (e.g. draw-degraded) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected draw-payout failure',
  );
}

/**
 * Anon-denial RLS proof on economy_lottery_tickets made non-vacuous by a positive
 * control: the scenario has already inserted ticket rows for this guild (the
 * service role sees them), so an anon client reading ZERO of them is a real deny.
 * Cross-guild isolation across two REAL guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const serviceTickets = await guildTicketCount(handle);
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_lottery_tickets rows (RLS lockdown revokes anon).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_lottery_tickets', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_lottery_tickets rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  ctx.expect(serviceTickets > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s lottery ticket rows while an anon client reads zero of them (RLS lockdown revokes anon on economy_lottery_tickets).',
    observation:
      `service-role sees ${serviceTickets} ticket row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} economy_lottery_tickets row(s) for that guild.`,
    impact:
      'Lottery ticket rows visible to the service role were also readable with an anon key — RLS/GRANT is not denying anon reads (direct data exposure).',
  });
}

function gateSchedulerDraw(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The scheduled draw tick fires on the configured cadence and posts a branded winner announcement in the lottery log channel.',
    'the draw runs only on the always-on scheduler (setTimeout ≥60s + setInterval ≥6h) and posts to a live channel — needs an accelerated clock + DISCORD_TOKEN + live guild; the draw RPCs it drives are proven DB-observably',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate debits, ticket inserts, or jackpot payouts.',
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ────────────────────────────────────────────────

/** DEF — out-of-box: 100/ticket, 10 cap, weekly draw; one shared jackpot, one stable winner paid the whole pot. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const priceDefault = Number(declaredDefault(ctx.domain, 'lottery-ticket-price'));
  const maxDefault = Number(declaredDefault(ctx.domain, 'lottery-max-tickets'));
  const scheduleDefault = String(declaredDefault(ctx.domain, 'lottery-schedule'));

  const handle = await bootLottery(ctx, { label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // A buys 3 (300), B buys 2 (200) → one shared jackpot of 500 across 5 tickets / 2 players.
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 3 } });
  const buyB = await runLottery(ctx, handle, { sub: 'buy', userId: userB, options: { tickets: 2 } });
  const drawing = await readActiveDrawing(handle);
  const tickets = drawing ? await ticketsForDrawing(handle, drawing.id) : [];
  const players = new Set(tickets.map((t) => t.user_id));
  const walletAAfterBuy = await walletAmount(handle, userA);
  const walletBAfterBuy = await walletAmount(handle, userB);

  ctx.expect(
    walletAAfterBuy === 700 &&
      walletBAfterBuy === 800 &&
      drawing?.jackpot === 500 &&
      tickets.length === 5 &&
      players.size === 2,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `Out of the box /lottery buy costs ${priceDefault} play coins/ticket (cap ${maxDefault}); each buy grows one shared jackpot.`,
      observation:
        `after A buys 3 / B buys 2: A wallet=${walletAAfterBuy} (expected 700), B wallet=${walletBAfterBuy} (expected 800), ` +
        `jackpot=${drawing?.jackpot} (expected 500), tickets=${tickets.length} (expected 5), players=${players.size} (expected 2).`,
      impact: 'Default ticket price / jackpot accumulation diverged from the catalog default.',
    },
  );

  // The buy embed shows the live jackpot (500) to the buyer.
  const buyBEmbed = replyEmbedData(buyB);
  const buyBDesc = String(buyBEmbed?.description ?? '');
  ctx.expect(buyBEmbed !== undefined && buyBDesc.includes('500'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The /lottery buy reply shows the updated shared jackpot.',
    observation: `buy embed description = "${truncate(buyBDesc)}".`,
    impact: 'The /lottery buy reply did not render the updated jackpot.',
  });

  // /lottery view reports pot, tickets, players, schedule, price.
  const view = await runLottery(ctx, handle, { sub: 'view', userId: userA });
  const viewDesc = String(replyEmbedData(view)?.description ?? '');
  ctx.expect(
    viewDesc.includes('500') && viewDesc.includes('5') && viewDesc.includes(scheduleDefault) && viewDesc.includes('100'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: '/lottery view reports the jackpot, tickets sold, weekly schedule, and ticket price.',
      observation: `view embed description = "${truncate(viewDesc)}".`,
      impact: '/lottery view did not report the drawing state contracted by the catalog.',
    },
  );

  // The scheduled draw pays exactly one stable winner the whole pot, once — proven
  // via the atomic RPCs the scheduler drives (claim stores the winner, award pays
  // it and finalises 'drawn'; a second award is a no-op — never double-paid).
  const preA = await walletAmount(handle, userA);
  const preB = await walletAmount(handle, userB);
  const claimed = drawing ? await claimDrawing(handle, drawing.id) : null;
  const awarded = drawing ? await awardJackpot(handle, drawing.id) : null;
  const secondAward = drawing ? await awardJackpot(handle, drawing.id) : null;
  const postA = await walletAmount(handle, userA);
  const postB = await walletAmount(handle, userB);
  const finalDrawing = drawing ? await readDrawingById(handle, drawing.id) : null;
  const winner = awarded?.winner_user_id ?? null;
  const winnerPaidCorrectly =
    winner !== null &&
    ((winner === userA && postA === (preA ?? 0) + 500 && postB === preB) ||
      (winner === userB && postB === (preB ?? 0) + 500 && postA === preA));

  ctx.expect(
    claimed?.winner_user_id === winner &&
      winnerPaidCorrectly &&
      awarded?.jackpot === 500 &&
      finalDrawing?.status === 'drawn' &&
      secondAward === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The draw pays exactly one stable winner the full 500-coin pot exactly once; a re-award is a no-op.',
      observation:
        `claimed winner=${claimed?.winner_user_id}, awarded winner=${winner}, jackpot=${awarded?.jackpot}; ` +
        `A ${preA}→${postA}, B ${preB}→${postB}; final status=${finalDrawing?.status}; second award=${secondAward === null ? 'no-op' : 'PAID AGAIN'}.`,
      impact: 'The draw did not pay a single stable winner the full pot exactly once (re-roll or double-pay on the money path).',
    },
  );

  // Audit: the finalised drawing row is the append-only record of the draw outcome
  // (winner id + winning ticket number), carrying the actor + guild.
  ctx.expect(
    finalDrawing?.winner_user_id === winner &&
      finalDrawing?.winning_number !== null &&
      finalDrawing?.winner_paid_at !== null &&
      finalDrawing?.guild_id === handle.guildId,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The draw records an append-only outcome row: the winner id, the winning ticket number, and the guild.',
      observation:
        `drawing row winner=${finalDrawing?.winner_user_id}, winning_number=${finalDrawing?.winning_number}, ` +
        `winner_paid_at=${finalDrawing?.winner_paid_at ? 'set' : 'null'}, guild=${finalDrawing?.guild_id}.`,
      impact: 'The draw did not leave a complete append-only outcome record.',
    },
  );

  proveBranding(ctx, view, scheduleDefault, 'schedule');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSchedulerDraw(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
  // The dedicated audit_logs lane IS live now: LotteryManager.buyTickets emits
  // `lottery.ticket_purchased` on the platform bus for each genuinely-new (non-
  // replayed) buy, and the REAL per-guild AuditService (started in guild-init) maps
  // it via EVENT_TO_AUDIT and batch-inserts the audit_logs row. Drive the flush the
  // 5s timer would otherwise do and read the two buy rows back DB-observably.
  const auditFlushed = await flushAuditQueue(handle);
  if (!auditFlushed) {
    ctx.gate(
      'audit',
      'audit-row',
      'Each accepted /lottery buy lands one append-only audit_logs row (lottery.ticket_purchased, category economy) carrying the buyer and the guild.',
      'the per-guild AuditService manager was not resolvable from the booted context, so the live event→audit pipeline could not be flushed deterministically',
    );
  } else {
    const auditRows = await readLotteryAuditRows(handle);
    if (auditRows === null) {
      ctx.gate(
        'audit',
        'audit-row',
        'Each accepted /lottery buy lands one append-only audit_logs row (lottery.ticket_purchased, category economy) carrying the buyer and the guild.',
        'the audit_logs read errored, so the audit trail cannot be evaluated (never recorded as a false result)',
      );
    } else {
      const buyRows = auditRows.filter((r) => r.action === 'lottery.ticket_purchased');
      const rowA = buyRows.find((r) => r.target_id === userA);
      const rowB = buyRows.find((r) => r.target_id === userB);
      ctx.expect(
        buyRows.length === 2 &&
          rowA !== undefined &&
          rowB !== undefined &&
          Number(rowA?.details?.count) === 3 &&
          Number(rowB?.details?.count) === 2 &&
          Number(rowA?.details?.totalCost) === 300 &&
          Number(rowB?.details?.totalCost) === 200 &&
          rowA?.category === 'economy' &&
          rowA?.target_type === 'member' &&
          rowA?.guild_id === handle.guildId,
        {
          assertionClass: 'audit',
          channel: 'audit-row',
          promise:
            'Each accepted /lottery buy lands exactly one append-only audit_logs row (action lottery.ticket_purchased, category economy) carrying the buying member (target id), the guild, and the buy details (ticket count + cost).',
          observation:
            `after A buys 3 / B buys 2 and one audit flush: lottery audit rows=${buyRows.length} (expected 2); ` +
            `A row present=${rowA !== undefined} count=${String(rowA?.details?.count)}/cost=${String(rowA?.details?.totalCost)}, ` +
            `B row present=${rowB !== undefined} count=${String(rowB?.details?.count)}/cost=${String(rowB?.details?.totalCost)}, ` +
            `category=${rowA?.category}, target_type=${rowA?.target_type}, guild=${rowA?.guild_id}.`,
          impact:
            'A /lottery buy did not leave its append-only audit_logs row — the buy money-path lacks the contracted audit trail.',
        },
      );
    }
  }
  // Still gated: lottery.drawn is emitted only by the scheduler-run
  // LotteryManager.drawWinner (this proof drives the atomic claim/award RPCs
  // directly to prove their idempotency), and lottery audit rows carry no
  // correlation id (no correlationId mapper in EVENT_TO_AUDIT).
  ctx.gate(
    'audit',
    'discord-readback',
    'The scheduled draw also lands a lottery.drawn audit row, and each lottery audit row carries a run-prefixed correlation id.',
    'lottery.drawn is emitted only by the scheduler-run LotteryManager.drawWinner (this proof drives the atomic draw RPCs directly), and lottery audit mappings set no correlation id — both need the live scheduler / a correlation-id mapping',
  );
}

/** SET-A — dashboard config takes live effect: price 250, per-member max 5, schedule 6h. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 250, maxTickets: 5, schedule: '6h' });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 5000);

  // Price 250 takes effect with no restart: buying 5 debits exactly 1250.
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 5 } });
  const drawing = await readActiveDrawing(handle);
  const afterBuy5 = await walletAmount(handle, userA);
  const ticketsAfter5 = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  ctx.expect(afterBuy5 === 3750 && drawing?.jackpot === 1250 && ticketsAfter5 === 5, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The saved ticket price 250 takes live effect: 5 tickets debit exactly 1250 play coins and the jackpot grows to 1250.',
    observation: `after buying 5: wallet=${afterBuy5} (expected 3750), jackpot=${drawing?.jackpot} (expected 1250), tickets=${ticketsAfter5} (expected 5).`,
    impact: 'The saved ticket-price configuration did not take live effect — a dashboard setting was ignored.',
  });

  // The saved per-member max 5 takes effect: a 6th ticket is refused and refunded (net zero).
  const buy6 = await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 1 } });
  const afterBuy6 = await walletAmount(handle, userA);
  const ticketsAfter6 = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  ctx.expect(afterBuy6 === 3750 && ticketsAfter6 === 5 && replyContent(buy6).toLowerCase().includes('maximum'), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The saved per-member max 5 refuses a 6th ticket and refunds the debit in full (net zero, no extra ticket).',
    observation:
      `after the refused 6th buy: wallet=${afterBuy6} (expected unchanged 3750), tickets=${ticketsAfter6} (expected 5), ` +
      `reply="${truncate(replyContent(buy6))}".`,
    impact: 'The saved per-member cap did not take effect, or the over-cap buy was not fully refunded.',
  });

  // Schedule 6h is surfaced by /lottery view with no restart.
  const view = await runLottery(ctx, handle, { sub: 'view', userId: userA });
  const viewDesc = String(replyEmbedData(view)?.description ?? '');
  ctx.expect(viewDesc.includes('6h') && viewDesc.includes('250'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/lottery view reports the tightened 6h cadence and the 250 ticket price.',
    observation: `view embed description = "${truncate(viewDesc)}".`,
    impact: 'The saved schedule / price were not reflected in /lottery view.',
  });

  // Audit: the 5 ticket rows are the append-only record; the refused buy added none.
  const finalTickets = drawing ? await ticketsForDrawing(handle, drawing.id) : [];
  ctx.expect(finalTickets.length === 5 && finalTickets.every((t) => t.user_id === userA), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Exactly 5 append-only ticket rows record the member’s buys; the refused over-cap buy appended none.',
    observation: `ticket rows=${finalTickets.length} (expected 5), all under actor ${userA}=${finalTickets.every((t) => t.user_id === userA)}.`,
    impact: 'The append-only ticket ledger did not match the accepted buys.',
  });

  proveBranding(ctx, view, '6h', 'schedule');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSchedulerDraw(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
}

/** SET-B — the wager cap is tunable independently: per-member max 1 → strictly one ticket per member. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 1, schedule: 'weekly' });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000);

  // First ticket accepted.
  const buy1 = await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 1 } });
  const drawing = await readActiveDrawing(handle);
  const afterBuy1 = await walletAmount(handle, userA);
  const tickets1 = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  ctx.expect(afterBuy1 === 900 && drawing?.jackpot === 100 && tickets1 === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'With per-member max 1, the first /lottery buy is accepted (debit 100, jackpot 100, one ticket).',
    observation: `after first buy: wallet=${afterBuy1} (expected 900), jackpot=${drawing?.jackpot} (expected 100), tickets=${tickets1} (expected 1).`,
    impact: 'The first ticket under a max-1 cap was not accepted correctly.',
  });

  // Second ticket refused with a branded cap message and fully refunded.
  const buy2 = await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 1 } });
  const afterBuy2 = await walletAmount(handle, userA);
  const tickets2 = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  ctx.expect(afterBuy2 === 900 && tickets2 === 1 && replyContent(buy2).toLowerCase().includes('maximum'), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A member’s second ticket is refused by the max-1 cap and the debit is refunded in full.',
    observation:
      `after refused second buy: wallet=${afterBuy2} (expected unchanged 900), tickets=${tickets2} (expected 1), ` +
      `reply="${truncate(replyContent(buy2))}".`,
    impact: 'The max-1 cap let a second ticket through, or did not refund the refused buy.',
  });

  // Draws keep working under the tight cap: the sole player wins the full pot exactly once.
  const preA = await walletAmount(handle, userA);
  const claimed = drawing ? await claimDrawing(handle, drawing.id) : null;
  const awarded = drawing ? await awardJackpot(handle, drawing.id) : null;
  const postA = await walletAmount(handle, userA);
  const finalDrawing = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(
    claimed?.winner_user_id === userA && awarded?.jackpot === 100 && postA === (preA ?? 0) + 100 && finalDrawing?.status === 'drawn',
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The scheduled draw still pays a single stable winner (the sole player) the full pot and finalises the drawing.',
      observation:
        `winner=${claimed?.winner_user_id} (expected ${userA}), jackpot=${awarded?.jackpot} (expected 100), ` +
        `wallet ${preA}→${postA}, status=${finalDrawing?.status} (expected drawn).`,
      impact: 'The draw stopped working when the wager cap was tightened.',
    },
  );

  proveBranding(ctx, buy1, '100', 'jackpot');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSchedulerDraw(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
}

/** INVALID — a rejected invalid config never persists (validation lives in the dashboard Zod layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000);

  // DB-observable core: guild_config retains its valid values (nothing invalid persisted).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('economy_lottery_ticket_price, economy_lottery_max_tickets')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as { economy_lottery_ticket_price: number; economy_lottery_max_tickets: number } | null;
  ctx.expect(cfg?.economy_lottery_ticket_price === 100 && cfg?.economy_lottery_max_tickets === 10, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config holds price=${cfg?.economy_lottery_ticket_price} (expected 100), max=${cfg?.economy_lottery_max_tickets} (expected 10).`,
    impact: 'A valid lottery configuration was not retained.',
  });

  // Live behavior unchanged on the very next command: /lottery buy honors the previous valid price + cap.
  const buy = await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 1 } });
  const drawing = await readActiveDrawing(handle);
  const afterBuy = await walletAmount(handle, userA);
  ctx.expect(afterBuy === 900 && drawing?.jackpot === 100, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Live bot behavior is unchanged after a rejected config save: the next /lottery buy debits the previous valid 100 price.',
    observation: `after buy: wallet=${afterBuy} (expected 900), jackpot=${drawing?.jackpot} (expected 100).`,
    impact: 'A rejected config attempt disturbed live bot behavior.',
  });

  // The actual REJECTION is enforced in the dashboard's Zod layer; the guild_config
  // lottery columns carry NO CHECK constraint (plain INTEGER/BOOLEAN/TEXT), so the
  // reject path is not reachable in a bot-only harness. GATE it honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard lottery page surfaces a clear validation error for a negative ticket price / a zero per-member max.',
    'config validation lives in the dashboard (Zod) layer; guild_config lottery columns have no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected lottery configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  proveBranding(ctx, buy, '100', 'jackpot');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
}

/** UNAUTH — a buy only ever spends the buyer's own wallet; no member-facing path can force a draw. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // run-member-b's /lottery buy debits ONLY b's wallet and adds tickets under b's id.
  const buyB = await runLottery(ctx, handle, { sub: 'buy', userId: userB, options: { tickets: 2 } });
  const drawing = await readActiveDrawing(handle);
  const walletA = await walletAmount(handle, userA);
  const walletB = await walletAmount(handle, userB);
  const tickets = drawing ? await ticketsForDrawing(handle, drawing.id) : [];
  ctx.expect(
    walletA === 1000 && walletB === 800 && tickets.length === 2 && tickets.every((t) => t.user_id === userB),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'A /lottery buy only ever debits the invoking member’s own wallet and files tickets under the invoking member’s id.',
      observation:
        `after B buys 2: A wallet=${walletA} (expected unchanged 1000), B wallet=${walletB} (expected 800), ` +
        `tickets=${tickets.length} all under B=${tickets.every((t) => t.user_id === userB)}.`,
      impact: 'A member’s buy touched another member’s wallet or filed tickets under the wrong id.',
    },
  );

  // No member-facing path can trigger a draw or reassign the jackpot: an (unsupported)
  // /lottery draw subcommand is a no-op — the drawing stays active with no winner.
  await runLottery(ctx, handle, { sub: 'draw', userId: userB });
  const afterAttempt = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(afterAttempt?.status === 'active' && afterAttempt?.winner_user_id === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'There is no member-facing draw command: a member cannot claim, draw, or reassign the jackpot.',
    observation:
      `after a member draw attempt the drawing status=${afterAttempt?.status} (expected active), winner=${afterAttempt?.winner_user_id} (expected none).`,
    impact: 'A member-facing path was able to influence the draw or the winner.',
  });

  // Audit: exactly the buyer's ticket rows exist (append-only, actor = buyer, guild scoped).
  ctx.expect(tickets.length === 2 && tickets.every((t) => t.user_id === userB && t.guild_id === handle.guildId), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Append-only ticket rows record only the buyer’s action, with the buyer id and guild id.',
    observation: `ticket rows=${tickets.length}, all actor=${userB}/guild=${handle.guildId} = ${tickets.every((t) => t.user_id === userB && t.guild_id === handle.guildId)}.`,
    impact: 'A ticket row recorded the wrong actor or guild.',
  });

  proveBranding(ctx, buyB, '200', 'jackpot');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  // The dashboard save-authorization facet is a dashboard session-auth + RLS lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save lottery settings (returns an authorization error).',
    'requires the dashboard session-auth lane (owner/admin RBAC on guild_config writes) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'An audit row records the denied lottery configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'During a Supabase outage, /lottery buy and /lottery view reply with the branded lottery-unavailable message and no coins move; after restoration a fresh buy debits exactly once.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed lottery command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'A draw tick during the outage logs and skips without crashing, and after restoration no ticket, jackpot, or payout is applied twice.',
    'requires the outage fault lane to exercise the degraded draw-tick path',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate ticket insert, jackpot increment, or payout survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded lottery-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the lottery-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Lottery rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a draw whose jackpot payout fails converges: the SAME stored winner is retried and paid exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  await seedWallet(handle, userA, 1000);
  await seedWallet(handle, userB, 1000);

  // Build a real pot with two players, then reproduce the exact state a failed
  // payout leaves: lottery_claim_drawing stored the winner but the drawing is not
  // yet paid (status 'drawing', winner_paid_at NULL). A first award "failing" is
  // equivalent to simply not awarding yet.
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 3 } });
  await runLottery(ctx, handle, { sub: 'buy', userId: userB, options: { tickets: 3 } });
  const drawing = await readActiveDrawing(handle);
  const claimed = drawing ? await claimDrawing(handle, drawing.id) : null;
  const storedWinner = claimed?.winner_user_id ?? null;
  const afterClaim = drawing ? await readDrawingById(handle, drawing.id) : null;

  ctx.expect(
    storedWinner !== null && afterClaim?.status === 'drawing' && afterClaim?.winner_user_id === storedWinner && afterClaim?.winner_paid_at === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After the claim, the drawing holds its single stored winner unpaid (status drawing) — the exact state a failed payout leaves.',
      observation: `stored winner=${storedWinner}, status=${afterClaim?.status} (expected drawing), winner_paid_at=${afterClaim?.winner_paid_at ? 'set' : 'null'} (expected null).`,
      impact: 'The claim did not store a stable winner or left the drawing in a payable-but-untracked state.',
    },
  );

  // Stable winner: a re-claim during the retry window cannot re-roll the winner
  // (the drawing is no longer 'active'), so the stored winner is immutable.
  const reClaim = drawing ? await claimDrawing(handle, drawing.id) : null;
  const afterReClaim = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(reClaim === null && afterReClaim?.winner_user_id === storedWinner, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The stored winner is stable across retries: a re-claim returns no row and never re-rolls the winner.',
    observation: `re-claim result=${reClaim === null ? 'no-op' : 'RE-ROLLED'}, winner still=${afterReClaim?.winner_user_id} (expected ${storedWinner}).`,
    impact: 'A retry re-rolled the winner — the draw is not stable across payout retries.',
  });

  // The next tick retries the SAME winner and pays the full jackpot exactly once.
  const preWinner = storedWinner ? await walletAmount(handle, storedWinner) : null;
  const awarded = drawing ? await awardJackpot(handle, drawing.id) : null;
  const secondAward = drawing ? await awardJackpot(handle, drawing.id) : null;
  const postWinner = storedWinner ? await walletAmount(handle, storedWinner) : null;
  const finalDrawing = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(
    awarded?.winner_user_id === storedWinner &&
      postWinner === (preWinner ?? 0) + 600 &&
      finalDrawing?.status === 'drawn' &&
      secondAward === null,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The retry pays the stored winner the full 600-coin jackpot exactly once and finalises the drawing; a further retry is a no-op.',
      observation:
        `awarded winner=${awarded?.winner_user_id} (expected ${storedWinner}), wallet ${preWinner}→${postWinner} (expected +600), ` +
        `status=${finalDrawing?.status} (expected drawn), second award=${secondAward === null ? 'no-op' : 'DOUBLE-PAID'}.`,
      impact: 'The retried payout re-rolled the winner or double-paid the jackpot.',
    },
  );

  proveBranding(ctx, await runLottery(ctx, handle, { sub: 'view', userId: userA }), 'weekly', 'schedule');
  await proveRlsIsolation(ctx, handle);
  // Happy-path-so-far raises no alert; the draw-degraded owner alert only fires on
  // the actual injected payout failure, which needs the fault lane + channel readback.
  await proveNoOwnerAlert(ctx, handle);
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner alert channel receives exactly one reasoned draw-degraded alert carrying the jackpot and "nothing was double-paid".',
    'requires a mid-draw fault-injection lane (fail lottery_award_jackpot after the claim) plus owner alert channel readback',
  );
  gateSchedulerDraw(ctx);
}

/** REPLAY — re-delivering triggers must not double-apply. Buys are NOT idempotent (a FAIL finding); draws ARE. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 10000);

  // (a) Re-deliver the SAME /lottery buy interaction id twice. The catalog promises
  //     replay-safety, but buyTickets has NO interaction-id idempotency key (unlike
  //     /pay, PR #301), so the second delivery double-charges — a FAIL finding.
  const buyId = `${ctx.runPrefix}replay-buy`;
  const opts = { tickets: 1 };
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: opts, interactionId: buyId });
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: opts, interactionId: buyId });
  const drawing = await readActiveDrawing(handle);
  const tickets = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  const wallet = await walletAmount(handle, userA);
  ctx.expect(wallet === 9900 && tickets === 1 && drawing?.jackpot === 100, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the /lottery buy interaction credits exactly one set of tickets and one debit (persisted idempotency key = interaction id).',
    observation:
      `after TWO deliveries of one /lottery buy interaction id: wallet=${wallet} (exactly-once expects 9900), ` +
      `tickets=${tickets} (expects 1), jackpot=${drawing?.jackpot} (expects 100). A double-apply reads 9800 / 2 / 200.`,
    impact:
      'A re-delivered identical /lottery buy double-charged: buyTickets does not dedupe on the interaction id (an idempotency gap on the money path, unlike /pay).',
  });

  // (b) The draw payout IS idempotent: award twice → a single jackpot credit and an
  //     unchanged stored winner.
  const preA = await walletAmount(handle, userA);
  const claimed = drawing ? await claimDrawing(handle, drawing.id) : null;
  const award1 = drawing ? await awardJackpot(handle, drawing.id) : null;
  const midWinner = drawing ? await readDrawingById(handle, drawing.id) : null;
  const award2 = drawing ? await awardJackpot(handle, drawing.id) : null;
  const postA = await walletAmount(handle, userA);
  const finalDrawing = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(
    claimed?.winner_user_id === userA &&
      award1?.winner_user_id === userA &&
      award2 === null &&
      postA === (preA ?? 0) + (drawing?.jackpot ?? 0) &&
      finalDrawing?.winner_user_id === midWinner?.winner_user_id,
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Re-delivering the draw payout yields exactly one jackpot credit and an unchanged stored winner.',
      observation:
        `award1 winner=${award1?.winner_user_id}, award2=${award2 === null ? 'no-op' : 'DOUBLE-PAID'}, ` +
        `wallet ${preA}→${postA} (expected +${drawing?.jackpot}), winner stable=${finalDrawing?.winner_user_id === midWinner?.winner_user_id}.`,
      impact: 'A replayed draw double-paid the jackpot or changed the stored winner.',
    },
  );

  proveBranding(ctx, await runLottery(ctx, handle, { sub: 'view', userId: userA }), 'weekly', 'schedule');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateSchedulerDraw(ctx);
}

/** RESTART — lottery state survives a full stack reboot; a claimed-but-unpaid drawing resumes and pays once. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Boot #1: build a pot, claim it (winner stored, payout pending), snapshot, shut down.
  const first = await bootLottery(ctx, { guildId, ticketPrice: 100, maxTickets: 10 });
  await seedWallet(first, userA, 1000);
  await seedWallet(first, userB, 1000);
  await runLottery(ctx, first, { sub: 'buy', userId: userA, options: { tickets: 2 } });
  await runLottery(ctx, first, { sub: 'buy', userId: userB, options: { tickets: 2 } });
  const drawingBefore = await readActiveDrawing(first);
  const claimed = drawingBefore ? await claimDrawing(first, drawingBefore.id) : null;
  const snapshot = drawingBefore ? await readDrawingById(first, drawingBefore.id) : null;
  const storedWinner = claimed?.winner_user_id ?? null;
  await first.cleanup(); // simulate shutdown (rows persist in Supabase)

  // Boot #2: SAME guild id. The claimed-but-unpaid drawing persists byte-for-byte.
  const second = await bootLottery(ctx, { guildId, ticketPrice: 100, maxTickets: 10 });
  const afterRestart = snapshot ? await readDrawingById(second, snapshot.id) : null;
  ctx.expect(
    afterRestart?.status === 'drawing' &&
      afterRestart?.winner_user_id === storedWinner &&
      afterRestart?.jackpot === snapshot?.jackpot &&
      afterRestart?.winner_paid_at === null &&
      snapshot?.jackpot === 400,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full restart the active drawing, its jackpot, and its stored winner persist exactly (state lives in Supabase).',
      observation:
        `pre-restart jackpot=${snapshot?.jackpot} winner=${storedWinner} status=${snapshot?.status}; ` +
        `post-restart jackpot=${afterRestart?.jackpot} winner=${afterRestart?.winner_user_id} status=${afterRestart?.status} (expected drawing/400).`,
      impact: 'Lottery state did not survive a restart — the claimed drawing or its stored winner was lost/altered.',
    },
  );

  // The first post-restart tick pays the stored winner exactly once — never a second draw.
  const preWinner = storedWinner ? await walletAmount(second, storedWinner) : null;
  const awarded = snapshot ? await awardJackpot(second, snapshot.id) : null;
  const secondAward = snapshot ? await awardJackpot(second, snapshot.id) : null;
  const postWinner = storedWinner ? await walletAmount(second, storedWinner) : null;
  const finalDrawing = snapshot ? await readDrawingById(second, snapshot.id) : null;
  ctx.expect(
    awarded?.winner_user_id === storedWinner && postWinner === (preWinner ?? 0) + 400 && finalDrawing?.status === 'drawn' && secondAward === null,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A claimed-but-unpaid drawing resumes after restart and pays its stored winner exactly once (no re-roll, no double draw).',
      observation:
        `resumed winner=${awarded?.winner_user_id} (expected ${storedWinner}), wallet ${preWinner}→${postWinner} (expected +400), ` +
        `status=${finalDrawing?.status} (expected drawn), second tick=${secondAward === null ? 'no-op' : 'DOUBLE-PAID'}.`,
      impact: 'The restart-spanning drawing double-paid or re-rolled its winner.',
    },
  );

  // Audit: the pre-restart draw outcome persists as the append-only record.
  ctx.expect(finalDrawing?.winner_user_id === storedWinner && finalDrawing?.winning_number === snapshot?.winning_number, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The pre-restart draw outcome (winner + winning ticket number) persists across the restart.',
    observation: `winner ${snapshot?.winner_user_id}→${finalDrawing?.winner_user_id}, winning_number ${snapshot?.winning_number}→${finalDrawing?.winning_number}.`,
    impact: 'The draw outcome record did not survive the restart.',
  });

  // A /lottery view after restart renders (the drawing is mid-draw → "no active drawing").
  const view = await runLottery(ctx, second, { sub: 'view', userId: userA });
  proveBranding(ctx, view, 'Lottery', 'brand title');
  await proveRlsIsolation(ctx, second);
  await proveNoOwnerAlert(ctx, second);
  gateSchedulerDraw(ctx);
}

/** RACE — concurrent lottery actions serialize: exactly one claim wins; a buy reaching a claimed drawing is rejected. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000);

  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 2 } });
  const drawing = await readActiveDrawing(handle);
  const buyReply = await runLottery(ctx, handle, { sub: 'view', userId: userA });

  // (a) Two simultaneous draw ticks: both claim the SAME drawing under the row lock;
  //     exactly one wins the claim, the other is a no-op.
  const [c1, c2] = await Promise.all([
    drawing ? claimDrawing(handle, drawing.id) : Promise.resolve(null),
    drawing ? claimDrawing(handle, drawing.id) : Promise.resolve(null),
  ]);
  const winners = [c1, c2].filter((r) => r !== null);
  const afterClaim = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(winners.length === 1 && afterClaim?.status === 'drawing' && afterClaim?.winner_user_id !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous draw ticks claim the drawing exactly once (one winner stored, the other a no-op).',
    observation:
      `concurrent claims returning a row=${winners.length} (expected 1); drawing status=${afterClaim?.status} (expected drawing), ` +
      `stored winner=${afterClaim?.winner_user_id ?? 'none'}.`,
    impact: 'A concurrent double-claim stored two winners or left the drawing unclaimed — the claim did not serialize.',
  });

  // (b) A buy that reaches the row lock AFTER the claim is rejected by the post-lock
  //     status guard ('is not active'), so the bot refunds — never unwinnable tickets.
  const ticketsBefore = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  const jackpotBefore = afterClaim?.jackpot ?? 0;
  const { error: buyErr } = await handle.supabase.rpc('lottery_buy_tickets', {
    p_drawing_id: drawing?.id,
    p_guild_id: handle.guildId,
    p_user_id: userA,
    p_count: 1,
    p_max: 10,
    p_cost: 100,
  });
  const ticketsAfter = drawing ? (await ticketsForDrawing(handle, drawing.id)).length : 0;
  const jackpotAfter = drawing ? (await readDrawingById(handle, drawing.id))?.jackpot ?? 0 : 0;
  ctx.expect(
    buyErr !== null &&
      (buyErr.message?.includes('is not active') ?? false) &&
      ticketsAfter === ticketsBefore &&
      jackpotAfter === jackpotBefore,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A buy that reaches a claimed drawing’s row lock is rejected (so the bot refunds), never appending unwinnable tickets or inflating the pot.',
      observation:
        `lottery_buy_tickets on the claimed drawing error=${buyErr ? buyErr.message : 'none'} (expected "is not active"); ` +
        `tickets ${ticketsBefore}→${ticketsAfter} (expected unchanged), jackpot ${jackpotBefore}→${jackpotAfter} (expected unchanged).`,
      impact: 'A buy racing the draw appended unwinnable tickets or inflated the jackpot — the row-lock serialization failed.',
    },
  );

  // Pay the single claimed winner once to finalise (audit record).
  const awarded = drawing ? await awardJackpot(handle, drawing.id) : null;
  const finalDrawing = drawing ? await readDrawingById(handle, drawing.id) : null;
  ctx.expect(awarded?.winner_user_id === afterClaim?.winner_user_id && finalDrawing?.status === 'drawn', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The single claimed winner is paid once and the drawing finalises to drawn (one append-only outcome).',
    observation: `awarded winner=${awarded?.winner_user_id}, claimed winner=${afterClaim?.winner_user_id}, final status=${finalDrawing?.status}.`,
    impact: 'The raced draw did not finalise a single winner.',
  });

  proveBranding(ctx, buyReply, 'weekly', 'schedule');
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  // The wall-clock buy⇄draw race through the dispatcher's refund branch needs
  // concurrency injection (buyTickets re-opens a fresh active drawing rather than
  // racing the claimed one), so the branded refund reply is GATED.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A /lottery buy landing exactly as the scheduler draws shows either a normal confirmation or the branded refund message, never unwinnable tickets.',
    'reproducing the wall-clock buy⇄draw refund branch through the dispatcher needs concurrency injection; the RPC-level row-lock guard it relies on is proven DB-observably',
  );
}

/** XGUILD — the lottery is strictly per-guild: buying and drawing in guild B never touches guild A. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await bootLottery(ctx, { guildId: guildA, ticketPrice: 100, maxTickets: 10 });
  const handleB = await bootLottery(ctx, { guildId: guildB, ticketPrice: 300, maxTickets: 10 });

  await seedWallet(handleA, userA, 1000);
  await seedWallet(handleB, userA, 1000);

  // Guild A: buy 2 (jackpot 200) and snapshot.
  await runLottery(ctx, handleA, { sub: 'buy', userId: userA, options: { tickets: 2 } });
  const drawingA0 = await readActiveDrawing(handleA);
  const walletA0 = await walletAmount(handleA, userA);
  const ticketsA0 = drawingA0 ? (await ticketsForDrawing(handleA, drawingA0.id)).length : 0;

  // Guild B: same user buys at guild B's OWN price (300), then a full draw in B.
  const buyB = await runLottery(ctx, handleB, { sub: 'buy', userId: userA, options: { tickets: 1 } });
  const drawingB = await readActiveDrawing(handleB);
  const claimedB = drawingB ? await claimDrawing(handleB, drawingB.id) : null;
  const awardedB = drawingB ? await awardJackpot(handleB, drawingB.id) : null;

  // Guild A is completely unchanged by all guild B activity.
  const drawingAAfter = drawingA0 ? await readDrawingById(handleA, drawingA0.id) : null;
  const walletAAfter = await walletAmount(handleA, userA);
  const ticketsAAfter = drawingA0 ? (await ticketsForDrawing(handleA, drawingA0.id)).length : 0;
  ctx.expect(
    walletAAfter === walletA0 &&
      walletA0 === 800 &&
      drawingAAfter?.status === 'active' &&
      drawingAAfter?.jackpot === 200 &&
      ticketsAAfter === ticketsA0 &&
      ticketsA0 === 2 &&
      drawingB?.guild_id === guildB &&
      awardedB?.jackpot === 300,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Buying and drawing in guild B never touches guild A’s drawing/tickets/wallet; guild B uses its own 300 price and jackpot.',
      observation:
        `guild A wallet ${walletA0}→${walletAAfter} (unchanged 800), drawing status=${drawingAAfter?.status}/jackpot=${drawingAAfter?.jackpot} (active/200), ` +
        `tickets=${ticketsAAfter} (2); guild B jackpot=${awardedB?.jackpot} (300) under guild "${drawingB?.guild_id}".`,
      impact: 'Cross-guild lottery activity mutated another guild’s drawing, tickets, or wallet — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN distinct ticket rows and never the other's.
  const bTickets = drawingB ? await ticketsForDrawing(handleB, drawingB.id) : [];
  const aTickets = drawingA0 ? await ticketsForDrawing(handleA, drawingA0.id) : [];
  ctx.expect(
    bTickets.length === 1 &&
      bTickets.every((t) => t.guild_id === guildB) &&
      aTickets.length === 2 &&
      aTickets.every((t) => t.guild_id === guildA),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: 'Each guild scope reads its OWN lottery ticket rows and never the other guild’s (distinct guild_ids).',
      observation:
        `guild-B-scoped tickets=${bTickets.length} all under "${guildB}"=${bTickets.every((t) => t.guild_id === guildB)}; ` +
        `guild-A-scoped tickets=${aTickets.length} all under "${guildA}"=${aTickets.every((t) => t.guild_id === guildA)}.`,
      impact: 'A guild-scoped read returned another guild’s lottery ticket rows — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA);

  // Audit: guild B's draw outcome is recorded under guild B only.
  const finalB = drawingB ? await readDrawingById(handleB, drawingB.id) : null;
  ctx.expect(finalB?.guild_id === guildB && finalB?.winner_user_id === claimedB?.winner_user_id && finalB?.status === 'drawn', {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Guild B keeps its own draw-outcome record; it does not cross into guild A.',
    observation: `guild B drawing outcome under guild=${finalB?.guild_id} winner=${finalB?.winner_user_id} status=${finalB?.status}.`,
    impact: 'A draw-outcome record crossed guilds.',
  });

  proveBranding(ctx, buyB, '300', 'jackpot');
  await proveNoOwnerAlert(ctx, handleA);
  gateSchedulerDraw(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RETRY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed lottery rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await bootLottery(ctx, { label: 'a', ticketPrice: 100, maxTickets: 10 });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 1000);

  // Create run-prefixed operational rows: a wallet, a drawing, ticket rows.
  await runLottery(ctx, handle, { sub: 'buy', userId: userA, options: { tickets: 3 } });
  const drawing = await readActiveDrawing(handle);

  const ticketsBefore = await guildTicketCount(handle);
  const drawingsBefore = await guildDrawingCount(handle);
  ctx.expect(ticketsBefore >= 3 && drawingsBefore >= 1 && drawing !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed drawing + ticket + wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: ticket rows=${ticketsBefore}, drawing rows=${drawingsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  proveBranding(ctx, await runLottery(ctx, handle, { sub: 'view', userId: userA }), 'weekly', 'schedule');

  // The buy above emitted `lottery.ticket_purchased`; flush it to its audit_logs row
  // BEFORE the sweep so the post-sweep read proves audit history is RETAINED (audit
  // rows are intentionally NOT among the domain's swept tables).
  const cleanupAuditFlushed = await flushAuditQueue(handle);
  const auditBeforeSweep = cleanupAuditFlushed ? await readLotteryAuditRows(handle) : null;

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const ticketsAfter = await guildTicketCount(handle);
  const drawingsAfter = await guildDrawingCount(handle);
  const walletsAfter = await (async () => {
    const { count } = await handle.supabase
      .from('economy_wallets')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', handle.guildId);
    return count ?? 0;
  })();
  ctx.expect(ticketsAfter === 0 && drawingsAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed ticket, drawing, and wallet rows are deleted; a final sweep finds zero run-prefixed lottery resources.',
    observation: `post-sweep: ticket rows=${ticketsAfter}, drawing rows=${drawingsAfter}, wallet rows=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed lottery rows behind — the suite leaves residue.',
  });

  // Audit history is RETAINED, not deleted, by cleanup: the buy's append-only
  // audit_logs row (flushed before the sweep) survives the sweep that cleared every
  // operational ticket/drawing/wallet/alert row (audit_logs is deliberately not a
  // swept table). Prove it DB-observably.
  if (auditBeforeSweep === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'Cleanup deletes the operational lottery rows but RETAINS the append-only audit_logs history.',
      'the per-guild AuditService was not resolvable or the audit_logs read errored, so audit retention could not be evaluated',
    );
  } else {
    const auditAfterSweep = await readLotteryAuditRows(handle);
    const buyBefore = auditBeforeSweep.filter((r) => r.action === 'lottery.ticket_purchased').length;
    const buyAfter = (auditAfterSweep ?? []).filter((r) => r.action === 'lottery.ticket_purchased').length;
    ctx.expect(buyBefore >= 1 && auditAfterSweep !== null && buyAfter >= buyBefore, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise:
        'Cleanup deletes the operational lottery rows but RETAINS the append-only audit_logs history (audit rows are never swept — only anonymized in place).',
      observation:
        `lottery audit rows before sweep=${buyBefore} (expected ≥1), after sweep=${buyAfter} (expected ≥ before — retained).`,
      impact:
        'The cleanup sweep deleted append-only audit_logs history — the audit trail is not retained across cleanup.',
    });
  }
  // Still gated: the in-place ANONYMIZATION of the retained rows (PII scrubbed, row
  // kept) runs through the retention scrub on a 60-day+ window, out of reach here.
  ctx.gate(
    'audit',
    'discord-readback',
    'The retained audit_logs rows are ANONYMIZED in place (PII scrubbed) rather than deleted.',
    'in-place anonymization runs via the retention scrub (scrub_expired_audit_logs, hard 60-day floor); a fast harness cannot age rows past the window, so the anonymize-not-delete transform needs the retention-scrub lane',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed ticket confirmations, win announcements, or reset notices after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ──────────────────────────────────────────────────────

/**
 * The Transparent Lottery domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before the guild row),
 * plus the 12 scenario scripts.
 */
export const gameEconomyLotteryProof: DomainProof = {
  domainId: 'game-economy-lottery',
  guildScopedTables: [
    // child → parent: tickets FK drawings + guild_config; drawings FK guild_config.
    'economy_lottery_tickets',
    'economy_lottery_drawings',
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
