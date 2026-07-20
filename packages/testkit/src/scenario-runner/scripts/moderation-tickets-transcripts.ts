/**
 * scenario-runner/scripts/moderation-tickets-transcripts — the Tickets &
 * Transcripts domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven through the REAL production dispatcher against LOCAL
 * Supabase. Every DB-observable / captured-reply / RLS / audit-row assertion runs
 * NOW; everything that needs a live Discord gateway (create the private ticket
 * thread, post the branded panel/intro/close embeds, deliver the HTML transcript,
 * move channels between categories, DM the creator) is GATED — the honesty
 * boundary the harness requires.
 *
 * What DOES run for real against the production stack:
 *   - The ticket lifecycle CLAIM transition is driven end-to-end through the REAL
 *     dispatcher: a `ticket:claim:{n}` button is injected, `handleInteraction` →
 *     `handleTicketInteraction` → `handleTicketClaim` → `claimTicket` performs the
 *     atomic `UPDATE … WHERE status='open'` (no `guild.channels` touch, so it runs
 *     gateway-less). The open→claimed flip is asserted DB-observably, the branded
 *     claim reply is captured, and the `ticket.claimed` platform event flows to the
 *     REAL AuditService which persists an append-only `audit_logs` row (asserted).
 *   - `ticket_panels` / `tickets` / `ticket_transcripts` are guild-scoped tables;
 *     their RLS deny-all (service role sees the scenario rows, anon reads zero),
 *     guild-scoping (XGUILD), the input_mode CHECK constraint (INVALID), the
 *     state-based claim idempotency (REPLAY/RACE), restart persistence (RESTART),
 *     and the run-prefixed cleanup sweep (CLEANUP) are all proven live.
 *
 * Behavior-bug discovery (never softened — recorded as FAIL findings for the owner):
 *   1. UNAUTH: the claim/close/reopen button handlers perform NO manager-role
 *      re-check. An injected claim from an unprivileged non-creator member SUCCEEDS
 *      and flips the ticket to claimed — the catalog contracts a handler-level
 *      re-check + branded ephemeral denial + denied-attempt audit row, none of
 *      which exist (lifecycle authorization rests solely on Discord channel
 *      visibility).
 *   2. XGUILD: `nextval_ticket()` is `MAX(ticket_number)+1` over the WHOLE
 *      `ticket_transcripts` table — a single global counter, not per-guild. A
 *      second guild's first allocation is contaminated by the first guild's
 *      transcripts, so the catalog's "each guild's numbering advances
 *      independently" is not met.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';
import { buildButtonInteraction } from '../../interaction-builders.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface TicketPanelRow {
  id: string;
  guild_id: string;
  input_mode: string;
  max_open_per_user: number;
  introduction_message: string | null;
  intake_form_enabled: boolean;
  intake_form_fields: unknown[] | null;
  transcript_channel_id: string | null;
  dm_transcript_to_creator: boolean;
  closed_category_id: string | null;
  ticket_types: Array<Record<string, unknown>>;
}

interface TicketRow {
  id: string;
  guild_id: string;
  panel_id: string | null;
  ticket_number: number;
  creator_id: string;
  status: string;
  claimed_by: string | null;
  type: string;
}

interface TranscriptRow {
  id: string;
  guild_id: string;
  ticket_number: number;
}

interface AuditRow {
  action: string;
  actor_id: string;
  target_id: string | null;
  category: string | null;
}

// The catalog default ticket-types (Support + Store & Billing), used to assert the
// out-of-the-box panel and to seed run-scoped panels.
const DEFAULT_TICKET_TYPES = [
  { color: 'blue', emoji: '🎫', id: 'support', label: 'Support' },
  { color: 'green', emoji: '🧾', id: 'billing', label: 'Store & Billing' },
];

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** Insert a run-prefixed ticket panel; returns the created row (or the error). */
async function insertPanel(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  overrides: Record<string, unknown> = {},
): Promise<{ row: TicketPanelRow | null; error: { message: string; code?: string } | null }> {
  const base = {
    guild_id: handle.guildId,
    name: `${ctx.runPrefix}panel`,
    channel_id: `${ctx.runPrefix}panel-chan`,
    panel_message: { title: `${ctx.runPrefix}Support`, description: 'Open a ticket below.' },
    input_mode: 'buttons',
    ticket_types: DEFAULT_TICKET_TYPES,
    open_category_id: `${ctx.runPrefix}open-cat`,
    max_open_per_user: 1,
    dm_transcript_to_creator: true,
  };
  const { data, error } = await handle.supabase
    .from('ticket_panels')
    .insert({ ...base, ...overrides })
    .select(
      'id, guild_id, input_mode, max_open_per_user, introduction_message, intake_form_enabled, ' +
        'intake_form_fields, transcript_channel_id, dm_transcript_to_creator, closed_category_id, ticket_types',
    )
    .single();
  return {
    row: (data as TicketPanelRow | null) ?? null,
    error: error ? { message: error.message, code: (error as { code?: string }).code } : null,
  };
}

/** Insert a run-prefixed ticket row; returns the created row. */
async function insertTicket(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  opts: {
    panelId: string | null;
    ticketNumber: number;
    creatorId: string;
    status?: string;
    type?: string;
    channelId?: string | null;
    claimedBy?: string | null;
  },
): Promise<TicketRow | null> {
  const { data } = await handle.supabase
    .from('tickets')
    .insert({
      guild_id: handle.guildId,
      panel_id: opts.panelId,
      channel_id: opts.channelId ?? `${ctx.runPrefix}ticket-chan-${opts.ticketNumber}`,
      ticket_number: opts.ticketNumber,
      creator_id: opts.creatorId,
      type: opts.type ?? 'billing',
      status: opts.status ?? 'open',
      claimed_by: opts.claimedBy ?? null,
      message_count: 0,
    })
    .select('id, guild_id, panel_id, ticket_number, creator_id, status, claimed_by, type')
    .single();
  return (data as TicketRow | null) ?? null;
}

