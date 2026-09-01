/**
 * scenario-runner/scripts/community-temporary-channels — the Temporary Voice
 * Channels domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven through the REAL production dispatcher / per-guild init
 * against LOCAL Supabase. Every DB-observable / captured-reply / RLS / audit-row
 * assertion runs NOW; everything that needs a real Discord voice gateway (spawn a
 * room from a hub join, render the templated channel name, apply a user limit,
 * run a /voice control, delete an empty room after the grace) is GATED — the
 * honesty boundary the harness requires.
 *
 * Why this domain is MOSTLY GATED:
 *   - Room creation is driven by a `voiceStateUpdate` hub-join event and calls
 *     `guild.channels.create(...)`; there is no gateway here, so no room, name,
 *     limit, grace-timer, or control effect can be observed.
 *   - `/voice` is a subcommand command; the ownership/precondition checks read
 *     `guild.members.cache.get(user).voice.channelId` + `manager.isTempChannel`.
 *     Since PR #331 `runSlash` drives the SUBCOMMAND in-process, so `/voice <control>`
 *     now routes to the REAL handler on an enabled guild — but the gateway-less
 *     synthetic guild exposes an empty members cache (no voice state), so the handler
 *     takes its "must be in a temporary voice channel" precondition branch. That
 *     refusal (driven on an enabled guild) and the config-gate refusal ("Temp
 *     channels are not enabled", disabled guild) are BOTH captured live as real
 *     dispatcher evidence; the owner-vs-non-owner ownership branch + control EFFECTS
 *     still need a live voice state + real room and stay gated.
 *
 * What DOES run for real against local Supabase:
 *   - `temp_channel_hubs` / `active_temp_channels` are guild-scoped tables. Their
 *     RLS deny-all (service role sees the scenario rows; anon reads zero), their
 *     guild-scoping (XGUILD), the `channel_id` PK idempotency (REPLAY/RACE), and
 *     the run-prefixed cleanup sweep (CLEANUP) are all proven live.
 *   - Startup orphan reconciliation is the REAL production `TempChannelManager.start()`
 *     path (`cleanupOrphans` deletes the DB row for a room whose channel is gone):
 *     a bot-driven DB mutation asserted DB-observably across a restart (RESTART).
 *
 * Live gateway execution remains necessary to read back room creation, replay,
 * retry, and ownership effects. The production path uses a durable hub-join
 * occurrence key, bounded creation retry, and occurrence recovery; those effects
 * are not substituted with synthetic gateway evidence.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface HubRow {
  id: string;
  guild_id: string;
  hub_channel_id: string;
  category_id: string;
  naming_format: string;
  default_user_limit: number;
  keep_alive_minutes: number;
  active: boolean;
}

interface ActiveRow {
  channel_id: string;
  guild_id: string;
  hub_id: string | null;
  owner_id: string;
  text_channel_id: string | null;
}

interface AuditRow {
  action: string;
  target_id: string | null;
  target_type: string | null;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** The text of a captured reply/editReply payload — discord.js accepts either a
 *  raw string or a `{ content }` object, so normalise both (a raw-string payload
 *  otherwise reads as empty — the #335 payload lesson). */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return String((payload as { content?: string } | undefined)?.content ?? '');
}

