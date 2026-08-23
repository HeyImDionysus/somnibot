/**
 * scenario-runner/scripts/community-giveaways — the giveaways domain proof.
 *
 * Binds the community-giveaways domain's 12 declarative catalog scenarios to
 * concrete real-stack proofs driven against LOCAL Supabase. Every DB-observable /
 * RLS / replay-safety assertion runs NOW through the REAL production giveaway
 * primitives; anything needing a live Discord effect, a fault-injection lane, or a
 * dashboard/API surface is GATED — never faked.
 *
 * The hard harness boundary for THIS domain (why it is mostlyGated):
 *   - `/giveaway` is a SUBCOMMAND command (start/end/reroll/pause/resume/list).
 *     Since PR #331 `runSlash` CAN supply a subcommand — DEPFAIL drives the real
 *     `/giveaway end` draw path through the dispatcher on the fault lane — but the
 *     member-facing Discord surfaces (posting the entry-button campaign, the
 *     ephemeral confirmations, the winner announcement/DM) still need a live
 *     channel/gateway and remain GATED in the other scenarios.
 *   - The entry BUTTON handler needs a live `guild.members.cache` member + gateway
 *     (it replies "could not find your member data" against the gateway-less
 *     minimal guild), so button entries + gate enforcement are GATED too.
 *   - Giveaway winner DMs, channel announcements, and the branded embeds are live
 *     Discord effects → GATED (DISCORD_TOKEN + live guild).
 *
 * What DOES run for real: the durable data layer the bot actually uses — the
 * `giveaways` table (schema, guild-scoped RLS, cross-guild isolation, restart
 * persistence, cleanup) and the REAL production RPCs the manager calls
 * (`giveaway_add_entry` — atomic + unique-per-member, `giveaway_atomic_end` —
 * exactly-once status-gated draw, `giveaway_atomic_reroll`). These carry the
 * concurrency / idempotency / isolation contracts, so they are asserted live by
 * driving the exact RPCs and reading the row back.
 *
 * Behavior notes surfaced to the owner (recorded as GATED with a precise reason,
 * NOT faked green): the giveaway feature writes NO audit_logs / alerts rows, and
 * the catalog's `entry-button-label` / `dm-winners` / `winner-announcement-style`
 * / `default-winner-count` controls have no guild_config columns and are not read
 * by the manager. Those contracts cannot be exercised by a bot-only harness (their
 * owning layer — command handler / Discord render — is undrivable), so they GATE.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Small live-stack helpers ──────────────────────────────────────────────

const GIVEAWAY_COLUMNS =
  'id, guild_id, prize, winner_count, entries, winners, status, ends_at, required_role_id, required_level, channel_id, created_by';

interface GiveawayRow {
  id: string;
  guild_id: string;
  prize: string;
  winner_count: number;
  entries: string[];
  winners: string[];
  status: 'active' | 'ended' | 'cancelled' | 'paused';
  ends_at: string;
  required_role_id: string | null;
  required_level: number | null;
  channel_id: string;
  created_by: string;
}

interface SeedGiveawayOptions {
  prize: string;
  channelId: string;
  createdBy: string;
  winnerCount?: number;
  status?: GiveawayRow['status'];
  /** ISO string; defaults to one hour in the FUTURE so the manager's background
   *  `checkExpired` sweep never races the test by auto-ending the seeded row. */
  endsAt?: string;
  requiredRoleId?: string | null;
  requiredLevel?: number | null;
  entries?: string[];
  winners?: string[];
}

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/**
 * A canonical Discord-snowflake-shaped id (18 digits) derived deterministically
 * from the run-scoped user label. `giveaway_atomic_end` / `giveaway_atomic_reroll`
 * validate EVERY winner against `^[0-9]{17,20}$` (real winners are Discord
 * snowflakes drawn from the entrant pool), so any entrant that may be drawn as a
 * winner must be a snowflake here — the plain `ctx.userId(...)` labels are not.
 * Seeds off `ctx.userId(label)` so the value stays unique per run + label and
 * never collides with another scenario's members.
 */
function member(ctx: ScenarioContext, label: string): string {
  const seed = ctx.userId(label);
  let h = 1469598103934665603n; // FNV-1a 64-bit offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= BigInt(seed.charCodeAt(i));
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  // Map into [100000000000000000, 999999999999999999] — always 18 digits.
  return (100000000000000000n + (h % 900000000000000000n)).toString();
}

/**
 * Insert one giveaway row through the service-role client (the exact table the
 * production manager writes). Returns the persisted row (with its DB-minted id),
 * or null when the insert errored.
 */
async function seedGiveaway(
  handle: LiveClientHandle,
  opts: SeedGiveawayOptions,
): Promise<GiveawayRow | null> {
  const endsAt = opts.endsAt ?? new Date(Date.now() + 60 * 60_000).toISOString();
  const { data, error } = await handle.supabase
    .from('giveaways')
    .insert({
      guild_id: handle.guildId,
      channel_id: opts.channelId,
      prize: opts.prize,
      winner_count: opts.winnerCount ?? 1,
      ends_at: endsAt,
      status: opts.status ?? 'active',
      created_by: opts.createdBy,
      required_role_id: opts.requiredRoleId ?? null,
      required_level: opts.requiredLevel ?? null,
      entries: opts.entries ?? [],
      winners: opts.winners ?? [],
    })
    .select(GIVEAWAY_COLUMNS)
    .single();
  if (error || !data) return null;
  return data as GiveawayRow;
}

async function readGiveaway(handle: LiveClientHandle, giveawayId: string): Promise<GiveawayRow | null> {
  const { data } = await handle.supabase
    .from('giveaways')
    .select(GIVEAWAY_COLUMNS)
    .eq('id', giveawayId)
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as GiveawayRow | null) ?? null;
}

