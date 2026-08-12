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
 *   - currency_name          → currencyName (economy display currency)
 *   - currency_emoji         → currencyEmoji
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
  /** Owner-configured economy currency display name (guild_config.currency_name). */
  currencyName: string;
  /** Owner-configured economy currency emoji (guild_config.currency_emoji). */
  currencyEmoji: string;
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

/**
 * The guild_config columns the brand kit projects from, as a select-list
 * fragment. Narrow-select managers append this to their existing column list
 * so the cached row they already hold can feed brandKitFromConfig() directly.
 */
export const BRAND_KIT_COLUMNS =
  'store_brand_name, store_brand_source, store_show_powered_by, brand_primary_color, brand_accent_color, brand_voice_preset, currency_name, currency_emoji';

/** Max valid Discord embed color (24-bit 0xFFFFFF). */
const MAX_COLOR = 0xffffff;

/** guild_config defaults for the currency columns (20260521200000 migration). */
const DEFAULT_CURRENCY_NAME = 'Coins';
const DEFAULT_CURRENCY_EMOJI = '🪙';

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
    currencyName: DEFAULT_CURRENCY_NAME,
    currencyEmoji: DEFAULT_CURRENCY_EMOJI,
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

/** Coerce a stored non-empty string, else the fallback. */
function coerceText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Pure projection: build a BrandKit from an already-loaded guild_config row
 * (or fragment containing the BRAND_KIT_COLUMNS). Managers that cache config
 * rows can call this directly instead of re-querying through resolveBrandKit.
 *
 * Accepts any object (e.g. a typed DbGuildConfig row without an index
 * signature) — the projection reads its columns dynamically and coerces each.
 *
 * Never throws; any missing/invalid column falls back to the default kit value.
 */
export function brandKitFromConfig(
  cfgRow: object | null | undefined,
  fallbackName?: string,
): BrandKit {
  const fallback = defaultBrandKit(fallbackName);
  if (!cfgRow) return fallback;
  const cfg = cfgRow as Record<string, unknown>;

  const rawName = cfg.store_brand_source === 'guild-profile' ? null : cfg.store_brand_name;
  const brandName =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : fallback.brandName;

  // Powered-by defaults ON when the toggle is missing/null.
  const showPoweredBy = cfg.store_show_powered_by !== false;

  return {
    brandName,
    primaryColor: coerceColor(cfg.brand_primary_color, fallback.primaryColor),
    accentColor: coerceColor(cfg.brand_accent_color, fallback.accentColor),
    voicePreset: coerceVoicePreset(cfg.brand_voice_preset),
    poweredByAttribution: showPoweredBy ? POWERED_BY_ATTRIBUTION : null,
    currencyName: coerceText(cfg.currency_name, fallback.currencyName),
    currencyEmoji: coerceText(cfg.currency_emoji, fallback.currencyEmoji),
  };
}

// ── Per-guild config-row cache ────────────────────────────
//
// resolveBrandKit is called several times per interaction on busy surfaces
// (ticket-service alone resolves it 4x per ticket lifecycle), so the raw
// guild_config row is cached per guild for a short TTL. The ROW is cached —
// not the projected kit — because brandName depends on the caller's
// fallbackName; projecting per call keeps different callers correct while
// still sharing one DB read.
//
// A FAILED read is NEVER cached (mirrors games-manager getConfigChecked):
// caching a failure would pin every brand surface to the vendor defaults for
// the TTL even after the database recovers. A successful "no row" read IS
// cached — an unconfigured guild is a legitimate, stable state.

interface BrandRowCacheEntry {
  row: Record<string, unknown> | null;
  time: number;
}

const BRAND_KIT_CACHE_TTL = 30_000;

/**
 * Maximum guilds tracked in the cache Map. In a sharded bot, each shard
 * handles ~2500 guilds max; 10,000 provides ample headroom without unbounded
 * growth risk (same sizing as the anti-raid config cache).
 */
const MAX_CACHED_GUILDS = 10_000;

const _rowCache = new Map<string, BrandRowCacheEntry>();

