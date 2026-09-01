import { createClient } from '@supabase/supabase-js';
import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

const ownerAlerts = vi.hoisted(() => ({
  raise: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: ownerAlerts.raise,
  resolveOwnerAlert: ownerAlerts.resolve,
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { AlertManager, type HealthSnapshot } from '../features/audit/alert-manager.js';
import type { OwnerAlertDelivery } from '../services/alert-service.js';

function snapshot(valkeyConnected: boolean): HealthSnapshot {
  return {
    guild_id: 'guild-1',
    memory_rss_mb: 100,
    discord_ws_ping: 20,
    valkey_connected: valkeyConnected,
    lavalink_nodes: [],
  };
}

describe('diagnostic owner alert lifecycle', () => {
  it('delivers one open notice and one recovery notice through the owner-alert service', async () => {
    ownerAlerts.raise.mockResolvedValue({ inserted: true, delivered: true });
    ownerAlerts.resolve.mockResolvedValue(1);
    let idReadCount = 0;
    const supabase = createClient('https://alerts.test', 'anon-key', {
      global: {
        fetch: async (input) => {
          const url = input instanceof Request ? input.url : input.toString();
          if (url.includes('/guild_config?')) {
            return Response.json({
              memory_alert_threshold_mb: 512,
              ws_ping_alert_threshold_ms: 500,
              webhook_error_rate_threshold: 0.25,
              incidents_auto_create_from_critical_alerts: false,
            });
          }
          if (url.includes('select=alert_type')) return Response.json([]);
          idReadCount += 1;
          return Response.json(idReadCount === 1 ? null : { id: 'alert-1' });
        },
      },
    });
    const delivery: OwnerAlertDelivery = { client: new Client({ intents: [] }) };
    const manager = new AlertManager(supabase, undefined, undefined, delivery);

    await manager.evaluate(snapshot(false));
    await manager.evaluate(snapshot(true));

    expect(ownerAlerts.raise).toHaveBeenCalledOnce();
    expect(ownerAlerts.raise).toHaveBeenCalledWith(
      supabase,
      'guild-1',
      expect.objectContaining({ alertType: 'valkey_disconnected', client: delivery.client }),
    );
    expect(ownerAlerts.resolve).toHaveBeenCalledOnce();
    expect(ownerAlerts.resolve).toHaveBeenCalledWith(
      supabase,
      'guild-1',
      'valkey_disconnected',
      undefined,
      expect.objectContaining({ client: delivery.client }),
    );
  });
});
