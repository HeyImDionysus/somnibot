import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

const snowflake = '123456789012345678';

describe('onboarding configuration validation', () => {
  it('retains the native prompt payload and typed interest-role mapping', () => {
    const result = schemas.onboarding.config.safeParse({
      onboarding_enabled: true,
      interest_role_mapping: { Gaming: snowflake },
      onboarding_config: {
        enabled: true,
        default_channel_ids: [snowflake],
        prompts: [
          {
            title: 'What are you interested in?',
            type: 'multiple_choice',
            required: true,
            single_select: false,
            options: [{ title: 'Gaming', role_ids: [snowflake] }],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.onboarding_config?.prompts[0].options[0]).toEqual({
      title: 'Gaming',
      role_ids: [snowflake],
    });
  });

  it('rejects malformed role mappings and empty prompts instead of silently saving them', () => {
    expect(schemas.onboarding.config.safeParse({
      interest_role_mapping: { Gaming: 'not-a-snowflake' },
    }).success).toBe(false);

    expect(schemas.onboarding.config.safeParse({
      onboarding_config: {
        enabled: true,
        default_channel_ids: [],
        prompts: [{
          title: 'Interests',
          type: 'multiple_choice',
          required: false,
          single_select: false,
          options: [],
        }],
      },
    }).success).toBe(false);
  });
});
