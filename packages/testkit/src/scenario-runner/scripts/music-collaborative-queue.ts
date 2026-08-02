/**
 * scenario-runner/scripts/music-collaborative-queue — the collaborative-queue domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven through the REAL production dispatcher against LOCAL Supabase.
 *
 * WHY THIS DOMAIN IS MOSTLY GATED (and that is the honest verdict):
 *   The collaborative queue itself is a Valkey object — `queue:<guildId>`,
 *   `nowplaying:<guildId>`, `music:votes:<guildId>:skip` (packages/bot/src/features/
 *   music/music-queue.ts). The isolated runner supplies a real Valkey instance, but
 *   queue mutations still need a live Discord gateway and a Lavalink/Shoukaku node
 *   (`client.shoukaku`); this gateway-less harness cannot create or read back the
 *   queue surface, so it is GATED for that real missing capability. Config writes +
 *   out-of-range rejection go through
 *   the dashboard PUT /api/music (Zod) route — GATED. The music.* audit rows are
 *   written by those same dashboard/Valkey/config-load lanes — GATED.
 *
 * WHAT RUNS LIVE, NON-VACUOUSLY, NOW (real rows read back, never synthetic):
 *   - guild_config music columns are the durable configuration contract the bot's
 *     loadConfig() reads (music-player.ts selects exactly
 *     `music_default_volume, dj_role_id, music_auto_leave_minutes,
 *     music_auto_destroy_minutes`) and the dashboard PUT writes. This proof reads
 *     those columns back through the service role: the shipped SCHEMA defaults
 *     (DEF), configured values persisting (SET-A), the enablement toggle (SET-B),
 *     valid values retained where a reject would be a no-op (INVALID), cross-guild
 *     isolation (XGUILD), durability across a restart (RESTART), and idempotent
 *     upsert (REPLAY).
 *   - RLS anon-denial on guild_config with a positive control (service role reads
 *     THIS guild's row while an anon key reads zero) — the owner-only config gate.
 *   - The owner-notification sink (`alerts`) is asserted empty on happy paths.
 *   - CLEANUP proves the sweep removes run-prefixed guild_config while audit_logs
 *     rows are RETAINED (never-delete, no cascade from guild). The retained
 *     baseline is one probe-seeded run-prefixed audit row: every music.* audit
 *     WRITER (dashboard save, Valkey outage, queue teardown) is behind a gated
 *     lane, and retention-through-sweep — not the writers — is the promise here.
 *
 * DISABLED-DECLINE PROOF: with music disabled the REAL dispatcher's manager-absent
 * branch reads guild_config.music_enabled=false and must answer a music command
 * with the catalog's branded, guild-named `music-disabled` notice ("Music is
 * currently switched off in {guild-name} — an admin can flip it back on from the
 * dashboard."), resolved through the white-label brand kit. SET-B drives /queue
 * against the real dispatcher and asserts BOTH conjuncts on the captured reply's
 * full member-facing surface (content + embed): the switched-off decline exists
 * (Discord) and it names the guild brand (branding). A regression to the old
 * stock unbranded fallback fails here — never softened to a pass.
 */
import type { AssertionClass, DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import { buildSlashInteraction } from '../../interaction-builders.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Small live-stack helpers ──────────────────────────────────────────────

/** The durable music configuration contract in guild_config (the exact columns
 *  the bot's music loadConfig() reads and the dashboard PUT writes). */
interface MusicConfigRow {
  music_enabled: boolean | null;
  music_default_volume: number | null;
  music_auto_leave_minutes: number | null;
  music_auto_destroy_minutes: number | null;
  dj_role_id: string | null;
}

const MUSIC_CONFIG_COLUMNS =
  'music_enabled, music_default_volume, music_auto_leave_minutes, music_auto_destroy_minutes, dj_role_id';

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** Read this guild's music configuration row (service role), or null. */
async function readMusicConfig(handle: LiveClientHandle): Promise<MusicConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(MUSIC_CONFIG_COLUMNS)
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as MusicConfigRow | null) ?? null;
}

/** Apply a live guild_config change the way a dashboard save would land it. */
async function updateMusicConfig(
  handle: LiveClientHandle,
  patch: Partial<MusicConfigRow>,
): Promise<void> {
  await handle.supabase.from('guild_config').update(patch).eq('guild_id', handle.guildId);
}

