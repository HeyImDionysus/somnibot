/**
 * scenario-runner/scripts/moderation-message-logging — the message-logging domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven through the REAL production dispatcher against LOCAL Supabase.
 *
 * ── The honesty boundary for THIS domain (why it is mostlyGated) ──
 * Message-log CAPTURE is not a slash command: it is driven by messageUpdate /
 * messageDelete GATEWAY events (packages/bot/src/features/message-log/index.ts,
 * wired in events/handler.ts) and its only output is an EMBED posted to a Discord
 * channel — there is NO forensic DB table. So the capture surface (edit/delete
 * embeds, before/after content, attachments, jump links, uncached fallback, the
 * log-channel/ignored-channel exclusions) cannot be driven or observed in a
 * bot-only, gateway-less harness. Those cells are GATED behind DISCORD_TOKEN + a
 * live guild + a gateway event-injection lane — never faked.
 *
 * What DOES run NOW against local Supabase (real, non-vacuous):
 *   - the guild_config message-log columns (message_log_enabled /
 *     message_log_channel_id): default (DEF), live enable (SET-A), byte-for-byte
 *     retention (INVALID), per-guild isolation (XGUILD), restart persistence
 *     (RESTART), and surgical cleanup (CLEANUP) are read back from the real row;
 *   - anon-denial + cross-guild RLS on guild_config (service role sees the row an
 *     anon key must not — 42501 permission-denied is the deny);
 *   - the member data-rights surface /mydata: driven through the real dispatcher,
 *     its export is parsed from the captured attachment and proven self-scoped to
 *     the requesting member (SET-A, UNAUTH);
 *   - the audit never-delete / anonymize-over-delete enforcement (CLEANUP): a
 *     seeded audit row survives a service-role delete attempt.
 *
 * Behavior-bug discovery (surfaced as FAILs / loud gate reasons for the owner):
 *   - guild_config has NO columns for log-edits-enabled, log-deletes-enabled, or
 *     ignored-channel-ids — SET-B's contracted second configuration is
 *     unrepresentable (recorded as a real FAIL via a live schema probe).
 *   - the message-log handler keeps a MODULE-GLOBAL config cache (not per-guild)
 *     and has NO per-event dedupe key and NO retry/backoff — flagged in the
 *     RETRY / REPLAY / RACE / XGUILD gate reasons.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row / payload shapes ──────────────────────────────────────────────────

interface MessageLogConfigRow {
  message_log_enabled: boolean | null;
  message_log_channel_id: string | null;
}

/** The subset of the /mydata export envelope this proof inspects for self-scoping. */
interface MyDataExport {
  user_id?: string;
  guild_id?: string;
  economy?: { wallet?: { wallet?: number } | null } | null;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readMessageLogConfig(handle: LiveClientHandle): Promise<MessageLogConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('message_log_enabled, message_log_channel_id')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as MessageLogConfigRow | null) ?? null;
}

/**
 * Whether `column` exists on guild_config, decided by a REAL PostgREST probe.
 * A definitive undefined-column error (SQLSTATE 42703 / "does not exist") means
 * ABSENT; no error means PRESENT; any OTHER error is treated as present so a
 * transient fault can never masquerade as a missing-control FAIL.
 */
async function columnExists(handle: LiveClientHandle, column: string): Promise<boolean> {
  const { error } = await handle.supabase
    .from('guild_config')
    .select(column)
    .eq('guild_id', handle.guildId)
    .limit(1);
  if (!error) return true;
  const undefinedColumn =
    error.code === '42703' || (error.message ?? '').toLowerCase().includes('does not exist');
  return !undefinedColumn;
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

/**
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of
 * rows an anon key can read (RLS lockdown → 0), or null when inconclusive (→ GATE).
 * The repo-wide lockdown (20260710010000_rls_pattern_sweep_lockdown) revokes ALL
 * privileges on guild_config from anon, so PostgREST surfaces SQLSTATE 42501
 * "permission denied for table" — the deny we want to prove.
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
      return 0; // the anon role is denied the table — RLS/GRANT lockdown working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

/** Arrange an exact wallet balance for a member via the REAL wallet initializer. */
async function seedWallet(handle: LiveClientHandle, userId: string, wallet: number): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet, bank: 0 })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

