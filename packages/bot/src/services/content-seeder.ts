/**
 * Starter content for features that shipped with none.
 *
 * The live-database audit found 102 of 112 guild-scoped tables empty. Six
 * features had defaults that merely seeded lazily (fixed in guild-init's
 * content warmup); the features here had NO defaults at all — achievements
 * could never unlock because zero definitions existed, automod had zero rules
 * to evaluate, and the shop had nothing to sell. "Enabled" features that can
 * do nothing until the operator authors content from scratch are not enabled
 * in any sense a server owner would recognise.
 *
 * Everything seeded here is live against the code that consumes it:
 *  - achievement conditions are ONLY the two the bot actually fires
 *    (messages_sent and level from the message-XP path) — no aspirational
 *    condition types that nothing evaluates;
 *  - automod rule configs match the engine's typed config for each rule, and
 *    enforcement still follows the guild's automod_mode (ships as observe, so
 *    nothing punishes anyone until the owner turns enforcement on);
 *  - shop items carry use_effects the bot executes: the padlock feeds rob
 *    protection, and the three tools are exactly what /hunt, /dig and /mine
 *    look up by effect type and tier.
 *
 * Idempotent per table: achievements and automod rules are gated on ANY row
 * existing, so operator edits and deletions are never overwritten or
 * resurrected. The shop gate is name-scoped instead — crafting's warmup also
 * writes economy_items rows (recipe outputs), so an any-row gate would starve
 * the starter shop on every default install. Any surviving row bearing one of
 * the four starter item names (edited, deactivated, or untouched) suppresses
 * the shop seed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ContentSeeder');

const ACHIEVEMENT_DEFS = [
  // messages_sent — fired from the message-XP path with the member's total.
  { name: 'First Words', description: 'Send your first message.', badge_emoji: '👋', condition_type: 'messages_sent', condition_value: 1, reward_currency: 50, reward_xp: 0, hidden: false },
  { name: 'Chatterbox', description: 'Send 100 messages.', badge_emoji: '💬', condition_type: 'messages_sent', condition_value: 100, reward_currency: 250, reward_xp: 100, hidden: false },
  { name: 'Voice of the Server', description: 'Send 1,000 messages.', badge_emoji: '📣', condition_type: 'messages_sent', condition_value: 1000, reward_currency: 1000, reward_xp: 500, hidden: false },
  { name: 'Legend of the Halls', description: 'Send 10,000 messages.', badge_emoji: '🏛️', condition_type: 'messages_sent', condition_value: 10000, reward_currency: 5000, reward_xp: 2000, hidden: false },
  // level — fired on level-up with the new level.
  { name: 'Getting Started', description: 'Reach level 5.', badge_emoji: '⭐', condition_type: 'level', condition_value: 5, reward_currency: 100, reward_xp: 0, hidden: false },
  { name: 'Rising Star', description: 'Reach level 10.', badge_emoji: '🌟', condition_type: 'level', condition_value: 10, reward_currency: 300, reward_xp: 0, hidden: false },
  { name: 'Veteran', description: 'Reach level 25.', badge_emoji: '🎖️', condition_type: 'level', condition_value: 25, reward_currency: 1500, reward_xp: 0, hidden: false },
  { name: 'Mythic', description: 'Reach level 50.', badge_emoji: '🐉', condition_type: 'level', condition_value: 50, reward_currency: 5000, reward_xp: 0, hidden: false },
];

const AUTOMOD_RULES = [
  {
    name: 'Block server invites',
    type: 'invite_filter',
    action: 'delete',
    enabled: true,
    config: { allowOwnServer: true },
    mute_duration_minutes: null,
    priority: 10,
  },
  {
    name: 'Anti-spam',
    type: 'spam_filter',
    action: 'mute',
    enabled: true,
    config: { maxMessages: 6, intervalSeconds: 5 },
    mute_duration_minutes: 10,
    priority: 20,
  },
  {
    name: 'Mass mention protection',
    type: 'mention_spam',
    action: 'delete',
    enabled: true,
    config: { maxMentions: 8 },
    mute_duration_minutes: null,
    priority: 30,
  },
].map((r) => ({
  ...r,
  log_to_mod_channel: true,
  // Discord-side AutoMod mirroring stays off until the owner opts in — seeding
  // must not mutate the Discord server.
  sync_to_discord: false,
  exempt_roles: [],
  exempt_channels: [],
}));

const SHOP_ITEMS = [
  {
    name: 'Padlock',
    description: 'Protects your wallet from one robbery attempt, then breaks.',
    emoji: '🔒',
    category: 'Protection',
    price: 500,
    sell_price: 200,
    usable: true,
    use_effect: { type: 'padlock' },
    durability: null,
    sort_order: 1,
  },
  {
    name: 'Shovel',
    description: 'Tier 1 digging tool — better finds from /dig while it lasts.',
    emoji: '🪏',
    category: 'Tools',
    price: 500,
    sell_price: 200,
    usable: false,
    use_effect: { type: 'shovel', tier: 1 },
    durability: 50,
    sort_order: 2,
  },
  {
    name: 'Pickaxe',
    description: 'Tier 1 mining tool — better finds from /mine while it lasts.',
    emoji: '⛏️',
    category: 'Tools',
    price: 750,
    sell_price: 300,
    usable: false,
    use_effect: { type: 'pickaxe', tier: 1 },
    durability: 50,
    sort_order: 3,
  },
  {
    name: 'Hunting Rifle',
    description: 'Tier 1 hunting tool — better finds from /hunt while it lasts.',
    emoji: '🏹',
    category: 'Tools',
    price: 750,
    sell_price: 300,
    usable: false,
    use_effect: { type: 'hunting_rifle', tier: 1 },
    durability: 50,
    sort_order: 4,
  },
].map((i) => ({
  ...i,
  stock: null, // null = unlimited in the store
  max_per_user: null,
  tradeable: true,
  active: true,
  require_role_id: null,
  grant_role_id: null,
}));

/**
 * Insert rows unless the guild already has matching rows.
 *
 * The gate is name-scoped when `gateNames` is provided (only rows whose `name`
 * is one of the seed names count), otherwise any row in the table counts.
 * Failures SURFACE: a failed existence check or a failed write throws so the
 * warmup loop can report degraded seeding instead of logging "complete" over
 * missing content.
 */
