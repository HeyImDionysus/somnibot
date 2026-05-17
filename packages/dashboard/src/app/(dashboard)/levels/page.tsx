/**
 * Levels & XP — Settings, role rewards, multipliers, leaderboard.
 *
 * Architecture doc §24
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface LevelConfig {
  levels_enabled: boolean;
  min_xp: number;
  max_xp: number;
  xp_cooldown_seconds: number;
  voice_xp_enabled: boolean;
  voice_xp_per_interval: number;
  voice_xp_interval_minutes: number;
  xp_multiplier_mode: 'highest' | 'additive';
  xp_channel_mode: 'blacklist' | 'whitelist';
  xp_channel_list: string[];
  level_up_channel_id: string | null;
  level_up_message: string | null;
  rank_card_accent_color: number | null;
  rank_card_background: string | null;
}

interface LevelReward {
  id: string;
  guild_id: string;
  level: number;
  role_id: string;
  remove_at_level: number | null;
  announce: boolean;
  created_at: string;
}

interface XpMultiplier {
  id: string;
  guild_id: string;
  role_id: string;
  multiplier: number;
  created_at: string;
}

interface LeaderboardEntry {
  member_id: string;
  xp: number;
  level: number;
  total_messages: number;
  voice_minutes: number;
}

const DEFAULT_CONFIG: LevelConfig = {
  levels_enabled: false,
  min_xp: 15,
  max_xp: 25,
  xp_cooldown_seconds: 60,
  voice_xp_enabled: false,
  voice_xp_per_interval: 10,
  voice_xp_interval_minutes: 5,
  xp_multiplier_mode: 'highest',
  xp_channel_mode: 'blacklist',
  xp_channel_list: [],
  level_up_channel_id: null,
  level_up_message: null,
  rank_card_accent_color: null,
  rank_card_background: null,
};

function numToHex(n: number | null): string {
  if (n == null) return '#FF1493';
  return `#${n.toString(16).padStart(6, '0')}`;
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ── Main Component ────────────────────────────────────────

export default function LevelsPage() {
  const [config, setConfig] = useState<LevelConfig>(DEFAULT_CONFIG);
  const [rewards, setRewards] = useState<LevelReward[]>([]);
  const [multipliers, setMultipliers] = useState<XpMultiplier[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [lbTotal, setLbTotal] = useState(0);
  const [lbPage, setLbPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'settings' | 'rewards' | 'multipliers' | 'leaderboard'>('settings');

  // Reward form
  const [newRewardLevel, setNewRewardLevel] = useState(5);
  const [newRewardRoleId, setNewRewardRoleId] = useState('');
  const [newRewardRemoveAt, setNewRewardRemoveAt] = useState('');
  const [newRewardAnnounce, setNewRewardAnnounce] = useState(true);

  // Multiplier form
  const [newMultRoleId, setNewMultRoleId] = useState('');
  const [newMultValue, setNewMultValue] = useState(1.5);

  // Channel list input
  const [channelInput, setChannelInput] = useState('');

  // ── Data fetching ──────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/levels');
      const json = await res.json();
      if (json.success) {
        setConfig({ ...DEFAULT_CONFIG, ...json.config });
        setRewards(json.rewards);
        setMultipliers(json.multipliers);
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to load level settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLeaderboard = useCallback(async (page = 0) => {
    try {
      const res = await fetch(`/api/levels?section=leaderboard&page=${page}`);
      const json = await res.json();
      if (json.success) {
        setLeaderboard(json.data);
        setLbTotal(json.total);
        setLbPage(page);
      }
    } catch {
      setError('Failed to load leaderboard');
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (activeTab === 'leaderboard') fetchLeaderboard(0);
  }, [activeTab, fetchLeaderboard]);

  // ── Handlers ───────────────────────────────────────────

  const flash = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/levels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!json.success) setError(json.error);
      else flash('Settings saved');
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const addReward = async () => {
    if (!newRewardRoleId) return;
    setError(null);
    try {
      const res = await fetch('/api/levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reward',
          level: newRewardLevel,
          role_id: newRewardRoleId,
          remove_at_level: newRewardRemoveAt ? parseInt(newRewardRemoveAt, 10) : null,
          announce: newRewardAnnounce,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setRewards([...rewards, json.data]);
        setNewRewardRoleId('');
        setNewRewardRemoveAt('');
        flash('Reward added');
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to add reward');
    }
  };

  const deleteReward = async (id: string) => {
    try {
      const res = await fetch(`/api/levels?type=reward&id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setRewards(rewards.filter((r) => r.id !== id));
        flash('Reward removed');
      }
    } catch {
      setError('Failed to remove reward');
    }
  };

  const addMultiplier = async () => {
    if (!newMultRoleId) return;
    setError(null);
    try {
      const res = await fetch('/api/levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'multiplier',
          role_id: newMultRoleId,
          multiplier: newMultValue,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setMultipliers([...multipliers, json.data]);
        setNewMultRoleId('');
        flash('Multiplier added');
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to add multiplier');
    }
  };

  const deleteMultiplier = async (id: string) => {
    try {
      const res = await fetch(`/api/levels?type=multiplier&id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setMultipliers(multipliers.filter((m) => m.id !== id));
        flash('Multiplier removed');
      }
    } catch {
      setError('Failed to remove multiplier');
    }
  };

  const addChannel = () => {
    if (!channelInput.trim()) return;
    setConfig({
      ...config,
      xp_channel_list: [...config.xp_channel_list, channelInput.trim()],
    });
    setChannelInput('');
  };

  const removeChannel = (channelId: string) => {
    setConfig({
      ...config,
      xp_channel_list: config.xp_channel_list.filter((c) => c !== channelId),
    });
  };

  // ── Render ─────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-discord-text-muted">Loading level settings…</div>
      </div>
    );
  }

  const tabs = ['settings', 'rewards', 'multipliers', 'leaderboard'] as const;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Levels & XP</h1>
          <p className="text-sm text-discord-text-muted">Configure the leveling system, role rewards, and XP multipliers</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <span className="text-sm text-discord-text-secondary">
            {config.levels_enabled ? 'Enabled' : 'Disabled'}
          </span>
          <div
            className={`relative h-6 w-11 rounded-full transition-colors ${config.levels_enabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
            onClick={() => setConfig({ ...config, levels_enabled: !config.levels_enabled })}
          >
            <div
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${config.levels_enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </div>
        </label>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-card bg-discord-success/10 border border-discord-success/30 px-4 py-3 text-sm text-discord-success">
          {success}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 rounded-card bg-discord-bg-tertiary p-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-input px-3 py-1.5 text-sm font-medium capitalize transition-standard ${
              activeTab === tab
                ? 'bg-discord-bg-secondary text-discord-text-primary'
                : 'text-discord-text-muted hover:text-discord-text-secondary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Settings Tab ────────────────────────────────── */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          {/* XP Settings */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Message XP</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Min XP per Message</label>
                <input
                  type="number"
                  value={config.min_xp}
                  onChange={(e) => setConfig({ ...config, min_xp: Number(e.target.value) })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Max XP per Message</label>
                <input
                  type="number"
                  value={config.max_xp}
                  onChange={(e) => setConfig({ ...config, max_xp: Number(e.target.value) })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Cooldown (seconds)</label>
                <input
                  type="number"
                  value={config.xp_cooldown_seconds}
                  onChange={(e) => setConfig({ ...config, xp_cooldown_seconds: Number(e.target.value) })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Voice XP */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-discord-text-primary">Voice XP</h2>
              <div
                className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors ${config.voice_xp_enabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                onClick={() => setConfig({ ...config, voice_xp_enabled: !config.voice_xp_enabled })}
              >
                <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${config.voice_xp_enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">XP per Interval</label>
                <input
                  type="number"
                  value={config.voice_xp_per_interval}
                  onChange={(e) => setConfig({ ...config, voice_xp_per_interval: Number(e.target.value) })}
                  disabled={!config.voice_xp_enabled}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none disabled:opacity-50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Interval (minutes)</label>
                <input
                  type="number"
                  value={config.voice_xp_interval_minutes}
                  onChange={(e) => setConfig({ ...config, voice_xp_interval_minutes: Number(e.target.value) })}
                  disabled={!config.voice_xp_enabled}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* Channel & Multiplier Mode */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Channel & Multiplier Settings</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">XP Channel Mode</label>
                <select
                  value={config.xp_channel_mode}
                  onChange={(e) => setConfig({ ...config, xp_channel_mode: e.target.value as 'blacklist' | 'whitelist' })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                >
                  <option value="blacklist">Blacklist (block specific channels)</option>
                  <option value="whitelist">Whitelist (only specific channels)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Multiplier Mode</label>
                <select
                  value={config.xp_multiplier_mode}
                  onChange={(e) => setConfig({ ...config, xp_multiplier_mode: e.target.value as 'highest' | 'additive' })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                >
                  <option value="highest">Highest (use highest applicable multiplier)</option>
                  <option value="additive">Additive (sum all applicable multipliers)</option>
                </select>
              </div>
            </div>

            {/* Channel list */}
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                {config.xp_channel_mode === 'blacklist' ? 'Blacklisted Channels' : 'Whitelisted Channels'}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={channelInput}
                  onChange={(e) => setChannelInput(e.target.value)}
                  placeholder="Channel ID"
                  className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
                <button onClick={addChannel} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                  Add
                </button>
              </div>
              {config.xp_channel_list.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {config.xp_channel_list.map((ch) => (
                    <span key={ch} className="flex items-center gap-1 rounded-input bg-discord-bg-tertiary px-2 py-1 text-xs text-discord-text-secondary">
                      #{ch}
                      <button onClick={() => removeChannel(ch)} className="text-discord-danger hover:text-discord-danger/80 ml-1">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Level-Up Announcements */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Level-Up Announcements</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Announcement Channel ID</label>
                <input
                  type="text"
                  value={config.level_up_channel_id ?? ''}
                  onChange={(e) => setConfig({ ...config, level_up_channel_id: e.target.value || null })}
                  placeholder="Leave empty to disable"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Rank Card Accent Color</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={numToHex(config.rank_card_accent_color)}
                    onChange={(e) => setConfig({ ...config, rank_card_accent_color: hexToNum(e.target.value) })}
                    className="h-9 w-12 cursor-pointer rounded-input border border-discord-border-subtle"
                  />
                  <span className="self-center text-xs text-discord-text-muted">{numToHex(config.rank_card_accent_color)}</span>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Level-Up Message
                <span className="ml-2 text-discord-text-muted font-normal">Variables: {'{user}'} {'{level}'} {'{totalXp}'} {'{nextLevelXp}'}</span>
              </label>
              <input
                type="text"
                value={config.level_up_message ?? ''}
                onChange={(e) => setConfig({ ...config, level_up_message: e.target.value || null })}
                placeholder="🎉 {user} just reached **Level {level}**!"
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Save */}
          <div className="flex justify-end">
            <button onClick={saveConfig} disabled={saving} className="rounded-input bg-discord-success px-6 py-2 text-sm font-medium text-white hover:bg-discord-success/80 transition-standard disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </div>
      )}

      {/* ── Rewards Tab ─────────────────────────────────── */}
      {activeTab === 'rewards' && (
        <div className="space-y-4">
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Add Level Reward</h2>
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Level</label>
                <input type="number" min={1} value={newRewardLevel} onChange={(e) => setNewRewardLevel(Number(e.target.value))}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Role ID</label>
                <input type="text" value={newRewardRoleId} onChange={(e) => setNewRewardRoleId(e.target.value)} placeholder="Role ID"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Remove at Level</label>
                <input type="text" value={newRewardRemoveAt} onChange={(e) => setNewRewardRemoveAt(e.target.value)} placeholder="Optional"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div className="flex items-end">
                <button onClick={addReward} className="w-full rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                  Add Reward
                </button>
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-discord-text-secondary">
              <input type="checkbox" checked={newRewardAnnounce} onChange={(e) => setNewRewardAnnounce(e.target.checked)} className="rounded" />
              Announce this reward in level-up message
            </label>
          </div>

          {/* Rewards List */}
          {rewards.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center text-sm text-discord-text-muted">
              No level rewards configured yet. Add one above.
            </div>
          ) : (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary divide-y divide-discord-border-subtle">
              {rewards.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-discord-accent/10 text-sm font-bold text-discord-accent">
                      {r.level}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary">Level {r.level} → Role {r.role_id}</p>
                      <p className="text-xs text-discord-text-muted">
                        {r.remove_at_level ? `Removed at level ${r.remove_at_level}` : 'Permanent'}
                        {r.announce ? ' · Announced' : ''}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => deleteReward(r.id)} className="text-discord-danger hover:text-discord-danger/80 text-sm transition-standard">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Multipliers Tab ─────────────────────────────── */}
      {activeTab === 'multipliers' && (
        <div className="space-y-4">
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Add XP Multiplier</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Role ID</label>
                <input type="text" value={newMultRoleId} onChange={(e) => setNewMultRoleId(e.target.value)} placeholder="Role ID"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Multiplier</label>
                <input type="number" step={0.1} min={0.1} max={10} value={newMultValue} onChange={(e) => setNewMultValue(Number(e.target.value))}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div className="flex items-end">
                <button onClick={addMultiplier} className="w-full rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                  Add Multiplier
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-discord-text-muted">
              Mode: <strong>{config.xp_multiplier_mode}</strong> — {config.xp_multiplier_mode === 'highest' ? 'only the highest matching multiplier applies' : 'all matching multipliers are summed'}
            </p>
          </div>

          {multipliers.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center text-sm text-discord-text-muted">
              No XP multipliers configured yet. Add one above.
            </div>
          ) : (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary divide-y divide-discord-border-subtle">
              {multipliers.map((m) => (
                <div key={m.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-discord-warning/10 text-sm font-bold text-discord-warning">
                      {m.multiplier}×
                    </span>
                    <p className="text-sm font-medium text-discord-text-primary">Role {m.role_id}</p>
                  </div>
                  <button onClick={() => deleteMultiplier(m.id)} className="text-discord-danger hover:text-discord-danger/80 text-sm transition-standard">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Leaderboard Tab ─────────────────────────────── */}
      {activeTab === 'leaderboard' && (
        <div className="space-y-4">
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
            <div className="border-b border-discord-border-subtle px-5 py-3">
              <h2 className="text-lg font-semibold text-discord-text-primary">Server Leaderboard</h2>
              <p className="text-xs text-discord-text-muted">{lbTotal} members ranked</p>
            </div>
            {leaderboard.length === 0 ? (
              <div className="p-8 text-center text-sm text-discord-text-muted">No XP data yet.</div>
            ) : (
              <div className="divide-y divide-discord-border-subtle">
                {leaderboard.map((entry, i) => {
                  const rank = lbPage * 20 + i + 1;
                  const medals = ['🥇', '🥈', '🥉'];
                  return (
                    <div key={entry.member_id} className="flex items-center gap-4 px-5 py-3">
                      <span className="w-8 text-center text-sm font-bold text-discord-text-muted">
                        {rank <= 3 ? medals[rank - 1] : `#${rank}`}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium text-discord-text-primary">{entry.member_id}</p>
                        <p className="text-xs text-discord-text-muted">
                          {entry.total_messages.toLocaleString()} msgs · {entry.voice_minutes} voice min
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-discord-accent">Level {entry.level}</p>
                        <p className="text-xs text-discord-text-muted">{entry.xp.toLocaleString()} XP</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {lbTotal > 20 && (
              <div className="flex items-center justify-between border-t border-discord-border-subtle px-5 py-3">
                <button
                  onClick={() => fetchLeaderboard(lbPage - 1)}
                  disabled={lbPage === 0}
                  className="rounded-input bg-discord-bg-tertiary px-3 py-1 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 disabled:opacity-50 transition-standard"
                >
                  ◀ Previous
                </button>
                <span className="text-xs text-discord-text-muted">Page {lbPage + 1} of {Math.ceil(lbTotal / 20)}</span>
                <button
                  onClick={() => fetchLeaderboard(lbPage + 1)}
                  disabled={lbPage >= Math.ceil(lbTotal / 20) - 1}
                  className="rounded-input bg-discord-bg-tertiary px-3 py-1 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 disabled:opacity-50 transition-standard"
                >
                  Next ▶
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
