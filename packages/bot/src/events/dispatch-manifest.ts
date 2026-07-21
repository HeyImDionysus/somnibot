/**
 * Dispatch Manifest — single source of truth for the interaction dispatcher's
 * routing keys.
 *
 * PR4 (E2E harness) — Extracted verbatim from the inline literals/Sets that were
 * previously hard-coded in interaction-handler.ts. This module is PURE and
 * SIDE-EFFECT-FREE: it exports only data (typed constants, Sets, arrays) so a
 * validator can enumerate EVERY routed control from this one file without
 * importing the live dispatcher.
 *
 * Behavior contract: interaction-handler.ts now SOURCES its routing keys from
 * here, so these constants and the dispatcher can never drift apart. Every value
 * below is byte-for-byte identical to the literal it replaced; the matching
 * SEMANTICS live in the dispatcher (`startsWith` stays `startsWith`, `===` stays
 * `===`, `.has`/`.includes` unchanged). Changing a value here changes routing.
 */

// ── Slash commands ──────────────────────────────────────────────────────────

/**
 * Slash command names matched by a single `interaction.commandName === '<name>'`
 * check in handleSlashCommand. `setup` is additionally matched in
 * isSetupInteraction (and registered in the command-registry — see
 * REGISTRY_COMMAND_NAMES). `badges`/`prestige` are matched together via `===||===`.
 */
export const SLASH = {
  rank: 'rank',
  leaderboard: 'leaderboard',
  voice: 'voice',
  giveaway: 'giveaway',
  store: 'store',
  license: 'license',
  timers: 'timers',
  farm: 'farm',
  fish: 'fish',
  adventure: 'adventure',
  market: 'market',
  trivia: 'trivia',
  lottery: 'lottery',
  poll: 'poll',
  predict: 'predict',
  pet: 'pet',
  quests: 'quests',
  heist: 'heist',
  badges: 'badges',
  prestige: 'prestige',
  setup: 'setup',
} as const;

/**
 * Music command names — feature-gated family matched with `.has(...)`
 * (`/play`, `/skip`, …). Exported as a Set to preserve the original `.has` call.
 */
export const MUSIC_COMMANDS: ReadonlySet<string> = new Set([
  'play', 'skip', 'stop', 'queue', 'np', 'volume', 'loop', 'shuffle', 'seek', 'remove', 'move', 'pause', 'filter',
]);

/**
 * Economy command names — feature-gated family matched with `.has(...)`,
 * gated by the `economy` manager.
 */
export const ECONOMY_COMMANDS: ReadonlySet<string> = new Set([
  'balance', 'daily', 'weekly', 'monthly', 'work', 'crime', 'beg', 'search',
  'deposit', 'withdraw', 'pay', 'rob', 'passive', 'shop', 'buy', 'sell',
  'inventory', 'use', 'economy-leaderboard', 'collect-income',
]);

/** Gathering command names — `/hunt`, `/dig`, `/mine` — matched with `.has(...)`. */
export const GATHERING_COMMANDS: ReadonlySet<string> = new Set(['hunt', 'dig', 'mine']);

/** Crafting command names — `/craft`, `/recipes` — matched with `.has(...)`. */
export const CRAFTING_COMMANDS: ReadonlySet<string> = new Set(['craft', 'recipes']);

/**
 * Mini-game command names — matched with `.includes(...)`. Kept as an array (not a
 * Set) to preserve the original `Array.prototype.includes` matching semantics.
 */
export const GAME_COMMANDS: readonly string[] = [
  'coinflip', 'slots', 'rps', 'dice', 'blackjack', 'highlow', 'scratch', 'guess',
];

/**
 * Profile command names — matched with `.includes(...)`. Kept as an array to
 * preserve the original `Array.prototype.includes` matching semantics.
 */
export const PROFILE_COMMANDS: readonly string[] = ['profile', 'title', 'bio'];

/**
 * Slash commands routed via the data-driven command-registry (each registered
 * with `registerCommand(...)` in events/handler.ts, dispatched by `lookupCommand`).
 *
 * These are DYNAMICALLY registered at module-load; the authoritative runtime
 * source is `registeredCommands()` in ./command-registry.js. This static mirror
 * exists so a validator can enumerate them from this one manifest — keep it in
 * sync with handler.ts's `registerCommand(...)` calls.
 */
export const REGISTRY_COMMAND_NAMES: readonly string[] = [
  'warn', 'mute', 'kick', 'ban', 'pardon', 'infractions', 'purge', 'xp',
  'help', 'forgetme', 'privacy', 'mydata', 'tutorial', 'setup', 'ticket',
];

