/**
 * scenario-runner/scripts/community-scheduled-messages — the Scheduled Messages proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proofs driven against LOCAL Supabase. Unlike the wallet domain, Scheduled
 * Messages exposes NO slash command: schedules are created on the dashboard
 * (service-role/owner writes into `scheduled_messages` + `embed_configs`) and
 * fired by the in-process `ScheduledMessageRunner`, which posts to a Discord
 * channel on a cron/timezone tick. That runner needs a live gateway and
 * wall-clock time to observe, so this domain is MOSTLY GATED.
 *
 * What runs NOW against local Supabase (real rows read back, never synthetic):
 *   - Durable persistence of a dashboard-created schedule (cron + timezone + text
 *     variables + embed linkage) — the exact substrate the runner reads (DEF/SET-A/SET-B).
 *   - Row-level security: anon reads/writes zero `scheduled_messages`/`embed_configs`
 *     rows while the service role sees them (owner_full_access RLS + the anon GRANT
 *     revoked by the RLS lockdown sweep) — proven with a positive control (UNAUTH/XGUILD).
 *   - The embed_config_id foreign key is enforced (SET-B).
 *   - Strict per-guild isolation + independent pause (XGUILD).
 *   - State durability across a full stack restart (RESTART).
 *   - The cleanup sweep leaves zero run-prefixed rows (CLEANUP).
 *
 * What is GATED honestly (never faked): the actual channel POST, exactly-once
 * firing, DST-correct occurrence timing, transient-send retry, missed-run policy,
 * concurrent occurrence-claim, and the owner failure alert — all require the live
 * runner + a Discord gateway (and, for the failure lanes, fault injection).
 *
 * Behavior-bug notes surfaced to the owner (see the run summary): the current
 * runner has NO durable per-occurrence record or idempotency key (dedup is a
 * 55-second `last_sent_at` window), writes NO audit rows, raises NO owner alert /
 * marks no failed state on a missing channel, performs NO retry/backoff, and
 * honors NO missed-run policy. Those divergences from the catalog contract are
 * recorded as precise GATES here (they cannot be observed in a bot-only harness)
 * and called out for adjudication; none is softened into a false PASS.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface ScheduleRow {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string;
  message: string | null;
  embed_config_id: string | null;
  cron_expression: string;
  timezone: string;
  active: boolean;
  current_sends: number;
  last_sent_at: string | null;
}

interface EmbedConfigRow {
  id: string;
  guild_id: string;
  name: string;
  title: string | null;
  description: string | null;
  fields: JsonValue;
}

interface ScheduleInsert {
  name: string;
  channel_id: string;
  cron_expression: string;
  message?: string | null;
  embed_config_id?: string | null;
  timezone?: string;
  active?: boolean;
  last_sent_at?: string;
  current_sends?: number;
}

const SCHEDULE_COLS =
  'id, guild_id, name, channel_id, message, embed_config_id, cron_expression, timezone, active, current_sends, last_sent_at';

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function truncate(text: string | null | undefined, max = 90): string {
  const s = text ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Insert a schedule (dashboard-create equivalent) via the service role; read it back. */
async function insertSchedule(
  handle: LiveClientHandle,
  fields: ScheduleInsert,
): Promise<ScheduleRow | null> {
  const { data } = await handle.supabase
    .from('scheduled_messages')
    .insert({ guild_id: handle.guildId, timezone: 'UTC', active: true, ...fields })
    .select(SCHEDULE_COLS)
    .single();
  return (data as ScheduleRow | null) ?? null;
}

async function readScheduleById(handle: LiveClientHandle, id: string): Promise<ScheduleRow | null> {
  const { data } = await handle.supabase
    .from('scheduled_messages')
    .select(SCHEDULE_COLS)
    .eq('id', id)
    .maybeSingle();
  return (data as ScheduleRow | null) ?? null;
}

