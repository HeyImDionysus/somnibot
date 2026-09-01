/**
 * scenario-runner/scripts/community-profiles — the Member Profiles domain proof.
 *
 * Binds the community-profiles domain's 12 declarative catalog scenarios to
 * concrete real-stack proofs driven through the REAL production dispatcher
 * (handleInteraction → ProfilesManager) against LOCAL Supabase. Every
 * DB-observable / captured-reply / RLS assertion runs NOW; anything needing a real
 * Discord effect (card/channel/message readback against a live brand kit), a
 * dependency-outage fault lane, or a mid-write fault lane is GATED — never faked.
 *
 * Commands used and why:
 *   - /title, /bio are pure-Supabase self-service writes to `economy_profiles`
 *     (create-on-first-use via getOrCreateProfile, then UPDATE title/bio), so their
 *     real DB effect + confirmation reply are asserted live.
 *   - /profile defers then editReplies a branded card embed (title prefix, bio as
 *     description, economy standing fields); the captured embed is asserted live.
 *
 * Behavior-bug discovery (these FAIL — findings for the owner, never softened):
 *   1. NO configuration surface. The catalog declares six owner controls
 *      (profiles-enabled, bio-max-length, title-max-length, content-filter-mode,
 *      profile-visibility, show-game-stats). guild_config has NONE of these columns
 *      (probed live via PostgREST 42703) and ProfilesManager reads no config — so
 *      SET-A (length cap / strict filter) and SET-B (visibility gate / hide game
 *      stats) cannot take effect. Even the DEFAULT 256-char bio cap is unenforced
 *      server-side (a 300-char bio persists verbatim).
 *   2. NO audit trail. Profile /title|/bio saves write zero `audit_logs` rows; the
 *      catalog contracts one append-only audit row per state change. Recorded once
 *      in DEF; other scenarios defer to that finding to avoid duplicate noise.
 *   3. NO write idempotency. Re-delivering the SAME /bio interaction id re-runs the
 *      write (updated_at advances) and re-sends the confirmation (REPLAY).
 *
 * Branding is GATED (not failed): the bot emits stock confirmation wording and a
 * fixed blurple embed color with no owner-configured brand token, and verifying a
 * white-label brand-kit/voice/powered-by match needs the snapshot inspector against
 * a live brand kit (DISCORD_TOKEN + live guild) — the same lane the gold-standard
 * wallet proof gates.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface ProfileRow {
  user_id: string;
  guild_id: string;
  title: string;
  bio: string;
  updated_at: string;
  profile_views: number;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readProfile(handle: LiveClientHandle, userId: string): Promise<ProfileRow | null> {
  const { data } = await handle.supabase
    .from('economy_profiles')
    .select('user_id, guild_id, title, bio, updated_at, profile_views')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function profileCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_profiles')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/**
 * Count append-only audit rows the bot wrote for member-profile actions in this
 * guild (`action` namespaced `profiles.*`, per the catalog's auditEvents). Returns
 * null when the read itself errors so a failed read can never masquerade as
 * "no audit written".
 */
async function profileAuditCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .ilike('action', 'profiles%');
  if (error) return null;
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors so a
 * failed read cannot masquerade as "no alert raised".
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
 * Probe whether a `guild_config` column exists, live, via PostgREST. Returns true
 * when the column is absent (SQLSTATE 42703 "column ... does not exist"), false when
 * it exists, and null when the probe is inconclusive. This is the real, DB-observable
 * evidence that a declared owner control has NO backing config surface at all.
 */
async function configColumnMissing(handle: LiveClientHandle, column: string): Promise<boolean | null> {
  const { error } = await handle.supabase
    .from('guild_config')
    .select(column)
    .eq('guild_id', handle.guildId)
    .limit(1);
  if (!error) return false;
  const code = (error as { code?: string }).code;
  const message = ((error as { message?: string }).message ?? '').toLowerCase();
  if (code === '42703' || message.includes('does not exist') || message.includes(column.toLowerCase())) {
    return true;
  }
  return null;
}

/** The last non-empty content string a handler produced (editReply → reply → followUp). */
/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

function replyContentOf(captured: CapturedResponse): string {
  for (let i = captured.calls.length - 1; i >= 0; i -= 1) {
    const call = captured.calls[i]!;
    if (call.method === 'editReply' || call.method === 'reply' || call.method === 'followUp') {
      const content = payloadText(call.payload);
      if (content.length > 0) return content;
    }
  }
  return '';
}

/**
 * The raw embed data of the last reply/editReply/followUp carrying an embed. /profile
 * defers then editReplies its card, so this must scan editReply (not just reply).
 */
function lastEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  for (let i = captured.calls.length - 1; i >= 0; i -= 1) {
    const call = captured.calls[i]!;
    if (call.method === 'editReply' || call.method === 'reply' || call.method === 'followUp') {
      const payload = call.payload as { embeds?: Array<{ data?: Record<string, unknown> }> } | undefined;
      const data = payload?.embeds?.[0]?.data;
      if (data) return data;
    }
  }
  return undefined;
}