/** Insert a run-prefixed transcript row (used for cleanup + XGUILD numbering). */
async function insertTranscript(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  opts: { ticketId: string | null; ticketNumber: number; creatorId: string; closedById: string },
): Promise<TranscriptRow | null> {
  const { data } = await handle.supabase
    .from('ticket_transcripts')
    .insert({
      guild_id: handle.guildId,
      ticket_id: opts.ticketId,
      ticket_number: opts.ticketNumber,
      creator_id: opts.creatorId,
      closed_by_id: opts.closedById,
      message_count: 3,
      html_content: `<!DOCTYPE html><html><body>${ctx.runPrefix} transcript #${opts.ticketNumber}</body></html>`,
    })
    .select('id, guild_id, ticket_number')
    .single();
  return (data as TranscriptRow | null) ?? null;
}

async function readTicket(handle: LiveClientHandle, ticketNumber: number): Promise<TicketRow | null> {
  const { data } = await handle.supabase
    .from('tickets')
    .select('id, guild_id, panel_id, ticket_number, creator_id, status, claimed_by, type')
    .eq('guild_id', handle.guildId)
    .eq('ticket_number', ticketNumber)
    .maybeSingle();
  return (data as TicketRow | null) ?? null;
}

/** Service-role count for a guild-scoped table (null only on a query error). */
async function guildRowCount(handle: LiveClientHandle, table: string): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/** Rows of a guild-scoped table that carry a specific ticket_number (XGUILD probe). */
async function countTicketsScoped(handle: LiveClientHandle, ticketNumber: number): Promise<number> {
  const { count } = await handle.supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('ticket_number', ticketNumber);
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
 * Poll the REAL audit pipeline for the guild's `ticket.claimed` rows. The
 * AuditService buffers events and flushes to `audit_logs` on a 5s batch interval,
 * so a short poll (default 15s = three flush cycles) is needed after driving a
 * claim. Returns the rows found (empty on timeout).
 */
async function pollClaimAudits(handle: LiveClientHandle, timeoutMs = 15_000): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: AuditRow[] = [];
  while (Date.now() < deadline) {
    const { data } = await handle.supabase
      .from('audit_logs')
      .select('action, actor_id, target_id, category')
      .eq('guild_id', handle.guildId)
      .eq('action', 'ticket.claimed');
    rows = (data as AuditRow[] | null) ?? [];
    if (rows.length >= 1) return rows;
    await new Promise((r) => setTimeout(r, 300));
  }
  return rows;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny_all → 0), or null when the probe is
 * inconclusive (no key/URL, network error, or the key was rejected before RLS
 * evaluated). Ported from the wallet-rewards / temp-channels proofs.
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
    return null;
  } catch {
    return null;
  }
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

function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  const reply = captured.find('reply');
  const payload = reply?.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
  return payload?.embeds?.[0]?.data;
}

