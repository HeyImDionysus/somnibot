/**
 * scenario-runner/scripts/music-player-fairness — the player-fairness domain proof.
 *
 * Binds the music-player-fairness domain's 12 declarative catalog scenarios to
 * concrete, real-stack proofs driven against LOCAL Supabase. This domain is
 * MOSTLY GATED, and honestly so: the fairness engine (queue, vote sets, skip
 * routing, playback) lives in Valkey + a Lavalink (Shoukaku) node + the Discord
 * gateway — NONE of which the bot-only local-Supabase harness has. The one thing
 * that IS persisted in Supabase is the fairness CONFIG on `guild_config`
 * (`dj_role_id` + the music columns the player actually reads), so every
 * config-persistence / RLS-isolation / cross-guild / cleanup assertion runs NOW
 * against real rows; everything that needs an audible track, a vote tally, a
 * force-skip, an owner outage alert, or a member-facing fairness embed is GATED
 * with a precise reason (never faked, never a hollow pass).
 *
 * Why no slash command is driven here: `initGuildFeatures` only wires the
 * `MusicPlayerManager` when `guild_config.music_enabled !== false`, and the
 * live-runner deliberately seeds `music_enabled = false` because the manager needs
 * a Shoukaku node + Valkey queue that do not exist gateway-less (guild-init.ts:289
 * + live-runner.ts). So the music commands are not even in the exposed set; the
 * evidence this proof can stand on is the guild_config config layer + its RLS.
 *
 * Behavior-bug discovery (surfaced as a FAIL, never softened): the catalog
 * declares five fairness controls, but only `dj-role-id` is schema-backed. There
 * is NO `guild_config` column for `vote-skip-threshold-percent`,
 * `self-skip-enabled`, `priority-voting-enabled`, or `requester-move-enabled`, and
 * `music-player.ts` hardcodes a `ceil(listeners/2)` majority in `voteSkip` and
 * routes every non-DJ /skip into that same vote (no requester self-skip bypass).
 * SET-B proves the missing storage DB-observably (a real column probe that FAILs),
 * so raising the threshold to 100 can never take effect — a finding for the owner.
 * The remaining behavioral divergences (self-skip bypass absent; no `music.*`
 * audit rows are ever written — the audit EVENT_TO_AUDIT map has no music events)
 * are only observable by driving a live skip/vote, so they are GATED with reasons
 * that name the gap rather than fabricated into a runtime FAIL.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Small live-stack helpers ──────────────────────────────────────────────

/** The fairness CONFIG columns that are actually schema-backed on guild_config
 *  (the player reads dj_role_id + the music_* columns in music-player.ts:110). */
interface MusicConfigRow {
  dj_role_id: string | null;
  music_enabled: boolean | null;
  music_default_volume: number | null;
  music_auto_leave_minutes: number | null;
  music_auto_destroy_minutes: number | null;
}

/** The catalog fairness controls that SHOULD have a guild_config column but do
 *  not (their natural snake_case mapping) — probed DB-observably in SET-B. */
const FAIRNESS_CONTROL_COLUMNS = [
  'vote_skip_threshold_percent',
  'self_skip_enabled',
  'priority_voting_enabled',
  'requester_move_enabled',
] as const;

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A deterministic Discord snowflake for this domain's DJ-role config proofs. */
function djRoleId(ctx: ScenarioContext, suffix = 'dj'): string {
  return ctx.snowflake(`dj-role-${suffix}`);
}

async function readMusicConfig(handle: LiveClientHandle): Promise<MusicConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('dj_role_id, music_enabled, music_default_volume, music_auto_leave_minutes, music_auto_destroy_minutes')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as MusicConfigRow | null) ?? null;
}

async function guildConfigCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('guild_config')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Probe whether a column exists on guild_config for THIS guild by selecting it:
 * PostgREST answers a missing column with SQLSTATE 42703 (undefined_column), so a
 * non-null error means the column is absent. Returns {present, detail} so a caller
 * can report exactly which controls have no storage backing. Reads real schema
 * state — the outcome is decided by the database, never by a synthetic literal.
 */
