/**
 * scenario-runner/scripts/community-welcome-onboarding — the Welcome & Onboarding
 * domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete real-stack
 * proofs driven against LOCAL Supabase. This domain is DELIBERATELY different in
 * shape from the wallet-rewards template: it is ENTIRELY gateway-event driven —
 * the welcome post, welcome DM, welcome card, member-role grant, native-onboarding
 * completion detection, and goodbye post are produced by the real handlers in
 * packages/bot/src/features/welcome (`handleMemberJoin` / `handleMemberUpdate` /
 * `handleMemberLeave`) that fire on guildMemberAdd/Update/Remove. The domain
 * exposes NO slash command, so the bot-only local-Supabase harness (which drives
 * the production dispatcher via runSlash) CANNOT emit the member-lifecycle events
 * that trigger those member-facing effects. Every such surface is therefore GATED
 * honestly behind a live Discord gateway (DISCORD_TOKEN + live guild) — this is a
 * MOSTLY-GATED domain, and that is the correct, honest boundary.
 *
 * What DOES run now, against real state:
 *   - The persisted membership model the flow reads/writes: the `members` table
 *     PK (guild_id, discord_id) that dedups a replayed join to one row, the
 *     partial unique index `uniq_member_number_per_guild` that guarantees single
 *     sequential numbering under a concurrent-join race, and the idempotent
 *     `onboarding_completed` marker (markOnboardingCompleted).
 *   - The real production RPC `get_next_member_number` the join flow calls to
 *     number each welcome post.
 *   - The `guild_config` welcome keys the real `getGuildConfig` load path reads.
 *   - Guild-scoped RLS on `members` (anon-denial with a service-role positive
 *     control) and strict per-guild isolation (XGUILD).
 *   - The cleanup sweep of run-prefixed membership rows.
 *
 * Behavior-bug discovery (never forced green): where the REAL bot/schema diverges
 * from the catalog's contracted intent the script records a FAIL (a finding for
 * the owner) — e.g. `get_next_member_number` reading a non-existent relation and the
 * missing safe-fallback config backing. The out-of-box welcome defaults now ALIGN with
 * the DEF promise (welcome/DM/goodbye ship ON after 20260724170000_ship_on_defaults),
 * so DEF asserts that alignment as a PASS.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes read back from local Supabase ──────────────────────────────

interface MemberRow {
  guild_id: string;
  discord_id: string;
  member_number: number;
  onboarding_completed: boolean;
  is_returning: boolean;
  roles: string[];
  left_at: string | null;
}

interface WelcomeConfigRow {
  welcome_enabled: boolean;
  welcome_dm_enabled: boolean;
  goodbye_enabled: boolean;
  welcome_card_enabled: boolean;
  returning_member_skip_welcome_dm: boolean;
  returning_member_restore_levels: boolean;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  welcome_card_background: string | null;
  goodbye_channel_id: string | null;
  goodbye_message: string | null;
  member_role_id: string | null;
  interest_role_mapping: Record<string, string>;
}

/** Options for seeding a `members` row through the SAME upsert shape the real
 *  `recordMemberJoin` uses (onConflict on the (guild_id, discord_id) PK). */
