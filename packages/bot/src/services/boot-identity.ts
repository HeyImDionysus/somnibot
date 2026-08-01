import { randomUUID } from 'node:crypto';

/**
 * One id per PROCESS boot. Runtime-feature rows and the heartbeat both carry
 * it, so the dashboard can reject feature rows stranded by an earlier boot —
 * a current heartbeat must never vouch for managers THIS process did not
 * construct.
 */
export const BOOT_ID = randomUUID();
