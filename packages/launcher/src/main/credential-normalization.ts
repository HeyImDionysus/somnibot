/**
 * Normalize values that commonly acquire invisible formatting characters when
 * copied through a browser, chat client, or cloud-backed settings row.
 *
 * Discord tokens are otherwise intentionally treated as opaque ASCII values:
 * visible punctuation is never removed or rewritten here. Only whitespace
 * and Unicode format characters at the boundaries are discarded.
 */
export function normalizeDiscordToken(token: string): string {
  return token.replace(/^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu, '');
}
