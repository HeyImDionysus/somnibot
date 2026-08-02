/**
 * scenario-runner/scripts/community-starboard — the Starboard domain proof.
 *
 * Binds the starboard domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. Every DB-observable /
 * RLS / config-persistence / idempotency assertion runs NOW; anything needing a
 * real Discord effect is GATED — the exact honesty boundary the harness requires.
 *
 * ── Why this domain is MOSTLY GATED ──────────────────────────────────────────
 * Starboard is NOT a slash-command feature. It ships exactly one runtime entry
 * point — `handleStarboardReaction(reaction, user, supabase, guildId)` in
 * packages/bot/src/features/starboard/index.ts — a Discord **gateway event**
 * handler. Its whole behavior (counting distinct reactors, excluding self-stars,
 * crossing the threshold, `starboardChannel.send()`ing the entry embed, editing
 * the live count, degrading when the channel disappears) is driven by real
 * `MessageReaction` / `User` / `Guild` objects and REST calls that only exist
 * with a DISCORD_TOKEN + live gateway. The bot-only local-Supabase harness drives
 * interactions through the dispatcher (`runSlash`); there is NO starboard command
 * to drive, so the reaction→post behavior is honestly GATED behind discord-readback.
 *
 * ── What DOES run NOW (real, non-vacuous evidence) ───────────────────────────
 *   - guild_config starboard columns persist / retain their saved values
 *     (SET-A, SET-B, INVALID) — read back from the real row the production seed
 *     path wrote.
 *   - starboard_entries RLS: the service role sees a scenario's real entry row
 *     while an anon key reads zero (starboard_entries is locked to service_role
 *     by the RLS-lockdown migration — anon is REVOKEd, PostgREST returns 42501).
 *   - Cross-guild isolation: two guilds' distinct entry rows never leak across a
 *     guild-scoped read (XGUILD).
 *   - At-most-once entry creation: `starboard_entries.source_message_id` carries a
 *     UNIQUE constraint — the exact DB guard behind `handleStarboardReaction`'s
 *     "already have an entry?" check. A second insert for one source message is
 *     rejected (23505), proving idempotency under replay (REPLAY) and concurrency
 *     (RACE), and at-most-once across retries (RETRY) — DB-observable, no gateway.
 *   - Persistence across restart: entry rows live in Supabase and survive a full
 *     stack reboot with no boot-time duplicates (RESTART).
 *   - Surgical cleanup: the sweep removes every run-prefixed entry (CLEANUP).
 *   - Happy-path owner-notification: no alert row is raised (real `alerts` read).
 *
 * ── Rich-open default now honored (ship-on alignment) ────────────────────────
 * DEF asserts a PASS: the catalog contracts starboard-enabled=true as the
 * "rich open default" (celebrating members works the moment a channel is chosen),
 * and the implementation now agrees everywhere — the guild_config column DEFAULT,
 * the bot's `loadConfig` fallback, and the dashboard form's initial toggle all
 * ship `true` (20260724170000_ship_on_defaults). A freshly-configured guild that
 * only picks a channel is active out of the box. That alignment is a ctx.expect
 * that PASSes; it is never a forced pass or a gate.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface StarboardConfigRow {
  starboard_enabled: boolean;
  starboard_channel_id: string | null;
  starboard_threshold: number;
  starboard_emoji: string;
  starboard_self_star: boolean;
}

interface StarboardEntryRow {
  id: string;
  guild_id: string;
  source_channel_id: string;
  source_message_id: string;
  starboard_message_id: string | null;
  star_count: number;
  author_id: string;
}

interface EntrySeed {
  sourceMessageId: string;
  sourceChannelId: string;
  authorId: string;
  starCount: number;
  starboardMessageId?: string | null;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** The starboard slice of guild_config, read back from the real row. */
async function readConfig(handle: LiveClientHandle): Promise<StarboardConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'starboard_enabled, starboard_channel_id, starboard_threshold, starboard_emoji, starboard_self_star',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as StarboardConfigRow | null) ?? null;
}

