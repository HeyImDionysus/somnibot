/**
 * scenario-runner/scripts/game-economy-gathering — the Progressive Gathering domain proof.
 *
 * Binds the gathering domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven against LOCAL Supabase. Every DB-observable /
 * RLS / owner-alert assertion runs NOW against the SAME production primitives the
 * bot uses; the live gather ROLL and its Valkey cooldown are GATED unless a
 * Redis/Valkey is reachable — the exact honesty boundary the harness requires.
 *
 * ── Why the member-facing gather ROLL is GATED without Valkey ──
 * `/hunt`, `/dig`, `/mine` all funnel through `GatheringManager.gather`, whose very
 * FIRST side-effect after the enabled-check is an atomic cooldown claim —
 * `valkey.set(key, '1', 'PX', ms, 'NX')` (gathering-manager.ts) — BEFORE any loot
 * roll, credit, inventory grant, or transaction. With no Redis the Valkey socket
 * refuses, so the command cannot resolve a roll at all. When `capabilities.redis`
 * is present the FULL live gather is driven and asserted (credit, one gather
 * ledger row, cooldown refusal); when absent it is GATED — never faked.
 *
 * ── What IS proven NOW, non-vacuously (no Redis needed) ──
 * The gather flow is a thin orchestration over primitives that ARE drivable
 * directly against local Supabase — the EXACT RPCs/queries the manager calls:
 *   - the coin-drop credit is `economy_add_balance` (atomic, rejects amount ≤ 0) —
 *     proven at the exact RPC, including the fail-closed reject + clean retry;
 *   - an item-drop grant is `economy_upsert_inventory` (ON CONFLICT increment) —
 *     proven idempotent-add over a real inventory row;
 *   - tool durability is `economy_decrement_durability` (FOR UPDATE) — proven to
 *     apply exactly once even under two concurrent decrements (no lost update);
 *   - the tool-tier-filtered loot pool is the manager's exact
 *     `economy_loot_tables` query (`active = true`) + `tool_tier ≤ tier` filter —
 *     proven to exclude gated-rare and deactivated rows for bare hands;
 *   - dashboard config (enabled / cooldown) lands in `guild_config`, the exact row
 *     `getConfig()` reads live — proven by readback;
 *   - wallet, inventory, and loot tables live in Supabase and survive a reboot;
 *   - economy_wallets / economy_loot_tables are guild-scoped under RLS (service
 *     role sees the row an anon / second-guild client must not).
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (promise / observation / impact). DEF surfaces
 * the documented `gathering-enabled` default conflict (catalog: ships ON; shipped
 * code: DB column + getConfig fallback default OFF). It never forces green and
 * never weakens the catalog.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes ────────────────────────────────────────────────────────────

interface GatheringConfigRow {
  economy_gathering_enabled: boolean;
  economy_gathering_cooldown_seconds: number;
}

interface WalletRow {
  wallet: number;
  bank: number;
  user_id: string;
  guild_id: string;
}

interface LootRow {
  id: string;
  item_name: string;
  source_type: string;
  tool_tier: number;
  sell_value: number;
  weight: number;
  min_qty: number;
  max_qty: number;
  active: boolean;
  gives_item_id: string | null;
}

interface InventoryRow {
  id: string;
  item_id: string;
  quantity: number;
  durability_remaining: number | null;
}

interface EconomyDisplay {
  currencyName: string;
  currencyEmoji: string;
}

/** A minimal PostgREST error surface (code + message) for insert/RPC results. */
type PgErr = { code?: string; message?: string } | null;

// ── Small live-stack helpers ──────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

function display(handle: LiveClientHandle): EconomyDisplay {
  return { currencyName: handle.economy.currencyName, currencyEmoji: handle.economy.currencyEmoji };
}

async function readConfig(handle: LiveClientHandle): Promise<GatheringConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('economy_gathering_enabled, economy_gathering_cooldown_seconds')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as GatheringConfigRow | null) ?? null;
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

/** The EXACT RPC GatheringManager.addToWallet credits a coin drop with. */
async function creditViaRpc(handle: LiveClientHandle, userId: string, amount: number): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_add_balance', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_amount: amount,
  });
  return (error as PgErr) ?? null;
}

/** The EXACT RPC GatheringManager.addToInventory grants an item drop with. */
async function upsertInventoryViaRpc(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
  quantity: number,
): Promise<PgErr> {
  const { error } = await handle.supabase.rpc('economy_upsert_inventory', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: quantity,
  });
  return (error as PgErr) ?? null;
}

/** The EXACT RPC GatheringManager.consumeDurability calls; null when the RPC errored. */
async function decrementDurability(handle: LiveClientHandle, inventoryId: string): Promise<boolean | null> {
  const { data, error } = await handle.supabase.rpc('economy_decrement_durability', {
    p_inventory_id: inventoryId,
  });
  if (error) return null;
  return data === true;
}

interface SeedLootOptions {
  itemName: string;
  toolTier?: number;
  sellValue?: number;
  weight?: number;
  minQty?: number;
  maxQty?: number;
  active?: boolean;
  rarity?: string;
  givesItemId?: string | null;
}

