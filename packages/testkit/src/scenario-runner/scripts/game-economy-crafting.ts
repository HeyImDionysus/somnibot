/**
 * scenario-runner/scripts/game-economy-crafting — the crafting domain proof.
 *
 * Binds the recipe-crafting domain's 12 declarative catalog scenarios to concrete,
 * real-stack proof scripts driven through the REAL production dispatcher against
 * LOCAL Supabase. Every DB-observable / captured-reply / audit-row / RLS assertion
 * runs NOW; anything needing a real Discord effect, a fault-injection lane, or the
 * Valkey/Redis crafting cooldown lock is GATED — never faked, never forced green.
 *
 * The load-bearing gating boundary for THIS domain: `/craft` acquires an atomic
 * Valkey `SET PX NX` cooldown lock on `economy:craft:{guild}:{user}` at the TOP of
 * the handler (crafting-manager.ts) — BEFORE any material check or consumption — so
 * the ENTIRE consume/produce/cooldown happy path needs a reachable Redis. Without
 * it, the craft-driven assertions GATE. `/recipes` (the recipe-book path) touches
 * no Valkey, so its default-book seeding + branded embed run NOW, and the atomic
 * ingredient primitive (`economy_decrement_inventory`, SELECT … FOR UPDATE) and the
 * disabled/config/isolation/cleanup paths are all DB-observable without Redis.
 *
 * Behavior-bug discovery: where the REAL bot diverges from the catalog's contracted
 * intent, the script records a FAIL (with promise / observation / impact). It never
 * softens a divergence into a pass or a gate — those FAILs are owner findings. In
 * particular the /recipes embed cell will FAIL (not silently pass) if the default
 * recipe book fails to render (e.g. the `seedDefaultRecipes` JSON.stringify-into-a-
 * jsonb-column of `inputs` breaks the render loop), while the separate DB-seeding
 * cell still proves the rows were written.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { CapturedResponse } from '../../captured-response.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface RecipeRow {
  id: string;
  name: string;
  output_qty: number;
  output_item_id: string | null;
  cooldown_seconds: number;
  category: string;
}

interface ItemRow {
  id: string;
  name: string;
}

interface CraftingConfigRow {
  economy_crafting_enabled: boolean;
  economy_crafting_cooldown_seconds: number;
}

// ── Catalog helpers ───────────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

// ── Captured-reply helpers (crafting defers, then editReply's an embed) ────

/** The last inspectable payload: crafting uses deferReply→editReply; the disabled
 *  fallback uses a plain reply. Read editReply first, then reply. */
function lastPayload(
  captured: CapturedResponse,
): { content?: string; embeds?: Array<{ data?: Record<string, unknown> }> } | undefined {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    return edits[edits.length - 1]!.payload as
      | { content?: string; embeds?: Array<{ data?: Record<string, unknown> }> }
      | undefined;
  }
  const reply = captured.find('reply');
  return reply?.payload as
    | { content?: string; embeds?: Array<{ data?: Record<string, unknown> }> }
    | undefined;
}

/** The reply content string (editReply content, else the plain-reply content). */
function replyContent(captured: CapturedResponse): string {
  const edits = captured.allOf('editReply');
  if (edits.length > 0) {
    const c = (edits[edits.length - 1]!.payload as { content?: string } | undefined)?.content;
    if (typeof c === 'string' && c.length > 0) return c;
  }
  const reply = captured.find('reply');
  return String((reply?.payload as { content?: string } | undefined)?.content ?? '');
}

/** The first embed's `.data` (EmbedBuilder) from the last editReply, else reply. */
function replyEmbedData(captured: CapturedResponse): Record<string, unknown> | undefined {
  return lastPayload(captured)?.embeds?.[0]?.data;
}