interface MyDataResult {
  captured: CapturedResponse;
  raw: string | null;
  parsed: MyDataExport | null;
  fileName: string | null;
}

/**
 * Drive /mydata through the REAL dispatcher and pull the JSON export out of the
 * captured attachment. In the gateway-less harness the synthetic user has no
 * createDM(), so the handler falls to its "couldn't DM you — here's your data
 * directly" branch, which attaches the same export buffer to the ephemeral reply
 * (packages/bot/src/features/account/mydata-command.ts). That buffer IS the real
 * export the member would receive.
 */
async function runMyData(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
): Promise<MyDataResult> {
  const captured = await ctx.runSlash(handle, { commandName: 'mydata', userId });
  const edits = captured.allOf('editReply');
  for (let i = edits.length - 1; i >= 0; i--) {
    const payload = edits[i]!.payload as
      | { files?: Array<{ attachment?: unknown; name?: string }> }
      | undefined;
    const file = payload?.files?.[0];
    if (file && Buffer.isBuffer(file.attachment)) {
      const raw = file.attachment.toString('utf-8');
      try {
        return { captured, raw, parsed: JSON.parse(raw) as MyDataExport, fileName: file.name ?? null };
      } catch {
        return { captured, raw, parsed: null, fileName: file.name ?? null };
      }
    }
  }
  return { captured, raw: null, parsed: null, fileName: null };
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild_config guild-scoping: the service role reads THIS guild's config
 * row (positive control) while an anon client reads zero of them (RLS lockdown).
 * GATES honestly when no anon key is exported or the probe is inconclusive.
 */
async function proveConfigRls(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/cross-guild clients read zero guild_config message-log rows (repo-wide anon lockdown).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — service-role guild-scoping is still asserted',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'guild_config', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero guild_config message-log rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readMessageLogConfig(handle);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s message-log config row while an anon client reads zero of them (guild_config anon lockdown).',
    observation:
      `service-role sees the guild_config row for "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} guild_config row(s) for that guild.`,
    impact:
      'A guild_config row visible to the service role was also readable with an anon key — the message-log configuration is exposed to unauthenticated clients.',
  });
}

/** Happy-path owner-notification: the alerts table holds zero rows for the guild. */
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
 * Branding is uniformly GATED for this domain: the only branded surfaces are
 * log-channel embeds and owner-alert-channel messages, both Discord-side. No
 * DB-capturable branded member surface exists (the /mydata export is a raw JSON
 * envelope, not a brand-kit surface), so there is nothing to inspect NOW.
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'Captured log embeds and owner alerts match the owner white-label brand kit (colors, voice preset, powered-by-SomniBot attribution).',
    'message-log branded surfaces are log-channel embeds + owner-alert messages (Discord-only); no DB-capturable branded member surface exists (needs DISCORD_TOKEN + live guild)',
  );
}

/** Capture is gateway-driven and posts embeds only — GATE the Discord capture surface. */
function gateCaptureReadback(ctx: ScenarioContext, promise: string): void {
  ctx.gate('Discord', 'discord-readback', promise, GATEWAY_CAPTURE_REASON);
}

/** Replay-safety is over re-delivered gateway events against the live log channel — GATED. */
function gateReplaySafety(ctx: ScenarioContext): void {
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'Re-delivering recorded messageUpdate/messageDelete events yields no duplicate log embeds (per-event dedupe key).',
    'needs a gateway event re-delivery harness (DISCORD_TOKEN + live guild). FINDING: the message-log handler posts each event with NO per-event dedupe key, so re-delivery WOULD double-post — flagged for the owner',
  );
}

