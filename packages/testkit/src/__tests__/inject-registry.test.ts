/**
 * Registry-through-inject proof.
 *
 * This file DELIBERATELY does not import '@somnibot/bot/dist/events/handler.js'.
 * The only code path that can populate the slash command-registry here is
 * inject.ts's own side-effect `import '@somnibot/bot/dist/events/handler.js'`,
 * reached transitively through the PUBLIC createInteractionInjector()/inject()
 * API (index.js → inject.js → handler.js).
 *
 * Vitest isolates each test file's module graph, so the registry state observed
 * here is produced solely by inject.ts's import — NOT by routing-parity.test.ts's
 * own top-level handler.js import (that runs in a separate context). If inject.ts's
 * side-effect import were removed, lookupCommand('help') would miss in THIS file,
 * `/help` would dispatch to nothing, and the captured reply below would be absent —
 * failing this test. That is what makes it a real guard against regressing the
 * injector's registry-completeness contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createInteractionInjector,
  mintCapabilityToken,
  buildSlashInteraction,
  LOOPBACK_E2E_CONFIRMATION,
} from '../index.js';

// A minimal SomniClient stub sufficient for the registry-routed /help handler.
// handleHelpCommand replies unconditionally; it only reads client._registeredCommands.
function makeMinimalClient(): any {
  return {
    guildId: '111111111111111111',
    setupVerificationMode: false,
    // No discoverable supabase URL → the injector's cross-check no-ops (env guard
    // + caller contract still apply); handleHelpCommand never touches the DB.
    supabase: { from: vi.fn() },
    eventBus: { emit: vi.fn() },
    _registeredCommands: [],
    router: { getContextSync: vi.fn(() => undefined) },
  };
}

describe('registry-routed command dispatches through the public inject() API', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Disposable-rig env so assertLoopbackAllowed() passes at construction + inject.
    process.env.NODE_ENV = 'test';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.DISCORD_GUILD_ID = '111111111111111111';
    process.env.SOMNIBOT_E2E_DISPOSABLE_GUILD_ID = '111111111111111111';
    process.env.SOMNIBOT_LOOPBACK_E2E_CONFIRMATION = LOOPBACK_E2E_CONFIRMATION;
    process.env.PAYPAL_ENV = 'sandbox';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('dispatches /help (registry-routed) — proving inject.ts populated the registry', async () => {
    const client = makeMinimalClient();
    const token = mintCapabilityToken();
    const injector = createInteractionInjector(client, { authToken: token });
    // `help` is dispatched ONLY via the command-registry (lookupCommand), which is
    // empty unless handler.js's registerCommand() side effects have run. The only
    // importer of handler.js in this file's module graph is inject.ts.
    const interaction = buildSlashInteraction({ commandName: 'help', client });

    const captured = await injector.inject(interaction, { authToken: token });

    // handleHelpCommand replies unconditionally once routed. If the registry were
    // empty (inject.ts's side-effect import removed), /help would match no branch
    // and produce no response — so this assertion is the regression guard.
    expect(captured).toBe(interaction.captured);
    expect(captured.has('reply')).toBe(true);
    expect(captured.count).toBeGreaterThan(0);
  });
});