async function probeColumn(
  handle: LiveClientHandle,
  column: string,
): Promise<{ present: boolean; detail: string }> {
  const { error } = await handle.supabase
    .from('guild_config')
    .select(column)
    .eq('guild_id', handle.guildId)
    .limit(1);
  if (!error) return { present: true, detail: 'present' };
  return { present: false, detail: `${error.code ?? '?'}:${error.message}` };
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
 * errors, so a failed read can never masquerade as "no alert raised" — the caller
 * GATEs on null rather than recording a false-clean PASS. (Mirrors the wallet
 * template's alertCount discipline.)
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
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS owner_full_access
 * → 0), or null when the probe is inconclusive (no anon key / URL / a gateway-level
 * key rejection before RLS evaluated → GATE). PostgREST surfaces a genuine
 * authorization deny as SQLSTATE 42501 "permission denied for table". (Copied from
 * the wallet template so the two proofs share one honest anon-denial semantics.)
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
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null; // non-JSON error body — inconclusive
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // the anon role is denied the table — RLS working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild_config (which carries dj_role_id + the fairness config) is
 * owner-scoped: the service role reads this guild's row while an anon client reads
 * ZERO of them (RLS owner_full_access). Made non-vacuous by a positive control —
 * the scenario has already written this guild's config row, so an anon client
 * seeing zero of it is a real deny, not "there was nothing to read." When no anon
 * key is exported the anon-denial GATEs (cross-guild scoping is still proven in
 * XGUILD via distinct real rows).
 */
async function proveGuildConfigRls(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/non-owner clients read zero guild_config rows carrying dj_role_id + fairness settings (RLS owner_full_access).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild config scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'guild_config', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/non-owner clients read zero guild_config rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readMusicConfig(handle);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s guild_config (dj_role_id + fairness settings) while an anon client reads zero of them (RLS owner_full_access).',
    observation:
      `service-role sees the guild_config row for guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} guild_config row(s) for that guild.`,
    impact:
      'A guild_config row visible to the service role was also readable with an anon key — the DJ role and fairness config are exposed to non-owner reads (RLS not denying anon).',
  });
}

/**
 * Prove no owner alert was raised on a routine (config-only) fairness path. The
 * catalog contracts that routine skips/denials/voting produce no owner noise; the
 * alerts table is the DB-observable owner-notification surface (a backend-outage
 * alert would land alert_type 'lavalink_down'). A read error GATEs rather than
 * recording a false-clean pass.
 */
async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      'This routine fairness path raises no owner alert (routine skips/denials/voting produce no owner noise).',
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'This routine fairness path raises no owner alert (only an audio-backend outage notifies the owner).',
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a routine fairness path — notification noise / a false alarm.',
  });
}

/** Branding is GATED for this domain: fairness embeds (track-queued, self-skip-confirm,
 *  vote-progress, fairness-denied, …) are only produced when a real queue + Lavalink
 *  track + Discord channel exist, none of which the bot-only harness has, so there is
 *  no captured member-facing surface to inspect for brand name/tone/footer. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Every player-fairness embed uses the guild brand name + configured tone preset and carries the powered-by-SomniBot footer.',
    'no fairness embed is produced in the bot-only harness (music is gateway/Lavalink-gated: initGuildFeatures leaves the music manager unwired without a Shoukaku node + Valkey queue), so there is no captured member-facing surface to inspect',
  );
}

/** GATE the audio/queue/vote behavior lane: skip routing, vote tallies, DJ
 *  force-skip, playback, and now-playing all require a live Lavalink node, the
 *  Valkey queue/vote store, and the Discord gateway (voice + text channel). */
function gateFairnessBehavior(ctx: ScenarioContext, promise: string, extra = ''): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    `requires a live Lavalink node + Valkey queue/vote store + Discord gateway to drive playback and skip/vote routing${extra ? `; ${extra}` : ''}`,
  );
}

/** GATE the music audit lane. Doubly gated: (1) the audit rows only exist once a
 *  real skip/vote/denial is driven (Lavalink+Valkey+Discord), and (2) the audit
 *  service's EVENT_TO_AUDIT map contains NO music.* events at all, so even a driven
 *  skip would write none — a divergence the owner should see, surfaced here in the
 *  gate reason rather than fabricated into a runtime FAIL that cannot be observed. */
function gateMusicAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'requires driving a live skip/vote/denial (Lavalink+Valkey+Discord); additionally the audit EVENT_TO_AUDIT map defines no music.* events, so no music audit row is written even when driven — a divergence to adjudicate, not observable as a DB row here',
  );
}