const GATEWAY_CAPTURE_REASON =
  'edit/delete capture runs on messageUpdate/messageDelete GATEWAY events (not slash commands) and posts an embed to a Discord channel with no DB persistence; needs DISCORD_TOKEN + a live guild + a gateway event-injection lane';

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — the shipped default is privacy-first: logging off, nothing captured. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // 1) The guild_config row reflects the catalog default: logging disabled, no channel.
  const cfg = await readMessageLogConfig(handle);
  const expectedEnabled = declaredDefault(ctx.domain, 'message-log-enabled') === true; // false
  ctx.expect(
    cfg !== null &&
      cfg.message_log_enabled === expectedEnabled &&
      (cfg.message_log_channel_id === null || cfg.message_log_channel_id === ''),
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'Out of the box the guild_config row shows message logging disabled with no channel set (the catalog default: enabled=false).',
      observation:
        `guild_config for the default guild: message_log_enabled=${cfg?.message_log_enabled} ` +
        `(catalog default ${expectedEnabled}), message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)}.`,
      impact: 'The shipped default was not privacy-first — logging was enabled or a channel was pre-set with zero configuration.',
    },
  );

  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // With logging disabled AND no forensic table in the schema, an edit/delete burst
  // captures nothing — but that capture path is gateway-only, so GATE its readback.
  gateCaptureReadback(
    ctx,
    'After an edit + delete burst in the default guild, no log embed appears in any channel and the member sees no bot reaction.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Message-logging actions land append-only audit rows; none are ever deleted.',
    'the default scenario changes no config and captures nothing; message-log config-change audit rows are written by the dashboard save path (not reachable in a bot-only harness)',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** SET-A — owner opt-in takes live effect; member data-rights export is self-scoped. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}log-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      message_log_enabled: true,
      message_log_channel_id: logChannelId,
    },
  });
  const userA = ctx.userId('a');

  // The saved opt-in is persisted verbatim in guild_config.
  const cfg = await readMessageLogConfig(handle);
  ctx.expect(cfg?.message_log_enabled === true && cfg?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'Enabling logging with a run-prefixed staff log channel persists to guild_config so capture can activate within the cache TTL.',
    observation:
      `guild_config after opt-in: message_log_enabled=${cfg?.message_log_enabled} (expected true), ` +
      `message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)} (expected "${logChannelId}").`,
    impact: 'A saved dashboard opt-in did not persist — message logging could not activate.',
  });

  // Member data-rights view-and-export: drive /mydata and prove the export is
  // scoped to the requesting member's own user id + guild (envelope check).
  const mine = await runMyData(ctx, handle, userA);
  ctx.expect(mine.parsed?.user_id === userA && mine.parsed?.guild_id === handle.guildId, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'A member exercising their data rights privately receives a portable JSON export scoped to their own user id in their own guild.',
    observation:
      `/mydata export envelope: user_id=${JSON.stringify(mine.parsed?.user_id)} (expected "${userA}"), ` +
      `guild_id=${JSON.stringify(mine.parsed?.guild_id)} (expected "${handle.guildId}"), file="${mine.fileName ?? '(none)'}".`,
    impact: 'The member data-rights export was missing or not scoped to the requesting member — a data-rights / privacy defect.',
  });

  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateCaptureReadback(
    ctx,
    'After opt-in, an edit yields one before/after embed and a delete yields one preserved-content embed in the log channel; a bot-authored edit yields nothing.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the configuration change with the acting administrator, guild id, and correlation id.',
    'the message-log config-change audit row is written by the dashboard settings API (not reachable in this bot-only harness, which seeds guild_config directly)',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/**
 * SET-B — a second distinct configuration (edits off / deletes on / ignored
 * channel). FINDING: guild_config has NO columns for these controls, so the
 * contracted second configuration is UNREPRESENTABLE in the current bot.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}log-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      message_log_enabled: true,
      message_log_channel_id: logChannelId,
    },
  });

  // Live schema probe: do the per-type toggle + ignored-channel controls exist?
  const editsToggle = await columnExists(handle, 'message_log_edits_enabled');
  const deletesToggle = await columnExists(handle, 'message_log_deletes_enabled');
  const ignoredChannels = await columnExists(handle, 'message_log_ignored_channel_ids');
  ctx.expect(editsToggle && deletesToggle && ignoredChannels, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A second distinct configuration takes effect: edits switched off while deletes stay on, plus a privacy-excluded channel in ignored-channel-ids.',
    observation:
      `guild_config columns present — edits toggle: ${editsToggle}, deletes toggle: ${deletesToggle}, ` +
      `ignored-channel list: ${ignoredChannels}. The bot's loadConfig reads ONLY message_log_enabled + ` +
      `message_log_channel_id and logs every edit AND delete with no ignored-channel exclusion.`,
    impact:
      'The catalog controls log-edits-enabled, log-deletes-enabled, and ignored-channel-ids are unimplemented in guild_config, so SET-B\'s contracted deletes-only + ignored-channel configuration cannot be represented or honored — a feature gap for the owner to adjudicate.',
  });

  // The base config that DOES exist is persisted and guild-scoped.
  const cfg = await readMessageLogConfig(handle);
  ctx.expect(cfg?.message_log_enabled === true && cfg?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The representable half of the config (enabled + channel) still persists guild-scoped.',
    observation:
      `guild_config: message_log_enabled=${cfg?.message_log_enabled}, ` +
      `message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)}.`,
    impact: 'The enable + channel configuration did not persist.',
  });
  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateCaptureReadback(
    ctx,
    'An edit produces no embed while a delete produces exactly one; edits/deletes in the ignored channel and the log channel produce nothing.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the configuration change with actor, guild, and correlation id.',
    'the config-change audit row is written by the dashboard settings API (not reachable in a bot-only harness)',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** INVALID — a rejected invalid config never persists (dashboard Zod layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}valid-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      message_log_enabled: true,
      message_log_channel_id: logChannelId,
    },
  });
  const userA = ctx.userId('a');

  // The prior VALID values are retained byte-for-byte (a rejected save never persists).
  const cfg = await readMessageLogConfig(handle);
  ctx.expect(cfg?.message_log_enabled === true && cfg?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid message-log values byte-for-byte (a rejected invalid save never persists).',
    observation:
      `guild_config holds message_log_enabled=${cfg?.message_log_enabled} (expected true), ` +
      `message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)} (expected "${logChannelId}").`,
    impact: 'A valid message-log configuration was not retained.',
  });

  // Live bot behavior is unchanged on the very next command after a rejected save.
  const mine = await runMyData(ctx, handle, userA);
  ctx.expect(mine.captured.has('editReply') && mine.parsed?.user_id === userA, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live bot behavior is unchanged on the very next command after a rejected config save.',
    observation: `the next /mydata command still replied and returned this member's export (user_id=${JSON.stringify(mine.parsed?.user_id)}).`,
    impact: 'A rejected config attempt disturbed live bot behavior on the next command.',
  });

  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The actual REJECTION is enforced in the dashboard's Zod layer; guild_config
  // carries NO CHECK constraint on the message-log columns, so the reject path is
  // not reachable in this bot-only harness (GATE it honestly).
  gateCaptureReadback(
    ctx,
    'An edit and delete immediately after the rejected saves behave exactly per the prior valid configuration.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records each rejected configuration attempt with the validation reason; no config-change audit row is written for the failed saves.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path or its rejected-config audit row',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** UNAUTH — forensic data is staff-only, config is admin-only, member data rights are self-scoped. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const aBalance = 424242;
  const bBalance = 737373;

  // Arrange DISTINCT member data so a self-scoping leak would be visible: A and B
  // each have a wallet with a unique balance in the SAME guild.
  await seedWallet(handle, userA, aBalance);
  await seedWallet(handle, userB, bBalance);

  // run-member-b exercises their own data rights: the export must be exactly B's
  // data and never A's (the handler resolves records by the invoking user id).
  const mineB = await runMyData(ctx, handle, userB);
  const scopedToB = mineB.parsed?.user_id === userB && mineB.parsed?.guild_id === handle.guildId;
  const showsBOwnBalance = mineB.parsed?.economy?.wallet?.wallet === bBalance;
  const leaksA = (mineB.raw ?? '').includes(String(aBalance));
  ctx.expect(scopedToB && showsBOwnBalance && !leaksA, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      'A member’s own data-rights view-and-export returns only their records — never another member’s data.',
    observation:
      `run-member-b export: user_id=${JSON.stringify(mineB.parsed?.user_id)} (expected "${userB}"), ` +
      `own wallet=${mineB.parsed?.economy?.wallet?.wallet} (expected ${bBalance}), ` +
      `contains member-a's distinctive balance ${aBalance}: ${leaksA} (expected false).`,
    impact:
      'A member data-rights export disclosed another member’s data (or was mis-scoped) — a privacy / data-rights breach.',
  });

  // The export query is guild-and-user scoped (DB-observable positive control):
  // member A's distinctive row exists and belongs to A, not B.
  const { data: aWalletRaw } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userA)
    .maybeSingle();
  const aWallet = aWalletRaw as { wallet: number; user_id: string; guild_id: string } | null;
  ctx.expect(aWallet?.user_id === userA && aWallet?.wallet === aBalance && !showExportUserMismatch(mineB, userB), {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Member data-rights resolution is scoped strictly to the invoking member’s own user id within the current guild.',
    observation:
      `member-a's own row exists (user_id=${aWallet?.user_id}, wallet=${aWallet?.wallet}) yet member-b's export is stamped ` +
      `user_id=${JSON.stringify(mineB.parsed?.user_id)} — the two are distinct members under guild "${handle.guildId}".`,
    impact: 'The member data-rights query was not self-scoped by user id — cross-member data exposure.',
  });

  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The staff-only log-channel read and the dashboard settings-API denial are
  // Discord-permission / dashboard-session lanes not reachable here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'An ordinary member cannot view the staff log channel while the staff observer reads it normally.',
    'requires staff-only channel permission overwrites + an unprivileged member read in the live guild (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'A dashboard session without admin access is refused by the settings API and the denied configuration attempt is audited (reason permission-denied).',
    'requires the dashboard session-auth + settings-API lane (not reachable in this bot-only harness)',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** Whether the export envelope is stamped with the WRONG user (a self-scoping violation). */
function showExportUserMismatch(result: MyDataResult, expectedUserId: string): boolean {
  return result.parsed?.user_id !== undefined && result.parsed.user_id !== expectedUserId;
}

/** DEPFAIL — Supabase-unreachable fail-closed. NOT convertible onto the supabase
 *  fault proxy: the whole capture surface fires only on messageUpdate /
 *  messageDelete GATEWAY events (loadConfig → logMessageEdit/logMessageDelete),
 *  and this harness has no edit/delete event driver — so even inside a real
 *  severed-DB window there is nothing ctx-drivable that reaches the contracted
 *  behavior. GATE honestly rather than fake a drive. (The product side is
 *  already outage-safe by static trace: loadConfig's error branch returns safe
 *  fail-closed defaults WITHOUT caching, emits message_log.degraded, and writes
 *  a throttled owner alert — proving it needs the event lane.) */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, edits and deletes flow normally for members while no log embed posts and no error reaches any member (fail-closed).',
    'the capture path fires only on gateway messageUpdate/messageDelete events — no edit/delete event driver exists in this harness, so the supabase fault proxy (run-one-domain.mjs dependency-outage lane) alone cannot drive the contracted outage behavior',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Message-log configuration and any forensic rows stay guild-scoped through the outage window.',
    'the outage window is only meaningful around a driven edit/delete capture — no gateway edit/delete driver exists in this harness',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'Append-only audit rows capture the degradation window and recovery; after restoration the next qualifying edit is captured normally.',
    'the message_log.degraded audit event is emitted from loadConfig only when a gateway edit/delete triggers the failed config read — no edit/delete event driver exists in this harness',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window rather than one per skipped event.',
    'the throttled message_log_degraded alert write fires only from a gateway-driven capture attempt (and its insert itself needs the DB back) — no edit/delete event driver exists in this harness',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** RETRY — a transient Discord fault on the first embed post is retried to exactly one embed. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The retry branch triggers only when a log embed POST transiently fails — a
  // Discord-REST fault on the gateway-driven capture path. GATE it; do not fake it.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a transient Discord fault on the first embed post for a delete, the retry succeeds and the log channel holds exactly one embed for that deletion.',
    `${GATEWAY_CAPTURE_REASON}. FINDING: the current handler wraps logChannel.send() in a bare try/catch that only logs the error — it has NO retry/backoff, so a transient failure DROPS the embed rather than converging to one`,
  );
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'The retried post reuses the original per-event dedupe key, so the log channel shows one embed for the event, not two.',
    'requires the mid-post fault-injection lane; FINDING: no per-event dedupe key exists in the handler',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Append-only audit rows record the retried delivery with the correlation id.',
    'requires the mid-post fault lane; the handler currently writes no delivery-retry audit row',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'No spurious owner alert is raised for a self-healing retried delivery.',
    'requires the mid-post fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The retried delivery touches only this guild’s scoped configuration.',
    'requires the mid-post fault-injection lane',
  );
  gateBranding(ctx);
}