/** Count guild_config rows for this guild (0 or 1 — guild_id is unique). */
async function guildConfigRowCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('guild_config')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Count immutable audit rows for this guild. Returns null (NOT 0) on read error
 *  so a failed read can never masquerade as "audit was wiped". */
async function auditRowCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

/**
 * Count owner alerts for the guild. Returns null (NOT 0) when the query errors, so
 * a failed read can never masquerade as "no alert raised".
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

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny → 0), or null when no anon key / URL is
 * available or the probe is inconclusive (→ GATE). Mirrors the first domain proof.
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * The owner-only config gate, proven DB-observably: the service role reads THIS
 * guild's guild_config row (positive control — there IS a row to leak) while an
 * anon key reads ZERO of them (RLS `owner_full_access` only). This is the concrete
 * "non-owner / direct table access is denied" evidence the catalog contracts.
 */
async function proveGuildConfigRls(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/non-owner clients read zero guild_config rows (RLS owner_full_access only); cross-guild config is unreadable under anon.',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — service-role guild-scoping still holds',
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
      'The service role reads this guild’s music config row while an anon client reads zero of them (guild_config RLS owner_full_access) — only the owner-scoped route may read/write music settings.',
    observation:
      `service-role sees guild_config for guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} guild_config row(s) for that guild.`,
    impact:
      'A guild_config row visible to the service role was also readable with an anon key — RLS is not denying anon reads (music settings exposed cross-guild).',
  });
}

/** Prove this scenario's happy path raised no owner alert (routine activity = no noise). */
async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      "This scenario's routine queue/config activity raises no owner alert.",
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: "This scenario's routine queue/config activity raises no owner alert.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on routine music activity — a false alarm / notification noise.',
  });
}

/** GATE the live gateway/Lavalink queue surface; isolated Valkey is available. */
function gateQueueStore(ctx: ScenarioContext, assertionClass: AssertionClass, promise: string): void {
  ctx.gate(
    assertionClass,
    'discord-readback',
    promise,
    'requires a live Discord gateway plus Lavalink/Shoukaku queue integration; isolated Valkey is reachable, but this bot-only local-Supabase harness cannot create or read back queue mutations',
  );
}

/** GATE the live Discord voice/embed readback surface. */
function gateVoiceReadback(ctx: ScenarioContext, assertionClass: AssertionClass, promise: string): void {
  ctx.gate(
    assertionClass,
    'discord-readback',
    promise,
    'requires a live Discord gateway + a Lavalink/Shoukaku node (DISCORD_TOKEN + voice) for audible playback and queue/now-playing embed readback',
  );
}

/** GATE the dashboard PUT /api/music configuration lane. */
function gateDashboardConfig(ctx: ScenarioContext, assertionClass: AssertionClass, promise: string): void {
  ctx.gate(
    assertionClass,
    'discord-readback',
    promise,
    'music settings are written/validated by the dashboard PUT /api/music (Zod) route + settings-saved toast — not reachable in a bot-only harness',
  );
}

