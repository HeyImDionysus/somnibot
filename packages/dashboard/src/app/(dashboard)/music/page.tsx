/**
 * Music Settings — Configure DJ role, default volume, queue limits, and behavior.
 *
 * Architecture doc §29.6–§29.7
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import NowPlayingWidget from '@/components/music/now-playing-widget';

// ── Types ─────────────────────────────────────────────────

interface MusicConfig {
  music_enabled: boolean;
  default_volume: number;
  max_queue_length: number;
  allow_duplicates: boolean;
  dj_role_id: string | null;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

const DEFAULT_CONFIG: MusicConfig = {
  music_enabled: true,
  default_volume: 50,
  max_queue_length: 500,
  allow_duplicates: true,
  dj_role_id: null,
};

// ── Component ─────────────────────────────────────────────

export default function MusicSettingsPage() {
  const [config, setConfig] = useState<MusicConfig>(DEFAULT_CONFIG);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const flash = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const fetchConfig = useCallback(async () => {
    try {
      const [musicRes, rolesRes] = await Promise.all([
        fetch('/api/music'),
        fetch('/api/roles'),
      ]);

      const musicJson = await musicRes.json();
      if (musicJson.success) {
        setConfig(musicJson.data);
      } else {
        setError(musicJson.error);
      }

      const rolesJson = await rolesRes.json();
      if (rolesJson.success && Array.isArray(rolesJson.data)) {
        setRoles(
          rolesJson.data
            .filter((r: DiscordRole) => r.name !== '@everyone')
            .sort((a: DiscordRole, b: DiscordRole) => b.position - a.position),
        );
      }
    } catch {
      setError('Failed to load music settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateField = <K extends keyof MusicConfig>(key: K, value: MusicConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const saveConfig = async () => {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/music', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      const json = await res.json();

      if (json.success) {
        flash('Music settings saved');
        setDirty(false);
      } else {
        setError(json.error || 'Failed to save');
      }
    } catch {
      setError('Failed to save music settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Now Playing Widget */}
      <NowPlayingWidget />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">🎵 Music Settings</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Configure the Lavalink-powered music system — DJ roles, volume, queue behavior.
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
      {success && (
        <div className="rounded-md bg-discord-success/20 px-4 py-3 text-sm text-discord-success">
          {success}
        </div>
      )}

      {/* Enable/Disable */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary">Music System</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Enable or disable the music system globally. When disabled, music commands won&apos;t be registered.
            </p>
          </div>
          <button
            onClick={() => updateField('music_enabled', !config.music_enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config.music_enabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                config.music_enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {config.music_enabled && (
        <>
          {/* DJ Role */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
            <h2 className="text-lg font-semibold text-discord-text-primary">DJ Role</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Members with this role can force-skip, clear queue, adjust volume, and disconnect the bot.
              Without a DJ role, everyone has DJ privileges. Members alone in voice always have DJ privileges.
            </p>
            <select
              value={config.dj_role_id ?? ''}
              onChange={(e) => updateField('dj_role_id', e.target.value || null)}
              className="mt-3 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            >
              <option value="">No DJ role (everyone is DJ)</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>

          {/* Playback Settings */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-5">
            <h2 className="text-lg font-semibold text-discord-text-primary">Playback Settings</h2>

            {/* Default Volume */}
            <div>
              <label className="block text-sm font-medium text-discord-text-secondary">
                Default Volume
              </label>
              <p className="mt-0.5 text-xs text-discord-text-muted">
                Volume when the bot first joins a voice channel (0–150).
              </p>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={150}
                  value={config.default_volume}
                  onChange={(e) => updateField('default_volume', parseInt(e.target.value, 10))}
                  className="flex-1 accent-discord-accent"
                />
                <span className="w-12 text-right text-sm font-mono text-discord-text-primary">
                  {config.default_volume}%
                </span>
              </div>
            </div>

            {/* Max Queue Length */}
            <div>
              <label className="block text-sm font-medium text-discord-text-secondary">
                Max Queue Length
              </label>
              <p className="mt-0.5 text-xs text-discord-text-muted">
                Maximum number of tracks allowed in the queue (1–2000).
              </p>
              <input
                type="number"
                min={1}
                max={2000}
                value={config.max_queue_length}
                onChange={(e) =>
                  updateField('max_queue_length', Math.max(1, Math.min(2000, parseInt(e.target.value, 10) || 500)))
                }
                className="mt-2 w-32 rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
              />
            </div>

            {/* Allow Duplicates */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-discord-text-secondary">
                  Allow Duplicate Tracks
                </label>
                <p className="mt-0.5 text-xs text-discord-text-muted">
                  Whether the same track can be added to the queue multiple times.
                </p>
              </div>
              <button
                onClick={() => updateField('allow_duplicates', !config.allow_duplicates)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config.allow_duplicates ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    config.allow_duplicates ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Auto Behaviors Info */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
            <h2 className="text-lg font-semibold text-discord-text-primary">Auto Behaviors</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              These behaviors are always active and cannot be disabled.
            </p>
            <div className="mt-4 space-y-3">
              {[
                { label: 'Auto-leave', desc: 'Leave voice when channel is empty (5 min timeout)' },
                { label: 'Auto-pause', desc: 'Pause when bot is alone in voice' },
                { label: 'Auto-resume', desc: 'Resume when someone joins while paused' },
                { label: 'Auto-destroy', desc: 'Destroy player after 30 min of inactivity' },
                { label: 'Queue persist', desc: 'Queue is saved to cache and survives track errors' },
              ].map((item) => (
                <div key={item.label} className="flex items-start gap-3">
                  <span className="mt-0.5 text-discord-success">✅</span>
                  <div>
                    <span className="text-sm font-medium text-discord-text-primary">{item.label}</span>
                    <p className="text-xs text-discord-text-muted">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Lavalink Health */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
            <h2 className="text-lg font-semibold text-discord-text-primary">Lavalink Node</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Music audio is powered by a Lavalink v4 server with YouTube plugin.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="rounded-md bg-discord-bg-tertiary p-3">
                <span className="text-xs font-medium text-discord-text-muted">Server</span>
                <p className="mt-1 text-sm font-mono text-discord-text-primary">Lavalink v4.0.8</p>
              </div>
              <div className="rounded-md bg-discord-bg-tertiary p-3">
                <span className="text-xs font-medium text-discord-text-muted">Client</span>
                <p className="mt-1 text-sm font-mono text-discord-text-primary">Shoukaku v4.x</p>
              </div>
              <div className="rounded-md bg-discord-bg-tertiary p-3">
                <span className="text-xs font-medium text-discord-text-muted">YouTube Plugin</span>
                <p className="mt-1 text-sm font-mono text-discord-text-primary">v1.17.0</p>
              </div>
              <div className="rounded-md bg-discord-bg-tertiary p-3">
                <span className="text-xs font-medium text-discord-text-muted">Enabled Filters</span>
                <p className="mt-1 text-sm font-mono text-discord-text-primary">EQ, Timescale, Rotation</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-discord-success animate-pulse" />
              <span className="text-discord-text-secondary">Node connected via WebSocket</span>
            </div>
          </div>

          {/* Filter Presets Reference */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
            <h2 className="text-lg font-semibold text-discord-text-primary">Audio Filter Presets</h2>
            <p className="mt-1 text-sm text-discord-text-muted mb-4">
              Available via the <code className="rounded bg-discord-bg-tertiary px-1 py-0.5 text-xs">/filter</code> command. Custom speed/pitch/rate values (0.1–3.0) are also supported.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { emoji: '🔊', name: 'Bass Boost', desc: 'Heavy low-end' },
                { emoji: '🔔', name: 'Treble Boost', desc: 'Crisp high-end' },
                { emoji: '🌙', name: 'Nightcore', desc: '1.25x speed + pitch' },
                { emoji: '🌊', name: 'Vaporwave', desc: '0.8x speed + pitch' },
                { emoji: '🎧', name: '8D Audio', desc: 'Rotating spatial' },
                { emoji: '🔄', name: 'Reset', desc: 'Clear all filters' },
              ].map((preset) => (
                <div key={preset.name} className="rounded-md bg-discord-bg-tertiary p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{preset.emoji}</span>
                    <span className="text-sm font-medium text-discord-text-primary">{preset.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-discord-text-muted">{preset.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Commands Reference */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6">
            <h2 className="text-lg font-semibold text-discord-text-primary">Music Commands</h2>
            <p className="mt-1 text-sm text-discord-text-muted mb-4">
              All commands are registered as Discord slash commands.
            </p>
            <div className="overflow-hidden rounded-md border border-discord-border-subtle">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-discord-bg-tertiary">
                    <th className="px-4 py-2 text-left font-medium text-discord-text-secondary">Command</th>
                    <th className="px-4 py-2 text-left font-medium text-discord-text-secondary">Description</th>
                    <th className="px-4 py-2 text-left font-medium text-discord-text-secondary">DJ Only</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-discord-border-subtle">
                  {[
                    { cmd: '/play <query>', desc: 'Search & play or add to queue', dj: false },
                    { cmd: '/skip', desc: 'Skip current track (vote-skip if not DJ)', dj: false },
                    { cmd: '/stop', desc: 'Stop playback and clear queue', dj: true },
                    { cmd: '/pause', desc: 'Pause or resume playback', dj: true },
                    { cmd: '/queue [page]', desc: 'View the queue', dj: false },
                    { cmd: '/np', desc: 'Show now-playing info', dj: false },
                    { cmd: '/volume <0–150>', desc: 'Set volume', dj: true },
                    { cmd: '/loop <mode>', desc: 'Set loop mode (off/track/queue)', dj: true },
                    { cmd: '/shuffle', desc: 'Shuffle upcoming tracks', dj: true },
                    { cmd: '/seek <position>', desc: 'Seek to position (e.g., 1:30)', dj: true },
                    { cmd: '/remove <position>', desc: 'Remove a track by position', dj: true },
                    { cmd: '/filter [preset]', desc: 'Audio filters (bass, nightcore, 8D, etc.)', dj: true },
                  ].map((row) => (
                    <tr key={row.cmd} className="bg-discord-bg-secondary">
                      <td className="px-4 py-2 font-mono text-discord-text-primary">{row.cmd}</td>
                      <td className="px-4 py-2 text-discord-text-secondary">{row.desc}</td>
                      <td className="px-4 py-2">
                        {row.dj ? (
                          <span className="rounded bg-discord-warning/20 px-1.5 py-0.5 text-xs text-discord-warning">DJ</span>
                        ) : (
                          <span className="rounded bg-discord-success/20 px-1.5 py-0.5 text-xs text-discord-success">All</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
