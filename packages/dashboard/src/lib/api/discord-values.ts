import { z } from 'zod';

export const discordSnowflakeSchema = z.string().regex(
  /^\d{17,20}$/,
  'Must be a 17-20 digit Discord ID',
);

const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_]{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function isDiscordEmoji(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= 64
    && (
      CUSTOM_EMOJI.test(normalized)
      || (
        UNICODE_EMOJI.test(normalized)
        && [...graphemeSegmenter.segment(normalized)].length === 1
      )
    );
}

export const discordEmojiSchema = z.string()
  .min(1)
  .max(64)
  .trim()
  .refine(isDiscordEmoji, 'Must be one Unicode emoji or a Discord custom emoji');

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

export const optionalHttpUrlSchema = z.string()
  .max(512)
  .trim()
  .refine(isHttpUrl, 'Must be a valid HTTP or HTTPS URL')
  .nullable()
  .optional();