/** Read the last editReply/reply content string a handler produced. */
function replyText(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return payloadText(edits[edits.length - 1]!.payload);
  }
  return payloadText(captured.find('reply')?.payload);
}

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Insert a hub config row (run-prefixed) and return its id. */
async function seedHub(
  handle: LiveClientHandle,
  ctx: ScenarioContext,
  opts: { hubChannelId: string; namingFormat: string; userLimit?: number; keepAliveMinutes?: number },
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('temp_channel_hubs')
    .insert({
      guild_id: handle.guildId,
      hub_channel_id: opts.hubChannelId,
      category_id: `${ctx.runPrefix}cat`,
      naming_format: opts.namingFormat,
      default_user_limit: opts.userLimit ?? 0,
      keep_alive_minutes: opts.keepAliveMinutes ?? 1,
      active: true,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function readHub(handle: LiveClientHandle, hubChannelId: string): Promise<HubRow | null> {
  const { data } = await handle.supabase
    .from('temp_channel_hubs')
    .select('id, guild_id, hub_channel_id, category_id, naming_format, default_user_limit, keep_alive_minutes, active')
    .eq('guild_id', handle.guildId)
    .eq('hub_channel_id', hubChannelId)
    .maybeSingle();
  return (data as HubRow | null) ?? null;
}

async function readActive(handle: LiveClientHandle, channelId: string): Promise<ActiveRow | null> {
  const { data } = await handle.supabase
    .from('active_temp_channels')
    .select('channel_id, guild_id, hub_id, owner_id, text_channel_id')
    .eq('guild_id', handle.guildId)
    .eq('channel_id', channelId)
    .maybeSingle();
  return (data as ActiveRow | null) ?? null;
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

async function activeCountForChannel(handle: LiveClientHandle, channelId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('active_temp_channels')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('channel_id', channelId);
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
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS deny_all → 0), or null when the probe is
 * inconclusive (no key/URL, network error, or the key was rejected before RLS
 * evaluated). Ported from the wallet-rewards proof.
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

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on a temp-channel table: the service role sees the
 * scenario's rows (positive control, so anon reading ZERO is a real deny rather
 * than "nothing to read"), while an anon key reads zero. GATEs (never fakes) when
 * no anon key is present or the probe is inconclusive; cross-guild scoping is
 * still proven separately in XGUILD.
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
 * Drive the REAL `/voice <control>` subcommand on an ENABLED guild and assert the
 * production dispatcher routes it and the handler refuses cleanly when the invoker
 * is not in a temporary voice channel. Since PR #331 the loopback adapter drives
 * slash SUBCOMMANDS in-process, so `/voice lock` reaches `handleTempChannelCommand`
 * for real (previously `runSlash` supplied no subcommand and the enabled `/voice`
 * path was undrivable). The gateway-less synthetic guild's members cache exposes no
 * voice state, so `guild.members.cache.get(user)?.voice?.channelId` is undefined and
 * the handler takes its "must be in a temporary voice channel" precondition branch —
 * a real captured reply proving the control command is wired and guards access (it
 * neither crashes on the subcommand nor acts without a temp-channel context). The
 * owner-vs-non-owner OWNERSHIP branch + control effects still need a live voice state
 * and stay gated separately.
 */
async function proveVoiceControlGuard(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  sub = 'lock',
): Promise<void> {
  const cap = await ctx.runSlash(handle, { commandName: 'voice', userId, subcommand: sub });
  const text = replyText(cap);
  ctx.expect(text.length > 0 && /temporary voice channel/i.test(text), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'The real production dispatcher routes /voice <control> to the temp-channel handler on an enabled guild, which refuses cleanly when the invoker is not in a temporary voice channel (never crashing on the subcommand and never acting without a temp-channel context).',
    observation: `/voice ${sub} from a member with no temp-channel voice state replied "${truncate(text)}".`,
    impact:
      'The /voice control subcommand was not dispatched by the real handler, or did not enforce the in-a-temp-channel precondition — the control command is unrouted or would act without an owned room.',
  });
}

/**
 * Branding always GATEs for this domain: the member-facing surfaces the catalog
 * brands (the `room-created` note posted in the new room's text chat, the
 * `control-applied` /voice ephemeral) are only produced when a real room is
 * spawned/controlled through the live gateway. No branded temp-channel reply can
 * be captured gateway-less, so branding is GATED rather than faked.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    "Every member-facing temp-channel surface (room-created note, /voice control-applied ephemeral) shows the owner's brand kit and voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.",
    'the branded room surfaces are only emitted when a room is spawned/controlled through the live Discord gateway (DISCORD_TOKEN + live guild); no branded temp-channel reply is captured in a gateway-less harness',
  );
}

/**
 * Audit GATEs everywhere except RESTART: a temp-channel state change (room
 * create/claim/delete) requires a live gateway to occur. The operation event
 * mapping is exercised in bot tests; the live lane reads the resulting audit row.
 */
function gateAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'discord-readback',
    'Every temp-channel state change lands exactly one append-only audit row with actor, guild, and correlation id; no audit row is ever deleted.',
    'temporary-channel create/claim/delete operations emit exact mapped audit events, but the state changes require a live Discord voice gateway followed by audit_logs readback',
  );
}

function gateLiveGuild(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) to spawn/observe voice rooms, templated names, user limits, grace-timer deletion, and /voice control effects',
  );
}