async function giveawayCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('giveaways')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Drive the REAL `giveaway_add_entry` RPC (SECURITY DEFINER, service-role only):
 * atomic array_append that only matches when the giveaway is `active` AND the user
 * is not already entered (unique-per-member). Returns whether the RPC matched
 * (appended) so callers can distinguish a real add from an idempotent no-op.
 */
async function addEntry(
  handle: LiveClientHandle,
  giveawayId: string,
  userId: string,
): Promise<{ matched: boolean }> {
  const { data, error } = await handle.supabase.rpc('giveaway_add_entry', {
    p_giveaway_id: giveawayId,
    p_user_id: userId,
  });
  if (error) return { matched: false };
  const rows = (data as Array<{ entries: string[] }> | null) ?? [];
  return { matched: rows.length > 0 };
}

/**
 * Drive the REAL `giveaway_atomic_end` RPC: flips status `active`→`ended` and
 * commits the winner set ONLY when the row is still `active`. Returns whether THIS
 * caller won the race (the exactly-once draw gate).
 */
async function atomicEnd(
  handle: LiveClientHandle,
  giveawayId: string,
  winners: string[],
): Promise<{ won: boolean }> {
  const { data, error } = await handle.supabase.rpc('giveaway_atomic_end', {
    p_giveaway_id: giveawayId,
    p_winners: winners,
    p_ended_at: new Date().toISOString(),
  });
  if (error) return { won: false };
  const rows = (data as unknown[] | null) ?? [];
  return { won: rows.length > 0 };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

function isSubset(sub: readonly string[], sup: readonly string[]): boolean {
  const s = new Set(sup);
  return sub.every((x) => s.has(x));
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
 * rows an anon key can read (RLS owner_full_access → 0 for a non-owner/anon), or
 * null when no anon key / an inconclusive gateway rejection.
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
    // from the table by RLS / a missing GRANT — the deny we want to prove, SQLSTATE
    // 42501 "permission denied for table") from the KEY being rejected before authz
    // ran (inconclusive → null → GATE).
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
 * Prove the giveaway's happy path raises no owner alert (DB-observable via the
 * `alerts` table), and GATE the failure-branch `giveaway-alert` (needs a live
 * owner channel + a fault-injected failure).
 */
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
      impact: 'An owner alert was raised on a giveaway happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Failure-branch giveaway-alerts carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected giveaway failure branch',
  );
}

/**
 * Prove guild-scoped RLS on `giveaways`: the service role reads THIS guild's
 * seeded giveaway row (positive control) while an anon client reads zero of them
 * (owner_full_access denies anon). GATEs (never fakes) when no anon key / probe
 * inconclusive — cross-guild scoping is still proven separately in XGUILD.
 */
async function proveGiveawayRls(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  giveawayId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero giveaways rows (owner_full_access RLS policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'giveaways', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero giveaways rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readGiveaway(handle, giveawayId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s giveaway row while an anon client reads zero of them (owner_full_access RLS).',
    observation:
      `service-role sees the seeded giveaway under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} giveaways row(s) for that guild.`,
    impact:
      'A giveaway row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
  });
}

/**
 * GATE every member-facing giveaway surface: the branded entry-button campaign,
 * ephemeral entry confirmations/blocks, the winner announcement, and winner DMs —
 * none are drivable here (`/giveaway` is subcommand-based; entry buttons need a
 * live member cache + gateway; announcements/DMs are live Discord effects).
 */
function gateMemberFacingSurfaces(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The /giveaway command posts the branded entry-button campaign, confirms each entrant, and delivers exactly-once winner announcement + DM in the live guild.',
    'runSlash can now supply the /giveaway subcommand, but entry buttons still need a live members cache + gateway; announcements/DMs are live Discord effects (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing giveaway surface shows the owner brand name, colors, and voice preset with zero stock-bot wording.',
    'the command confirmation can be driven in-process, but the campaign embed/entry button and winner notifications require live Discord message effects, so no equivalent branded campaign surface is captured here',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on the giveaway embed.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * GATE the audit contract. The catalog contracts an append-only audit row per
 * giveaway state change, but neither the command handler nor the low-level
 * RPCs write an audit row today — so this
 * cannot be exercised or fairly failed by a bot-only harness. Surfaced loudly.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every giveaways state change lands exactly one append-only audit row with actor, guild, and correlation id.',
    'giveaway dashboard mutations and bot lifecycle events have occurrence-keyed audit paths; proving each action requires the authenticated dashboard or live Discord interaction followed by audit_logs readback',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate winner draws, notifications, or entry confirmations.',
    `replay/idempotency of the durable draw is exercised directly in the ${where} scenario`,
  );
}

