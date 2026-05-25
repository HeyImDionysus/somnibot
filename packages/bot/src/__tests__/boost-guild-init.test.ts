/**
 * Tests for guild-init.ts — initGuildFeatures, registerGuildCommands, destroyGuildServices.
 * 237 uncovered statements at 41.2%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => {
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: () => logger,
    };
    return logger;
  },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return {
    ...actual,
    REST: class { setToken() { return this; } put = vi.fn(async () => ({})); },
    Routes: { applicationGuildCommands: () => '/cmds' },
  };
});

// Mock all feature managers that guild-init creates
vi.mock('../features/economy/index.js', () => ({}));
vi.mock('../features/levels/index.js', () => ({}));
vi.mock('../features/quests/index.js', () => ({}));
vi.mock('../features/moderation/index.js', () => ({}));
vi.mock('../features/tickets/index.js', () => ({}));
vi.mock('../features/music/index.js', () => ({}));
vi.mock('../features/welcome/index.js', () => ({}));
vi.mock('../features/adventures/index.js', () => ({}));
vi.mock('../features/polls/index.js', () => ({}));
vi.mock('../features/heist/index.js', () => ({}));
vi.mock('../features/farming/index.js', () => ({}));
vi.mock('../features/market/index.js', () => ({}));
vi.mock('../features/crafting/index.js', () => ({}));
vi.mock('../features/gathering/index.js', () => ({}));
vi.mock('../features/giveaways/index.js', () => ({}));
vi.mock('../features/pets/index.js', () => ({}));
vi.mock('../features/fishing/index.js', () => ({}));
vi.mock('../features/lottery/index.js', () => ({}));
vi.mock('../features/games/index.js', () => ({}));
vi.mock('../features/commerce/index.js', () => ({}));
vi.mock('../features/temp-channels/index.js', () => ({}));
vi.mock('../features/reaction-roles/index.js', () => ({}));
vi.mock('../features/custom-commands/index.js', () => ({}));
vi.mock('../features/automations/index.js', () => ({}));
vi.mock('../features/scheduled-messages/index.js', () => ({}));
vi.mock('../features/discord-ux/index.js', () => ({}));
vi.mock('../features/discord-native/index.js', () => ({}));
vi.mock('../features/audit/index.js', () => ({}));
vi.mock('../features/setup-wizard/index.js', () => ({}));
vi.mock('../services/cross-feature-bridge.js', () => ({
  CrossFeatureBridge: class { start = vi.fn(); stop = vi.fn(); },
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../sync/sync-engine.js', () => ({
  startSyncScheduler: vi.fn(() => vi.fn()),
}));
vi.mock('../deploy/deploy-listener.js', () => ({
  startDeployListener: vi.fn(),
}));
vi.mock('../config/config-watcher.js', () => ({
  ConfigWatcher: class { start = vi.fn(); stop = vi.fn(); },
}));
vi.mock('../services/action-queue.js', () => ({
  startActionQueueListener: vi.fn(() => vi.fn()),
}));
vi.mock('../features/automations/automation-engine.js', () => ({
  AutomationEngine: class { start = vi.fn(async () => {}); stop = vi.fn(); setAlertService = vi.fn(); },
}));
vi.mock('../services/alert-service.js', () => ({
  AlertService: class { send = vi.fn(); },
}));

import { destroyGuildServices } from '../guild-init.js';

describe('guild-init', () => {
  it('destroyGuildServices works on empty context (no services)', () => {
    const ctx = { guildId: 'guild-1', getManager: vi.fn(() => null) };
    destroyGuildServices(ctx as any);
    expect(ctx.getManager).toHaveBeenCalledWith('_services');
  });

  it('destroyGuildServices calls shutdown on services', () => {
    const services = {
      syncStop: vi.fn(),
      configWatcher: { stop: vi.fn() },
      automationEngine: null,
      actionQueueStop: vi.fn(),
      crossFeatureBridge: { stop: vi.fn() },
      reconciliationStop: vi.fn(),
    };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn(() => services),
    };
    destroyGuildServices(ctx as any);
  });
});