interface SeedMemberOptions {
  username?: string;
  memberNumber?: number;
  onboardingCompleted?: boolean;
  isReturning?: boolean;
  roles?: string[];
  leftAt?: string | null;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

async function readMember(handle: LiveClientHandle, discordId: string): Promise<MemberRow | null> {
  const { data } = await handle.supabase
    .from('members')
    .select('guild_id, discord_id, member_number, onboarding_completed, is_returning, roles, left_at')
    .eq('guild_id', handle.guildId)
    .eq('discord_id', discordId)
    .maybeSingle();
  return (data as MemberRow | null) ?? null;
}

async function memberCount(handle: LiveClientHandle, discordId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('members')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', discordId);
  return count ?? 0;
}

async function memberCountAll(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('members')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/**
 * Upsert a member through the EXACT onConflict target production's
 * `recordMemberJoin` uses (the (guild_id, discord_id) PK). Returns the error
 * message (or null) so a caller can prove replay/idempotency by re-delivering.
 */
async function upsertMember(
  handle: LiveClientHandle,
  discordId: string,
  opts: SeedMemberOptions = {},
): Promise<string | null> {
  const { error } = await handle.supabase.from('members').upsert(
    {
      guild_id: handle.guildId,
      discord_id: discordId,
      username: opts.username ?? `${discordId}-tag`,
      member_number: opts.memberNumber ?? 0,
      onboarding_completed: opts.onboardingCompleted ?? false,
      is_returning: opts.isReturning ?? false,
      roles: opts.roles ?? [],
      joined_at: new Date().toISOString(),
      ...(opts.leftAt !== undefined ? { left_at: opts.leftAt } : {}),
    },
    { onConflict: 'guild_id,discord_id' },
  );
  return error?.message ?? null;
}

/** Raw INSERT (no upsert) so a PK / unique-index conflict surfaces as an error —
 *  used to prove the member-number unique index rejects a duplicate. */
async function insertMemberRaw(
  handle: LiveClientHandle,
  discordId: string,
  opts: SeedMemberOptions = {},
): Promise<string | null> {
  const { error } = await handle.supabase.from('members').insert({
    guild_id: handle.guildId,
    discord_id: discordId,
    username: opts.username ?? `${discordId}-tag`,
    member_number: opts.memberNumber ?? 0,
    onboarding_completed: opts.onboardingCompleted ?? false,
    is_returning: opts.isReturning ?? false,
    roles: opts.roles ?? [],
    joined_at: new Date().toISOString(),
  });
  return error?.message ?? null;
}

/** Mirror `markOnboardingCompleted`: idempotently set onboarding_completed=true. */
async function markCompleted(handle: LiveClientHandle, discordId: string): Promise<void> {
  await handle.supabase
    .from('members')
    .update({ onboarding_completed: true })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', discordId);
}

async function readWelcomeConfig(handle: LiveClientHandle): Promise<WelcomeConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select(
      'welcome_enabled, welcome_dm_enabled, goodbye_enabled, welcome_card_enabled, ' +
        'returning_member_skip_welcome_dm, returning_member_restore_levels, welcome_channel_id, ' +
        'welcome_message, welcome_card_background, goodbye_channel_id, goodbye_message, ' +
        'member_role_id, interest_role_mapping',
    )
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as WelcomeConfigRow | null) ?? null;
}

/** Call the REAL production RPC the join flow uses to number each welcome post. */
async function nextMemberNumber(
  handle: LiveClientHandle,
): Promise<{ value: number | null; error: string | null }> {
  const { data, error } = await handle.supabase.rpc('get_next_member_number', {
    p_guild_id: handle.guildId,
  });
  return { value: typeof data === 'number' ? data : null, error: error?.message ?? null };
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
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS / a missing
 * GRANT → 0), or null when no anon key / URL is available (→ GATE).
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
    // from the table by RLS / a missing GRANT — the deny we want to prove) from the
    // key itself being rejected before authz ran (inconclusive → GATE).
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0; // anon role denied the table — RLS / GRANT working
    }
    return null; // rejected/invalid key or other error → inconclusive (GATE)
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Prove guild-scoped RLS on `members`: the service role reads THIS member's row
 * while an anon client reads zero of them. Made non-vacuous by the positive
 * control — the caller has already created the member under the guild, so an anon
 * read of ZERO is a real deny, not "nothing to read." GATEs (never fakes) when no
 * anon key is exported or the probe is inconclusive.
 */
async function proveMembersRls(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  discordId: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero `members` rows (guild-scoped RLS; no anon GRANT).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, 'members', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon/authenticated clients read zero `members` rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readMember(handle, discordId);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s membership row while an anon client reads zero of them (guild-scoped `members` RLS / no anon GRANT).',
    observation:
      `service-role sees the member under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} \`members\` row(s) for that guild.`,
    impact:
      'A membership row visible to the service role was also readable with an anon key — RLS is not denying anon reads (member PII exposure).',
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
    promise: "This scenario's welcome/onboarding happy path raises no owner alert.",
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert was raised on a happy path — a false alarm / notification noise.',
  });
}

/** Gate a member-facing surface that only a live Discord gateway can drive. */
function gateGatewayReadback(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    promise,
    'requires live Discord gateway member events (guildMemberAdd / guildMemberUpdate / guildMemberRemove) + DISCORD_TOKEN; this domain has no slash-command surface, so the bot-only local-Supabase harness cannot emit the member-lifecycle events that drive welcome/onboarding/goodbye effects',
  );
}

/** Branding has no slash-reply surface to inspect in this gateway-driven domain. */
function gateBrandingNoReply(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Every member-facing welcome/onboarding surface shows the owner brand kit + voice preset with the subtle powered-by-SomniBot attribution and zero stock-bot wording.',
    'this domain emits no slash-command reply — all member-facing surfaces (welcome post, DM, card, goodbye) are gateway-driven channel/DM messages, needing a live embed/message snapshot (DISCORD_TOKEN + live guild) to inspect',
  );
}

/** Welcome/onboarding audit rows are written by writeAuditLog inside the gateway
 *  handlers — unreachable without member events. */
