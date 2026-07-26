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
 * Idempotent per table: a guild with ANY rows in a table is left alone, so
 * operator edits and deletions are never overwritten or resurrected.
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
    category: 'protection',
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
    category: 'tool',
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
    category: 'tool',
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
    category: 'tool',
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

/** Insert rows only when the guild has none in that table. */
async function seedIfEmpty(
  supabase: SupabaseClient,
  guildId: string,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const { count, error: countError } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);

  if (countError) {
    log.warn(`Skipping ${table} — could not check existing rows`, { error: countError.message });
    return;
  }
  if ((count ?? 0) > 0) return; // operator content exists — never touch it

  const { error } = await supabase
    .from(table)
    .insert(rows.map((r) => ({ ...r, guild_id: guildId })));

  if (error) {
    log.warn(`Seeding ${table} failed`, { error: error.message });
  } else {
    log.info(`Seeded ${rows.length} starter row(s) into ${table}`);
  }
}

/**
 * Seed starter content for features that ship without any.
 * Called from guild-init's content warmup; safe to run on every boot.
 */
export async function seedStarterContent(
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await seedIfEmpty(supabase, guildId, 'economy_achievement_defs', ACHIEVEMENT_DEFS);
  await seedIfEmpty(supabase, guildId, 'automod_rules', AUTOMOD_RULES);
  await seedIfEmpty(supabase, guildId, 'economy_items', SHOP_ITEMS);
}