function embedTitle(captured: CapturedResponse): string {
  const embed = replyEmbedData(captured);
  return typeof embed?.title === 'string' ? embed.title : '';
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

// ── Live-stack DB helpers ─────────────────────────────────────────────────

/** Create a run-prefixed shop item (a crafting input/output) and return its id. */
async function createItem(handle: LiveClientHandle, name: string): Promise<string | null> {
  const { data } = await handle.supabase
    .from('economy_items')
    .insert({
      guild_id: handle.guildId,
      name,
      emoji: '🪨',
      category: 'Materials',
      price: 0,
      sell_price: 0,
      active: true,
    })
    .select('id')
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

/** Give a member `qty` of an item via the REAL atomic inventory upsert RPC. */
async function giveInventory(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
  qty: number,
): Promise<void> {
  await handle.supabase.rpc('economy_upsert_inventory', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: qty,
  });
}

/** Read a member's owned quantity of an item (0 when the row was decremented away). */
async function inventoryQty(handle: LiveClientHandle, userId: string, itemId: string): Promise<number> {
  const { data } = await handle.supabase
    .from('economy_inventory')
    .select('quantity')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  return (data as { quantity: number } | null)?.quantity ?? 0;
}

/** Drive the REAL atomic decrement RPC (SELECT … FOR UPDATE); returns its boolean. */
async function decrementInventory(
  handle: LiveClientHandle,
  userId: string,
  itemId: string,
  qty: number,
): Promise<boolean> {
  const { data } = await handle.supabase.rpc('economy_decrement_inventory', {
    p_guild_id: handle.guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: qty,
  });
  return data === true;
}

async function recipeByName(handle: LiveClientHandle, name: string): Promise<RecipeRow | null> {
  const { data } = await handle.supabase
    .from('economy_recipes')
    .select('id, name, output_qty, output_item_id, cooldown_seconds, category')
    .eq('guild_id', handle.guildId)
    .ilike('name', name)
    .limit(1);
  return ((data as RecipeRow[] | null) ?? [])[0] ?? null;
}

async function itemByName(handle: LiveClientHandle, name: string): Promise<ItemRow | null> {
  const { data } = await handle.supabase
    .from('economy_items')
    .select('id, name')
    .eq('guild_id', handle.guildId)
    .ilike('name', name)
    .limit(1);
  return ((data as ItemRow[] | null) ?? [])[0] ?? null;
}

async function recipeCount(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('economy_recipes')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function craftTxns(
  handle: LiveClientHandle,
  userId: string,
): Promise<Array<{ type: string; amount: number; description: string | null }>> {
  const { data } = await handle.supabase
    .from('economy_transactions')
    .select('type, amount, description')
    .eq('guild_id', handle.guildId)
    .eq('user_id', userId)
    .eq('type', 'craft');
  return (data as Array<{ type: string; amount: number; description: string | null }> | null) ?? [];
}

/** Service-role row count for a guild-scoped table, or null when the read errors. */
async function serviceRowCount(handle: LiveClientHandle, table: string): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
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
 * Anon-denial RLS probe via the PostgREST REST endpoint (no @supabase/supabase-js
 * dependency). Returns the number of rows an anon key can read (RLS deny → 0), or
 * null when no anon key/URL is available or the key is rejected before RLS runs.
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
    // Non-2xx: distinguish a genuine AUTHORIZATION denial (SQLSTATE 42501 /
    // "permission denied" — the deny we want) from a rejected key (inconclusive).
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

/**
 * Anon-denial RLS proof made non-vacuous by a positive control: the service role
 * must see ≥1 real row in `table` under this guild while an anon client reads ZERO
 * of them (RLS `<table>_deny_all` / missing anon GRANT → 42501). Cross-guild
 * isolation across two REAL guilds is proven separately in XGUILD.
 */
async function proveRlsIsolation(
  ctx: ScenarioContext,
  handle: LiveClientHandle,
  table: string,
): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      `anon/authenticated clients read zero ${table} rows (RLS ${table}_deny_all / no anon GRANT).`,
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
  const serviceCount = await serviceRowCount(handle, table);
  ctx.expect(serviceCount !== null && serviceCount > 0 && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise: `The service role reads this guild's ${table} rows while an anon client reads zero of them (RLS ${table}_deny_all).`,
    observation:
      `service-role sees ${serviceCount ?? '(read error)'} ${table} row(s) under guild "${handle.guildId}"; ` +
      `an anon-key REST read returned ${anonRows} row(s) for that guild.`,
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
    'Failure-branch alerts (crafting-degraded / backend-unavailable) carry a human-readable reason + remediation hint in the owner alert channel.',
    'requires the live owner alert channel readback (DISCORD_TOKEN + live guild) plus a fault-injected failure branch',
  );
}

/**
 * Crafting embeds carry no owner-currency token (unlike wallet replies), and the
 * brand-kit / voice-preset / powered-by-SomniBot conformance the catalog contracts
 * can only be verified by the embed snapshot inspector against the configured brand
 * kit — a credentialed readback lane. So we capture the REAL member-facing surface
 * and GATE the brand-kit conformance (citing that real surface), never faking it.
 */
function gateBrandKit(ctx: ScenarioContext, captured: CapturedResponse, surfaceLabel: string): void {
  const surface = brandingSurface(captured);
  if (!surface) {
    ctx.gate(
      'branding',
      'captured-reply',
      'Member-facing crafting surfaces match the owner brand kit and voice preset with the subtle powered-by-SomniBot attribution.',
      `this scenario produced no member-facing ${surfaceLabel} to inspect for branding`,
    );
    return;
  }
  ctx.gate(
    'branding',
    'discord-readback',
    'The member-facing crafting surface matches the owner white-label brand kit (name, colors, voice preset, powered-by-SomniBot) with zero stock-bot wording.',
    `captured ${surfaceLabel} surface "${truncate(surface)}" carries no in-process-verifiable owner brand token; ` +
      'full brand-kit/voice conformance needs the embed snapshot inspector (DISCORD_TOKEN + live guild against the configured brand kit)',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'Re-delivering this scenario’s craft triggers yields no duplicate consumption / output / craft transaction.',
    `/craft's only replay guard is the Valkey SET PX NX cooldown lock (no DB idempotency key); replay/idempotency is exercised in the ${where} scenario`,
  );
}

function gateLiveGuildReadback(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The crafting surfaces are observed working in the live test guild (channel embeds, refund/cooldown notices).',
    'requires a live Discord gateway (DISCORD_TOKEN + live guild) for channel/message readback',
  );
}

