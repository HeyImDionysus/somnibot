/**
 * Gathering feature barrel export.
 */
import type { GatheringManager } from './gathering-manager.js';

export { GatheringManager } from './gathering-manager.js';
export type { GatheringConfig } from './gathering-manager.js';
export { buildGatheringCommands, handleGatheringCommand } from './commands.js';

// ── Module-level manager registry for cache invalidation ──

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, GatheringManager>();

export function registerGatheringManager(mgr: GatheringManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

export function invalidateGatheringCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateConfig();
  } else {
    for (const mgr of _managers.values()) mgr.invalidateConfig();
  }
}
