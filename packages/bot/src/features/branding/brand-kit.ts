/**
 * Brand Kit — single source of truth for a guild's white-label brand.
 *
 * Every member-facing surface (store header, ticket embeds, infraction DMs)
 * should render with the OWNER's brand — name, colors, voice, and a subtle
 * powered-by attribution — instead of hardcoded SomniBot palette/branding. This
 * util resolves that kit from guild_config so the Dyno/MEE6-tier white-label
 * experience is consistent EVERYWHERE, driven by one owner configuration.
 *
 * Storage (guild_config):
 *   - store_brand_name       → brandName (shared with the storefront)
 *   - store_show_powered_by  → poweredByAttribution toggle
 *   - brand_primary_color    → primaryColor (24-bit 0xRRGGBB int, NULL = default)
 *   - brand_accent_color     → accentColor  (24-bit 0xRRGGBB int, NULL = default)
 *   - brand_voice_preset     → voicePreset
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SOMNI_PALETTE, createLogger } from '@somnibot/shared';

const log = createLogger('BrandKit');

/** Copy/voice presets an owner can pick for member-facing brand surfaces. */
export type BrandVoicePreset = 'default' | 'professional' | 'friendly' | 'playful';

/** The resolved white-label brand kit for a guild. */
export interface BrandKit {
  /** Owner-configured brand name (falls back to the guild name, then 'SomniBot'). */
  brandName: string;
  /** Primary accent color (24-bit 0xRRGGBB int) for key member-facing embeds. */
  primaryColor: number;
  /** Secondary/info accent color (24-bit 0xRRGGBB int) for informational embeds. */
  accentColor: number;
  /** Copy/voice preset for brand surfaces. */
  voicePreset: BrandVoicePreset;
  /**
   * Subtle attribution string for buyer/member-facing surfaces, or `null` when
   * the owner has turned the powered-by attribution off.
   */
  poweredByAttribution: string | null;
}

/** Allowed voice presets — keep in sync with the guild_config CHECK constraint. */
export const BRAND_VOICE_PRESETS: readonly BrandVoicePreset[] = [
  'default',
  'professional',
  'friendly',
  'playful',
];

/** The subtle vendor attribution shown when the owner leaves powered-by on. */
export const POWERED_BY_ATTRIBUTION = 'Powered by SomniBot';

/** Max valid Discord embed color (24-bit 0xFFFFFF). */
const MAX_COLOR = 0xffffff;

export interface ResolveBrandKitOptions {
  /**
   * Fallback brand name (typically the guild name) used when the owner has not
   * configured a store_brand_name. Falls back to 'SomniBot' when omitted/blank.
   */
  fallbackName?: string;
}

/**
 * The neutral SomniBot default kit — the fallback for every field. Used verbatim
 * for unconfigured guilds and whenever config resolution fails.
 */
export function defaultBrandKit(fallbackName?: string): BrandKit {
  const trimmed = typeof fallbackName === 'string' ? fallbackName.trim() : '';
  return {
    brandName: trimmed.length > 0 ? trimmed : 'SomniBot',
    primaryColor: SOMNI_PALETTE.HOT_PINK,
    accentColor: SOMNI_PALETTE.CYAN,
    voicePreset: 'default',
    poweredByAttribution: POWERED_BY_ATTRIBUTION,
  };
}

/** Coerce a stored color to a valid 24-bit int, else the palette fallback. */
function coerceColor(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COLOR
    ? value
    : fallback;
}

/** Coerce a stored voice preset to a known value, else 'default'. */
function coerceVoicePreset(value: unknown): BrandVoicePreset {
  return typeof value === 'string' && (BRAND_VOICE_PRESETS as readonly string[]).includes(value)
    ? (value as BrandVoicePreset)
    : 'default';
}

/**
 * Resolve a guild's white-label brand kit from guild_config.
 *
 * Never throws: on any error, missing row, or missing column it returns the
 * SomniBot default kit (optionally carrying the provided fallback name), so
 * callers can render unconditionally without a null check.
 */
export async function resolveBrandKit(
  supabase: SupabaseClient,
  guildId: string,
  options: ResolveBrandKitOptions = {},
): Promise<BrandKit> {
  const fallback = defaultBrandKit(options.fallbackName);

  try {
    const { data, error } = await supabase
      .from('guild_config')
      .select(
        'store_brand_name, store_show_powered_by, brand_primary_color, brand_accent_color, brand_voice_preset',
      )
      .eq('guild_id', guildId)
      .maybeSingle();

    if (error || !data) {
      return fallback;
    }

    // New brand-kit columns may not be present in the generated types yet; read
    // through a loose record so this compiles regardless of type regeneration.
    const cfg = data as Record<string, unknown>;

    const rawName = cfg.store_brand_name;
    const brandName =
      typeof rawName === 'string' && rawName.trim().length > 0
        ? rawName.trim()
        : fallback.brandName;

    // Powered-by defaults ON when the toggle is missing/null.
    const showPoweredBy = cfg.store_show_powered_by !== false;

    return {
      brandName,
      primaryColor: coerceColor(cfg.brand_primary_color, fallback.primaryColor),
      accentColor: coerceColor(cfg.brand_accent_color, fallback.accentColor),
      voicePreset: coerceVoicePreset(cfg.brand_voice_preset),
      poweredByAttribution: showPoweredBy ? POWERED_BY_ATTRIBUTION : null,
    };
  } catch (err) {
    log.warn('Failed to resolve brand kit; falling back to defaults', {
      guildId,
      error: String(err),
    });
    return fallback;
  }
}