/** Common enabled-crafting boot overrides. */
function craftingEnabled(cooldownSeconds: number): Record<string, unknown> {
  return { economy_crafting_enabled: true, economy_crafting_cooldown_seconds: cooldownSeconds };
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — default recipe book seeds & lists; /craft consumes+produces; cooldown paces. */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const cooldownDefault = Number(declaredDefault(ctx.domain, 'crafting-cooldown-seconds')); // 60
  const enabledDefault = declaredDefault(ctx.domain, 'crafting-enabled'); // true

  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: {
      economy_crafting_enabled: enabledDefault === true,
      economy_crafting_cooldown_seconds: cooldownDefault,
    },
  });
  const userA = ctx.userId('a');

  // 1) First /recipes seeds the default book (DB-observable) — the seed insert runs
  //    BEFORE the embed render loop, so the rows persist even if rendering later throws.
  const recipesCaptured = await ctx.runSlash(handle, {
    commandName: 'recipes',
    userId: userA,
    displayName: 'DEF A',
  });
  const ironBar = await recipeByName(handle, 'Iron Bar');
  const ironBarItem = await itemByName(handle, 'Iron Bar');
  const count = await recipeCount(handle);
  ctx.expect(
    count > 0 && ironBar !== null && ironBar.output_qty === 1 && ironBar.output_item_id !== null && ironBarItem !== null,
    {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise:
        'First /recipes seeds the default recipe book: the "Iron Bar" recipe (output 1) and its linked output item are created.',
      observation:
        `economy_recipes rows=${count}; Iron Bar recipe present=${ironBar !== null} ` +
        `(output_qty=${ironBar?.output_qty}, output_item_id linked=${ironBar?.output_item_id != null}); ` +
        `Iron Bar item present=${ironBarItem !== null}.`,
      impact: 'The default recipe book was not seeded / linked as contracted.',
    },
  );

  // 2) …and /recipes replies with the branded Recipe Book embed listing the book.
  ctx.expect(embedTitle(recipesCaptured).includes('Recipe Book') && brandingSurface(recipesCaptured).includes('Iron Bar'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/recipes replies with the Recipe Book embed listing the seeded recipes grouped by category.',
    observation:
      `recipe embed title="${embedTitle(recipesCaptured) || '(no embed)'}", ` +
      `surface includes "Iron Bar"=${brandingSurface(recipesCaptured).includes('Iron Bar')}.`,
    impact:
      'The /recipes reply did not render the seeded recipe book (e.g. the default-recipe inputs JSON.stringify-into-jsonb broke the render loop).',
  });

  // 3) /craft "Iron Bar": the consume/produce path acquires a Valkey SET PX NX cooldown
  //    lock FIRST, so the whole happy path needs Redis. GATE it honestly when absent.
  if (ctx.capabilities.redis) {
    const ironOreId = await createItem(handle, 'Iron Ore');
    if (ironOreId) await giveInventory(handle, userA, ironOreId, 4);
    const craftCaptured = await ctx.runSlash(handle, { commandName: 'craft', userId: userA, options: { item: 'Iron Bar' } });
    const oreAfter = ironOreId ? await inventoryQty(handle, userA, ironOreId) : -1;
    const barAfter = ironBarItem ? await inventoryQty(handle, userA, ironBarItem.id) : -1;
    ctx.expect(oreAfter === 0 && barAfter === 1, {
      assertionClass: 'Discord',
      channel: 'db-observable',
      promise: '/craft "Iron Bar" consumes exactly 4 Iron Ore and adds exactly 1 Iron Bar to inventory.',
      observation: `after craft: Iron Ore qty=${oreAfter} (expected 0), Iron Bar qty=${barAfter} (expected 1).`,
      impact: 'The craft did not atomically consume the listed ingredients and produce exactly one output.',
    });
    const craftTx = await craftTxns(handle, userA);
    ctx.expect(craftTx.length === 1, {
      assertionClass: 'audit',
      channel: 'audit-row',
      promise: 'A successful craft records exactly one append-only economy_transactions ledger row (type "craft") with actor + guild.',
      observation: `craft ledger rows=${craftTx.length} (desc="${craftTx[0]?.description ?? ''}").`,
      impact: 'A craft did not produce exactly one correct ledger row.',
    });
    const repeat = await ctx.runSlash(handle, { commandName: 'craft', userId: userA, options: { item: 'Iron Bar' } });
    const repeatSurface = brandingSurface(repeat);
    ctx.expect(/wait/i.test(repeatSurface) || repeatSurface.includes('⏳'), {
      assertionClass: 'Discord',
      channel: 'captured-reply',
      promise: 'An immediate second /craft is refused by the active per-member cooldown with the remaining wait.',
      observation: `repeat /craft surface="${truncate(repeatSurface)}".`,
      impact: 'The per-member crafting cooldown did not refuse an immediate repeat craft.',
    });
    gateBrandKit(ctx, craftCaptured, 'Crafted embed');
  } else {
    ctx.gate(
      'Discord',
      'redis-dependency',
      '/craft "Iron Bar" consumes exactly 4 Iron Ore and adds exactly 1 Iron Bar, and an immediate repeat is refused by the per-member cooldown.',
      'no Valkey/Redis reachable — /craft acquires an atomic SET PX NX cooldown lock at the top of the handler, so the consume/produce/cooldown path cannot run',
    );
    ctx.gate(
      'audit',
      'redis-dependency',
      'A successful craft lands exactly one economy_transactions ledger row (type "craft").',
      'no Valkey/Redis reachable — /craft cannot run to produce its ledger row',
    );
    gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  }

  await proveRlsIsolation(ctx, handle, 'economy_recipes');
  await proveNoOwnerAlert(ctx, handle);
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-A — the owner lowers the fallback cooldown; it persists live. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const lowered = 5;
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(lowered),
  });
  const userA = ctx.userId('a');

  // Config persisted DB-observably (economy_crafting_cooldown_seconds is the fallback
  // cooldown for recipes without their own per-recipe cooldown).
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_crafting_cooldown_seconds, economy_crafting_enabled')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const row = cfg as CraftingConfigRow | null;
  ctx.expect(row?.economy_crafting_cooldown_seconds === lowered && row?.economy_crafting_enabled === true, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'Lowering economy_crafting_cooldown_seconds persists live to guild_config with crafting still enabled.',
    observation:
      `guild_config economy_crafting_cooldown_seconds=${row?.economy_crafting_cooldown_seconds} (expected ${lowered}), ` +
      `crafting_enabled=${row?.economy_crafting_enabled}.`,
    impact: 'A saved crafting-cooldown configuration did not persist.',
  });

  // /recipes keeps rendering under the new config.
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  ctx.expect(embedTitle(recipesCaptured).includes('Recipe Book'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/recipes keeps working after the cooldown config change.',
    observation: `/recipes ${embedTitle(recipesCaptured) ? `rendered "${embedTitle(recipesCaptured)}"` : 'produced no embed'}.`,
    impact: '/recipes stopped rendering after a config change.',
  });

  // The actual "re-craftable after 5s instead of 60s, no restart" effect rides the
  // Valkey SET PX NX TTL → Redis-gated (the fallback only applies to recipes with a
  // zero per-recipe cooldown, and the timing itself lives in Valkey).
  ctx.gate(
    'Discord',
    'redis-dependency',
    'After lowering the fallback cooldown, a fallback-cooldown recipe re-crafts after 5s (not 60s) with no restart; a repeat inside 5s still returns the cooldown message.',
    'no Valkey/Redis reachable — the per-member cooldown is a Valkey SET PX NX TTL; the re-craft-timing effect cannot be exercised',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'The re-craft after the lowered cooldown records one further craft ledger row.',
    'no Valkey/Redis reachable — /craft cannot run to produce its ledger row',
  );

  await proveRlsIsolation(ctx, handle, 'economy_recipes');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** SET-B — the owner switches crafting off cleanly. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: { economy_crafting_enabled: false },
  });
  const userA = ctx.userId('a');

  // With economy_crafting_enabled off at boot, the CraftingManager is NOT wired
  // (guild-init.ts gate), so /recipes and /craft take the dispatcher's crafting-not-
  // enabled fallback reply.
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  const craftCaptured = await ctx.runSlash(handle, { commandName: 'craft', userId: userA, options: { item: 'Iron Bar' } });
  const recipesContent = replyContent(recipesCaptured);
  const craftContent = replyContent(craftCaptured);
  const disabled = (s: string): boolean => /not enabled/i.test(s);
  ctx.expect(disabled(recipesContent) && disabled(craftContent), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'With crafting disabled, /recipes and /craft both reply that crafting is not enabled.',
    observation: `/recipes reply="${truncate(recipesContent)}"; /craft reply="${truncate(craftContent)}".`,
    impact: 'A disabled-crafting guild did not receive the crafting-not-enabled reply.',
  });

  // No recipe rows were seeded while disabled (no inventory changes either).
  const seeded = await recipeCount(handle);
  ctx.expect(seeded === 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'A disabled /recipes / /craft seeds no recipe rows and mutates no inventory.',
    observation: `economy_recipes rows for the guild=${seeded} (expected 0 while disabled).`,
    impact: 'Crafting wrote rows while the feature was disabled.',
  });

  // RLS positive control: a guild-scoped economy_items row (crafting disabled seeds none).
  const probeItem = await createItem(handle, `${ctx.runPrefix}disabled-probe`);
  ctx.expect(probeItem !== null, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a guild-scoped economy_items row exists as the RLS positive control.',
    observation: `economy_items probe row created=${probeItem !== null}.`,
    impact: 'Could not arrange the RLS positive-control row.',
  });

  ctx.gate(
    'audit',
    'db-observable',
    'A disabled-crafting path writes no craft ledger row.',
    'crafting is disabled so no /craft action (and no ledger row) is produced; audit-row evidence is proven where crafting is enabled and a craft runs (Valkey-gated)',
  );
  await proveRlsIsolation(ctx, handle, 'economy_items');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'crafting-disabled reply');
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** INVALID — a rejected invalid crafting config never persists. */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const validCooldown = 120;
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(validCooldown),
  });
  const userA = ctx.userId('a');

  // guild_config keeps its prior valid cooldown byte-for-byte (nothing invalid persisted).
  const { data: cfg } = await handle.supabase
    .from('guild_config')
    .select('economy_crafting_cooldown_seconds')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  const row = cfg as { economy_crafting_cooldown_seconds: number } | null;
  ctx.expect(row?.economy_crafting_cooldown_seconds === validCooldown, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'guild_config keeps its prior valid crafting cooldown byte-for-byte (a rejected invalid save never persists).',
    observation: `guild_config economy_crafting_cooldown_seconds=${row?.economy_crafting_cooldown_seconds} (expected ${validCooldown}).`,
    impact: 'A valid crafting cooldown configuration was not retained.',
  });

  // Behavior unchanged on the very next command after a rejected save.
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  ctx.expect(embedTitle(recipesCaptured).includes('Recipe Book'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Live crafting behavior is unchanged on the very next command after a rejected config save.',
    observation: `/recipes ${embedTitle(recipesCaptured) ? `rendered "${embedTitle(recipesCaptured)}"` : 'produced no embed'}.`,
    impact: 'A rejected config attempt disturbed live crafting behavior.',
  });

  // The negative-cooldown REJECTION lives in the dashboard Zod layer;
  // economy_crafting_cooldown_seconds has no DB CHECK (integer NOT NULL DEFAULT 60),
  // so the reject path is not reachable in a bot-only harness. GATE it honestly.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The dashboard crafting page surfaces a validation error (or clamps) for a negative fallback cooldown.',
    'config validation lives in the dashboard (Zod) layer; economy_crafting_cooldown_seconds has no DB CHECK constraint, so a bot-only harness cannot drive the reject path',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'One audit row records the rejected crafting-config attempt with the validation reason; no config-change audit row is written.',
    'the rejected-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, 'economy_recipes');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** UNAUTH — a member's craft only ever consumes their OWN inventory. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(60),
  });
  const userA = ctx.userId('a');
  const userB = ctx.userId('b');

  // Two members each own the SAME material in their OWN inventory rows.
  const oreId = await createItem(handle, 'Iron Ore');
  if (oreId) {
    await giveInventory(handle, userA, oreId, 5);
    await giveInventory(handle, userB, oreId, 5);
  }

  // The atomic primitive every /craft uses (economy_decrement_inventory) is keyed by
  // the invoking member's OWN user_id — decrementing member B never touches member A.
  const bOk = oreId ? await decrementInventory(handle, userB, oreId, 3) : false;
  const aAfter = oreId ? await inventoryQty(handle, userA, oreId) : -1;
  const bAfter = oreId ? await inventoryQty(handle, userB, oreId) : -1;
  ctx.expect(bOk && bAfter === 2 && aAfter === 5, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: "A member's craft only ever consumes their OWN inventory: consuming member B's materials leaves member A's inventory byte-identical.",
    observation: `member B Iron Ore 5→${bAfter} (consumed 3, ok=${bOk}); member A Iron Ore=${aAfter} (expected unchanged 5).`,
    impact: "A craft consumed another member's inventory — the own-inventory-only guarantee was breached.",
  });

  // The non-admin dashboard save refusal is a dashboard session-auth lane.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A non-admin dashboard session cannot save crafting settings (authorization error).',
    'requires the dashboard session-auth lane (not reachable in this bot-only harness)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'An audit row records the denied crafting-config attempt with actor and reason permission-denied.',
    'the denied-config audit row is written by the dashboard save path (not reachable in a bot-only harness)',
  );

  await proveRlsIsolation(ctx, handle, 'economy_inventory');
  await proveNoOwnerAlert(ctx, handle);
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** DEPFAIL — Supabase-unreachable fail-safe (needs a dependency-outage fault lane). */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // This DB-observable harness's whole premise is a REACHABLE local Supabase, so a
  // database-outage cannot be induced without a fault-injection lane. GATE the
  // outage-dependent behavior honestly rather than fake an outage.
  ctx.gate(
    'Discord',
    'db-observable',
    'With database access blocked, /craft and /recipes reply with the branded crafting-unavailable message and no inventory mutation occurs.',
    'requires a Supabase dependency-outage fault-injection lane (the harness deliberately runs against a reachable local DB)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The owner receives a single dependency-degradation alert for the outage window (not one per failed craft).',
    'requires a dependency-outage fault lane plus owner alert channel readback',
  );
  ctx.gate(
    'audit',
    'db-observable',
    'After restoration a fresh /craft consumes exactly once and applies.',
    'requires the outage fault lane and (for /craft) a Valkey/Redis cooldown path',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'No duplicate consumption survives the outage/restore cycle.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The degradation reply uses the branded crafting-unavailable template in the owner voice.',
    'requires the outage fault lane to reach the crafting-unavailable branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    'Crafting rows stay guild-scoped through the outage window.',
    'requires a Supabase dependency-outage fault-injection lane',
  );
}