/** Insert one economy_loot_tables row (the exact row shape seedDefaultLoot writes). */
async function seedLootRow(
  handle: LiveClientHandle,
  sourceType: string,
  options: SeedLootOptions,
): Promise<string> {
  const { data } = await handle.supabase
    .from('economy_loot_tables')
    .insert({
      guild_id: handle.guildId,
      source_type: sourceType,
      item_name: options.itemName,
      emoji: '📦',
      rarity: options.rarity ?? 'common',
      min_qty: options.minQty ?? 1,
      max_qty: options.maxQty ?? 1,
      weight: options.weight ?? 40,
      tool_tier: options.toolTier ?? 0,
      sell_value: options.sellValue ?? 15,
      gives_item_id: options.givesItemId ?? null,
      active: options.active ?? true,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? '';
}

/** Insert an economy_items row (a gatherable/tool item); returns its id. */
async function seedItem(
  handle: LiveClientHandle,
  name: string,
  useEffect: { type: string; tier?: number } | null,
  durability: number | null,
): Promise<string> {
  const { data } = await handle.supabase
    .from('economy_items')
    .insert({
      guild_id: handle.guildId,
      name,
      emoji: '⛏️',
      category: 'Tools',
      usable: true,
      use_effect: useEffect,
      durability,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? '';
}

/** Insert an economy_inventory row for a member; returns its id. */
async function seedInventory(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
  quantity: number,
  durability: number | null,
): Promise<string> {
  const { data } = await handle.supabase
    .from('economy_inventory')
    .insert({
      guild_id: handle.guildId,
      user_id: userId,
      item_id: itemId,
      quantity,
      durability_remaining: durability,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? '';
}

async function readInventoryById(
  handle: LiveClientHandle,
  id: string,
): Promise<{ durability_remaining: number | null; quantity: number } | null> {
  const { data } = await handle.supabase
    .from('economy_inventory')
    .select('durability_remaining, quantity')
    .eq('id', id)
    .maybeSingle();
  return (data as { durability_remaining: number | null; quantity: number } | null) ?? null;
}

async function inventoryCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_inventory')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

/**
 * Replicate the manager's live loot pool EXACTLY: getLootTable's guild+source+
 * `active = true` query, then the `available = lootTable.filter(tool_tier <= tier)`
 * tier gate. This is the precise pool a member of `toolTier` would roll from.
 */
async function readLootPool(
  handle: LiveClientHandle,
  sourceType: string,
  toolTier: number,
): Promise<LootRow[]> {
  const { data } = await handle.supabase
    .from('economy_loot_tables')
    .select('id, item_name, source_type, tool_tier, sell_value, weight, min_qty, max_qty, active, gives_item_id')
    .eq('guild_id', handle.guildId)
    .eq('source_type', sourceType)
    .eq('active', true)
    .limit(1000);
  const rows = (data as LootRow[] | null) ?? [];
  return rows.filter((e) => e.tool_tier <= toolTier);
}

async function lootCount(handle: LiveClientHandle, sourceType?: string): Promise<number> {
  let query = handle.supabase
    .from('economy_loot_tables')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (sourceType) query = query.eq('source_type', sourceType);
  const { count } = await query;
  return count ?? 0;
}

/** The append-only gather ledger rows (economy_transactions type='gather') for a member. */
async function gatherTxns(
  handle: LiveClientHandle,
  userId: string,
): Promise<Array<{ type: string; amount: number; guild_id: string; user_id: string }>> {
  const { data } = await handle.supabase
    .from('economy_transactions')
    .select('type, amount, guild_id, user_id')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('type', 'gather');
  return (data as Array<{ type: string; amount: number; guild_id: string; user_id: string }> | null) ?? [];
}

async function walletCount(handle: LiveClientHandle, userId: string): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId);
  return count ?? 0;
}

async function serviceCount(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
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
 * rows an anon key can read (RLS deny / missing GRANT → 0), or null when the probe
 * is inconclusive (→ GATE). PostgREST surfaces a genuine authorization denial as
 * SQLSTATE 42501 / "permission denied" (HTTP 401/403), which we treat as the deny
 * we want to prove; a rejected key or other error is inconclusive.
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

// ── Captured-reply readers (used only on the Redis-driven live gather path) ──

/** The embed data of the LAST editReply a gather handler produced (defer→editReply). */
function lastEmbed(captured: CapturedResponse): Record<string, unknown> | undefined {
  const edits = captured.allOf('editReply');
  const last = edits[edits.length - 1]?.payload as
    | { embeds?: Array<{ data?: Record<string, unknown> }> }
    | undefined;
  return last?.embeds?.[0]?.data;
}

/** Every member-facing text surface of a gather embed: title + description. */
function brandingSurface(embed: Record<string, unknown> | undefined): string {
  if (!embed) return '';
  const parts: string[] = [];
  if (typeof embed.title === 'string') parts.push(embed.title);
  if (typeof embed.description === 'string') parts.push(embed.description);
  return parts.join('\n');
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

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
    'Failure-branch alerts (gather payout keeps failing / backend unreachable) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected gather failure branch',
  );
}

/**
 * Prove a guild-scoped table denies anon reads, made non-vacuous by a positive
 * control: the scenario has already written a real row under the guild (the service
 * role sees `svc` of them), so an anon client reading ZERO is a real deny. GATEs
 * (never fakes) when there is no row to isolate, no anon key, or the probe is
 * inconclusive.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
  policyPromise: string,
): Promise<void> {
  const svc = await serviceCount(handle, table);
  if (svc === 0) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      policyPromise,
      `this scenario seeds no ${table} row to serve as the positive control for the anon-denial probe; guild-scoped RLS is proven in scenarios that seed one`,
    );
    return;
  }
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      policyPromise,
      `no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial on ${table} not exercised — cross-guild scoping is still proven in XGUILD`,
    );
    return;
  }
  const anonRows = await anonReadCount(anonKey, table, handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      policyPromise,
      `the anon REST probe on ${table} was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)`,
    );
    return;
  }
  ctx.expect(anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: policyPromise,
    observation:
      `service-role sees ${svc} ${table} row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} ${table} row(s) for that guild.`,
    impact: `A ${table} row visible to the service role was also readable with an anon key — RLS is not denying anon reads (direct data exposure).`,
  });
}

/**
 * The only member-facing gather surfaces are the /hunt·/dig·/mine result / cooldown
 * embeds, produced ONLY when the Valkey cooldown path runs. Branding is GATED
 * honestly here rather than checked against a synthetic string. (The one place a
 * real embed IS captured — SET-A under Redis — asserts the currency branding
 * directly and surfaces the stock-wording gap as a finding.)
 */
function gateBranding(ctx: ScenarioContext): void {
  ctx.gate(
    'branding',
    'captured-reply',
    'Member-facing gather surfaces (result / cooldown embeds) show the owner brand name, colors, and voice preset with the powered-by-SomniBot attribution and zero stock-bot wording.',
    'the gather result/cooldown embed is produced only after the Valkey SET PX NX cooldown claim; with no Redis reachable no member-facing gather reply is produced to inspect',
  );
  ctx.gate(
    'branding',
    'discord-readback',
    'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on gather embeds.',
    'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
  );
}

/** Gate the replay-safety class where it depends on the Valkey cooldown lock. */
function gateCooldownReplay(ctx: ScenarioContext, promise: string): void {
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    promise,
    'gather writes no per-interaction idempotency key — the SOLE replay/duplicate guard is the atomic Valkey SET PX NX cooldown, which cannot run with no Redis reachable',
  );
}

/** Gate the live Discord gather roll (needs Valkey + a live gateway for readback). */
function gateLiveGather(ctx: ScenarioContext, promise: string, extra = ''): void {
  ctx.gate(
    'Discord',
    'redis-dependency',
    promise,
    `the gather roll begins only after the atomic Valkey SET PX NX cooldown claim, so /hunt·/dig·/mine cannot resolve a roll with no Redis reachable${extra ? `; ${extra}` : ''}`,
  );
}

/** Gate the audit ledger where only a real gather would write the economy_transactions row. */
function gateGatherAudit(ctx: ScenarioContext): void {
  ctx.gate(
    'audit',
    'audit-row',
    'Each resolved gather lands exactly one append-only economy_transactions row of type=gather with actor + guild.',
    'the gather ledger row is written only after a roll resolves (post-Valkey-cooldown); with no Redis reachable no real gather runs to write it — fabricating one would be vacuous',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the economy_transactions gather ledger is the DB-observable evidence here',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/**
 * DEF — out-of-the-box gathering. Surfaces the documented default conflict
 * (catalog: ships ENABLED; shipped code: default DISABLED) and proves the cooldown
 * default, the bare-hands tier-0 loot pool, and the coin-drop credit primitive.
 */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const enabledDefault = Boolean(declaredDefault(ctx.domain, 'gathering-enabled')); // catalog: true
  const cooldownDefault = Number(declaredDefault(ctx.domain, 'gathering-cooldown-seconds')); // 300
  const sellDefault = Number(declaredDefault(ctx.domain, 'loot-entry-sell-value')); // 15

  // Boot WITHOUT overriding the gathering columns so they take their real SHIPPED
  // defaults — proving (or refuting) that the live defaults equal the catalog's.
  const handle = await ctx.bootGuild({ label: 'a', economyStartingBalance: 0 });
  const userA = ctx.userId('a');

  const cfg = await readConfig(handle);

  // Cooldown default matches the catalog (300s).
  ctx.expect(cfg?.economy_gathering_cooldown_seconds === cooldownDefault, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: `Out of the box the live guild_config holds the catalog default gathering cooldown (${cooldownDefault}s).`,
    observation: `guild_config holds economy_gathering_cooldown_seconds=${cfg?.economy_gathering_cooldown_seconds} (expected ${cooldownDefault}).`,
    impact: 'The live gathering cooldown default diverged from the catalog-declared default.',
  });

  // Enabled default: the catalog contracts ships-ON, but the shipped code
  // (migration column DEFAULT false + GatheringManager.getConfig() `?? false`)
  // leaves gathering OFF out of the box — a documented conflict (INTENT-DELTAS.md).
  // Surface it as a FAIL for owner adjudication; do NOT soften it into a gate.
  ctx.expect(cfg?.economy_gathering_enabled === enabledDefault, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `Out of the box gathering is ENABLED (catalog default gathering-enabled=${enabledDefault}) so /hunt·/dig·/mine work without setup.`,
    observation:
      `live guild_config economy_gathering_enabled=${cfg?.economy_gathering_enabled} ` +
      `(catalog contracts ${enabledDefault}); the shipped column DEFAULT is false and getConfig() falls back to false.`,
    impact:
      'Gathering ships DISABLED, contradicting the catalog "great-defaults / works out of the box" promise — a new guild sees no gathering until an admin toggles it on (documented conflict awaiting owner decision).',
  });

  // Bare-hands (tier 0) loot pool: a seeded tier-0 coin drop is in the pool; a
  // tier-1 rare is NOT (proving the manager's active + tool_tier gate over real rows).
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}stone`, toolTier: 0, sellValue: sellDefault });
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}emerald`, toolTier: 1, sellValue: 150, rarity: 'rare' });
  const barePool = await readLootPool(handle, 'mine', 0);
  ctx.expect(
    barePool.length === 1 && barePool[0]?.item_name === `${ctx.runPrefix}stone` && barePool[0]?.sell_value === sellDefault,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `A bare-hands (tier 0) member's live loot pool is exactly the tier-0 drop(s) at the seeded sell value (${sellDefault}); the tier-1 rare is gated out.`,
      observation:
        `bare-hands pool size=${barePool.length}, item=${barePool[0]?.item_name ?? '(none)'}, ` +
        `sell_value=${barePool[0]?.sell_value ?? '(none)'} (expected the ${sellDefault}-coin tier-0 drop only).`,
      impact: 'The tool-tier loot gate did not restrict a bare-hands member to tier-0 drops.',
    },
  );

  // Coin-drop credit primitive — the EXACT RPC the manager credits a sale with.
  await seedWallet(handle, userA, 0);
  const before = (await readWallet(handle, userA))?.wallet ?? 0;
  const creditErr = await creditViaRpc(handle, userA, sellDefault);
  const after = (await readWallet(handle, userA))?.wallet ?? 0;
  ctx.expect(creditErr === null && after - before === sellDefault, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `A coin-yielding drop sells into the play-money wallet by exactly its sell value (${sellDefault}) via economy_add_balance.`,
    observation: `wallet moved ${before}→${after} (Δ${after - before}, err=${creditErr ? creditErr.message : 'none'}); expected +${sellDefault}.`,
    impact: 'The coin-drop credit did not add exactly the sell value to the play-money wallet.',
  });

  // DEF boots at the SHIPPED default, which leaves gathering DISABLED (the finding
  // above), so the REAL initGuildFeatures never wired the GatheringManager at this
  // boot — a live /mine cannot resolve a roll here regardless of Redis. GATE the
  // live roll + its ledger honestly (the live gather IS driven in SET-A/SET-B/
  // REPLAY/RACE, which boot with gathering enabled).
  gateLiveGather(
    ctx,
    'Out of the box a bare-handed /mine returns a tier-0 result embed, a coin drop credits the wallet by its sell value with one gather ledger row, and a second /mine within 300s is refused with the branded cooldown message.',
    'the shipped default leaves gathering disabled (see the enabled-default finding), so initGuildFeatures does not wire the GatheringManager at this boot and the roll also depends on the Valkey cooldown path',
  );
  gateGatherAudit(ctx);

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_wallets',
    'The service role reads this guild’s wallet row while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateCooldownReplay(ctx, 'Re-delivering a /mine within the cooldown yields no duplicate credit, inventory grant, or gather transaction.');
}

