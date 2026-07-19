/**
 * inject — the guarded, in-process-only ingress for synthetic interactions.
 *
 * This is the ONLY way the harness feeds an interaction into the production
 * dispatcher. There is deliberately no network, HTTP, socket, or event-bus
 * ingress: injection is a direct in-process function call that
 *   1. re-checks the loopback safety guard (at construction AND before every
 *      inject, so a mid-run environment change cannot slip a real-effect call
 *      through),
 *   2. requires the capability token minted for this injector (un-forgeable by
 *      unrelated in-process code that did not construct it), and
 *   3. calls the REAL exported `handleInteraction(interaction, client)` directly
 *      — NOT `client.emit('interactionCreate', ...)` — so it exercises the exact
 *      production dispatch path with no gateway in the loop.
 *
 * After the handler settles, the interaction's {@link CapturedResponse} is
 * returned so the ephemeral reply bubble can be asserted in-process; every other
 * effect (roles/channels/DB) is real when run against the live stack.
 */

import { handleInteraction } from '@somnibot/bot/dist/events/interaction-handler.js';
// Side-effect import: handler.js's top-level registerCommand() calls populate
// the module-scoped slash command registry that handleSlashCommand looks up.
// Without it, registry-routed slash commands (help/setup/warn/…) silently
// no-op through inject(). Importing here guarantees the public injector API is
// complete regardless of what else the harness has loaded.
import '@somnibot/bot/dist/events/handler.js';
import type { Interaction } from 'discord.js';
import { assertLoopbackAllowed, assertSupabaseUrlIsLocal, LoopbackGuardError } from './guard.js';
import { tokensMatch, type CapabilityToken } from './capability.js';
import type { CapturedResponse } from './captured-response.js';
import type { SyntheticInteraction } from './interaction-builders.js';

export class InjectorAuthError extends Error {
  constructor(message: string) {
    super(`Loopback injector: ${message}`);
    this.name = 'InjectorAuthError';
  }
}

export interface CreateInjectorOptions {
  /**
   * The capability token authorising this injector. Mint it with
   * `mintCapabilityToken()` and present the SAME token to every `inject()` call.
   */
  authToken: CapabilityToken;
}

export interface InjectOptions {
  /** Must equal the token the injector was constructed with. */
  authToken: CapabilityToken;
}

export interface InteractionInjector {
  /**
   * Drive a synthetic interaction through the REAL production dispatcher and
   * return its recorder once the handler settles.
   *
   * @throws LoopbackGuardError if the environment is not a disposable local rig.
   * @throws InjectorAuthError if the presented token does not match.
   */
  inject(interaction: SyntheticInteraction, options: InjectOptions): Promise<CapturedResponse>;
}

/**
 * Construct a loopback interaction injector bound to `client`.
 *
 * The guard is asserted immediately so a mis-configured environment fails at
 * construction, not only at first use.
 */
/**
 * Best-effort cross-check that the injected client's REAL Supabase target is
 * local. The env guard only proves process.env.SUPABASE_URL is local; every
 * actual write flows through client.supabase, which the caller is responsible
 * for building from the same env. This defense-in-depth catches the mismatch
 * (client points at a remote project while env says localhost) whenever the
 * client exposes a discoverable URL. If none is discoverable, the documented
 * caller contract + env guard still apply.
 */
function crossCheckClientTarget(client: unknown): void {
  const c = client as { supabase?: Record<string, unknown> };
  const supabase = c?.supabase;
  if (!supabase || typeof supabase !== 'object') return;
  // Known places supabase-js and our client surface the URL, most specific first.
  const candidates = [
    (supabase as { supabaseUrl?: unknown }).supabaseUrl,
    ((supabase as { rest?: { url?: unknown } }).rest?.url),
    ((supabase as { realtimeUrl?: unknown }).realtimeUrl),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      // rest.url is `${supabaseUrl}/rest/v1`; hostname extraction handles both.
      assertSupabaseUrlIsLocal(candidate, 'client.supabase target');
      return;
    }
  }
  // No discoverable URL — cannot cross-check; env guard + caller contract hold.
}

export function createInteractionInjector(
  client: unknown,
  options: CreateInjectorOptions,
): InteractionInjector {
  // Gate 1 (construction): never build an injector outside a disposable rig.
  assertLoopbackAllowed();
  // Gate 1b: the client's actual Supabase target must also be local (the env
  // guard alone cannot see where client.supabase was pointed).
  crossCheckClientTarget(client);

  const expectedToken = options.authToken;

  return {
    async inject(interaction: SyntheticInteraction, injectOptions: InjectOptions): Promise<CapturedResponse> {
      // Gate 1 (per-inject): re-check in case the environment changed mid-run.
      assertLoopbackAllowed();

      // Gate 2: un-forgeable capability — only holders of the minted token may
      // drive the production dispatcher.
      if (!tokensMatch(expectedToken, injectOptions.authToken)) {
        throw new InjectorAuthError('capability token mismatch');
      }

      // Gate 3: the ONLY ingress — a direct in-process call to the real dispatcher.
      // Cast at the boundary: handleInteraction accepts discord.js's Interaction,
      // and the synthetic object is structurally compatible with the parts it uses.
      await handleInteraction(interaction as unknown as Interaction, client);

      return interaction.captured;
    },
  };
}