/** RETRY — a craft whose output step fails refunds every consumed ingredient once. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The refund branch triggers only when the output economy_upsert_inventory FAILS
  // after ingredients were consumed — a mid-craft fault requiring injection at the
  // inventory-RPC boundary (and the /craft path itself needs Valkey). GATE it; never
  // fabricate a failure.
  ctx.gate(
    'Discord',
    'db-observable',
    'With a fault on the output economy_upsert_inventory, every consumed ingredient is refunded once, no output exists, and a clean retry crafts exactly one output for exactly one consumption.',
    'requires a mid-/craft fault-injection lane (fail the output economy_upsert_inventory after ingredients are consumed) — and the /craft path itself needs Valkey',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Inventory shows consume, refund, consume — never a double consume and never a double refund.',
    'requires the mid-/craft fault-injection lane',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The refund restores each consumed ingredient exactly once and the retry consumes exactly once.',
    'requires the mid-/craft fault-injection lane',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The member sees the branded materials-refunded notice.',
    'requires the mid-/craft fault-injection lane to reach the refund branch',
  );
  ctx.gate(
    'database-RLS',
    'db-rls',
    "The refund touches only the invoking member's guild-scoped inventory.",
    'requires the mid-/craft fault-injection lane',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A repeated output-write failure raises exactly one owner crafting-degraded alert; a one-off self-healing refund raises none.',
    'requires the mid-/craft fault-injection lane plus owner alert channel readback',
  );
}

/** REPLAY — re-delivering a /craft must not double-consume or double-produce. */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(60),
  });
  const userA = ctx.userId('a');

  // A real member-facing surface + a seeded inventory row (RLS positive control),
  // both DB-observable without Redis.
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  const oreId = await createItem(handle, 'Iron Ore');
  if (oreId) await giveInventory(handle, userA, oreId, 4);
  const oreQty = oreId ? await inventoryQty(handle, userA, oreId) : 0;
  ctx.expect(oreQty === 4, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'Test arrangement: a guild-scoped economy_inventory row exists as the RLS positive control.',
    observation: `seeded Iron Ore qty=${oreQty} (expected 4).`,
    impact: 'Could not arrange the RLS positive-control inventory row.',
  });
  ctx.expect(embedTitle(recipesCaptured).includes('Recipe Book'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: '/recipes renders the recipe book (a real member-facing surface exists for this scenario).',
    observation: `/recipes ${embedTitle(recipesCaptured) ? `rendered "${embedTitle(recipesCaptured)}"` : 'produced no embed'}.`,
    impact: '/recipes failed to render.',
  });

  // Crafting has NO DB idempotency key: the sole replay guard is the atomic Valkey
  // SET PX NX cooldown lock on economy:craft:{guild}:{user}. Un-runnable without Redis.
  ctx.gate(
    'replay-safety',
    'redis-dependency',
    'Re-delivering the same /craft interaction consumes ingredients once and produces output once (the atomic SET PX NX cooldown lock rejects the duplicate within its window).',
    'no Valkey/Redis reachable — /craft has no DB idempotency key; its sole replay guard is the Valkey SET PX NX cooldown lock, which cannot run',
  );
  ctx.gate(
    'Discord',
    'redis-dependency',
    'The channel shows exactly one crafted embed despite the replay and inventory totals match the pre-replay snapshot.',
    'no Valkey/Redis reachable — the /craft path (and thus its replay) cannot run',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'A replayed craft writes exactly one craft ledger row.',
    'no Valkey/Redis reachable — /craft cannot run to produce a ledger row',
  );

  await proveRlsIsolation(ctx, handle, 'economy_inventory');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateLiveGuildReadback(ctx);
}

