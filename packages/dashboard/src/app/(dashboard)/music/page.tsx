/**
 * Music Settings — Configure DJ role, default volume, queue limits, and behavior.
 *
 * Architecture doc §29.6–§29.7
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import NowPlayingWidget from '@/components/music/now-playing-widget';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import {
  lavalinkHealthFromDiagnostics,
  UNKNOWN_LAVALINK_HEALTH,
  type LavalinkHealth,
} from '@/lib/lavalink-health';
import { ValidatedNumberInput } from '../economy/_components/validated-number-input';

// ── Types ─────────────────────────────────────────────────

interface MusicConfig {
  music_enabled: boolean;
  music_default_volume: number;
  dj_role_id: string | null;
  music_auto_leave_minutes: number;
  music_auto_destroy_minutes: number;
  max_queue_length: number;
  allow_duplicates: boolean;
  per_user_queue_cap: number;
  vote_skip_threshold_percent: number;
  self_skip_enabled: boolean;
  requester_move_enabled: boolean;
  priority_voting_enabled: boolean;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

const DEFAULT_CONFIG: MusicConfig = {
  music_enabled: true,
  music_default_volume: 50,
  dj_role_id: null,
  music_auto_leave_minutes: 5,
  music_auto_destroy_minutes: 30,
  max_queue_length: 5000,
  allow_duplicates: true,
  per_user_queue_cap: 50,
  vote_skip_threshold_percent: 50,
  self_skip_enabled: true,
  requester_move_enabled: true,
  priority_voting_enabled: true,
};

const LAVALINK_STATUS_TEXT: Record<LavalinkHealth['state'], string> = {
  connected: 'Configured and connected via WebSocket; playback readiness is not reported separately.',
  disconnected: 'Configured, but disconnected; music playback is not ready.',
  unavailable: 'Not configured; music playback is not ready.',
  unknown: 'Configuration or live connection status could not be confirmed.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMusicConfig(value: unknown): value is MusicConfig {
  if (!isRecord(value)) return false;
  return typeof value.music_enabled === 'boolean'
    && typeof value.music_default_volume === 'number'
    && (typeof value.dj_role_id === 'string' || value.dj_role_id === null)
    && typeof value.music_auto_leave_minutes === 'number'
    && typeof value.music_auto_destroy_minutes === 'number'
    && typeof value.max_queue_length === 'number'
    && typeof value.allow_duplicates === 'boolean'
    && typeof value.per_user_queue_cap === 'number'
    && typeof value.vote_skip_threshold_percent === 'number'
    && typeof value.self_skip_enabled === 'boolean'
    && typeof value.requester_move_enabled === 'boolean'
    && typeof value.priority_voting_enabled === 'boolean';
}

class MusicReadbackError extends Error {
  constructor() {
    super('Music settings readback failed');
    this.name = 'MusicReadbackError';
  }
}

// ── Component ─────────────────────────────────────────────

export default function MusicSettingsPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<MusicConfig>(DEFAULT_CONFIG);
  const [confirmedConfig, setConfirmedConfig] = useState<MusicConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [lavalinkHealth, setLavalinkHealth] = useState<LavalinkHealth>(UNKNOWN_LAVALINK_HEALTH);
  const [lavalinkCheckedAt, setLavalinkCheckedAt] = useState<Date | null>(null);
  const [checkingLavalink, setCheckingLavalink] = useState(false);
  useUnsavedWarning(dirty);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [musicRes, rolesRes] = await Promise.all([
        fetch('/api/music'),
        fetch('/api/roles'),
      ]);

      const musicJson = await musicRes.json();
      if (musicJson.success && isMusicConfig(musicJson.data)) {
        setConfig(musicJson.data);
        setConfirmedConfig(musicJson.data);
        setConfigLoaded(true);
      } else {
        setConfigLoaded(false);
        setError(typeof musicJson.error === 'string' ? musicJson.error : 'Music settings could not be verified.');
        toast({ title: musicJson.error || 'Failed to load music config', variant: 'error' });
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
      setConfigLoaded(false);
      setError('Failed to load music settings');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchLavalinkHealth = useCallback(async () => {
    setCheckingLavalink(true);
    try {
      const res = await fetch('/api/diagnostics');
      if (!res.ok) {
        setLavalinkHealth(UNKNOWN_LAVALINK_HEALTH);
        return;
      }
      setLavalinkHealth(lavalinkHealthFromDiagnostics(await res.json()));
    } catch {
      setLavalinkHealth(UNKNOWN_LAVALINK_HEALTH);
    } finally {
      setLavalinkCheckedAt(new Date());
      setCheckingLavalink(false);
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
    void fetchLavalinkHealth();
  }, [fetchConfig, fetchLavalinkHealth]);

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

      const json: unknown = await res.json();

      if (isRecord(json) && json.success === true) {
        const readback = await fetch('/api/music', { cache: 'no-store' });
        const readbackJson: unknown = await readback.json();
        if (!readback.ok || !isRecord(readbackJson) || readbackJson.success !== true || !isMusicConfig(readbackJson.data)) {
          throw new MusicReadbackError();
        }
        setConfig(readbackJson.data);
        setConfirmedConfig(readbackJson.data);
        toast({ title: 'Music settings saved', variant: 'success' });
        setDirty(false);
      } else {
        const msg = isRecord(json) && typeof json.error === 'string' ? json.error : 'Failed to save';
        setConfig(confirmedConfig);
        setDirty(false);
        setError(msg);
        toast({ title: msg, variant: 'error' });
      }
    } catch {
      setConfig(confirmedConfig);
      setDirty(false);
      setError('Failed to save music settings; restored the last confirmed values.');
      toast({ title: 'Failed to save music settings; restored confirmed values', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  if (!configLoaded) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-bold text-discord-text-primary">🎵 Music Settings</h1>
        <div role="alert" className="rounded-lg border border-discord-danger/40 bg-discord-danger/10 p-5">
          <h2 className="font-semibold text-discord-danger">Music settings unavailable</h2>
          <p className="mt-2 text-sm text-discord-text-secondary">
            {error ?? 'The saved configuration could not be verified. Editing is disabled until it can be read.'}
          </p>
          <button
            type="button"
            onClick={() => void fetchConfig()}
            className="mt-4 min-h-11 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
          >
            Retry loading settings
          </button>
        </div>
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
            type="button"
            role="switch"
            aria-label="Enable Music System"
            aria-checked={config.music_enabled}
            onClick={() => updateField('music_enabled', !config.music_enabled)}
            className={`relative inline-flex h-11 w-11 items-center rounded-full transition-colors ${
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
                  value={config.music_default_volume}
                  onChange={(e) => updateField('music_default_volume', parseInt(e.target.value, 10))}
                  className="flex-1 accent-discord-accent"
                />
                <span className="w-12 text-right text-sm font-mono text-discord-text-primary">
                  {config.music_default_volume}%
                </span>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ValidatedNumberInput label="Maximum Queue Length (tracks)" help="Maximum tracks held for this server." value={config.max_queue_length} min={1} max={5000} onCommit={async (value) => { updateField('max_queue_length', value); return 'saved'; }} />
              <ValidatedNumberInput label="Per-Member Queue Cap (tracks)" help="Maximum queued tracks attributed to one requester." value={config.per_user_queue_cap} min={1} max={500} onCommit={async (value) => { updateField('per_user_queue_cap', value); return 'saved'; }} />
            </div>
            <label className="flex items-start gap-3 cursor-pointer pt-2 border-t border-discord-border-subtle">
              <input type="checkbox" checked={config.allow_duplicates}
                onChange={(e) => updateField('allow_duplicates', e.target.checked)} className="mt-1 accent-discord-accent" />
              <span><span className="block text-sm font-medium text-discord-text-secondary">Allow duplicate tracks</span>
                <span className="block text-xs text-discord-text-muted">When off, a track already in the queue cannot be requested again.</span></span>
            </label>
          </div>

          {/* Fairness Controls */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-discord-text-primary">Fairness Controls</h2>
              <p className="mt-1 text-sm text-discord-text-muted">
                Control how listeners skip and manage the queue.
              </p>
            </div>

            {/* Vote-skip threshold */}
            <div>
              <label className="block text-sm font-medium text-discord-text-secondary">
                Vote-Skip Threshold
              </label>
              <p className="mt-0.5 text-xs text-discord-text-muted">
                Percentage of listeners whose votes are needed to skip a track (1–100).
              </p>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={config.vote_skip_threshold_percent}
                  onChange={(e) => updateField('vote_skip_threshold_percent', parseInt(e.target.value, 10))}
                  className="flex-1 accent-discord-accent"
                />
                <span className="w-12 text-right text-sm font-mono text-discord-text-primary">
                  {config.vote_skip_threshold_percent}%
                </span>
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-3 pt-2 border-t border-discord-border-subtle">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.self_skip_enabled}
                  onChange={(e) => updateField('self_skip_enabled', e.target.checked)}
                  className="mt-1 accent-discord-accent"
                />
                <span>
                  <span className="block text-sm font-medium text-discord-text-secondary">Self-skip</span>
                  <span className="block text-xs text-discord-text-muted">Let the requester skip their own track without a vote.</span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.requester_move_enabled}
                  onChange={(e) => updateField('requester_move_enabled', e.target.checked)}
                  className="mt-1 accent-discord-accent"
                />
                <span>
                  <span className="block text-sm font-medium text-discord-text-secondary">Requester move</span>
                  <span className="block text-xs text-discord-text-muted">Let the requester reposition their own queued track (via /move).</span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.priority_voting_enabled}
                  onChange={(e) => updateField('priority_voting_enabled', e.target.checked)}
                  className="mt-1 accent-discord-accent"
                />
                <span>
                  <span className="block text-sm font-medium text-discord-text-secondary">Priority voting</span>
                  <span className="block text-xs text-discord-text-muted">A DJ&apos;s skip vote takes effect immediately.</span>
                </span>
              </label>
            </div>
          </div>

          {/* Auto Behaviors */}
          <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-discord-text-primary">Auto Behaviors</h2>
              <p className="mt-1 text-sm text-discord-text-muted">
                Configure automatic voice channel management. Auto-pause, auto-resume, and queue persistence are always active.
              </p>
            </div>

            {/* Auto-leave timeout */}
            <div>
              <ValidatedNumberInput label="Auto-Leave Timeout (minutes)" help="Leave voice after the channel remains empty for this long." value={config.music_auto_leave_minutes} min={1} max={60} onCommit={async (value) => { updateField('music_auto_leave_minutes', value); return 'saved'; }} className="mt-2 w-32 rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary" />
            </div>

            {/* Auto-destroy timeout */}
            <div>
              <ValidatedNumberInput label="Inactivity Timeout (minutes)" help="Destroy an inactive player after this long." value={config.music_auto_destroy_minutes} min={1} max={120} onCommit={async (value) => { updateField('music_auto_destroy_minutes', value); return 'saved'; }} className="mt-2 w-32 rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary" />
            </div>

            {/* Always-on behaviors */}
            <div className="space-y-3 pt-2 border-t border-discord-border-subtle">
              <p className="text-xs font-medium text-discord-text-muted uppercase tracking-wide">Always Active</p>
              {[
                { label: 'Auto-pause', desc: 'Pause when bot is alone in voice' },
                { label: 'Auto-resume', desc: 'Resume when someone joins while paused' },
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
              Configuration and observed runtime readiness are reported separately.
            </p>
            <div className="mt-4 space-y-2 text-sm" aria-live="polite">
              <p className="text-discord-text-secondary">{LAVALINK_STATUS_TEXT[lavalinkHealth.state]}</p>
              <p className="text-xs text-discord-text-muted">
                Last checked: {lavalinkCheckedAt ? lavalinkCheckedAt.toLocaleTimeString() : 'not checked yet'}
              </p>
              {lavalinkHealth.state !== 'connected' ? (
                <p className="text-xs text-discord-text-muted">
                  Open <a href="/diagnostics" className="text-discord-accent hover:underline">Diagnostics</a> to inspect node details, then restart the Lavalink service or bot connection before retrying.
                </p>
              ) : null}
              <button type="button" onClick={() => void fetchLavalinkHealth()} disabled={checkingLavalink} className="min-h-11 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary hover:bg-discord-bg-hover disabled:opacity-50">
                {checkingLavalink ? 'Checking Lavalink…' : 'Check Lavalink again'}
              </button>
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
