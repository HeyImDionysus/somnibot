/**
 * SomniBot default palette.
 * Used for bot Components v2 messages in Discord.
 * The dashboard uses Discord-native dark theme — NOT this palette.
 */
export const SOMNI_PALETTE = {
  /** Primary accent — key actions, purchase confirmations, rank cards */
  HOT_PINK: 0xFF1493,
  /** Info — music player, secondary highlights */
  CYAN: 0x00D4FF,
  /** Warnings — important notices, store highlights */
  ORANGE: 0xFF6B00,
  /** Container backgrounds — subtle off-black, premium feel */
  NEAR_BLACK: 0x0D0D0D,
} as const;

/** Semantic palette mapping for consistent usage across features. */
export const PALETTE_USAGE = {
  PRIMARY_ACCENT: SOMNI_PALETTE.HOT_PINK,
  SECONDARY_ACCENT: SOMNI_PALETTE.CYAN,
  WARNING_ACCENT: SOMNI_PALETTE.ORANGE,
  CONTAINER_BG: SOMNI_PALETTE.NEAR_BLACK,
} as const;

/** Convert a numeric color to hex string (e.g. for CSS). */
export function colorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * Discord dashboard theme colors.
 * Used by the Next.js dashboard to match Discord's dark mode.
 */
export const DISCORD_THEME = {
  BG_PRIMARY: '#313338',
  BG_SECONDARY: '#2b2d31',
  BG_TERTIARY: '#1e1f22',
  BG_FLOATING: '#111214',
  TEXT_PRIMARY: '#f2f3f5',
  TEXT_SECONDARY: '#b5bac1',
  TEXT_MUTED: '#949ba4',
  ACCENT_PRIMARY: '#5865f2',
  ACCENT_SUCCESS: '#23a559',
  ACCENT_DANGER: '#f23f43',
  ACCENT_WARNING: '#f0b232',
  BORDER_SUBTLE: '#3f4147',
  BORDER_STRONG: '#4e5058',
} as const;