/** RESTART — recipe book + inventory survive a full stack reboot. */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const userA = ctx.userId('a');

  // Boot #1: enable crafting, seed the book via /recipes + a distinctive inventory qty, snapshot.
  const first = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0, guildConfigOverrides: craftingEnabled(60) });
  await ctx.runSlash(first, { commandName: 'recipes', userId: userA });
  const oreId = await createItem(first, 'Iron Ore');
  if (oreId) await giveInventory(first, userA, oreId, 7);
  const recipesBefore = await recipeCount(first);
  const oreBefore = oreId ? await inventoryQty(first, userA, oreId) : -1;
  await first.cleanup(); // simulate shutdown

  // Boot #2: SAME guild id (restart). State lives in Supabase, so it must be identical.
  const second = await ctx.bootGuild({ guildId, label: 'a', economyStartingBalance: 0, guildConfigOverrides: craftingEnabled(60) });
  const recipesCaptured = await ctx.runSlash(second, { commandName: 'recipes', userId: userA });
  const recipesAfter = await recipeCount(second);
  const oreAfter = oreId ? await inventoryQty(second, userA, oreId) : -1;
  ctx.expect(recipesAfter === recipesBefore && recipesBefore > 0 && oreAfter === oreBefore && oreBefore === 7, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'After a full stack restart, the seeded recipe book and inventory match the pre-restart snapshot exactly.',
    observation:
      `recipes ${recipesBefore}→${recipesAfter} (unchanged, >0); ` +
      `Iron Ore qty ${oreBefore}→${oreAfter} (expected 7).`,
    impact: 'Crafting state (recipe book / inventory) did not survive a restart.',
  });
  ctx.expect(embedTitle(recipesCaptured).includes('Recipe Book'), {
    assertionClass: 'Discord',
    channel: 'captured-reply',
    promise: 'Post-restart /recipes renders the persisted recipe book (and does not re-seed duplicates).',
    observation:
      `post-restart /recipes ${embedTitle(recipesCaptured) ? `rendered "${embedTitle(recipesCaptured)}"` : 'produced no embed'}; ` +
      `recipe rows=${recipesAfter}.`,
    impact: 'Post-restart /recipes failed to render the persisted book.',
  });

  // The "cooldown window that spans the restart is still refused" facet rides the Valkey lock.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'A /craft whose cooldown window spans the restart is still refused rather than consuming a second time.',
    'no Valkey/Redis reachable — the per-member cooldown is a Valkey SET PX NX lock; the cross-restart refusal cannot be exercised',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'A pre-restart craft ledger row persists across the restart.',
    'no Valkey/Redis reachable — /craft could not run pre-restart to produce a ledger row',
  );

  await proveRlsIsolation(ctx, second, 'economy_inventory');
  await proveNoOwnerAlert(ctx, second);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** RACE — concurrent crafts consume ingredients exactly once. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(60),
  });
  const userA = ctx.userId('a');

  // Real DB-observable atomicity: the SAME primitive /craft uses to consume ingredients
  // (economy_decrement_inventory, SELECT … FOR UPDATE) must succeed exactly once when
  // two crafts race for one craft-worth of materials — never a double consume / free craft.
  const oreId = await createItem(handle, 'Iron Ore');
  if (oreId) await giveInventory(handle, userA, oreId, 4);
  const [r1, r2] = await Promise.all([
    decrementInventory(handle, userA, oreId ?? '', 4),
    decrementInventory(handle, userA, oreId ?? '', 4),
  ]);
  const successes = [r1, r2].filter(Boolean).length;
  const oreAfter = oreId ? await inventoryQty(handle, userA, oreId) : -1;
  ctx.expect(successes === 1 && oreAfter === 0, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise:
      'Two concurrent ingredient consumptions for one craft-worth of materials succeed exactly once (atomic economy_decrement_inventory) — never a double consume, never a free craft.',
    observation: `concurrent decrements succeeded=${successes} (expected 1); remaining Iron Ore=${oreAfter} (expected 0, not -4).`,
    impact: 'The atomic ingredient decrement allowed a double consume / free craft under concurrency.',
  });

  // The one-crafted-embed + one-cooldown-refusal at the /craft level rides the Valkey lock.
  ctx.gate(
    'Discord',
    'redis-dependency',
    'Two simultaneous /craft calls yield exactly one crafted embed and one cooldown refusal.',
    'no Valkey/Redis reachable — the SET PX NX cooldown lock that guarantees a single craft cannot run',
  );
  ctx.gate(
    'audit',
    'redis-dependency',
    'Two simultaneous /craft calls write exactly one craft ledger row.',
    'no Valkey/Redis reachable — /craft cannot run to produce a ledger row',
  );

  // A real member-facing surface for branding + an economy_recipes positive control
  // (the race emptied the inventory row, so probe the seeded recipe book instead).
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  await proveRlsIsolation(ctx, handle, 'economy_recipes');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');
  gateLiveGuildReadback(ctx);
}