/** GATE all seven classes behind a fault-injection lane (outage / mid-op fault). */
function gateFaultLane(ctx: ScenarioContext, lane: string): void {
  ctx.gate(
    'Discord',
    'db-observable',
    'No premature/partial/duplicate announcement or notification results from the fault; the draw completes exactly once after recovery/retry.',
    `${lane} (the harness deliberately runs against a reachable local Supabase and a gateway-less client)`,
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Giveaway/entry rows stay guild-scoped through the fault window.',
    lane,
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The append-only audit trail records the fault and its recovery/retry with no gap or duplicate.',
    `${lane}; the audited failure requires the real winner-announcement branch and audit_logs readback`,
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one giveaway-alert describes the delayed/failed draw and its recovery.',
    `${lane} plus owner alert channel readback (DISCORD_TOKEN + live guild)`,
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'Any degradation reply uses the branded template in the owner voice.',
    `${lane} to reach the degraded branch`,
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate winner draw, notification, or entry survives the fault/recovery cycle.',
    lane,
  );
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run-prefixed giveaway rows created around the fault are still swept to zero afterwards.',
    `${lane}; end-to-end cleanup is proven in the CLEANUP scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box: unique entries, exactly-once fair draw, durable end. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const defaultWinners = Number(declaredDefault(ctx.domain, 'default-winner-count'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');
  const userC = member(ctx, 'c');

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}nitro`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    winnerCount: defaultWinners,
  });
  ctx.expect(giveaway !== null && giveaway.winner_count === defaultWinners, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `A started giveaway persists with the default winner count (${defaultWinners}) and its prize, active out of the box.`,
    observation: `seeded giveaway id=${giveaway?.id ?? '(none)'}, winner_count=${giveaway?.winner_count}, status=${giveaway?.status}.`,
    impact: 'The giveaway row did not persist with the contracted default winner count / active state.',
  });
  const giveawayId = giveaway!.id;

  // 1) Three distinct entrants each store exactly once; a duplicate click no-ops
  //    (giveaway_add_entry: array_append gated on NOT (user = ANY(entries))).
  await addEntry(handle, giveawayId, userA);
  await addEntry(handle, giveawayId, userB);
  await addEntry(handle, giveawayId, userC);
  const dupAdd = await addEntry(handle, giveawayId, userA); // duplicate — must no-op
  const afterEntries = await readGiveaway(handle, giveawayId);
  ctx.expect(
    !dupAdd.matched && afterEntries !== null && sameSet(afterEntries.entries, [userA, userB, userC]),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each entrant is stored exactly once; a repeat entry from the same member is not duplicated (unique per member).',
      observation:
        `entries after 3 distinct + 1 duplicate add = [${afterEntries?.entries.join(', ')}] ` +
        `(duplicate matched=${dupAdd.matched}); expected the 3 distinct entrants once each.`,
      impact: 'A member entry was lost or duplicated — the atomic unique-per-member entry contract is broken.',
    },
  );

  // 2) The draw commits exactly `defaultWinners` winner(s) drawn from the entrants
  //    and flips the giveaway to `ended` (giveaway_atomic_end).
  const winnerPick = [userB]; // one entrant; real fairness (crypto pick) lives in the gated manager
  const end1 = await atomicEnd(handle, giveawayId, winnerPick);
  const afterEnd = await readGiveaway(handle, giveawayId);
  ctx.expect(
    end1.won &&
      afterEnd !== null &&
      afterEnd.status === 'ended' &&
      afterEnd.winners.length === defaultWinners &&
      isSubset(afterEnd.winners, afterEnd.entries),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `At end time exactly ${defaultWinners} winner(s) are drawn from the entrants and the giveaway becomes ended.`,
      observation:
        `after end: status=${afterEnd?.status}, winners=[${afterEnd?.winners.join(', ')}] ` +
        `(${afterEnd?.winners.length}), all winners ∈ entrants=${afterEnd ? isSubset(afterEnd.winners, afterEnd.entries) : false}.`,
      impact: 'The draw did not commit the contracted number of winners from the entrant pool.',
    },
  );

  // 3) Re-delivering the end (a scheduler tick + a manual end) draws exactly once:
  //    the second giveaway_atomic_end finds status='ended' and no-ops.
  const end2 = await atomicEnd(handle, giveawayId, [userA]);
  const afterReEnd = await readGiveaway(handle, giveawayId);
  ctx.expect(
    !end2.won && afterReEnd !== null && sameSet(afterReEnd.winners, winnerPick),
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A second end trigger never re-draws: the winner set is committed exactly once (status-gated atomic end).',
      observation:
        `second end won=${end2.won} (expected false); winners still [${afterReEnd?.winners.join(', ')}] (unchanged).`,
      impact: 'A re-delivered end re-drew or overwrote winners — the exactly-once draw guarantee is broken.',
    },
  );

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'Winner selection is a uniform crypto-random draw (Fisher-Yates over unique entries) observed in the live guild.',
    'the random winner pick lives in the gateway-bound GiveawayManager; only its durable committed result is DB-observable here',
  );
}