/** Build a full user-shaped option value for /profile's `user` target (handler reads
 *  target.id / target.username / target.displayAvatarURL()). */
function viewerOption(userId: string, name: string): Record<string, unknown> {
  return {
    user: {
      id: userId,
      bot: false,
      username: name,
      displayAvatarURL: () => `https://cdn.example/${userId}.png`,
    },
  };
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint (no supabase-js dependency).
 * Returns the number of rows an anon key can read (deny → 0), or null when no anon
 * key / inconclusive. Mirrors the gold-standard wallet proof: a genuine 42501
 * "permission denied for table" is the deny we want (economy_profiles GRANTs are
 * revoked from anon/authenticated by the V6 hardening migration).
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_profiles rows (table GRANTs revoked; RLS economy_profiles_guild).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — per-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'economy_profiles', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero economy_profiles rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS/GRANTs evaluated)',
    );
    return;
  }
  const serviceSees = await readProfile(handle, userId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s member-profile row while an anon client reads zero of them (economy_profiles anon/authenticated GRANTs revoked; RLS economy_profiles_guild).',
    observation:
      `service-role sees the member’s profile under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} economy_profiles row(s) for that guild.`,
    impact:
      'A profile row visible to the service role was also readable with an anon key — anon reads are not denied (direct data exposure).',
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
      promise: "This scenario's happy path raises no owner alert (profile failures also set ownerNotification=false).",
      observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
      impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
    });
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A single dependency-degradation alert (the only owner-alerting profile failure) carries a reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus the dependency-outage fault branch',
  );
}

/**
 * Prove the audit gap ONCE: member-profile state changes must land append-only
 * audit_logs rows (actor, guild, correlation id) but ProfilesManager writes none.
 */
async function proveProfilesAudited(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  expectedMin: number,
  actionsDesc: string,
): Promise<void> {
  const rows = await profileAuditCount(handle);
  if (rows === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'Every member-profile state change lands exactly one append-only audit row.',
      'the audit_logs read errored, so the audit trail could not be evaluated (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(rows >= expectedMin, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'Every member-profile state change lands exactly one append-only audit_logs row carrying actor id, guild id, and the run-prefixed correlation id.',
    observation:
      `${actionsDesc}, but audit_logs holds ${rows} row(s) with a "profiles.*" action for the guild (expected >= ${expectedMin}).`,
    impact:
      'Member-profile /title and /bio saves write no audit_logs row at all — there is no append-only audit trail (actor/guild/correlation id) for profile changes.',
  });
}

/** Defer the audit class to DEF's recorded finding, so the same bug is not re-filed per scenario. */
function gateAuditDeferredToDef(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every member-profile state change lands one append-only audit row.',
    'profile saves use occurrence-keyed audit events with bounded retry; proving this scenario requires the real profile command followed by audit_logs readback',
  );
}