async function scheduleCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('scheduled_messages')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function embedConfigCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('embed_configs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors, so
 * a failed read can never masquerade as "no alert raised" — the caller GATEs on
 * null rather than recording a false-clean PASS.
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
 * Anon-denial READ probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS/GRANT deny → 0), or null when inconclusive (no
 * anon key/URL, network error, or a pre-authz key rejection → GATE).
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (anon blocked from the
    // table by RLS / a revoked GRANT — the deny we want) from a key rejected
    // before authz ran (inconclusive → GATE). PostgREST surfaces the former as
    // SQLSTATE 42501 "permission denied for table" (HTTP 401/403).
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
 * Anon-denial WRITE probe: attempt an anon INSERT via PostgREST. Returns true when
 * the write is denied (permission error — the admin-only barrier we want), false
 * when it unexpectedly persists (a breach → FAIL), or null when inconclusive (GATE).
 */
async function anonWriteDenied(
  anonKey: string,
  table: string,
  payload: Record<string, unknown>,
): Promise<boolean | null> {
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
      body: JSON.stringify(payload),
    });
    if (res.ok) return false; // the anon INSERT succeeded — the barrier failed
    if (res.status === 401 || res.status === 403) return true;
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove anon-denial for a guild-scoped table, made non-vacuous by a positive
 * control: the scenario already created rows the service role can see, so an anon
 * client reading ZERO of them is a real deny, not "nothing to read." Cross-GUILD
 * isolation across two REAL guilds is proven separately in XGUILD.
 */
async function proveRls(ctx: ScenarioContext, handle: LiveClientHandle, table: string): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (owner_full_access RLS + the anon GRANT revoked by the RLS lockdown sweep).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-denial probe cannot run — service-role/guild scoping is still proven by the scoped reads and XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows.`,
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  const serviceSees = (count ?? 0) > 0;
  ctx.expect(serviceSees && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild’s ${table} row(s) while an anon client reads zero of them (owner_full_access RLS + revoked anon GRANT).`,
    observation:
      `service-role sees ${count ?? 0} ${table} row(s) for guild "${handle.guildId}"; ` +
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
    'Failure-branch alerts carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Branding for this domain is a live-guild readback lane: every member-facing
 * surface is a channel POST delivered by the runner over the Discord gateway, so
 * the bot-only local-Supabase harness produces no captured reply/embed to inspect.
 * GATE it (never a hollow PASS).
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing scheduled-messages surface shows the owner brand name, colors, and voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.',
    'scheduled messages have no slash-command surface — the only member-facing surface is a channel post delivered via the Discord gateway, so a bot-only harness produces no captured reply/embed to inspect (branding is a live-guild readback lane)',
  );
}

/**
 * Audit rows are not written by the bot for scheduled-message actions (the runner
 * records none; schedule create/edit/delete auditing is a dashboard save-path
 * concern), so there is nothing to observe in a bot-only harness. GATE + note.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every scheduled-messages state change lands exactly one append-only audit row with actor, guild, and correlation id; no audit row is ever deleted.',
    'the bot writes no audit rows for scheduled-message actions today (the runner records none; schedule create/edit/delete audit is a dashboard save-path concern) — not reachable in a bot-only harness (see run summary)',
  );
}

/**
 * Replay/idempotency for scheduled messages is exercised in REPLAY/RACE and is
 * itself gated: there is no durable per-occurrence record or idempotency key.
 */