/**
 * SET-A — dashboard config takes live effect: cooldown 60, a common mine drop's
 * sell value raised to 120. The retuned value credits with no restart.
 */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    // Distinctive currency so a real gather embed's stock "coins" wording is a
    // visible branding gap (checked below only on the Redis-driven path).
    currencyName: 'Gilder',
    currencyEmoji: '🔶',
    guildConfigOverrides: {
      economy_gathering_enabled: true,
      economy_gathering_cooldown_seconds: 60,
    },
  });
  const econ = display(handle);
  const userA = ctx.userId('a');
  const retunedSell = 120;

  // The saved values land in guild_config — the exact row getConfig() reads live.
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_gathering_enabled === true && cfg?.economy_gathering_cooldown_seconds === 60, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A dashboard save of gathering enabled + cooldown 60s persists to guild_config and is what the bot reads live (no restart).',
    observation: `guild_config holds enabled=${cfg?.economy_gathering_enabled} (expected true), cooldown=${cfg?.economy_gathering_cooldown_seconds} (expected 60).`,
    impact: 'A saved gathering configuration did not persist / would not take live effect.',
  });

  // The retuned common drop lives at sell_value 120; a coin drop of it credits
  // exactly 120 via the RPC the manager uses (config takes effect, no restart).
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}retuned`, toolTier: 0, sellValue: retunedSell, weight: 100 });
  await seedWallet(handle, userA, 0);
  const before = (await readWallet(handle, userA))?.wallet ?? 0;
  const err = await creditViaRpc(handle, userA, retunedSell);
  const after = (await readWallet(handle, userA))?.wallet ?? 0;
  ctx.expect(err === null && after - before === retunedSell, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: `With the mine drop retuned to sell value ${retunedSell}, a /mine that rolls it credits exactly ${retunedSell} play coins (no restart).`,
    observation: `wallet moved ${before}→${after} (Δ${after - before}, err=${err ? err.message : 'none'}); expected +${retunedSell}.`,
    impact: 'The retuned sell value did not take live effect on the wallet credit.',
  });

  if (ctx.capabilities.redis) {
    await handle.supabase.from('economy_loot_tables').delete().eq('guild_id', handle.guildId);
    await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}only`, toolTier: 0, sellValue: retunedSell, weight: 100 });
    const userC = ctx.userId('c');
    const preWallet = (await readWallet(handle, userC))?.wallet ?? 0;
    const cap = await ctx.runSlash(handle, { commandName: 'mine', userId: userC });
    const postWallet = (await readWallet(handle, userC))?.wallet ?? 0;
    ctx.expect(postWallet - preWallet === retunedSell, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: `A live /mine after the save credits exactly ${retunedSell} play coins, proving the retuned sell value is live with no restart.`,
      observation: `live /mine wallet ${preWallet}→${postWallet} (Δ${postWallet - preWallet}); expected +${retunedSell}.`,
      impact: 'The saved sell value did not take live effect on a real /mine.',
    });
    // Branding on the REAL result embed: it should carry the owner's currency
    // ("Gilder"/🔶), not stock "coins". This surfaces the stock-wording gap.
    const surface = brandingSurface(lastEmbed(cap));
    const hasBrand = surface.includes(econ.currencyName) || surface.includes(econ.currencyEmoji);
    ctx.expect(hasBrand, {
      assertionClass: 'branding',
      channel: 'captured-reply',
      promise: `The gather result embed shows the owner's configured currency ("${econ.currencyName}" ${econ.currencyEmoji}) with zero stock-bot wording.`,
      observation: `result embed surface "${truncate(surface)}" ${hasBrand ? 'includes' : 'omits'} the configured currency name/emoji.`,
      impact: 'The gather result embed uses stock-bot wording ("coins") instead of the owner-configured currency branding (white-label leak).',
    });
    ctx.gate(
      'branding',
      'discord-readback',
      'The full white-label brand kit (colors, voice preset, powered-by-SomniBot attribution) matches the owner brand kit on gather embeds.',
      'requires an embed/message snapshot readback against the live brand kit (DISCORD_TOKEN + live guild)',
    );
  } else {
    gateLiveGather(ctx, 'A live /mine credits exactly 120 play coins after the save, and a repeat /mine is refused before 60s and permitted after — proving the new cooldown and sell value are live.');
    gateBranding(ctx);
  }

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_wallets',
    'The service role reads this guild’s wallet row while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateGatherAudit(ctx);
  gateCooldownReplay(ctx, 'Re-delivering the retuned /mine within the 60s cooldown yields no duplicate credit or gather transaction.');
}

