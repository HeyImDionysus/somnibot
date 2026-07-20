/**
 * scenario-runner/scripts/game-economy-achievements-prestige — the achievements +
 * prestige domain proof.
 *
 * Binds this domain's 12 declarative catalog scenarios to concrete, real-stack
 * proof scripts driven through the REAL production dispatcher (handleInteraction →
 * handleAchievementCommand → AchievementsManager) against LOCAL Supabase. Every
 * DB-observable / captured-reply / RLS assertion runs NOW; anything needing a real
 * Discord effect, a dependency-outage fault lane, a mid-op fault, or the dashboard
 * session-auth lane is GATED — the exact honesty boundary the harness requires.
 *
 * Commands used and why:
 *   - /badges (AchievementsManager.viewBadges) reads economy_achievement_defs +
 *     economy_user_achievements and renders an embed that MASKS hidden, unearned
 *     achievements. Pure Supabase — its DB-backed reply (hidden masking, the
 *     "n/total unlocked" footer, the owner-configured badge name/emoji) is asserted
 *     live against the real captured reply.
 *   - /prestige (AchievementsManager.prestige) checks economy_prestige_enabled, the
 *     member level (member_levels) and net worth (economy_wallets), then atomically*
 *     resets the wallet/bank and upserts economy_prestige. Pure Supabase — the reset,
 *     the prestige record (level / multiplier / total_resets) and the reply embed are
 *     asserted live.
 *
 * Behavior-bug discovery (per packages/e2e/catalog/INTENT-DELTAS.md):
 *   - prestige() has NO persisted idempotency key, so re-delivering one /prestige
 *     interaction DOUBLE-APPLIES when the member stays eligible (net-worth floor 0).
 *     REPLAY drives this deterministically and records a FAIL — a real finding, never
 *     softened to green.
 *   - prestige() is non-atomic (eligibility read, then a separate record read/write,
 *     with no advisory lock). The UNIQUE(guild_id,user_id) constraint still prevents a
 *     duplicate prestige ROW under concurrency (RACE asserts that), but the surviving
 *     prestige_level is timing-dependent; RACE gates the exactly-one-increment facet
 *     with an explicit code-gap reason.
 *   - The prestige cap (catalog control prestige-max-level, default 10) is unimplemented
 *     in code and has no guild_config column; DEF gates that facet loudly.
 *   - The passive milestone-unlock pipeline (checkAndUnlock) has NO production caller /
 *     slash trigger and would be driven by gateway activity events, so its unlock +
 *     reward-payout facets are GATED (undrivable in this gateway-less bot-only harness).
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface PrestigeRow {
  prestige_level: number;
  total_resets: number;
  multiplier_pct: number;
  user_id: string;
  guild_id: string;
}

interface EconomyDisplay {
  currencyName: string;
  currencyEmoji: string;
}

interface SeededDef {
  id: string | null;
  name: string;
  emoji: string;
  description: string;
}

interface SeededDefs {
  visible: SeededDef;
  hidden: SeededDef;
}

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function display(handle: LiveClientHandle): EconomyDisplay {
  return { currencyName: handle.economy.currencyName, currencyEmoji: handle.economy.currencyEmoji };
}

async function readWallet(handle: LiveClientHandle, userId: string): Promise<WalletRow | null> {
  const { data } = await handle.supabase
    .from('economy_wallets')
    .select('wallet, bank, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletRow | null) ?? null;
}

/** Arrange an exact wallet/bank via the REAL wallet initializer, then a precise set. */
async function seedWallet(
  handle: LiveClientHandle,
  userId: string,
  wallet: number,
  bank = 0,
): Promise<void> {
  await handle.supabase.rpc('economy_get_or_create_wallet', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
  });
  await handle.supabase
    .from('economy_wallets')
    .update({ wallet, bank })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
}

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/** Seed the member's leveling row (the level threshold /prestige reads). */
async function seedMemberLevel(handle: LiveClientHandle, userId: string, level: number): Promise<void> {
  await handle.supabase
    .from('member_levels')
    .upsert({ guild_id: handle.guildId, member_id: userId, level }, { onConflict: 'guild_id,member_id' });
}