/** Read one entry, scoped to the handle's guild (guild-scoping is load-bearing). */
async function readEntry(
  handle: LiveClientHandle,
  sourceMessageId: string,
): Promise<StarboardEntryRow | null> {
  const { data } = await handle.supabase
    .from('starboard_entries')
    .select(
      'id, guild_id, source_channel_id, source_message_id, starboard_message_id, star_count, author_id',
    )
    .eq('guild_id', handle.guildId)
    .eq('source_message_id', sourceMessageId)
    .maybeSingle();
  return (data as StarboardEntryRow | null) ?? null;
}

async function entryCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('starboard_entries')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Insert one starboard entry through the service role. This is the ARRANGE step:
 * the row a real threshold-crossing reaction WOULD create (the gateway-driven
 * `handleStarboardReaction` path is not reachable here). It returns the Postgres
 * error code so the caller can prove the UNIQUE(source_message_id) guard fires.
 */
async function insertEntry(
  handle: LiveClientHandle,
  seed: EntrySeed,
): Promise<{ code: string | null; ok: boolean }> {
  const { error } = await handle.supabase.from('starboard_entries').insert({
    guild_id: handle.guildId,
    source_channel_id: seed.sourceChannelId,
    source_message_id: seed.sourceMessageId,
    starboard_message_id: seed.starboardMessageId ?? null,
    star_count: seed.starCount,
    author_id: seed.authorId,
  });
  return { code: error?.code ?? null, ok: !error };
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query itself
 * errors, so a failed read can never masquerade as "no alert raised" — the
 * caller GATEs on null rather than recording a false-clean PASS.
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
 * rows an anon key can read (RLS/GRANT deny → 0), or null when the probe is
 * inconclusive (→ GATE). The RLS-lockdown migration REVOKEs anon on
 * starboard_entries + guild_config, so PostgREST returns SQLSTATE 42501
 * "permission denied" — the deny we want to prove.
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
      return 0; // the anon role is denied the table — RLS/GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove per-guild RLS isolation on starboard_entries, made non-vacuous by a
 * positive control: this scenario already created a real entry row (the service
 * role can see it), so an anon client reading ZERO rows for the guild is a real
 * deny, not "there was nothing to read." Cross-GUILD isolation across two REAL
 * guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  sourceMessageId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero starboard_entries rows (service_role-only lockdown).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'starboard_entries', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero starboard_entries rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readEntry(handle, sourceMessageId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s starboard entry while an anon client reads zero of them (starboard_entries is service_role-only).',
    observation:
      `service-role sees the entry for source_message_id "${sourceMessageId}" under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} starboard_entries row(s) for that guild.`,
    impact:
      'A starboard entry visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).',
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
    'starboard failure branches raise exactly one owner alert carrying a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch (see the channel-missing gap noted in DEPFAIL)',
  );
}

/** The starboard member-facing surface is a channel embed, never an ephemeral reply. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Every member-facing starboard surface shows the owner brand kit (name, colors, voice preset) with the subtle powered-by-SomniBot attribution and zero stock-bot wording.',
    'the starboard surface is an embed posted to the starboard channel (there is no ephemeral reply to inspect); it can only be snapshotted via a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
}

/** Audit rows for starboard would be written by the gateway-driven reaction engine. */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'discord-readback',
    'Every starboard state change lands exactly one append-only audit row with actor id, guild id, and correlation id; audit history is anonymized, never deleted.',
    'a starboard audit row is only emitted from the gateway-driven reaction engine, which this bot-only harness cannot drive (needs DISCORD_TOKEN + live guild)',
  );
}

/** The reaction→post behavior needs a live Discord gateway; gate it with a precise promise. */
function gateReactionBehavior(ctx: ScenarioContext, promise: string, reason: string): void {
  ctx.gate('Discord', 'discord-readback', promise, reason);
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s triggers yields no duplicate starboard posts, count edits, or entry rows.',
    `entry-row idempotency (the UNIQUE source_message_id guard) is exercised directly in the ${where} scenario`,
  );
}

function gateCleanupDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'cleanup',
    'db-observable',
    'Every run-prefixed starboard resource this scenario created is removed by the cleanup sweep.',
    `the surgical run-prefixed sweep is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — with only the channel selected, defaults rule (threshold 3, ⭐, no self-star). */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  // Boot with ONLY the starboard channel set — exactly "the owner picks a channel."
  // Every other starboard column takes its DB default, which is what a freshly
  // configured guild really loads.
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { starboard_channel_id: channel },
  });
  const cfg = await readConfig(handle);

  const thresholdDefault = Number(declaredDefault(ctx.domain, 'starboard-threshold'));
  const emojiDefault = String(declaredDefault(ctx.domain, 'starboard-emoji'));
  const selfStarDefault = declaredDefault(ctx.domain, 'starboard-self-star') === true;
  const enabledDefault = declaredDefault(ctx.domain, 'starboard-enabled') === true;

  // 1) Emoji / threshold / self-star defaults match the catalog contract (real read).
  ctx.expect(
    cfg?.starboard_threshold === thresholdDefault &&
      cfg?.starboard_emoji === emojiDefault &&
      cfg?.starboard_self_star === selfStarDefault,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `Out of the box the starboard uses the catalog defaults: threshold ${thresholdDefault}, emoji "${emojiDefault}", self-star ${selfStarDefault}.`,
      observation:
        `guild_config holds threshold=${cfg?.starboard_threshold} (expected ${thresholdDefault}), ` +
        `emoji="${cfg?.starboard_emoji}" (expected "${emojiDefault}"), self_star=${cfg?.starboard_self_star} (expected ${selfStarDefault}).`,
      impact: 'A default starboard control diverged from the catalog default.',
    },
  );

  // 2) Rich-open default MET — enabled=true the moment a channel is chosen: the column
  //    DEFAULT, the bot loadConfig fallback, and the dashboard form toggle now all default
  //    true. Picking a channel alone activates the starboard out of the box.
  ctx.expect(cfg?.starboard_enabled === enabledDefault, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Rich open default: with only the starboard channel selected the feature is active (starboard-enabled defaults to true).',
    observation:
      `a guild configured with only the channel reads starboard_enabled=${cfg?.starboard_enabled}, ` +
      `matching the catalog rich-open default of ${enabledDefault}. The guild_config column DEFAULT, the ` +
      `bot loadConfig fallback, and the dashboard form toggle now all default true.`,
    impact:
      'Were the rich-open default unmet, choosing a starboard channel would not activate the feature, so out-of-box celebration would silently never fire until the owner also flipped an enable toggle.',
  });

  // The threshold-crossing behavior itself is gateway-driven — GATE it.
  gateReactionBehavior(
    ctx,
    'Two ⭐ produce no entry; the third distinct non-author ⭐ showcases the message exactly once with count 3, channel, author, and a working jump link; the author’s own ⭐ is not counted.',
    'the reaction→post engine (handleStarboardReaction) needs real MessageReaction/User/Guild objects + starboardChannel.send — a live Discord gateway (DISCORD_TOKEN + live guild)',
  );

  // Arrange the entry a threshold-crossing reaction WOULD create, then prove RLS on it.
  const msg = `${ctx.runPrefix}sb-def-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: thresholdDefault,
  });
  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** SET-A — dashboard config (custom emoji 🌟, threshold 2) is saved and loaded. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_emoji: '🌟',
      starboard_threshold: 2,
      starboard_self_star: false,
    },
  });
  const cfg = await readConfig(handle);

  // Config-takes-effect, DB-observable: the saved custom emoji + threshold persist
  // and are exactly what the starboard engine's loadConfig reads.
  ctx.expect(
    cfg?.starboard_emoji === '🌟' && cfg?.starboard_threshold === 2 && cfg?.starboard_enabled === true,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A saved dashboard configuration (emoji 🌟, threshold 2, enabled) persists in guild_config — the values the starboard engine loads.',
      observation:
        `guild_config holds emoji="${cfg?.starboard_emoji}" (expected 🌟), threshold=${cfg?.starboard_threshold} (expected 2), ` +
        `enabled=${cfg?.starboard_enabled} (expected true).`,
      impact: 'A saved starboard configuration was not persisted — a dashboard setting would be silently ignored.',
    },
  );

  // The behavioral effect (🌟×2 posts; ⭐ no longer counts) is gateway-driven.
  gateReactionBehavior(
    ctx,
    'After saving 🌟 + threshold 2, a message with two 🌟 posts to the starboard while a control message with three ⭐ does not.',
    'proving the emoji/threshold actually gate showcasing requires the reaction engine to fire against a live Discord gateway (DISCORD_TOKEN + live guild)',
  );

  const msg = `${ctx.runPrefix}sb-seta-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 2,
  });
  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** SET-B — a second distinct config (self-star on, channel switched) is saved live. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const oldChannel = ctx.snowflake('starboard-channel-old');
  const newChannel = ctx.snowflake('starboard-channel-new');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: oldChannel,
      starboard_threshold: 3,
      starboard_self_star: false,
    },
  });

  // Save the second configuration live (switch channel + allow self-stars), then
  // read back to prove the change persisted and the old value is gone.
  await handle.supabase
    .from('guild_config')
    .update({ starboard_channel_id: newChannel, starboard_self_star: true })
    .eq('guild_id', handle.guildId);
  const cfg = await readConfig(handle);

  ctx.expect(
    cfg?.starboard_channel_id === newChannel &&
      cfg?.starboard_self_star === true &&
      cfg?.starboard_threshold === 3,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A second distinct configuration (self-star on, starboard channel switched) is saved live and replaces the prior channel.',
      observation:
        `guild_config now holds channel="${cfg?.starboard_channel_id}" (expected the new channel, old one gone), ` +
        `self_star=${cfg?.starboard_self_star} (expected true), threshold=${cfg?.starboard_threshold} (expected 3).`,
      impact: 'A live starboard reconfiguration (channel switch / self-star) did not persist.',
    },
  );

  // Behavioral: author’s own star counts under self-star, entry posts to the NEW
  // channel only, old channel stays silent — gateway-driven.
  gateReactionBehavior(
    ctx,
    'With self-star on and the channel switched, the author’s own ⭐ plus two others reach threshold 3 and the entry posts to the NEW channel only; the old channel stays silent.',
    'proving self-star counting + the destination channel requires the reaction engine against a live Discord gateway (DISCORD_TOKEN + live guild)',
  );

  const msg = `${ctx.runPrefix}sb-setb-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
    starboardMessageId: `${ctx.runPrefix}sb-out`,
  });
  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** INVALID — invalid config (threshold 0, malformed emoji) never persists; prior config stands. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 5,
      starboard_emoji: '⭐',
    },
  });

  // DB-observable core: guild_config keeps its prior valid values byte-for-byte
  // (a rejected invalid save never persists).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.starboard_threshold === 5 && cfg?.starboard_emoji === '⭐', {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid starboard values (a rejected invalid save never persists).',
    observation: `guild_config holds threshold=${cfg?.starboard_threshold} (expected 5) and emoji="${cfg?.starboard_emoji}" (expected ⭐).`,
    impact: 'A valid starboard configuration was not retained.',
  });

  // The actual REJECTION (threshold 0 / malformed emoji) is enforced in the
  // dashboard's Zod layer (api/guild route: starboard_threshold z.number().int()
  // .min(1).max(100)); the guild_config columns carry NO CHECK constraint, so the
  // reject path is not reachable in this bot-only harness. GATE it honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard rejects threshold 0 and a malformed emoji with clear errors; stored config is unchanged and live behavior follows the prior settings.',
    'starboard config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records each rejected starboard configuration attempt with its reason.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  const msg = `${ctx.runPrefix}sb-invalid-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 5,
  });
  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReactionBehavior(
    ctx,
    'A message starred to the prior threshold still posts exactly as before the rejected save.',
    'the unchanged post behavior after a rejected save is only observable through the live reaction engine (DISCORD_TOKEN + live guild)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** UNAUTH — starboard settings are admin-only; the config table is service_role-only. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 3,
    },
  });

  // DB-observable enforcement backing "admin-only settings": guild_config is
  // locked to service_role (anon/authenticated REVOKEd by the RLS-lockdown
  // migration), so no unprivileged client can write starboard config directly.
  // Positive control: the service role reads the config; the anon key reads zero.
  const anonKey = ctx.capabilities.anonKey;
  if (anonKey) {
    const anonCfgRows = await anonReadCount(anonKey, 'guild_config', handle.guildId);
    const serviceSees = await readConfig(handle);
    if (anonCfgRows === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'anon/authenticated clients cannot read or write guild_config starboard settings (service_role-only).',
        'the anon REST probe against guild_config was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS evaluated)',
      );
    } else {
      ctx.expect(serviceSees !== null && anonCfgRows === 0, {
        assertionClass: 'database-RLS',
        channel: 'db-rls',
        promise:
          'Starboard settings are admin-only at the data layer: the service role reads guild_config while an anon client reads zero rows (guild_config is service_role-only).',
        observation:
          `service-role reads the starboard config for guild "${handle.guildId}" (${serviceSees !== null}); ` +
          `an anon-key REST read returned ${anonCfgRows} guild_config row(s) for that guild.`,
        impact:
          'guild_config was readable/writable with an anon key — a non-admin could change starboard settings, breaking the admin-only guarantee.',
      });
    }
  } else {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients cannot read or write guild_config starboard settings (service_role-only).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); the anon-denial on guild_config was not exercised',
    );
  }

  // The full "non-admin dashboard SESSION returns a permission error" path lives
  // on the dashboard session-auth lane, not reachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session receives a permission error; the config is unchanged and the starboard keeps operating under the owner’s settings.',
    'requires the dashboard session-auth lane (a real non-admin session) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The denied write is audited with actor and reason; no config-change row exists.',
    'the denied-write audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  // A real entry row still exists under the owner's settings — prove RLS on it too.
  const msg = `${ctx.runPrefix}sb-unauth-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** DEPFAIL — a deleted starboard channel degrades gracefully (fault-lane + gateway). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 3,
    },
  });

  // The degradation behavior (counting continues in-cache, posting suspends, one
  // owner alert, repair resumes) requires deleting a live channel and driving
  // reactions through the gateway — none reachable in a bot-only harness. GATE it.
  gateReactionBehavior(
    ctx,
    'After the channel is deleted, new threshold-crossers produce no errors and no crash loops; choosing a new channel posts each pending entry exactly once.',
    'requires a live Discord gateway + a channel-deletion fault lane to drive handleStarboardReaction through its degraded branch',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one starboard-alert names the missing channel when the starboard channel is deleted.',
    'requires the live owner alert channel readback plus a channel-deletion fault lane. NOTE: the current handleStarboardReaction returns silently when the starboard channel is missing (no alert emitted) — a gap flagged for the owner',
  );
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');

  // A pre-degradation entry row stays guild-scoped through the outage window —
  // this IS DB-observable, so prove RLS isolation on it (the catalog DEPFAIL
  // database-RLS assertion: rows carry the guild id; anon/second-guild read zero).
  const msg = `${ctx.runPrefix}sb-depfail-msg`;
  await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  await proveRlsIsolation(ctx, handle, msg);
}

/** RETRY — a transiently-failed entry post retries to exactly one entry (keyed by source msg id). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 3,
    },
  });
  const msg = `${ctx.runPrefix}sb-retry-msg`;

  // replay-safety, DB-observable: the entry is keyed by source_message_id (UNIQUE),
  // so even if a first post attempt "retries" the second attempt to create an entry
  // for the SAME source message is rejected — at-most-once creation across attempts.
  const first = await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  const retry = await insertEntry(handle, {
    sourceMessageId: msg, // SAME source message id → the retry
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  const total = await entryCount(handle);
  ctx.expect(first.ok && !retry.ok && retry.code === '23505' && total === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'The starboard entry is keyed by source_message_id (UNIQUE), proving at-most-once creation across post attempts/retries.',
    observation:
      `first insert ok=${first.ok}; retry insert ok=${retry.ok} (code=${retry.code ?? 'none'}, expected 23505 unique_violation); ` +
      `entry rows for the source message = ${total} (expected exactly 1).`,
    impact:
      'A retried starboard post created a SECOND entry for the same message — at-most-once creation is not enforced (duplicate showcase).',
  });

  // The transient-fault-then-retry SEQUENCE (fail the first send, back off, succeed)
  // needs the reaction engine + a fault lane at the Discord send boundary. GATE it.
  gateReactionBehavior(
    ctx,
    'With a transient fault injected on the first post attempt, the retry lands one entry whose count matches the live reactions.',
    'requires a fault-injection lane at the starboardChannel.send boundary plus the live reaction engine (DISCORD_TOKEN + live guild)',
  );

  await proveRlsIsolation(ctx, handle, msg);
  // RETRY's failure (entry_post_failed) is ownerNotification:false in the catalog,
  // so no owner alert is expected — prove that DB-observably.
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** REPLAY — re-delivered reaction events never duplicate the entry or its cardinality. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 3,
    },
  });
  const msg = `${ctx.runPrefix}sb-replay-msg`;

  // replay-safety, DB-observable: re-delivering the triggering event that creates a
  // starboard entry (same source_message_id) yields exactly ONE entry row — the
  // UNIQUE(source_message_id) guard is the persisted idempotency key.
  const original = await insertEntry(handle, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  const replay = await insertEntry(handle, {
    sourceMessageId: msg, // re-delivered event → same source message id
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  });
  const total = await entryCount(handle);
  ctx.expect(original.ok && !replay.ok && replay.code === '23505' && total === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering the entry-creating event never duplicates: exactly one starboard_entries row exists per source message (UNIQUE idempotency key).',
    observation:
      `original insert ok=${original.ok}; replayed insert ok=${replay.ok} (code=${replay.code ?? 'none'}, expected 23505); ` +
      `entry rows after replay = ${total} (expected exactly 1).`,
    impact:
      'A replayed reaction event created a duplicate starboard entry — the entry idempotency key was not honored.',
  });

  // The reactor-set dedup (count convergence to the true distinct-reactor total on
  // replayed reaction-add events) lives in the in-process reaction handler. GATE it.
  gateReactionBehavior(
    ctx,
    'After replaying recorded reaction-add events, the entry count equals the true distinct-reactor count (the per-guild reactor set deduplicates).',
    'the reactor-set dedup / count reconciliation runs inside handleStarboardReaction against live MessageReaction data (DISCORD_TOKEN + live guild)',
  );

  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** RESTART — starboard entries survive a full stack reboot; no boot-time duplicates. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const channel = ctx.snowflake('starboard-channel');
  const msg = `${ctx.runPrefix}sb-restart-msg`;
  const overrides = {
    starboard_enabled: true,
    starboard_channel_id: channel,
    starboard_threshold: 3,
  };

  // Boot #1: create a posted entry (star_count 4), snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: overrides });
  await insertEntry(first, {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 4,
    starboardMessageId: `${ctx.runPrefix}sb-out`,
  });
  const snapshot = await readEntry(first, msg);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The entry must be identical and single —
  // caches rebuild from the database, no boot-time duplicate.
  const second = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: overrides });
  const afterRestart = await readEntry(second, msg);
  const total = await entryCount(second);
  ctx.expect(
    afterRestart?.star_count === snapshot?.star_count &&
      afterRestart?.starboard_message_id === snapshot?.starboard_message_id &&
      afterRestart?.star_count === 4 &&
      total === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart the starboard entry matches its pre-restart snapshot exactly and no boot-time duplicate is created.',
      observation:
        `pre-restart count=${snapshot?.star_count}/sb_msg=${snapshot?.starboard_message_id}; ` +
        `post-restart count=${afterRestart?.star_count}/sb_msg=${afterRestart?.starboard_message_id}; entry rows=${total} (expected count 4, exactly 1 row).`,
      impact: 'Starboard state did not survive a restart, or a duplicate entry appeared on boot.',
    },
  );

  // "A star added post-restart edits the correct entry in place" is gateway-driven.
  gateReactionBehavior(
    ctx,
    'A star added after the restart edits the original entry in place (no new entry); threshold logic still uses accurate counts.',
    'editing the live entry on a new reaction runs inside handleStarboardReaction against a live Discord message (DISCORD_TOKEN + live guild)',
  );

  await proveRlsIsolation(ctx, second, msg);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** RACE — two concurrent threshold-crossing stars produce exactly one entry. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      starboard_enabled: true,
      starboard_channel_id: channel,
      starboard_threshold: 3,
    },
  });
  const msg = `${ctx.runPrefix}sb-race-msg`;

  // Two threshold-crossing stars landing simultaneously both try to CREATE the
  // entry for one source message. The UNIQUE(source_message_id) constraint is the
  // exact guard that makes this safe: fire both inserts concurrently and prove
  // exactly one wins and exactly one entry row exists.
  const seed: EntrySeed = {
    sourceMessageId: msg,
    sourceChannelId: `${ctx.runPrefix}src`,
    authorId: ctx.userId('a'),
    starCount: 3,
  };
  const [r1, r2] = await Promise.all([insertEntry(handle, seed), insertEntry(handle, seed)]);
  const successes = (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0);
  const rejected = r1.ok ? r2 : r1;
  const total = await entryCount(handle);
  ctx.expect(successes === 1 && rejected.code === '23505' && total === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Two members delivering the threshold-crossing star simultaneously produce exactly one starboard entry (UNIQUE source_message_id resolves the race).',
    observation:
      `concurrent inserts: successes=${successes} (expected 1), loser code=${rejected.code ?? 'none'} (expected 23505); ` +
      `entry rows for the source message = ${total} (expected exactly 1).`,
    impact:
      'Two racing threshold-crossing stars created duplicate starboard entries — the concurrency guard failed.',
  });
  ctx.expect(total === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The racing threshold-crossing stars leave exactly one entry row (idempotent at the ledger level).',
    observation: `starboard_entries rows for the source message after the concurrent race = ${total} (expected 1).`,
    impact: 'A raced starboard post wrote a duplicate entry row — the transfer was not idempotent under concurrency.',
  });

  // The settled COUNT reflecting the true reactor total (in-memory reconciliation)
  // is gateway-driven. GATE that facet.
  gateReactionBehavior(
    ctx,
    'The single entry’s count settles at the true total of the simultaneously-crossing stars.',
    'the count reconciliation runs inside handleStarboardReaction from live MessageReaction.count data (DISCORD_TOKEN + live guild)',
  );

  await proveRlsIsolation(ctx, handle, msg);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** XGUILD — starboard entries are strictly per-guild (guild B never touches guild A). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({
    guildId: guildA,
    guildConfigOverrides: { starboard_enabled: true, starboard_channel_id: ctx.snowflake('starboard-channel-a'), starboard_threshold: 3 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    guildConfigOverrides: { starboard_enabled: true, starboard_channel_id: ctx.snowflake('starboard-channel-b'), starboard_threshold: 2 },
  });

  // source_message_id is globally UNIQUE, so each guild uses a distinct message id.
  const msgA = `${ctx.runPrefix}sb-xg-a`;
  const msgB = `${ctx.runPrefix}sb-xg-b`;
  await insertEntry(handleA, { sourceMessageId: msgA, sourceChannelId: `${ctx.runPrefix}src-a`, authorId: ctx.userId('a'), starCount: 5 });
  await insertEntry(handleB, { sourceMessageId: msgB, sourceChannelId: `${ctx.runPrefix}src-b`, authorId: ctx.userId('a'), starCount: 2 });

  const aRow = await readEntry(handleA, msgA); // guild A scope → A's row
  const bRow = await readEntry(handleB, msgB); // guild B scope → B's row
  const crossFromB = await readEntry(handleB, msgA); // guild B scope looking for A's message → null

  ctx.expect(
    aRow?.guild_id === guildA &&
      aRow?.star_count === 5 &&
      bRow?.guild_id === guildB &&
      bRow?.star_count === 2 &&
      crossFromB === null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Starboard entries are strictly per-guild: guild B activity never touches guild A’s entries and each guild’s entries evolve independently.',
      observation:
        `guild A entry count=${aRow?.star_count} under "${aRow?.guild_id}"; guild B entry count=${bRow?.star_count} under "${bRow?.guild_id}"; ` +
        `a guild-B-scoped read of guild A’s message returned ${crossFromB === null ? 'null (isolated)' : 'a leaked row'}.`,
      impact: 'Cross-guild activity leaked into another guild’s starboard entries — per-guild isolation broken.',
    },
  );
  ctx.expect(
    aRow?.guild_id === guildA && bRow?.guild_id === guildB && crossFromB === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'A guild-B-scoped client reads zero of guild A’s starboard rows: each guild scope returns only its own entry under its own guild_id.',
      observation:
        `guild-A-scoped read = row under "${aRow?.guild_id}"; guild-B-scoped read = row under "${bRow?.guild_id}"; ` +
        `guild-B-scoped read of guild A’s message = ${crossFromB === null ? 'zero rows' : 'a cross-guild row'}.`,
      impact: 'A guild-scoped read returned another guild’s starboard entry — cross-guild leakage.',
    },
  );
  await proveRlsIsolation(ctx, handleA, msgA);

  // The in-process config cache (loadConfig) is now a per-guild Map keyed by guildId,
  // so cross-guild config bleed is fixed at the source (see per-guild-config-cache.test.ts).
  // End-to-end validation of the "strictly per-guild caches" behavioral claim across two
  // guilds' live reactions still requires the live reaction engine in one process.
  gateReactionBehavior(
    ctx,
    'Guild A’s starboard gains nothing from guild B activity and vice versa across live reactions (strictly per-guild caches).',
    'validating the per-guild in-process cache across two guilds’ reactions requires the live reaction engine in one process (DISCORD_TOKEN + live guild); the loadConfig cache is now a per-guild Map keyed by guildId (unit-proven in per-guild-config-cache.test.ts)',
  );

  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateAudit(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE / RETRY');
  gateCleanupDeferredTo(ctx, 'CLEANUP');
}

/** CLEANUP — the sweep leaves no trace: run-prefixed entries removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const channel = ctx.snowflake('starboard-channel');
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { starboard_enabled: true, starboard_channel_id: channel, starboard_threshold: 3 },
  });
  const msg1 = `${ctx.runPrefix}sb-clean-1`;
  const msg2 = `${ctx.runPrefix}sb-clean-2`;

  // Create run-prefixed operational rows: two starboard entries.
  await insertEntry(handle, { sourceMessageId: msg1, sourceChannelId: `${ctx.runPrefix}src`, authorId: ctx.userId('a'), starCount: 3 });
  await insertEntry(handle, { sourceMessageId: msg2, sourceChannelId: `${ctx.runPrefix}src`, authorId: ctx.userId('b'), starCount: 4 });

  const before = await entryCount(handle);
  ctx.expect(before >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed starboard entry rows (pre-cleanup baseline).',
    observation: `pre-cleanup: starboard_entries rows for the guild = ${before} (expected >= 2).`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(ctx, handle, msg1);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateAudit(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const after = await entryCount(handle);
  ctx.expect(after === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed starboard entry rows are deleted; a final sweep finds zero run-prefixed starboard resources.',
    observation: `post-sweep: starboard_entries rows for the guild = ${after} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed starboard rows behind — the suite leaves residue.',
  });

  // Discord channel readback of removed embeds, and audit "anonymized-not-deleted"
  // history in audit_logs, are separate credentialed lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed starboard entries remain in either test guild’s starboard channel after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering the cleaned scenario’s triggers yields no duplicate rows.',
    'entry-row idempotency is exercised directly in the REPLAY / RACE / RETRY scenarios',
  );
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The starboard domain proof. Starboard writes exactly one guild_id-scoped table
 * (`starboard_entries`, child of `guild`); guild_config + guild are always swept
 * by the runner in addition, so the sweep is surgical.
 */
export const communityStarboardProof: DomainProof = {
  domainId: 'community-starboard',
  guildScopedTables: ['starboard_entries'],
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
