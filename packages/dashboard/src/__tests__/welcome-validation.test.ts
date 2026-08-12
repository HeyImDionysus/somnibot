import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

const snowflake = '123456789012345678';

describe('welcome configuration validation', () => {
  it('accepts null message fields returned by an unchanged guild configuration', () => {
    expect(schemas.welcome.config.safeParse({
      welcome_channel_id: snowflake,
      welcome_message: null,
      welcome_dm_message: null,
      goodbye_channel_id: snowflake,
      goodbye_message: null,
    }).success).toBe(true);
  });
});
