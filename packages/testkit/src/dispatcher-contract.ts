/**
 * Compile-time tie between the ambient dispatcher declaration
 * (bot-dispatcher.d.ts) and the exact shape testkit's injector relies on.
 *
 * @somnibot/bot ships no `.d.ts` (declaration: false), so testkit hand-mirrors
 * `handleInteraction`'s signature in bot-dispatcher.d.ts. That mirror can silently
 * drift from what inject.ts actually calls. These assertions turn any drift into a
 * loud compile error under `type-check` / `build` instead of a vacuous pass:
 *
 *   - forward: the declared dispatcher must SATISFY the contract inject() calls
 *     it by (a widened/incompatible param or return type breaks here);
 *   - reverse: the contract must remain assignable BACK to the declared
 *     dispatcher, so an added required parameter or a narrowed signature in
 *     bot-dispatcher.d.ts also breaks compilation.
 *
 * Together they pin the two types to mutual assignability, i.e. the same call
 * shape testkit depends on: `(interaction: Interaction, client) => Promise<void>`.
 */
import { handleInteraction } from '@somnibot/bot/dist/events/interaction-handler.js';
import type { Interaction } from 'discord.js';

/** The exact dispatcher shape testkit's inject path invokes. */
export type DispatcherContract = (interaction: Interaction, client: unknown) => Promise<void>;

// Forward tie: the real (declared) dispatcher must satisfy the call contract.
const _dispatcherSatisfiesContract = handleInteraction satisfies DispatcherContract;

// Reverse tie: the contract must stay assignable to the declared dispatcher, so a
// drift in bot-dispatcher.d.ts (extra required arg, changed return) fails to
// compile rather than passing vacuously.
const _contractMatchesDispatcher: typeof handleInteraction = null as unknown as DispatcherContract;

void _dispatcherSatisfiesContract;
void _contractMatchesDispatcher;
