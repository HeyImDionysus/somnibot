/**
 * Interaction handler ↔ setup-verification gate (codex round-3 finding #1).
 *
 * While `client.setupVerificationMode === true` the bot is logged in ONLY so
 * the wizard can confirm it is online; the GuildRouter is an empty placeholder
 * and guild_config rows do not exist yet. Discord may still route previously
 * registered slash commands / component interactions (e.g. /warn, store/music
 * buttons). Those must be short-circuited — running them against the empty
 * router and missing guild_config reproduces the pre-setup DB writes/errors the
 * gate exists to suppress. Only the setup wizard's own interactions may route.
 *
 * These tests observe routing by mocking the setup-wizard handlers (allowed
 * path) and the command-registry lookup (the /warn path), then asserting which
 * fire under the gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Setup-wizard entry points — the ONLY interactions allowed through the gate.
const handleSetupButton = vi.fn((..._a: unknown[]) => Promise.resolve());
const handleSetupModal = vi.fn((..._a: unknown[]) => Promise.resolve());
const handleReconfigureSelect = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock('../features/setup-wizard/index.js', () => ({
  handleSetupButton: (...a: unknown[]) => handleSetupButton(...a),
  handleSetupModal: (...a: unknown[]) => handleSetupModal(...a),
  handleReconfigureSelect: (...a: unknown[]) => handleReconfigureSelect(...a),
}));

// Command registry — a registered non-setup command handler (e.g. /warn).
// If the gate leaks, handleSlashCommand looks the command up here and runs it.
const registeredHandler = vi.fn((..._a: unknown[]) => Promise.resolve());
const lookupCommand = vi.fn((..._a: unknown[]) => registeredHandler);
vi.mock('../events/command-registry.js', () => ({
  lookupCommand: (...a: unknown[]) => lookupCommand(...a),
  registerCommand: vi.fn(),
}));

// Ticket interactions — a non-setup button path. Must NOT run while gated.
const handleTicketInteraction = vi.fn((..._a: unknown[]) => Promise.resolve(false));
vi.mock('../features/tickets/index.js', () => ({
  handleTicketInteraction: (...a: unknown[]) => handleTicketInteraction(...a),
}));

import { handleInteraction } from '../events/interaction-handler.js';

function baseInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild: { id: 'g1' },
    guildId: 'g1',
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue({}),
    user: { id: 'u1', username: 'user' },
    ...overrides,
  } as any;
}

const client = { setupVerificationMode: false, supabase: {}, eventBus: { emit: vi.fn() } } as any;

describe('interaction handler setup-verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.setupVerificationMode = false;
  });

  it('lets the /setup slash command through while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isChatInputCommand: () => true,
      commandName: 'setup',
    });
    // /setup is registered in the command registry (handleSetupCommand).
    await handleInteraction(interaction, client);
    expect(lookupCommand).toHaveBeenCalledWith('setup');
    expect(registeredHandler).toHaveBeenCalledTimes(1);
  });

  it('lets setup: buttons through while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isButton: () => true,
      customId: 'setup:start',
    });
    await handleInteraction(interaction, client);
    expect(handleSetupButton).toHaveBeenCalledTimes(1);
  });

  it('lets the setup:reconfigure select menu through while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isStringSelectMenu: () => true,
      customId: 'setup:reconfigure',
    });
    await handleInteraction(interaction, client);
    expect(handleReconfigureSelect).toHaveBeenCalledTimes(1);
  });

  it('lets setup:modal: submissions through while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isModalSubmit: () => true,
      customId: 'setup:modal:discord',
    });
    await handleInteraction(interaction, client);
    expect(handleSetupModal).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a non-setup slash command (/warn) while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isChatInputCommand: () => true,
      commandName: 'warn',
    });
    await handleInteraction(interaction, client);
    // Gate short-circuits before the command registry is ever consulted.
    expect(lookupCommand).not.toHaveBeenCalled();
    expect(registeredHandler).not.toHaveBeenCalled();
  });

  it('BLOCKS a non-setup button (ticket) while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isButton: () => true,
      customId: 'ticket:open:panel-1',
    });
    await handleInteraction(interaction, client);
    expect(handleTicketInteraction).not.toHaveBeenCalled();
  });

  it('BLOCKS a non-setup modal (warn) while in verification mode', async () => {
    client.setupVerificationMode = true;
    const interaction = baseInteraction({
      isModalSubmit: () => true,
      customId: 'warn:user-1',
    });
    await handleInteraction(interaction, client);
    // No setup modal handler ran, and the generic modal path was not reached.
    expect(handleSetupModal).not.toHaveBeenCalled();
  });

  it('RUNS a non-setup slash command (/warn) once verification mode is cleared', async () => {
    client.setupVerificationMode = false;
    const interaction = baseInteraction({
      isChatInputCommand: () => true,
      commandName: 'warn',
    });
    await handleInteraction(interaction, client);
    expect(lookupCommand).toHaveBeenCalledWith('warn');
    expect(registeredHandler).toHaveBeenCalledTimes(1);
  });

  it('RUNS a non-setup button (ticket) once verification mode is cleared', async () => {
    client.setupVerificationMode = false;
    const interaction = baseInteraction({
      isButton: () => true,
      customId: 'ticket:open:panel-1',
    });
    await handleInteraction(interaction, client);
    expect(handleTicketInteraction).toHaveBeenCalledTimes(1);
  });
});
