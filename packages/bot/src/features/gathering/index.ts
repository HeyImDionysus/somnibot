/**
 * Gathering feature barrel export.
 */
import type { GatheringManager } from './gathering-manager.js';

export { GatheringManager } from './gathering-manager.js';
export type { GatheringConfig } from './gathering-manager.js';
export { buildGatheringCommands, handleGatheringCommand } from './commands.js';

// ── Module-level manager registry for cache invalidation ──

let _managerInstance: GatheringManager | null = null;

export function registerGatheringManager(mgr: GatheringManager): void {
  _managerInstance = mgr;
}

export function invalidateGatheringCache(): void {
  _managerInstance?.invalidateConfig();
}