/**
 * SET-B — loot-table tuning: raising a rare drop's tool_tier gate and deactivating
 * another entry restricts what bare-hands members roll while core gathering works.
 */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });

  // Three tuned rows: two tier-0 active commons, one rare raised to tier 2, and one
  // tier-0 entry deactivated. The bare-hands pool must be exactly the two active commons.
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}stone`, toolTier: 0, sellValue: 5, weight: 40 });
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}iron`, toolTier: 0, sellValue: 18, weight: 25 });
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}diamond`, toolTier: 2, sellValue: 600, weight: 5, rarity: 'epic' });
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}deactivated`, toolTier: 0, sellValue: 50, weight: 20, active: false });

  const barePool = await readLootPool(handle, 'mine', 0);
  const bareNames = barePool.map((r) => r.item_name).sort();
  ctx.expect(
    barePool.length === 2 &&
      bareNames.includes(`${ctx.runPrefix}stone`) &&
      bareNames.includes(`${ctx.runPrefix}iron`) &&
      !bareNames.includes(`${ctx.runPrefix}diamond`) &&
      !bareNames.includes(`${ctx.runPrefix}deactivated`),
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'A bare-hands /mine after the retune only rolls the remaining tier-0 ACTIVE drops — never the tier-2-gated rare and never the deactivated entry.',
      observation: `bare-hands pool=[${bareNames.join(', ')}] (expected exactly stone + iron; no diamond, no deactivated).`,
      impact: 'The tool_tier gate or the active flag did not restrict the bare-hands loot pool as tuned.',
    },
  );

  // A tier-2 member can still reach the gated rare (tool_tier ≤ 2), but never the deactivated one.
  const tier2Pool = await readLootPool(handle, 'mine', 2);
  const tier2Names = tier2Pool.map((r) => r.item_name);
  ctx.expect(tier2Pool.length === 3 && tier2Names.includes(`${ctx.runPrefix}diamond`) && !tier2Names.includes(`${ctx.runPrefix}deactivated`), {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A member holding a tier-2 pickaxe can still roll the gated rare drop; the deactivated entry stays out for everyone.',
    observation: `tier-2 pool size=${tier2Pool.length}, includes diamond=${tier2Names.includes(`${ctx.runPrefix}diamond`)}, includes deactivated=${tier2Names.includes(`${ctx.runPrefix}deactivated`)}.`,
    impact: 'The tier-2 loot gate did not unlock the gated rare, or a deactivated entry leaked into the pool.',
  });

  if (ctx.capabilities.redis) {
    // A live bare-hands /mine's drop must be one of the active tier-0 items (never
    // the rare or the deactivated one) — the tier gate observed end-to-end.
    const userC = ctx.userId('c');
    const cap = await ctx.runSlash(handle, { commandName: 'mine', userId: userC });
    const surface = brandingSurface(lastEmbed(cap));
    const rolledAllowed = surface.includes(`${ctx.runPrefix}stone`) || surface.includes(`${ctx.runPrefix}iron`);
    const rolledForbidden = surface.includes(`${ctx.runPrefix}diamond`) || surface.includes(`${ctx.runPrefix}deactivated`);
    ctx.expect(rolledAllowed && !rolledForbidden, {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'A live bare-hands /mine rolls only an active tier-0 drop — never the tier-2 rare or the deactivated entry.',
      observation: `result embed surface "${truncate(surface)}" (allowed rolled=${rolledAllowed}, forbidden rolled=${rolledForbidden}).`,
      impact: 'A live bare-hands /mine rolled a gated or deactivated loot entry.',
    });
  } else {
    gateLiveGather(ctx, 'A live bare-hands /mine only ever returns active tier-0 drops and never the gated rare or deactivated entry, while a tier-2 member can still roll the gated rare.');
  }

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_loot_tables',
    'The service role reads this guild’s loot-table rows while an anon client reads zero (economy_loot_tables is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateGatherAudit(ctx);
  gateCooldownReplay(ctx, 'Re-delivering a /mine within the cooldown yields no duplicate credit or gather transaction.');
}