/** SET-A — entry gates (required role + minimum level) are configured on start. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = ctx.userId('a');
  const requiredRole = `${ctx.runPrefix}role-req`;
  const requiredLevel = 5;

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}gated-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    requiredRoleId: requiredRole,
    requiredLevel,
  });
  ctx.expect(
    giveaway !== null && giveaway.required_role_id === requiredRole && giveaway.required_level === requiredLevel,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'Entry gates configured on start persist on the giveaway row: required_role and required_level are stored as given.',
      observation:
        `stored required_role_id=${giveaway?.required_role_id} (expected ${requiredRole}), ` +
        `required_level=${giveaway?.required_level} (expected ${requiredLevel}).`,
      impact: 'The configured entry gates did not persist on the giveaway — a saved start setting was dropped.',
    },
  );
  const giveawayId = giveaway!.id;

  // A qualifying entry is accepted and stored (the gate CHECK itself — role/level
  // membership — is evaluated in the gateway-bound button handler, not the RPC).
  const qualifying = await addEntry(handle, giveawayId, userA);
  const afterEntry = await readGiveaway(handle, giveawayId);
  ctx.expect(qualifying.matched && afterEntry !== null && sameSet(afterEntry.entries, [userA]), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A qualifying member’s entry is accepted and stored under the giveaway.',
    observation: `entries after a qualifying entry = [${afterEntry?.entries.join(', ')}] (expected the one qualifying member).`,
    impact: 'A qualifying entry was not stored.',
  });

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'A member missing the required role or below the required level is blocked with the friendly entry-blocked ephemeral and stores no entry row.',
    'gate ENFORCEMENT lives in the button handler (member.roles.cache + member_levels), which needs a live members cache + gateway; the entry button is not drivable in this harness',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — a second config: two winners drawn; DM-off + custom label are Discord-side. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');
  const userC = member(ctx, 'c');

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}double-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    winnerCount: 2,
    entries: [userA, userB, userC],
  });
  ctx.expect(giveaway !== null && giveaway.winner_count === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A two-winner giveaway persists winner_count=2.',
    observation: `seeded winner_count=${giveaway?.winner_count} (expected 2).`,
    impact: 'The two-winner configuration did not persist.',
  });
  const giveawayId = giveaway!.id;

  // The draw commits exactly two DISTINCT winners from the entrant pool.
  const winners = [userA, userC];
  const end = await atomicEnd(handle, giveawayId, winners);
  const afterEnd = await readGiveaway(handle, giveawayId);
  ctx.expect(
    end.won &&
      afterEnd !== null &&
      afterEnd.status === 'ended' &&
      afterEnd.winners.length === 2 &&
      new Set(afterEnd.winners).size === 2 &&
      isSubset(afterEnd.winners, afterEnd.entries),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Exactly two distinct winners are drawn from the entrants and committed durably.',
      observation:
        `after end: status=${afterEnd?.status}, winners=[${afterEnd?.winners.join(', ')}] ` +
        `(distinct=${afterEnd ? new Set(afterEnd.winners).size : 0}), all ∈ entrants=${afterEnd ? isSubset(afterEnd.winners, afterEnd.entries) : false}.`,
      impact: 'The two-winner draw did not commit two distinct entrants as winners.',
    },
  );

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  // The four config controls now HAVE guild_config columns and the manager reads
  // them (buildEntryButton label, getDefaultWinnerCount, embed-vs-plain
  // announcement, dmWinnersEnabled). Prove they persist per-guild + read back.
  await handle.supabase.from('guild_config').upsert(
    {
      guild_id: handle.guildId,
      giveaway_default_winner_count: 3,
      giveaway_dm_winners: false,
      giveaway_entry_button_label: 'Join the fun!',
      giveaway_winner_announcement_style: 'plain',
    },
    { onConflict: 'guild_id' },
  );
  const { data: gcfg } = await handle.supabase
    .from('guild_config')
    .select('giveaway_default_winner_count, giveaway_dm_winners, giveaway_entry_button_label, giveaway_winner_announcement_style')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = gcfg as {
    giveaway_default_winner_count?: number;
    giveaway_dm_winners?: boolean;
    giveaway_entry_button_label?: string;
    giveaway_winner_announcement_style?: string;
  } | null;
  ctx.expect(
    cfg?.giveaway_default_winner_count === 3 &&
      cfg?.giveaway_dm_winners === false &&
      cfg?.giveaway_entry_button_label === 'Join the fun!' &&
      cfg?.giveaway_winner_announcement_style === 'plain',
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'The four giveaway config controls (default-winner-count, dm-winners, entry-button-label, winner-announcement-style) persist per-guild and read back as saved.',
      observation:
        `read back winner_count=${cfg?.giveaway_default_winner_count}, dm_winners=${cfg?.giveaway_dm_winners}, ` +
        `label=${JSON.stringify(cfg?.giveaway_entry_button_label)}, style=${cfg?.giveaway_winner_announcement_style}.`,
      impact: 'A giveaway config control does not persist, so a saved dashboard setting would not take effect.',
    },
  );
  // The columns persist + the manager reads them; the VISUAL render (the branded
  // button label, the embed-vs-plain announcement, the suppressed DM) is a live
  // Discord effect that still needs a gateway to observe.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The custom entry-button label renders, no winner DMs are sent (dm-winners off), and the channel announcement carries the durable notification.',
    'the config columns persist and the manager reads them (proven above); the button/DM/announcement are live Discord effects that require a gateway + live guild to observe',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a disabled/invalid start creates no giveaway; the master switch denies. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  // Boot with giveaways DISABLED (the runner's default seed): driving /giveaway
  // through the REAL dispatcher then reaches the master-switch denial branch.
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');

  // The REAL production dispatcher denies /giveaway when the feature is off.
  const denied = await ctx.runSlash(handle, { commandName: 'giveaway', userId: admin, displayName: 'INVALID admin' });
  const deniedContent = replyContent(denied);
  ctx.expect(deniedContent.toLowerCase().includes('not enabled'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With giveaways disabled, /giveaway is denied through the real dispatcher and creates no campaign.',
    observation: `dispatcher reply = "${deniedContent}" (expected the giveaways-not-enabled denial).`,
    impact: 'A disabled giveaways feature did not deny the command — the master switch was not honored.',
  });
  ctx.expect((await giveawayCount(handle)) === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A denied/invalid start creates no giveaway row.',
    observation: `giveaways rows for the guild after the denied command = ${await giveawayCount(handle)} (expected 0).`,
    impact: 'A rejected start left a giveaway row behind.',
  });

  // The giveaways.status CHECK constraint rejects a malformed row and persists
  // nothing — the DB integrity floor under "invalid never creates a campaign".
  const { error: badStatusErr } = await handle.supabase.from('giveaways').insert({
    guild_id: handle.guildId,
    channel_id: `${ctx.runPrefix}chan`,
    prize: `${ctx.runPrefix}bad`,
    winner_count: 1,
    ends_at: new Date(Date.now() + 60_000).toISOString(),
    status: 'not-a-real-status',
    created_by: admin,
  });
  ctx.expect(badStatusErr !== null && (await giveawayCount(handle)) === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The giveaways status CHECK rejects a malformed row and writes nothing.',
    observation:
      `invalid-status insert error=${badStatusErr ? badStatusErr.message : 'none'}; ` +
      `giveaways rows still = ${await giveawayCount(handle)} (expected 0).`,
    impact: 'The giveaways integrity constraint accepted a malformed row — invalid state could persist.',
  });

  await proveNoOwnerAlert(ctx, handle);
  // No giveaway row was created (by design), so there is no positive control for
  // the anon-denial RLS probe here; RLS isolation is proven in DEF/UNAUTH/XGUILD.
  ctx.gate(
    'database-RLS',
    'db-rls',
    'anon/authenticated clients read zero giveaways rows.',
    'INVALID intentionally creates no giveaway row, so there is no positive-control row for the anon-denial probe (proven in DEF/UNAUTH/XGUILD)',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A zero-duration start, a 51-winner start, and an over-1000-char prize are each rejected with a clear error and no message is posted.',
    'those limits are enforced by Discord’s slash-command option constraints (min/max/maxLength) validated before the interaction reaches the bot — not reachable in a gateway-less harness',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'An API-level over-1000-char prize is stored only in canonical btrim/left-1000 form.',
    'prize canonicalization runs in the /giveaway start handler (codePointSlice+trim) and the notify snapshot path; the giveaways table has no canonicalizing trigger, so this handler-level behavior is not represented by the direct table probe',
  );
  gateAudit(ctx);
  gateMemberFacingSurfaces(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — administration is denied to unprivileged members. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { giveaways_enabled: true } });
  const admin = ctx.userId('admin');
  const outsider = ctx.userId('b');

  // A real active giveaway exists (created by the admin); the DB-observable proof
  // of "unprivileged/anon cannot see or touch it" is the anon-denial RLS probe.
  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}protected`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
  });
  ctx.expect(giveaway !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: an active admin-created giveaway exists for the isolation proof.',
    observation: `seeded giveaway id=${giveaway?.id ?? '(none)'}.`,
    impact: 'Could not arrange the active giveaway — the UNAUTH isolation proof setup is invalid.',
  });
  const giveawayId = giveaway!.id;

  // An entry attempt against a NON-active (ended) giveaway is refused at the DB
  // layer (giveaway_add_entry gates on status='active') — the active campaign
  // stays untouched by an out-of-band mutation.
  const ended = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}closed`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    status: 'ended',
  });
  const refusedEntry = await addEntry(handle, ended!.id, outsider);
  const endedAfter = await readGiveaway(handle, ended!.id);
  ctx.expect(!refusedEntry.matched && endedAfter !== null && endedAfter.entries.length === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'An entry into a non-active giveaway is refused; the giveaway is not mutated.',
    observation: `entry matched=${refusedEntry.matched} (expected false); ended giveaway entries=${endedAfter?.entries.length} (expected 0).`,
    impact: 'A non-active giveaway accepted an entry — the status guard on entries is not enforced.',
  });

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  const denied = await ctx.runSlash(handle, {
    commandName: 'giveaway',
    userId: outsider,
    member: { id: outsider, roles: [], permissions: { has: () => false } },
    subcommand: 'end',
    options: { id: giveawayId },
  });
  const denial = replyContent(denied);
  const protectedAfter = await readGiveaway(handle, giveawayId);
  ctx.expect(
    /Manage Server/i.test(denial) && protectedAfter?.status === 'active',
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A member without Manage Guild who runs /giveaway end gets an ephemeral denial and the giveaway remains active.',
      observation: `captured denial=${JSON.stringify(denial)}; protected giveaway status=${protectedAfter?.status ?? '(missing)'}.`,
      impact: 'A caller without Manage Guild reached giveaway administration or did not receive the required denial.',
    },
  );
  const { data: deniedAudits } = await handle.supabase
    .from('audit_logs')
    .select('actor_id, action, success, details')
    .eq('guild_id', handle.guildId)
    .eq('actor_id', outsider)
    .eq('action', 'giveaway.command.denied');
  ctx.expect(
    Array.isArray(deniedAudits)
      && deniedAudits.length === 1
      && deniedAudits[0]?.success === false
      && (deniedAudits[0]?.details as { reason?: unknown } | null)?.reason === 'missing_manage_guild',
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each denied /giveaway attempt lands one audit row with actor, subcommand, and reason permission-denied.',
      observation: `matching denied audit rows=${deniedAudits?.length ?? 0}; success=${deniedAudits?.[0]?.success ?? '(missing)'}.`,
      impact: 'A denied giveaway-administration attempt was not recorded exactly once with its actor and reason.',
    },
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The same Manage Guild denial is read back from a real Discord test-guild interaction.',
    'the in-handler denial and immutable database outcome are proven through the real dispatcher; the required live test-guild readback remains pending',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — database unreachable at end time → fail safe, driven through the
 *  REAL fault proxy (ctx.faults severs the actual network path run-one-domain
 *  routed the stack through). The end trigger is the REAL `/giveaway end`
 *  subcommand through the production dispatcher + GiveawayManager — the same
 *  selectWinnersAndEnd draw path the scheduled sweep runs. Falls back to honest
 *  gates when no proxy is registered (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (!supabaseFault) {
    gateFaultLane(
      ctx,
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    return;
  }

  // Giveaways must be ON so guild-init wires the real GiveawayManager behind
  // the /giveaway dispatcher route (the runner's default seed disables it).
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { giveaways_enabled: true } });
  const admin = ctx.userId('admin');
  const adminMember = { id: admin, roles: [], permissions: { has: () => true } };
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');
  const userC = member(ctx, 'c');

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}depfail-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    winnerCount: 1,
    entries: [userA, userB, userC],
  });
  ctx.expect(giveaway !== null && giveaway.entries.length === 3, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: an active giveaway with three entrants exists before the outage.',
    observation: `seeded giveaway id=${giveaway?.id ?? '(none)'} with ${giveaway?.entries.length ?? 0} entries.`,
    impact: 'Could not arrange the pre-outage giveaway — the DEPFAIL proof setup is invalid.',
  });
  const giveawayId = giveaway!.id;
  const runEnd = () =>
    ctx.runSlash(handle, {
      commandName: 'giveaway',
      userId: admin,
      member: adminMember,
      subcommand: 'end',
      options: { id: giveawayId },
    });

  // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
  await supabaseFault.sever();
  let threw: string | null = null;
  let severedReply = '';
  try {
    severedReply = replyContent(await runEnd());
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  await supabaseFault.restore();

  // (1) Fail-SAFE: the end command replied; the pipeline never crashed.
  ctx.expect(threw === null && severedReply.length > 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With database access blocked at end time, /giveaway end still replies (fail-safe) instead of crashing the interaction pipeline.',
    observation: `during the outage window /giveaway end ${threw === null ? `replied ${JSON.stringify(severedReply)}` : `THREW ${threw}`}.`,
    impact: 'A database outage crashed the giveaway end pipeline instead of degrading to a reply.',
  });

  // (2) The reply must NEVER claim a completed draw fabricated from the failed
  //     read: "✅ Giveaway ended. No entries." during an outage is a lie about
  //     a draw that never ran against entries the bot could not read. The
  //     catalog contracts a degradation notice. Recorded honestly; never softened.
  const looksUnavailable = /unavailable|try again|temporar|later|not run/i.test(severedReply);
  const fabricatedDraw = /giveaway ended|no entries|winners:/i.test(severedReply);
  ctx.expect(looksUnavailable && !fabricatedDraw, {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise: 'The outage-window reply is the branded giveaways-unavailable degradation notice — never a fabricated "ended / no entries" draw result.',
    observation: `outage-window reply ${JSON.stringify(severedReply)} — looksUnavailable=${looksUnavailable}, fabricatedDraw=${fabricatedDraw}.`,
    impact: 'During a database outage /giveaway end claimed a completed draw ("ended / no entries") fabricated from a failed read — the admin is told a draw ran when nothing happened.',
  });

  // (3) ZERO CORRUPTION / no partial draw: after restoration the durable row is
  //     untouched — still active, same end time, all three entries, no winners.
  const afterOutage = await readGiveaway(handle, giveawayId);
  ctx.expect(
    afterOutage !== null &&
      afterOutage.status === 'active' &&
      afterOutage.ends_at === giveaway!.ends_at &&
      sameSet(afterOutage.entries, [userA, userB, userC]) &&
      afterOutage.winners.length === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'No winner is lost and no partial draw leaks: after restoration the giveaway is still active with its original end time, all entries, and zero committed winners.',
      observation:
        `post-restore: status=${afterOutage?.status} (expected active), ends_at match=${afterOutage?.ends_at === giveaway!.ends_at}, ` +
        `entries=[${afterOutage?.entries.join(', ')}] (expected the 3 entrants), winners=${afterOutage?.winners.length} (expected 0).`,
      impact: 'The blocked draw corrupted durable giveaway state (a partial draw, lost entries, or a premature end).',
    },
  );

  // (4) RECOVERY: the draw resumes from durable state and completes exactly
  //     once — the re-driven end selects one winner from the intact entrant pool.
  const recoveredReply = replyContent(await runEnd());
  const afterEnd = await readGiveaway(handle, giveawayId);
  ctx.expect(
    /giveaway ended/i.test(recoveredReply) &&
      afterEnd !== null &&
      afterEnd.status === 'ended' &&
      afterEnd.winners.length === 1 &&
      isSubset(afterEnd.winners, [userA, userB, userC]),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After restoration the draw completes from durable state: the re-driven end commits exactly one winner drawn from the pre-outage entrants.',
      observation:
        `post-restore /giveaway end replied ${JSON.stringify(recoveredReply)}; status=${afterEnd?.status} (expected ended), ` +
        `winners=[${afterEnd?.winners.join(', ')}] (expected exactly 1, drawn from the entrant pool).`,
      impact: 'The draw did not complete correctly after the outage ended.',
    },
  );

  // (5) Exactly-once: re-delivering the end AFTER the recovered draw is a
  //     status-gated no-op — the committed winner set is never re-drawn.
  const replayedReply = replyContent(await runEnd());
  const afterReplay = await readGiveaway(handle, giveawayId);
  ctx.expect(
    afterReplay !== null &&
      sameSet(afterReplay.winners, afterEnd?.winners ?? []) &&
      afterReplay.winners.length === 1 &&
      /giveaway ended/i.test(replayedReply),
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Re-delivering the end trigger around the outage cycle never re-draws: the winner set committed by the recovered draw stays byte-identical.',
      observation:
        `replayed /giveaway end replied ${JSON.stringify(replayedReply)}; winners after replay=[${afterReplay?.winners.join(', ')}] ` +
        `(unchanged from the recovered draw [${(afterEnd?.winners ?? []).join(', ')}]).`,
      impact: 'A re-delivered end after the outage cycle re-drew or mutated the committed winner set — the exactly-once draw guarantee is broken.',
    },
  );

  // Guild-scoping holds across the outage window.
  await proveGiveawayRls(ctx, handle, giveawayId);

  // Residual legs the in-process outage lane cannot observe:
  ctx.gate(
    'Discord',
    'discord-readback',
    'No premature or partial announcement appears during the outage; after recovery exactly one announcement and one notification per winner appear in the live channel.',
    'announcement/notification counts require a live channel + gateway readback (DISCORD_TOKEN + live guild); the durable exactly-once draw record is the DB-observable evidence above',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one giveaway-alert describes the delayed draw and its recovery.',
    'the alert row cannot be written while the database itself is severed and no resumed-draw alert emitter fires on this path today; observing the single alert needs the owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
  gateAudit(ctx);
  ctx.gate(
    'cleanup',
    'db-observable',
    'Run-prefixed giveaway rows created around the fault are still swept to zero afterwards.',
    'end-to-end cleanup of run-prefixed giveaway rows is proven in the CLEANUP scenario',
  );
}

/** RETRY — a transient announcement fault retries to exactly one message. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The retry branch triggers only when the first announcement POST fails
  // transiently — a fault at the Discord channel.send boundary that requires
  // injection plus a live channel to observe the single resulting message.
  gateFaultLane(
    ctx,
    'requires a transient-fault-injection lane on the winner-announcement post plus a live channel readback',
  );
}

/** REPLAY — re-delivering the end trigger never re-draws or re-notifies. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}replay-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    entries: [userA, userB],
  });
  const giveawayId = giveaway!.id;

  // First end commits the winner set; every subsequent end trigger (a duplicate
  // scheduler tick + a re-delivered end command) is a status-gated no-op.
  const first = await atomicEnd(handle, giveawayId, [userA]);
  const afterFirst = await readGiveaway(handle, giveawayId);
  const second = await atomicEnd(handle, giveawayId, [userB]);
  const third = await atomicEnd(handle, giveawayId, [userA, userB]);
  const afterReplays = await readGiveaway(handle, giveawayId);

  ctx.expect(
    first.won &&
      !second.won &&
      !third.won &&
      afterReplays !== null &&
      afterReplays.status === 'ended' &&
      sameSet(afterReplays.winners, afterFirst?.winners ?? []) &&
      sameSet(afterReplays.winners, [userA]),
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'The durable draw record shows one committed draw; replayed end triggers are deduplicated no-ops (persisted idempotency = the status-gated atomic end).',
      observation:
        `end wins: first=${first.won}, second=${second.won}, third=${third.won} (expected true,false,false); ` +
        `winners after replays=[${afterReplays?.winners.join(', ')}] (unchanged from the first draw [${(afterFirst?.winners ?? []).join(', ')}]).`,
      impact: 'A replayed end re-drew or appended winners — the exactly-once draw / idempotency guarantee is broken.',
    },
  );
  // Entries are untouched by the replayed ends.
  ctx.expect(afterReplays !== null && sameSet(afterReplays.entries, [userA, userB]), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Replaying the end leaves the entrant set byte-identical.',
    observation: `entries after replays = [${afterReplays?.entries.join(', ')}] (expected the original two entrants).`,
    impact: 'A replayed end mutated the entrant set.',
  });

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'After the replay the channel still holds exactly one announcement and each winner exactly one DM.',
    'announcement/DM counts require a live channel + gateway readback; the durable single-draw record is the DB-observable evidence here',
  );
}

/** RESTART — an active giveaway spans a full stack restart intact. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const admin = ctx.userId('admin');
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');

  // Boot #1: start a giveaway, take real entries, snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const seeded = await seedGiveaway(first, {
    prize: `${ctx.runPrefix}restart-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    entries: [userA],
  });
  const giveawayId = seeded!.id;
  await addEntry(first, giveawayId, userB); // a second entry before the restart
  const snapshot = await readGiveaway(first, giveawayId);
  await first.cleanup(); // simulate shutdown (rows persist in Supabase)

  // Boot #2: SAME guild id (restart). The giveaway + entries must be identical.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readGiveaway(second, giveawayId);
  ctx.expect(
    afterRestart !== null &&
      snapshot !== null &&
      afterRestart.status === 'active' &&
      afterRestart.ends_at === snapshot.ends_at &&
      sameSet(afterRestart.entries, [userA, userB]),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the giveaway is still active with the same end time and the same entrants.',
      observation:
        `post-restart: status=${afterRestart?.status}, ends_at match=${afterRestart?.ends_at === snapshot?.ends_at}, ` +
        `entries=[${afterRestart?.entries.join(', ')}] (expected the two pre-restart entrants).`,
      impact: 'Giveaway state did not survive a restart — the countdown or entries were lost.',
    },
  );

  // A post-restart entry is accepted on the same giveaway, and the end-time draw
  // commits exactly once after the restart.
  await addEntry(second, giveawayId, member(ctx, 'c'));
  const end = await atomicEnd(second, giveawayId, [userA]);
  const afterEnd = await readGiveaway(second, giveawayId);
  ctx.expect(end.won && afterEnd !== null && afterEnd.status === 'ended' && afterEnd.winners.length === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Post-restart the giveaway ends at its original time and draws exactly once.',
    observation: `post-restart end won=${end.won}, status=${afterEnd?.status}, winners=${afterEnd?.winners.length} (expected one).`,
    impact: 'The giveaway did not end/draw correctly after a restart.',
  });

  await proveGiveawayRls(ctx, second, giveawayId);
  await proveNoOwnerAlert(ctx, second);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — double-clicked entries store once; concurrent ends draw once. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = member(ctx, 'a');
  const userB = member(ctx, 'b');

  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}race-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    winnerCount: 1,
  });
  const giveawayId = giveaway!.id;

  // (a) A rapid double click (two concurrent add-entry RPCs for one member) stores
  //     exactly one entry (array_append gated on NOT (user = ANY(entries))).
  await Promise.all([addEntry(handle, giveawayId, userA), addEntry(handle, giveawayId, userA)]);
  const afterDouble = await readGiveaway(handle, giveawayId);
  ctx.expect(afterDouble !== null && sameSet(afterDouble.entries, [userA]), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A double-clicked entry stores exactly one entry row for the member.',
    observation: `entries after two concurrent add-entry calls = [${afterDouble?.entries.join(', ')}] (expected the member once).`,
    impact: 'A concurrent double entry stored twice — the atomic unique-per-member guard failed under a race.',
  });

  // (b) Two admins ending the same giveaway concurrently → exactly one draw commits
  //     (giveaway_atomic_end gates the status flip on status='active').
  await addEntry(handle, giveawayId, userB);
  const [end1, end2] = await Promise.all([
    atomicEnd(handle, giveawayId, [userA]),
    atomicEnd(handle, giveawayId, [userB]),
  ]);
  const afterEnd = await readGiveaway(handle, giveawayId);
  const exactlyOneWon = end1.won !== end2.won; // XOR — exactly one caller won
  ctx.expect(
    exactlyOneWon && afterEnd !== null && afterEnd.status === 'ended' && afterEnd.winners.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Two admins ending the same giveaway at once trigger exactly one draw and one committed winner set.',
      observation:
        `concurrent end wins: [${end1.won}, ${end2.won}] (exactly one true=${exactlyOneWon}); ` +
        `final status=${afterEnd?.status}, winners=${afterEnd?.winners.length} (expected one draw).`,
      impact: 'Concurrent ends double-drew or committed conflicting winners — the status-gated single-draw guarantee failed.',
    },
  );

  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'One entry confirmation per member and exactly one announcement despite the concurrent end commands.',
    'confirmation/announcement counts require a live channel + gateway readback; the single-entry and single-draw records are the DB-observable evidence here',
  );
}

/** XGUILD — giveaways are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const admin = ctx.userId('admin');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // Guild A runs a giveaway with entries; guild B runs its own separate giveaway.
  const gA = await seedGiveaway(handleA, {
    prize: `${ctx.runPrefix}A-prize`,
    channelId: `${ctx.runPrefix}A-chan`,
    createdBy: admin,
    entries: [ctx.userId('a'), ctx.userId('b')],
  });
  const gB = await seedGiveaway(handleB, {
    prize: `${ctx.runPrefix}B-prize`,
    channelId: `${ctx.runPrefix}B-chan`,
    createdBy: admin,
  });
  ctx.expect(gA !== null && gB !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Test arrangement: each guild has its own giveaway.',
    observation: `guild A giveaway=${gA?.id ?? '(none)'}, guild B giveaway=${gB?.id ?? '(none)'}.`,
    impact: 'Could not arrange the two per-guild giveaways.',
  });

  // A guild-B-scoped read sees ZERO of guild A's giveaway rows; each scope reads
  // only its OWN row (the exact `.eq('guild_id', ...)` predicate the manager uses
  // before ending/entering — cross-guild ids match nothing).
  const { data: bSeesA } = await handleB.supabase
    .from('giveaways')
    .select('id')
    .eq('guild_id', guildB)
    .eq('id', gA!.id)
    .maybeSingle();
  const { count: aOwnCount } = await handleA.supabase
    .from('giveaways')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildA);
  const { count: bOwnCount } = await handleB.supabase
    .from('giveaways')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildB);
  ctx.expect(bSeesA === null && aOwnCount === 1 && bOwnCount === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'A guild-B-scoped read matches none of guild A’s giveaways; each guild reads only its own giveaway row (per-guild isolation).',
    observation:
      `guild-B-scoped read of A’s giveaway id = ${bSeesA === null ? 'no match' : 'MATCHED'}; ` +
      `guild A owns ${aOwnCount} row(s), guild B owns ${bOwnCount} row(s) (each expected 1).`,
    impact: 'A cross-guild read returned another guild’s giveaway — per-guild isolation is broken.',
  });

  await proveGiveawayRls(ctx, handleA, gA!.id);
  await proveNoOwnerAlert(ctx, handleA);
  gateMemberFacingSurfaces(ctx);
  gateAudit(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'A /giveaway end run in guild B with guild A’s giveaway id is refused as unknown and guild A’s campaign proceeds untouched.',
    '/giveaway is subcommand-based and undrivable; the manager’s guild-scoped read (proven above via the scoped SELECT) is what refuses the cross-guild end',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const admin = ctx.userId('admin');
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: a giveaway with a real entry.
  const giveaway = await seedGiveaway(handle, {
    prize: `${ctx.runPrefix}cleanup-prize`,
    channelId: `${ctx.runPrefix}chan`,
    createdBy: admin,
    entries: [userA],
  });
  const giveawayId = giveaway!.id;
  const before = await giveawayCount(handle);
  ctx.expect(before >= 1 && giveaway !== null && giveaway.entries.length === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed giveaway + entry rows (pre-cleanup baseline).',
    observation: `pre-cleanup: giveaway rows=${before}, seeded entries=${giveaway?.entries.length}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveGiveawayRls(ctx, handle, giveawayId);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO rows remain.
  await ctx.sweepGuildRows(handle);
  const after = await giveawayCount(handle);
  ctx.expect(after === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed giveaway and entry rows are deleted; a final sweep finds zero run-prefixed giveaway resources.',
    observation: `post-sweep: giveaway rows=${after} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed giveaway rows behind — the suite leaves residue.',
  });

  gateMemberFacingSurfaces(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed giveaway messages remain in either test guild after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Giveaway audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'giveaway actions write durable audit rows; proving anonymize-over-delete requires real campaign actions, cleanup, and retained audit_logs readback',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The community-giveaways domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before the guild row),
 * plus the 12 scenario scripts. Entries and winners are TEXT[] columns on the
 * giveaways row (no separate entry/notification tables exist), so `giveaways` is
 * the sole giveaway operational table; `alerts` is swept for the owner-notification
 * happy-path proof.
 */
export const communityGiveawaysProof: DomainProof = {
  domainId: 'community-giveaways',
  guildScopedTables: [
    // giveaway_atomic_end queues one durable notify_giveaway_winner action per
    // committed winner in bot_action_queue (guild-scoped) — swept so the draws
    // this proof commits (DEF/SET-B/DEPFAIL/REPLAY/RESTART/RACE) leave no
    // queue residue behind.
    'bot_action_queue',
    'giveaways',
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