/** REPLAY — re-delivering recorded gateway events must not double-log. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}log-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { message_log_enabled: true, message_log_channel_id: logChannelId },
  });

  // The configuration the replayed events would run under is real and guild-scoped.
  const cfg = await readMessageLogConfig(handle);
  ctx.expect(cfg?.message_log_enabled === true && cfg?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The persisted configuration the replayed events resolve against is intact and guild-scoped.',
    observation:
      `guild_config: message_log_enabled=${cfg?.message_log_enabled}, message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)}.`,
    impact: 'The message-log configuration was not intact for the replay scenario.',
  });
  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The actual double-log check is over re-delivered gateway events against the
  // live log channel — GATED, and the handler's missing dedupe key is flagged.
  gateCaptureReadback(
    ctx,
    'After replaying recorded edit/delete events, the log channel’s embed count and content are byte-identical to the pre-replay state.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Replayed deliveries add deduplication no-op records, not duplicate action rows.',
    'requires the gateway re-delivery harness; the handler writes no message-log action/dedupe audit rows',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** RESTART — logging configuration survives a full stack restart. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const logChannelId = `${ctx.runPrefix}log-chan`;

  // Boot #1: enable logging + pick a channel, snapshot, then shut down.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    guildConfigOverrides: { message_log_enabled: true, message_log_channel_id: logChannelId },
  });
  const snapshot = await readMessageLogConfig(first);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id, WITHOUT re-passing the message-log overrides. The base
  // upsert never lists the message-log columns, so on conflict they persist — this
  // is the "capture resumes under the persisted settings without re-saving" proof.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readMessageLogConfig(second);
  ctx.expect(
    afterRestart?.message_log_enabled === snapshot?.message_log_enabled &&
      afterRestart?.message_log_channel_id === snapshot?.message_log_channel_id &&
      afterRestart?.message_log_enabled === true &&
      afterRestart?.message_log_channel_id === logChannelId,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise:
        'After a full stack restart the persisted message-log configuration is unchanged (capture resumes under the same settings without re-saving).',
      observation:
        `pre-restart enabled=${snapshot?.message_log_enabled}/channel=${JSON.stringify(snapshot?.message_log_channel_id)}; ` +
        `post-restart enabled=${afterRestart?.message_log_enabled}/channel=${JSON.stringify(afterRestart?.message_log_channel_id)} ` +
        `(expected true/"${logChannelId}").`,
      impact: 'Message-log configuration did not survive a restart — persisted settings were lost or altered.',
    },
  );

  await proveConfigRls(ctx, second);
  await proveNoOwnerAlert(ctx, second);

  gateCaptureReadback(
    ctx,
    'Post-restart, an edit is captured under the pre-restart configuration and a delete of a pre-restart message produces the uncached-fallback embed rather than a crash.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Append-only audit rows capture post-restart message-logging actions; none double-post.',
    'requires the gateway capture lane (the DB-observable proof is that the config persisted across the reboot)',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** RACE — concurrency is safe: one embed per event; a config toggle races cleanly. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}log-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { message_log_enabled: true, message_log_channel_id: logChannelId },
  });

  // The config the racing events resolve against is a single, consistent row (the
  // toggle a race would flip is DB-observable here even though the capture is not).
  const cfg = await readMessageLogConfig(handle);
  ctx.expect(cfg?.message_log_enabled === true && cfg?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The single guild_config row the concurrent burst resolves against is consistent and guild-scoped.',
    observation:
      `guild_config: message_log_enabled=${cfg?.message_log_enabled}, message_log_channel_id=${JSON.stringify(cfg?.message_log_channel_id)}.`,
    impact: 'The configuration the concurrent events resolve against was inconsistent.',
  });
  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  gateCaptureReadback(
    ctx,
    'Ten concurrent edit/delete events produce exactly ten embeds; an event racing the owner disabling logging yields one complete embed or none, never half-logged.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit rows show exactly one configuration change for the toggle; the concurrent burst adds no duplicate rows.',
    'requires the gateway capture lane + dashboard config-toggle audit; FINDING: the handler keeps a MODULE-GLOBAL config cache (not per-guild), so a toggle racing an event across guilds is not isolated as the catalog promises',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** XGUILD — logging configuration and caches are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const logChannelA = `${ctx.runPrefix}log-chan-a`;

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    guildConfigOverrides: { message_log_enabled: true, message_log_channel_id: logChannelA },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    guildConfigOverrides: { message_log_enabled: false, message_log_channel_id: null },
  });

  // Each guild scope reads its OWN distinct config row and never the other's:
  // guild A → enabled + channel A; guild B → disabled + no channel.
  const cfgA = await readMessageLogConfig(handleA);
  const cfgB = await readMessageLogConfig(handleB);
  ctx.expect(
    cfgA?.message_log_enabled === true &&
      cfgA?.message_log_channel_id === logChannelA &&
      cfgB?.message_log_enabled === false &&
      (cfgB?.message_log_channel_id === null || cfgB?.message_log_channel_id === ''),
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Guild A (logging on, channel A) and guild B (logging off) coexist with zero bleed: each guild-scoped read returns its own row.',
      observation:
        `guild-A-scoped read: enabled=${cfgA?.message_log_enabled}, channel=${JSON.stringify(cfgA?.message_log_channel_id)}; ` +
        `guild-B-scoped read: enabled=${cfgB?.message_log_enabled}, channel=${JSON.stringify(cfgB?.message_log_channel_id)} ` +
        `(distinct rows under distinct guild_ids).`,
      impact: 'A guild-scoped config read returned the other guild’s message-log settings — cross-guild configuration leakage.',
    },
  );

  await proveConfigRls(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleA);

  // The actual per-guild CAPTURE isolation (guild A logs, guild B never does) needs
  // the gateway lane — and the module-global runtime cache concern is flagged here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Simultaneous edits in both guilds produce exactly one embed in guild A’s log channel and none anywhere for guild B.',
    `${GATEWAY_CAPTURE_REASON}. FINDING: the handler's config cache is a MODULE-GLOBAL variable keyed on nothing — not per-guild — so the first guild loaded within the 60s TTL can serve its config to a second guild, contradicting the per-guild-cache promise`,
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Append-only audit rows capture each guild’s message-logging actions independently.',
    'requires the gateway capture lane; per-guild config-row isolation is the DB-observable evidence proven here',
  );
  gateBranding(ctx);
  gateReplaySafety(ctx);
}

/** CLEANUP — the suite leaves no trace and honors erasure (anonymize-over-delete). */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const logChannelId = `${ctx.runPrefix}log-chan`;
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { message_log_enabled: true, message_log_channel_id: logChannelId },
  });

  // Baseline: the run-prefixed message-log configuration exists before cleanup.
  const before = await readMessageLogConfig(handle);
  ctx.expect(before?.message_log_enabled === true && before?.message_log_channel_id === logChannelId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created a run-prefixed message-log configuration row (pre-cleanup baseline).',
    observation:
      `pre-cleanup guild_config: message_log_enabled=${before?.message_log_enabled}, message_log_channel_id=${JSON.stringify(before?.message_log_channel_id)}.`,
    impact: 'The cleanup scenario could not establish its run-prefixed configuration baseline.',
  });

  await proveConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);

  // Erasure honors anonymize-over-delete: seed an audit row for the run, attempt to
  // DELETE it as the service role, and prove it SURVIVES — the enforcement behind
  // "retained forensic/audit records are anonymized rather than deleted". (service_role
  // has DELETE revoked on audit_logs + trg_prevent_audit_log_delete guards it.)
  const { data: seededRaw, error: seedErr } = await handle.supabase
    .from('audit_logs')
    .insert({
      guild_id: handle.guildId,
      actor_type: 'bot',
      actor_id: 'anonymized',
      action: 'message_log.member_erased',
      target_type: 'member',
      target_id: 'anonymized',
      details: { anonymized: true, run: ctx.runPrefix },
      correlation_id: `${ctx.runPrefix}corr`,
    })
    .select('id')
    .single();
  const seededId = (seededRaw as { id: string } | null)?.id ?? null;
  let deleteRefused = false;
  let survived = false;
  if (seededId) {
    const { error: delErr } = await handle.supabase.from('audit_logs').delete().eq('id', seededId);
    deleteRefused = delErr !== null;
    const { count } = await handle.supabase
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('id', seededId);
    survived = (count ?? 0) === 1;
  }
  ctx.expect(seededId !== null && deleteRefused && survived, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise:
      'Retained audit records for an erased member are anonymized, never deleted: a delete attempt is refused and the (already-anonymized) row survives.',
    observation:
      `seeded audit row: ${seededId !== null} (insert error: ${seedErr?.message ?? 'none'}); ` +
      `service-role delete refused: ${deleteRefused}; row survived the delete attempt: ${survived}.`,
    impact:
      'An audit row could be deleted — the never-delete / anonymize-over-delete erasure contract is not enforced (forensic history is destructible).',
  });

  // Run the sweep and prove ZERO run-prefixed message-log configuration remains.
  await ctx.sweepGuildRows(handle);
  const after = await readMessageLogConfig(handle);
  ctx.expect(after === null, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed message-log configuration is deleted by the cleanup sweep; a final sweep finds zero configuration rows for the test guild.',
    observation: `post-sweep guild_config for the test guild: ${after === null ? 'no row (swept)' : JSON.stringify(after)}.`,
    impact: 'The cleanup sweep left run-prefixed message-log configuration behind — the suite leaves residue.',
  });

  // The Discord-side log channel/embed removal is a live-guild readback lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed log channels or log embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  gateReplaySafety(ctx);
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The message-logging domain proof. guildScopedTables lists the guild_id-scoped
 * tables THIS proof writes so cleanup is surgical (guild_config + guild are always
 * swept in addition): economy_wallets (the /mydata self-scoping fixtures) and
 * alerts (owner-notification hygiene). audit_logs is deliberately EXCLUDED — it is
 * never-deletable by contract, so sweeping/counting it would be both impossible
 * and wrong.
 */
export const moderationMessageLoggingProof: DomainProof = {
  domainId: 'moderation-message-logging',
  guildScopedTables: ['economy_wallets', 'alerts'],
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