/** Insert one owner-authored achievement definition; return its id. */
async function insertDef(
  handle: LiveClientHandle,
  def: { name: string; emoji: string; description: string; hidden: boolean; reward: number },
): Promise<string | null> {
  const { data } = await handle.supabase
    .from('economy_achievement_defs')
    .insert({
      guild_id: handle.guildId,
      name: def.name,
      badge_emoji: def.emoji,
      description: def.description,
      hidden: def.hidden,
      reward_currency: def.reward,
      condition_type: 'generic',
      condition_value: 1,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Seed the two owner-authored definitions every /badges assertion needs: one
 * visible (name/emoji rendered) and one hidden (masked until earned). Run-prefixed
 * names keep the rows attributable + sweepable.
 */
async function seedDefs(ctx: ScenarioContext, handle: LiveClientHandle): Promise<SeededDefs> {
  const visible: SeededDef = {
    id: null,
    name: `${ctx.runPrefix}First Steps`,
    emoji: '🥇',
    description: 'Complete your first tracked action',
  };
  const hidden: SeededDef = {
    id: null,
    name: `${ctx.runPrefix}Hidden Vault`,
    emoji: '🗝️',
    description: 'A secret milestone',
  };
  visible.id = await insertDef(handle, {
    name: visible.name,
    emoji: visible.emoji,
    description: visible.description,
    hidden: false,
    reward: 0,
  });
  hidden.id = await insertDef(handle, {
    name: hidden.name,
    emoji: hidden.emoji,
    description: hidden.description,
    hidden: true,
    reward: 0,
  });
  return { visible, hidden };
}

/** Arrange an unlocked badge row (the service-role "arrange" the milestone pipeline would do). */
async function insertUnlock(handle: LiveClientHandle, userId: string, achievementId: string): Promise<void> {
  await handle.supabase
    .from('economy_user_achievements')
    .insert({ guild_id: handle.guildId, user_id: userId, achievement_id: achievementId });
}

async function userAchievementCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_user_achievements')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function defCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_achievement_defs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function readPrestige(handle: LiveClientHandle, userId: string): Promise<PrestigeRow | null> {
  const { data } = await handle.supabase
    .from('economy_prestige')
    .select('prestige_level, total_resets, multiplier_pct, user_id, guild_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as PrestigeRow | null) ?? null;
}

async function prestigeCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_prestige')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
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

function truncate(text: string, max = 90): string {
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
 * Anon-denial RLS probe via the PostgREST REST endpoint. Returns the number of rows
 * an anon key can read (v6 REVOKE ALL FROM anon → 0), or null when no anon key is
 * available / the probe is inconclusive (→ GATE).
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (SQLSTATE 42501, the deny we
    // want) from the KEY being rejected before authz ran (inconclusive → GATE).
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

function gateBrandKitReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/**
 * Prove the /badges surface renders the OWNER-configured badge name + emoji (owner
 * content, not stock-bot wording), checked against the REAL captured reply. The full
 * brand-kit conformance (colors/voice/attribution) stays GATED behind the snapshot lane.
 */
function proveBadgeBranding(ctx: ScenarioContext, captured: CapturedResponse, def: SeededDef): void {
  const surface = brandingSurface(captured);
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      'Member-facing achievements surfaces show the owner-configured badge name and emoji.',
      'this scenario produced no member-facing /badges reply/embed to inspect for owner-configured branding',
    );
  } else {
    const hasName = surface.includes(def.name);
    const hasEmoji = surface.includes(def.emoji);
    ctx.expect(hasName && hasEmoji, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise:
        'The /badges surface renders the owner-configured badge name and emoji (owner content, zero stock-bot placeholder wording).',
      observation:
        `reply surface "${truncate(surface)}" ${hasName ? 'includes' : 'omits'} owner badge name "${def.name}" ` +
        `and ${hasEmoji ? 'includes' : 'omits'} its emoji "${def.emoji}".`,
      impact: 'A /badges reply did not reflect the owner-configured badge definition (stock-bot wording leaked).',
    });
  }
  gateBrandKitReadback(ctx);
}

/** Prestige-only surfaces carry no owner-configurable token; GATE captured-reply branding honestly. */
function gatePrestigeBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing prestige surfaces carry the owner brand voice and the subtle powered-by-SomniBot attribution.',
    'the /prestige reply uses a hardcoded title/color/wording with no owner-configured token to verify in-process; full brand-kit conformance needs the live embed-snapshot readback lane',
  );
  gateBrandKitReadback(ctx);
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
    'Failure-branch alerts (badge-reward-delayed, dependency-degradation) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Anon-denial isolation probe made non-vacuous by a positive control: the scenario
 * has already created a real row under this guild that the service role sees, so an
 * anon client reading ZERO of them is a genuine deny (v6 REVOKE ALL FROM anon), not
 * "nothing to read." Cross-GUILD isolation across two real guilds is proven in XGUILD.
 */
async function proveAnonDenied(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  positivePresent: boolean,
  positiveDesc: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (v6 REVOKE ALL FROM anon).`,
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
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
  ctx.expect(positivePresent && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} row while an anon client reads zero of them (v6 REVOKE ALL FROM anon).`,
    observation:
      `service-role sees ${positiveDesc} under guild "${handle.guildId}" (${positivePresent}); ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — anon is not denied (direct data exposure).`,
  });
}

/** No append-only audit ledger is emitted by the bot-only command path for this domain. */
function gateAudit(ctx: ScenarioContext, reason: string): void {
  ctx.gate('audit', 'audit-row', 'Every achievements-and-prestige state change lands exactly one append-only audit row with actor, guild, and correlation id.', reason);
}

const AUDIT_NO_LEDGER =
  'the /badges and /prestige handlers write no dedicated append-only audit_logs row; the economy_prestige record is mutable state (upserted, total_resets incremented), not an append-only ledger — no audit ledger is emitted on the bot-only command path for this domain';