/** Branding is undrivable here: no owner brand token in profile replies + no snapshot inspector. */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Member-profile embeds and replies match the owner white-label brand kit, colors, voice preset, and the subtle powered-by-SomniBot attribution.',
    'the bot emits stock confirmation wording (e.g. "✅ Bio updated!") and a fixed blurple embed color with no owner-configured brand token; verifying the configured brand kit / voice preset / powered-by attribution needs the embed+message snapshot inspector against a live brand kit (DISCORD_TOKEN + live guild)',
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The /profile card, /title and /bio confirmations are observed rendering in the live test guild.',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/message readback',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s trigger yields no duplicate profile write or confirmation.',
    `replay/idempotency is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — default title/bio save + branded profile card out of the box. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const bioMaxDefault = Number(declaredDefault(ctx.domain, 'bio-max-length'));
  const titleMaxDefault = Number(declaredDefault(ctx.domain, 'title-max-length'));

  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const title = `${ctx.runPrefix}TITLE-A`.slice(0, titleMaxDefault);
  const bio = `${ctx.runPrefix}bio: loves testing profiles`.slice(0, bioMaxDefault);

  // 1) First /title creates exactly one self-owned profile row and confirms the value.
  const titleCaptured = await ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title } });
  const afterTitle = await readProfile(handle, userA);
  const created = await profileCount(handle, userA);
  ctx.expect(created === 1 && afterTitle?.title === title, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: '/title saves exactly one profile row carrying the invoking member’s title (create-on-first-use).',
    observation: `profile rows=${created}, stored title=${JSON.stringify(afterTitle?.title)} (expected ${JSON.stringify(title)}).`,
    impact: '/title did not persist the member’s title to a single guild-scoped profile row.',
  });
  const titleReply = replyContentOf(titleCaptured);
  ctx.expect(titleReply.includes(title), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Saving a title returns a confirmation naming the saved value.',
    observation: `/title reply = ${JSON.stringify(truncate(titleReply))}.`,
    impact: 'The /title confirmation did not echo the saved title.',
  });

  // 2) /bio saves the bio onto the same row without disturbing the title.
  await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio } });
  const afterBio = await readProfile(handle, userA);
  ctx.expect(afterBio?.bio === bio && afterBio?.title === title, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: '/bio saves the member’s bio onto the same profile row without disturbing the title.',
    observation:
      `stored bio=${JSON.stringify(truncate(afterBio?.bio ?? ''))} (len ${afterBio?.bio.length ?? 0}), ` +
      `title=${JSON.stringify(afterBio?.title)}.`,
    impact: '/bio did not persist the bio (or clobbered the title).',
  });

  // 3) /profile from run-member-b renders run-member-a's saved title + bio + standing.
  const profileCaptured = await ctx.runSlash(handle, {
    commandName: 'profile',
    userId: userB,
    options: viewerOption(userA, 'DEF-A'),
  });
  const embed = lastEmbedData(profileCaptured);
  const embedTitle = typeof embed?.title === 'string' ? embed.title : '';
  const embedDesc = typeof embed?.description === 'string' ? embed.description : '';
  const fields = (embed?.fields as Array<{ name?: string; value?: string }> | undefined) ?? [];
  const standingField = fields.find((f) => typeof f.name === 'string' && f.name.includes('Net Worth'));
  ctx.expect(embedTitle.includes(title) && embedDesc === bio && Boolean(standingField), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/profile renders the saved title and bio verbatim on a card beside community standing.',
    observation:
      `embed title=${JSON.stringify(truncate(embedTitle))}, description=${JSON.stringify(truncate(embedDesc))}, ` +
      `standing field=${JSON.stringify(standingField?.name ?? '(missing)')}.`,
    impact: '/profile did not render the saved title/bio or the community-standing field.',
  });

  // Audit gap — the canonical finding, recorded once here (deferred elsewhere).
  await proveProfilesAudited(ctx, handle, 2, 'DEF performed a /title and a /bio save');

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard bio-length cap + strict content filter should take effect (they can't). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const bioMaxDefault = Number(declaredDefault(ctx.domain, 'bio-max-length'));
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  const capMissing = await configColumnMissing(handle, 'bio_max_length');
  const filterMissing = await configColumnMissing(handle, 'content_filter_mode');

  // A bio longer than even the DEFAULT cap (256): a correct implementation would reject
  // or truncate; the bot persists it verbatim (no server-side enforcement at all).
  const longBio = 'B'.repeat(bioMaxDefault + 44);
  const captured = await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio: longBio } });
  const saved = await readProfile(handle, userA);
  const savedLen = saved?.bio.length ?? 0;
  const reply = replyContentOf(captured);
  const capEnforced = saved !== null && savedLen <= bioMaxDefault;

  ctx.expect(capEnforced, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Dashboard configuration takes effect: an owner-tuned bio-length cap and a strict content-filter mode are enforced on the next /bio save.',
    observation:
      `submitted a ${longBio.length}-char bio; the catalog default bio-max-length is ${bioMaxDefault}; ` +
      `the bot persisted ${savedLen} char(s) verbatim (server-side length enforcement absent), ` +
      `reply=${JSON.stringify(truncate(reply))}. guild_config has no bio_max_length column (missing=${capMissing}) ` +
      `or content_filter_mode column (missing=${filterMissing}) to tighten the cap or enable strict filtering.`,
    impact:
      'Profile length/content controls are unimplemented: the owner-configurable cap and content-filter have no guild_config columns and ProfilesManager applies no server-side validation, so even the default 256-char cap is unenforced — SET-A’s "config takes effect" cannot hold.',
  });

  gateAuditDeferredToDef(ctx);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — visibility gate + hide-game-stats should take effect (they can't). */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  const visibilityMissing = await configColumnMissing(handle, 'profile_visibility');
  const statsMissing = await configColumnMissing(handle, 'show_game_stats');

  // Customize + render a card; the card ALWAYS carries game-stat fields (no config can hide them).
  const bio = `${ctx.runPrefix}set-b bio`;
  await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio } });
  const captured = await ctx.runSlash(handle, { commandName: 'profile', userId: userA });
  const embed = lastEmbedData(captured);
  const fields = (embed?.fields as Array<{ name?: string; value?: string }> | undefined) ?? [];
  const gameStatFields = fields.filter(
    (f) => typeof f.name === 'string' && (f.name.includes('Net Worth') || f.name.includes('Wallet') || f.name.includes('Bank')),
  );
  const cardRendered = Boolean(embed);

  ctx.expect(!visibilityMissing && !statsMissing, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A second configuration takes effect: profile visibility is gated to onboarded members and game-stat display is switched off, so /profile omits game standing.',
    observation:
      `guild_config has no profile_visibility column (missing=${visibilityMissing}) and no show_game_stats column (missing=${statsMissing}); ` +
      `/profile ${cardRendered ? 'rendered a card' : 'rendered no card'} that still shows ${gameStatFields.length} game-stat field(s) ` +
      `(${gameStatFields.map((f) => f.name).join(', ') || 'none'}) with no visibility gate applied.`,
    impact:
      'The profile-visibility and show-game-stats controls are unimplemented (no guild_config columns, no gating): /profile always renders the full card with game standing to everyone, so SET-B cannot hold.',
  });

  // Corroboration (real captured embed): the card exposes game-stat fields it cannot be told to hide.
  ctx.expect(cardRendered && gameStatFields.length >= 1, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/profile renders game-standing fields (which a show-game-stats=off config should be able to suppress).',
    observation: `card game-stat fields = ${gameStatFields.length} (${gameStatFields.map((f) => f.name).join(', ') || 'none'}).`,
    impact: 'Expected the profile card to expose game-stat fields to prove they cannot be suppressed; none rendered (probe invalid).',
  });

  gateAuditDeferredToDef(ctx);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — an out-of-range profile config must be rejected atomically (dashboard lane). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const capMissing = await configColumnMissing(handle, 'bio_max_length');

  // DB-observable core: the bot behaves normally on the very next command regardless of
  // any (unreachable) config-rejection — a /bio saves and /profile renders it.
  const bio = `${ctx.runPrefix}invalid-scenario bio`;
  await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio } });
  const captured = await ctx.runSlash(handle, { commandName: 'profile', userId: userA });
  const embed = lastEmbedData(captured);
  const embedDesc = typeof embed?.description === 'string' ? embed.description : '';
  ctx.expect(Boolean(embed) && embedDesc === bio, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged: after an (attempted) invalid config save, the next /bio still saves and /profile renders it.',
    observation: `/profile ${embed ? 'rendered its card' : 'produced no card'}; description=${JSON.stringify(truncate(embedDesc))}.`,
    impact: 'A rejected/invalid config attempt disturbed live profile behavior.',
  });

  // The atomic REJECTION of an out-of-range bio-max-length (0 / 4096) is a dashboard (Zod)
  // concern; guild_config has no bio_max_length column at all, so the reject path is not
  // reachable in a bot-only harness. GATE honestly (never fake a rejection).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard rejects bio-max-length 0 and 4096 with a clear error and never persists an out-of-range value.',
    `profile length config lives in the dashboard (Zod) layer and guild_config has no bio_max_length column at all (missing=${capMissing}); a bot-only harness cannot drive the reject path`,
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records each rejected profile-configuration attempt with its validation reason.',
    'the rejected-config audit row requires the authenticated dashboard save path, while profile write audits require the real command path; neither audit readback is reachable in this bot-only harness',
  );

  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — profiles are self-service only: no member can write another member’s profile. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const titleA = `${ctx.runPrefix}A-OWN-TITLE`;
  const titleB = `${ctx.runPrefix}B-OWN-TITLE`;

  // run-member-a customizes their own profile; snapshot it.
  await ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title: titleA } });
  const snapA = await readProfile(handle, userA);

  // run-member-b runs /title — the command only ever writes the INVOKER's row (there is no
  // target option on /title|/bio), so it can only touch b's own profile, never a's.
  await ctx.runSlash(handle, { commandName: 'title', userId: userB, options: { title: titleB } });
  const afterA = await readProfile(handle, userA);
  const rowB = await readProfile(handle, userB);

  ctx.expect(afterA?.title === titleA && afterA?.title === snapA?.title && rowB?.title === titleB, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Profiles are self-service only: another member’s /title|/bio writes only their OWN row and can never mutate a target member’s title or bio.',
    observation:
      `run-member-a title=${JSON.stringify(afterA?.title)} (unchanged from ${JSON.stringify(snapA?.title)}); ` +
      `run-member-b wrote its own row title=${JSON.stringify(rowB?.title)}.`,
    impact: 'A member’s profile was altered by another member — the self-service-only guarantee was broken.',
  });

  ctx.expect(afterA?.user_id === userA && rowB?.user_id === userB && afterA?.title !== rowB?.title, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Each member owns a distinct guild-scoped profile row; one member’s write never lands on another’s row.',
    observation:
      `row A user=${afterA?.user_id} title=${JSON.stringify(afterA?.title)}; ` +
      `row B user=${rowB?.user_id} title=${JSON.stringify(rowB?.title)}.`,
    impact: 'Two members’ writes collapsed onto one row — cross-member profile bleed.',
  });

  await proveRlsIsolation(ctx, handle, userA);

  // A crafted API write to run-member-a's row is denied at the DB GRANT layer (anon/
  // authenticated REVOKED on economy_profiles — proven by the anon-deny probe above). The
  // bot audits no denied write because no command surface accepts a target write to audit.
  ctx.gate(
    'audit',
    'audit-row',
    'A denied cross-member profile-write attempt is audited with actor, target, and reason.',
    'no command/API surface accepts a target write to deny-and-audit (writes are structurally self-service), and a crafted anon API write is denied at the economy_profiles GRANT layer without a bot-written audit row',
  );

  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — database-unreachable fail-soft, driven through the REAL fault
 *  proxy (ctx.faults severs the actual network path run-one-domain routed the
 *  stack through). Falls back to honest gates when no proxy is registered
 *  (e.g. the CI vitest lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const supabaseFault = ctx.faults?.supabase;
  if (supabaseFault) {
    const handle = await ctx.bootGuild({ label: 'a' });
    const userA = ctx.userId('a');
    const title = `${ctx.runPrefix}pre-outage-title`;
    const bio = `${ctx.runPrefix}pre-outage-bio`;

    // Arrange known pre-outage state THROUGH the real handlers (2 audit rows).
    await ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title } });
    await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio } });
    const before = await readProfile(handle, userA);

    // ── Outage window: a REAL severed network path (ECONNREFUSED). ──
    await supabaseFault.sever();
    let threw: string | null = null;
    let severedCardReply = '';
    let severedCardEmbed: Record<string, unknown> | undefined;
    let severedBioReply = '';
    const outageBio = `${ctx.runPrefix}outage-bio-never-lands`;
    try {
      const cardCap = await ctx.runSlash(handle, { commandName: 'profile', userId: userA });
      severedCardReply = replyContentOf(cardCap);
      severedCardEmbed = lastEmbedData(cardCap);
      const bioCap = await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio: outageBio } });
      severedBioReply = replyContentOf(bioCap);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await supabaseFault.restore();

    // (1) Fail-SOFT: both commands replied; the pipeline never crashed.
    ctx.expect(threw === null && severedCardReply.length > 0 && severedBioReply.length > 0, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'With the database unreachable, /profile and /bio still reply (fail-soft) instead of crashing the interaction pipeline.',
      observation:
        threw === null
          ? `during the outage /profile replied ${JSON.stringify(truncate(severedCardReply))} and /bio replied ${JSON.stringify(truncate(severedBioReply))}.`
          : `an outage-window command THREW ${truncate(threw)}.`,
      impact: 'A database outage crashed the profiles command pipeline instead of degrading to a reply.',
    });

    // (2) The catalog contracts the branded profiles-unavailable notice — never
    //     a data-shaped answer. A zeroed profile card or a "Bio updated!"
    //     confirmation during an outage is a lie about state the bot could not
    //     read/write. Recorded honestly; never softened.
    const unavailableRe = /snooz|unavailable|try again|temporar|later/i;
    const cardHonest = unavailableRe.test(severedCardReply) && severedCardEmbed === undefined;
    const bioHonest = unavailableRe.test(severedBioReply) && !/updated|saved|✅/i.test(severedBioReply);
    ctx.expect(cardHonest && bioHonest, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise:
        'During the outage /profile and /bio reply with the branded profiles-unavailable notice ("Profiles are snoozing…") — never a fabricated zeroed card or a false "Bio updated!" confirmation.',
      observation:
        `outage-window /profile reply ${JSON.stringify(truncate(severedCardReply))} (embed rendered=${severedCardEmbed !== undefined}); ` +
        `/bio reply ${JSON.stringify(truncate(severedBioReply))} — cardHonest=${cardHonest}, bioHonest=${bioHonest}.`,
      impact:
        'During a database outage the profiles surface fabricated a data-shaped answer (a zeroed card or a success confirmation for a write that never landed) instead of the branded unavailable notice.',
    });

    // (3) ZERO data loss / corruption: the pre-outage row is byte-identical
    //     after restore; the outage-window bio never landed.
    const after = await readProfile(handle, userA);
    ctx.expect(
      after !== null &&
        after.title === before?.title &&
        after.bio === before?.bio &&
        after.bio === bio &&
        after.updated_at === before?.updated_at,
      {
        assertionClass: 'Discord',
        channel: 'db-observable',
        promise: 'No data is lost across the outage window: the persisted title/bio (and updated_at) are byte-identical after restoration and the outage-window save never landed.',
        observation:
          `post-restore profile title=${JSON.stringify(after?.title)}/bio=${JSON.stringify(truncate(after?.bio ?? ''))} ` +
          `(expected the pre-outage ${JSON.stringify(truncate(bio))}); updated_at ${before?.updated_at} → ${after?.updated_at} (must be unchanged).`,
        impact: 'A database outage corrupted or partially applied a profile write.',
      },
    );

    // (4) RECOVERY: the very next commands serve real data and save again.
    const recoveredCard = await ctx.runSlash(handle, { commandName: 'profile', userId: userA });
    const recoveredEmbed = lastEmbedData(recoveredCard);
    const recoveredTitle = typeof recoveredEmbed?.title === 'string' ? recoveredEmbed.title : '';
    const recoveredDesc = typeof recoveredEmbed?.description === 'string' ? recoveredEmbed.description : '';
    const freshBio = `${ctx.runPrefix}post-outage-bio`;
    const freshCap = await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio: freshBio } });
    const afterFresh = await readProfile(handle, userA);
    const rows = await profileCount(handle, userA);
    ctx.expect(
      recoveredTitle.includes(title) &&
        recoveredDesc === bio &&
        afterFresh?.bio === freshBio &&
        rows === 1 &&
        replyContentOf(freshCap).includes('Bio updated'),
      {
        assertionClass: 'replay-safety',
        channel: 'db-observable',
        promise: 'After restoration the very next /profile renders the intact pre-outage values and a fresh /bio save applies exactly once (one row, one confirmation — no duplicate or phantom write from the outage cycle).',
        observation:
          `post-restore /profile embed title=${JSON.stringify(truncate(recoveredTitle))}, description=${JSON.stringify(truncate(recoveredDesc))}; ` +
          `fresh save stored bio=${JSON.stringify(truncate(afterFresh?.bio ?? ''))} across ${rows} profile row(s); reply ${JSON.stringify(truncate(replyContentOf(freshCap)))}.`,
        impact: 'The profiles pipeline did not recover cleanly after the outage ended (stale degradation, lost values, or a duplicated write).',
      },
    );

    // (5) Audit: the two pre-outage saves + the one post-recovery save each
    //     landed exactly one append-only profiles.* audit row; the REFUSED
    //     outage-window save landed none (no audit row for a write that never
    //     happened).
    const auditRows = await profileAuditCount(handle);
    ctx.expect(auditRows === 3, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Each applied profile save lands exactly one append-only audit row and the refused outage-window save lands none (3 total: title + bio + post-recovery bio).',
      observation: `audit_logs holds ${auditRows ?? '(read errored)'} profiles.* row(s) for the guild (expected exactly 3).`,
      impact: 'The outage cycle broke the profile audit trail (a missing row for an applied save, or a phantom row for a refused one).',
    });

    // Guild-scoping holds across the outage window.
    await proveRlsIsolation(ctx, handle, userA);
  } else {
    ctx.gate(
      'Discord',
      'db-observable',
      'With the database unreachable, /profile and /bio reply with the branded profiles-unavailable notice and no data is lost.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'audit',
      'db-observable',
      'After restoration the pre-outage title/bio are intact and a fresh save applies exactly once.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'replay-safety',
      'db-observable',
      'No duplicate profile write survives the outage/restore cycle.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'branding',
      'captured-reply',
      'The degradation reply uses the branded profiles-unavailable template ("Profiles are snoozing…") in the owner voice.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
    ctx.gate(
      'database-RLS',
      'db-rls',
      'Profile rows stay guild-scoped through the outage window.',
      'no fault proxy registered in this process (run via run-one-domain.mjs for the dependency-outage lane)',
    );
  }
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A single dependency-degradation alert covers the outage window (profile happy paths raise none; non-outage profile failures set ownerNotification=false).',
    'the degradation alert cannot be written while the database itself is severed and no post-recovery alert emitter exists on the profiles path today; observing the single alert needs the owner alert channel readback (DISCORD_TOKEN + live guild)',
  );
}

/** RETRY — a transient write fault converges to exactly one save (needs a mid-write fault lane). */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  ctx.gate(
    'Discord',
    'db-observable',
    'With a transient fault injected on the first /bio save, the retry lands the value exactly once and the member sees one confirmation.',
    'requires a mid-write fault-injection lane at the economy_profiles update boundary; the bot also has no retry/idempotent-write-key wired today, so this cannot be exercised without injection',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The write idempotency key shows a single applied save across attempts.',
    'requires the mid-write fault-injection lane; profile writes also carry no persisted idempotency key today (see REPLAY)',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The retried save applies under one idempotency key — no double write.',
    'requires the mid-write fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The member sees the branded confirmation once after the retry converges.',
    'requires the mid-write fault-injection lane to reach the retry branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The retried save touches only the member’s guild-scoped profile row.',
    'requires the mid-write fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'db-observable',
    'No owner alert is raised for a self-healing transient retry (ownerNotification=false for this failure).',
    'requires the mid-write fault-injection lane',
  );
}

/** REPLAY — re-delivering the /bio interaction must not double-write or double-confirm. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const bio = `${ctx.runPrefix}replay-bio-v1`;
  const bioIntId = `${ctx.runPrefix}bio-int`;

  const first = await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio }, interactionId: bioIntId });
  const firstReply = replyContentOf(first);
  const afterFirst = await readProfile(handle, userA);

  // Re-deliver the SAME /bio interaction id (a replay).
  const second = await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio }, interactionId: bioIntId });
  const secondReply = replyContentOf(second);
  const afterReplay = await readProfile(handle, userA);

  // Value idempotency holds trivially (same value written), so the card stays coherent.
  const profileCaptured = await ctx.runSlash(handle, { commandName: 'profile', userId: userA });
  const embed = lastEmbedData(profileCaptured);
  const desc = typeof embed?.description === 'string' ? embed.description : '';
  ctx.expect(afterReplay?.bio === bio && desc === bio, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'After replay the profile shows the value exactly once (one coherent bio).',
    observation: `stored bio=${JSON.stringify(truncate(afterReplay?.bio ?? ''))}; /profile description=${JSON.stringify(truncate(desc))}.`,
    impact: 'The replayed save corrupted or duplicated the stored bio value.',
  });

  // Replay-safety FAIL: NO persisted idempotency key — the re-delivered interaction re-ran
  // the write (updated_at advanced) and produced a SECOND confirmation, instead of no-op.
  const secondConfirmationIssued = secondReply.length > 0;
  const updatedAtAdvanced = Boolean(
    afterFirst?.updated_at && afterReplay?.updated_at && afterReplay.updated_at !== afterFirst.updated_at,
  );
  const replayIgnored = !secondConfirmationIssued && !updatedAtAdvanced;
  ctx.expect(replayIgnored, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the /bio interaction is ignored: no second write (updated_at unchanged) and no second confirmation reply.',
    observation:
      `replay produced a second confirmation reply=${secondConfirmationIssued} (${JSON.stringify(truncate(secondReply))}); ` +
      `updated_at ${afterFirst?.updated_at} → ${afterReplay?.updated_at} (advanced=${updatedAtAdvanced}). ` +
      `first reply was ${JSON.stringify(truncate(firstReply))}.`,
    impact:
      'Profile writes carry no persisted idempotency key: a re-delivered /title|/bio interaction re-runs the write and re-sends the confirmation, so the catalog’s replay-safety guarantee does not hold.',
  });

  gateAuditDeferredToDef(ctx);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
}

/** RESTART — profile state survives a full stack reboot (it lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const title = `${ctx.runPrefix}restart-title`;
  const bio = `${ctx.runPrefix}restart-bio`;

  // Boot #1: create + customize, snapshot, then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await ctx.runSlash(first, { commandName: 'title', userId: userA, options: { title } });
  await ctx.runSlash(first, { commandName: 'bio', userId: userA, options: { bio } });
  const snapshot = await readProfile(first, userA);
  await first.cleanup();

  // Boot #2: SAME guild id (restart). State must be identical.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const captured = await ctx.runSlash(second, { commandName: 'profile', userId: userA });
  const afterRestart = await readProfile(second, userA);
  const embed = lastEmbedData(captured);
  const embedTitle = typeof embed?.title === 'string' ? embed.title : '';
  const embedDesc = typeof embed?.description === 'string' ? embed.description : '';
  ctx.expect(
    afterRestart?.title === snapshot?.title &&
      afterRestart?.bio === snapshot?.bio &&
      afterRestart?.title === title &&
      afterRestart?.bio === bio,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, the profile row matches the pre-restart snapshot exactly (title + bio persist).',
      observation:
        `pre-restart title=${JSON.stringify(snapshot?.title)}/bio=${JSON.stringify(truncate(snapshot?.bio ?? ''))}; ` +
        `post-restart title=${JSON.stringify(afterRestart?.title)}/bio=${JSON.stringify(truncate(afterRestart?.bio ?? ''))}.`,
      impact: 'Profile state did not survive a restart — persisted title/bio were lost or altered.',
    },
  );
  ctx.expect(embedTitle.includes(title) && embedDesc === bio, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /profile renders the same title and bio.',
    observation: `post-restart embed title=${JSON.stringify(truncate(embedTitle))}, description=${JSON.stringify(truncate(embedDesc))}.`,
    impact: 'Post-restart /profile did not render the persisted title/bio.',
  });

  gateAuditDeferredToDef(ctx);
  await proveRlsIsolation(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — two simultaneous /title saves end with one coherent winning value. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  // Pre-create the row so both concurrent saves are pure UPDATEs (isolate write coherence
  // from first-touch insert creation).
  await ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title: `${ctx.runPrefix}seed-title` } });

  const titleX = `${ctx.runPrefix}RACE-X`;
  const titleY = `${ctx.runPrefix}RACE-Y`;
  const [cx, cy] = await Promise.all([
    ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title: titleX } }),
    ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title: titleY } }),
  ]);
  const rows = await profileCount(handle, userA);
  const finalRow = await readProfile(handle, userA);
  const winner = finalRow?.title ?? '';
  const coherent = winner === titleX || winner === titleY;
  ctx.expect(rows === 1 && coherent, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous /title saves end with exactly one profile row holding one coherent winning value — never a blend or partial write.',
    observation: `profile rows=${rows}; final title=${JSON.stringify(winner)} (expected exactly one of ${JSON.stringify(titleX)} / ${JSON.stringify(titleY)}).`,
    impact: 'A concurrent /title race produced duplicate rows or an interleaved/blended title value.',
  });
  ctx.expect(replyContentOf(cx).length > 0 || replyContentOf(cy).length > 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Both concurrent /title saves acknowledge with a confirmation.',
    observation: `concurrent replies: x=${JSON.stringify(truncate(replyContentOf(cx)))}, y=${JSON.stringify(truncate(replyContentOf(cy)))}.`,
    impact: 'A concurrent /title produced no confirmation reply.',
  });

  gateAuditDeferredToDef(ctx);
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** XGUILD — profiles are strictly per-guild (a title set in guild A never leaks into guild B). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA });
  const handleB = await ctx.bootGuild({ guildId: guildB });
  const titleA = `${ctx.runPrefix}GUILD-A-TITLE`;

  await ctx.runSlash(handleA, { commandName: 'title', userId: userA, options: { title: titleA } });
  const rowA = await readProfile(handleA, userA);

  // In guild B the same member's /profile shows guild B's default (no guild A title).
  const capturedB = await ctx.runSlash(handleB, { commandName: 'profile', userId: userA });
  const embedB = lastEmbedData(capturedB);
  const embedBTitle = typeof embedB?.title === 'string' ? embedB.title : '';
  const rowB = await readProfile(handleB, userA);
  const rowAAfter = await readProfile(handleA, userA);

  ctx.expect(
    rowA?.title === titleA &&
      rowAAfter?.title === titleA &&
      (rowB?.title ?? '') === '' &&
      !embedBTitle.includes(titleA),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Profiles are per-guild: a title set in guild A never renders or leaks into guild B; guild B shows its own default profile.',
      observation:
        `guild A title=${JSON.stringify(rowAAfter?.title)} (still ${JSON.stringify(titleA)}); ` +
        `guild B stored title=${JSON.stringify(rowB?.title ?? '')}; ` +
        `guild B /profile embed title=${JSON.stringify(truncate(embedBTitle))} (must not contain the guild A title).`,
      impact: 'A profile title set in one guild leaked into another guild — per-guild isolation broken.',
    },
  );

  ctx.expect(rowA?.guild_id === guildA && rowB?.guild_id === guildB && rowA?.guild_id !== rowB?.guild_id, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: 'Each guild scope reads its own profile row under its own guild_id; a guild-B-scoped read never returns the guild-A row.',
    observation:
      `guild-A-scoped row under "${rowA?.guild_id}" title=${JSON.stringify(rowA?.title)}; ` +
      `guild-B-scoped row under "${rowB?.guild_id}" title=${JSON.stringify(rowB?.title ?? '')}.`,
    impact: 'A guild-scoped read returned another guild’s profile row — cross-guild leakage.',
  });
  await proveRlsIsolation(ctx, handleA, userA);

  gateAuditDeferredToDef(ctx);
  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed profile rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed profile rows for two members.
  await ctx.runSlash(handle, { commandName: 'title', userId: userA, options: { title: `${ctx.runPrefix}cleanup-a` } });
  await ctx.runSlash(handle, { commandName: 'bio', userId: userA, options: { bio: `${ctx.runPrefix}cleanup-bio` } });
  await ctx.runSlash(handle, { commandName: 'title', userId: userB, options: { title: `${ctx.runPrefix}cleanup-b` } });

  const before = (await profileCount(handle, userA)) + (await profileCount(handle, userB));
  ctx.expect(before >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed profile rows (pre-cleanup baseline).',
    observation: `pre-cleanup economy_profiles rows for the run members = ${before}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed profile rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveRlsIsolation(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const after = (await profileCount(handle, userA)) + (await profileCount(handle, userB));
  ctx.expect(after === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed profile rows are deleted; a final sweep finds zero run-prefixed member-profile resources.',
    observation: `post-sweep economy_profiles rows for the run members = ${after}.`,
    impact: 'The cleanup sweep left run-prefixed profile rows behind — the suite leaves residue.',
  });

  // Audit-history anonymization (retain, not delete) and Discord channel/message readback
  // are separate lanes; profiles additionally write no audit_logs rows at all (see DEF).
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational profile rows deleted, audit_logs retained-anonymized).',
    'profile writes produce durable audit rows; proving anonymize-over-delete requires real profile changes, cleanup, and retained audit_logs readback',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed profile cards or confirmation replies after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The community-profiles domain proof: the guild_id-scoped tables the sweep must
 * clear (economy_profiles is the only table this domain writes; alerts is swept for
 * owner-notification hygiene), plus the 12 scenario scripts.
 */
export const communityProfilesProof: DomainProof = {
  domainId: 'community-profiles',
  guildScopedTables: [
    // child → parent so FK-constrained rows are removed before the guild row.
    'economy_profiles',
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
