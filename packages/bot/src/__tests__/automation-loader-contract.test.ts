import { describe, expect, it, vi } from 'vitest';
import { AutomationLoader } from '../features/automations/automation-loader.js';

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    guild_id: 'guild-1',
    name: 'Valid automation',
    description: null,
    trigger_type: 'member.joined',
    trigger_config: {},
    target_user_ids: [],
    target_channel_ids: [],
    exclude_user_ids: [],
    exclude_channel_ids: [],
    conditions: [{ type: 'is_new_member', config: {} }],
    actions: [{ type: 'send_dm', config: { message: 'Welcome' } }],
    enabled: true,
    execution_count: 0,
    last_executed_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    rate_limit_per_user: null,
    rate_limit_window_seconds: null,
    ...overrides,
  };
}

function supabaseWith(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
  return {
    from: vi.fn(() => query),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
  };
}

describe('AutomationLoader persisted-contract boundary', () => {
  it('loads canonical automations and rejects malformed rows fail-closed', async () => {
    const supabase = supabaseWith([
      automation(),
      automation({
        id: '22222222-2222-4222-8222-222222222222',
        trigger_type: 'entitlement.granted',
      }),
      automation({
        id: '33333333-3333-4333-8333-333333333333',
        actions: [{ type: 'run_arbitrary_code', config: {} }],
      }),
      automation({
        id: '44444444-4444-4444-8444-444444444444',
        conditions: [{ type: 'always_true', config: {} }],
      }),
    ]);
    const loader = new AutomationLoader(supabase as never, 'guild-1');

    await loader.load();

    expect(loader.getAll()).toHaveLength(1);
    expect(loader.getForTrigger('member.joined')).toHaveLength(1);
    expect(loader.getForTrigger('entitlement.granted')).toEqual([]);
  });
});