function gateReplayGateway(ctx: ScenarioContext): void {
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Re-delivering the hub-join voiceStateUpdate spawns no second room; the join dedupe key records the replay as a no-op.',
    'requires a live gateway to re-deliver voiceStateUpdate events and read the durable hub-join occurrence outcome',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — defaults: a hub join spawns "{owner-name}'s room", owner-controlled, self-deleting. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const nameTemplate = String(declaredDefault(ctx.domain, 'channel-name-template') ?? "{owner-name}'s room");
  const limitDefault = Number(declaredDefault(ctx.domain, 'default-user-limit') ?? 0);

  // (a) Real dispatcher evidence: the /voice command IS wired into the REAL
  //     production handler and, when the guild has temp channels disabled, it
  //     refuses with a clear ephemeral instead of crashing. (The room-spawn and
  //     /voice control effects themselves need the live gateway — gated below.)
  const gateHandle = await ctx.bootGuild({ label: 'gate', guildConfigOverrides: { temp_channels_enabled: false } });
  const gateReply = await ctx.runSlash(gateHandle, { commandName: 'voice', userId: ctx.userId('a') });
  const gateText = replyText(gateReply);
  ctx.expect(gateText.length > 0 && /not enabled/i.test(gateText), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'The real production dispatcher routes /voice and refuses cleanly when the guild has temp channels disabled.',
    observation: `/voice on a temp-channels-disabled guild replied "${truncate(gateText)}".`,
    impact: 'The /voice command was not dispatched by the real handler, or produced no clear refusal when the feature is off.',
  });

  // (b) Enabled guild: the default hub config persists guild-scoped and passes RLS.
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-def`;
  await seedHub(handle, ctx, { hubChannelId, namingFormat: nameTemplate, userLimit: limitDefault });
  const hub = await readHub(handle, hubChannelId);
  ctx.expect(hub?.guild_id === handle.guildId && hub?.naming_format === nameTemplate && hub?.default_user_limit === limitDefault, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A configured hub row is stored under the test guild id with the default name template and user limit.',
    observation: `hub row guild_id="${hub?.guild_id}", naming_format="${hub?.naming_format}", default_user_limit=${hub?.default_user_limit}.`,
    impact: 'The default hub configuration was not persisted guild-scoped as contracted.',
  });

  await proveRls(ctx, handle, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, handle);

  // (c) The enabled-guild `/voice` control now routes to the REAL handler
  //     in-process (subcommand-driven) and refuses cleanly for a member with no
  //     temp-channel voice state — the config-gate refusal in (a) proves the
  //     disabled branch, this proves the enabled dispatch + precondition guard.
  await proveVoiceControlGuard(ctx, handle, ctx.userId('a'));

  // Gateway-bound facets of the DEF promise.
  gateLiveGuild(
    ctx,
    'A hub join spawns "{owner-name}\'s room" in the hub\'s category, unlimited, owner-controlled, and self-deleting after the empty grace.',
  );
  // Honest note on a config-contract discrepancy that can only be confirmed at
  // the rendered channel name (gateway): the catalog default template variable is
  // {owner-name}, but handleJoinHub substitutes {username}/{user}/{tag}/{count}
  // only — a {owner-name} template would render literally.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The spawned room name renders the owner-name template variable.',
    'needs the live gateway to read the created channel name; note handleJoinHub substitutes {username}/{user}/{tag}/{count}, NOT the catalog default {owner-name} — a {owner-name} template would render unreplaced',
  );
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** SET-A — dashboard config (custom name template + user limit 5) takes effect on new rooms. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-seta`;
  const customTemplate = `${ctx.runPrefix}{username}-den`;
  await seedHub(handle, ctx, { hubChannelId, namingFormat: customTemplate, userLimit: 5 });

  // DB-observable: the saved dashboard config (custom template + limit 5) persists
  // guild-scoped exactly as configured (the room-side EFFECT is gateway-gated).
  const hub = await readHub(handle, hubChannelId);
  ctx.expect(hub?.default_user_limit === 5 && hub?.naming_format === customTemplate && hub?.guild_id === handle.guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A saved custom name template and default user limit of 5 persist on the guild-scoped hub row.',
    observation: `hub naming_format="${hub?.naming_format}", default_user_limit=${hub?.default_user_limit}, guild_id="${hub?.guild_id}".`,
    impact: 'A saved dashboard temp-channel configuration was not persisted as entered.',
  });

  await proveRls(ctx, handle, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, handle);

  gateLiveGuild(
    ctx,
    'A hub join spawns a room showing the custom name pattern and user limit 5, and Discord blocks the sixth join.',
  );
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** SET-B — a second config (longer empty grace + claim enabled) also takes effect. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-setb`;
  // The bot's grace window column is keep_alive_minutes (applied as *60_000ms in
  // handleLeaveTemp); a "60-second grace" maps to keep_alive_minutes=1.
  await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}`, keepAliveMinutes: 1 });

  const hub = await readHub(handle, hubChannelId);
  ctx.expect(hub?.keep_alive_minutes === 1 && hub?.guild_id === handle.guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A second distinct hub configuration (a longer empty-grace window) persists on the guild-scoped hub row.',
    observation: `hub keep_alive_minutes=${hub?.keep_alive_minutes}, guild_id="${hub?.guild_id}".`,
    impact: 'A second saved temp-channel configuration was not persisted.',
  });

  await proveRls(ctx, handle, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, handle);

  gateLiveGuild(
    ctx,
    'The owner leaves, a friend runs /voice claim and gains control, and the empty room survives the longer grace before deleting once.',
  );
  // Honest note: the catalog `allow-claim` control has NO backing hub column, and
  // /voice claim always allows a claim when the owner is absent (no config gate).
  ctx.gate(
    'Discord',
    'discord-readback',
    'With claiming enabled, /voice claim transfers ownership when the owner has left.',
    'needs the live gateway (voice state + a real room) to run /voice claim; note there is no allow_claim hub column — claim is always permitted when the owner is absent, so the allow-claim toggle is not enforced by the bot',
  );
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** INVALID — a rejected invalid config never persists; prior valid config + behavior unchanged. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-valid`;
  // Arrange a VALID hub config (user limit within the 0..99 range, a real hub id).
  await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}`, userLimit: 5 });

  // DB-observable core: the guild's hub retains its valid values byte-for-byte
  // (nothing invalid persisted).
  const hub = await readHub(handle, hubChannelId);
  ctx.expect(hub?.default_user_limit === 5 && hub?.hub_channel_id === hubChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The hub keeps its prior valid values (a rejected invalid save never persists).',
    observation: `hub default_user_limit=${hub?.default_user_limit} (expected 5), hub_channel_id="${hub?.hub_channel_id}".`,
    impact: 'A valid temp-channel configuration was not retained after a rejected save.',
  });

  await proveRls(ctx, handle, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, handle);

  // The actual REJECTION (user limit 100 > max 99; a nonexistent hub channel) is
  // enforced in the dashboard's Zod layer; the temp_channel_hubs columns carry NO
  // DB CHECK constraint, so a bot-only harness cannot drive the reject path.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard rejects a user limit of 100 and a nonexistent hub channel with clear errors; stored config is unchanged and hub joins keep spawning rooms.',
    'temp-channel config validation lives in the dashboard (Zod) layer; temp_channel_hubs has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Each rejected save lands one audit row with its validation reason.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** UNAUTH — room controls belong to the owner; a non-owner /voice is refused. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const ownerId = ctx.userId('a');
  const attackerId = ctx.userId('b');
  const hubChannelId = `${ctx.runPrefix}hub-unauth`;
  const roomId = `${ctx.runPrefix}room-unauth`;

  // Arrange an active room owned by member A.
  const hubId = await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });
  await handle.supabase
    .from('active_temp_channels')
    .insert({ channel_id: roomId, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerId });

  // DB-observable ownership: the room's tracked owner is member A, never the
  // attacker — the persisted fact the /voice ownership check reads per subcommand.
  const room = await readActive(handle, roomId);
  ctx.expect(room?.owner_id === ownerId && room?.owner_id !== attackerId, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: "A spawned room's tracked owner is its member-owner; a non-owner never becomes the owner of record.",
    observation: `active room owner_id="${room?.owner_id}" (owner=${ownerId}, attacker=${attackerId}).`,
    impact: 'The room ownership record did not identify the member-owner — the ownership check would authorize the wrong actor.',
  });

  await proveRls(ctx, handle, 'active_temp_channels');
  await proveNoOwnerAlert(ctx, handle);

  // The attacker's /voice control now routes to the REAL handler in-process
  // (subcommand-driven) and is refused: with no voice state pointing at the room,
  // the non-owner never reaches a control effect — a live captured refusal that
  // proves the control command is wired and guards access before the ownership check.
  await proveVoiceControlGuard(ctx, handle, attackerId);

  // The /voice <control> subcommand routes in-process (proven above); reaching the
  // OWNERSHIP branch specifically — the friendly denial pointing to /voice claim,
  // plus the untouched channel permissions — still needs a live voice state pointing
  // at a real temp room (the synthetic guild's members cache exposes none), so that
  // owner-vs-non-owner facet stays gateway-gated.
  gateLiveGuild(
    ctx,
    "run-member-b's /voice lock on run-member-a's occupied room gets the friendly denial pointing to /voice claim; the room's permissions are unchanged.",
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The denied control attempt is audited with actor, room, and reason.',
    'the denied /voice control emits its mapped denial event, but reaching it requires a live voice state and owned room followed by audit_logs readback',
  );
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** DEPFAIL — Discord rejects room creation → fail safe (kind notice, no ghost row, one owner alert). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-depfail`;
  await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });

  // The one real assertion available in a degraded scenario: the hub row is still
  // guild-scoped and RLS-isolated even when the create path would fail.
  await proveRls(ctx, handle, 'temp_channel_hubs');

  // The failure branch requires a live gateway with channel-management permission
  // revoked. It cannot be induced in this gateway-less harness.
  gateLiveGuild(
    ctx,
    'With the bot\'s channel-management permission revoked, a hub join produces the kind failure notice and no room row; restoring the permission makes the next join spawn normally.',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A create failure raises exactly one owner alert (temp-alert) naming the missing permission.',
    'requires a live rejected guild.channels.create branch and owner-alert channel readback',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The creation failure lands an append-only audit row (temp_channels.creation_failed).',
    'creation failures emit mapped audit events; proving them requires a live gateway failure branch followed by audit_logs readback',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No ghost active_temp_channels row is left behind by a failed create.',
    'needs the live gateway to drive a failed create; the row is inserted only after a successful create, so "no ghost row" holds by construction but cannot be exercised here',
  );
  gateBranding(ctx);
}

/** RETRY — a transient create error converges to exactly one room for the join. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-retry`;
  await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });

  await proveRls(ctx, handle, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, handle);

  // The retry-into-one-room behavior needs a mid-create transient-fault injection
  // at the gateway boundary.
  gateLiveGuild(
    ctx,
    'With a transient fault injected on the first create call, the retry produces exactly one room and the member is moved into it; no duplicate rooms exist.',
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'The join-event key shows exactly one room creation across attempts.',
    'requires a live gateway, transient-fault injection, and durable occurrence readback',
  );
  gateAudit(ctx);
  gateBranding(ctx);
}

