import {
  parseTenantCacheValue,
  serializeTenantCacheValue,
} from '@somnibot/shared';
import { z } from 'zod';

const SyncConfigCacheSchema = z.object({
  autoRepair: z.boolean(),
  autoRepairEveryone: z.boolean(),
}).strict();

export type SyncConfigCache = z.output<typeof SyncConfigCacheSchema>;

export function parseSyncConfigCache(raw: string, guildId: string): SyncConfigCache | null {
  const result = parseTenantCacheValue(raw, { guildId }, SyncConfigCacheSchema);
  return result.status === 'hit' ? result.value : null;
}

export function serializeSyncConfigCache(guildId: string, value: unknown): string {
  return serializeTenantCacheValue({ guildId }, 'sync-config', value);
}