/** GATE the replay-safety lane where it depends on the Valkey vote set / queue
 *  currentIndex (re-delivered /skip or vote). */
function gateReplaySafety(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    promise,
    'the skip/vote idempotency surface is the Valkey vote set + queue currentIndex; re-delivery cannot be exercised without a live Valkey queue + Lavalink',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — default fairness out of the box: no DJ role, self-skip + listener-majority vote. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const djDefault = String(declaredDefault(ctx.domain, 'dj-role-id') ?? '');
  const thresholdDefault = Number(declaredDefault(ctx.domain, 'vote-skip-threshold-percent'));

  // Boot WITHOUT a dj_role_id override, so the column stays at its out-of-box
  // NULL — the DB-observable form of the catalog default (dj-role-id = "" → no DJ
  // role, fairness governed by self-skip + listener-majority voting).
  const handle = await ctx.bootGuild({ label: 'a' });

  const cfg = await readMusicConfig(handle);
  ctx.expect(cfg !== null && (cfg.dj_role_id === null || cfg.dj_role_id === ''), {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: `Out of the box guild_config.dj_role_id is unset (catalog default "${djDefault}"), so no DJ role gates fairness.`,
    observation: `guild_config.dj_role_id = ${JSON.stringify(cfg?.dj_role_id)} (row present=${cfg !== null}).`,
    impact: 'The default fairness config diverged: a DJ role was set out of the box, changing the default arbitration model.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The self-skip-instant / vote-opens-on-non-requester behavior is the heart of
  // DEF but is only observable by driving /skip against a live queue.
  gateFairnessBehavior(
    ctx,
    `A requester self-skips instantly while a non-requester's /skip opens a listener-majority vote (${thresholdDefault}% threshold), posting track-queued → self-skip-confirm → vote-progress embeds.`,
    'NOTE for owner: with no DJ role the bot treats everyone as DJ (music-player.ts isDJ → true) and routes every non-DJ /skip through voteSkip with a hardcoded ceil(listeners/2) majority — there is no requester-self-skip bypass, a divergence from the DEF promise',
  );
  gateMusicAudit(ctx, 'One music.self_skip row for A and one music.vote_cast row for B; no music.force_skip row for B.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Re-delivering B’s vote interaction leaves the tally at exactly one vote.');
}

/** SET-A — a dashboard-configured DJ role grants arbitration (force-skip, no vote). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const dj = djRoleId(ctx);
  // Seed dj_role_id via the config layer the owner-scoped PUT /api/music writes.
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { dj_role_id: dj } });

  // DB-observable core: the DJ role persists on guild_config and reads back exactly.
  const cfg = await readMusicConfig(handle);
  ctx.expect(cfg?.dj_role_id === dj, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A saved DJ role persists on guild_config.dj_role_id and reads back exactly (the value the owner-scoped PUT /api/music writes).',
    observation: `guild_config.dj_role_id = ${JSON.stringify(cfg?.dj_role_id)} (expected "${dj}").`,
    impact: 'The DJ-role configuration did not persist — a saved dashboard setting would be lost, so DJ arbitration could never engage.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The owner-scoped write path itself (requireGuildOwner, non-owner rejected) is a
  // dashboard session-auth lane, not reachable in this bot-only harness.
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The DJ-role write path is owner-scoped: a non-owner PUT /api/music is rejected before any guild_config write.',
    'the owner-scoped write path lives in the dashboard (requireGuildOwner + session auth); this harness cannot drive a dashboard session',
  );

  gateFairnessBehavior(
    ctx,
    'A DJ-role holder’s /skip force-skips member A’s playing track immediately (no vote), and /stop, /volume, /remove also succeed for the DJ, naming the next track.',
  );
  gateMusicAudit(ctx, 'One music.force_skip row records the DJ actor, the skipped track, and arbitration basis dj-role.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Replaying the DJ’s /skip advances the queue no further than the single original skip.');
}

/** SET-B — raising the vote-skip threshold takes effect (columns now backed). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // DB-observable: the catalog declares four fairness controls beyond dj-role-id.
  // guild_config now has a persisted column for each; probe every column against
  // the real schema (a missing column would be a genuine 42703 error, not a
  // synthetic literal). voteSkip reads vote_skip_threshold_percent (and honors
  // self-skip / priority-voting), and /move honors requester-move.
  const probes = await Promise.all(
    FAIRNESS_CONTROL_COLUMNS.map(async (col) => ({ col, ...(await probeColumn(handle, col)) })),
  );
  const present = probes.filter((p) => p.present).map((p) => p.col);
  const missing = probes.filter((p) => !p.present).map((p) => p.col);
  ctx.expect(missing.length === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'guild_config exposes a persisted column for every catalog fairness control (vote-skip-threshold-percent, self-skip-enabled, priority-voting-enabled, requester-move-enabled) so a saved dashboard setting takes effect for this guild.',
    observation:
      `guild_config columns present=[${present.join(', ') || 'none'}], missing=[${missing.join(', ') || 'none'}] ` +
      `(details: ${probes.map((p) => `${p.col}=${p.detail}`).join('; ')}). Only dj_role_id is schema-backed.`,
    impact:
      'The catalog declares fairness controls the product cannot persist: guild_config has no column for them and music-player.ts voteSkip hardcodes a ceil(listeners/2) majority, so raising vote-skip-threshold-percent to 100 (SET-B) can never make vote-skip unanimous and self-skip/priority/requester-move settings are ignored — the control surface is non-functional.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Even if a column existed, proving "two votes hold at 2/3, the third passes" is a
  // Valkey vote-set + Lavalink + Discord flow.
  gateFairnessBehavior(
    ctx,
    'With threshold 100 and three human listeners, two votes leave the track playing (vote-progress 2 of 3) and the third vote skips exactly once (vote-skip-complete).',
  );
  // The threshold column now exists — prove it persists per-guild and reads back.
  await handle.supabase
    .from('guild_config')
    .upsert({ guild_id: handle.guildId, vote_skip_threshold_percent: 100 }, { onConflict: 'guild_id' });
  const { data: afterWrite } = await handle.supabase
    .from('guild_config')
    .select('vote_skip_threshold_percent')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const readBack = (afterWrite as { vote_skip_threshold_percent?: number } | null)?.vote_skip_threshold_percent;
  ctx.expect(readBack === 100, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The vote-skip threshold override persists for this guild and reads back as the saved value (100).',
    observation: `vote_skip_threshold_percent read back = ${readBack ?? 'null'} (expected 100).`,
    impact: 'The threshold override does not persist, so a saved dashboard setting would not take effect for this guild.',
  });
  gateMusicAudit(ctx, 'Three music.vote_cast rows and exactly one music.vote_skip_passed row exist for the track.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Re-delivering the third voter’s interaction does not skip a second track or restart the tally.');
}

/** INVALID — an invalid fairness config is rejected atomically; the valid config is untouched. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const dj = djRoleId(ctx, 'valid');
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { dj_role_id: dj } });

  // DB-observable core: the prior VALID dj_role_id is retained byte-for-byte (a
  // rejected invalid save must never partially persist).
  const cfg = await readMusicConfig(handle);
  ctx.expect(cfg?.dj_role_id === dj, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid dj_role_id byte-for-byte (a rejected invalid fairness save never persists a partial payload).',
    observation: `guild_config.dj_role_id = ${JSON.stringify(cfg?.dj_role_id)} (expected the valid "${dj}").`,
    impact: 'A valid DJ-role configuration was not retained across the guild_config write.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The actual rejection (a non-snowflake dj_role_id, an out-of-range threshold) is
  // enforced by the dashboard's Zod layer; guild_config.dj_role_id is plain TEXT with
  // no DB CHECK, and the threshold has no column at all, so the reject path cannot be
  // driven from a bot-only harness. GATE it honestly (never fake a rejection).
  ctx.gate(
    'database-RLS',
    'db-observable',
    'PUT /api/music with a not-a-snowflake dj_role_id and a vote threshold of 0 returns a validation error and persists nothing.',
    'config validation lives in the dashboard (Zod) layer; guild_config.dj_role_id has no DB CHECK and no threshold column exists, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One config.rejected audit row records the invalid payload attempt without storing the invalid values as applied state.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  gateFairnessBehavior(ctx, 'Live fairness behavior (self-skip + majority voting) is identical before and after the rejected write.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Replaying the invalid PUT produces the same rejection and still persists nothing.');
}

/** UNAUTH — non-DJ members cannot arbitrate; non-owners cannot change fairness settings. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const dj = djRoleId(ctx);
  // A DJ role IS configured, so ordinary members are non-DJ and must be denied.
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { dj_role_id: dj } });

  ctx.expect((await readMusicConfig(handle))?.dj_role_id === dj, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A DJ role is configured on guild_config, so non-DJ members are gated from arbitration.',
    observation: `guild_config.dj_role_id = "${dj}" is set for the scenario guild.`,
    impact: 'The DJ-role gate configuration was not in place — the arbitration deny path could not be set up.',
  });

  // The "non-owner PUT is blocked and direct table access under a non-owner JWT is
  // denied by RLS" facet IS DB-observable: the anon (non-owner) client reads zero
  // guild_config rows while the service role sees this guild's config.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The ephemeral fairness-denied / DJ-required replies for a non-DJ /stop, /remove,
  // /volume are produced by the live handlers only against an active player.
  gateFairnessBehavior(
    ctx,
    'A non-DJ member’s /stop, /remove on another’s track, and /volume are each denied ephemerally (fairness-denied / DJ-required) while playback continues uninterrupted.',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'A logged-in non-owner’s PUT /api/music returns a permission error (requireGuildOwner) and changes nothing.',
    'the dashboard session-auth path (requireGuildOwner) is not reachable in a bot-only harness; the RLS non-owner deny is proven above via the anon guild_config probe',
  );
  gateMusicAudit(ctx, 'music.fairness_denied rows record each denied attempt with actor and attempted action.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Replaying a denied interaction produces the same denial and no state change.');
}

/** DEPFAIL — the Lavalink audio backend dies mid-track; fairness state fails safe.
 *  NOT convertible onto the ctx.faults proxy lane: the contracted outage is the
 *  LAVALINK backend (with queue/votes in Valkey), and the proxy severs Supabase
 *  only this wave — a supabase sever models neither, so the gates stay honest. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const dj = djRoleId(ctx);
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { dj_role_id: dj } });

  // The DB-observable, outage-independent facet: the persisted config stays
  // guild-scoped (an anon client cannot read it). The "unchanged BY the outage"
  // invariant needs an actual outage and is GATED below.
  await proveGuildConfigRls(ctx, handle);

  ctx.gate(
    'Discord',
    'discord-readback',
    'Stopping the Lavalink node mid-track posts the playback-error embed once in the bound text channel with the track title and reason; the session enters degraded.',
    'requires a Lavalink dependency-outage fault lane + a live Discord channel to observe the playback-error embed (the harness has no audio backend at all)',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The persisted queue + config rows are unchanged by the outage and the open vote tally is intact.',
    'the queue and vote tally live in Valkey and cannot be exercised without a live queue; config guild-scoping is proven above',
  );
  gateMusicAudit(ctx, 'Exactly one music.playback_backend_failed audit row exists for the outage episode.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one notification identifying the guild and the backend outage.',
    'requires a Lavalink dependency-outage fault lane to raise the alert, plus the owner alert-channel readback',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx, 'The outage grants no skips: the vote tally and current index re-read identical before and after the failure.');
}

/** RETRY — after a transient audio-backend outage, automatic reconnect converges. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Config guild-scoping is the DB-observable anchor; queue/current-index recovery
  // is entirely Valkey + Lavalink.
  await proveGuildConfigRls(ctx, handle);

  gateFairnessBehavior(
    ctx,
    'Restarting Lavalink leads the bot to reconnect automatically and resume the persisted current track without a duplicate track-queued embed; a subsequent self-skip works.',
    'plus a Lavalink restart/recovery fault lane',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The queue record shows the same entries and currentIndex after recovery as before the outage.',
    'the queue lives in Valkey; recovery cannot be exercised without a live queue + Lavalink reconnect',
  );
  gateMusicAudit(ctx, 'One recovery audit row follows the failure row; retry loops do not multiply audit entries.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'At most one recovery notice follows the outage notification; retry attempts do not spam the owner.',
    'requires the Lavalink outage/recovery fault lane plus the owner alert-channel readback',
  );
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Reconnect attempts never double-start the track: exactly one live player exists for the guild after convergence.',
    'the player/queue lifecycle is Valkey + Lavalink; single-player convergence cannot be exercised here',
  );
}

/** REPLAY — duplicate delivery of skip/vote interactions never double-applies. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Config guild-scoping + the "replays generate zero owner notifications" facet are
  // the DB-observable anchors; the vote-set-once / index-advance-once idempotency is
  // Valkey.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateFairnessBehavior(
    ctx,
    'A second identical /skip vote yields an already-voted ephemeral reply with no tally increase; a re-delivered self-skip advances the queue zero additional positions.',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The vote set for the track contains the user id exactly once and the queue currentIndex advanced exactly once for the self-skip.',
    'the vote set + queue currentIndex are Valkey structures; duplicate delivery cannot be exercised without a live queue + Lavalink',
  );
  gateMusicAudit(ctx, 'One audit row exists per unique logical action; replayed deliveries add no rows.');
  gateBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'End-state queue and vote structures are byte-identical between single-delivery and duplicate-delivery runs.',
    'the queue + vote set are Valkey structures; the replay differ cannot be exercised without a live queue + Lavalink',
  );
}

/** RESTART — fairness state survives a full stack restart (config in Supabase; tally in Valkey). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const dj = djRoleId(ctx);

  // Boot #1: configure the DJ role, snapshot it, then shut the stack down.
  const first = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: { dj_role_id: dj } });
  const snapshot = await readMusicConfig(first);
  await first.cleanup(); // simulate a full shutdown

  // Boot #2: SAME guild id (restart), WITHOUT re-seeding dj_role_id — the default
  // seed upsert does not touch that column, so a persisted value must survive purely
  // because it lives in Supabase.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readMusicConfig(second);
  ctx.expect(afterRestart?.dj_role_id === dj && snapshot?.dj_role_id === dj, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The fairness config in Supabase (dj_role_id) re-reads unchanged across a full stack restart.',
    observation:
      `pre-restart dj_role_id=${JSON.stringify(snapshot?.dj_role_id)}; ` +
      `post-restart dj_role_id=${JSON.stringify(afterRestart?.dj_role_id)} (expected "${dj}").`,
    impact: 'The DJ-role fairness config did not survive a restart — a member could gain or lose arbitration rights across a reboot.',
  });

  await proveGuildConfigRls(ctx, second);
  await proveNoOwnerAlert(ctx, second);

  gateFairnessBehavior(
    ctx,
    'After restart A can still self-skip, the surviving vote tally still counts toward the same track, and one more listener vote completes the majority.',
    'plus the persisted Valkey queue/tally (requestedBy + open votes) which cannot be exercised here',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The persisted queue in Valkey re-reads unchanged across the restart with requestedBy intact.',
    'the queue + open vote tally are Valkey structures; cross-restart survival cannot be exercised without a live queue + Lavalink',
  );
  gateMusicAudit(ctx, 'Pre-restart audit rows remain and post-restart rows continue the same episode without duplication.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Restart-time recovery does not re-fire completed skips: the queue advances only from post-restart actions.');
}

/** RACE — concurrent final votes and a simultaneous self-skip resolve to exactly one advance. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateFairnessBehavior(
    ctx,
    'Two threshold-completing votes plus a simultaneous self-skip advance the queue exactly one position, post exactly one skip embed, and clear the tally once.',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'The queue currentIndex advanced by exactly one and the vote set for the old track is deleted exactly once.',
    'the queue currentIndex + vote set are Valkey structures; the concurrency race cannot be exercised without a live queue + Lavalink',
  );
  gateMusicAudit(ctx, 'One skip audit row exists for the track regardless of how many concurrent actors raced.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'The concurrent losers’ interactions are absorbed idempotently with no double advance.');
}

/** XGUILD — fairness state is strictly guild-scoped (votes, DJ roles, thresholds never cross). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const djA = djRoleId(ctx, 'a');
  const djB = djRoleId(ctx, 'b');

  const handleA = await ctx.bootGuild({ guildId: guildA, guildConfigOverrides: { dj_role_id: djA } });
  const handleB = await ctx.bootGuild({ guildId: guildB, guildConfigOverrides: { dj_role_id: djB } });

  // Each guild scope reads its OWN distinct config row and never the other's: guild
  // A → its djA row, guild B → its djB row. If config-scoping leaked, one scope would
  // return the other's DJ role.
  const cfgA = await readMusicConfig(handleA);
  const cfgB = await readMusicConfig(handleB);
  ctx.expect(cfgA?.dj_role_id === djA && cfgB?.dj_role_id === djB && djA !== djB, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'DJ roles and fairness config are keyed strictly per guild: guild A reads its own dj_role_id and guild B reads its own — neither sees the other’s.',
    observation:
      `guild A dj_role_id=${JSON.stringify(cfgA?.dj_role_id)} (expected "${djA}"); ` +
      `guild B dj_role_id=${JSON.stringify(cfgB?.dj_role_id)} (expected "${djB}"); distinct=${djA !== djB}.`,
    impact: 'A guild-scoped config read returned another guild’s DJ role — cross-guild fairness leakage.',
  });

  // Anon cannot read guild A's config from any context (the catalog's "anon probe
  // from B's context cannot read A's config row").
  await proveGuildConfigRls(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleA);

  gateFairnessBehavior(
    ctx,
    'Votes cast in guild A never appear in guild B’s tally, guild A’s DJ role grants nothing in guild B, and changing A’s threshold leaves B’s voting math unchanged.',
    'the vote tallies are per-guild Valkey sets which cannot be exercised here',
  );
  gateMusicAudit(ctx, 'Audit rows carry the correct guild id and no cross-guild rows appear.');
  gateBranding(ctx);
  gateReplaySafety(ctx, 'Replaying guild A interactions changes nothing in guild B.');
}

/** CLEANUP — run-prefixed fairness config is removed; the sweep is idempotent; audit is retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const dj = djRoleId(ctx);
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { dj_role_id: dj } });

  // Baseline: the scenario created a run-prefixed guild_config row carrying the DJ role.
  const before = await guildConfigCount(handle);
  ctx.expect(before >= 1 && (await readMusicConfig(handle))?.dj_role_id === dj, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created a run-prefixed guild_config row carrying the fairness config (pre-cleanup baseline).',
    observation: `pre-cleanup guild_config rows=${before}, dj_role_id="${dj}".`,
    impact: 'The cleanup scenario could not establish a baseline run-prefixed config row.',
  });

  // Prove the off-theme classes while the row still exists.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep and verify ZERO run-prefixed config rows remain.
  await ctx.sweepGuildRows(handle);
  const afterFirst = await guildConfigCount(handle);
  ctx.expect(afterFirst === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed fairness config rows are deleted; a sweep finds zero run-prefixed guild_config resources.',
    observation: `post-sweep guild_config rows=${afterFirst}.`,
    impact: 'The cleanup sweep left run-prefixed guild_config rows behind — the suite leaves residue.',
  });

  // The catalog's replay-safety facet: running the sweeper twice is idempotent and
  // reports zero remaining resources both times.
  await ctx.sweepGuildRows(handle);
  const afterSecond = await guildConfigCount(handle);
  ctx.expect(afterSecond === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running the sweeper twice is idempotent and reports zero remaining resources both times.',
    observation: `guild_config rows after a second sweep=${afterSecond} (first sweep left ${afterFirst}).`,
    impact: 'A second cleanup sweep was not idempotent — the sweeper is not safe to re-run.',
  });

  // The run-prefixed Valkey queue/vote keys and Discord messages/roles are a
  // separate cleanup lane; audit history is retained (anonymized-not-deleted).
  ctx.gate(
    'Discord',
    'discord-readback',
    'Run-created channels, roles, and fairness messages are deleted from the test guilds.',
    'requires a live Discord channel/role readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Run-prefixed Valkey queue + vote keys are removed by the sweeper (zero remaining).',
    'the queue + vote keys are Valkey structures; enumerating/removing them needs a live Valkey (config-row cleanup is proven above DB-observably)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Audit rows from the run remain present and unmodified (never-delete honored).',
    'requires an audit_logs retention readback; note the audit map writes no music.* rows, so no music audit history exists to retain here',
  );
  gateBranding(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The music-player-fairness domain proof. Its Supabase footprint is the
 * guild_config fairness config (always swept by the runner) plus the guild-scoped
 * `alerts` (owner outage notifications) and `bot_diagnostics` (music status
 * reporter) tables — listed here so a Lavalink-enabled run sweeps them surgically
 * (child→parent: both reference `guild`, deleted before the guild row). The queue
 * and vote sets live in Valkey and are swept by the Valkey lane, not this list.
 */
export const musicPlayerFairnessProof: DomainProof = {
  domainId: 'music-player-fairness',
  guildScopedTables: [
    'alerts',
    'bot_diagnostics',
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