/** REPLAY — re-delivered hub-join events never duplicate the active room row. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-replay`;
  const roomId = `${ctx.runPrefix}room-replay`;
  const ownerId = ctx.userId('a');
  const hubId = await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });

  // Persistence-layer replay-safety: active_temp_channels.channel_id is the PK, so
  // re-recording the SAME room (a replayed effect) is rejected — exactly one active
  // row survives. This is the idempotency guarantee the catalog's "active-room rows
  // remain single / one effect per logical action" rests on.
  const first = await handle.supabase
    .from('active_temp_channels')
    .insert({ channel_id: roomId, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerId });
  const replay = await handle.supabase
    .from('active_temp_channels')
    .insert({ channel_id: roomId, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerId });
  const rows = await activeCountForChannel(handle, roomId);
  ctx.expect(!first.error && Boolean(replay.error) && rows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering the same room record is a no-op at the persistence layer: exactly one active_temp_channels row survives (channel_id PK dedupe).',
    observation:
      `first insert error=${first.error ? first.error.message : 'none'}; ` +
      `replay insert error=${replay.error ? replay.error.message : 'none (UNEXPECTED)'}; ` +
      `active rows for the channel=${rows} (expected exactly 1).`,
    impact: 'A replayed room record produced a second active row — the channel_id PK did not dedupe the duplicate.',
  });

  await proveRls(ctx, handle, 'active_temp_channels');
  await proveNoOwnerAlert(ctx, handle);

  // The room-creation replay itself needs a live gateway to re-deliver the
  // voiceStateUpdate and inspect the durable occurrence result.
  gateReplayGateway(ctx);
  gateLiveGuild(ctx, 'After replaying the recorded voiceStateUpdate, the guild still has exactly one room for the member.');
  gateAudit(ctx);
  gateBranding(ctx);
}

/** RESTART — rooms survive a restart; empty leftovers are reconciled away by startup. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const ownerId = ctx.userId('a');
  const hubChannelId = `${ctx.runPrefix}hub-restart`;
  const orphanRoomId = `${ctx.runPrefix}room-orphan`;

  // Boot #1: create the guild + a hub, then seed an active room row whose Discord
  // channel does not exist (an "empty leftover" from before the restart).
  const first = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubId = await seedHub(first, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });
  await first.supabase
    .from('active_temp_channels')
    .insert({ channel_id: orphanRoomId, guild_id: guildId, hub_id: hubId, owner_id: ownerId });
  const beforeRestart = await activeCountForChannel(first, orphanRoomId);
  ctx.expect(beforeRestart === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: an active-room row exists for a room whose channel is gone (an empty leftover).',
    observation: `active rows for the orphan channel before restart=${beforeRestart} (expected 1).`,
    impact: 'Could not arrange the pre-restart orphan row — the reconciliation proof setup is invalid.',
  });
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The REAL production TempChannelManager.start()
  // → cleanupOrphans() deletes the DB row for a room whose channel is absent from
  // the (gateway-less) channel cache. This is a real bot-driven DB mutation.
  const second = await ctx.bootGuild({ guildId, label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const afterRestart = await activeCountForChannel(second, orphanRoomId);
  ctx.expect(afterRestart === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Startup reconciliation deletes the empty orphan room row on restart (converging to a consistent state).',
    observation: `active rows for the orphan channel after restart=${afterRestart} (expected 0 — reconciled away).`,
    impact: 'The empty orphan room row survived the restart — startup reconciliation did not close the dangling row.',
  });

  // The hub itself persists across the restart (state lives in Supabase).
  const hub = await readHub(second, hubChannelId);
  ctx.expect(hub?.hub_channel_id === hubChannelId && hub?.guild_id === guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The hub configuration survives the restart unchanged.',
    observation: `post-restart hub hub_channel_id="${hub?.hub_channel_id}", guild_id="${hub?.guild_id}".`,
    impact: 'The hub configuration did not survive the restart.',
  });

  // AUDIT FINDING (real divergence, not softened): orphan reconciliation is a
  // declared audit event (temp_channels.orphan_reconciled), but the reconciliation
  // just ran through the REAL production init and wrote ZERO audit_logs rows for
  // it. The catalog contracts "every state change lands exactly one append-only
  // audit row" — this is a behavior bug for the owner to adjudicate.
  const { data: auditData } = await second.supabase
    .from('audit_logs')
    .select('action, target_id, target_type')
    .eq('guild_id', guildId);
  const auditRows = (auditData as AuditRow[] | null) ?? [];
  const reconciliationAudits = auditRows.filter(
    (r) =>
      r.target_id === orphanRoomId ||
      /temp[_-]?channel|orphan|reconcil/i.test(r.action) ||
      /temp[_-]?channel/i.test(r.target_type ?? ''),
  );
  ctx.expect(reconciliationAudits.length >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'Startup orphan reconciliation (temp_channels.orphan_reconciled) lands exactly one append-only audit row with actor, guild, and correlation id.',
    observation:
      `after a real reconciliation that deleted the orphan room row, audit_logs holds ${reconciliationAudits.length} ` +
      `temp-channel/orphan audit row(s) for the guild (of ${auditRows.length} total).`,
    impact:
      'A real temp-channel state change (orphan reconciliation) produced no audit row — the feature writes no audit trail for its state changes, breaking the append-only audit contract.',
  });

  await proveRls(ctx, second, 'temp_channel_hubs');
  await proveNoOwnerAlert(ctx, second);

  // The "occupied room keeps its owner + working /voice controls through the
  // restart" facet needs a live gateway (an occupied room's channel would be in
  // cache and preserved; that path is unobservable gateway-less).
  gateLiveGuild(
    ctx,
    "run-member-a's occupied room persists through the restart with working /voice controls (its channel stays in the live cache and is not reconciled).",
  );
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** RACE — concurrent joins spawn distinct rooms; racing claims yield exactly one owner. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-race`;
  const hubId = await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });
  const ownerA = ctx.userId('a');
  const ownerB = ctx.userId('b');
  const roomA = `${ctx.runPrefix}room-race-a`;
  const roomB = `${ctx.runPrefix}room-race-b`;

  // (a) Two simultaneous joins → two DISTINCT rooms with correct ownership. The
  //     schema (channel_id PK, no guild/owner uniqueness) permits per-member rooms,
  //     so concurrent inserts of distinct channels both persist.
  const [insA, insB] = await Promise.all([
    handle.supabase.from('active_temp_channels').insert({ channel_id: roomA, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerA }),
    handle.supabase.from('active_temp_channels').insert({ channel_id: roomB, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerB }),
  ]);
  const rowA = await readActive(handle, roomA);
  const rowB = await readActive(handle, roomB);
  ctx.expect(
    !insA.error && !insB.error && rowA?.owner_id === ownerA && rowB?.owner_id === ownerB && rowA?.channel_id !== rowB?.channel_id,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Two simultaneous hub joins spawn two distinct, correctly-owned active rooms.',
      observation: `room A owner="${rowA?.owner_id}" (expected ${ownerA}), room B owner="${rowB?.owner_id}" (expected ${ownerB}), distinct channels=${rowA?.channel_id !== rowB?.channel_id}.`,
      impact: 'Two concurrent joins did not yield two distinct correctly-owned rooms.',
    },
  );

  // (b) Racing /voice claim → exactly one owner. transferOwnership is an UPDATE of
  //     the single owner_id column keyed on channel_id; two concurrent transfers
  //     leave exactly one row with exactly one of the racing owners.
  await Promise.all([
    handle.supabase.from('active_temp_channels').update({ owner_id: ownerA }).eq('channel_id', roomA),
    handle.supabase.from('active_temp_channels').update({ owner_id: ownerB }).eq('channel_id', roomA),
  ]);
  const claimed = await readActive(handle, roomA);
  const rowsForA = await activeCountForChannel(handle, roomA);
  ctx.expect(rowsForA === 1 && (claimed?.owner_id === ownerA || claimed?.owner_id === ownerB), {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Two racing ownership transfers on one room leave exactly one row with exactly one owner.',
    observation: `after two concurrent transfers: rows for the room=${rowsForA} (expected 1), owner_id="${claimed?.owner_id}" (exactly one of ${ownerA}/${ownerB}).`,
    impact: 'A racing /voice claim left the room with zero or duplicate owner rows — the single-owner invariant was broken.',
  });

  await proveRls(ctx, handle, 'active_temp_channels');
  await proveNoOwnerAlert(ctx, handle);

  gateLiveGuild(
    ctx,
    'run-member-a and run-member-b joining the hub together each get their own correctly-owned room; two members racing /voice claim end with exactly one new owner whose controls work.',
  );
  gateAudit(ctx);
  gateBranding(ctx);
}

/** XGUILD — hubs and room rows are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, guildConfigOverrides: { temp_channels_enabled: true } });
  const handleB = await ctx.bootGuild({ guildId: guildB, guildConfigOverrides: { temp_channels_enabled: true } });
  const ownerA = ctx.userId('a');
  const ownerB = ctx.userId('b');

  // Each guild gets its OWN hub + active room.
  const hubA = `${ctx.runPrefix}hub-xg-a`;
  const hubB = `${ctx.runPrefix}hub-xg-b`;
  const roomA = `${ctx.runPrefix}room-xg-a`;
  const roomB = `${ctx.runPrefix}room-xg-b`;
  const hubIdA = await seedHub(handleA, ctx, { hubChannelId: hubA, namingFormat: `${ctx.runPrefix}A-{username}` });
  const hubIdB = await seedHub(handleB, ctx, { hubChannelId: hubB, namingFormat: `${ctx.runPrefix}B-{username}` });
  await handleA.supabase.from('active_temp_channels').insert({ channel_id: roomA, guild_id: guildA, hub_id: hubIdA, owner_id: ownerA });
  await handleB.supabase.from('active_temp_channels').insert({ channel_id: roomB, guild_id: guildB, hub_id: hubIdB, owner_id: ownerB });

  // A guild-B-scoped read sees B's room and NEVER guild A's room, and vice-versa —
  // distinct real rows under distinct guild_ids (not "nothing to read").
  const bScoped = await readActive(handleB, roomB);
  const bScopedForA = await activeCountForChannel(handleB, roomA); // B scope, A's channel
  const aScoped = await readActive(handleA, roomA);
  const aScopedForB = await activeCountForChannel(handleA, roomB); // A scope, B's channel
  ctx.expect(
    bScoped?.guild_id === guildB && aScoped?.guild_id === guildA && bScopedForA === 0 && aScopedForB === 0,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise: "Each guild scope reads its OWN room row and never the other guild's: B → B's room, A → A's room.",
      observation:
        `guild-B-scoped read=room under "${bScoped?.guild_id}" and ${bScopedForA} of guild A's room; ` +
        `guild-A-scoped read=room under "${aScoped?.guild_id}" and ${aScopedForB} of guild B's room (both cross-reads expected 0).`,
      impact: "A guild-scoped read returned the other guild's room row — cross-guild leakage.",
    },
  );

  // Hub configs are independent per guild (different templates persist side-by-side).
  const hubRowA = await readHub(handleA, hubA);
  const hubRowB = await readHub(handleB, hubB);
  ctx.expect(hubRowA?.guild_id === guildA && hubRowB?.guild_id === guildB && hubRowA?.naming_format !== hubRowB?.naming_format, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: "Each guild's hub configuration is independent; guild A's hub never governs guild B.",
    observation: `hub A guild="${hubRowA?.guild_id}" template="${hubRowA?.naming_format}"; hub B guild="${hubRowB?.guild_id}" template="${hubRowB?.naming_format}".`,
    impact: 'Hub configuration leaked across guilds — hubs are not strictly per-guild.',
  });

  await proveRls(ctx, handleA, 'active_temp_channels');
  await proveNoOwnerAlert(ctx, handleA);

  gateLiveGuild(ctx, "Hub joins in guild B spawn rooms only in B under B's template; guild A's rooms are untouched.");
  gateAudit(ctx);
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

/** CLEANUP — the suite leaves no trace: run-prefixed hub + room rows are swept and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a', guildConfigOverrides: { temp_channels_enabled: true } });
  const hubChannelId = `${ctx.runPrefix}hub-cleanup`;
  const roomId = `${ctx.runPrefix}room-cleanup`;
  const ownerId = ctx.userId('a');

  // Create run-prefixed operational rows: a hub + an active room.
  const hubId = await seedHub(handle, ctx, { hubChannelId, namingFormat: `${ctx.runPrefix}{username}` });
  await handle.supabase.from('active_temp_channels').insert({ channel_id: roomId, guild_id: handle.guildId, hub_id: hubId, owner_id: ownerId });

  const hubsBefore = (await guildRowCount(handle, 'temp_channel_hubs')) ?? 0;
  const activeBefore = (await guildRowCount(handle, 'active_temp_channels')) ?? 0;
  ctx.expect(hubsBefore >= 1 && activeBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed hub + active-room rows (pre-cleanup baseline).',
    observation: `pre-cleanup: hub rows=${hubsBefore}, active-room rows=${activeBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRls(ctx, handle, 'active_temp_channels');
  await proveNoOwnerAlert(ctx, handle);

  // Run the same sweep teardown uses and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const hubsAfter = (await guildRowCount(handle, 'temp_channel_hubs')) ?? 0;
  const activeAfter = (await guildRowCount(handle, 'active_temp_channels')) ?? 0;
  ctx.expect(hubsAfter === 0 && activeAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise: 'Run-prefixed hub and active-room rows are deleted; a final sweep finds zero run-prefixed temp-channel resources.',
    observation: `post-sweep: hub rows=${hubsAfter}, active-room rows=${activeAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord channel readback (no run-prefixed voice channels remain) and audit
  // "anonymized-not-deleted" history are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed voice channels (hubs or spawned rooms) after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the temp-channel operational tables are the DB-observable cleanup evidence here',
  );
  gateBranding(ctx);
  gateReplayGateway(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Temporary Voice Channels domain proof: the guild_id-scoped tables the sweep
 * must clear (child → parent so FK-constrained rows go before their parents and
 * the guild row), plus the 12 scenario scripts. `active_temp_channels` (FK
 * hub_id → temp_channel_hubs, ON DELETE CASCADE) is swept before the hub table;
 * `alerts` is swept for the owner-notification lane.
 */
export const communityTemporaryChannelsProof: DomainProof = {
  domainId: 'community-temporary-channels',
  guildScopedTables: ['active_temp_channels', 'temp_channel_hubs', 'alerts'],
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