function gateAuditGateway(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Every welcome/onboarding state change lands exactly one append-only audit_logs row with actor, guild, and correlation id.',
    'welcome/onboarding audit rows are written by writeAuditLog inside the gateway member-lifecycle handlers; with no emittable gateway member events here, no bot-driven audit row is produced (the DB-observable membership + idempotency invariants are proven instead)',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-delivering this scenario’s join/completion events yields no duplicate welcome posts, welcome DMs, or member-role grants.',
    `the DB-observable idempotency backbone (members PK dedup + idempotent onboarding-completion) is exercised directly in the ${where} scenario`,
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — out-of-box welcome + required onboarding; member role on completion. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  // Boot a fresh guild with NO welcome overrides, so guild_config carries the
  // SHIPPED column defaults — the config a brand-new guild's join flow loads.
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // 1) Out-of-box alignment: the catalog contracts welcomes ON by default, and the
  //    shipped guild_config column DEFAULTs now agree — welcome_enabled/welcome_dm_enabled/
  //    goodbye_enabled ship true (20260724170000_ship_on_defaults), so a fresh guild's
  //    join flow loads welcomes ON.
  const cfg = await readWelcomeConfig(handle);
  const catWelcome = declaredDefault(ctx.domain, 'welcome-enabled') === true;
  const catDm = declaredDefault(ctx.domain, 'welcome-dm-enabled') === true;
  const catGoodbye = declaredDefault(ctx.domain, 'goodbye-enabled') === true;
  ctx.expect(cfg?.welcome_enabled === catWelcome, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Out of the box the guild_config the join flow loads has welcomes enabled (catalog welcome-enabled default = ${catWelcome}).`,
    observation:
      `fresh guild_config.welcome_enabled=${cfg?.welcome_enabled}, welcome_dm_enabled=${cfg?.welcome_dm_enabled}, ` +
      `goodbye_enabled=${cfg?.goodbye_enabled}; catalog defaults are welcome-enabled=${catWelcome}, ` +
      `welcome-dm-enabled=${catDm}, goodbye-enabled=${catGoodbye}.`,
    impact:
      'Were the shipped guild_config defaults (welcome_enabled/welcome_dm_enabled/goodbye_enabled) OFF they would contradict the DEF out-of-box promise of a branded channel welcome + DM — a brand-new guild would have welcomes OFF until an owner enabled them.',
  });

  // Seed the first membership row (also the RLS positive control below).
  await upsertMember(handle, userA, { memberNumber: 0, username: 'DEF A' });

  // 2) The real member-number RPC the join flow calls to number each welcome post.
  //    Call → number a member → call again: expect a monotonically increasing
  //    sequence (N then N+1, N>=1). The RPC's final migration reads a non-existent
  //    relation, so this surfaces the divergence as a FAIL rather than forcing green.
  const r1 = await nextMemberNumber(handle);
  if (r1.value !== null) {
    await upsertMember(handle, userB, { memberNumber: r1.value, username: 'DEF B' });
  }
  const r2 = r1.value !== null ? await nextMemberNumber(handle) : { value: null, error: r1.error };
  ctx.expect(r1.value !== null && r2.value !== null && r1.value >= 1 && r2.value === r1.value + 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'get_next_member_number returns a valid, monotonically increasing sequence so each welcome post shows a correct member number.',
    observation:
      r1.error || r2.error
        ? `get_next_member_number errored: ${r1.error ?? r2.error}`
        : `two calls (one member numbered between) returned ${r1.value} then ${r2.value} (expected N then N+1, N>=1).`,
    impact:
      'get_next_member_number reads from public.guild_members, a relation that does not exist in the schema, so it raises 42P01 and the bot silently falls back to a NON-atomic MAX(member_number)+1 read on `members` — defeating the advisory-lock atomicity that prevents duplicate member numbers under concurrent joins.',
  });

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  // Member-facing effects that only a live gateway can drive.
  gateGatewayReadback(
    ctx,
    'Exactly one welcome post (with card) and one welcome DM appear; member-gated channels stay invisible until onboarding completes, after which the member role is present and channels open.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard welcome config (channel/template/card/interest map) persists. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      welcome_enabled: true,
      welcome_channel_id: ctx.snowflake('welcome-channel'),
      welcome_message: `${ctx.runPrefix} Welcome {member-name} to {guild-name}!`,
      welcome_card_enabled: true,
      welcome_card_background: 'https://example.test/bg.png',
      interest_role_mapping: { 'onboard-opt-1': ctx.snowflake('interest-role') },
      member_role_id: ctx.snowflake('member-role'),
    },
  });
  const userA = ctx.userId('a');
  await upsertMember(handle, userA, { memberNumber: 1, username: 'SETA A' });

  // The guild_config the join flow's getGuildConfig loads carries the SET-A welcome
  // configuration, STRUCTURALLY distinct from the stock defaults (welcome_enabled
  // default false → true; interest_role_mapping default {} → one mapping; a
  // dedicated welcome channel + card background set). We assert booleans / counts /
  // null-ness (not our literal strings) so this proves the write LANDED, not that
  // Supabase echoes input.
  const cfg = await readWelcomeConfig(handle);
  const mappingKeys = cfg ? Object.keys(cfg.interest_role_mapping) : [];
  ctx.expect(
    cfg?.welcome_enabled === true &&
      cfg?.welcome_channel_id !== null &&
      cfg?.welcome_card_enabled === true &&
      cfg?.welcome_card_background !== null &&
      mappingKeys.length === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The dashboard-configured welcome (dedicated channel, custom template, card background, interest-role mapping) is persisted in guild_config for the join flow to consume — distinct from the stock defaults.',
      observation:
        `welcome_enabled=${cfg?.welcome_enabled}, welcome_channel_id set=${cfg?.welcome_channel_id !== null}, ` +
        `welcome_card_enabled=${cfg?.welcome_card_enabled}, welcome_card_background set=${cfg?.welcome_card_background !== null}, ` +
        `interest_role_mapping keys=${mappingKeys.length}.`,
      impact: 'A saved dashboard welcome configuration was not persisted for the bot to load.',
    },
  );

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  // The RENDERED effect (post in the configured channel using the template + card,
  // mapped interest role granted after the onboarding answer) needs the gateway flow.
  gateGatewayReadback(
    ctx,
    'The welcome post appears in the newly configured channel using the custom template + card, and the mapped run interest role is granted after the onboarding answer.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — DMs off, goodbye on in a dedicated channel, returning-member restore. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      welcome_enabled: true,
      welcome_dm_enabled: false,
      goodbye_enabled: true,
      goodbye_channel_id: ctx.snowflake('goodbye-channel'),
      goodbye_message: `${ctx.runPrefix} Safe travels {member-name}!`,
      returning_member_restore_levels: true,
    },
  });
  const userA = ctx.userId('a');

  // The second distinct config persists for the flow: DMs OFF, goodbye ON in a
  // dedicated channel, restore-levels ON — asserted via booleans / null-ness.
  const cfg = await readWelcomeConfig(handle);
  ctx.expect(
    cfg?.welcome_dm_enabled === false &&
      cfg?.goodbye_enabled === true &&
      cfg?.goodbye_channel_id !== null &&
      cfg?.returning_member_restore_levels === true,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'The second configuration persists for the flow: welcome DMs off, goodbye posts on in a dedicated channel, and returning-member level restoration on.',
      observation:
        `welcome_dm_enabled=${cfg?.welcome_dm_enabled}, goodbye_enabled=${cfg?.goodbye_enabled}, ` +
        `goodbye_channel_id set=${cfg?.goodbye_channel_id !== null}, returning_member_restore_levels=${cfg?.returning_member_restore_levels}.`,
      impact: 'A saved goodbye / returning-member configuration was not persisted for the bot to load.',
    },
  );

  // Returning-member data model: recordMemberLeave PRESERVES (never deletes) the
  // member row with a left_at snapshot + roles, so a rejoin can restore state.
  // Seed a member, snapshot a leave, then prove the row survived with its roles.
  const priorRoles = [ctx.snowflake('earned-role')];
  await upsertMember(handle, userA, {
    memberNumber: 7,
    onboardingCompleted: true,
    username: 'SETB A',
  });
  await handle.supabase
    .from('members')
    .update({ left_at: new Date().toISOString(), roles: priorRoles })
    .eq('guild_id', handle.guildId)
    .eq('discord_id', userA);
  const afterLeave = await readMember(handle, userA);
  ctx.expect(
    afterLeave !== null &&
      afterLeave.left_at !== null &&
      afterLeave.roles.length === 1 &&
      afterLeave.member_number === 7,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'On leaving, the membership row is preserved (not deleted) with a left_at snapshot and the member’s roles, so a returning member’s status can be restored on rejoin.',
      observation:
        `post-leave row present=${afterLeave !== null}, left_at set=${afterLeave?.left_at !== null}, ` +
        `roles snapshot count=${afterLeave?.roles.length}, member_number=${afterLeave?.member_number} (kept at 7).`,
      impact:
        'A departing member’s row/roles were not preserved — returning-member level restoration would have nothing to restore.',
    },
  );

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  gateGatewayReadback(
    ctx,
    'No welcome DM is sent, the goodbye channel shows exactly one branded farewell, and the rejoining member’s /rank shows restored pre-departure XP.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid welcome config never persists (dashboard layer). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: {
      welcome_enabled: true,
      welcome_channel_id: ctx.snowflake('valid-welcome-channel'),
      interest_role_mapping: { 'opt-1': ctx.snowflake('interest-role-1') },
    },
  });
  const userA = ctx.userId('a');
  await upsertMember(handle, userA, { memberNumber: 1, username: 'INVALID A' });

  // The prior VALID welcome config is retained and well-formed (nothing invalid
  // persisted): welcome enabled, a channel present, and interest_role_mapping is a
  // well-formed JSON object with exactly the one valid mapping.
  const cfg = await readWelcomeConfig(handle);
  const mapping = cfg?.interest_role_mapping ?? {};
  const mappingWellFormed =
    typeof mapping === 'object' && !Array.isArray(mapping) && Object.keys(mapping).length === 1;
  ctx.expect(cfg?.welcome_enabled === true && cfg?.welcome_channel_id !== null && mappingWellFormed, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise:
      'guild_config keeps its prior valid welcome values and a well-formed interest-role mapping (a rejected invalid save never persists).',
    observation:
      `welcome_enabled=${cfg?.welcome_enabled}, welcome_channel_id set=${cfg?.welcome_channel_id !== null}, ` +
      `interest_role_mapping well-formed object with ${Object.keys(mapping).length} key(s)=${mappingWellFormed}.`,
    impact: 'A valid welcome configuration was not retained.',
  });

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  // The actual REJECTION (nonexistent channel id / malformed mapping) is enforced in
  // the dashboard's Zod layer; guild_config's welcome columns carry NO FK/CHECK
  // constraint, so the reject path is not reachable in this bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard welcome page surfaces a clear validation error for a nonexistent channel id and a malformed interest-role mapping; stored config is unchanged.',
    'welcome-config validation lives in the dashboard (Zod) layer; guild_config welcome columns have no DB FK/CHECK, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected welcome-config attempt and its validation reason; no config-change row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );
  // "A member joining right after the rejected save is welcomed exactly as before"
  // needs the gateway join flow.
  gateGatewayReadback(ctx, 'A member joining right after the rejected save is welcomed exactly as before the attempt.');
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — only admins shape the welcome; a member cannot self-grant the role. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { member_role_id: ctx.snowflake('member-role') },
  });
  const userB = ctx.userId('b');

  // run-member-b joins but has NOT completed onboarding: the membership gate row
  // records onboarding_completed=false — the state the bot requires before it (and
  // ONLY it) grants the member role. There is no DB "role grant" record (roles live
  // on Discord), so the bypass-refusal itself is a Discord permission-design fact.
  await upsertMember(handle, userB, { memberNumber: 1, onboardingCompleted: false, username: 'UNAUTH B' });
  const m = await readMember(handle, userB);
  ctx.expect(m !== null && m.onboarding_completed === false, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A member who has not completed onboarding is recorded onboarding_completed=false — the pre-completion gate state before the bot grants the member role.',
    observation: `members.onboarding_completed for the bypass-attempt member = ${m?.onboarding_completed}.`,
    impact: 'A member who never completed onboarding was not held in the pre-completion gate state.',
  });

  // Anon cannot even READ member data (let alone edit welcome settings) — the RLS
  // negative control under the "only admins may shape the welcome" permission.
  await proveMembersRls(ctx, handle, userB);
  await proveNoOwnerAlert(ctx, handle);

  gateGatewayReadback(
    ctx,
    'run-member-b cannot obtain the member role or member-gated access without completing onboarding (the role is granted only by the bot; channel perms restrict pre-onboarding members).',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot edit welcome settings (permission error, no row change).',
    'requires the dashboard session-auth lane (Supabase RLS restricts welcome-config writes to guild admins) — not reachable in a bot-only harness',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'The denied dashboard write and the bypass attempt each produce one audit row naming actor and reason.',
    'these audit rows are written by the dashboard save path / gateway handler — not reachable in a bot-only harness',
  );
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — safe fallback when DMs closed + onboarding unavailable. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  // Seed the member whose closed-DM join would trigger the fallback (also the RLS
  // positive control below).
  await upsertMember(handle, userA, { memberNumber: 1, onboardingCompleted: false, username: 'DEPFAIL A' });

  // The catalog contracts a safe fallback gated by the fallback-mode +
  // fallback-timeout-minutes controls. Prove whether guild_config actually backs
  // those controls: select them and observe the read result. The schema has NEITHER
  // column and the bot has no fallback timer, so this reads an error → FAIL finding.
  const { error: fbErr } = await handle.supabase
    .from('guild_config')
    .select('fallback_mode, fallback_timeout_minutes')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  ctx.expect(fbErr === null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'guild_config exposes the catalog fallback-mode + fallback-timeout-minutes controls that drive the safe-fallback grant when DMs are closed / onboarding is unavailable.',
    observation:
      fbErr === null
        ? 'both fallback_mode and fallback_timeout_minutes columns are present.'
        : `reading fallback_mode/fallback_timeout_minutes from guild_config errored: ${fbErr.message}`,
    impact:
      'The catalog-contracted safe fallback has NO config backing (guild_config lacks fallback_mode / fallback_timeout_minutes) and the onboarding handler has no fallback timer — a member with closed DMs while onboarding is unavailable is never granted access by a fallback and stays locked at the door.',
  });

  await proveMembersRls(ctx, handle, userA);
  // NOTE: DEPFAIL is a FAILURE branch where the catalog expects exactly ONE owner
  // config-alert — so we do NOT assert "no owner alert" here; that alert is gated
  // (undrivable) below rather than force-passed.
  // The timed fallback grant, the dm-fallback-notice in-channel, the single
  // config-alert to the owner, and the post-timeout member-role grant all need the
  gateGatewayReadback(
    ctx,
    'The welcome channel shows the dm-fallback-notice, and the member role appears within the fallback window despite no completed onboarding.',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Exactly one config-alert reaches the owner channel describing the fallback grant and its cause.',
    'the durable onboarding fallback and deduped owner alert exist; proving them requires the live gateway, fallback timer, and configured owner channel readback',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Append-only audit rows capture the fallback grant with actor, guild, and correlation id.',
    'the fallback RPC writes member.onboarding_fallback_granted atomically; proving it requires the live gateway/fallback path followed by audit_logs readback',
  );
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RETRY — a transient member-role grant failure converges to exactly one grant. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { member_role_id: ctx.snowflake('member-role') },
  });
  const userA = ctx.userId('a');
  await upsertMember(handle, userA, { memberNumber: 1, onboardingCompleted: false, username: 'RETRY A' });

  // The DB backing for "completion is never double-processed": markOnboardingCompleted
  // is idempotent — re-marking keeps a single row at onboarding_completed=true, so a
  // retried grant after a transient failure converges without double-processing.
  await markCompleted(handle, userA);
  await markCompleted(handle, userA);
  const m = await readMember(handle, userA);
  const cnt = await memberCount(handle, userA);
  ctx.expect(m?.onboarding_completed === true && cnt === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Onboarding completion is recorded idempotently (onboarding_completed=true on a single membership row) so a retried grant never double-processes completion.',
    observation: `onboarding_completed=${m?.onboarding_completed}, membership rows=${cnt} (expected true / 1).`,
    impact: 'Retried onboarding completion diverged from an idempotent single-row completed state.',
  });

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  // The role grant is a Discord REST call, not a DB write; its transient-failure
  // retry/backoff, the delayed-access member message, and the owner alert on repeated
  // failure need a mid-grant fault-injection lane + a live gateway.
  ctx.gate(
    'Discord',
    'discord-readback',
    'With a transient fault on the first member-role grant, the retry lands the grant exactly once and the member holds the role once with one completion message.',
    'requires a mid-grant Discord fault-injection lane + a live gateway (the member-role grant is a Discord REST call, not a DB write)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'If retries keep failing the owner is alerted once; a self-healing retry raises none.',
    'requires the mid-grant fault-injection lane + the owner alert channel readback',
  );
  gateAuditGateway(ctx);
  gateBrandingNoReply(ctx);
}

/** REPLAY — re-delivered join/completion events never double-apply. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');

  // (a) Replaying a join upserts on the members PK (guild_id, discord_id) — the EXACT
  //     onConflict target recordMemberJoin uses — so exactly ONE membership row
  //     survives two identical deliveries.
  await upsertMember(handle, userA, { memberNumber: 7, username: 'REPLAY A' });
  await upsertMember(handle, userA, { memberNumber: 7, username: 'REPLAY A' }); // replay
  const cntJoin = await memberCount(handle, userA);
  ctx.expect(cntJoin === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering a join upserts on the members PK (guild_id, discord_id) so exactly one membership record exists after replay.',
    observation: `members rows for the replayed member after two identical join deliveries = ${cntJoin} (expected 1).`,
    impact: 'A replayed join created a duplicate membership record — the PK idempotency the join flow relies on failed.',
  });

  // (b) Replaying completion is idempotent: onboarding_completed stays true on the
  //     single row (completion never double-processed).
  await markCompleted(handle, userA);
  await markCompleted(handle, userA); // replay
  const m = await readMember(handle, userA);
  const cntAfter = await memberCount(handle, userA);
  ctx.expect(m?.onboarding_completed === true && cntAfter === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-delivering onboarding completion leaves onboarding_completed=true on the single membership row.',
    observation: `after two identical completion deliveries: onboarding_completed=${m?.onboarding_completed}, rows=${cntAfter}.`,
    impact: 'A replayed onboarding completion double-processed or duplicated the membership row.',
  });

  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  gateGatewayReadback(
    ctx,
    'After replaying the recorded join and completion events, exactly one welcome post, one DM, and one member-role grant exist.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
}

/** RESTART — mid-onboarding state survives a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: a member joins and is mid-onboarding (onboarding_completed=false); snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  await upsertMember(first, userA, { memberNumber: 3, onboardingCompleted: false, username: 'RESTART A' });
  const snapshot = await readMember(first, userA);
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). The membership row lives in Supabase, so it
  // must be byte-identical after reboot.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const afterRestart = await readMember(second, userA);
  ctx.expect(
    afterRestart !== null &&
      afterRestart.member_number === snapshot?.member_number &&
      afterRestart.onboarding_completed === false &&
      afterRestart.member_number === 3,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A member mid-onboarding survives a full stack restart: the persisted membership row is identical after reboot (state lives in Supabase).',
      observation:
        `pre-restart member_number=${snapshot?.member_number}/completed=${snapshot?.onboarding_completed}; ` +
        `post-restart member_number=${afterRestart?.member_number}/completed=${afterRestart?.onboarding_completed} (expected 3/false).`,
      impact: 'Mid-onboarding membership state did not survive a restart — onboarding progress was lost or altered.',
    },
  );

  // Post-restart completion converges to full access without a duplicate membership row.
  await markCompleted(second, userA);
  const converged = await readMember(second, userA);
  const cnt = await memberCount(second, userA);
  ctx.expect(converged?.onboarding_completed === true && cnt === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'After the restart the member completes onboarding and converges to full access exactly once (one membership row, onboarding_completed=true).',
    observation: `post-restart completion: onboarding_completed=${converged?.onboarding_completed}, membership rows=${cnt}.`,
    impact: 'Post-restart completion produced a duplicate membership row or failed to converge.',
  });

  await proveMembersRls(ctx, second, userA);
  await proveNoOwnerAlert(ctx, second);

  gateGatewayReadback(
    ctx,
    'Post-restart completion grants the member role exactly once and no duplicate welcome surfaces exist.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
}

/** RACE — concurrent joins/completions grant access exactly once. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');
  const userC = ctx.userId('c');

  // (a) Two simultaneous deliveries of the SAME join (same PK) create exactly ONE
  //     membership row — the members PK dedups the race.
  const [e1, e2] = await Promise.all([
    upsertMember(handle, userC, { memberNumber: 0, username: 'RACE C' }),
    upsertMember(handle, userC, { memberNumber: 0, username: 'RACE C' }),
  ]);
  const cntC = await memberCount(handle, userC);
  ctx.expect(cntC === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Two simultaneous deliveries of one member’s join create exactly one membership row (members PK dedup).',
    observation: `after two concurrent identical join upserts: membership rows=${cntC} (expected 1); upsert errors=[${e1 ?? 'none'}, ${e2 ?? 'none'}].`,
    impact: 'A concurrent first-touch join created duplicate membership rows — the PK dedup failed under a race.',
  });

  // (b) The partial unique index uniq_member_number_per_guild guarantees single
  //     sequential numbering: two DIFFERENT members cannot hold the same
  //     member_number (>0) in one guild — the safety net when the numbering RPC is
  //     defeated (see DEF). The second raw insert must be REJECTED.
  const dupNumber = 4242;
  const insA = await insertMemberRaw(handle, userA, { memberNumber: dupNumber, username: 'RACE A' });
  const insB = await insertMemberRaw(handle, userB, { memberNumber: dupNumber, username: 'RACE B' });
  ctx.expect(insA === null && insB !== null, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Two members cannot hold the same member_number in one guild — uniq_member_number_per_guild guarantees single sequential numbering even under a concurrent-join race.',
    observation:
      `first insert (member_number=${dupNumber}) error=${insA ?? 'none'}; ` +
      `second insert (same member_number) error=${insB ?? 'none (UNEXPECTEDLY ACCEPTED)'}.`,
    impact: 'The unique member-number index did not reject a duplicate — concurrent joins could receive the same member number.',
  });

  await proveMembersRls(ctx, handle, userC);
  await proveNoOwnerAlert(ctx, handle);

  // The onboarding-completion-vs-fallback-timer race (single role grant + single
  // completion notice) and two simultaneous joins each getting one welcome need the
  // gateway + the fallback timer + a live guild readback.
  gateGatewayReadback(
    ctx,
    'Each racing member holds the member role exactly once and the channel shows exactly one welcome per member; onboarding completion racing the fallback timer never double-grants.',
  );
  gateBrandingNoReply(ctx);
  gateAuditGateway(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

/** XGUILD — welcome flows are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({
    guildId: guildA,
    guildConfigOverrides: { welcome_enabled: true, welcome_message: `${ctx.runPrefix}A-template` },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    guildConfigOverrides: { welcome_enabled: true, welcome_message: `${ctx.runPrefix}B-template` },
  });

  // Fund + snapshot guild A's membership.
  await upsertMember(handleA, userA, { memberNumber: 5, username: 'XG A' });
  const snapA = await readMember(handleA, userA);

  // The SAME user joins guild B: a SEPARATE membership row is created under guild B;
  // guild A's row is untouched.
  await upsertMember(handleB, userA, { memberNumber: 1, username: 'XG B' });
  const rowB = await readMember(handleB, userA);
  const rowAAfter = await readMember(handleA, userA);
  ctx.expect(
    rowB?.guild_id === guildB &&
      rowB?.member_number === 1 &&
      rowAAfter?.member_number === snapA?.member_number &&
      snapA?.member_number === 5,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'Joining guild B creates a distinct membership row under guild B and never mutates guild A’s membership.',
      observation:
        `guild A member_number=${rowAAfter?.member_number} (unchanged at ${snapA?.member_number}=5); ` +
        `guild B member_number=${rowB?.member_number} under guild_id="${rowB?.guild_id}".`,
      impact: 'A cross-guild join mutated another guild’s membership — per-guild isolation broken.',
    },
  );

  // Each guild scope reads its OWN welcome config and never the other guild’s: guild
  // A → A’s distinct template row, guild B → B’s distinct template row (two REAL
  // distinct rows under distinct guild_ids, not a count>=0).
  const cfgA = await readWelcomeConfig(handleA);
  const cfgB = await readWelcomeConfig(handleB);
  ctx.expect(
    cfgA?.welcome_message === `${ctx.runPrefix}A-template` &&
      cfgB?.welcome_message === `${ctx.runPrefix}B-template` &&
      cfgA?.welcome_message !== cfgB?.welcome_message,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild scope reads its OWN welcome config: guild A → A’s template, guild B → B’s template (distinct rows under distinct guild_ids).',
      observation:
        `guild-A welcome_message="${cfgA?.welcome_message}", guild-B welcome_message="${cfgB?.welcome_message}".`,
      impact: 'A guild-scoped welcome-config read returned the other guild’s row — cross-guild leakage.',
    },
  );

  await proveMembersRls(ctx, handleA, userA);
  await proveNoOwnerAlert(ctx, handleA);

  // This isolation scenario seeds membership directly and drives no gateway action,
  // so there is no bot-written audit row here; per-guild audit scoping is covered by
  // the gateway audit lane.
  gateAuditGateway(ctx);
  gateGatewayReadback(
    ctx,
    'Guild B’s welcome uses B’s template and channel while guild A’s welcome channel gains no messages.',
  );
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed membership rows are removed. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    guildConfigOverrides: { welcome_enabled: true, goodbye_enabled: true },
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Create run-prefixed operational rows: two membership records.
  await upsertMember(handle, userA, { memberNumber: 1, username: 'CLEAN A' });
  await upsertMember(handle, userB, { memberNumber: 2, username: 'CLEAN B' });
  const before = await memberCountAll(handle);
  ctx.expect(before >= 2, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed membership rows (pre-cleanup baseline).',
    observation: `pre-cleanup members rows for the scenario guild = ${before}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed membership rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveMembersRls(ctx, handle, userA);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const after = await memberCountAll(handle);
  ctx.expect(after === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed membership rows are deleted; a final sweep finds zero run-prefixed welcome/onboarding resources.',
    observation: `post-sweep members rows for the scenario guild = ${after} (expected 0).`,
    impact: 'The cleanup sweep left run-prefixed membership rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed welcome/goodbye messages and run roles, and
  // the "anonymized-not-deleted" audit history, are separate lanes.
  gateGatewayReadback(
    ctx,
    'No run-prefixed welcome or goodbye messages and no run roles remain in either test guild after cleanup.',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history for the join/onboarding events is anonymized rather than deleted (operational membership rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (the operational membership rows are the DB-observable cleanup evidence here)',
  );
  gateBrandingNoReply(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Welcome & Onboarding domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before the guild row),
 * plus the 12 scenario scripts. `audit_logs` is intentionally NOT swept — audit
 * history is anonymized, never deleted.
 */
export const communityWelcomeOnboardingProof: DomainProof = {
  domainId: 'community-welcome-onboarding',
  guildScopedTables: [
    // Both are direct children of `guild`; `members` holds the onboarding rows and
    // `alerts` holds any owner-notification rows this domain would raise.
    'members',
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
