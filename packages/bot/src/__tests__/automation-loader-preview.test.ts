import { describe, expect, it } from 'vitest';
import { AutomationLoader, automationPreviewHash } from '../features/automations/automation-loader.js';

const definition = {
  id: 'auto-1',
  guild_id: 'guild-1',
  name: 'Welcome',
  description: null,
  trigger_type: 'member.joined',
  trigger_config: {},
  conditions: [],
  actions: [{ type: 'send_message', config: { channel_id: '12345678901234567', message: 'hello' }}],
  target_user_ids: [],
  target_channel_ids: [],
  exclude_user_ids: [],
  exclude_channel_ids: [],
  enabled: true,
  execution_count: 0,
  last_executed_at: null,
  created_at: '',
  updated_at: '',
  rate_limit_per_user: null,
  rate_limit_window_seconds: null,
};

function makeSupabase(previewRequired: boolean, row: Record<string, unknown>) {
  return {
    from(table: string) {
      if (table === 'guild_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { automation_preview_required: previewRequired }, error: null }) }) }) };
      }
      return { select: () => ({ eq: () => ({ limit: async () => ({ data: [row], error: null }) }) }) };
    },
  } as never;
}

describe('AutomationLoader preview gate', () => {
  it('does not expose enabled definitions whose preview hash is missing or stale', async () => {
    const loader = new AutomationLoader(makeSupabase(true, definition), 'guild-1');
    await loader.load();
    expect(loader.getForTrigger('member.joined')).toEqual([]);
  });

  it('exposes an enabled definition only when its exact preview hash matches', async () => {
    const preview_hash = automationPreviewHash(definition);
    const loader = new AutomationLoader(makeSupabase(true, { ...definition, preview_hash }), 'guild-1');
    await loader.load();
    expect(loader.getForTrigger('member.joined')).toHaveLength(1);
  });
});