async function seedIfEmpty(
  supabase: SupabaseClient,
  guildId: string,
  table: string,
  rows: Record<string, unknown>[],
  gateNames?: string[],
): Promise<void> {
  let gate = supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  if (gateNames) gate = gate.in('name', gateNames);
  const { count, error: countError } = await gate;

  if (countError) {
    throw new Error(`could not check existing ${table} rows: ${countError.message}`);
  }
  if ((count ?? 0) > 0) return; // operator content exists — never touch it

  // Upsert with ON CONFLICT DO NOTHING (no conflict target) so the catalog
  // uniqueness indexes (e.g. economy_items (guild_id, lower(name))) turn a
  // concurrent double-seed into a no-op instead of a hard failure.
  const { error } = await supabase
    .from(table)
    .upsert(rows.map((r) => ({ ...r, guild_id: guildId })), { ignoreDuplicates: true });

  if (error) {
    throw new Error(`seeding ${table} failed: ${error.message}`);
  }
  log.info(`Seeded ${rows.length} starter row(s) into ${table}`);
}

/**
 * Starter shop items reconcile PER ITEM rather than gating on a name count.
 *
 * The catalog uniqueness index means one row per (guild, name): if crafting's
 * warmup or a lazy /craft created its price-0 'Padlock' output shell first, a
 * count gate would starve ALL FOUR starter items forever, and an upsert could
 * never turn the shell into the buyable item. So per name:
 *   - absent            → insert the starter definition
 *   - bare output shell → upgrade it in place (price 0/null AND no use_effect),
 *                         preserving the row id so crafted copies in member
 *                         inventories become the real item
 *   - anything else     → operator-shaped content, never touched
 */
async function reconcileStarterItems(supabase: SupabaseClient, guildId: string): Promise<void> {
  const names = SHOP_ITEMS.map((i) => i.name);
  const { data, error: readError } = await supabase
    .from('economy_items')
    .select('id, name, price, use_effect')
    .eq('guild_id', guildId)
    .in('name', names);

  if (readError) {
    throw new Error(`could not check existing economy_items rows: ${readError.message}`);
  }

  const byName = new Map((data ?? []).map((r) => [String(r.name), r]));
  const toInsert = SHOP_ITEMS.filter((i) => !byName.has(i.name));
  // Crafting output shells are created with exactly price 0 and no use_effect;
  // anything else (including a null price) is operator-shaped and untouchable.
  const toUpgrade = SHOP_ITEMS.filter((i) => {
    const row = byName.get(i.name);
    return row !== undefined && row.price === 0 && row.use_effect === null;
  });

  const failures: string[] = [];
  if (toInsert.length > 0) {
    const { error } = await supabase
      .from('economy_items')
      .upsert(toInsert.map((r) => ({ ...r, guild_id: guildId })), { ignoreDuplicates: true });
    if (error) failures.push(`insert: ${error.message}`);
    else log.info(`Seeded ${toInsert.length} starter item(s)`);
  }
  for (const item of toUpgrade) {
    const row = byName.get(item.name);
    if (row === undefined) continue;
    const { id: _unused, ...fields } = item as Record<string, unknown> & { id?: unknown };
    void _unused;
    const { error } = await supabase
      .from('economy_items')
      .update(fields)
      .eq('guild_id', guildId)
      .eq('id', row.id)
      .eq('price', 0)
      .is('use_effect', null);
    if (error) failures.push(`upgrade ${item.name}: ${error.message}`);
    else log.info(`Upgraded crafting output shell '${item.name}' to the starter shop item`);
  }
  if (failures.length > 0) {
    throw new Error(`starter item reconcile failed: ${failures.join('; ')}`);
  }
}

/**
 * Seed starter content for features that ship without any.
 * Called from guild-init's content warmup; safe to run on every boot.
 * Throws when any table failed to seed (after attempting all of them), so the
 * warmup loop can log a degraded warning instead of a false "complete".
 */
export async function seedStarterContent(
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  const seeds: Array<[string, () => Promise<void>]> = [
    ['economy_achievement_defs', () => seedIfEmpty(supabase, guildId, 'economy_achievement_defs', ACHIEVEMENT_DEFS)],
    ['automod_rules', () => seedIfEmpty(supabase, guildId, 'automod_rules', AUTOMOD_RULES)],
    ['economy_items', () => reconcileStarterItems(supabase, guildId)],
  ];

  const failures: string[] = [];
  for (const [table, run] of seeds) {
    try {
      await run();
    } catch (err) {
      log.warn(`Starter seeding failed for ${table}`, { error: String(err) });
      failures.push(table);
    }
  }
  if (failures.length > 0) {
    throw new Error(`starter content seeding failed for: ${failures.join(', ')}`);
  }
}