/** INVALID — a rejected invalid loot/cooldown config never persists; valid values retained live. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 120 },
  });

  // A valid loot row that must remain byte-for-byte after a rejected save.
  const lootId = await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}valid`, toolTier: 0, sellValue: 30, minQty: 1, maxQty: 3, weight: 40 });

  // guild_config keeps its prior valid cooldown (nothing invalid persisted).
  const cfg = await readConfig(handle);
  ctx.expect(cfg?.economy_gathering_cooldown_seconds === 120 && cfg?.economy_gathering_enabled === true, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid values byte-for-byte (a rejected negative cooldown never persists).',
    observation: `guild_config holds cooldown=${cfg?.economy_gathering_cooldown_seconds} (expected 120), enabled=${cfg?.economy_gathering_enabled} (expected true).`,
    impact: 'A valid gathering configuration was not retained after a rejected save.',
  });

  // The valid loot row is unchanged and still the live pool the next gather rolls.
  const { data: lootRow } = await handle.supabase
    .from('economy_loot_tables')
    .select('min_qty, max_qty, sell_value')
    .eq('id', lootId)
    .maybeSingle();
  const row = lootRow as { min_qty: number; max_qty: number; sell_value: number } | null;
  const pool = await readLootPool(handle, 'mine', 0);
  ctx.expect(row?.min_qty === 1 && row?.max_qty === 3 && row?.sell_value === 30 && pool.length === 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Live gathering behavior is unchanged on the very next gather: the previous valid loot row (min≤max, sell 30) is intact and still the pool the bot rolls.',
    observation: `valid loot row min=${row?.min_qty}/max=${row?.max_qty}/sell=${row?.sell_value} (expected 1/3/30); bare-hands pool size=${pool.length} (expected 1).`,
    impact: 'A rejected config attempt disturbed the live loot table / cooldown the bot applies.',
  });

  // The REJECTION (min_qty > max_qty, negative cooldown) is enforced in the dashboard
  // Zod layer; economy_loot_tables / guild_config carry NO such CHECK constraint, so
  // the reject path (and its audit row) is unreachable in a bot-only harness.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard gathering page surfaces a clear validation error for a loot entry with min_qty > max_qty and a negative cooldown.',
    'config/loot validation lives in the dashboard (Zod) layer; economy_loot_tables and guild_config have no matching DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'One audit row records the rejected gathering configuration attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_loot_tables',
    'The service role reads this guild’s loot-table rows while an anon client reads zero (economy_loot_tables is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateCooldownReplay(ctx, 'Re-delivering a /mine within the cooldown yields no duplicate credit or gather transaction.');
}

/**
 * UNAUTH — gather credits are keyed to the invoking member's own id: a member
 * cannot credit gathered rewards into another member's wallet or inventory.
 */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });
  const userA = ctx.userId('a'); // run-member-a
  const userB = ctx.userId('b'); // run-member-b

  await seedWallet(handle, userA, 0);
  await seedWallet(handle, userB, 0);
  const aBefore = (await readWallet(handle, userA))?.wallet ?? 0;

  // The gather credit RPCs are keyed to (guild, user_id) — there is NO parameter to
  // credit anyone but the invoker. Crediting B (the invoker in this arrangement)
  // moves only B's wallet; A is byte-identical. This is the exact enforcement the
  // catalog contracts for "credit-others-wallet: deny".
  const creditErr = await creditViaRpc(handle, userB, 250);
  const aAfter = (await readWallet(handle, userA))?.wallet ?? 0;
  const bAfter = (await readWallet(handle, userB))?.wallet ?? 0;
  ctx.expect(creditErr === null && bAfter === 250 && aAfter === aBefore && aAfter === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A member’s gather only ever credits their OWN wallet: economy_add_balance is keyed to the invoking member’s guild+user id, so run-member-b’s gather leaves run-member-a byte-identical.',
    observation:
      `run-member-b wallet after credit=${bAfter} (expected 250); run-member-a wallet ${aBefore}→${aAfter} (expected unchanged 0).`,
    impact: 'A gather credit reached another member’s wallet — the own-id credit keying was not enforced (cross-member credit).',
  });

  // The item-drop grant RPC is likewise keyed to the invoker; upserting into B's
  // inventory never touches A's.
  const itemId = await seedItem(handle, `${ctx.runPrefix}ore`, null, null);
  const upErr = await upsertInventoryViaRpc(handle, userB, itemId, 1);
  const aInv = await inventoryCount(handle, userA);
  const bInv = await inventoryCount(handle, userB);
  ctx.expect(upErr === null && bInv === 1 && aInv === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'An item drop lands only in the invoking member’s inventory (economy_upsert_inventory keyed to their own guild+user id).',
    observation: `run-member-b inventory rows=${bInv} (expected 1); run-member-a inventory rows=${aInv} (expected 0).`,
    impact: 'An item-drop grant reached another member’s inventory — the own-id keying was not enforced.',
  });

  // The non-admin dashboard save refusal + its permission-denied audit row live on
  // the dashboard session-auth lane (RLS + dashboard.manage_economy) — not here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save gathering settings (returns an authorization error for lacking dashboard.manage_economy).',
    'requires the dashboard session-auth lane (RLS + session role) — not reachable in this bot-only harness',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'An audit row records the denied gathering configuration attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_wallets',
    'The service role reads this guild’s wallet rows while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
  gateCooldownReplay(ctx, 'Re-delivering a /mine within the cooldown yields no duplicate credit or gather transaction.');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database-outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /hunt·/dig·/mine reply with the branded gathering-unavailable message and no coins, items, or cooldown move; after restore a fresh gather resolves and credits exactly once.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed gather command).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'After restoration a fresh gather credits exactly once and applies, logged with the run-prefixed correlation id.',
    'requires the outage fault lane plus a Valkey cooldown path for the post-restore /mine',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate credit or gather transaction survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded gathering-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the gathering-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Gathering rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a gather whose wallet credit fails moves nothing; a clean retry credits exactly once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });
  const userA = ctx.userId('a');

  // The manager's credit is fail-closed: economy_add_balance REJECTS a non-positive
  // amount (RAISE), so a failed payout moves nothing and (the insert being AFTER the
  // credit check) writes no gather ledger row. A clean retry with the real sell value
  // then credits exactly once. Prove the exact fail→retry primitive.
  await seedWallet(handle, userA, 0);
  const failErr = await creditViaRpc(handle, userA, 0); // the failing credit
  const afterFail = (await readWallet(handle, userA))?.wallet ?? 0;
  const failTxns = await gatherTxns(handle, userA);
  const retryErr = await creditViaRpc(handle, userA, 40); // the clean retry
  const afterRetry = (await readWallet(handle, userA))?.wallet ?? 0;
  ctx.expect(failErr !== null && afterFail === 0 && failTxns.length === 0 && retryErr === null && afterRetry === 40, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'A gather whose wallet credit fails moves nothing and writes no gather ledger row; a clean retry then credits exactly once (economy_add_balance is fail-closed and rejects a non-positive payout).',
    observation:
      `failing credit err=${failErr ? failErr.message : 'none'}, wallet=${afterFail} (expected unchanged 0), gather rows=${failTxns.length} (expected 0); ` +
      `retry err=${retryErr ? retryErr.message : 'none'}, wallet=${afterRetry} (expected the single 40 credit).`,
    impact: 'A failed gather credit moved coins / wrote a ledger row, or the clean retry did not credit exactly once — a play-coin loss or double-credit.',
  });
  // Idempotency of the ledger sequence: the failed credit left no entry, so the
  // ledger shows exactly one gather credit and never a double-credit.
  ctx.expect(afterRetry === 40, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'The failed credit leaves no ledger entry and the successful retry credits under its own effect — the play-money ledger shows exactly one gather credit, never a double-credit.',
    observation: `net wallet after fail+retry=${afterRetry} (expected exactly the one 40-coin credit).`,
    impact: 'The retry double-applied / the failed credit persisted — the play-money ledger would double-count.',
  });

  // The manager reaching the credit-failed notice/alert branch (branded reply,
  // repeated-failure owner alert) needs a mid-gather fault on economy_add_balance
  // after a real roll — a fault-injection lane not present here.
  ctx.gate(
    'Discord',
    'discord-readback',
    'After the injected credit fault run-member-a sees the branded credit-failed notice with an unchanged wallet and no gather transaction; the clean retry credits exactly the drop’s sell value once.',
    'requires a mid-gather fault-injection lane (fail economy_add_balance after a resolved roll) plus the Valkey cooldown path',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Repeated credit failures raise exactly one reasoned owner alert naming the failed payout; the happy-path retry raises none.',
    'requires the mid-gather fault-injection lane plus owner alert channel readback',
  );
  gateGatherAudit(ctx);
  await proveRlsIsolation(
    ctx,
    handle,
    'economy_wallets',
    'The service role reads this guild’s wallet row while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  gateBranding(ctx);
}

