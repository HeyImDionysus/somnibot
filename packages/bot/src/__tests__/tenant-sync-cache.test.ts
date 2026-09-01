import { describe, expect, it } from 'vitest';
import {
  parseSyncConfigCache,
  serializeSyncConfigCache,
} from '../sync/tenant-sync-cache.js';

describe('tenant-scoped sync config cache', () => {
  it('round-trips a same-guild cache entry', () => {
    const raw = serializeSyncConfigCache('guild-a', {
      autoRepair: true,
      autoRepairEveryone: false,
    });

    expect(parseSyncConfigCache(raw, 'guild-a')).toEqual({
      autoRepair: true,
      autoRepairEveryone: false,
    });
  });

  it('rejects a valid cache entry read through another guild', () => {
    const raw = serializeSyncConfigCache('guild-b', {
      autoRepair: true,
      autoRepairEveryone: true,
    });

    expect(parseSyncConfigCache(raw, 'guild-a')).toBeNull();
  });

  it('rejects malformed cached configuration', () => {
    const raw = serializeSyncConfigCache('guild-a', { autoRepair: 'yes' });

    expect(parseSyncConfigCache(raw, 'guild-a')).toBeNull();
  });
});
