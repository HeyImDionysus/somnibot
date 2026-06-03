/**
 * Farming feature barrel export.
 */
import type { FarmingManager } from './farming-manager.js';

export { FarmingManager } from './farming-manager.js';
export type { FarmingConfig } from './farming-manager.js';
export { buildFarmingCommands, handleFarmingCommand } from './commands.js';

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, FarmingManager>();

export function registerFarmingManager(mgr: FarmingManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterFarmingManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateFarmingCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateConfig();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateConfig();
  }
}
