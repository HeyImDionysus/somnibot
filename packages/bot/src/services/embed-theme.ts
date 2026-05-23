/**
 * Embed Theme Service — Per-feature embed customization.
 *
 * V53 Phase 3 (Finding 3.7 — M-10)
 *
 * Provides `themedEmbed(supabase, valkey, guildId, featureKey)` that returns
 * an EmbedBuilder pre-configured with the guild's overrides for that feature
 * (color, footer, thumbnail, author). Falls back to defaults.
 *
 * Overrides are cached in Valkey for 60s to avoid DB hits on every embed.
 */
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';

// ── Types ─────────────────────────────────────────────────

export type FeatureKey =
  | 'welcome'
  | 'goodbye'
  | 'level_up'
  | 'moderation'
  | 'economy'
  | 'music'
  | 'tickets'
  | 'giveaways'
  | 'achievements';

export interface EmbedOverride {
  guild_id: string;
  feature_key: FeatureKey;
  color: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  thumbnail_url: string | null;
  author_name: string | null;
}

// ── Default colors ────────────────────────────────────────

const DEFAULT_COLORS: Record<FeatureKey, number> = {
  welcome: 0x57f287,
  goodbye: 0xed4245,
  level_up: 0xfee75c,
  moderation: 0xed4245,
  economy: 0x5865f2,
  music: 0xeb459e,
  tickets: 0x5865f2,
  giveaways: 0xfee75c,
  achievements: 0xf1c40f,
};

const CACHE_TTL = 60; // seconds
const CACHE_PREFIX = 'embed_theme';

// ── Public API ────────────────────────────────────────────

/**
 * Returns an EmbedBuilder pre-configured with the guild's overrides
 * for the given feature. Cached in Valkey for 60s.
 */
export async function themedEmbed(
  supabase: SupabaseClient,
  valkey: Valkey,
  guildId: string,
  featureKey: FeatureKey,
): Promise<EmbedBuilder> {
  const override = await getOverride(supabase, valkey, guildId, featureKey);
  const embed = new EmbedBuilder();

  // Color
  const colorHex = override?.color;
  if (colorHex) {
    const parsed = parseInt(colorHex.replace('#', ''), 16);
    if (!isNaN(parsed)) embed.setColor(parsed);
    else embed.setColor(DEFAULT_COLORS[featureKey]);
  } else {
    embed.setColor(DEFAULT_COLORS[featureKey]);
  }

  // Footer
  if (override?.footer_text) {
    embed.setFooter({
      text: override.footer_text,
      iconURL: override.footer_icon_url ?? undefined,
    });
  }

  // Thumbnail
  if (override?.thumbnail_url) {
    embed.setThumbnail(override.thumbnail_url);
  }

  // Author
  if (override?.author_name) {
    embed.setAuthor({ name: override.author_name });
  }

  return embed;
}

/**
 * Invalidate cached override for a feature (called when dashboard saves).
 */
export async function invalidateThemeCache(
  valkey: Valkey,
  guildId: string,
  featureKey?: FeatureKey,
): Promise<void> {
  if (featureKey) {
    await valkey.del(`${CACHE_PREFIX}:${guildId}:${featureKey}`);
  } else {
    // Invalidate all for this guild (SCAN instead of KEYS — V5 audit 6.1)
    let cursor = '0';
    do {
      const [next, batch] = await valkey.scan(cursor, 'MATCH', `${CACHE_PREFIX}:${guildId}:*`, 'COUNT', '100');
      cursor = next;
      if (batch.length > 0) await valkey.del(...batch);
    } while (cursor !== '0');
  }
}

// ── Internal ──────────────────────────────────────────────

async function getOverride(
  supabase: SupabaseClient,
  valkey: Valkey,
  guildId: string,
  featureKey: FeatureKey,
): Promise<EmbedOverride | null> {
  const cacheKey = `${CACHE_PREFIX}:${guildId}:${featureKey}`;

  // Try cache first
  const cached = await valkey.get(cacheKey);
  if (cached) {
    if (cached === 'null') return null;
    try {
      return JSON.parse(cached) as EmbedOverride;
    } catch {
      // Corrupted cache — fetch from DB
    }
  }

  // Fetch from DB
  const { data } = await supabase
    .from('feature_embed_overrides')
    .select('*')
    .eq('guild_id', guildId)
    .eq('feature_key', featureKey)
    .maybeSingle();

  // Cache result (including null → 'null' to avoid repeated DB misses)
  await valkey.set(cacheKey, data ? JSON.stringify(data) : 'null', 'EX', CACHE_TTL);

  return data as EmbedOverride | null;
}
