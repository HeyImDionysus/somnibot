/**
 * scenario-runner/scripts/moderation-infractions-appeals — the Infractions &
 * Appeals domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven through the REAL production dispatcher against LOCAL Supabase.
 * Discord moderation effects remain gated where a real gateway is required, but
 * the appeal lifecycle is driven end-to-end through the production dispatcher and
 * real Supabase state.
 *
 *   1. Every mutating moderation command (`/warn`, `/mute`, `/kick`, `/ban`) is
 *      Discord-side: the real handlers in packages/bot/src/features/moderation/
 *      commands.ts immediately call `guild.members.fetch(target.id)` and then
 *      `member.timeout/kick/ban`. The synthetic guild the live-runner installs has
 *      no `members.fetch` and no gateway, so those handlers throw before writing
 *      any infraction — they CANNOT be driven here. The action/escalation/DM/
 *      mod-log effects are therefore GATED behind DISCORD_TOKEN + a live guild.
 *   2. Appeal submit/status, pending-row dedupe, atomic decisions, restart
 *      persistence, cross-guild isolation, and lifecycle audit rows are all
 *      DB-observable without a gateway. Only the final member DM/readback remains
 *      credential-gated.
 *
 * What DOES run now, against real state:
 *   - The ONE pure-Supabase command this domain exposes, `/infractions`, is driven
 *     through the real dispatcher (`handleInfractionsCommand` reads
 *     `getMemberInfractions` straight from Supabase — no gateway), and its captured
 *     embed is asserted against the exact rows seeded into the `infractions` table.
 *   - The `infractions` table model the whole domain reads/writes: seeded rows are
 *     read back for active-warning counts, actor/target/guild provenance, and the
 *     warn-before-punish "warned" window.
 *   - The `guild_config` moderation columns the escalation/expiry config lives in
 *     (`escalation_chain`, `infraction_expiry_days`) — saved live and read back.
 *   - Guild-scoped RLS on `infractions` (anon-denial with a service-role positive
 *     control) and strict per-guild isolation (XGUILD, two real guilds).
 *   - Owner-notification quiet on happy paths (the `alerts` table stays empty).
 *   - The cleanup sweep of run-prefixed infraction rows.
 *
 * Behavior-bug discovery (never forced green): where the REAL bot diverges from
 * the catalog's contracted intent the script records a FAIL — most notably that
 * `handleInfractionsCommand` performs NO server-side permission re-check (the
 * catalog's UNAUTH promise requires the handler to re-check and deny), so an
 * unprivileged member reaches moderation history. That FAIL is a finding for the
 * owner, not something to soften into a pass or a gate.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Small live-stack helpers ──────────────────────────────────────────────

/** The `infractions` columns this proof reads back (the real table shape). */
interface InfractionRow {
  id: string;
  guild_id: string;
  member_id: string;
  moderator_id: string;
  type: string;
  reason: string;
  active: boolean;
  pardoned: boolean;
  expires_at: string | null;
  created_at: string;
}

interface AppealRow {
  id: string;
  guild_id: string;
  infraction_id: string;
  appellant_discord_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  reviewer_id: string | null;
  decision_notified: boolean;
  created_at: string;
}

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** Read the mute duration a chain step carries at a given threshold (for gate copy). */
function chainMuteMinutes(chain: JsonValue | undefined, threshold: number): number | null {
  if (!Array.isArray(chain)) return null;
  for (const step of chain) {
    if (step && typeof step === 'object' && !Array.isArray(step)) {
      const s = step as { [k: string]: JsonValue };
      if (Number(s.threshold) === threshold) {
        const d = s['duration-minutes'];
        return typeof d === 'number' ? d : null;
      }
    }
  }
  return null;
}

interface SeedInfractionInput {
  memberId: string;
  moderatorId: string;
  type: 'warn' | 'mute' | 'kick' | 'ban';
  reason: string;
  active?: boolean;
  pardoned?: boolean;
  /** Days from now to expiry; omitted → null (never expires). */
  expiryDays?: number;
  durationMinutes?: number;
}

/**
 * Seed one infraction row exactly as `createInfraction` writes it (the same
 * columns/defaults), using the service role. Returns the new row id (or null on
 * failure) so callers can reference it. This mirrors the template seeding wallets
 * through the real initializer: it arranges REAL rows the proof then reads back.
 */
