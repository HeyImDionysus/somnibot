/**
 * Crafting feature barrel export.
 */
import type { CraftingManager } from './crafting-manager.js';

export { CraftingManager } from './crafting-manager.js';
export type { CraftingConfig } from './crafting-manager.js';
export { buildCraftingCommands, handleCraftingCommand } from './commands.js';

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, CraftingManager>();

export function registerCraftingManager(mgr: CraftingManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterCraftingManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateCraftingCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateConfig();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateConfig();
  }
}
