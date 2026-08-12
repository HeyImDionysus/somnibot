/**
 * Branded embed — one helper for the setColor+footer two-step that every
 * member-facing surface currently copy-pastes around resolveBrandKit.
 *
 * Intent → color mapping:
 *   primary → kit.primaryColor   (key actions, confirmations, headlines)
 *   info    → kit.accentColor    (informational/secondary embeds)
 *   warning → derived from primaryColor by HSL hue rotation (+45°)
 *   danger  → derived from primaryColor by HSL hue rotation (−45°)
 *
 * warning/danger have NO storage columns: for a custom brand they are derived
 * deterministically from the primary so they harmonize with the owner's hue;
 * for the default (unconfigured) kit they fall back to the classic semantic
 * colors — SOMNI_PALETTE.ORANGE and Discord red 0xED4245 — so unbranded guilds
 * keep the warning/danger look members already know.
 *
 * FOOTER RULE: when an embed already carries a semantic footer (e.g. the
 * ticket 'Ticket created by …' footer), the powered-by attribution is APPENDED
 * as ' • {attribution}' — never clobbered over it. `attribution: false`
 * suppresses the attribution entirely (staff/log surfaces).
 */
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SOMNI_PALETTE } from '@somnibot/shared';
import { type BrandKit, resolveBrandKit } from './brand-kit.js';

/** Semantic color intent for a branded embed. */
export type BrandIntent = 'primary' | 'info' | 'warning' | 'danger';

/** Discord's classic red — danger fallback for the default (unbranded) kit. */
const DANGER_FALLBACK = 0xed4245;

/** Hue rotation applied to primaryColor for the derived intents. */
const WARNING_HUE_SHIFT = 45;
const DANGER_HUE_SHIFT = -45;

export interface BrandEmbedOptions {
  /** Semantic color intent — defaults to 'primary'. */
  intent?: BrandIntent;
  /** Optional title, set verbatim. */
  title?: string;
  /** Optional description, set verbatim. */
  description?: string;
  /**
   * Set to `false` to suppress the powered-by attribution on this embed
   * (staff/log surfaces). Defaults to attributing per kit.poweredByAttribution.
   */
  attribution?: boolean;
  /**
   * Set to `true` to keep the embed's existing color instead of applying the
   * intent color. For surfaces whose color carries MEANING the brand must not
   * overwrite — fish/gathering rarity tiers, where the hue *is* the rarity.
   * Those embeds still receive the branded footer/attribution.
   */
  keepColor?: boolean;
}

export interface BrandedEmbedForOptions extends BrandEmbedOptions {
  /** Fallback brand name (typically the guild name) for unconfigured guilds. */
  fallbackName?: string;
}

// ── Color derivation ──────────────────────────────────────

/** Rotate a 24-bit RGB color's hue by `degrees`, preserving S and L. */
function rotateHue(color: number, degrees: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  h = (((h + degrees / 360) % 1) + 1) % 1;

  const hueToRgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let outR: number;
  let outG: number;
  let outB: number;
  if (s === 0) {
    outR = outG = outB = l; // achromatic — rotation is a no-op
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    outR = hueToRgb(p, q, h + 1 / 3);
    outG = hueToRgb(p, q, h);
    outB = hueToRgb(p, q, h - 1 / 3);
  }

  return (Math.round(outR * 255) << 16) | (Math.round(outG * 255) << 8) | Math.round(outB * 255);
}

/** Resolve the embed color for an intent against a brand kit. */
export function intentColor(kit: BrandKit, intent: BrandIntent): number {
  switch (intent) {
    case 'primary':
      return kit.primaryColor;
    case 'info':
      return kit.accentColor;
    case 'warning':
      return kit.primaryColor === SOMNI_PALETTE.HOT_PINK
        ? SOMNI_PALETTE.ORANGE
        : rotateHue(kit.primaryColor, WARNING_HUE_SHIFT);
    case 'danger':
      return kit.primaryColor === SOMNI_PALETTE.HOT_PINK
        ? DANGER_FALLBACK
        : rotateHue(kit.primaryColor, DANGER_HUE_SHIFT);
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Apply the brand kit to an EXISTING embed — the escape hatch for surfaces
 * that build elaborate embeds and only need the color + attribution pass.
 *
 * Sets the intent color, then handles the footer per the footer rule:
 * appends ' • {attribution}' to an existing semantic footer (preserving its
 * icon), sets the attribution alone when there is no footer, and leaves the
 * footer untouched when attribution is suppressed (opts or owner toggle).
 */
export function applyBrand(
  embed: EmbedBuilder,
  kit: BrandKit,
  opts: BrandEmbedOptions = {},
): EmbedBuilder {
  if (!opts.keepColor) {
    embed.setColor(intentColor(kit, opts.intent ?? 'primary'));
  }

  const attribution = kit.poweredByAttribution;
  if (opts.attribution === false || !attribution) return embed;

  const existing = embed.data?.footer;
  if (existing?.text) {
    if (!existing.text.includes(attribution)) {
      embed.setFooter({ text: `${existing.text} • ${attribution}`, iconURL: existing.icon_url });
    }
  } else {
    embed.setFooter({ text: attribution });
  }
  return embed;
}

/** Build a new branded embed from an already-resolved kit (sync). */
export function brandedEmbed(kit: BrandKit, opts: BrandEmbedOptions = {}): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (opts.title !== undefined) embed.setTitle(opts.title);
  if (opts.description !== undefined) embed.setDescription(opts.description);
  return applyBrand(embed, kit, opts);
}

/**
 * Build a new branded embed, resolving the guild's kit first (cached — see
 * resolveBrandKit). Never throws: an unresolvable kit renders the defaults.
 */
export async function brandedEmbedFor(
  supabase: SupabaseClient,
  guildId: string,
  opts: BrandedEmbedForOptions = {},
): Promise<EmbedBuilder> {
  const kit = await resolveBrandKit(supabase, guildId, { fallbackName: opts.fallbackName });
  return brandedEmbed(kit, opts);
}