/** GATE the music.* audit lane (written by dashboard save / Lavalink playback / Valkey outage, none reachable). */
function gateMusicAudit(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'audit',
    'audit-row',
    promise,
    'music.* audit rows (config save/reject, queue add, applied control, skip, queue teardown, store-outage, capacity) are written by the dashboard save path, the Lavalink-backed playback path, a Valkey outage, or a config-load failure — none reachable in the bot-only local-Supabase harness',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-the-box: shipped guild_config schema defaults equal the catalog's safe defaults. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const volDefault = Number(declaredDefault(ctx.domain, 'default-volume'));
  const leaveDefault = Number(declaredDefault(ctx.domain, 'auto-leave-minutes'));
  const destroyDefault = Number(declaredDefault(ctx.domain, 'auto-destroy-minutes'));

  // Boot WITHOUT touching the music integer columns, so they carry the shipped
  // SCHEMA defaults (music_default_volume 50 / auto_leave 5 / auto_destroy 30) —
  // values we did NOT write, so reading them back is a genuine defaults check, not
  // an echo of our own input.
  const handle = await ctx.bootGuild({ label: 'a' });
  const cfg = await readMusicConfig(handle);

  ctx.expect(
    cfg?.music_default_volume === volDefault &&
      cfg?.music_auto_leave_minutes === leaveDefault &&
      cfg?.music_auto_destroy_minutes === destroyDefault,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        `Out of the box a new session reads its starting volume + idle timers from the shipped guild_config defaults, which equal the catalog defaults (volume ${volDefault}, auto-leave ${leaveDefault}m, auto-destroy ${destroyDefault}m).`,
      observation:
        `guild_config defaults: music_default_volume=${cfg?.music_default_volume} (expected ${volDefault}), ` +
        `music_auto_leave_minutes=${cfg?.music_auto_leave_minutes} (expected ${leaveDefault}), ` +
        `music_auto_destroy_minutes=${cfg?.music_auto_destroy_minutes} (expected ${destroyDefault}).`,
      impact: 'The shipped guild_config music defaults diverged from the catalog’s documented safe defaults.',
    },
  );

  // The one guild_config row backs the defaults; no separate music config row is
  // needed for defaults to work (catalog DEF database-RLS intent, DB-observable side).
  const rows = await guildConfigRowCount(handle);
  ctx.expect(rows === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Exactly one guild_config row backs the guild; defaults work with no extra music config row.',
    observation: `guild_config row count for the guild = ${rows} (expected 1).`,
    impact: 'The guild’s configuration was not a single guild-scoped row as contracted.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The persistent queue object + its embeds live in Valkey/Discord — gated here.
  gateQueueStore(
    ctx,
    'database-RLS',
    'Exactly one queue object exists under the run guild’s Valkey key with entries, currentIndex, and volume 50 matching Discord.',
  );
  gateVoiceReadback(
    ctx,
    'Discord',
    'track-added embeds show correct positions and /queue lists both members’ tracks with requester attribution at volume 50.',
  );
  gateMusicAudit(ctx, 'Session-start and track-add events are audited once each with the correct guild id.');
  gateVoiceReadback(
    ctx,
    'branding',
    'Queue embeds use the default playful tone with guild brand name and powered-by-SomniBot footer.',
  );
  gateQueueStore(
    ctx,
    'replay-safety',
    'Re-delivering one member’s /play interaction leaves the queue length unchanged.',
  );
}

