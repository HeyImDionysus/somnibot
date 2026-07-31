/**
 * Branding — Configure the guild's white-label brand kit.
 *
 * One owner configuration drives EVERY member-facing bot surface: brand name,
 * primary/accent embed colors, copy voice preset, and the powered-by
 * attribution toggle. Saved via PUT /api/branding, which hot-reloads the bot's
 * brand kit cache.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
// Subpath import: the shared BARREL (and even ./constants) transitively pulls
// node:crypto (constants/levels.ts), which the Next client bundle rejects.
// constants/brand is dependency-free and exported as its own entry.
import { colorToHex, SOMNI_PALETTE } from '@somnibot/shared/constants/brand';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { fetchOptionalJsonArray } from '@/lib/optional-json';
import {
  DiscordEmbedPreview,
  type DiscordEmbedPreviewField,
} from '@/components/discord/discord-embed-preview';

// ── Types ─────────────────────────────────────────────────

type VoicePreset = 'default' | 'professional' | 'friendly' | 'playful';

interface BrandingConfig {
  store_brand_name: string | null;
  store_show_powered_by: boolean;
  brand_primary_color: number | null;
  brand_accent_color: number | null;
  brand_voice_preset: VoicePreset;
}

const DEFAULT_CONFIG: BrandingConfig = {
  store_brand_name: null,
  store_show_powered_by: true,
  brand_primary_color: null,
  brand_accent_color: null,
  brand_voice_preset: 'default',
};

/** One-line description per voice preset (mirrors the bot's voice table). */
const VOICE_PRESETS: Array<{ value: VoicePreset; label: string; description: string }> = [
  { value: 'default', label: 'Default', description: "SomniBot's stock copy, exactly as shipped." },
  { value: 'professional', label: 'Professional', description: 'Polished and to the point — no emoji flourishes.' },
  { value: 'friendly', label: 'Friendly', description: 'Warm and encouraging, with a light touch.' },
  { value: 'playful', label: 'Playful', description: 'Cheeky, emoji-forward, and fun.' },
];

interface SavedEmbed {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  color: number | null;
  fields: DiscordEmbedPreviewField[];
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  author_name: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
}

/** Parse a '#rrggbb' hex string to a 24-bit int. */
function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) & 0xffffff;
}

// ── Component ─────────────────────────────────────────────