/** The passive milestone-unlock + reward-payout path is undrivable here. */
function gateMilestonePipeline(ctx: ScenarioContext, assertionClass: 'Discord' | 'audit' | 'replay-safety'): void {
  ctx.gate(
    assertionClass,
    'discord-readback',
    'A tracked milestone crossing inserts exactly one badge row and pays its play-money reward exactly once, posting one unlock embed.',
    'the passive milestone-check pipeline (AchievementsManager.checkAndUnlock) has no production caller / slash trigger and would be driven by gateway activity events (messages/xp/economy actions); a gateway-less bot-only harness cannot deliver those trigger events',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    "Re-delivering this scenario's triggers yields no duplicate badge unlocks, reward payouts, or prestige resets.",
    `prestige-replay idempotency is exercised directly in the ${where} scenario`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The unlock/prestige embeds are observed working in the live test guild (channel embeds).',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/embed readback',
  );
}

// ── Higher-level drivers shared by scenarios ──────────────────────────────

/**
 * Run /badges and assert: hidden achievements masked (name never leaked), the visible
 * owner-authored badge rendered, the footer's unlocked/total matches the DB, and the
 * owner-configured branding is present. Returns the captured reply.
 */
async function proveBadgesView(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  defs: SeededDefs,
  opts: { visibleUnlocked: boolean },
): Promise<CapturedResponse> {
  const captured = await ctx.runSlash(handle, {
    commandName: 'badges',
    userId,
    displayName: `${ctx.runPrefix}viewer`,
  });
  const surface = brandingSurface(captured);
  const embed = replyEmbedData(captured);

  const hiddenLeaked = surface.includes(defs.hidden.name);
  const masksHidden = surface.includes('Hidden achievement') && !hiddenLeaked;
  const showsVisible = surface.includes(defs.visible.name);
  ctx.expect(masksHidden && showsVisible, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise:
      '/badges lists every definition, renders the visible/earned badge by name, and masks the hidden achievement as unknown until earned.',
    observation:
      `surface "${truncate(surface)}" shows visible "${defs.visible.name}"=${showsVisible}, ` +
      `masks hidden as "Hidden achievement"=${surface.includes('Hidden achievement')}, leaks hidden name=${hiddenLeaked}.`,
    impact: 'The /badges view leaked a hidden achievement or failed to render a definition.',
  });

  const footer = (embed?.footer as { text?: string } | undefined)?.text ?? '';
  const expectedUnlocked = opts.visibleUnlocked ? 1 : 0;
  ctx.expect(footer.includes(`${expectedUnlocked}/2 unlocked`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: "The /badges footer reports the member's unlocked count over the total definitions, matching the DB.",
    observation: `footer="${footer}" (expected "${expectedUnlocked}/2 unlocked" from ${expectedUnlocked} unlocked of 2 defs).`,
    impact: 'The /badges progress footer did not match the persisted unlock rows.',
  });

  proveBadgeBranding(ctx, captured, defs.visible);
  return captured;
}

/** Drive /prestige and assert a successful atomic reset + prestige record + reply embed. */
async function provePrestigeSuccess(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  expect: { level: number; multiplier: number },
): Promise<CapturedResponse> {
  const captured = await ctx.runSlash(handle, {
    commandName: 'prestige',
    userId,
    displayName: `${ctx.runPrefix}prestiger`,
  });
  const row = await readPrestige(handle, userId);
  const wallet = await readWallet(handle, userId);
  ctx.expect(
    row?.prestige_level === expect.level &&
      row?.multiplier_pct === expect.multiplier &&
      row?.total_resets === 1 &&
      wallet?.wallet === 0 &&
      wallet?.bank === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `/prestige atomically zeroes wallet+bank and records prestige level ${expect.level} with a +${expect.multiplier}% permanent multiplier.`,
      observation:
        `prestige_level=${row?.prestige_level} (expected ${expect.level}), multiplier_pct=${row?.multiplier_pct} ` +
        `(expected ${expect.multiplier}), total_resets=${row?.total_resets} (expected 1); ` +
        `wallet=${wallet?.wallet}/bank=${wallet?.bank} (expected 0/0).`,
      impact: 'A /prestige did not reset balances or record the bounded multiplier as contracted.',
    },
  );
  const embed = replyEmbedData(captured);
  const title = typeof embed?.title === 'string' ? embed.title : '';
  const desc = typeof embed?.description === 'string' ? embed.description : '';
  ctx.expect(title.includes(`Prestige Level ${expect.level}`) && desc.includes(`${expect.multiplier}%`), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: `The /prestige embed shows prestige ${expect.level} with a +${expect.multiplier}% multiplier.`,
    observation: `embed title="${title}", description mentions ${expect.multiplier}%=${desc.includes(`${expect.multiplier}%`)}.`,
    impact: 'The /prestige reply did not render the new prestige level / multiplier.',
  });
  return captured;
}