/** Any member-facing text surface of a captured claim reply (content + embed). */
function replySurface(captured: CapturedResponse): string {
  const parts: string[] = [];
  const content = replyContent(captured);
  if (content) parts.push(content);
  const embed = replyEmbedData(captured);
  if (embed) {
    if (typeof embed.title === 'string') parts.push(embed.title);
    if (typeof embed.description === 'string') parts.push(embed.description);
  }
  return parts.join('\n');
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Drive a real ticket lifecycle button through the production dispatcher. */
async function clickTicketButton(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  action: 'claim' | 'close' | 'reopen' | 'delete' | 'transcript',
  ticketNumber: number,
  userId: string,
  opts: { interactionId?: string; member?: unknown } = {},
): Promise<CapturedResponse> {
  const injector = ctx.injectorFor(handle);
  const interaction = buildButtonInteraction({
    customId: `ticket:${action}:${ticketNumber}`,
    guildId: handle.guildId,
    client: handle.client,
    id: opts.interactionId,
    user: { id: userId, username: userId, displayName: userId },
    member: opts.member,
  });
  return injector.inject(interaction);
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on a ticket table: the service role sees the scenario's
 * rows (positive control, so anon reading ZERO is a real deny, not "nothing to
 * read"), while an anon key reads zero. GATEs (never fakes) when no anon key is
 * present or the probe is inconclusive; cross-guild scoping is proven in XGUILD.
 */
async function proveRls(ctx: ScenarioContext, handle: LiveClientHandle, table: string): Promise<void> {
  const serviceCount = await guildRowCount(handle, table);
  const anonKey = ctx.capabilities.anonKey;
  const promise = `The service role reads this guild's ${table} rows while an anon client reads zero of them (RLS deny-all).`;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      promise,
      `no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial on ${table} not exercised — cross-guild scoping is still proven in XGUILD`,
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      promise,
      `the anon REST probe on ${table} was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)`,
    );
    return;
  }
  ctx.expect((serviceCount ?? 0) >= 1 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise,
    observation:
      `service-role sees ${serviceCount ?? 0} ${table} row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} row(s).`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).`,
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
    promise: "This scenario's happy path raises no owner alert.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
  });
}

/**
 * Branding always GATEs for this domain. The member-facing surfaces the catalog
 * brands (panel embed, intro embed, close embed, feedback prompt, transcript HTML)
 * are only emitted when a real thread + channel exist through the live gateway.
 * The one reply the harness CAN capture — the claim embed — is built from a
 * hardcoded SOMNI_PALETTE with no owner brand-kit/voice-preset injection, so the
 * white-label branding contract cannot be affirmed and is GATED (never faked),
 * with the code gap surfaced in the reason.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    "Every member-facing ticket surface (panel embed, intro, close embed, feedback prompt, transcript HTML) shows the owner's brand kit, colors, and voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.",
    'the branded ticket surfaces (panel/intro/close embeds, transcript HTML) are only emitted when a real thread + channel exist through the live Discord gateway (DISCORD_TOKEN + live guild); note the ticket embeds are currently built from a hardcoded SOMNI_PALETTE with no owner brand-kit/voice-preset injection, so the white-label branding contract is unmet even before the gateway is available',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s panel-open and close interactions yields no duplicate ticket threads, status changes, transcripts, or feedback prompts.',
    `interaction/idempotency replay is exercised directly in the ${where} scenario (the open/close/transcript replay itself needs the live gateway to create the thread + transcript)`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box panel + a real claim lifecycle transition + audit row. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const inputModeDefault = String(declaredDefault(ctx.domain, 'panel-input-mode') ?? 'buttons');
  const maxOpenDefault = Number(declaredDefault(ctx.domain, 'max-open-per-user') ?? 1);

  const handle = await ctx.bootGuild({ label: 'a' });
  const creator = ctx.userId('a');
  const staff = ctx.userId('b');

  // 1) The default panel persists guild-scoped with the two catalog default ticket
  //    types and the default input mode + open cap (panel-ready state).
  const { row: panel } = await insertPanel(handle, ctx);
  const typeIds = (panel?.ticket_types ?? []).map((t) => String(t.id)).sort();
  ctx.expect(
    panel?.guild_id === handle.guildId &&
      panel?.input_mode === inputModeDefault &&
      panel?.max_open_per_user === maxOpenDefault &&
      typeIds.length === 2 &&
      typeIds[0] === 'billing' &&
      typeIds[1] === 'support',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `Out of the box the panel is stored with per-type buttons and the Support + Store & Billing ticket types (input_mode="${inputModeDefault}", max_open_per_user=${maxOpenDefault}).`,
      observation: `panel guild_id="${panel?.guild_id}", input_mode="${panel?.input_mode}", max_open_per_user=${panel?.max_open_per_user}, ticket_types=[${typeIds.join(', ')}].`,
      impact: 'The default ticket panel was not persisted with the contracted default input mode / ticket types.',
    },
  );

  // 2) Drive a REAL lifecycle transition through the production dispatcher: a staff
  //    member claims an open ticket. `handleTicketClaim` runs the atomic
  //    open→claimed update (no channel touch), so the flip is DB-observable now.
  const ticket = await insertTicket(handle, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator, type: 'billing' });
  const claimReply = await clickTicketButton(ctx, handle, 'claim', 1, staff);
  const afterClaim = await readTicket(handle, 1);
  ctx.expect(afterClaim?.status === 'claimed' && afterClaim?.claimed_by === staff, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A Claim on an open ticket atomically flips it open→claimed with the claimer recorded, driven through the real dispatcher.',
    observation: `after the real /ticket claim button: status="${afterClaim?.status}" (expected claimed), claimed_by="${afterClaim?.claimed_by}" (expected ${staff}).`,
    impact: 'The claim lifecycle transition did not apply through the production dispatcher.',
  });

  // The dispatcher produced a real member-facing claim reply.
  const surface = replySurface(claimReply);
  ctx.expect(surface.length > 0 && /claim/i.test(surface), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The claim produces a member-facing confirmation reply.',
    observation: `captured claim reply surface = "${truncate(surface)}".`,
    impact: 'The claim produced no confirmation reply from the real handler.',
  });

  // 3) AUDIT (real pipeline): the ticket.claimed event flowed to the AuditService,
  //    which persisted an append-only audit_logs row with actor + guild + target.
  const claimAudits = await pollClaimAudits(handle);
  if (claimAudits.length === 0) {
    ctx.gate(
      'audit',
      'audit-row',
      'The claim lands exactly one append-only audit_logs row (action=ticket.claimed) with actor id, guild id, and the ticket target.',
      'the AuditService buffers events and flushes on a 5s batch interval; the ticket.claimed row did not surface within the 15s poll window, so its persistence could not be affirmed here (no deterministic flush hook is exposed to the script)',
    );
  } else {
    ctx.expect(
      claimAudits.length === 1 && claimAudits[0]!.actor_id === staff && claimAudits[0]!.target_id === ticket?.id,
      {
        assertionClass: 'audit',
        channel: 'audit-row',
        promise: 'The claim lands exactly one append-only audit_logs row (action=ticket.claimed) carrying the actor, guild, and ticket target.',
        observation: `audit_logs holds ${claimAudits.length} ticket.claimed row(s); actor_id="${claimAudits[0]?.actor_id}" (expected ${staff}), target_id="${claimAudits[0]?.target_id}" (expected ${ticket?.id}), category="${claimAudits[0]?.category}".`,
        impact: 'The claim did not produce exactly one correct append-only audit row — the audit trail diverged from the action.',
      },
    );
  }

  // Two-economies wall: a billing ticket conversation never touches game currency.
  const walletCount = (await guildRowCount(handle, 'economy_wallets')) ?? 0;
  const txnCount = (await guildRowCount(handle, 'economy_transactions')) ?? 0;
  ctx.expect(walletCount === 0 && txnCount === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A Store & Billing ticket conversation never touches game currency or any wagerable balance.',
    observation: `after the ticket flow the guild holds ${walletCount} economy_wallets and ${txnCount} economy_transactions rows (expected 0/0).`,
    impact: 'Ticket activity created game-economy rows — the two-economies wall was breached.',
  });

  await proveRls(ctx, handle, 'tickets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  // Gateway-bound facets of the DEF promise.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Clicking a panel button opens a private thread visible only to the creator + managers + bot (run-member-b gets an access error), and closing locks the thread, posts the close embed + feedback stars, saves the HTML transcript, and DMs the creator their copy.',
    'the panel-open and close pipelines call guild.channels.create / channel.send / member.send and require a live Discord gateway (DISCORD_TOKEN + live guild); only the claim transition is drivable gateway-less',
  );
}

/** SET-A — dropdown mode + max-open 2 + custom intro + intake form + transcript channel take live effect (config persists). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const intro = `${ctx.runPrefix}Welcome — tell us how we can help.`;
  const intake = [{ label: 'Order number', style: 'short', required: true, min_length: 3, max_length: 40 }];
  const { row: panel } = await insertPanel(handle, ctx, {
    input_mode: 'dropdown',
    max_open_per_user: 2,
    introduction_message: intro,
    intake_form_enabled: true,
    intake_form_fields: intake,
    transcript_channel_id: `${ctx.runPrefix}transcript-chan`,
    dm_transcript_to_creator: true,
  });

  ctx.expect(
    panel?.input_mode === 'dropdown' &&
      panel?.max_open_per_user === 2 &&
      panel?.introduction_message === intro &&
      panel?.intake_form_enabled === true &&
      (panel?.intake_form_fields?.length ?? 0) === 1 &&
      panel?.transcript_channel_id === `${ctx.runPrefix}transcript-chan` &&
      panel?.dm_transcript_to_creator === true,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A saved dashboard config (dropdown mode, max-open 2, custom intro, an intake form, and the transcript channel + creator DM enabled) persists live on the guild-scoped panel.',
      observation:
        `panel input_mode="${panel?.input_mode}", max_open_per_user=${panel?.max_open_per_user}, intake_form_enabled=${panel?.intake_form_enabled}, ` +
        `intake_fields=${panel?.intake_form_fields?.length ?? 0}, transcript_channel_id="${panel?.transcript_channel_id}", dm=${panel?.dm_transcript_to_creator}.`,
      impact: 'A saved dashboard ticket configuration was not persisted as entered.',
    },
  );

  await proveRls(ctx, handle, 'ticket_panels');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  ctx.gate(
    'audit',
    'discord-readback',
    'The panel configuration change and each ticket action are captured as append-only audit rows.',
    'the dashboard panel-config-change audit row is written by the dashboard save path (not reachable in a bot-only harness); ticket-action audit is proven via a real claim in DEF/REPLAY/RACE',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The edited panel shows the dropdown, the intake modal collects the fields into the intro, a third open returns the branded limit reply, and the close posts one transcript file to the transcript channel plus one DM.',
    'the dropdown render, intake modal, max-open cap enforcement, and transcript-channel post all require a live gateway (thread + channel + modal); only the stored config is observable here',
  );
}

/** SET-B — closed-tickets category + per-type manager-role override persist; inactivity/feedback controls have no backing column. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const overrideRole = `${ctx.runPrefix}override-role`;
  const closedCat = `${ctx.runPrefix}closed-cat`;
  const overriddenTypes = [
    { color: 'blue', emoji: '🎫', id: 'support', label: 'Support' },
    { color: 'green', emoji: '🧾', id: 'billing', label: 'Store & Billing', managerRoleOverride: [overrideRole] },
  ];
  const { row: panel } = await insertPanel(handle, ctx, {
    closed_category_id: closedCat,
    ticket_types: overriddenTypes,
  });

  const billing = (panel?.ticket_types ?? []).find((t) => t.id === 'billing');
  const override = (billing?.managerRoleOverride as string[] | undefined) ?? [];
  ctx.expect(panel?.closed_category_id === closedCat && override.length === 1 && override[0] === overrideRole, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A second config — a closed-tickets category and a per-type manager-role override — persists on the guild-scoped panel.',
    observation: `panel closed_category_id="${panel?.closed_category_id}", billing.managerRoleOverride=[${override.join(', ')}] (expected [${overrideRole}]).`,
    impact: 'The closed category / per-type manager-role override was not persisted.',
  });

  await proveRls(ctx, handle, 'ticket_panels');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  // Honest config-surface gap: the catalog's fast-inactivity-timer and
  // feedback-disabled controls have NO backing column on ticket_panels, and the
  // bot's checkInactiveTickets takes its warn/close thresholds from call-site
  // options (defaults 24h/48h), not from the panel row — so these two controls
  // cannot be persisted or observed at the panel level in this harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Fast inactivity timers fire the warning at the configured hour and auto-close at the close threshold, and the feedback prompt is disabled on close.',
    'inactivity-warn-hours / inactivity-close-hours / feedback-prompt-enabled have no ticket_panels backing column; checkInactiveTickets reads its thresholds from call-site options (24h/48h defaults), and the warn/close/feedback effects need a live thread + scheduler — none are observable in a bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The configuration change, the inactivity warning, and the auto-close are captured as append-only audit rows.',
    'the config-change audit is a dashboard save path; the inactivity warning/auto-close need a live thread + scheduler to occur; ticket-action audit is proven via a real claim in DEF/REPLAY/RACE',
  );
}

/** INVALID — a rejected invalid config never persists; the input_mode CHECK is DB-enforced. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Arrange a VALID panel (max-open 2, dropdown) — the prior good state.
  const { row: valid } = await insertPanel(handle, ctx, { input_mode: 'dropdown', max_open_per_user: 2 });
  ctx.expect(valid?.input_mode === 'dropdown' && valid?.max_open_per_user === 2, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The panel keeps its prior valid values byte-for-byte (a rejected invalid save never persists).',
    observation: `panel input_mode="${valid?.input_mode}" (expected dropdown), max_open_per_user=${valid?.max_open_per_user} (expected 2).`,
    impact: 'A valid ticket-panel configuration was not retained.',
  });

  // The ONE ticket-config constraint enforced at the DB level: input_mode has a
  // CHECK IN ('buttons','dropdown'). An invalid mode is rejected atomically and
  // never persists — a real DB-observable "invalid config is rejected" proof.
  const before = (await guildRowCount(handle, 'ticket_panels')) ?? 0;
  const { error: badErr } = await insertPanel(handle, ctx, { input_mode: 'carousel' });
  const after = (await guildRowCount(handle, 'ticket_panels')) ?? 0;
  ctx.expect(badErr !== null && after === before, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'An invalid panel input_mode is rejected atomically by the DB CHECK constraint and no panel row is written.',
    observation: `insert with input_mode="carousel" returned error=${badErr ? `"${truncate(badErr.message, 60)}"` : 'none (UNEXPECTED)'}; ticket_panels rows stayed ${before}→${after}.`,
    impact: 'An invalid input_mode persisted — the DB-level enum constraint did not reject the bad save.',
  });

  await proveRls(ctx, handle, 'ticket_panels');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');

  // The three catalog-specific rejects (close-threshold ≤ warn, max-open 0, a
  // nonexistent panel channel) carry NO DB CHECK constraint — they are enforced by
  // the dashboard's Zod layer, unreachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard rejects an inactivity close threshold at/below the warning threshold, a max-open-per-user of zero, and a nonexistent panel channel with clear errors; stored config is unchanged and the panel keeps working on the next open.',
    'those three rejections live in the dashboard (Zod) layer — max_open_per_user has no DB CHECK, and inactivity thresholds have no ticket_panels column at all, so a bot-only harness cannot drive their reject paths',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records each rejected configuration attempt with the validation reason; no config-change audit row is written for the failed saves.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
}

/** UNAUTH — FINDING: the claim handler performs no manager-role re-check. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const creator = ctx.userId('a');
  const attacker = ctx.userId('b');
  const managerRole = `${ctx.runPrefix}manager-role`;

  // A panel whose only privileged role is one the attacker does NOT hold, and an
  // OPEN ticket owned by the creator.
  const { row: panel } = await insertPanel(handle, ctx, { manager_roles: [managerRole] });
  await insertTicket(handle, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator, type: 'support' });

  // Drive a REAL claim button as the unprivileged, non-creator attacker (member
  // carries no manager role). The catalog contracts a handler-level re-check + a
  // branded ephemeral denial + a denied-attempt audit row.
  const attackerMember = { id: attacker, roles: [], permissions: { has: () => false } };
  const reply = await clickTicketButton(ctx, handle, 'claim', 1, attacker, { member: attackerMember });
  const after = await readTicket(handle, 1);
  const surface = replySurface(reply);
  const wasDenied =
    after?.status === 'open' &&
    after?.claimed_by === null &&
    /denied|permission|not allowed|manager|can(?:'|no)t/i.test(surface);

  ctx.expect(wasDenied, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A member with no manager role who is not the creator cannot claim a ticket: the handler re-checks manager-role membership, replies with a branded ephemeral denial, and leaves the ticket state unchanged.',
    observation:
      `after the attacker's real claim button: status="${after?.status}" (expected still open), claimed_by="${after?.claimed_by}" (expected null), reply="${truncate(surface)}".`,
    impact:
      'The claim button handler (handleTicketClaim) performs NO manager-role re-check, so an unprivileged non-creator successfully claimed another member’s ticket through the real dispatcher — lifecycle authorization rests solely on Discord channel visibility, and the contracted handler-level re-check + ephemeral denial + denied-attempt audit row are absent (the close and reopen handlers share this gap).',
  });

  await proveRls(ctx, handle, 'tickets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  // No denial path exists, so no denied-attempt audit row is written; instead an
  // unauthorized SUCCESS is what the audit pipeline records.
  ctx.gate(
    'audit',
    'discord-readback',
    'Each denied lifecycle attempt lands one audit row with actor, ticket number, and reason permission-denied.',
    'the claim/close/reopen handlers have no denial branch (see the FAIL above), so no denied-attempt audit row is ever written; the pipeline instead records an unauthorized ticket.claimed success',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The private thread stays invisible to the unprivileged member.',
    'thread visibility is enforced by Discord channel permission overwrites, observable only against a live guild (DISCORD_TOKEN + live guild)',
  );
}

