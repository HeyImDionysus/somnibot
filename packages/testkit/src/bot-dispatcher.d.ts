/**
 * Ambient typing for the ONE production entry point testkit drives: the real
 * exported `handleInteraction` dispatcher, imported from @somnibot/bot's compiled
 * output.
 *
 * @somnibot/bot is built with `declaration: false` (see packages/bot/tsconfig.json),
 * so its `dist/` ships no `.d.ts` files. testkit deliberately depends on the
 * COMPILED dispatcher (a deep import into `dist/`, which is allowed because
 * @somnibot/bot declares no `exports` map) rather than on bot source, so this
 * ambient declaration supplies the single signature we rely on. It documents the
 * exact contract: `(interaction: Interaction, client) => Promise<void>`.
 *
 * This is the testkit->bot edge the isolation check explicitly permits; the check
 * only forbids the reverse (bot->testkit).
 */
declare module '@somnibot/bot/dist/events/interaction-handler.js' {
  import type { Interaction } from 'discord.js';
  /** The real production interaction dispatcher (interaction-handler.ts). */
  export function handleInteraction(interaction: Interaction, client: unknown): Promise<void>;
}