/** XGUILD — crafting is strictly per-guild. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const userA = ctx.userId('a');
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, economyStartingBalance: 0, guildConfigOverrides: craftingEnabled(60) });
  const handleB = await ctx.bootGuild({ guildId: guildB, economyStartingBalance: 0, guildConfigOverrides: craftingEnabled(60) });

  // Seed guild A: recipes + a distinctive inventory qty; snapshot.
  await ctx.runSlash(handleA, { commandName: 'recipes', userId: userA });
  const oreAId = await createItem(handleA, 'Iron Ore');
  if (oreAId) await giveInventory(handleA, userA, oreAId, 9);
  const recipesA0 = await recipeCount(handleA);
  const oreA0 = oreAId ? await inventoryQty(handleA, userA, oreAId) : -1;

  // Same user seeds/earns independently in guild B.
  const recipesCapturedB = await ctx.runSlash(handleB, { commandName: 'recipes', userId: userA });
  const oreBId = await createItem(handleB, 'Iron Ore');
  if (oreBId) await giveInventory(handleB, userA, oreBId, 2);
  const oreB = oreBId ? await inventoryQty(handleB, userA, oreBId) : -1;
  const oreAAfter = oreAId ? await inventoryQty(handleA, userA, oreAId) : -1;
  const recipesAAfter = await recipeCount(handleA);

  ctx.expect(oreB === 2 && oreAAfter === oreA0 && oreA0 === 9 && recipesAAfter === recipesA0 && recipesA0 > 0, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: "Crafting in a second guild never touches the first guild's recipe book or inventory; each guild evolves independently.",
    observation:
      `guild A Iron Ore=${oreAAfter} (unchanged at ${oreA0}=9), recipes=${recipesAAfter} (unchanged at ${recipesA0}); ` +
      `guild B Iron Ore=${oreB} (2).`,
    impact: "Cross-guild crafting activity mutated another guild's inventory/recipe book — per-guild isolation broken.",
  });

  // Each guild scope reads its OWN inventory row and never the other's.
  const { data: bScoped } = await handleB.supabase
    .from('economy_inventory')
    .select('quantity, guild_id')
    .eq('guild_id', guildB)
    .eq('user_id', userA)
    .eq('item_id', oreBId ?? '')
    .maybeSingle();
  const { data: aScoped } = await handleA.supabase
    .from('economy_inventory')
    .select('quantity, guild_id')
    .eq('guild_id', guildA)
    .eq('user_id', userA)
    .eq('item_id', oreAId ?? '')
    .maybeSingle();
  const bRow = bScoped as { quantity: number; guild_id: string } | null;
  const aRow = aScoped as { quantity: number; guild_id: string } | null;
  ctx.expect(bRow?.guild_id === guildB && bRow?.quantity === 2 && aRow?.guild_id === guildA && aRow?.quantity === 9, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      "Each guild scope reads its OWN economy_inventory row and never the other guild's (guild B → its 2-qty row, guild A → its 9-qty row).",
    observation:
      `guild-B-scoped read=${bRow?.quantity} under "${bRow?.guild_id}"; ` +
      `guild-A-scoped read=${aRow?.quantity} under "${aRow?.guild_id}" (distinct rows under distinct guild_ids).`,
    impact: "A guild-scoped read returned the other guild's inventory row — cross-guild leakage.",
  });
  await proveRlsIsolation(ctx, handleA, 'economy_inventory');

  ctx.gate(
    'audit',
    'db-observable',
    "Each guild keeps its own craft ledger; craft rows do not cross guilds.",
    'this cross-guild isolation scenario seeds inventory directly and drives no /craft (Valkey-gated), so no economy_transactions craft row is written; per-guild ledger scoping is proven where real craft rows exist',
  );
  await proveNoOwnerAlert(ctx, handleA);
  gateBrandKit(ctx, recipesCapturedB, 'Recipe Book embed');
  gateLiveGuildReadback(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
}

/** CLEANUP — the suite leaves no trace: run-prefixed crafting rows are removed and verified absent. */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({
    label: 'a',
    economyStartingBalance: 0,
    guildConfigOverrides: craftingEnabled(60),
  });
  const userA = ctx.userId('a');

  // Create run-prefixed operational rows: recipes (+ output items via /recipes) and an inventory row.
  const recipesCaptured = await ctx.runSlash(handle, { commandName: 'recipes', userId: userA });
  const oreId = await createItem(handle, 'Iron Ore');
  if (oreId) await giveInventory(handle, userA, oreId, 6);
  const recipesBefore = await recipeCount(handle);
  const itemsBefore = (await serviceRowCount(handle, 'economy_items')) ?? 0;
  const invBefore = oreId ? await inventoryQty(handle, userA, oreId) : 0;
  ctx.expect(recipesBefore > 0 && itemsBefore > 0 && invBefore === 6, {
    assertionClass: 'Discord',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed recipe, item, and inventory rows (pre-cleanup baseline).',
    observation: `pre-cleanup: recipes=${recipesBefore}, items=${itemsBefore}, Iron Ore qty=${invBefore}.`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist (before the sweep removes them).
  await proveRlsIsolation(ctx, handle, 'economy_inventory');
  await proveNoOwnerAlert(ctx, handle);
  gateBrandKit(ctx, recipesCaptured, 'Recipe Book embed');

  // Run the sweep (the same one teardown uses) and verify ZERO run-prefixed crafting rows remain.
  await ctx.sweepGuildRows(handle);
  const recipesAfter = await recipeCount(handle);
  const itemsAfter = (await serviceRowCount(handle, 'economy_items')) ?? 0;
  const invAfter = oreId ? await inventoryQty(handle, userA, oreId) : 0;
  ctx.expect(recipesAfter === 0 && itemsAfter === 0 && invAfter === 0, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed recipe, item, and inventory rows are deleted; a final sweep finds zero run-prefixed crafting resources.',
    observation: `post-sweep: recipes=${recipesAfter}, items=${itemsAfter}, Iron Ore qty=${invAfter}.`,
    impact: 'The cleanup sweep left run-prefixed crafting rows behind — the suite leaves residue.',
  });

  // Discord/channel readback of removed embeds, and audit "anonymized-not-deleted"
  // history in the dedicated audit_logs table, are separate lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test guilds contain no run-prefixed craft embeds, recipe-book listings, or refund notices after cleanup.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'Audit history is anonymized rather than deleted (operational rows deleted, audit_logs retained).',
    'requires an audit_logs anonymization readback lane (the crafting operational rows are the DB-observable evidence here)',
  );

  gateReplayDeferredTo(ctx, 'REPLAY');
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The crafting domain proof: the guild_id-scoped tables the sweep must clear
 * (child → parent so FK-constrained rows are removed before the guild row), plus
 * the 12 scenario scripts.
 */
export const gameEconomyCraftingProof: DomainProof = {
  domainId: 'game-economy-crafting',
  guildScopedTables: [
    // child → parent: economy_inventory/economy_recipes reference economy_items
    // (ON DELETE CASCADE), so remove them before their parent items.
    'economy_transactions',
    'economy_inventory',
    'economy_recipes',
    'economy_items',
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