async function seedInfraction(handle: LiveClientHandle, input: SeedInfractionInput): Promise<string | null> {
  const expiresAt =
    input.expiryDays != null ? new Date(Date.now() + input.expiryDays * 86_400_000).toISOString() : null;
  const { data } = await handle.supabase
    .from('infractions')
    .insert({
      guild_id: handle.guildId,
      member_id: input.memberId,
      moderator_id: input.moderatorId,
      type: input.type,
      reason: input.reason,
      duration_minutes: input.durationMinutes ?? null,
      active: input.active ?? true,
      pardoned: input.pardoned ?? false,
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

/** Service-role read of every infraction row for a member in a guild. */
async function readInfractions(handle: LiveClientHandle, memberId: string): Promise<InfractionRow[]> {
  const { data } = await handle.supabase
    .from('infractions')
    .select('id, guild_id, member_id, moderator_id, type, reason, active, pardoned, expires_at, created_at')
    .eq('guild_id', handle.guildId)
    .eq('member_id', memberId);
  return (data as InfractionRow[] | null) ?? [];
}

/** Active (unpardoned) warn count for a member — the escalation input the bot uses. */
async function activeWarnCount(handle: LiveClientHandle, memberId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('infractions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('member_id', memberId)
    .eq('type', 'warn')
    .eq('active', true)
    .eq('pardoned', false);
  return count ?? 0;
}

/** Total infraction rows scoped to a whole guild (for isolation/cleanup counts). */
async function guildInfractionCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('infractions')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function readAppeals(handle: LiveClientHandle, appellantId?: string): Promise<AppealRow[]> {
  let query = handle.supabase
    .from('appeals')
    .select('id, guild_id, infraction_id, appellant_discord_id, reason, status, reviewer_id, decision_notified, created_at')
    .eq('guild_id', handle.guildId);
  if (appellantId) query = query.eq('appellant_discord_id', appellantId);
  const { data } = await query.order('created_at', { ascending: true });
  return (data as AppealRow[] | null) ?? [];
}

async function readAppealAudits(handle: LiveClientHandle): Promise<Array<{ action: string; occurrence_key: string | null }>> {
  const { data } = await handle.supabase
    .from('audit_logs')
    .select('action, occurrence_key')
    .eq('guild_id', handle.guildId)
    .like('action', 'appeal.%');
  return (data as Array<{ action: string; occurrence_key: string | null }> | null) ?? [];
}

async function submitAppeal(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  infractionId: string,
  reason: string,
  interactionId?: string,
): Promise<CapturedResponse> {
  return ctx.runSlash(handle, {
    commandName: 'appeal',
    subcommand: 'submit',
    interactionId,
    userId,
    options: { infraction_id: infractionId, reason },
  });
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

/** Read the last editReply/reply content string a handler produced. */
/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty; that hid the /infractions denial and produced a
 *  FALSE "no server-side re-check" finding — the #335 payload lesson). */
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

/** The embed data of the last editReply/reply (the /infractions history embed). */
function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const edits = captured.allOf('editReply');
  const source =
    edits.length > 0
      ? (edits[edits.length - 1]!.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined)
      : (captured.find('reply')?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined);
  return source?.embeds?.[0]?.data;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny_all → 0), null when inconclusive (→ GATE).
 * PostgREST surfaces a genuine authorization denial as SQLSTATE 42501 / "permission
 * denied" (the deny we want to prove); a rejected key is inconclusive.
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
      return 0;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Drive the REAL `/infractions` dispatcher path (pure-Supabase; needs no gateway).
 * The target is supplied as an options.user object exactly as discord.js would.
 */
async function runInfractions(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  actingUserId: string,
  targetId: string,
  targetTag: string,
  activeOnly: boolean,
  member?: unknown,
): Promise<CapturedResponse> {
  return ctx.runSlash(handle, {
    commandName: 'infractions',
    userId: actingUserId,
    member,
    options: {
      user: { id: targetId, tag: targetTag, bot: false },
      active_only: activeOnly,
    },
  });
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on `infractions`: an anon client reads ZERO of the
 * scenario guild's rows while the service role sees the seeded row (a positive
 * control that makes the anon-zero a real deny, not "nothing to read"). The caller
 * MUST have seeded at least one infraction for `memberId` first.
 */
async function proveRlsIsolation(ctx: ScenarioContext, handle: LiveClientHandle, memberId: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero infractions rows (RLS lockdown: no anon/authenticated GRANT, owner-only policy).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'infractions', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero infractions rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readInfractions(handle, memberId);
  ctx.expect(serviceSees.length > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s infraction rows while an anon client reads zero of them (RLS lockdown on infractions).',
    observation:
      `service-role sees ${serviceSees.length} infraction row(s) for the member under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} infractions row(s) for that guild.`,
    impact:
      'An infraction row visible to the service role was also readable with an anon key — RLS is not denying anon reads (member moderation data exposure).',
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
      promise: "This scenario's moderation happy path raises no owner alert (the alerts table stays empty for the guild).",
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Moderation failure branches (rejected escalation, unrecordable infraction) raise exactly one owner alert carrying a reason + remediation hint.',
    'the owner alert is posted to the live owner alert channel (this.notify → Discord embed) and only fires on a fault branch — requires DISCORD_TOKEN + a live guild plus a fault-injection lane',
  );
}

/**
 * Branding for this domain is honestly GATED: moderation surfaces (warn/mute/kick/
 * ban DMs, mod-log embeds, the /infractions embed) are rendered from a HARDCODED
 * palette (SOMNI_PALETTE / raw hex) in the bot, not from the owner's white-label
 * brand kit or voice preset. There is no owner-configurable branding input in this
 * harness to compare against, and the brand-kit/voice-preset match requires an
 * embed/message snapshot readback against the live brand kit. We never fabricate a
 * brand pass; the hardcoded-palette gap is surfaced in the domain report.
 */
function gateBranding(ctx: ScenarioContext, captured?: CapturedResponse): void {
  const note = captured && brandingSurface(captured)
    ? `a member-facing surface was produced ("${truncate(brandingSurface(captured), 80)}") but `
    : '';
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing moderation surface shows the owner’s configured brand name, colors, and voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.',
    `${note}moderation embeds/DMs are rendered from a hardcoded palette, not the owner brand kit; matching the configured white-label brand kit + voice preset requires the brand-kit config and an embed snapshot readback (DISCORD_TOKEN + live guild)`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext, promise: string, reason: string): void {
  ctx.gate('Discord', 'discord-readback', promise, reason);
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate infractions, punishments, DMs, or appeal filings.',
    `replay/idempotency of the mutating moderation path is addressed in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — warn-before-punish out of the box: first two warnings record + DM only. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const chainDefault = declaredDefault(ctx.domain, 'escalation-chain');
  const expiryDefault = Number(declaredDefault(ctx.domain, 'infraction-expiry-days'));
  const muteAt3 = chainMuteMinutes(chainDefault, 3) ?? 60;

  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a'); // target member
  const modId = ctx.userId('mod'); // acting moderator
  const reason1 = `${ctx.runPrefix}first-warning`;
  const reason2 = `${ctx.runPrefix}second-warning`;

  // Arrange the warn-before-punish window: the first two warnings, recorded exactly
  // as createInfraction writes them (active, unpardoned, with an expiry).
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: reason1, expiryDays: expiryDefault });
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: reason2, expiryDays: expiryDefault });

  // Drive the REAL /infractions dispatcher path and assert the captured embed
  // reflects EXACTLY the two seeded warnings (real reply, not a synthetic literal).
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
  const warns = await activeWarnCount(handle, userA);
  const surface = brandingSurface(cap);
  const embed = replyEmbedData(cap);
  ctx.expect(
    warns === 2 &&
      Boolean(embed) &&
      surface.includes('WARN') &&
      surface.includes(reason1) &&
      surface.includes(reason2) &&
      surface.includes('Showing 2 of 2'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: `Out of the box the first two warnings only record (no punishment); /infractions lists both active WARN rows and no timeout stands (threshold-3 mute is ${muteAt3}m).`,
      observation:
        `active warn count=${warns} (expected 2); /infractions embed=${Boolean(embed)}, ` +
        `surface="${truncate(surface)}" (expected to name both seeded reasons + "Showing 2 of 2").`,
      impact: 'The recorded warn-before-punish history did not render on /infractions as the two active warnings it is.',
    },
  );

  // Audit: each recorded warning is an append-only infractions row carrying actor
  // (moderator_id), target (member_id), guild scope, and a creation time.
  const rows = await readInfractions(handle, userA);
  ctx.expect(
    rows.length === 2 &&
      rows.every((r) => r.moderator_id === modId && r.member_id === userA && r.guild_id === handle.guildId && Boolean(r.created_at)),
    {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each recorded warning lands one append-only infractions row carrying its actor (moderator_id), target (member_id), guild scope, and creation time.',
      observation:
        `infraction rows=${rows.length} (expected 2); ` +
        `actor/target/guild/created_at complete on all=${rows.every((r) => r.moderator_id === modId && r.member_id === userA && r.guild_id === handle.guildId && Boolean(r.created_at))}.`,
      impact: 'A recorded warning was missing its actor/target/guild provenance on the infractions ledger.',
    },
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Every escalation, pardon, appeal, denial, and failure additionally lands exactly one append-only audit_logs row with a run-prefixed correlation id.',
    'the manual /warn path writes the infractions row + emits an event but no audit_logs row; audit_logs entries for moderation come from the escalation-failure / automod / dashboard paths — driving them needs DISCORD_TOKEN + a live guild (and, for appeals, an unimplemented feature)',
  );

  // The third-warning escalation to a 60-minute mute is a Discord action (member.timeout).
  gateLiveGuildReadback(
    ctx,
    `A third active infraction escalates to exactly one ${muteAt3}-minute timeout with a DM stating what, why, and how to appeal, and a mod-log entry naming the next step.`,
    'the /warn→executeEscalation path calls guild.members.fetch + member.timeout + member DM — requires DISCORD_TOKEN + a live guild; the gateway-less harness cannot drive it (the synthetic guild has no members.fetch)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — the owner tunes the chain live (gentler chain + 7-day expiry). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  // A gentler chain: four pure warnings before a 10-minute mute, plus a 7-day expiry,
  // written in the REAL guild_config DB shape (camelCase durationMinutes/dmMember).
  const gentlerChain = [
    { threshold: 1, action: 'warn', dmMember: true },
    { threshold: 2, action: 'warn', dmMember: true },
    { threshold: 3, action: 'warn', dmMember: true },
    { threshold: 4, action: 'warn', dmMember: true },
    { threshold: 5, action: 'mute', durationMinutes: 10, dmMember: true },
  ];
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      escalation_chain: gentlerChain,
      infraction_expiry_days: 7,
    },
  });
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // Prove the live config save is persisted + well-formed DB-observably (this is
  // what "takes effect without a restart" means at the data layer the bot reads).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as { escalation_chain: Array<{ threshold: number; action: string; durationMinutes?: number }>; infraction_expiry_days: number } | null;
  const chain = Array.isArray(cfg?.escalation_chain) ? cfg!.escalation_chain : [];
  const muteStep = chain.find((s) => s.action === 'mute');
  ctx.expect(
    chain.length === 5 &&
      chain.filter((s) => s.action === 'warn').length === 4 &&
      muteStep?.threshold === 5 &&
      muteStep?.durationMinutes === 10 &&
      cfg?.infraction_expiry_days === 7,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'The tuned chain (four pure warnings before a 10-minute mute) and the 7-day expiry are saved live into guild_config the bot reads on the next command.',
      observation:
        `guild_config chain length=${chain.length}, pure-warn steps=${chain.filter((s) => s.action === 'warn').length}, ` +
        `mute step threshold=${muteStep?.threshold}/duration=${muteStep?.durationMinutes}, expiry_days=${cfg?.infraction_expiry_days} (expected 5/4/5/10/7).`,
      impact: 'A saved dashboard chain/expiry did not persist to guild_config — the live tune would be ignored by the bot.',
    },
  );

  // Seed one infraction so the RLS positive control is real, and confirm the config
  // change did not disturb the read path: /infractions still renders.
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}set-a`, expiryDays: 7 });
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
  ctx.expect(Boolean(replyEmbedData(cap)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/infractions keeps working under the tuned chain.',
    observation: `/infractions ${replyEmbedData(cap) ? 'rendered its history embed' : 'produced no embed'}.`,
    impact: '/infractions stopped rendering after the chain was tuned.',
  });

  // The observable escalation behavior change (3rd warning no longer mutes; 5th
  // applies a 10-minute timeout) and the 7-day expiry SWEEP are Discord/scheduler.
  gateLiveGuildReadback(
    ctx,
    'Under the tuned chain the third warning only DMs while the fifth applies a single 10-minute timeout, and an infraction older than 7 days stops counting after the expiry sweep runs.',
    'the escalation actions call guild.members.fetch + member.timeout (needs DISCORD_TOKEN + a live guild), and the expiry deactivation is done by the periodic expireInfractions sweep (a scheduler tick, not a dispatcher command) — neither is drivable here',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The config change is captured in an append-only audit_logs row.',
    'the config save + its audit_logs row are written by the dashboard save path; this harness seeds guild_config directly (no dashboard), so no config-change audit row is produced here',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — appeal submit/status, pending dedupe, audit, and review queue state. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // Seed an escalated infraction so the member has something to appeal, and so the
  // RLS positive control + a real /infractions readback are non-vacuous.
  const infractionId = await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'mute', reason: `${ctx.runPrefix}escalated`, durationMinutes: 60, expiryDays: 30 });
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', false);
  const rows = await readInfractions(handle, userA);
  ctx.expect(rows.length === 1 && rows[0]!.type === 'mute' && Boolean(replyEmbedData(cap)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The infraction the member would appeal exists and is visible via /infractions.',
    observation: `infraction rows=${rows.length} (type=${rows[0]?.type}); /infractions embed=${Boolean(replyEmbedData(cap))}.`,
    impact: 'The infraction backing the appeal scenario is missing or not visible.',
  });

  const submitted = infractionId
    ? await submitAppeal(ctx, handle, userA, infractionId, `${ctx.runPrefix}please-review`)
    : null;
  const replayed = infractionId
    ? await submitAppeal(ctx, handle, userA, infractionId, `${ctx.runPrefix}duplicate`)
    : null;
  const appeals = await readAppeals(handle, userA);
  const audits = await readAppealAudits(handle);
  const submitAudits = audits.filter((row) => row.action === 'appeal.submitted');
  ctx.expect(
    Boolean(infractionId) &&
      replyContent(submitted!).includes('pending') &&
      replyContent(replayed!).includes('already have a pending appeal') &&
      appeals.length === 1 &&
      appeals[0]?.infraction_id === infractionId &&
      appeals[0]?.status === 'pending',
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A member files one pending appeal through /appeal submit and an immediate duplicate receives a respectful refusal without a second row.',
      observation:
        `submit reply="${truncate(submitted ? replyContent(submitted) : '(not run)')}"; ` +
        `replay reply="${truncate(replayed ? replyContent(replayed) : '(not run)')}"; appeal rows=${appeals.length}.`,
      impact: 'Appeal submission or pending-row dedupe is broken — the member cannot file reliably or duplicate rows can enter the review queue.',
    },
  );
  ctx.expect(submitAudits.length === 1 && Boolean(submitAudits[0]?.occurrence_key), {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The successful appeal filing lands exactly one append-only appeal.submitted audit row with a stable occurrence key.',
    observation: `appeal.submitted audit rows=${submitAudits.length}; occurrence_key=${submitAudits[0]?.occurrence_key ?? '(none)'}.`,
    impact: 'The appeal entered the queue without its exactly-once lifecycle audit record.',
  });
  ctx.expect(appeals.length === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-filing the same pending appeal yields no duplicate appeal row (one pending appeal per infraction).',
    observation: `appeal rows for the appellant after the replay=${appeals.length} (expected 1).`,
    impact: 'A replay created duplicate pending appeals for one infraction.',
  });
  ctx.gate(
    'branding',
    'discord-readback',
    'The appeal confirmation, dashboard review queue, and decision DM match the owner brand kit and voice preset.',
    'functional submit/dedupe/audit state is proven above; visual brand-kit comparison remains part of the aesthetic owner walkthrough',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
}

