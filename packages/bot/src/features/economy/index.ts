/**
 * Economy feature barrel export.
 */
import type { EconomyManager } from './economy-manager.js';

export { EconomyManager } from './economy-manager.js';
export type { EconomyConfig, WalletData, TransactionResult } from './economy-manager.js';
export { buildEconomyCommands, handleEconomyCommand } from './commands.js';
export { buildTimersCommand, handleTimersCommand } from './timers-command.js';

// ── Guild-scoped manager registry for cache invalidation ──
// V10 Audit H-1: Was a single `let _manager` that got overwritten on
// multi-guild init, breaking cache invalidation for all but the last guild.

const _managers = new Map<string, EconomyManager>();

export function registerEconomyManager(mgr: EconomyManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterEconomyManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateEconomyCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.invalidateConfig();
  } else {
    for (const mgr of _managers.values()) mgr?.invalidateConfig();
  }
}
