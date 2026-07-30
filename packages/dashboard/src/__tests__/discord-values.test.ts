import { describe, expect, it } from 'vitest';
import {
  discordEmojiSchema,
  discordSnowflakeSchema,
  optionalHttpUrlSchema,
} from '@/lib/api/discord-values';

describe('Discord configuration values', () => {
  it.each(['⭐', '👨‍👩‍👧‍👦', '🇺🇸', '<:party_blob:12345678901234567>', '<a:dance:123456789012345678>'])(
    'accepts supported emoji %s',
    (value) => expect(discordEmojiSchema.safeParse(value).success).toBe(true),
  );

  it.each(['star', ':star:', '<:x:not-a-snowflake>', '', 'stars 😀 please', '😀😀'])(
    'rejects non-emoji value %s',
    (value) => expect(discordEmojiSchema.safeParse(value).success).toBe(false),
  );

  it('accepts only canonical Discord snowflakes', () => {
    expect(discordSnowflakeSchema.safeParse('12345678901234567').success).toBe(true);
    expect(discordSnowflakeSchema.safeParse('channel-one').success).toBe(false);
  });

  it('accepts HTTP card URLs and rejects credentials or non-web schemes', () => {
    expect(optionalHttpUrlSchema.safeParse('https://cdn.example/card.png').success).toBe(true);
    expect(optionalHttpUrlSchema.safeParse('data:image/png;base64,abc').success).toBe(false);
    expect(optionalHttpUrlSchema.safeParse('https://user:pass@example.com/card.png').success).toBe(false);
  });
});
