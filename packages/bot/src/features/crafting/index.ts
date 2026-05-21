/**
 * Crafting feature barrel export.
 */
import type { CraftingManager } from './crafting-manager.js';

export { CraftingManager } from './crafting-manager.js';
export type { CraftingConfig } from './crafting-manager.js';
export { buildCraftingCommands, handleCraftingCommand } from './commands.js';

let _managerInstance: CraftingManager | null = null;

export function registerCraftingManager(mgr: CraftingManager): void {
  _managerInstance = mgr;
}

export function invalidateCraftingCache(): void {
  _managerInstance?.invalidateConfig();
}
