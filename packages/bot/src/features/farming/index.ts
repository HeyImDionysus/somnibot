/**
 * Farming feature barrel export.
 */
import type { FarmingManager } from './farming-manager.js';

export { FarmingManager } from './farming-manager.js';
export type { FarmingConfig } from './farming-manager.js';
export { buildFarmingCommands, handleFarmingCommand } from './commands.js';

let _managerInstance: FarmingManager | null = null;

export function registerFarmingManager(mgr: FarmingManager): void {
  _managerInstance = mgr;
}

export function invalidateFarmingCache(): void {
  _managerInstance?.invalidateConfig();
}