function gateReplaySafety(ctx: ScenarioContext): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggering events yields no duplicate posted occurrences or occurrence records; persisted idempotency keys show exactly one effect per logical action.',
    'replay/idempotency is exercised in REPLAY/RACE and is gated there: the runner keeps no durable per-occurrence record or idempotency key (dedup is a 55-second last_sent_at window) — see run summary',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — a dashboard-created every-minute UTC text schedule persists durably. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const tzDefault = String(declaredDefault(ctx.domain, 'default-timezone')); // 'UTC'
  const handle = await ctx.bootGuild({ label: 'a' });
  const cron = '* * * * *';
  const message = 'Good morning {server} — {members} of us and counting. Make today a good one!';

  const row = await insertSchedule(handle, {
    name: `${ctx.runPrefix}def`,
    channel_id: `${ctx.runPrefix}chan-def`,
    message,
    cron_expression: cron,
    timezone: tzDefault,
    active: true,
  });
  ctx.expect(
    row?.cron_expression === cron &&
      row?.timezone === tzDefault &&
      row?.active === true &&
      row?.current_sends === 0 &&
      (row?.message ?? '').includes('{server}') &&
      (row?.message ?? '').includes('{members}'),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `A dashboard-created every-minute schedule persists durably: cron "${cron}", timezone "${tzDefault}" (catalog default-timezone), active, send-count zero, with its variable-bearing text ({server}/{members}) stored verbatim for the runner to substitute.`,
      observation:
        `stored cron="${row?.cron_expression}", timezone="${row?.timezone}", active=${row?.active}, ` +
        `current_sends=${row?.current_sends}, message="${truncate(row?.message)}".`,
      impact:
        'The scheduled-message persistence contract diverged — the durable schedule the runner reads was not stored as created.',
    },
  );

  // The actual post (exactly one per minute boundary, with substituted variables)
  // needs the runner firing against a live gateway across a multi-minute window.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Across a multi-minute window the target channel shows exactly one post per cron match with live variable values — never zero, never two.',
    'the runner posts to the channel over the Discord gateway on a wall-clock tick; observing per-minute exactly-once delivery requires DISCORD_TOKEN + a live guild + a multi-minute window',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** SET-A — a distinct config (daily 09:00 America/New_York) takes effect and persists. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const tz = 'America/New_York';
  const cron = '0 9 * * *';

  const row = await insertSchedule(handle, {
    name: `${ctx.runPrefix}set-a`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'Daily 9am ET check-in',
    cron_expression: cron,
    timezone: tz,
    active: true,
  });
  ctx.expect(row?.timezone === tz && row?.cron_expression === cron && row?.active === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'A distinct configuration takes effect and persists: a daily 09:00 schedule stores its IANA timezone (America/New_York) and cron ("0 9 * * *") verbatim for timezone-aware evaluation.',
    observation: `stored timezone="${row?.timezone}", cron="${row?.cron_expression}", active=${row?.active}.`,
    impact:
      'A saved timezone/cron configuration was not persisted as entered — the schedule would evaluate against the wrong wall-clock.',
  });

  // DST correctness: the 13:00-UTC-summer / 14:00-UTC-winter occurrence split is
  // computed LIVE inside the runner and is NOT persisted (no next-occurrence column),
  // so there is no stored UTC occurrence to diff — this is a runner+gateway proof.
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The stored next-occurrence straddling the DST boundary differs by exactly the DST hour in UTC (13:00 UTC summer vs 14:00 UTC winter).',
    'the runner computes occurrences live from cron+timezone and persists no next-occurrence/occurrence row (see run summary), so there is no stored UTC occurrence to diff — DST correctness is only observable by firing the runner across the boundary',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A live fire of the daily 09:00 America/New_York schedule lands at the local wall-clock minute (13:00 UTC in summer, 14:00 UTC in winter).',
    'requires firing the runner against a live Discord gateway across the DST boundary (DISCORD_TOKEN + live guild)',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** SET-B — an embed schedule built from a saved embed config links + persists; FK enforced. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  const { data: embData } = await handle.supabase
    .from('embed_configs')
    .insert({
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}emb`,
      title: 'Weekly Roundup',
      description: 'Here is what happened in {server}.',
      color: 0x5865f2,
      fields: [{ name: 'Members', value: '{members}', inline: true }],
      footer_text: 'From your community',
    })
    .select('id, guild_id, name, title, description, fields')
    .single();
  const emb = (embData as EmbedConfigRow | null) ?? null;

  const sch = await insertSchedule(handle, {
    name: `${ctx.runPrefix}set-b`,
    channel_id: `${ctx.runPrefix}chan`,
    message: null,
    embed_config_id: emb?.id,
    cron_expression: '0 12 * * 1',
    timezone: 'UTC',
    active: true,
  });
  ctx.expect(
    Boolean(emb?.id) && sch?.embed_config_id === emb?.id && sch?.message === null && emb?.title === 'Weekly Roundup',
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A second configuration takes effect: an embed schedule built from a saved embed config links to that config (embed_config_id FK) with no plain-text body, so the runner posts the saved embed field-for-field.',
      observation:
        `schedule.embed_config_id ${sch?.embed_config_id === emb?.id ? 'matches the saved config' : 'MISMATCH'}, ` +
        `message=${sch?.message === null ? 'null (embed-only)' : 'unexpectedly set'}, saved embed title="${emb?.title}".`,
      impact: 'The embed-schedule linkage did not persist — the runner would have no saved embed to post.',
    },
  );

  // The embed_config_id foreign key is REAL: a schedule cannot reference a missing config.
  const bogusId = '00000000-0000-0000-0000-000000000000';
  const { error: fkErr } = await handle.supabase.from('scheduled_messages').insert({
    guild_id: handle.guildId,
    name: `${ctx.runPrefix}set-b-fk`,
    channel_id: `${ctx.runPrefix}chan`,
    cron_expression: '0 12 * * 1',
    timezone: 'UTC',
    embed_config_id: bogusId,
    active: true,
  });
  ctx.expect(Boolean(fkErr), {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The embed_config_id foreign key is enforced: a schedule cannot reference a non-existent embed config.',
    observation: `inserting a schedule with a dangling embed_config_id ${fkErr ? `was rejected (${fkErr.code ?? fkErr.message})` : 'unexpectedly succeeded'}.`,
    impact: 'A schedule could reference a missing embed config — an integrity gap the runner would silently post nothing for.',
  });

  // Full-embed posting + the send-latest catch-up after downtime need the runner.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The schedule posts the full saved embed (title/description/fields/footer), and after a downtime spanning two occurrences exactly one catch-up post sends under missed-run policy send-latest.',
    'the runner performs no missed-occurrence catch-up (missed-run-policy is not implemented — see run summary) and posting needs a live Discord gateway; both are outside a bot-only harness',
  );

  await proveRls(ctx, handle, 'embed_configs');
  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** INVALID — a rejected malformed cron / unknown timezone never persists. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const cron = '0 12 * * *';

  const row = await insertSchedule(handle, {
    name: `${ctx.runPrefix}invalid-valid`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'valid baseline',
    cron_expression: cron,
    timezone: 'UTC',
    active: true,
  });
  const count = await scheduleCount(handle);
  ctx.expect(row?.cron_expression === cron && row?.timezone === 'UTC' && count === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'A valid schedule persists byte-for-byte and remains the only schedule row; a rejected invalid save never adds or corrupts a row.',
    observation: `stored cron="${row?.cron_expression}", timezone="${row?.timezone}"; schedule rows for guild=${count} (expected exactly 1, the valid one).`,
    impact: 'The valid baseline schedule was not retained cleanly.',
  });

  // The actual REJECTION of a six-field cron / fictional timezone lives in the
  // dashboard Zod layer; scheduled_messages carries NO CHECK on cron_expression or
  // timezone, so the DB would accept them (the runner’s matchesCron simply returns
  // false for a non-5-field cron → a silent no-op, not a validated reject). GATE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard rejects the six-field cron and the fictional timezone with clear errors; no schedule row is written and nothing ever fires from the attempts.',
    'cron/timezone validation lives in the dashboard (Zod) layer; scheduled_messages has no DB CHECK on cron_expression/timezone, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Each rejected save lands one audit row with its validation reason.',
    'the rejected-save audit row is written by the dashboard save path (audit_logs), not reachable in a bot-only harness',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** UNAUTH — schedules are admin-only: a non-admin (anon) client cannot create one. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Arrange: an admin-created (service-role) schedule exists and is active.
  const admin = await insertSchedule(handle, {
    name: `${ctx.runPrefix}unauth-admin`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'admin schedule',
    cron_expression: '0 12 * * *',
    timezone: 'UTC',
    active: true,
  });

  // Prove the admin-only write barrier at the RLS/GRANT layer: an anon (non-admin)
  // client cannot INSERT a schedule (owner_full_access FOR ALL + REVOKE ALL from anon).
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'A non-admin (anon) client cannot create a schedule row (owner-only RLS + the anon GRANT revoked).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon write-deny probe cannot run — the anon read-deny probe below still exercises the same owner_full_access policy',
    );
  } else {
    const denied = await anonWriteDenied(anonKey, 'scheduled_messages', {
      guild_id: handle.guildId,
      name: `${ctx.runPrefix}unauth-anon`,
      channel_id: `${ctx.runPrefix}chan`,
      message: 'anon attempt',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      active: true,
    });
    if (denied === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'A non-admin (anon) client cannot create a schedule row.',
        'the anon REST write probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS/GRANT evaluated)',
      );
    } else {
      ctx.expect(denied === true, {
        assertionClass: 'database-RLS',
        channel: 'db-rls',
        promise:
          'A non-admin (anon) dashboard client cannot create a schedule: the anon role is denied INSERT on scheduled_messages (owner_full_access RLS + revoked anon GRANT).',
        observation: `anon-key REST INSERT into scheduled_messages was ${denied ? 'denied (permission error)' : 'ACCEPTED — the row persisted'}.`,
        impact:
          'A non-admin client could create a schedule row directly — the admin-only write barrier is not enforced at the database layer.',
      });
    }
  }

  // The denied write left the admin schedule untouched: still present + active.
  const after = admin?.id ? await readScheduleById(handle, admin.id) : null;
  ctx.expect(after?.id === admin?.id && after?.active === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Existing schedules keep firing unchanged: the admin-created schedule remains present and active after the denied non-admin write.',
    observation: `admin schedule after the denied write: present=${after?.id === admin?.id}, active=${after?.active}.`,
    impact: 'A denied non-admin write disturbed an existing admin schedule.',
  });

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  ctx.gate(
    'audit',
    'audit-row',
    'Each denied write is audited with actor and reason.',
    'the denied-write audit row is written by the dashboard save path (audit_logs), not reachable in a bot-only harness',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The non-admin create/delete attempts return a clear dashboard permission error while the existing schedule keeps posting on cadence.',
    'requires the dashboard session-auth lane plus live-guild post readback (DISCORD_TOKEN + live guild)',
  );
  gateReplaySafety(ctx);
}

/** DEPFAIL — a deleted target channel fails safe (affected schedule alone stops). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Two independent active schedules: A (would lose its channel) and B (keeps firing).
  const a = await insertSchedule(handle, {
    name: `${ctx.runPrefix}depfail-a`,
    channel_id: `${ctx.runPrefix}chan-a`,
    message: 'A',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });
  const b = await insertSchedule(handle, {
    name: `${ctx.runPrefix}depfail-b`,
    channel_id: `${ctx.runPrefix}chan-b`,
    message: 'B',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });
  ctx.expect(
    Boolean(a?.id && b?.id) &&
      a?.id !== b?.id &&
      a?.active === true &&
      b?.active === true &&
      a?.channel_id !== b?.channel_id,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Two schedules coexist as independent active rows (distinct ids + target channels), so one failing cannot structurally stop the other.',
      observation:
        `A id=…${a?.id?.slice(-6)} chan="${a?.channel_id}" active=${a?.active}; ` +
        `B id=…${b?.id?.slice(-6)} chan="${b?.channel_id}" active=${b?.active}.`,
      impact: 'Schedules are not independent rows — a shared record would couple failures across schedules.',
    },
  );

  // The fail-safe BEHAVIOR (deleted channel → A marks failed, ONE owner alert, B keeps
  // posting) needs the live runner + a channel-deletion fault lane. The current runner
  // also does NOT implement this contract — it log-warns and returns on a missing
  // channel, marks no failed state (no such column) and raises no alert (see summary).
  ctx.gate(
    'Discord',
    'discord-readback',
    'After schedule A’s channel is deleted, A marks failed without crash loops while B keeps posting on cadence; repairing the channel re-arms A cleanly.',
    'requires a channel-deletion fault lane + live Discord gateway; the current runner has no failed-state/occurrence record (it log-warns and returns on a missing channel) — see run summary',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one delivery-failed alert names schedule A, the missing channel, and the reason.',
    'requires the channel-deletion fault lane + owner alert channel readback; the runner raises no owner alert on a missing channel today — see run summary',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One scheduled_messages.channel_missing audit row records the failed occurrence.',
    'requires the fault lane; no audit row is written for scheduled-message delivery today',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** RETRY — a transient send error converges (occurrence lands exactly once). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  await insertSchedule(handle, {
    name: `${ctx.runPrefix}retry`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'retry me',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });

  // The retry/converge behavior needs a mid-send transient-fault lane + the runner.
  // The current runner has NO retry/backoff: a throw is caught per-schedule and
  // logged, the occurrence is not retried (see run summary).
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a transient fault on the first post attempt, the retry posts the occurrence exactly once.',
    'requires a mid-send transient-fault lane + live Discord gateway; the current runner has no retry/backoff (a throw is caught per-schedule and logged) — see run summary',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The occurrence record shows a single sent marker across all attempts.',
    'there is no durable per-occurrence record in the schema (only last_sent_at/current_sends on the schedule row); exactly-once-after-retry cannot be observed without an occurrence table + the fault lane',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'A scheduled_messages.send_retried audit row is written for the retried delivery.',
    'requires the transient-fault lane; the runner writes no audit rows for delivery',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle); // ownerNotification=false for transient errors
  gateBranding(ctx);
}

/** REPLAY — re-running the runner tick over an already-sent occurrence sends nothing. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Simulate a prior send by stamping the runner's dedup substrate on the row.
  const sentAt = new Date().toISOString();
  const row = await insertSchedule(handle, {
    name: `${ctx.runPrefix}replay`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'once',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
    last_sent_at: sentAt,
    current_sends: 1,
  });
  ctx.expect(row?.current_sends === 1 && Boolean(row?.last_sent_at), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A sent occurrence is recorded on the schedule row (current_sends incremented, last_sent_at stamped) — the state a replayed tick must not double-apply.',
    observation: `current_sends=${row?.current_sends}, last_sent_at=${row?.last_sent_at ? 'set' : 'null'}.`,
    impact: 'The send-tracking fields were not persisted — the runner would have no dedup substrate at all.',
  });

  // The replay guarantee can only be observed by driving the runner. Dedup today is
  // a 55-SECOND last_sent_at window (NOT a durable per-occurrence idempotency key),
  // so a replayed tick >55s later, or clock skew, could re-send (see run summary).
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-running the runner tick over an already-sent occurrence sends nothing (a durable occurrence key dedupes the replay as a no-op).',
    'requires driving the runner against a live gateway; dedup today is a 55-second last_sent_at time-window on the schedule row, not a durable per-occurrence idempotency key — see run summary',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'Exactly one post remains for the occurrence after a duplicate evaluation.',
    'requires firing the runner twice against a live Discord gateway',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The replayed tick is recorded as a no-op audit row.',
    'the runner writes no audit rows for occurrence evaluation',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** RESTART — schedule + send-tracking survive a full stack restart (state lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const name = `${ctx.runPrefix}restart`;
  const sentAt = new Date().toISOString();

  // Boot #1: create a schedule + simulate a prior send, snapshot, shutdown.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const snap = await insertSchedule(first, {
    name,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'survivor',
    cron_expression: '0 9 * * *',
    timezone: 'America/New_York',
    active: true,
    last_sent_at: sentAt,
    current_sends: 3,
  });
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State must be identical — it lives in Supabase.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const { data: reData } = await second.supabase
    .from('scheduled_messages')
    .select(SCHEDULE_COLS)
    .eq('guild_id', guildId)
    .eq('name', name)
    .maybeSingle();
  const after = (reData as ScheduleRow | null) ?? null;
  ctx.expect(
    after?.id === snap?.id &&
      after?.cron_expression === snap?.cron_expression &&
      after?.timezone === snap?.timezone &&
      after?.current_sends === 3 &&
      after?.last_sent_at === snap?.last_sent_at,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the schedule and its send-tracking survive exactly: cron, timezone, current_sends, and last_sent_at match the pre-restart snapshot (state lives in Supabase, not memory).',
      observation:
        `pre: cron="${snap?.cron_expression}" tz="${snap?.timezone}" sends=${snap?.current_sends}; ` +
        `post: cron="${after?.cron_expression}" tz="${after?.timezone}" sends=${after?.current_sends}, ` +
        `last_sent preserved=${after?.last_sent_at === snap?.last_sent_at}.`,
      impact: 'Schedule state did not survive a restart — cadence/dedup would reset (risking duplicate or dropped sends).',
    },
  );

  // "Sent occurrence not re-sent after restart" + "missed occurrence → skip-missed
  // with one owner notice" need the runner + timing. The runner effectively skips
  // missed occurrences (it only matches live cron) but writes NO missed-occurrence
  // owner notice — a divergence from missed-run-policy (see run summary).
  ctx.gate(
    'Discord',
    'discord-readback',
    'Post-restart posts resume at the correct wall-clock minutes with no duplicate for the pre-restart occurrence.',
    'requires firing the runner against a live Discord gateway across the restart',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'An occurrence missed during the restart window is handled per skip-missed with exactly one owner notice.',
    'requires the downtime/runner lane; the runner sends no missed-occurrence owner notice today (missed-run-policy is not implemented) — see run summary',
  );

  await proveRls(ctx, second, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, second);
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** RACE — concurrent runner evaluation is safe (two ticks over one occurrence → one post). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  const row = await insertSchedule(handle, {
    name: `${ctx.runPrefix}race`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'contested',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });
  ctx.expect(Boolean(row?.id) && row?.active === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A single durable schedule row is the contested resource two racing runner ticks would evaluate.',
    observation: `schedule row present=${Boolean(row?.id)}, active=${row?.active}.`,
    impact: 'The schedule row was not created — there is no substrate for the concurrency proof.',
  });

  // Atomic single-claim needs the runner. The schema has NO atomic occurrence-claim
  // primitive (no occurrence table, no claim RPC, no unique occurrence key); dedup is
  // a read-modify-write of last_sent_at, so two concurrent ticks could both pass the
  // 55s check and double-send (see run summary).
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Two ticks claiming the same due occurrence produce exactly one durable occurrence record and one send; the other backs off silently.',
    'no atomic occurrence-claim exists (no occurrence row / claim RPC / unique key); the last_sent_at read-modify-write is not a serializable claim — the single-winner guarantee cannot be observed or upheld here (see run summary)',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'Exactly one post exists for the contested occurrence.',
    'requires two concurrent runner ticks against a live Discord gateway',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One occurrence-claim audit row records the winning tick.',
    'the runner writes no audit rows for occurrence claims',
  );

  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** XGUILD — schedules are strictly per-guild; pausing one guild stops only that guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA });
  const handleB = await ctx.bootGuild({ guildId: guildB });
  const cron = '* * * * *';

  const a = await insertSchedule(handleA, {
    name: `${ctx.runPrefix}xg-a`,
    channel_id: `${ctx.runPrefix}chan-a`,
    message: 'A only',
    cron_expression: cron,
    timezone: 'UTC',
    active: true,
  });
  const b = await insertSchedule(handleB, {
    name: `${ctx.runPrefix}xg-b`,
    channel_id: `${ctx.runPrefix}chan-b`,
    message: 'B only',
    cron_expression: cron,
    timezone: 'UTC',
    active: true,
  });

  // Pausing B stops only B: set B inactive, assert A stays active.
  await handleB.supabase.from('scheduled_messages').update({ active: false }).eq('id', b?.id ?? '');
  const aAfter = a?.id ? await readScheduleById(handleA, a.id) : null;
  const bAfter = b?.id ? await readScheduleById(handleB, b.id) : null;
  ctx.expect(
    aAfter?.active === true &&
      bAfter?.active === false &&
      a?.guild_id === guildA &&
      b?.guild_id === guildB,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Identical cron schedules in two guilds are independent: pausing guild B’s schedule (active=false) leaves guild A’s schedule active, and each row is anchored to its own guild.',
      observation:
        `after pausing B: A active=${aAfter?.active} under "${a?.guild_id}", B active=${bAfter?.active} under "${b?.guild_id}".`,
      impact: 'Pausing one guild’s schedule affected the other, or a schedule was not guild-anchored — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN schedule row and never the other's.
  const { data: aScoped } = await handleA.supabase
    .from('scheduled_messages')
    .select('name, guild_id')
    .eq('guild_id', guildA)
    .maybeSingle();
  const { data: bScoped } = await handleB.supabase
    .from('scheduled_messages')
    .select('name, guild_id')
    .eq('guild_id', guildB)
    .maybeSingle();
  const aRow = aScoped as { name: string; guild_id: string } | null;
  const bRow = bScoped as { name: string; guild_id: string } | null;
  ctx.expect(
    aRow?.guild_id === guildA &&
      aRow?.name === `${ctx.runPrefix}xg-a` &&
      bRow?.guild_id === guildB &&
      bRow?.name === `${ctx.runPrefix}xg-b`,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads only its own schedule row: guild A → its "xg-a" row, guild B → its "xg-b" row; neither scope returns the other’s.',
      observation:
        `guild-A-scoped read name="${aRow?.name}" under "${aRow?.guild_id}"; ` +
        `guild-B-scoped read name="${bRow?.name}" under "${bRow?.guild_id}".`,
      impact: 'A guild-scoped read returned the other guild’s schedule — cross-guild leakage.',
    },
  );

  await proveRls(ctx, handleA, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handleA);
  gateAudit(ctx);
  gateBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'Guild A keeps posting after guild B’s schedule is paused; neither guild ever receives the other’s posts.',
    'requires firing both guilds’ runners against a live Discord gateway',
  );
  gateReplaySafety(ctx);
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Run-prefixed rows: an embed config + an embed-backed schedule + a text schedule.
  const { data: embData } = await handle.supabase
    .from('embed_configs')
    .insert({ guild_id: handle.guildId, name: `${ctx.runPrefix}cleanup-emb`, title: 'Cleanup', description: 'x' })
    .select('id')
    .single();
  const embId = (embData as { id: string } | null)?.id;
  await insertSchedule(handle, {
    name: `${ctx.runPrefix}cleanup-text`,
    channel_id: `${ctx.runPrefix}chan`,
    message: 'text',
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });
  await insertSchedule(handle, {
    name: `${ctx.runPrefix}cleanup-embed`,
    channel_id: `${ctx.runPrefix}chan`,
    embed_config_id: embId,
    cron_expression: '* * * * *',
    timezone: 'UTC',
    active: true,
  });

  const schedulesBefore = await scheduleCount(handle);
  const embedsBefore = await embedConfigCount(handle);
  ctx.expect(schedulesBefore >= 2 && embedsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed schedule + embed-config rows (pre-cleanup baseline).',
    observation: `pre-cleanup: schedule rows=${schedulesBefore}, embed-config rows=${embedsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRls(ctx, handle, 'scheduled_messages');
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const schedulesAfter = await scheduleCount(handle);
  const embedsAfter = await embedConfigCount(handle);
  ctx.expect(schedulesAfter === 0 && embedsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed schedule and embed-config rows are deleted; a final sweep finds zero run-prefixed scheduled-messages resources.',
    observation: `post-sweep: schedule rows=${schedulesAfter}, embed-config rows=${embedsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord channel readback of removed posts, and audit "anonymized-not-deleted"
  // history, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed scheduled posts remain in the test guild and none appear after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; this domain writes no operational audit rows today (see run summary)',
  );
  gateReplaySafety(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Scheduled Messages domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before the guild row),
 * plus the 12 scenario scripts.
 *
 * `scheduled_messages.embed_config_id` REFERENCES `embed_configs(id)` (no cascade),
 * so schedules are swept BEFORE their embed configs; `alerts` is swept for the
 * owner-notification probe. `guild_config` + `guild` are swept by the runner.
 */
export const communityScheduledMessagesProof: DomainProof = {
  domainId: 'community-scheduled-messages',
  guildScopedTables: [
    'scheduled_messages',
    'embed_configs',
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
