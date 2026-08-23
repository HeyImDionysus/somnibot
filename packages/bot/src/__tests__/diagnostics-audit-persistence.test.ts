import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AuditService } from '../features/audit/audit-service.js';
import { PlatformEventBus } from '../services/event-bus.js';

type AuditRow = Record<string, unknown>;

describe('diagnostic audit persistence', () => {
  it('flushes alert open and recovery transitions as guild-scoped audit rows', async () => {
    const rows: AuditRow[] = [];
    const supabase = createClient('https://audit.test', 'anon-key', {
      global: {
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          if (url.includes('/audit_logs') && init?.body) {
            const body: unknown = JSON.parse(String(init.body));
            if (Array.isArray(body)) rows.push(...body);
            else if (body && typeof body === 'object') rows.push(body as AuditRow);
          }
          return Response.json(url.includes('/guild_config') ? null : {});
        },
      },
    });
    const bus = new PlatformEventBus();
    const service = new AuditService('guild-1', supabase, bus);
    service.start();

    bus.emit('diagnostics.alert_raised', 'guild-1', {
      alertType: 'valkey_disconnected',
      severity: 'critical',
      title: 'Cache unavailable',
      message: 'Short-lived state may reset.',
    });
    bus.emit('diagnostics.alert_resolved', 'guild-1', { alertType: 'valkey_disconnected' });
    await service.stop();

    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({
        guild_id: 'guild-1',
        action: 'diagnostics.alert_raised',
        category: 'diagnostics',
        target_type: 'alert',
        target_id: 'valkey_disconnected',
      }),
      expect.objectContaining({
        guild_id: 'guild-1',
        action: 'diagnostics.alert_resolved',
        category: 'diagnostics',
        target_type: 'alert',
        target_id: 'valkey_disconnected',
      }),
    ]);
  });
});
