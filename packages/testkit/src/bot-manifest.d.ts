/**
 * Ambient typing for the compiled dispatch manifest the bidirectional validator
 * reads (packages/bot/src/events/dispatch-manifest.ts → dist/.../dispatch-manifest.js).
 *
 * Companion to bot-dispatcher.d.ts / bot-live-stack.d.ts. @somnibot/bot is built
 * with `declaration: false`, so its `dist/` ships no `.d.ts`; testkit depends on
 * the COMPILED manifest (a deep `dist/` import, allowed because @somnibot/bot
 * declares no `exports` map), so this supplies exactly the surface the PR5
 * validator consumes — the HANDLED slash sets (Check 1) and the routed component
 * prefixes/literals (Check 2).
 *
 * The manifest module is PURE data (typed `as const` objects); modeling the
 * routing objects as `Readonly<Record<string, string>>` is enough for the
 * validator to enumerate their VALUES (the customId prefixes/literals) without
 * pinning their exact key unions here.
 *
 * This is the permitted testkit->bot edge (the isolation check forbids only the
 * reverse, bot->testkit).
 */
declare module '@somnibot/bot/dist/events/dispatch-manifest.js' {
  /** Slash names handled by the inline feature-gated dispatch (Check 1 HANDLED). */
  export const INLINE_SLASH_COMMAND_NAMES: readonly string[];
  /** Slash names handled by the data-driven command-registry lane (Check 1 HANDLED). */
  export const REGISTRY_COMMAND_NAMES: readonly string[];
  /** Button customId prefixes matched via `startsWith` (Check 2). */
  export const BUTTON_PREFIX: Readonly<Record<string, string>>;
  /** String-select-menu customId literals matched via `===` (Check 2). */
  export const SELECT_LITERAL: Readonly<Record<string, string>>;
  /** Modal-submit customId prefixes matched via `startsWith` (Check 2). */
  export const MODAL_PREFIX: Readonly<Record<string, string>>;
  /** Economy quick-action button customIds (secondary switch keys) (Check 2). */
  export const ECON_BUTTON: Readonly<Record<string, string>>;
  /** User context-menu command names (documented, not part of the slash checks). */
  export const USER_CONTEXT_MENU: Readonly<Record<string, string>>;
  /** Message context-menu command names (documented, not part of the slash checks). */
  export const MESSAGE_CONTEXT_MENU: Readonly<Record<string, string>>;
}
