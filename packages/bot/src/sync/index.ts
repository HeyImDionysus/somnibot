/**
 * Sync Engine — Server state synchronization and drift detection.
 *
 * Exports:
 * - Periodic sync engine (scheduler + cycle runner)
 * - Event-based drift detection (role + channel events)
 * - Snapshot utility
 * - Repair actions
 */

export { takeSnapshot } from './snapshot.js';
export { runSyncCycle, startSyncScheduler, type SyncConfig, type SyncResult } from './sync-engine.js';
export { handleRoleCreate, handleRoleUpdate, handleRoleDelete } from './role-events.js';
export { handleChannelCreate, handleChannelUpdate, handleChannelDelete } from './channel-events.js';
export { repairDriftItem, acceptDriftItem, ignoreDriftItem, clearAllDrift } from './repair-actions.js';