/** Drive /prestige expecting a refusal; assert the refusal text and that NO prestige row was written. */
async function provePrestigeRefused(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  userId: string,
  expectToken: string,
  promise: string,
): Promise<CapturedResponse> {
  const captured = await ctx.runSlash(handle, {
    commandName: 'prestige',
    userId,
    displayName: `${ctx.runPrefix}prestiger`,
  });
  const content = replyContent(captured);
  const count = await prestigeCount(handle, userId);
  ctx.expect(content.includes(expectToken) && count === 0, {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise,
    observation: `refusal reply="${truncate(content)}" (expected to mention "${expectToken}"); economy_prestige rows for the member=${count} (expected 0, no reset).`,
    impact: 'A /prestige that should have been refused either used the wrong message or wrote a prestige record anyway.',
  });
  return captured;
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — default badges (hidden masked) + a default-threshold prestige (+10% at level 50 / 1M net worth). */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const minLevel = Number(declaredDefault(ctx.domain, 'prestige-min-level'));
  const minNetWorth = Number(declaredDefault(ctx.domain, 'prestige-min-net-worth'));
  const step = Number(declaredDefault(ctx.domain, 'prestige-multiplier-step-pct'));
  const maxLevel = Number(declaredDefault(ctx.domain, 'prestige-max-level'));

  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: minLevel,
      economy_prestige_min_net_worth: minNetWorth,
      economy_prestige_multiplier_pct: step,
    },
  });
  const userA = ctx.userId('a');

  // (1) /badges: hidden achievement masked, visible one rendered unlocked, footer 1/2.
  const defs = await seedDefs(ctx, handle);
  if (defs.visible.id) await insertUnlock(handle, userA, defs.visible.id);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: true });

  // (2) /prestige at the DEFAULT thresholds: level 50 + 1,000,000 net worth → +10% multiplier.
  await seedMemberLevel(handle, userA, minLevel);
  await seedWallet(handle, userA, minNetWorth, 0);
  await provePrestigeSuccess(ctx, handle, userA, { level: 1, multiplier: step });

  // The passive milestone unlock + reward payout is undrivable here.
  gateMilestonePipeline(ctx, 'Discord');

  // The prestige cap is unimplemented AND unreachable at defaults (net worth resets below 1M).
  ctx.gate(
    'Discord',
    'db-observable',
    `A member already at prestige-max-level (${maxLevel}) is refused with the branded prestige-capped message; the permanent multiplier is bounded by the owner-set cap.`,
    `the prestige cap (control prestige-max-level, default ${maxLevel}) is UNIMPLEMENTED in code and has no guild_config column (INTENT-DELTAS [CONFLICT]); default thresholds also allow only a single prestige (the reset drops net worth below the ${minNetWorth} floor), so the cap boundary is unreachable here — flagged as a finding for the owner`,
  );

  await proveAnonDenied(ctx, handle, 'economy_prestige', (await readPrestige(handle, userA)) !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, AUDIT_NO_LEDGER);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — dashboard config takes live effect: lowered thresholds (level 2 / 1,000) + raised step (25%). */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 2,
      economy_prestige_min_net_worth: 1000,
      economy_prestige_multiplier_pct: 25,
    },
  });
  const userA = ctx.userId('a');

  // With the lowered thresholds saved live, a level-2 / 1,000-net-worth member prestiges,
  // and the raised 25% step is applied — no bot restart.
  await seedMemberLevel(handle, userA, 2);
  await seedWallet(handle, userA, 1000, 0);
  await provePrestigeSuccess(ctx, handle, userA, { level: 1, multiplier: 25 });

  // /badges still works under the new config (visible unlocked → footer 1/2).
  const defs = await seedDefs(ctx, handle);
  if (defs.visible.id) await insertUnlock(handle, userA, defs.visible.id);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: true });

  await proveAnonDenied(ctx, handle, 'economy_prestige', (await readPrestige(handle, userA)) !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, AUDIT_NO_LEDGER);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — the prestige piece is disabled independently: /prestige refuses while /badges keeps working. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true, // wires the manager AND keeps badges alive
      economy_prestige_enabled: false, // the piece under test — off
    },
  });
  const userA = ctx.userId('a');

  // Even for a member who WOULD qualify, /prestige returns the piece-disabled refusal
  // and writes no prestige record — proving the toggle acts independently.
  await seedMemberLevel(handle, userA, 100);
  await seedWallet(handle, userA, 5_000_000, 0);
  await provePrestigeRefused(
    ctx,
    handle,
    userA,
    'not enabled',
    'With economy_prestige_enabled off, /prestige returns the piece-disabled refusal and writes no economy_prestige row.',
  );

  // Badges keep unlocking/displaying while prestige is off (visible unlocked → footer 1/2).
  const defs = await seedDefs(ctx, handle);
  if (defs.visible.id) await insertUnlock(handle, userA, defs.visible.id);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: true });

  // The actual "fresh milestone still unlocks + pays reward" facet is undrivable here.
  gateMilestonePipeline(ctx, 'audit');

  await proveAnonDenied(ctx, handle, 'economy_user_achievements', (await userAchievementCount(handle, userA)) > 0, "the member's unlocked-badge row");
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid config never persists; the next /prestige is judged against the prior valid thresholds. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 2,
      economy_prestige_min_net_worth: 1000,
      economy_prestige_multiplier_pct: 25,
    },
  });
  const userA = ctx.userId('a');

  // DB-observable core: guild_config retains its prior VALID thresholds byte-for-byte.
  const { data: cfgRow } = await handle.supabase
    .from('guild_config')
    .select('economy_prestige_min_level, economy_prestige_min_net_worth, economy_prestige_multiplier_pct')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const row = cfgRow as
    | { economy_prestige_min_level: number; economy_prestige_min_net_worth: number; economy_prestige_multiplier_pct: number }
    | null;
  ctx.expect(
    row?.economy_prestige_min_level === 2 &&
      Number(row?.economy_prestige_min_net_worth) === 1000 &&
      row?.economy_prestige_multiplier_pct === 25,
    {
      assertionClass: 'database-RLS',
      channel: 'db-observable',
      promise: 'guild_config keeps its prior valid thresholds byte-for-byte (a rejected invalid save never persists).',
      observation:
        `guild_config holds min_level=${row?.economy_prestige_min_level} (expected 2), ` +
        `min_net_worth=${row?.economy_prestige_min_net_worth} (expected 1000), ` +
        `multiplier_pct=${row?.economy_prestige_multiplier_pct} (expected 25).`,
      impact: 'A valid prestige configuration was not retained.',
    },
  );

  // A below-threshold /prestige immediately after is still refused against the PRIOR valid
  // level (2), proving no invalid partial write (e.g. a zero minimum level) reached the bot.
  await seedMemberLevel(handle, userA, 1); // below the valid min_level of 2
  await seedWallet(handle, userA, 100, 0);
  await provePrestigeRefused(
    ctx,
    handle,
    userA,
    'level 2',
    'The next /prestige is judged against the previous valid level threshold (2), proving no invalid partial write reached the bot.',
  );

  // /badges still renders normally after the rejected save.
  const defs = await seedDefs(ctx, handle);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: false });

  // The actual REJECTION lives in the dashboard Zod layer; guild_config carries no CHECK
  // constraint, so the reject path is not reachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard achievements page surfaces a clear validation error for a zero minimum level / negative net worth / out-of-range multiplier step.',
    'config validation lives in the dashboard (Zod) layer; guild_config has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  gateAudit(ctx, 'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)');

  await proveAnonDenied(ctx, handle, 'economy_achievement_defs', (await defCount(handle)) > 0, "this guild's achievement definitions");
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — members cannot self-grant badges; a non-admin dashboard save is refused. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 50,
      economy_prestige_min_net_worth: 1000000,
      economy_prestige_multiplier_pct: 10,
    },
  });
  const userB = ctx.userId('b');

  const defs = await seedDefs(ctx, handle);

  // run-member-b exhausts every member-facing surface: /badges (view only) and /prestige
  // (refused — level 0). Neither surface inserts a badge row.
  await proveBadgesView(ctx, handle, userB, defs, { visibleUnlocked: false });
  await provePrestigeRefused(
    ctx,
    handle,
    userB,
    'level 50',
    'A non-qualifying member is refused /prestige (below the level threshold) and writes no economy_prestige row.',
  );

  // Core UNAUTH proof: after exhausting member surfaces, the member holds ZERO unlock rows —
  // badges unlock only through the passive milestone pipeline, never a member-facing command.
  const bBadges = await userAchievementCount(handle, userB);
  ctx.expect(bBadges === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'No member-facing surface self-grants a badge: after running every member command, run-member-b holds zero economy_user_achievements rows.',
    observation: `run-member-b holds ${bBadges} economy_user_achievements row(s) after /badges + /prestige (expected 0).`,
    impact: 'A member-facing command inserted a badge row — members can self-grant achievements.',
  });

  // The non-admin dashboard save refusal + its denied-config audit row live on the
  // dashboard session-auth lane, not reachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot alter achievement definitions or prestige thresholds; the save returns an authorization error.',
    'requires the dashboard session-auth lane (RLS + session auth) — not reachable in this bot-only harness',
  );
  gateAudit(ctx, 'the denied-configuration audit row (actor + reason permission-denied) is written by the dashboard save path — not reachable in a bot-only harness');

  await proveAnonDenied(ctx, handle, 'economy_achievement_defs', (await defCount(handle)) > 0, "this guild's achievement definitions");
  await proveNoOwnerAlert(ctx, handle);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage. (Note: the branded
  // "achievements-unavailable" degradation template also appears unimplemented in
  // viewBadges/prestige — surfaced in the run summary for the owner.)
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /badges and /prestige reply with the branded achievements-unavailable message and lose no unlocks; after restoration the identical inventory renders.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'After restoration a deferred milestone unlocks exactly once and its ledger row lands.',
    'requires the outage fault lane and the (undrivable) passive milestone pipeline',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate unlock or reward survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded achievements-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the achievements-unavailable branch (which also appears unimplemented in code)',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Achievement/prestige rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a badge whose reward payout fails: the badge stands and the retried payout lands exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The reward-degraded branch triggers only when economy_add_balance FAILS during the
  // passive milestone unlock — a path that is itself undrivable here (no milestone
  // trigger) AND needs a mid-op fault injected at the wallet-RPC boundary. GATE the
  // fault-dependent proof; do not fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault on the reward payout, /badges shows the badge unlocked and after the retry the wallet shows exactly one reward credit.',
    'requires the (undrivable) passive milestone pipeline plus a mid-op fault-injection lane (fail economy_add_balance for the badge reward)',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'The badge row stands and is never rolled back; the payout retries under one idempotency key until it lands exactly once.',
    'requires the milestone pipeline + reward-payout fault-injection lane',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The failed payout attempt and its retry resolve under one idempotency key to exactly one play-money credit; the badge row is never duplicated.',
    'requires the milestone pipeline + reward-payout fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The unlock surface stays branded through the degraded-reward window.',
    'requires the milestone pipeline + reward-payout fault-injection lane',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'The retried payout touches only the member’s guild-scoped wallet.',
    'requires the milestone pipeline + reward-payout fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A single badge-reward-delayed alert with badge + member context is raised to the owner while the payout is queued for retry.',
    'requires the reward-payout fault-injection lane plus owner alert channel readback',
  );
}