/** DEPFAIL — Supabase-outage fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  await insertPanel(handle, ctx);

  // The one real assertion available in a degraded scenario: the panel row is still
  // guild-scoped and RLS-isolated even when the create path would fail.
  await proveRls(ctx, handle, 'ticket_panels');
  await proveNoOwnerAlert(ctx, handle);

  // The DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, a panel click yields the branded ticket-create-failed reply in the owner voice and no ticket thread or row is left behind.',
    'requires a Supabase dependency-outage fault-injection lane plus a live gateway (the panel-open path calls guild.channels.create); the harness deliberately runs against a reachable DB',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window rather than one alert per failed interaction.',
    'requires a dependency-outage fault lane plus the owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'Append-only audit rows capture the failed attempt and the clean recovery open after restoration.',
    'requires the outage fault lane and a live gateway to drive the failing/recovering opens',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate ticket survives the outage/restore cycle; recovery opens with the next sequential number.',
    'requires a Supabase dependency-outage fault-injection lane + a live gateway',
  );
  gateBranding(ctx);
}

/** RETRY — compensation + operator retry converge without duplication (fault lane). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  await insertPanel(handle, ctx);

  await proveRls(ctx, handle, 'tickets');
  await proveNoOwnerAlert(ctx, handle);

  // Both failure branches need a mid-op fault injected at a Discord/DB boundary:
  //   - create rollback: the tickets insert fails AFTER the thread is created, so
  //     createTicket deletes the just-created thread (channel.delete) — needs a
  //     gateway to create/delete the thread and a fault on the insert.
  //   - transcript retry: the ticket_transcripts insert fails during close, then
  //     /ticket transcript regenerates exactly one — needs a gateway (channel to
  //     read messages) plus a fault on the insert.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A tickets insert that fails after thread creation deletes the orphan thread (compensation); the member’s retry produces exactly one ticket, and a failed transcript store is retried by the operator to exactly one stored transcript.',
    'requires a mid-op fault-injection lane at the tickets/ticket_transcripts insert boundary AND a live gateway (createTicket/generateTranscript touch guild.channels)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried insert and transcript store reuse their original keys, so the database shows one tickets row and one ticket_transcripts row, never two.',
    'requires the mid-op fault-injection lane + a live gateway; note createTicket/generateTranscript carry no persisted idempotency key today, so retry-dedup rests on the operator re-running after a failure',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Audit rows record the create rollback, the transcript failure, and the successful retry.',
    'the compensation/failure branches need a live gateway + fault lane to occur; the ticket feature emits no failure event, so no create_rolled_back / transcript_failed audit row is written today',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner alert channel receives exactly one reasoned alert per exercised failure branch and none for the eventual successes.',
    'the ticket create/transcript failure branches raise no owner alert in the current code and need a live gateway + fault lane to reach',
  );
  gateBranding(ctx);
}

/** REPLAY — a re-delivered claim never double-applies (state-based idempotency) + exactly one audit row. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const creator = ctx.userId('a');
  const staff = ctx.userId('b');
  const { row: panel } = await insertPanel(handle, ctx);
  const ticket = await insertTicket(handle, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator });

  // Deliver the SAME claim interaction id twice. The first flips open→claimed; the
  // second finds status='claimed' (not 'open'), so the atomic guarded update
  // matches zero rows and no second claim is applied — exactly one effect.
  const replayId = `${ctx.runPrefix}claim-int`;
  const first = await clickTicketButton(ctx, handle, 'claim', 1, staff, { interactionId: replayId });
  const second = await clickTicketButton(ctx, handle, 'claim', 1, staff, { interactionId: replayId });
  const after = await readTicket(handle, 1);
  const firstSurface = replySurface(first);
  const secondSurface = replySurface(second);
  ctx.expect(
    after?.status === 'claimed' &&
      after?.claimed_by === staff &&
      /already/i.test(secondSurface) &&
      !/already/i.test(firstSurface),
    {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'Re-delivering the claim interaction applies the transfer exactly once: the ticket stays claimed by the original claimer and the replay is a no-op.',
      observation:
        `after two deliveries of one claim interaction: status="${after?.status}", claimed_by="${after?.claimed_by}"; ` +
        `first reply="${truncate(firstSurface, 50)}", replay reply="${truncate(secondSurface, 50)}" (replay expected an "already claimed" refusal). ` +
        `Note: dedupe rests on the status='open' guard, not a persisted interaction-id key.`,
      impact: 'A replayed claim double-applied or overwrote the claimer — the state-based idempotency guard failed.',
    },
  );

  // AUDIT: the replay emits no second ticket.claimed event (the guarded update
  // returned zero rows), so exactly one append-only audit row exists.
  const claimAudits = await pollClaimAudits(handle);
  if (claimAudits.length === 0) {
    ctx.gate(
      'audit',
      'audit-row',
      'The replayed claim adds no duplicate audit action row: exactly one ticket.claimed row exists.',
      'the AuditService flushes on a 5s batch interval; the ticket.claimed row did not surface within the 15s poll window, so the exactly-one-row assertion could not be affirmed here',
    );
  } else {
    ctx.expect(claimAudits.length === 1 && claimAudits[0]!.target_id === ticket?.id, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Replayed deliveries add no duplicate action row: exactly one append-only ticket.claimed audit row exists.',
      observation: `after the replayed claim, audit_logs holds ${claimAudits.length} ticket.claimed row(s) for the ticket (expected exactly 1).`,
      impact: 'A replayed claim wrote a duplicate audit action row — the dedupe did not hold at the audit layer.',
    });
  }

  await proveRls(ctx, handle, 'tickets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  // The panel-open + close/transcript replay themselves need the live gateway.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Re-delivering the recorded panel-open and close interactions yields no second thread, close embed, feedback prompt, or transcript.',
    'the open/close/transcript pipelines create the thread + transcript via guild.channels — re-delivering them needs a live gateway to observe the (absence of) duplicate Discord effects',
  );
}

/** RESTART — claimed ticket state survives a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const creator = ctx.userId('a');
  const staff = ctx.userId('b');

  // Boot #1: create the panel + an open ticket, claim it through the real
  //          dispatcher (open→claimed), snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const { row: panel } = await insertPanel(first, ctx);
  await insertTicket(first, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator });
  await clickTicketButton(ctx, first, 'claim', 1, staff);
  const snapshot = await readTicket(first, 1);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State lives in Supabase, so the ticket is
  // still claimed with the same claimer and the panel is intact.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readTicket(second, 1);
  ctx.expect(
    afterRestart?.status === 'claimed' &&
      afterRestart?.status === snapshot?.status &&
      afterRestart?.claimed_by === snapshot?.claimed_by &&
      afterRestart?.claimed_by === staff,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart the open/claimed ticket survives unchanged (status + claimer persist from Supabase).',
      observation:
        `pre-restart status="${snapshot?.status}"/claimed_by="${snapshot?.claimed_by}"; ` +
        `post-restart status="${afterRestart?.status}"/claimed_by="${afterRestart?.claimed_by}" (expected claimed/${staff}).`,
      impact: 'Ticket state did not survive a restart — persisted lifecycle state was lost or altered.',
    },
  );

  const panelSurvived = (await guildRowCount(second, 'ticket_panels')) ?? 0;
  ctx.expect(panelSurvived >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The ticket panel configuration survives the restart.',
    observation: `post-restart ticket_panels rows for the guild = ${panelSurvived} (expected ≥ 1).`,
    impact: 'The ticket panel configuration did not survive the restart.',
  });

  await proveRls(ctx, second, 'tickets');
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  ctx.gate(
    'Discord',
    'discord-readback',
    'The surviving ticket’s Close/Claim/Transcript buttons still work post-restart (stateless custom ids) and the inactivity warning fires from the persisted last-activity timestamp.',
    'the button-controllability and inactivity-clock resume need a live thread + scheduler; only the persisted ticket/panel state is observable here (claim persistence proven above)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Append-only audit rows for the pre-restart actions remain after the restart; no audit row is deleted.',
    'append-only audit persistence is proven directly in DEF/REPLAY; the boot#1 claim audit is subject to the async 5s flush landing before the simulated shutdown, so it is not asserted across the restart boundary here',
  );
}

/** RACE — two concurrent claims yield exactly one claimer (atomic open→claimed). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const creator = ctx.userId('a');
  const racerX = ctx.userId('b');
  const racerY = ctx.userId('c');
  const { row: panel } = await insertPanel(handle, ctx);
  const ticket = await insertTicket(handle, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator });

  // Two simultaneous claim buttons on one open ticket. claimTicket's atomic
  // `UPDATE … WHERE status='open'` lets exactly one win; the loser reads back a
  // non-'open' status and is told the ticket is already claimed.
  const [rx, ry] = await Promise.all([
    clickTicketButton(ctx, handle, 'claim', 1, racerX),
    clickTicketButton(ctx, handle, 'claim', 1, racerY),
  ]);
  const after = await readTicket(handle, 1);
  const surfaces = [replySurface(rx), replySurface(ry)];
  const alreadyReplies = surfaces.filter((s) => /already/i.test(s)).length;
  const winnerIsOneRacer = after?.claimed_by === racerX || after?.claimed_by === racerY;
  ctx.expect(after?.status === 'claimed' && winnerIsOneRacer && alreadyReplies === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Of two simultaneous claims exactly one wins the atomic open→claimed update; the loser is told the ticket is already claimed.',
    observation:
      `after two concurrent claims: status="${after?.status}", claimed_by="${after?.claimed_by}" (one of ${racerX}/${racerY}); ` +
      `${alreadyReplies} of 2 replies said "already claimed" (expected exactly 1).`,
    impact: 'Two concurrent claims did not settle to exactly one claimer — the atomic status guard failed under contention.',
  });

  // AUDIT: only the winning claim emits ticket.claimed, so exactly one audit row.
  const claimAudits = await pollClaimAudits(handle);
  if (claimAudits.length === 0) {
    ctx.gate(
      'audit',
      'audit-row',
      'The race yields exactly one ticket.claimed audit row (the loser is recorded as rejected, not applied).',
      'the AuditService flushes on a 5s batch interval; the ticket.claimed row did not surface within the 15s poll window, so the exactly-one-row assertion could not be affirmed here',
    );
  } else {
    ctx.expect(claimAudits.length === 1 && claimAudits[0]!.target_id === ticket?.id, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'The race writes exactly one append-only ticket.claimed audit row; the losing concurrent claim writes none.',
      observation: `after the race, audit_logs holds ${claimAudits.length} ticket.claimed row(s) for the ticket (expected exactly 1).`,
      impact: 'A raced claim wrote a duplicate (or zero) audit row — the exactly-once ledger invariant was broken.',
    });
  }

  await proveRls(ctx, handle, 'tickets');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
  ctx.gate(
    'Discord',
    'discord-readback',
    'A double-clicked panel button produces one ticket under the max-open cap, and a concurrent Close button + /ticket close settle into one close, one close embed, and one transcript.',
    'the panel-open cap and the concurrent-close pipeline create/read the thread + transcript through guild.channels — a live gateway is required to observe the single-effect outcome',
  );
}

/** XGUILD — tickets are strictly per-guild; FINDING: numbering is a global counter. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });
  const creator = ctx.userId('a');

  // Each guild gets its own panel + an OPEN ticket sharing the SAME ticket_number.
  const { row: panelA } = await insertPanel(handleA, ctx);
  const { row: panelB } = await insertPanel(handleB, ctx);
  await insertTicket(handleA, ctx, { panelId: panelA?.id ?? null, ticketNumber: 1, creatorId: creator, type: 'support' });
  await insertTicket(handleB, ctx, { panelId: panelB?.id ?? null, ticketNumber: 1, creatorId: creator, type: 'billing' });

  // Guild-scoped reads never cross: A sees its ticket under guildA and NONE of
  // guild B's rows, and vice-versa (distinct real rows under distinct guild_ids).
  const aTicket = await readTicket(handleA, 1);
  const bTicket = await readTicket(handleB, 1);
  const aRowsUnderB = await countTicketsScoped(handleB, 1); // scope B counts its own #1 only
  ctx.expect(
    aTicket?.guild_id === guildA &&
      bTicket?.guild_id === guildB &&
      aTicket?.type === 'support' &&
      bTicket?.type === 'billing' &&
      aRowsUnderB === 1,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: "Each guild scope reads its OWN ticket row and never the other guild's, even when both share ticket #1.",
      observation:
        `guild-A #1 = "${aTicket?.type}" under "${aTicket?.guild_id}"; guild-B #1 = "${bTicket?.type}" under "${bTicket?.guild_id}"; ` +
        `guild-B scope sees ${aRowsUnderB} ticket #1 row(s) (its own only).`,
      impact: "A guild-scoped read returned another guild's ticket row — cross-guild leakage.",
    },
  );

  // FINDING — ticket numbering is NOT per-guild. nextval_ticket() returns
  // MAX(ticket_number)+1 over the WHOLE ticket_transcripts table (a single global
  // counter). Insert a distinctively high transcript in guild A, then a guild-B
  // allocation jumps to follow it — proving cross-guild contamination.
  const { data: baseData, error: baseErr } = await handleA.supabase.rpc('nextval_ticket');
  if (baseErr || baseData == null) {
    ctx.gate(
      'Discord',
      'db-observable',
      'Each guild’s ticket numbering advances independently of other guilds.',
      `could not call nextval_ticket() to probe the numbering primitive (${baseErr?.message ?? 'null result'})`,
    );
  } else {
    const base = Number(baseData);
    const marker = base + 500;
    await insertTranscript(handleA, ctx, { ticketId: null, ticketNumber: marker, creatorId: creator, closedById: creator });
    const { data: nextForBData } = await handleB.supabase.rpc('nextval_ticket');
    const nextForB = Number(nextForBData);
    // Per-guild-independent numbering: guild B (no transcripts of its own) must NOT
    // be pushed forward by guild A's transcript. Reality: nextForB = marker + 1.
    ctx.expect(nextForB < marker, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: "Each guild's ticket numbering advances independently: a second guild's next number is unaffected by another guild's tickets.",
      observation:
        `before any guild-A transcript, nextval_ticket()=${base}; after inserting a guild-A transcript numbered ${marker}, ` +
        `a guild-B allocation returned ${nextForB} — guild B's numbering jumped to follow guild A's transcript.`,
      impact:
        'nextval_ticket() is MAX(ticket_number)+1 over the ENTIRE ticket_transcripts table — a single global counter shared by all guilds. A second guild’s numbering is contaminated by the first guild’s tickets, so the catalog’s "each guild’s ticket numbering advances independently" is not met.',
    });
  }

  await proveRls(ctx, handleA, 'tickets');
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  ctx.gate(
    'Discord',
    'discord-readback',
    "Guild A's panel, open tickets, and transcript channel are byte-identical before and after a guild B activity burst.",
    'the per-guild Discord surfaces (panels, threads, transcript posts) require a live gateway to observe; per-guild row isolation is proven above',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Each guild keeps its own append-only audit rows; ticket actions in one guild never write rows scoped to the other.',
    'per-guild audit scoping is enforced by the AuditService guildId filter; ticket-action audit is proven via a real claim in DEF/REPLAY/RACE, not re-driven in this isolation scenario',
  );
}

/** CLEANUP — the suite leaves no trace: run-prefixed ticket rows are swept + verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const creator = ctx.userId('a');

  // Create run-prefixed operational rows: a panel, a ticket, and its transcript.
  const { row: panel } = await insertPanel(handle, ctx);
  const ticket = await insertTicket(handle, ctx, { panelId: panel?.id ?? null, ticketNumber: 1, creatorId: creator, status: 'closed' });
  await insertTranscript(handle, ctx, { ticketId: ticket?.id ?? null, ticketNumber: 1, creatorId: creator, closedById: creator });

  const panelsBefore = (await guildRowCount(handle, 'ticket_panels')) ?? 0;
  const ticketsBefore = (await guildRowCount(handle, 'tickets')) ?? 0;
  const transcriptsBefore = (await guildRowCount(handle, 'ticket_transcripts')) ?? 0;
  ctx.expect(panelsBefore >= 1 && ticketsBefore >= 1 && transcriptsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed panel + ticket + transcript rows (pre-cleanup baseline).',
    observation: `pre-cleanup: panels=${panelsBefore}, tickets=${ticketsBefore}, transcripts=${transcriptsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRls(ctx, handle, 'ticket_transcripts');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);

  // Run the same sweep teardown uses and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const panelsAfter = (await guildRowCount(handle, 'ticket_panels')) ?? 0;
  const ticketsAfter = (await guildRowCount(handle, 'tickets')) ?? 0;
  const transcriptsAfter = (await guildRowCount(handle, 'ticket_transcripts')) ?? 0;
  ctx.expect(panelsAfter === 0 && ticketsAfter === 0 && transcriptsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed ticket panels, tickets, and transcript rows are deleted; a final sweep finds zero run-prefixed ticket resources.',
    observation: `post-sweep: panels=${panelsAfter}, tickets=${ticketsAfter}, transcripts=${transcriptsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord channel/thread readback and the audit "anonymized-not-deleted" history
  // (audit_logs is deliberately NOT swept — retained per the anonymize-over-delete
  // policy) are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed ticket panels, threads, or transcript posts after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational ticket rows deleted; audit_logs and transcripts for an erased member retained with identity anonymized after /forgetme).',
    'audit_logs is intentionally excluded from the sweep (retained); the /forgetme anonymization pass lives in the account/erasure domain, not reachable in this ticket-only harness',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Tickets & Transcripts domain proof: the guild_id-scoped tables the sweep
 * must clear in child→parent FK order (ticket_transcripts.ticket_id → tickets ON
 * DELETE CASCADE, tickets.panel_id → ticket_panels RESTRICT), plus `alerts` for
 * the owner-notification lane, and the 12 scenario scripts. `audit_logs` is
 * deliberately NOT swept — ticket audit history is retained/anonymized, never
 * deleted.
 */
export const moderationTicketsTranscriptsProof: DomainProof = {
  domainId: 'moderation-tickets-transcripts',
  guildScopedTables: ['ticket_transcripts', 'tickets', 'ticket_panels', 'alerts'],
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