/** INVALID — a rejected invalid config never persists; the prior valid chain stands. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const validChain = [
    { threshold: 1, action: 'warn', dmMember: true },
    { threshold: 2, action: 'warn', dmMember: true },
    { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
  ];
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { escalation_chain: validChain, infraction_expiry_days: 30 },
  });
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // DB-observable core: guild_config retains its prior VALID chain byte-for-byte
  // (a rejected invalid save must never persist).
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const cfg = cfgRow as { escalation_chain: Array<{ threshold: number; action: string; durationMinutes?: number }>; infraction_expiry_days: number } | null;
  const chain = Array.isArray(cfg?.escalation_chain) ? cfg!.escalation_chain : [];
  ctx.expect(
    chain.length === 3 &&
      chain[2]?.action === 'mute' &&
      chain[2]?.threshold === 3 &&
      chain[2]?.durationMinutes === 60 &&
      cfg?.infraction_expiry_days === 30,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'guild_config keeps its prior valid chain (warn, warn, mute-60 at 3) and 30-day expiry byte-for-byte (a rejected invalid save never persists).',
      observation:
        `guild_config chain length=${chain.length}, step3 action=${chain[2]?.action}/threshold=${chain[2]?.threshold}/duration=${chain[2]?.durationMinutes}, ` +
        `expiry=${cfg?.infraction_expiry_days} (expected 3/mute/3/60/30).`,
      impact: 'The prior valid moderation configuration was not retained.',
    },
  );

  // Behavior unchanged on the very next command after a (would-be) rejected save.
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}invalid`, expiryDays: 30 });
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
  ctx.expect(Boolean(replyEmbedData(cap)), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged on the very next command after a rejected config save — the previous valid chain still applies.',
    observation: `/infractions ${replyEmbedData(cap) ? 'still renders normally' : 'failed to render'}.`,
    impact: 'A rejected config attempt disturbed live bot behavior.',
  });

  // The actual REJECTION lives in the dashboard's Zod layer; guild_config columns
  // (escalation_chain JSONB, infraction_expiry_days INTEGER) carry NO CHECK
  // constraint, so a chain whose punishment precedes any warning / a negative mute /
  // a zero expiry could persist at the DB level — the reject path is not reachable
  // in this bot-only harness. GATE it honestly (never fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard surfaces a clear validation error for a chain whose punishment precedes any warning, a negative mute duration, or a zero expiry.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint on escalation_chain/infraction_expiry_days, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit_logs row records the rejected configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — moderation power is gated: the handler re-checks Moderate Members,
 *  denies the unprivileged member, leaks no history, and AUDITS the denial. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a'); // target with history
  const userB = ctx.userId('b'); // unprivileged member
  const modId = ctx.userId('mod');

  // Give the target a real recorded history (also the RLS positive control).
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}unauth-1`, expiryDays: 30 });
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}unauth-2`, expiryDays: 30 });
  const before = await guildInfractionCount(handle);

  // Drive /infractions as member B WITHOUT Moderate Members (permissions.has →
  // false → interaction.memberPermissions mirrors the deny). The handler's
  // server-side re-check (defense-in-depth beyond Discord's
  // default_member_permissions hiding) must refuse with an ephemeral denial and
  // leak zero history. (An earlier run recorded a FALSE "no re-check" finding
  // here: the denial is a raw-string editReply payload the old replyContent
  // couldn't read — fixed in payloadText above.)
  const unprivileged = { id: userB, permissions: { has: () => false } };
  const cap = await runInfractions(ctx, handle, userB, userA, 'run-member-a', true, unprivileged);
  const surface = brandingSurface(cap);
  const looksDenied = /permission|not allowed|only moderators|cannot|denied|no access/i.test(surface);
  const leakedHistory = surface.includes('WARN') || surface.includes(`${ctx.runPrefix}unauth-1`);
  ctx.expect(looksDenied && !leakedHistory, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'A member without Moderate Members is refused by the handler (server-side re-check), not merely hidden by Discord — /infractions replies with an ephemeral denial and leaks no history.',
    observation:
      `driving /infractions as an unprivileged member (permissions.has→false) produced surface "${truncate(surface)}"; ` +
      `looksDenied=${looksDenied}, leakedHistory=${leakedHistory}.`,
    impact:
      'handleInfractionsCommand did not refuse an unprivileged member — an unprivileged member (Discord command-hiding bypassed, e.g. via a raw API call) receives another member’s moderation history. The handler-level enforcement the catalog promises is missing.',
  });

  // The denied attempt is a security event: exactly one append-only audit row
  // records it with the actor, the target, and success=false.
  const { data: denialRows } = await handle.supabase
    .from('audit_logs')
    .select('action, actor_id, target_id, success')
    .eq('guild_id', handle.guildId)
    .eq('action', 'moderation.infractions.denied');
  const denials = (denialRows as Array<{ actor_id: string; target_id: string | null; success: boolean }> | null) ?? [];
  ctx.expect(denials.length === 1 && denials[0]!.actor_id === userB && denials[0]!.target_id === userA && denials[0]!.success === false, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The denied /infractions attempt lands exactly one append-only audit row (moderation.infractions.denied) with actor, target, and success=false.',
    observation:
      `audit_logs holds ${denials.length} moderation.infractions.denied row(s); ` +
      `actor_id=${denials[0]?.actor_id ?? '(none)'} (expected ${userB}), target_id=${denials[0]?.target_id ?? '(none)'} (expected ${userA}), success=${denials[0]?.success}.`,
    impact: 'A refused privileged-command attempt left no audit trail — denied moderation attempts are invisible to the owner.',
  });

  // The target's recorded history is intact/unchanged by the unauthorized attempt.
  const after = await guildInfractionCount(handle);
  ctx.expect(after === before && before === 2, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'No infraction is created by an unauthorized attempt; the target’s recorded history is identical before and after.',
    observation: `infraction rows before=${before}, after=${after} (expected 2 and unchanged).`,
    impact: 'An unauthorized moderation attempt altered the infractions ledger.',
  });

  // /warn refusal itself, and the member-portal appeal-resolution denial, are not
  // drivable here (/warn needs the gateway; the portal + appeals denial lane is separate).
  gateLiveGuildReadback(
    ctx,
    'run-member-b’s /warn attempt yields only an ephemeral denial with no infraction created (the denied-attempt audit row is now proven above via /infractions).',
    'driving /warn end-to-end needs guild.members.fetch + a live gateway (the shared deny+audit path is proven via /infractions in this scenario)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'A member dashboard session receives a permission error when attempting to resolve their own appeal, and the denial is audited.',
    'the appeal decision route is protected by requireGuildOwner, but exercising the denied HTTP session and its audit surface requires the authenticated dashboard-session lane',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe, driven through the REAL fault proxy
 *  (ctx.faults severs the actual network path run-one-domain routed the stack
 *  through — a genuine ECONNREFUSED window). The one pure-Supabase surface this
 *  domain exposes (/infractions) is driven inside the outage; the mutating
 *  /warn + /mute outage legs still need the live gateway (guild.members.fetch +
 *  member.timeout) and stay honestly gated. Falls back to gates when no proxy is
 *  registered (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await ctx.bootGuild({ label: 'a' });
    const userA = ctx.userId('a');
    const modId = ctx.userId('mod');
    const reason = `${ctx.runPrefix}depfail-warn`;
    await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason, expiryDays: 30 });
    const before = await readInfractions(handle, userA);

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let severedReply = '';
    try {
      const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
      severedReply = replyContent(cap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SAFE: the dispatcher must reply, never crash the pipeline.
    ctx.expect(threw === null && severedReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'With database access blocked, a moderation command still replies (fail-safe) instead of crashing the interaction pipeline.',
      observation: `during the outage window /infractions ${threw === null ? `replied ${JSON.stringify(truncate(severedReply))}` : `THREW ${truncate(threw)}`}.`,
      impact: 'A database outage crashed the moderation command pipeline instead of degrading to a reply.',
    });

    // (2) The catalog contracts a branded failure in the owner voice — never a
    //     data-shaped answer. Replying "has no active infractions" during an
    //     outage is a lie about a record the bot could not read (a clean-record
    //     verdict fabricated from a failed read). Recorded honestly; never softened.
    const looksUnavailable = /unavailable|try again|temporar|later|degraded|issue|problem/i.test(severedReply);
    const dataShapedLie = /has no\b.*infraction/i.test(severedReply);
    ctx.expect(looksUnavailable && !dataShapedLie, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: 'With the database blocked, the moderation reply is the branded moderation-unavailable notice — never a data-shaped clean-record answer fabricated from the failed read.',
      observation: `outage-window reply ${JSON.stringify(truncate(severedReply))} — looksUnavailable=${looksUnavailable}, dataShapedLie=${dataShapedLie}.`,
      impact: 'During a database outage /infractions replied with a fabricated data-shaped answer ("no infractions") instead of a degradation notice — a moderator is told a clean-record lie about history the bot could not read.',
    });

    // (3) No corruption: the persisted infraction history is byte-identical after restore.
    const after = await readInfractions(handle, userA);
    ctx.expect(
      before.length === 1 &&
        after.length === 1 &&
        after[0]!.id === before[0]!.id &&
        after[0]!.reason === reason &&
        after[0]!.active === true &&
        after[0]!.pardoned === false,
      {
        assertionClass: 'Discord',
        channel: 'db-observable',
        promise: 'No infraction record corrupts across the outage window — the persisted history is unchanged after restoration.',
        observation:
          `infraction rows before=${before.length}/after=${after.length}; post-restore id=${after[0]?.id === before[0]?.id ? 'unchanged' : 'CHANGED'}, ` +
          `reason=${JSON.stringify(after[0]?.reason)}, active=${after[0]?.active}, pardoned=${after[0]?.pardoned} (expected the one seeded active warn, untouched).`,
        impact: 'A database outage corrupted or dropped persisted infraction records.',
      },
    );

    // (4) Recovery: the very next command serves the real history again.
    const recovered = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
    const recoveredSurface = brandingSurface(recovered);
    ctx.expect(/WARN/i.test(recoveredSurface) && recoveredSurface.includes(reason), {
      assertionClass: 'replay-safety',
      channel: 'captured-reply',
      promise: 'After restoration the very next /infractions serves the real recorded history again with consistent counts (no lingering degradation).',
      observation: `post-restore /infractions surface ${JSON.stringify(truncate(recoveredSurface))} (expected the seeded active WARN with its reason).`,
      impact: 'The moderation pipeline did not recover after the outage ended.',
    });

    await proveRlsIsolation(ctx, handle, userA);
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'With database access blocked, /warn and /mute reply with a branded failure, no timeout is left applied without an infraction record, and after restoration the same commands succeed with consistent counts.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded moderation-unavailable template in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'No duplicate infraction/timeout survives the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'Infraction rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  // The mutating outage legs and the degradation observability remain gated in
  // BOTH lanes: /warn + /mute call guild.members.fetch + member.timeout (live
  // gateway), and the moderation feature raises no degradation alert/audit today.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With database access blocked, /warn and /mute reply with the branded failure and no timeout is left applied without an infraction record.',
    'the mutating /warn and /mute outage legs call guild.members.fetch + member.timeout (DISCORD_TOKEN + a live guild); the read-side outage fail-safe is proven via /infractions in the fault lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed command).',
    'requires the owner alert channel readback; the moderation feature currently raises no dependency-degradation alert on a failed DB read',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'Append-only audit rows capture the degradation window and recovery; no punishment stands without its infraction record through the outage.',
    'the moderation feature writes no degradation/recovery audit rows today, and the punishment-without-record invariant needs the live /mute path',
  );
}

/** RETRY — a transient infraction-write fault converges to exactly one row. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The retry/convergence branch fires only when the FIRST infractions insert fails
  // transiently — a fault that requires injection at the createInfraction boundary,
  // AND the surrounding /warn handler needs the gateway to even reach that insert.
  // GATE the fault-dependent proof; do not fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a transient fault on the first insert for a third warning, the retry lands exactly one infraction row, one 60-minute timeout, and one punishment DM.',
    'requires a mid-/warn fault-injection lane (fail the first infractions insert) PLUS the live escalation path (guild.members.fetch + member.timeout) — neither is reachable in the bot-only harness',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried insert reuses the original correlation key, so the infractions table shows one row for the warning, not two, and escalation fires once.',
    'requires the mid-/warn fault-injection lane; NOTE: createInfraction currently writes a fresh row per call with NO persisted idempotency/correlation key, so a naive retry would DUPLICATE — a likely owner finding surfaced in the report',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The converged history shows exactly one infraction row and one escalation, never a double.',
    'requires the mid-/warn fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'No spurious owner alert is raised for a self-healing transient retry.',
    'requires the mid-/warn fault-injection lane plus owner alert channel readback',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The single retried punishment DM carries the owner brand kit + voice preset.',
    'requires the mid-/warn fault-injection lane plus the live DM path',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The converged infraction row is guild-scoped.',
    'requires the mid-/warn fault-injection lane',
  );
}

/** REPLAY — re-delivering /warn + an appeal must not double-apply. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // Seed one infraction so RLS + a real readback are non-vacuous.
  const infractionId = await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}replay`, expiryDays: 30 });
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', true);
  ctx.expect(Boolean(replyEmbedData(cap)) && (await activeWarnCount(handle, userA)) === 1, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The member holds exactly one recorded infraction that /infractions renders.',
    observation: `active warn count=${await activeWarnCount(handle, userA)} (expected 1); embed=${Boolean(replyEmbedData(cap))}.`,
    impact: 'The single-infraction baseline for the replay scenario is wrong.',
  });

  const replayInteractionId = ctx.snowflake('appeal-replay');
  if (infractionId) {
    await submitAppeal(ctx, handle, userA, infractionId, `${ctx.runPrefix}replay-appeal`, replayInteractionId);
    await submitAppeal(ctx, handle, userA, infractionId, `${ctx.runPrefix}replay-appeal`, replayInteractionId);
  }
  const appeals = await readAppeals(handle, userA);
  const submitAudits = (await readAppealAudits(handle)).filter((row) => row.action === 'appeal.submitted');
  ctx.expect(Boolean(infractionId) && appeals.length === 1 && submitAudits.length === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the same appeal submission leaves one pending appeal and one occurrence-keyed appeal.submitted audit record.',
    observation: `appeal rows=${appeals.length}; appeal.submitted audit rows=${submitAudits.length} (expected 1 and 1).`,
    impact: 'The replay duplicated an appeal row or its lifecycle audit record.',
  });

  // /warn still needs the gateway. Keep that distinct from the appeal replay,
  // which is fully proven above.
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering the /warn interaction yields no duplicate infraction, timeout, or DM.',
    'the mutating /warn path needs DISCORD_TOKEN + a live guild (guild.members.fetch); appeal replay is proven separately above',
  );
  gateLiveGuildReadback(
    ctx,
    'After replaying the recorded interaction events the timeout state and DM count are byte-identical to the pre-replay snapshot.',
    'the timeout/DM effects require the live Discord gateway; not observable in the bot-only harness',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);
}

/** RESTART — moderation state survives a full stack reboot (it lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // Boot #1: record a history (two warns + one escalated mute), snapshot, shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const appealInfractionId = await seedInfraction(first, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}r1`, expiryDays: 30 });
  await seedInfraction(first, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}r2`, expiryDays: 30 });
  await seedInfraction(first, { memberId: userA, moderatorId: modId, type: 'mute', reason: `${ctx.runPrefix}r3`, durationMinutes: 60, expiryDays: 30 });
  if (appealInfractionId) {
    await submitAppeal(ctx, first, userA, appealInfractionId, `${ctx.runPrefix}restart-appeal`);
  }
  const snapshot = await readInfractions(first, userA);
  const appealSnapshot = await readAppeals(first, userA);
  const snapWarns = await activeWarnCount(first, userA);
  await first.cleanup(); // simulate shutdown (rows persist in Supabase; sweep is separate)

  // Boot #2: SAME guild id (restart). /infractions must match the pre-restart state.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const cap = await runInfractions(ctx, second, modId, userA, 'run-member-a', false);
  const afterRestart = await readInfractions(second, userA);
  const surface = brandingSurface(cap);
  ctx.expect(
    afterRestart.length === snapshot.length &&
      afterRestart.length === 3 &&
      surface.includes(`${ctx.runPrefix}r1`) &&
      surface.includes(`${ctx.runPrefix}r3`) &&
      surface.includes('Showing 3 of 3'),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'After a full stack restart /infractions matches the pre-restart snapshot exactly (all three rows persist and re-render).',
      observation:
        `pre-restart rows=${snapshot.length}, post-restart rows=${afterRestart.length}; ` +
        `post-restart surface="${truncate(surface)}" (expected to name r1+r3 and "Showing 3 of 3").`,
      impact: 'Moderation history did not survive the restart — persisted infractions were lost or altered.',
    },
  );
  ctx.expect((await activeWarnCount(second, userA)) === snapWarns && snapWarns === 2, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'The active-warning count the escalation reads is identical before and after the restart.',
    observation: `pre-restart active warns=${snapWarns}, post-restart=${await activeWarnCount(second, userA)} (expected 2).`,
    impact: 'The escalation-relevant active-warning count changed across the restart.',
  });

  const appealsAfterRestart = await readAppeals(second, userA);
  const pendingAppeal = appealsAfterRestart[0];
  const { data: decided } = pendingAppeal
    ? await second.supabase
        .from('appeals')
        .update({ status: 'approved', reviewer_id: modId, decided_at: new Date().toISOString() })
        .eq('id', pendingAppeal.id)
        .eq('guild_id', second.guildId)
        .eq('status', 'pending')
        .select('id, status')
        .maybeSingle()
    : { data: null };
  const decisionAudits = (await readAppealAudits(second)).filter((row) => row.action === 'appeal.approved');
  ctx.expect(
    appealSnapshot.length === 1 &&
      appealsAfterRestart.length === 1 &&
      (decided as { status?: string } | null)?.status === 'approved' &&
      decisionAudits.length === 1,
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'A pending appeal survives the full stack restart and remains atomically decidable exactly once with its lifecycle audit row.',
      observation:
        `appeals before restart=${appealSnapshot.length}, after restart=${appealsAfterRestart.length}; ` +
        `decision status=${(decided as { status?: string } | null)?.status ?? '(none)'}; appeal.approved audits=${decisionAudits.length}.`,
      impact: 'The restart lost the pending appeal or left it undecidable/unaudited.',
    },
  );

  // The persisted appeal and decision are proven above. Only the live Discord
  // timeout and scheduler timing remain gateway/scheduler surfaces.
  gateLiveGuildReadback(
    ctx,
    'The live timeout continues to its original end time and the expiry sweep resumes on schedule after restart.',
    'the running Discord timeout state needs the live gateway and the expiry sweep is a scheduler tick (not a dispatcher command)',
  );

  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx, cap);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** RACE — concurrent moderation is safe (the write-race needs the gateway → gated). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');

  // Record three warnings, then read /infractions CONCURRENTLY: both deliveries must
  // return the SAME consistent history under concurrency (a real read-consistency
  // check against live DB — the write-race itself is gated below).
  const appealInfractionId = await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}rc1`, expiryDays: 30 });
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}rc2`, expiryDays: 30 });
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}rc3`, expiryDays: 30 });
  const [c1, c2] = await Promise.all([
    runInfractions(ctx, handle, modId, userA, 'run-member-a', true),
    runInfractions(ctx, handle, modId, userA, 'run-member-a', true),
  ]);
  const s1 = brandingSurface(c1);
  const s2 = brandingSurface(c2);
  const warns = await activeWarnCount(handle, userA);
  ctx.expect(warns === 3 && s1.includes('Showing 3 of 3') && s2.includes('Showing 3 of 3'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Both concurrent warnings are recorded and every concurrent /infractions read returns the same consistent three-warning history.',
    observation: `active warns=${warns} (expected 3); reply1 shows "Showing 3 of 3"=${s1.includes('Showing 3 of 3')}, reply2=${s2.includes('Showing 3 of 3')}.`,
    impact: 'Concurrent reads returned an inconsistent infraction history.',
  });

  if (appealInfractionId) {
    await submitAppeal(ctx, handle, userA, appealInfractionId, `${ctx.runPrefix}race-appeal`);
  }
  const pending = (await readAppeals(handle, userA))[0];
  const decide = (status: 'approved' | 'denied', reviewerId: string) =>
    handle.supabase
      .from('appeals')
      .update({ status, reviewer_id: reviewerId, decided_at: new Date().toISOString() })
      .eq('id', pending?.id ?? '00000000-0000-0000-0000-000000000000')
      .eq('guild_id', handle.guildId)
      .eq('status', 'pending')
      .select('id, status')
      .maybeSingle();
  const [approved, denied] = await Promise.all([
    decide('approved', ctx.userId('owner-a')),
    decide('denied', ctx.userId('owner-b')),
  ]);
  const winners = [approved.data, denied.data].filter(Boolean) as Array<{ status: string }>;
  const terminalAudits = (await readAppealAudits(handle)).filter((row) =>
    row.action === 'appeal.approved' || row.action === 'appeal.denied');
  ctx.expect(Boolean(pending) && winners.length === 1 && terminalAudits.length === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two simultaneous appeal decisions produce exactly one terminal state and one occurrence-keyed decision audit row.',
    observation:
      `decision winners=${winners.length} (${winners.map((row) => row.status).join(',') || 'none'}); ` +
      `terminal appeal audit rows=${terminalAudits.length}.`,
    impact: 'The decision race applied twice, applied neither, or produced duplicate/missing lifecycle audit evidence.',
  });

  // The catalog RACE promise — two moderators warning simultaneously record both
  // warnings but the threshold escalation executes EXACTLY ONCE, and a racing pardon
  // + appeal decision resolve to one final state. The appeal race is proven above;
  // only the gateway-backed warn escalation remains gated.
  gateLiveGuildReadback(
    ctx,
    'Two simultaneous /warn invocations at the threshold apply exactly one 60-minute timeout (escalation fires once).',
    'concurrent /warn (guild.members.fetch + member.timeout) needs DISCORD_TOKEN + a live guild; the appeal decision race is proven DB-observably above',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The threshold escalation writes exactly one escalation infraction row despite the concurrent warnings.',
    'the escalation write is only reachable through the live /warn path (gateway) — not drivable here',
  );
  ctx.gate('Discord', 'discord-readback', 'The winning appeal decision produces exactly one member DM.', 'the terminal state and exactly-once audit are proven above; DM delivery readback requires a live Discord user/gateway');

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, c1);
}

/** XGUILD — infractions and appeals are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const modId = ctx.userId('mod');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // Warn the SAME member three times in guild A; guild B stays clean.
  const appealInfractionId = await seedInfraction(handleA, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}xg1`, expiryDays: 30 });
  await seedInfraction(handleA, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}xg2`, expiryDays: 30 });
  await seedInfraction(handleA, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}xg3`, expiryDays: 30 });

  // /infractions in guild A shows three; in guild B shows none — same member id.
  const capA = await runInfractions(ctx, handleA, modId, userA, 'run-member-a', true);
  const capB = await runInfractions(ctx, handleB, modId, userA, 'run-member-a', true);
  const countA = await guildInfractionCount(handleA);
  const countB = await guildInfractionCount(handleB);
  const surfaceA = brandingSurface(capA);
  const surfaceB = brandingSurface(capB);
  ctx.expect(
    countA === 3 && countB === 0 && surfaceA.includes('Showing 3 of 3') && /no .*infraction/i.test(surfaceB),
    {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'Warnings in guild A never advance guild B: guild A’s /infractions shows three, guild B’s shows none for the same member.',
      observation:
        `guild A count=${countA} (reply "Showing 3 of 3"=${surfaceA.includes('Showing 3 of 3')}); ` +
        `guild B count=${countB} (reply="${truncate(surfaceB, 60)}").`,
      impact: 'Cross-guild activity leaked infractions between guilds — per-guild escalation isolation broken.',
    },
  );

  // Each guild scope reads its OWN rows and never the other's (distinct real rows).
  const { data: aScoped } = await handleA.supabase
    .from('infractions')
    .select('guild_id, member_id')
    .eq('guild_id', guildA)
    .eq('member_id', userA);
  const { data: bScoped } = await handleB.supabase
    .from('infractions')
    .select('guild_id, member_id')
    .eq('guild_id', guildB)
    .eq('member_id', userA);
  const aRows = (aScoped as Array<{ guild_id: string }> | null) ?? [];
  const bRows = (bScoped as Array<{ guild_id: string }> | null) ?? [];
  ctx.expect(aRows.length === 3 && aRows.every((r) => r.guild_id === guildA) && bRows.length === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'A client scoped to guild B reads zero of guild A’s infraction rows and vice versa; the counts diverged independently under distinct guild_ids.',
    observation:
      `guild-A-scoped read=${aRows.length} rows all under "${guildA}"=${aRows.every((r) => r.guild_id === guildA)}; ` +
      `guild-B-scoped read=${bRows.length} rows (expected 3 and 0).`,
    impact: 'A guild-scoped read returned the other guild’s infractions — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA, userA);

  if (appealInfractionId) {
    await submitAppeal(ctx, handleA, userA, appealInfractionId, `${ctx.runPrefix}xguild-appeal`);
  }
  const appealA = (await readAppeals(handleA, userA))[0];
  const { data: visibleInB } = await handleB.supabase
    .from('appeals')
    .select('id')
    .eq('id', appealA?.id ?? '00000000-0000-0000-0000-000000000000')
    .eq('guild_id', guildB)
    .maybeSingle();
  const { data: decidedInB } = await handleB.supabase
    .from('appeals')
    .update({ status: 'denied', reviewer_id: modId, decided_at: new Date().toISOString() })
    .eq('id', appealA?.id ?? '00000000-0000-0000-0000-000000000000')
    .eq('guild_id', guildB)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  const stillPendingA = (await readAppeals(handleA, userA))[0];
  ctx.expect(
    Boolean(appealA) && visibleInB === null && decidedInB === null && stillPendingA?.status === 'pending',
    {
      assertionClass: 'audit',
      channel: 'db-observable',
      promise: 'An appeal filed in guild A is invisible and undecidable through guild B’s scoped review query; guild A remains pending.',
      observation:
        `appeal A exists=${Boolean(appealA)}; visible in B=${Boolean(visibleInB)}; ` +
        `decision through B=${Boolean(decidedInB)}; guild-A status=${stillPendingA?.status ?? '(none)'}.`,
      impact: 'A guild-B scoped review could see or decide guild A’s appeal — cross-guild moderation isolation is broken.',
    },
  );
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx, capA);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** CLEANUP — the suite leaves no trace: run-prefixed infractions removed + verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const modId = ctx.userId('mod');

  // Create run-prefixed operational rows: infractions for two members.
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}cu-a1`, expiryDays: 30 });
  await seedInfraction(handle, { memberId: userA, moderatorId: modId, type: 'mute', reason: `${ctx.runPrefix}cu-a2`, durationMinutes: 60, expiryDays: 30 });
  await seedInfraction(handle, { memberId: userB, moderatorId: modId, type: 'warn', reason: `${ctx.runPrefix}cu-b1`, expiryDays: 30 });

  // Confirm the baseline through the real read path + a DB count.
  const cap = await runInfractions(ctx, handle, modId, userA, 'run-member-a', false);
  const before = await guildInfractionCount(handle);
  ctx.expect(before >= 3 && Boolean(replyEmbedData(cap)), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed infraction rows visible via /infractions (pre-cleanup baseline).',
    observation: `pre-cleanup infraction rows=${before}; /infractions embed=${Boolean(replyEmbedData(cap))}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx, cap);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows.
  await ctx.sweepGuildRows(handle);
  const after = await guildInfractionCount(handle);
  const alertsAfter = (await alertCount(handle)) ?? -1;
  ctx.expect(after === 0 && alertsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed infraction (and alert) rows are deleted; a final sweep finds zero run-prefixed moderation resources.',
    observation: `post-sweep: infraction rows=${after}, alert rows=${alertsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord channel readback (review channels / mod-log messages) and the
  // anonymize-not-delete audit_logs retention are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guild contains no run-prefixed appeal review channels or leftover moderation mod-log messages after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational infraction rows deleted, audit_logs retained in anonymized form).',
    'requires an audit_logs anonymization readback lane; the deletable operational ledger (infractions) is the DB-observable evidence here',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Infractions & Appeals domain proof: the guild_id-scoped operational tables
 * the sweep must clear (child→parent; audit_logs is intentionally NOT swept —
 * audit history is anonymized, not deleted), plus the 12 scenario scripts.
 */
export const moderationInfractionsAppealsProof: DomainProof = {
  domainId: 'moderation-infractions-appeals',
  guildScopedTables: [
    // Operational, guild_id-scoped, deletable rows this domain writes (child→parent).
    'infractions',
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