// ── Cache generation token ──
//
// Deleting the cache entry alone cannot invalidate a read that is already in
// flight: resolveBrandKit awaits the DB between its cache miss and its
// _rowCache.set, so an invalidation landing in that window would be silently
// overwritten by the (now stale) row — pinning the pre-save brand for a full
// TTL. To close the race, every resolve captures the guild's generation at
// cache-miss time and only writes the row back if the generation is still
// unchanged. Targeted invalidations bump the guild's counter; the no-arg form
// bumps a global epoch that outranks every per-guild counter.

/** Snapshot of a guild's cache generation (compared field-wise, never summed). */
interface BrandCacheGeneration {
  epoch: number;
  guild: number;
}

let _globalEpoch = 0;
const _guildGenerations = new Map<string, number>();

function cacheGenerationOf(guildId: string): BrandCacheGeneration {
  return { epoch: _globalEpoch, guild: _guildGenerations.get(guildId) ?? 0 };
}

function generationUnchanged(guildId: string, captured: BrandCacheGeneration): boolean {
  const current = cacheGenerationOf(guildId);
  return current.epoch === captured.epoch && current.guild === captured.guild;
}

/** Evict oldest entry from a Map if it exceeds the cap. */
function capMap<V>(map: Map<string, V>, max: number): void {
  /* v8 ignore next 4 -- defensive cap; only fires at 10k+ guilds in memory */
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

/**
 * Invalidate the cached brand-kit row for one guild, or all guilds when no
 * guildId is given. Called by the config-watcher when the dashboard saves the
 * 'branding' section so owner edits apply without waiting out the TTL.
 *
 * Also bumps the guild's cache generation (global epoch for the no-arg form)
 * so any resolve already awaiting the DB discards its result instead of
 * caching a row read before this invalidation.
 */
export function invalidateBrandKitCache(guildId?: string): void {
  if (guildId) {
    _rowCache.delete(guildId);
    _guildGenerations.set(guildId, (_guildGenerations.get(guildId) ?? 0) + 1);
    if (_guildGenerations.size > MAX_CACHED_GUILDS) {
      // Evicting a counter could make an in-flight capture read "unchanged"
      // again, so fail CLOSED: bump the epoch so every in-flight resolve
      // skips its cache write (worst case: one extra DB read per guild).
      const oldest = _guildGenerations.keys().next().value;
      if (oldest) _guildGenerations.delete(oldest);
      _globalEpoch++;
    }
  } else {
    _rowCache.clear();
    // The per-guild counters stay put: clearing them alongside the epoch bump
    // could re-produce a previously captured {epoch+1, 0} snapshot.
    _globalEpoch++;
  }
}

/**
 * Resolve a guild's white-label brand kit from guild_config.
 *
 * Cached per guild for 30s (invalidate via invalidateBrandKitCache). Never
 * throws: on any error, missing row, or missing column it returns the SomniBot
 * default kit (optionally carrying the provided fallback name), so callers can
 * render unconditionally without a null check. Failed reads are not cached.
 */
export async function resolveBrandKit(
  supabase: SupabaseClient,
  guildId: string,
  options: ResolveBrandKitOptions = {},
): Promise<BrandKit> {
  const now = Date.now();
  const cached = _rowCache.get(guildId);
  if (cached && now - cached.time < BRAND_KIT_CACHE_TTL) {
    return brandKitFromConfig(cached.row, options.fallbackName);
  }

  // Captured at cache-miss time: if an invalidation lands while the query is
  // in flight, the fetched row may predate the save and must not be cached.
  const generation = cacheGenerationOf(guildId);

  try {
    const { data, error } = await supabase
      .from('guild_config')
      .select(BRAND_KIT_COLUMNS)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (error) {
      // Failed read — fall back WITHOUT caching so recovery is immediate.
      return defaultBrandKit(options.fallbackName);
    }

    // New brand-kit columns may not be present in the generated types yet; read
    // through a loose record so this compiles regardless of type regeneration.
    const row = (data as Record<string, unknown> | null) ?? null;
    if (generationUnchanged(guildId, generation)) {
      _rowCache.set(guildId, { row, time: now });
      capMap(_rowCache, MAX_CACHED_GUILDS);
    }

    return brandKitFromConfig(row, options.fallbackName);
  } catch (err) {
    log.warn('Failed to resolve brand kit; falling back to defaults', {
      guildId,
      error: String(err),
    });
    return defaultBrandKit(options.fallbackName);
  }
}
