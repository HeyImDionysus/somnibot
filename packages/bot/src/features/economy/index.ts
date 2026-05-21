/**
 * Economy feature barrel export.
 */
import type { EconomyManager } from './economy-manager.js';

export { EconomyManager } from './economy-manager.js';
export type { EconomyConfig, WalletData, TransactionResult } from './economy-manager.js';
export { buildEconomyCommands, handleEconomyCommand } from './commands.js';

// ── Module-level manager registry for cache invalidation ──

let _managerInstance: EconomyManager | null = null;

export function registerEconomyManager(mgr: EconomyManager): void {
  _managerInstance = mgr;
}

export function invalidateEconomyCache(): void {
  _managerInstance?.invalidateConfig();
}