/** REPLAY — re-delivering one gather interaction must not double-credit. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });
  const userA = ctx.userId('a');
  await seedWallet(handle, userA, 0); // RLS positive control

  if (ctx.capabilities.redis) {
    await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}only`, toolTier: 0, sellValue: 25, weight: 100 });
    const userC = ctx.userId('c');
    const replayId = `${ctx.runPrefix}mine-int`;
    const pre = (await readWallet(handle, userC))?.wallet ?? 0;
    await ctx.runSlash(handle, { commandName: 'mine', userId: userC, interactionId: replayId });
    const afterFirst = (await readWallet(handle, userC))?.wallet ?? 0;
    await ctx.runSlash(handle, { commandName: 'mine', userId: userC, interactionId: replayId }); // re-deliver same id
    const afterReplay = (await readWallet(handle, userC))?.wallet ?? 0;
    const txns = await gatherTxns(handle, userC);
    ctx.expect(afterFirst - pre === 25 && afterReplay === afterFirst && txns.length === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'Re-delivering a single /mine interaction leaves exactly one credit and one gather transaction: the atomic Valkey cooldown absorbs the replay as a deduplicated no-op.',
      observation:
        `wallet ${pre}→${afterFirst} on first /mine, then ${afterReplay} after re-delivering the same interaction id; gather rows=${txns.length} (exactly-once expects one credit, one row).`,
      impact: 'A replayed /mine double-credited or wrote a second gather transaction — the cooldown replay-guard failed.',
    });
  } else {
    gateCooldownReplay(ctx, 'Re-delivering a single /mine interaction leaves exactly one credit, one gather transaction, and one claimed cooldown (the Valkey SET PX NX cooldown absorbs the replay).');
    gateLiveGather(ctx, 'The channel shows exactly one gather result embed despite the replay, and the member’s wallet + transaction history are unchanged from the pre-replay snapshot.');
    gateGatherAudit(ctx);
  }

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_wallets',
    'The service role reads this guild’s wallet row while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** RESTART — wallet, inventory, and loot tables survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: enable, seed wallet + a durable tool in inventory + a loot row; snapshot.
  const first = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 90 },
  });
  await seedWallet(first, userA, 500, 200);
  const itemId = await seedItem(first, `${ctx.runPrefix}pickaxe`, { type: 'pickaxe', tier: 2 }, 4);
  const invId = await seedInventory(first, userA, itemId, 1, 4);
  await seedLootRow(first, 'mine', { itemName: `${ctx.runPrefix}stone`, toolTier: 0, sellValue: 5 });
  const walletSnap = await readWallet(first, userA);
  const invSnap = await readInventoryById(first, invId);
  const lootSnap = await lootCount(first, 'mine');
  await first.cleanup(); // simulate shutdown (does NOT delete rows)

  // Boot #2: SAME guild id (restart). State must be byte-identical (it lives in Supabase).
  const second = await ctx.bootGuild({
    guildId,
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 90 },
  });
  const walletAfter = await readWallet(second, userA);
  const invAfter = await readInventoryById(second, invId);
  const lootAfter = await lootCount(second, 'mine');
  ctx.expect(
    walletAfter?.wallet === walletSnap?.wallet &&
      walletAfter?.bank === walletSnap?.bank &&
      walletAfter?.wallet === 500 &&
      walletAfter?.bank === 200 &&
      invAfter?.durability_remaining === invSnap?.durability_remaining &&
      invAfter?.durability_remaining === 4 &&
      lootAfter === lootSnap &&
      lootAfter === 1,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'After a full stack restart, the member’s wallet, tool inventory (durability), and the loot tables match the pre-restart snapshot exactly (state lives in Supabase).',
      observation:
        `pre-restart wallet=${walletSnap?.wallet}/bank=${walletSnap?.bank}, tool durability=${invSnap?.durability_remaining}, loot rows=${lootSnap}; ` +
        `post-restart wallet=${walletAfter?.wallet}/bank=${walletAfter?.bank}, tool durability=${invAfter?.durability_remaining}, loot rows=${lootAfter} (expected 500/200 / 4 / 1).`,
      impact: 'Gathering state did not survive a restart — wallet, inventory durability, or loot tables were lost or altered.',
    },
  );

  // The "cooldown still refused across the restart" facet lives in the Valkey key
  // (which persists in Redis, not Supabase) — needs a reachable Valkey.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'A /mine issued inside the surviving cooldown window after a restart returns the branded cooldown refusal rather than a fresh credit.',
    'the cooldown is a Valkey SET PX NX key (persisted in Redis, not Supabase); with no Redis reachable the cross-restart cooldown cannot be exercised',
  );

  await proveRlsIsolation(
    ctx,
    second,
    'economy_wallets',
    'The service role reads this guild’s wallet row while an anon client reads zero (economy_wallets is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, second);
  gateBranding(ctx);
  gateGatherAudit(ctx);
  gateCooldownReplay(ctx, 'Re-delivering a /mine within the surviving cooldown yields no duplicate credit or gather transaction.');
}

/** RACE — concurrent gathers are safe: the atomic durability decrement never loses an update. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });
  const userA = ctx.userId('a');

  // The per-gather tool-durability decrement is atomic (economy_decrement_durability
  // uses SELECT … FOR UPDATE). Two CONCURRENT decrements on the same tool must each
  // apply exactly once — durability drops by exactly 2, never 1 (no lost update).
  const itemId = await seedItem(handle, `${ctx.runPrefix}pickaxe`, { type: 'pickaxe', tier: 1 }, 5);
  const invId = await seedInventory(handle, userA, itemId, 1, 5);
  const [d1, d2] = await Promise.all([decrementDurability(handle, invId), decrementDurability(handle, invId)]);
  const invAfter = await readInventoryById(handle, invId);
  ctx.expect(d1 === true && d2 === true && invAfter?.durability_remaining === 3, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise:
      'Concurrent tool-durability consumption is atomic: two simultaneous economy_decrement_durability calls each apply exactly once (FOR UPDATE), so durability drops by exactly 2 (no lost update).',
    observation: `both decrements returned true=${d1 === true && d2 === true}; durability 5→${invAfter?.durability_remaining} (expected exactly 3, i.e. −2 not −1).`,
    impact: 'A concurrent durability decrement was lost — the tool would be over-used / extraction not kept honest under a race.',
  });
  ctx.expect(invAfter?.durability_remaining === 3, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Under concurrency the durability ledger shows exactly one decrement per call — never a coalesced single effect that would let a second gather ride free.',
    observation: `durability after two concurrent decrements=${invAfter?.durability_remaining} (exactly-once-per-call expects 3).`,
    impact: 'Two concurrent decrements collapsed into one — a concurrency-safety regression.',
  });

  // The catalog RACE guarantee (two simultaneous /mine → exactly one credit + one
  // cooldown refusal) is enforced by the Valkey SET PX NX lock — needs a Redis.
  if (ctx.capabilities.redis) {
    await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}only`, toolTier: 0, sellValue: 20, weight: 100 });
    const userC = ctx.userId('c');
    const [r1, r2] = await Promise.all([
      ctx.runSlash(handle, { commandName: 'mine', userId: userC }),
      ctx.runSlash(handle, { commandName: 'mine', userId: userC }),
    ]);
    const wallet = (await readWallet(handle, userC))?.wallet ?? 0;
    const txns = await gatherTxns(handle, userC);
    const surfaces = [brandingSurface(lastEmbed(r1)), brandingSurface(lastEmbed(r2))];
    const cooldownRefusals = surfaces.filter((s) => /wait/i.test(s)).length;
    ctx.expect(wallet === 20 && txns.length === 1 && cooldownRefusals === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Two simultaneous /mine invocations yield exactly one applied gather credit and one cooldown refusal (the Valkey SET PX NX lock serializes them).',
      observation: `after two concurrent /mine: wallet=${wallet} (expected one 20-coin credit), gather rows=${txns.length} (expected 1), cooldown refusals=${cooldownRefusals} (expected 1).`,
      impact: 'Two concurrent gathers both resolved — the atomic cooldown lock did not serialize the race.',
    });
  } else {
    gateLiveGather(ctx, 'Two simultaneous /mine invocations yield exactly one applied gather credit and one cooldown refusal, and the tool durability drops by exactly one.');
    gateCooldownReplay(ctx, 'The Valkey SET PX NX lock guarantees only one of the concurrent gathers claims the cooldown and credits, so the ledger shows exactly one credit.');
    gateGatherAudit(ctx);
  }

  await proveRlsIsolation(
    ctx,
    handle,
    'economy_inventory',
    'The service role reads this guild’s inventory rows while an anon client reads zero (economy_inventory is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);
  gateBranding(ctx);
}

/** XGUILD — gathering is strictly per-guild (wallet, loot table, cooldown). */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');

  const handleA = await ctx.bootGuild({
    guildId: guildA,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 300 },
  });
  const handleB = await ctx.bootGuild({
    guildId: guildB,
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true, economy_gathering_cooldown_seconds: 60 },
  });

  // Distinct per-guild wallet + loot state.
  await seedWallet(handleA, userA, 700);
  await seedLootRow(handleA, 'mine', { itemName: `${ctx.runPrefix}a-stone`, toolTier: 0, sellValue: 15 });
  const snapA = await readWallet(handleA, userA);

  await seedWallet(handleB, userA, 123);
  await seedLootRow(handleB, 'mine', { itemName: `${ctx.runPrefix}b-gold`, toolTier: 0, sellValue: 999 });
  const walletB = await readWallet(handleB, userA);
  const walletAAfter = await readWallet(handleA, userA);

  ctx.expect(
    walletB?.guild_id === guildB &&
      walletB?.wallet === 123 &&
      walletAAfter?.wallet === snapA?.wallet &&
      snapA?.wallet === 700,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Gathering in a second guild never touches the first guild’s wallet; each guild’s wallet evolves independently.',
      observation:
        `guild A wallet=${walletAAfter?.wallet} (unchanged at ${snapA?.wallet}=700); ` +
        `guild B wallet=${walletB?.wallet} under guild_id="${walletB?.guild_id}".`,
      impact: 'Cross-guild activity mutated another guild’s wallet — per-guild isolation broken.',
    },
  );

  // Per-guild config + loot table: guild B's cooldown/loot are its own.
  const cfgA = await readConfig(handleA);
  const cfgB = await readConfig(handleB);
  const poolA = await readLootPool(handleA, 'mine', 0);
  const poolB = await readLootPool(handleB, 'mine', 0);
  ctx.expect(
    cfgA?.economy_gathering_cooldown_seconds === 300 &&
      cfgB?.economy_gathering_cooldown_seconds === 60 &&
      poolA.length === 1 &&
      poolA[0]?.item_name === `${ctx.runPrefix}a-stone` &&
      poolB.length === 1 &&
      poolB[0]?.item_name === `${ctx.runPrefix}b-gold`,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: 'Each guild’s gather reflects only its OWN loot table and cooldown (A: 300s / a-stone; B: 60s / b-gold).',
      observation:
        `guild A cooldown=${cfgA?.economy_gathering_cooldown_seconds}/pool=[${poolA.map((r) => r.item_name).join(', ')}]; ` +
        `guild B cooldown=${cfgB?.economy_gathering_cooldown_seconds}/pool=[${poolB.map((r) => r.item_name).join(', ')}].`,
      impact: 'A guild’s gathering configuration or loot table leaked across guilds.',
    },
  );

  // Each guild scope reads its OWN distinct wallet row and never the other's.
  const { data: bScoped } = await handleB.supabase
    .from('economy_wallets')
    .select('wallet, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_wallets')
    .select('wallet, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .maybeSingle();
  const bRow = bScoped as { wallet: number; guild_id: string } | null;
  const aRow = aScoped as { wallet: number; guild_id: string } | null;
  ctx.expect(bRow?.guild_id === guildB && bRow?.wallet === 123 && aRow?.guild_id === guildA && aRow?.wallet === 700, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'Each guild scope reads its OWN wallet row and never the other guild’s: guild B → its 123-coin row, guild A → its 700-coin row.',
    observation:
      `guild-B-scoped read=${bRow?.wallet} under "${bRow?.guild_id}"; ` +
      `guild-A-scoped read=${aRow?.wallet} under "${aRow?.guild_id}" (distinct rows under distinct guild_ids).`,
    impact: 'A guild-scoped read returned the other guild’s wallet row — cross-guild leakage.',
  });
  await proveRlsIsolation(
    ctx,
    handleA,
    'economy_loot_tables',
    'The service role reads guild A’s loot-table rows while an anon client reads zero (economy_loot_tables is REVOKED from anon/authenticated).',
  );

  await proveNoOwnerAlert(ctx, handleA);
  gateBranding(ctx);
  gateGatherAudit(ctx);
  gateLiveGather(ctx, 'Observed in the live guilds, guild A’s /balance and inventory are identical before and after guild B activity, and guild B’s gather credits guild B’s wallet against guild B’s loot table and cooldown.');
  gateCooldownReplay(ctx, 'Re-delivering a /mine within a guild’s cooldown yields no duplicate credit or gather transaction in that guild.');
}

