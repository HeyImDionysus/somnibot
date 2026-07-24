/**
 * gateway-inject — the guarded, in-process-only ingress for synthetic GATEWAY
 * EVENTS (messageCreate, …), the counterpart to inject.ts (interactions).
 *
 * Like the interaction injector, this is the ONLY way the harness feeds a
 * gateway event into production code. There is no network / socket / gateway in
 * the loop: injection is a direct in-process call that
 *   1. re-checks the loopback safety guard (construction AND per-inject),
 *   2. requires the capability token minted for this injector, and
 *   3. calls the REAL exported per-event handler
 *      (`handleMessageCreateEvent(message, client)` etc) directly — NOT
 *      `client.emit('messageCreate', …)`.
 *
 * Driving the EXPORTED handler (not `client.emit`) is deliberate: `emit` does not
 * await the async handler, so the DB effect would race the assertion, and it also
 * re-runs `registerProcessSafetyNets()` via `registerEvents`. The exported
 * `handle<Event>Event` functions (extracted to mirror the exported
 * `handleInteraction`) are awaitable and side-effect-free to register, so the
 * proof can await the full pipeline and then read the real DB effect.
 */

import { handleMessageCreateEvent } from '@somnibot/bot/dist/events/handler.js';
import type { Message } from 'discord.js';
import { assertLoopbackAllowed, assertSupabaseUrlIsLocal } from './guard.js';
import { tokensMatch, type CapabilityToken } from './capability.js';
import type { SyntheticMessage } from './gateway-builders.js';

export class GatewayInjectorAuthError extends Error {
  constructor(message: string) {
    super(`Loopback gateway injector: ${message}`);
    this.name = 'GatewayInjectorAuthError';
  }
}

export interface CreateGatewayInjectorOptions {
  /** The capability token authorising this injector (same token per inject). */
  authToken: CapabilityToken;
}

export interface GatewayInjectOptions {
  authToken: CapabilityToken;
}

export interface GatewayInjector {
  /**
   * Drive a synthetic `messageCreate` through the REAL exported
   * `handleMessageCreateEvent` and resolve once the full pipeline (auto-mod,
   * automation, XP accrual, achievements, economy, quests) has settled. Every DB
   * effect is real; `message.sent` captures any announcement `channel.send`.
   *
   * @throws LoopbackGuardError if the environment is not a disposable local rig.
   * @throws GatewayInjectorAuthError if the presented token does not match.
   */
  injectMessageCreate(message: SyntheticMessage, options: GatewayInjectOptions): Promise<void>;
}

/** Mirror inject.ts's defense-in-depth: the client's REAL Supabase target must be
 *  local, not just process.env. */
function crossCheckClientTarget(client: unknown): void {
  const c = client as { supabase?: Record<string, unknown> };
  const supabase = c?.supabase;
  if (!supabase || typeof supabase !== 'object') return;
  const candidates = [
    (supabase as { supabaseUrl?: unknown }).supabaseUrl,
    (supabase as { rest?: { url?: unknown } }).rest?.url,
    (supabase as { realtimeUrl?: unknown }).realtimeUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      assertSupabaseUrlIsLocal(candidate, 'client.supabase target');
      return;
    }
  }
}

/**
 * Construct a loopback gateway injector bound to `client`. The guard is asserted
 * immediately so a mis-configured environment fails at construction, not use.
 */
export function createGatewayInjector(
  client: unknown,
  options: CreateGatewayInjectorOptions,
): GatewayInjector {
  assertLoopbackAllowed();
  crossCheckClientTarget(client);

  const expectedToken = options.authToken;

  const authorize = (injectOptions: GatewayInjectOptions): void => {
    assertLoopbackAllowed();
    if (!tokensMatch(expectedToken, injectOptions.authToken)) {
      throw new GatewayInjectorAuthError('capability token mismatch');
    }
  };

  return {
    async injectMessageCreate(message: SyntheticMessage, injectOptions: GatewayInjectOptions): Promise<void> {
      authorize(injectOptions);
      // Cast at the boundary: the exported handler accepts discord.js's Message,
      // and the synthetic object is structurally compatible with the parts it uses.
      await handleMessageCreateEvent(message as unknown as Message, client as never);
    },
  };
}