/** REPLAY — re-delivering one /prestige interaction must not double-apply. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 1,
      economy_prestige_min_net_worth: 0, // keeps the member eligible AFTER a reset — the true idempotency probe
      economy_prestige_multiplier_pct: 10,
    },
  });
  const userA = ctx.userId('a');

  await seedMemberLevel(handle, userA, 1);
  await seedWallet(handle, userA, 100, 0);

  // Deliver the SAME /prestige interaction id twice (sequentially). With a net-worth floor
  // of 0 the member stays eligible after the first reset, so a NON-idempotent prestige
  // applies a SECOND time. The contract promises exactly one reset per logical action.
  const prestigeId = `${ctx.runPrefix}prestige-int`;
  await ctx.runSlash(handle, { commandName: 'prestige', userId: userA, interactionId: prestigeId, displayName: `${ctx.runPrefix}prestiger` });
  await ctx.runSlash(handle, { commandName: 'prestige', userId: userA, interactionId: prestigeId, displayName: `${ctx.runPrefix}prestiger` });
  const row = await readPrestige(handle, userA);
  ctx.expect(row?.prestige_level === 1 && row?.total_resets === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Re-delivering one /prestige interaction leaves exactly one reset: persisted idempotency keeps prestige_level at 1 and total_resets at 1.',
    observation:
      `after TWO deliveries of one /prestige interaction id: prestige_level=${row?.prestige_level}, total_resets=${row?.total_resets} ` +
      `(exactly-once reads 1/1; a double-apply reads 2/2). prestige() persists NO idempotency key (INTENT-DELTAS [GAP]).`,
    impact:
      'A re-delivered identical /prestige DOUBLE-APPLIED — prestige has no idempotency key, so a retried/duplicated interaction resets the wallet and bumps the multiplier twice (a real replay-safety defect on the money path).',
  });

  // The badge-unlock replay facet (one badge row / one reward per re-delivered milestone)
  // is undrivable — no milestone trigger.
  gateMilestonePipeline(ctx, 'replay-safety');

  // Give branding a real /badges surface to inspect.
  const defs = await seedDefs(ctx, handle);
  if (defs.visible.id) await insertUnlock(handle, userA, defs.visible.id);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: true });

  await proveAnonDenied(ctx, handle, 'economy_prestige', row !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, AUDIT_NO_LEDGER);
  gateLiveGuildReadback(ctx);
}

/** RESTART — badge + prestige state survives a full stack reboot (it lives in Supabase). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');
  const overrides = {
    economy_achievements_enabled: true,
    economy_prestige_enabled: true,
    economy_prestige_min_level: 1,
    economy_prestige_min_net_worth: 0,
    economy_prestige_multiplier_pct: 10,
  };

  // Boot #1: seed defs + an unlocked badge, then prestige once; snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0, guildConfigOverrides: overrides });
  const defs = await seedDefs(ctx, first);
  if (defs.visible.id) await insertUnlock(first, userA, defs.visible.id);
  await seedMemberLevel(first, userA, 1);
  await seedWallet(first, userA, 100, 0);
  await ctx.runSlash(first, { commandName: 'prestige', userId: userA, displayName: `${ctx.runPrefix}prestiger` });
  const snapshot = await readPrestige(first, userA);
  const unlocksBefore = await userAchievementCount(first, userA);
  await first.cleanup(); // simulate shutdown (dispose only — NOT a sweep)

  // Boot #2: SAME guild id (restart). Badge + prestige state must be identical.
  const second = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0, guildConfigOverrides: overrides });
  const afterRestart = await readPrestige(second, userA);
  const walletAfter = await readWallet(second, userA);
  ctx.expect(
    afterRestart?.prestige_level === snapshot?.prestige_level &&
      afterRestart?.multiplier_pct === snapshot?.multiplier_pct &&
      afterRestart?.prestige_level === 1 &&
      afterRestart?.multiplier_pct === 10 &&
      walletAfter?.wallet === 0 &&
      walletAfter?.bank === 0,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'After a full stack restart, the prestige record (level + multiplier) and the reset wallet match the pre-restart snapshot exactly.',
      observation:
        `pre-restart level=${snapshot?.prestige_level}/mult=${snapshot?.multiplier_pct}; ` +
        `post-restart level=${afterRestart?.prestige_level}/mult=${afterRestart?.multiplier_pct}, ` +
        `wallet=${walletAfter?.wallet}/bank=${walletAfter?.bank} (expected 1 / 10 / 0 / 0).`,
      impact: 'Prestige state did not survive a restart — persisted level/multiplier were lost or altered.',
    },
  );

  // Badges survive too: post-restart /badges still shows the unlocked badge (footer 1/2).
  await proveBadgesView(ctx, second, userA, defs, { visibleUnlocked: true });
  const unlocksAfter = await userAchievementCount(second, userA);
  ctx.expect(unlocksAfter === unlocksBefore && unlocksAfter === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The unlocked-badge inventory is byte-identical across the restart.',
    observation: `unlocked rows pre-restart=${unlocksBefore}, post-restart=${unlocksAfter} (expected 1 both).`,
    impact: 'An unlocked badge row did not survive the restart.',
  });

  // The "in-flight milestone completes exactly once post-restart" facet is undrivable.
  gateMilestonePipeline(ctx, 'replay-safety');

  await proveAnonDenied(ctx, second, 'economy_prestige', afterRestart !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, second);
  gateAudit(ctx, AUDIT_NO_LEDGER);
}

/** RACE — concurrent /prestige never creates a duplicate prestige record (UNIQUE guard). */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 1,
      economy_prestige_min_net_worth: 1000,
      economy_prestige_multiplier_pct: 10,
    },
  });
  const userA = ctx.userId('a');

  await seedMemberLevel(handle, userA, 1);
  await seedWallet(handle, userA, 1000, 0);

  // Two simultaneous /prestige confirmations (distinct interaction ids — two real clicks).
  await Promise.all([
    ctx.runSlash(handle, { commandName: 'prestige', userId: userA, interactionId: `${ctx.runPrefix}race-1`, displayName: `${ctx.runPrefix}prestiger` }),
    ctx.runSlash(handle, { commandName: 'prestige', userId: userA, interactionId: `${ctx.runPrefix}race-2`, displayName: `${ctx.runPrefix}prestiger` }),
  ]);
  const count = await prestigeCount(handle, userA);
  const row = await readPrestige(handle, userA);
  ctx.expect(count === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Concurrent /prestige confirmations never create a duplicate prestige record: exactly one economy_prestige row survives (UNIQUE(guild_id,user_id)).',
    observation:
      `after two simultaneous /prestige: economy_prestige rows for the member=${count} (expected 1); ` +
      `observed prestige_level=${row?.prestige_level}, total_resets=${row?.total_resets}.`,
    impact: 'Concurrent /prestige created duplicate prestige records — the UNIQUE guard failed.',
  });

  // Exactly-one-increment is NOT deterministically observable: prestige() is non-atomic.
  ctx.gate(
    'Discord',
    'db-observable',
    'Two simultaneous /prestige yield exactly one increment and one refusal (the surviving prestige_level is exactly one step).',
    'prestige() is non-atomic — eligibility is read before the prestige-record read/write with no advisory lock or idempotency key (INTENT-DELTAS [GAP]); the surviving prestige_level under true concurrency is timing-dependent (1 or 2), so exactly-one-increment cannot be asserted deterministically in-process — surfaced as a concurrency finding for the owner',
  );
  // Concurrent milestone crossing → exactly one badge row: undrivable (no milestone trigger).
  gateMilestonePipeline(ctx, 'replay-safety');

  await proveAnonDenied(ctx, handle, 'economy_prestige', row !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, handle);
  gateAudit(ctx, AUDIT_NO_LEDGER);
  gatePrestigeBranding(ctx);
}

