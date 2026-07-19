import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, TRIGGER_TYPES } from '@somnibot/shared';
import { schemas } from '@/lib/api/validation';

const SNOWFLAKE = '12345678901234567';

function validCreate() {
  return {
    name: 'Welcome automation',
    trigger_type: 'member.joined',
    trigger_config: {},
    conditions: [{ type: 'is_new_member', config: {} }],
    actions: [{ type: 'send_dm', config: { message: 'Welcome' } }],
    target_user_ids: [SNOWFLAKE],
    target_channel_ids: [],
    exclude_user_ids: [],
    exclude_channel_ids: [],
  };
}

describe('automation API contracts', () => {
  it('accepts every canonical trigger and action', () => {
    for (const trigger_type of TRIGGER_TYPES) {
      expect(schemas.automation.create.safeParse({
        ...validCreate(),
        trigger_type,
      }).success).toBe(true);
    }
    for (const type of ACTION_TYPES) {
      expect(schemas.automation.create.safeParse({
        ...validCreate(),
        actions: [{ type, config: {} }],
      }).success).toBe(true);
    }
  });

  it.each([
    { field: 'trigger_type', value: 'member.anything' },
    { field: 'actions', value: [{ type: 'run_arbitrary_code', config: {} }] },
    { field: 'conditions', value: [{ type: 'always_true', config: {} }] },
  ])('rejects a noncanonical $field', ({ field, value }) => {
    expect(schemas.automation.create.safeParse({
      ...validCreate(),
      [field]: value,
    }).success).toBe(false);
  });

  it('enforces the same action allowlist in template overrides', () => {
    expect(schemas.automation.deployTemplate.safeParse({
      template_id: 'welcome_dm',
      overrides: {
        actions: [{ type: 'run_arbitrary_code', config: {} }],
      },
    }).success).toBe(false);
  });

  it('rejects duplicate scope ids', () => {
    expect(schemas.automation.create.safeParse({
      ...validCreate(),
      target_user_ids: [SNOWFLAKE, SNOWFLAKE],
    }).success).toBe(false);
  });
});