export default function BrandingPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<BrandingConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedEmbeds, setSavedEmbeds] = useState<SavedEmbed[]>([]);
  const [selectedEmbedId, setSelectedEmbedId] = useState<string>('');
  useUnsavedWarning(dirty);

  const fetchConfig = useCallback(async () => {
    try {
      const brandingRes = await fetch('/api/branding');
      const brandingJson = await brandingRes.json();
      if (brandingRes.ok && brandingJson.success) {
        setConfig({ ...DEFAULT_CONFIG, ...brandingJson.data });
      } else {
        const message = brandingJson.error || 'Failed to load branding';
        setError(message);
        toast({ title: message, variant: 'error' });
        return;
      }

      // Saved embeds are optional preview material. Fetch and parse them only
      // after the authoritative branding config has been applied so a proxy or
      // malformed optional response can never leave an editable defaults form.
      // Release the editor before awaiting this secondary request: an optional
      // preview endpoint that stalls must not block authoritative branding.
      setLoading(false);
      const embeds = await fetchOptionalJsonArray<SavedEmbed>('/api/embeds');
      setSavedEmbeds(embeds);
      setSelectedEmbedId((current) => current || embeds[0]?.id || '');
    } catch {
      setError('Failed to load branding');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateField = <K extends keyof BrandingConfig>(key: K, value: BrandingConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const saveConfig = async () => {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          // Blank name means "fall back to the guild name" — store NULL.
          store_brand_name: config.store_brand_name?.trim() || null,
        }),
      });

      const json = await res.json();

      if (json.success) {
        toast({ title: 'Branding saved', variant: 'success' });
        setDirty(false);
      } else {
        const msg = json.error || 'Failed to save';
        setError(msg);
        toast({ title: msg, variant: 'error' });
      }
    } catch {
      setError('Failed to save branding');
      toast({ title: 'Failed to save branding', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  const primaryHex = colorToHex(config.brand_primary_color ?? SOMNI_PALETTE.HOT_PINK);
  const accentHex = colorToHex(config.brand_accent_color ?? SOMNI_PALETTE.CYAN);
  const previewName = config.store_brand_name?.trim() || 'Your Server';
  const selectedEmbed = savedEmbeds.find((embed) => embed.id === selectedEmbedId) ?? savedEmbeds[0];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">🎨 Branding</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            White-label the bot — your name, colors, and voice on every member-facing surface.
          </p>
        </div>
        <button
          onClick={saveConfig}
          disabled={saving || !dirty}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            dirty
              ? 'bg-discord-accent text-white hover:bg-discord-accent/80'
              : 'bg-discord-bg-tertiary text-discord-text-muted cursor-not-allowed'
          }`}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-md bg-discord-danger/20 px-4 py-3 text-sm text-discord-danger">
          {error}
        </div>
      )}

      {/* Brand Name */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">Brand Name</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Shown on the storefront header, ticket embeds, and other member-facing surfaces.
          Leave blank to use your server name.
        </p>
        <input
          type="text"
          maxLength={64}
          value={config.store_brand_name ?? ''}
          onChange={(e) => updateField('store_brand_name', e.target.value || null)}
          placeholder="Falls back to your server name"
          className="mt-3 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-discord-accent focus:outline-none"
        />
      </div>

      {/* Brand Colors */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-discord-text-primary">Brand Colors</h2>
          <p className="mt-1 text-sm text-discord-text-muted">
            Embed accent colors for member-facing messages. Warning and danger tones are derived
            from your primary color automatically.
          </p>
        </div>

        {(
          [
            {
              key: 'brand_primary_color' as const,
              label: 'Primary Color',
              desc: 'Key actions, confirmations, and headline embeds.',
              hex: primaryHex,
              fallback: SOMNI_PALETTE.HOT_PINK,
            },
            {
              key: 'brand_accent_color' as const,
              label: 'Accent Color',
              desc: 'Informational and secondary embeds.',
              hex: accentHex,
              fallback: SOMNI_PALETTE.CYAN,
            },
          ]
        ).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <label className="block text-sm font-medium text-discord-text-secondary">
                {row.label}
              </label>
              <p className="mt-0.5 text-xs text-discord-text-muted">{row.desc}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                type="color"
                value={row.hex}
                onChange={(e) => updateField(row.key, hexToInt(e.target.value))}
                className="h-9 w-12 cursor-pointer rounded-md border border-discord-border-subtle bg-discord-bg-tertiary"
                aria-label={row.label}
              />
              <span className="w-20 font-mono text-sm text-discord-text-primary">{row.hex}</span>
              <button
                onClick={() => updateField(row.key, null)}
                disabled={config[row.key] === null}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  config[row.key] === null
                    ? 'bg-discord-bg-tertiary text-discord-text-muted cursor-not-allowed'
                    : 'bg-discord-bg-tertiary text-discord-text-secondary hover:text-discord-text-primary'
                }`}
                title={`Reset to the default (${colorToHex(row.fallback)})`}
              >
                Default
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Voice Preset */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">Voice</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          The tone the bot uses for stock member-facing lines (cooldowns, refusals, outage notices).
        </p>
        <select
          value={config.brand_voice_preset}
          onChange={(e) => updateField('brand_voice_preset', e.target.value as VoicePreset)}
          className="mt-3 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
        >
          {VOICE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label} — {preset.description}
            </option>
          ))}
        </select>
      </div>

      {/* Powered-by */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary">
              &quot;Powered by SomniBot&quot;
            </h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Show a subtle attribution in the footer of member-facing embeds.
            </p>
          </div>
          <button
            onClick={() => updateField('store_show_powered_by', !config.store_show_powered_by)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.store_show_powered_by ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config.store_show_powered_by ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Live Preview */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">Live Preview</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          An actual saved member-facing embed with the unsaved brand color and attribution applied.
        </p>

        {savedEmbeds.length > 0 && selectedEmbed ? (
          <>
            <label className="mt-4 block text-xs font-medium text-discord-text-muted" htmlFor="preview-embed">
              Saved embed
            </label>
            <select
              id="preview-embed"
              value={selectedEmbed.id}
              onChange={(event) => setSelectedEmbedId(event.target.value)}
              className="mb-3 mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            >
              {savedEmbeds.map((embed) => (
                <option key={embed.id} value={embed.id}>{embed.name}</option>
              ))}
            </select>
            <DiscordEmbedPreview
              embed={{
                title: selectedEmbed.title,
                description: selectedEmbed.description,
                color: primaryHex,
                fields: selectedEmbed.fields,
                imageUrl: selectedEmbed.image_url,
                thumbnailUrl: selectedEmbed.thumbnail_url,
                footerText: selectedEmbed.footer_text,
                authorName: selectedEmbed.author_name || previewName,
                authorIconUrl: selectedEmbed.author_icon_url,
                includeTimestamp: selectedEmbed.include_timestamp,
              }}
              footerSuffix={config.store_show_powered_by ? 'Powered by SomniBot' : null}
            />
          </>
        ) : (
          <div className="mt-4 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary p-4">
            <p className="text-sm font-medium text-discord-text-primary">No saved embed to preview</p>
            <p className="mt-1 text-sm text-discord-text-muted">
              Create the member-facing message first; this page will preview its real content.
            </p>
            <Link href="/embeds" className="mt-3 inline-block text-sm font-medium text-discord-accent hover:underline">
              Create an embed
            </Link>
          </div>
        )}

        {/* Swatches */}
        <div className="mt-4 flex items-center gap-4">
          {[
            { label: 'Primary', hex: primaryHex },
            { label: 'Accent', hex: accentHex },
          ].map((swatch) => (
            <div key={swatch.label} className="flex items-center gap-2">
              <span
                className="h-5 w-5 rounded-full ring-1 ring-white/10"
                style={{ backgroundColor: swatch.hex }}
              />
              <span className="text-xs text-discord-text-muted">
                {swatch.label} <span className="font-mono">{swatch.hex}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