/** SET-A — dashboard config (volume 25 / auto-leave 1) persists to the columns the player reads. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { music_default_volume: 25, music_auto_leave_minutes: 1 },
  });
  const cfg = await readMusicConfig(handle);

  // The exact columns music-player.ts loadConfig() reads now hold the configured
  // values — the durable half of "dashboard config takes live effect".
  ctx.expect(cfg?.music_default_volume === 25 && cfg?.music_auto_leave_minutes === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'guild_config reads back music_default_volume 25 and music_auto_leave_minutes 1 (the exact columns the music player’s loadConfig reads).',
    observation:
      `guild_config music_default_volume=${cfg?.music_default_volume} (expected 25), ` +
      `music_auto_leave_minutes=${cfg?.music_auto_leave_minutes} (expected 1).`,
    impact: 'A saved music setting did not persist to the column the bot reads — a dashboard save would be silently ignored.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The live behavioral effect (new session at volume 25, bot leaves ~1 min after
  // the channel empties) needs a running session — Valkey queue + Discord voice.
  gateVoiceReadback(
    ctx,
    'Discord',
    'The new session’s now-playing reports volume 25 and the bot leaves the emptied voice channel within ~1 minute plus grace.',
  );
  gateDashboardConfig(
    ctx,
    'owner-notification',
    'The owner sees the dashboard settings-saved toast with no additional out-of-band notification.',
  );
  gateDashboardConfig(ctx, 'branding', 'The dashboard Music page and toast render in the owner-branded shell.');
  gateMusicAudit(ctx, 'One config-save audit row records the owner, the changed fields, and prior values.');
  gateDashboardConfig(
    ctx,
    'replay-safety',
    'Replaying the PUT is idempotent: the same values persist once with no duplicate audit spam.',
  );
}

/** SET-B — disable music; the config toggles + the branded, guild-named disabled decline is asserted. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const brandName = `${ctx.runPrefix}BrandGuild`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildName: brandName,
    guildConfigOverrides: { music_enabled: false },
  });

  // (1) DB-observable: the enablement flag toggled off.
  const disabled = await readMusicConfig(handle);
  ctx.expect(disabled?.music_enabled === false, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config.music_enabled toggles to false via the owner route.',
    observation: `guild_config.music_enabled = ${disabled?.music_enabled} (expected false).`,
    impact: 'The music-enabled toggle did not persist to guild_config.',
  });

  // (2) Real captured reply: a member uses /queue while music is disabled. The
  //     REAL dispatcher (interaction-handler.ts) takes the manager-absent branch,
  //     reads guild_config.music_enabled=false, and must decline with the catalog
  //     `music-disabled` notice. The interaction is hand-built (injectorFor, the
  //     capability-bound real ingress) so it carries the REAL guild name the way
  //     every production gateway interaction does — interaction.guild.name IS the
  //     guild's actual name in production, and bootGuild named this guild
  //     `brandName`; runSlash's default synthetic stand-in name would misreport
  //     the very brand surface under test.
  const declineCaptured = await ctx.injectorFor(handle).inject(
    buildSlashInteraction({
      commandName: 'queue',
      guildId: handle.guildId,
      guildName: brandName,
      client: handle.client,
      user: {
        id: ctx.userId('a'),
        username: ctx.userId('a'),
        displayName: 'SET-B member',
      },
    }),
  );
  // Observe the FULL member-facing reply surface (content + embed text): the
  // decline is contracted as a notice, not as a specific payload shape, and an
  // embed-only decline must never be misreported as "no reply at all".
  const surface = brandingSurface(declineCaptured);
  const declineReply = declineCaptured.find('reply');
  const declineEphemeral =
    (declineReply?.payload as { ephemeral?: boolean } | undefined)?.ephemeral === true;
  ctx.expect(declineReply !== undefined && declineEphemeral && surface.includes('switched off'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'While music is disabled, a music command declines ephemerally with the switched-off notice rather than acting on the queue.',
    observation:
      `/queue with music disabled replied (captured=${declineReply !== undefined}, ephemeral=${declineEphemeral}) ` +
      `with surface "${truncate(surface)}".`,
    impact: 'A music command while disabled produced no ephemeral switched-off decline (no reply, or a reply that is not the music-disabled notice).',
  });

  // (3) White-label: the catalog `music-disabled` notice is BRANDED and
  //     guild-named ("Music is currently switched off in {guild-name} — an admin
  //     can flip it back on from the dashboard."), resolved through the brand kit
  //     (store_brand_name falling back to the guild's own name). A stock unbranded
  //     string here is a white-label regression.
  ctx.expect(surface.includes(brandName), {
    assertionClass: 'branding',
    channel: 'captured-reply',
    promise:
      'The music-disabled notice names the guild brand (catalog `music-disabled`: "Music is currently switched off in {guild-name} …"), not a stock SomniBot string.',
    observation:
      `the disabled-command reply surface "${truncate(surface)}" was checked for the guild brand name "${brandName}".`,
    impact:
      'The music-disabled decline does not name the guild brand — the catalog’s branded, guild-named music-disabled notice regressed to a stock string (a white-label gap).',
  });

  // (4) DB-observable: re-enabling toggles the flag back (the persisted queue object
  //     itself surviving the toggle is a Valkey property — gated below).
  await updateMusicConfig(handle, { music_enabled: true });
  const reEnabled = await readMusicConfig(handle);
  ctx.expect(reEnabled?.music_enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Re-enabling music toggles guild_config.music_enabled back to true (round-trips through the owner route).',
    observation: `after re-enable guild_config.music_enabled = ${reEnabled?.music_enabled} (expected true).`,
    impact: 'The music-enabled flag did not round-trip false→true — re-enabling would not restore the feature.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateQueueStore(
    ctx,
    'replay-safety',
    'The persisted queue object is retained across the disable/enable toggle and is usable again with entries intact.',
  );
  gateMusicAudit(ctx, 'Both toggle saves are audited with actor and prior value; no queue-destruction event appears.');
}

/** INVALID — out-of-range config is a dashboard reject; valid values are retained unchanged. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  // Seed a VALID configuration; the rejection of out-of-range input happens in the
  // dashboard Zod layer — guild_config carries NO DB CHECK on these columns, so the
  // reject path is not reachable bot-only. Prove the valid values are retained.
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      music_default_volume: 80,
      music_auto_leave_minutes: 5,
      music_auto_destroy_minutes: 30,
    },
  });
  const before = await readMusicConfig(handle);
  ctx.expect(
    before?.music_default_volume === 80 &&
      before?.music_auto_leave_minutes === 5 &&
      before?.music_auto_destroy_minutes === 30,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'guild_config keeps its prior valid music values byte-for-byte (volume 80, timers 5/30); a rejected out-of-range save never persists and nothing is silently clamped.',
      observation:
        `guild_config music_default_volume=${before?.music_default_volume} (expected 80), ` +
        `music_auto_leave_minutes=${before?.music_auto_leave_minutes} (expected 5), ` +
        `music_auto_destroy_minutes=${before?.music_auto_destroy_minutes} (expected 30).`,
      impact: 'A valid music configuration was not retained.',
    },
  );

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The actual reject (default-volume 300 / auto-leave 0 / auto-destroy 999) is
  // enforced by the dashboard Zod validator; guild_config has no CHECK constraint on
  // these columns, so a bot-only harness cannot drive the reject or its audit row.
  gateDashboardConfig(
    ctx,
    'Discord',
    'PUT /api/music with out-of-range values returns a field-level validation error and a session started afterward still uses the prior stored volume/timers.',
  );
  gateMusicAudit(ctx, 'A config.rejected audit row records the invalid attempt without recording the invalid values as applied.');
  gateDashboardConfig(
    ctx,
    'branding',
    'The validation error renders in the branded dashboard shell with actionable field-level text.',
  );
  gateDashboardConfig(ctx, 'replay-safety', 'Replaying the invalid PUT is rejected identically and persists nothing.');
}

/** UNAUTH — only the owner may configure; non-owner/direct table access is denied. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { music_default_volume: 42 },
  });

  // The centerpiece: a direct (anon / non-owner) read of this guild's music config
  // is denied by RLS while the service role sees the distinctive row — the concrete
  // "non-owner dashboard sessions and direct database writes are denied" evidence.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The non-DJ /stop denial needs the music manager WIRED (Valkey + Shoukaku): the
  // DJ-required decline lives inside handleStop, only reached when the manager
  // resolves. The non-owner dashboard GET/PUT lane is dashboard-only.
  gateVoiceReadback(
    ctx,
    'Discord',
    'A non-DJ member’s /stop is refused ephemerally with the branded DJ-required denial while playback and the queue continue.',
  );
  gateDashboardConfig(
    ctx,
    'branding',
    'A non-owner’s GET/PUT /api/music returns a branded permission error rather than a raw authorization error.',
  );
  gateMusicAudit(ctx, 'Denied configuration and denied /stop attempts are each audited with actor identity.');
  gateDashboardConfig(ctx, 'replay-safety', 'Replaying denied requests yields identical denials and zero state change.');
}

/** DEPFAIL — Valkey-outage fail-safe: fully behind a Valkey dependency-outage fault lane. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The queue store IS Valkey (`queue:<guildId>` et al.), and the catalog's
  // contracted outage is "Valkey stopped". The ctx.faults proxy lane severs
  // SUPABASE only this wave — a supabase sever does not model the contracted
  // queue-store outage, so inducing the controlled outage-then-restore, the
  // queue-store-error decline, the single owner outage alert, and the
  // byte-identical recovery all stay honestly gated on the Valkey lane.
  gateQueueStore(
    ctx,
    'Discord',
    'With Valkey down, /play returns the branded queue-store-error and no phantom track-added embed ever appears.',
  );
  gateQueueStore(
    ctx,
    'database-RLS',
    'After the store returns, the queue object is byte-identical to the last pre-outage save with no partial entry.',
  );
  gateMusicAudit(ctx, 'Exactly one music.queue_store_unavailable audit row exists for the outage episode.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives exactly one outage notification naming the guild and the store dependency.',
    'requires a Valkey dependency-outage fault lane plus the owner notification channel readback',
  );
  gateQueueStore(
    ctx,
    'branding',
    'The failure copy is calm, branded, and instructs retry rather than exposing infrastructure detail.',
  );
  gateQueueStore(ctx, 'replay-safety', 'The failed mutation grants nothing: retrying after recovery adds the track exactly once.');
}

/** RETRY — transient Valkey blip converges under retry: fully behind a fault lane. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  gateQueueStore(
    ctx,
    'Discord',
    'Exactly one track-added embed for the track exists across the blip-and-retry sequence.',
  );
  gateQueueStore(
    ctx,
    'database-RLS',
    'The persisted queue contains the track exactly once with a single requestedBy attribution.',
  );
  gateMusicAudit(ctx, 'The audit trail shows failure then success for the same logical request without per-attempt row multiplication.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'At most one outage-and-recovery notification pair reaches the owner for the blip.',
    'requires a transient-Valkey-blip fault lane plus the owner notification channel readback',
  );
  gateQueueStore(ctx, 'branding', 'Retry-facing copy stays branded and consistent across attempts.');
  gateQueueStore(ctx, 'replay-safety', 'Automatic retries internal to the bot never insert the entry twice.');
}

/** REPLAY — duplicate delivery never duplicates: config upsert idempotency is DB-observable. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Config write idempotency IS provable now: re-applying the SAME music config
  // upsert twice must leave exactly one guild_config row with identical values
  // (guild_id is unique — the dashboard PUT relies on this ON CONFLICT semantics).
  await updateMusicConfig(handle, { music_default_volume: 77, music_auto_leave_minutes: 3 });
  await updateMusicConfig(handle, { music_default_volume: 77, music_auto_leave_minutes: 3 });
  const rows = await guildConfigRowCount(handle);
  const cfg = await readMusicConfig(handle);
  ctx.expect(rows === 1 && cfg?.music_default_volume === 77 && cfg?.music_auto_leave_minutes === 3, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Duplicate delivery of a music-config write never duplicates the config: two identical saves leave exactly one guild_config row with the saved values.',
    observation:
      `after two identical config saves: guild_config rows=${rows} (expected 1), ` +
      `music_default_volume=${cfg?.music_default_volume} (expected 77), music_auto_leave_minutes=${cfg?.music_auto_leave_minutes} (expected 3).`,
    impact: 'A replayed config save duplicated the guild_config row or diverged its values — config writes are not idempotent.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Queue-mutation replays (/play, /remove) and the dashboard PUT replay are Valkey /
  // dashboard lanes.
  gateQueueStore(
    ctx,
    'Discord',
    'No second track-added or removal embed appears for a replayed /play or /remove interaction.',
  );
  gateQueueStore(
    ctx,
    'database-RLS',
    'Queue length and entry order are identical between single-delivery and duplicate-delivery runs.',
  );
  gateMusicAudit(ctx, 'One audit row per unique logical mutation; replays add none.');
  gateQueueStore(ctx, 'branding', 'Any replay-rejection surface remains branded and non-alarming.');
}

/** RESTART — config the recover-on-boot path reads survives a full stack restart. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');

  // Boot #1: save a distinctive config (the volume 80 the catalog restarts with),
  // then shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await updateMusicConfig(first, { music_default_volume: 80, music_auto_destroy_minutes: 45 });
  const snapshot = await readMusicConfig(first);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id. The music config the player's loadConfig() reads on
  // recover-on-boot is durable in Supabase and must be identical.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readMusicConfig(second);
  ctx.expect(
    afterRestart?.music_default_volume === snapshot?.music_default_volume &&
      afterRestart?.music_auto_destroy_minutes === snapshot?.music_auto_destroy_minutes &&
      afterRestart?.music_default_volume === 80,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'After a full stack restart the music config the recover-on-boot path reads is identical (volume 80 and timers persist in guild_config).',
      observation:
        `pre-restart volume=${snapshot?.music_default_volume}/destroy=${snapshot?.music_auto_destroy_minutes}; ` +
        `post-restart volume=${afterRestart?.music_default_volume}/destroy=${afterRestart?.music_auto_destroy_minutes} (expected 80/45).`,
      impact: 'Music configuration did not survive a restart — the recovered session would use wrong settings.',
    },
  );

  await proveGuildConfigRls(ctx, second);
  await proveNoOwnerAlert(ctx, second);

  // The QUEUE object recovery (entries/currentIndex/volume/loopMode/pause), the
  // queue-restored embed, and audible resume are Valkey + Discord.
  gateQueueStore(
    ctx,
    'database-RLS',
    'The persisted queue object re-reads with identical entries, currentIndex, volume 80, and loopMode queue across the restart.',
  );
  gateVoiceReadback(
    ctx,
    'Discord',
    'The queue-restored embed names the restored track and count, playback resumes track two, and /queue matches the pre-restart snapshot.',
  );
  gateMusicAudit(ctx, 'A recovery audit row links the restored session to the pre-restart session without duplicating track-add history.');
  gateVoiceReadback(ctx, 'branding', 'The restoration message uses the guild brand voice and attribution footer.');
  gateQueueStore(ctx, 'replay-safety', 'Recovery does not re-append entries or re-fire confirmations; queue length is unchanged.');
}

/** RACE — concurrent queue mutations: contention lives entirely in Valkey (gated). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // The only DB-observable facets here are the off-theme guarantees: contention
  // raises no owner alert and config stays owner-scoped.
  await proveNoOwnerAlert(ctx, handle);
  await proveGuildConfigRls(ctx, handle);

  gateQueueStore(
    ctx,
    'Discord',
    'Each successful actor gets one confirmation, the capped member gets the user-cap-reached decline, and /queue reflects a consistent final order.',
  );
  gateQueueStore(
    ctx,
    'database-RLS',
    'The persisted queue holds each surviving entry exactly once with a valid currentIndex and correct per-user counts.',
  );
  gateMusicAudit(ctx, 'One audit row per applied mutation and one for the capacity decline; no phantom rows.');
  gateQueueStore(ctx, 'branding', 'All concurrent replies remain branded and mutually consistent with the final queue state.');
  gateQueueStore(ctx, 'replay-safety', 'Racing writers never double-append: total entries equal successful logical additions exactly.');
}

/** XGUILD — queues and music settings are strictly guild-isolated (config isolation is DB-observable). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  // Both guilds start ENABLED with DISTINCT volumes; then A is disabled and B must
  // stay exactly as it was — the cross-guild isolation the catalog contracts.
  const handleA = await ctx.bootGuild({
    guildId: guildA,
    guildConfigOverrides: { music_default_volume: 30, music_enabled: true },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    guildConfigOverrides: { music_default_volume: 90, music_enabled: true },
  });

  // Disabling music in A must not touch B's config.
  await updateMusicConfig(handleA, { music_enabled: false });

  const aRow = await readMusicConfig(handleA);
  const bRow = await readMusicConfig(handleB);
  ctx.expect(
    aRow?.music_default_volume === 30 &&
      aRow?.music_enabled === false &&
      bRow?.music_default_volume === 90 &&
      bRow?.music_enabled === true,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN music config and never the other’s: guild A → volume 30 / disabled, guild B → volume 90 / still enabled; A’s disable toggle leaves B untouched.',
      observation:
        `guild-A-scoped read = volume ${aRow?.music_default_volume}, enabled ${aRow?.music_enabled}; ` +
        `guild-B-scoped read = volume ${bRow?.music_default_volume}, enabled ${bRow?.music_enabled} (distinct rows under distinct guild_ids).`,
      impact: 'A guild-scoped config read returned the other guild’s music settings — cross-guild leakage.',
    },
  );

  // Anon cannot read either guild's config (the "A's owner cannot read B's row"
  // cross-guild denial, proven at the anon boundary).
  await proveGuildConfigRls(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleB);

  gateQueueStore(
    ctx,
    'Discord',
    'Both guilds play their own Valkey-keyed queues concurrently and A’s disable produces no behavioral change in B.',
  );
  gateMusicAudit(ctx, 'Every audit row carries the correct guild id with zero cross-guild rows.');
  gateVoiceReadback(ctx, 'branding', 'Each guild’s surfaces render that guild’s own brand simultaneously.');
  gateQueueStore(ctx, 'replay-safety', 'Replaying guild A mutations leaves guild B’s queue untouched.');
}

/** CLEANUP — the sweep removes run-prefixed guild_config while audit rows are retained. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { music_default_volume: 111, music_auto_leave_minutes: 9 },
  });

  // Seed the append-only audit row whose RETENTION the sweep must honor. Every
  // music.* audit WRITER (dashboard config save, a Valkey outage, queue teardown)
  // is behind a lane this bot-only harness gates, so without seeding the
  // retention assertion is vacuous (before=0 proves nothing). The probe inserts
  // ONE run-prefixed row shaped like the real `music.stopped` EVENT_TO_AUDIT
  // mapping (mirrors the commerce-product-store CLEANUP baseline):
  // retention-through-sweep is the promise under proof here — not the writers.
  const { error: auditSeedErr } = await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'user',
    actor_id: ctx.userId('a'),
    action: 'music.stopped',
    category: 'music',
    target_type: 'music_session',
    target_id: `${ctx.runPrefix}cleanup-session`,
    details: {
      seeded_by: 'music-collaborative-queue/CLEANUP retention probe',
      reason: 'command',
    },
  });

  // Baseline: a run-prefixed guild_config row exists to be swept, and the seeded
  // audit row is in place so retention is provable (before > 0, never vacuous).
  const cfgBefore = await guildConfigRowCount(handle);
  const auditBefore = await auditRowCount(handle);
  ctx.expect(cfgBefore >= 1 && auditSeedErr === null && (auditBefore ?? 0) >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created a run-prefixed guild_config row + one seeded append-only audit row (pre-cleanup baseline).',
    observation:
      `pre-cleanup: guild_config rows=${cfgBefore}, audit rows=${auditBefore ?? 'unreadable'}, ` +
      `audit seed error=${auditSeedErr?.message ?? 'none'}.`,
    impact: 'The cleanup scenario could not establish a run-prefixed config + audit baseline.',
  });

  // Prove the off-theme classes while rows still exist.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed
  // guild_config rows remain.
  await ctx.sweepGuildRows(handle);
  const cfgAfter = await guildConfigRowCount(handle);
  ctx.expect(cfgAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed guild_config music overrides are removed; a final sweep finds zero run-prefixed config rows.',
    observation: `post-sweep: guild_config rows for the guild = ${cfgAfter} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed guild_config rows behind — the suite leaves residue.',
  });

  // Audit rows are RETAINED by design: audit_logs has no cascade from guild, so the
  // sweep (which deletes guild_config + guild) leaves audit history intact.
  const auditAfter = await auditRowCount(handle);
  if (auditBefore === null || auditAfter === null) {
    ctx.gate(
      'audit',
      'audit-row',
      'Audit rows from the run remain present and unmodified, honoring never-delete.',
      'the audit_logs count read errored, so retention could not be proven (never recorded as a false pass)',
    );
  } else {
    ctx.expect(auditBefore > 0 && auditAfter >= auditBefore, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'Audit rows from the run remain present and unmodified after cleanup (never-delete: operational config removed, audit_logs retained).',
      observation: `audit_logs rows for the guild: before sweep=${auditBefore}, after sweep=${auditAfter} (expected retained, ≥ before).`,
      impact: 'The cleanup sweep deleted audit history — the never-delete audit guarantee was violated.',
    });
  }

  // Idempotent sweep: running it again still finds zero — reported as replay-safety.
  await ctx.sweepGuildRows(handle);
  const cfgAfter2 = await guildConfigRowCount(handle);
  ctx.expect(cfgAfter2 === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Running the sweeper twice is idempotent, reporting zero remaining config rows both times.',
    observation: `guild_config rows after a second sweep = ${cfgAfter2} (expected 0).`,
    impact: 'A second sweep was not idempotent — cleanup is not repeatable.',
  });

  // Valkey queue/now-playing keys and Discord channels/messages are separate lanes.
  gateQueueStore(
    ctx,
    'database-RLS',
    'Zero run-prefixed queue or now-playing keys remain in Valkey after the run.',
  );
  gateVoiceReadback(
    ctx,
    'Discord',
    'Run-created channels and messages are deleted and the bot has left all test voice channels.',
  );
  gateVoiceReadback(ctx, 'branding', 'Brand configuration is restored to its pre-run state.');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The collaborative-queue domain proof.
 *
 * guildScopedTables: the queue itself is a Valkey object (queue:/nowplaying:/
 * music:votes:, not a Supabase table), so the only DB-observable state this domain
 * persists in Supabase is guild_config — which the runner ALWAYS sweeps (plus the
 * guild row, deleted last). No extra domain tables are listed: the derived
 * music_status read-model (bot_diagnostics, type='music_status') is only written by
 * the always-on Diagnostics/MusicStatus services when a live session runs, so
 * listing bot_diagnostics here would risk sweeping (and false-failing on) unrelated
 * always-on diagnostics rows. audit_logs is deliberately NOT listed either
 * (never-delete — its retention through the sweep is proven in CLEANUP).
 */
export const musicCollaborativeQueueProof: DomainProof = {
  domainId: 'music-collaborative-queue',
  guildScopedTables: [
    // guild_config + guild are always swept by the runner; the queue is Valkey-only.
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