/** XGUILD — badges + prestige are strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const overrides = {
    economy_achievements_enabled: true,
    economy_prestige_enabled: true,
    economy_prestige_min_level: 1,
    economy_prestige_min_net_worth: 0,
    economy_prestige_multiplier_pct: 10,
  };
  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0, guildConfigOverrides: overrides });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0, guildConfigOverrides: overrides });

  // Guild A: unlock a badge + prestige once, then snapshot.
  const defsA = await seedDefs(ctx, handleA);
  if (defsA.visible.id) await insertUnlock(handleA, userA, defsA.visible.id);
  await seedMemberLevel(handleA, userA, 1);
  await seedWallet(handleA, userA, 100, 0);
  await ctx.runSlash(handleA, { commandName: 'prestige', userId: userA, displayName: `${ctx.runPrefix}prestiger` });
  const snapA = await readPrestige(handleA, userA);
  const unlocksA = await userAchievementCount(handleA, userA);

  // Guild B: the SAME user prestiges under guild B's own records.
  await seedMemberLevel(handleB, userA, 1);
  await seedWallet(handleB, userA, 100, 0);
  await ctx.runSlash(handleB, { commandName: 'prestige', userId: userA, displayName: `${ctx.runPrefix}prestiger` });

  // Guild A's prestige record + badge inventory are untouched by guild B's activity.
  const afterA = await readPrestige(handleA, userA);
  const unlocksAAfter = await userAchievementCount(handleA, userA);
  const rowB = await readPrestige(handleB, userA);
  ctx.expect(
    afterA?.prestige_level === snapA?.prestige_level &&
      afterA?.prestige_level === 1 &&
      unlocksAAfter === unlocksA &&
      rowB?.guild_id === guildB &&
      rowB?.prestige_level === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: "Prestiging in a second guild never touches the first guild's prestige level or badges; each guild's records evolve independently.",
      observation:
        `guild A prestige_level=${afterA?.prestige_level} (unchanged at ${snapA?.prestige_level}=1), unlocks=${unlocksAAfter} (unchanged at ${unlocksA}); ` +
        `guild B prestige_level=${rowB?.prestige_level} under guild_id="${rowB?.guild_id}".`,
      impact: "Cross-guild activity mutated another guild's prestige/badge state — per-guild isolation broken.",
    },
  );

  // Each guild scope reads its OWN prestige row and never the other's.
  const { data: aScoped } = await handleA.supabase
    .from('economy_prestige')
    .select('prestige_level, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .maybeSingle();
  const { data: bScoped } = await handleB.supabase
    .from('economy_prestige')
    .select('prestige_level, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .maybeSingle();
  const aRow = aScoped as { prestige_level: number; guild_id: string } | null;
  const bRow = bScoped as { prestige_level: number; guild_id: string } | null;
  ctx.expect(aRow?.guild_id === guildA && bRow?.guild_id === guildB && aRow?.prestige_level === 1 && bRow?.prestige_level === 1, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: "Each guild scope reads its OWN economy_prestige row and never the other guild's — distinct rows under distinct guild_ids.",
    observation:
      `guild-A-scoped read = level ${aRow?.prestige_level} under "${aRow?.guild_id}"; ` +
      `guild-B-scoped read = level ${bRow?.prestige_level} under "${bRow?.guild_id}".`,
    impact: "A guild-scoped read returned the other guild's prestige row — cross-guild leakage.",
  });
  await proveAnonDenied(ctx, handleA, 'economy_prestige', afterA !== null, "guild A's prestige record");

  // Branding surface from guild B's /badges.
  await proveBadgesView(ctx, handleB, userA, await seedDefsForGuildB(ctx, handleB), { visibleUnlocked: false });

  gateAudit(ctx, 'this cross-guild isolation scenario writes no append-only audit ledger; per-guild scoping is proven via distinct guild_id-scoped rows above');
  await proveNoOwnerAlert(ctx, handleA);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** Guild B needs its own definitions (distinct from guild A) for the branding surface. */