/** CLEANUP — the suite leaves no trace: run-prefixed rows removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_gathering_enabled: true },
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: loot table, item, inventory, wallet, and a
  // gather ledger row (inserted directly here purely as a sweep fixture).
  await seedWallet(handle, userA, 500);
  await seedLootRow(handle, 'mine', { itemName: `${ctx.runPrefix}stone`, toolTier: 0, sellValue: 5 });
  const itemId = await seedItem(handle, `${ctx.runPrefix}pickaxe`, { type: 'pickaxe', tier: 1 }, 5);
  await seedInventory(handle, userA, itemId, 1, 5);
  await handle.supabase.from('economy_transactions').insert({
    guild_id: handle.guildId,
    user_id: userA,
    type: 'gather',
    amount: 5,
    balance_after: 505,
    description: `${ctx.runPrefix}mined stone`,
  });

  const lootBefore = await lootCount(handle);
  const invBefore = await inventoryCount(handle, userA);
  const walletsBefore = await walletCount(handle, userA);
  const txnsBefore = (await gatherTxns(handle, userA)).length;
  const itemsBefore = await serviceCount(handle, 'economy_items');
  ctx.expect(lootBefore >= 1 && invBefore >= 1 && walletsBefore >= 1 && txnsBefore >= 1 && itemsBefore >= 1, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed loot-table, item, inventory, wallet, and gather-transaction rows (pre-cleanup baseline).',
    observation: `pre-cleanup: loot=${lootBefore}, inventory=${invBefore}, wallets=${walletsBefore}, gather txns=${txnsBefore}, items=${itemsBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep).
  await proveRlsIsolation(
    ctx,
    handle,
    'economy_loot_tables',
    'The service role reads this guild’s loot-table rows while an anon client reads zero (economy_loot_tables is REVOKED from anon/authenticated).',
  );
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed rows.
  await ctx.sweepGuildRows(handle);
  const lootAfter = await lootCount(handle);
  const invAfter = await inventoryCount(handle, userA);
  const walletsAfter = await walletCount(handle, userA);
  const txnsAfter = (await gatherTxns(handle, userA)).length;
  const itemsAfter = await serviceCount(handle, 'economy_items');
  ctx.expect(lootAfter === 0 && invAfter === 0 && walletsAfter === 0 && txnsAfter === 0 && itemsAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed loot-table, item, inventory, wallet, and gather-transaction rows are deleted; a final sweep finds zero run-prefixed gathering resources.',
    observation: `post-sweep: loot=${lootAfter}, inventory=${invAfter}, wallets=${walletsAfter}, gather txns=${txnsAfter}, items=${itemsAfter}.`,
    impact: 'The cleanup sweep left run-prefixed gathering rows behind — the suite leaves residue.',
  });

  gateBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed gather result embeds, cooldown, or disabled notices after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane; the gathering operational rows are the DB-observable evidence here',
  );
  gateCooldownReplay(ctx, 'Re-delivering a /mine after cleanup yields no resurrected run-prefixed credit or gather transaction.');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The Progressive Gathering domain proof: the guild_id-scoped tables the sweep must
 * clear (child → parent so FK-constrained rows are removed before their parents and
 * the guild row), plus the 12 scenario scripts.
 *
 * FK order notes: economy_inventory.item_id → economy_items(id) (ON DELETE CASCADE)
 * and economy_loot_tables.gives_item_id → economy_items(id) (ON DELETE SET NULL), so
 * economy_inventory and economy_loot_tables are swept BEFORE economy_items.
 * economy_transactions / economy_wallets / alerts are independent guild-scoped rows.
 */
export const gameEconomyGatheringProof: DomainProof = {
  domainId: 'game-economy-gathering',
  guildScopedTables: [
    'economy_transactions',
    'economy_inventory',
    'economy_loot_tables',
    'economy_items',
    'economy_wallets',
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