/**
 * Every slash command name handled by the INLINE feature-gated dispatch in
 * handleSlashCommand (i.e. everything except the command-registry lane and the
 * dynamic custom-commands lookup). Derived purely from the constants above so it
 * can never drift from them.
 *
 * `SLASH.setup` is EXCLUDED here: /setup is dispatched through the
 * command-registry lane (registerCommand('setup', ...)), not by an inline
 * branch — the SLASH.setup constant exists only for isSetupInteraction's
 * type-guard. It belongs solely to REGISTRY_COMMAND_NAMES.
 *
 * Custom commands are resolved dynamically via `isCustomCommand(...)` and
 * therefore have no static literal to enumerate.
 */
export const INLINE_SLASH_COMMAND_NAMES: readonly string[] = [
  ...Object.values(SLASH).filter((name) => name !== SLASH.setup),
  ...MUSIC_COMMANDS,
  ...ECONOMY_COMMANDS,
  ...GATHERING_COMMANDS,
  ...CRAFTING_COMMANDS,
  ...GAME_COMMANDS,
  ...PROFILE_COMMANDS,
];

// ── Components (buttons / selects / modals) ─────────────────────────────────

/**
 * Button customId prefixes matched via `interaction.customId.startsWith(...)`.
 * `musicQueuePage` is a nested sub-check evaluated BEFORE `music` inside the
 * `music:` branch and must keep that ordering. `econ` routes to the economy
 * quick-action button handler (see ECON_BUTTON for its secondary switch keys).
 */
export const BUTTON_PREFIX = {
  setup: 'setup:',
  giveawayEnter: 'giveaway_enter:',
  buttonRole: 'btnrole:',
  storeBuy: 'store:buy:',
  music: 'music:',
  musicQueuePage: 'music:queue_page:',
  adventure: 'adventure:',
  trivia: 'trivia:',
  poll: 'poll:',
  econ: 'econ_',
} as const;

/** String-select-menu customId literals matched via `interaction.customId === ...`. */
export const SELECT_LITERAL = {
  setupReconfigure: 'setup:reconfigure',
  helpCategory: 'help:category',
} as const;

/** Modal-submit customId prefixes matched via `interaction.customId.startsWith(...)`. */
export const MODAL_PREFIX = {
  setup: 'setup:modal:',
} as const;

/**
 * Economy quick-action button customIds — the secondary `switch` keys inside
 * handleEconomyButton. The `econ_` prefix (BUTTON_PREFIX.econ) routes to that
 * handler; these are the exact-match cases it dispatches on.
 */
export const ECON_BUTTON = {
  daily: 'econ_daily',
  balance: 'econ_balance',
  inventory: 'econ_inventory',
  shop: 'econ_shop',
  timers: 'econ_timers',
} as const;

// ── Context menus ───────────────────────────────────────────────────────────

/** User context-menu command names (`interaction.isUserContextMenuCommand()`). */
export const USER_CONTEXT_MENU = {
  viewProfile: 'View Profile',
  warnUser: 'Warn User',
  viewPurchases: 'View Purchases',
} as const;

/** Message context-menu command names (`interaction.isMessageContextMenuCommand()`). */
export const MESSAGE_CONTEXT_MENU = {
  createTicket: 'Create Ticket',
  reportMessage: 'Report Message',
} as const;

// ── Notes ───────────────────────────────────────────────────────────────────
//
// Fall-through: unmatched buttons are NOT a routed control — the dispatcher emits
// the `button.clicked` automation event for them. That event name is intentionally
// omitted from this manifest because it is a side-effect, not a routing key.
//
// COVERAGE BOUNDARY (a bidirectional validator built on this manifest must not
// over-claim completeness): three routed lanes match their controls INTERNALLY
// with no dispatcher-level static key, so they cannot be enumerated from here:
//   1. handleTicketInteraction — invoked for all buttons/selects; matches ticket
//      customIds inside the handler (no top-level prefix in the dispatcher).
//   2. handleModalSubmit — the fall-through for all non-`setup:modal:` modals;
//      matches modal customIds inside the handler.
//   3. isCustomCommand / handleCustomCommand — dynamic, per-guild custom commands
//      with no static literal.
// The validator's "every control has a handler / every handler is reachable"
// claim covers the manifested lanes only; ticket/modal-sub/custom controls are
// out of scope of this static registry by construction.