async function seedDefsForGuildB(ctx: ScenarioContext, handle: LiveClientHandle): Promise<SeededDefs> {
  return seedDefs(ctx, handle);
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_achievements_enabled: true,
      economy_prestige_enabled: true,
      economy_prestige_min_level: 1,
      economy_prestige_min_net_worth: 0,
      economy_prestige_multiplier_pct: 10,
    },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: defs, an unlocked badge, a wallet, a prestige record.
  const defs = await seedDefs(ctx, handle);
  if (defs.visible.id) await insertUnlock(handle, userA, defs.visible.id);
  await seedMemberLevel(handle, userA, 1);
  await seedWallet(handle, userA, 100, 0);
  await ctx.runSlash(handle, { commandName: 'prestige', userId: userA, displayName: `${ctx.runPrefix}prestiger` });

  const defsBefore = await defCount(handle);
  const unlocksBefore = await userAchievementCount(handle, userA);
  const prestigeBefore = await prestigeCount(handle, userA);
  const walletsBefore = await walletCount(handle, userA);
  ctx.expect(defsBefore >= 2 && unlocksBefore >= 1 && prestigeBefore >= 1 && walletsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed definition, badge, prestige, and wallet rows (pre-cleanup baseline).',
    observation: `pre-cleanup: defs=${defsBefore}, unlocks=${unlocksBefore}, prestige=${prestigeBefore}, wallets=${walletsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveAnonDenied(ctx, handle, 'economy_prestige', (await readPrestige(handle, userA)) !== null, "the member's prestige record");
  await proveNoOwnerAlert(ctx, handle);
  await proveBadgesView(ctx, handle, userA, defs, { visibleUnlocked: true });

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows remain.
  await ctx.sweepGuildRows(handle);
  const defsAfter = await defCount(handle);
  const unlocksAfter = await userAchievementCount(handle, userA);
  const prestigeAfter = await prestigeCount(handle, userA);
  const walletsAfter = await walletCount(handle, userA);
  ctx.expect(defsAfter === 0 && unlocksAfter === 0 && prestigeAfter === 0 && walletsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed achievement definitions, badge rows, prestige records, and wallet entries are deleted; a final sweep finds zero run-prefixed resources.',
    observation: `post-sweep: defs=${defsAfter}, unlocks=${unlocksAfter}, prestige=${prestigeAfter}, wallets=${walletsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed embeds, and audit "anonymized-not-deleted" history,
  // are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed unlock or prestige embeds after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  gateAudit(ctx, 'audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained) — an audit_logs anonymization readback lane; the operational rows are the DB-observable cleanup evidence here');
  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The achievements + prestige domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before the guild row), plus
 * the 12 scenario scripts.
 */
export const gameEconomyAchievementsPrestigeProof: DomainProof = {
  domainId: 'game-economy-achievements-prestige',
  guildScopedTables: [
    'economy_user_achievements', // FK → economy_achievement_defs (child first)
    'economy_achievement_defs',
    'economy_prestige',
    'economy_transactions', // badge reward payouts (economy_add_balance) land here if driven
    'economy_wallets',
    'member_levels',
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
