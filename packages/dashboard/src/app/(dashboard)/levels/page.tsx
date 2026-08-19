/**
 * Levels & XP — Settings, role rewards, multipliers, leaderboard.
 *
 * Architecture doc §24
 */
'use client';

import { VariableChips } from '@/components/shared/variable-chips';
import { useEffect, useRef, useState, useCallback } from 'react';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Trophy } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface LevelConfig {
  levels_enabled: boolean;
  xp_min: number;
  xp_max: number;
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
  no_xp_role_id: string | null;
  level_curve: { base: number; exponent: number };
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
  xp_min: 15,
  xp_max: 25,
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
  no_xp_role_id: null,
  level_curve: { base: 100, exponent: 1.9 },
};

function numToHex(n: number | null): string {
  if (n == null) return '#FF1493';
  return `#${n.toString(16).padStart(6, '0')}`;
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ── Helper: Inline member name display ────────────────────

function MemberName({ memberId }: { memberId: string }) {
  const { resolveMember } = useDiscordNames({ memberIds: [memberId] });
  return <p className="truncate text-sm font-medium text-discord-text-primary">{resolveMember(memberId)}</p>;
}

// ── Helper: Inline role name display ──────────────────────

function RoleDisplay({ roleId }: { roleId: string }) {
  const { resolveRole, roleColor } = useDiscordNames({ roleIds: [roleId] });
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: roleColor(roleId) }} />
      <span style={{ color: roleColor(roleId) }}>{resolveRole(roleId)}</span>
    </span>
  );
}

// ── Main Component ────────────────────────────────────────

export default function LevelsPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<LevelConfig>(DEFAULT_CONFIG);
  const [rewards, setRewards] = useState<LevelReward[]>([]);
  const [multipliers, setMultipliers] = useState<XpMultiplier[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [lbTotal, setLbTotal] = useState(0);
  const [lbPage, setLbPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedWarning(dirty);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'reward' | 'multiplier'; id: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'settings' | 'rewards' | 'multipliers' | 'leaderboard'>('settings');
  // Binds the level-up variable chips to their own input so a click can never
  // insert into an unrelated field.
  const levelUpMessageRef = useRef<HTMLInputElement>(null);

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

  // Track unsaved changes — skip the initial render + fetch-set
  const configLoaded = useRef(false);
  useEffect(() => {
    if (!loading && configLoaded.current) {
      setDirty(true);
    }
    if (!loading) configLoaded.current = true;
  }, [config, loading]);

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


  const saveConfig = async () => {
    setSaving(true);
    setError(null);

    // Client-side validation
    if (config.xp_min < 1 || config.xp_max < 1) {
      setError('XP values must be at least 1');
      toast({ title: 'XP values must be at least 1', variant: 'error' });
      setSaving(false);
      return;
    }
    if (config.xp_min >= config.xp_max) {
      setError('Min XP must be less than Max XP');
      toast({ title: 'Min XP must be less than Max XP', variant: 'error' });
      setSaving(false);
      return;
    }
    if (config.xp_cooldown_seconds < 0) {
      setError('XP cooldown cannot be negative');
      toast({ title: 'XP cooldown cannot be negative', variant: 'error' });
      setSaving(false);
      return;
    }
    if (config.voice_xp_enabled && config.voice_xp_per_interval < 1) {
      setError('Voice XP per interval must be at least 1');
      toast({ title: 'Voice XP per interval must be at least 1', variant: 'error' });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/levels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error);
        toast({ title: json.error || 'Failed to save', variant: 'error' });
      } else {
        toast({ title: 'Settings saved', variant: 'success' });
        setDirty(false);
      }
    } catch {
      setError('Failed to save settings');
      toast({ title: 'Failed to save settings', variant: 'error' });
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
        toast({ title: 'Reward added', variant: 'success' });
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
        toast({ title: 'Reward removed', variant: 'success' });
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
        toast({ title: 'Multiplier added', variant: 'success' });
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
        toast({ title: 'Multiplier removed', variant: 'success' });
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
    return <ConfigSkeleton />;
  }

  const tabs = ['settings', 'rewards', 'multipliers', 'leaderboard'] as const;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-0 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-card bg-discord-bg-tertiary p-1 sm:flex">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`min-w-0 rounded-input px-3 py-1.5 text-sm font-medium capitalize transition-standard sm:flex-1 ${
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
                  value={config.xp_min}
                  onChange={(e) => setConfig({ ...config, xp_min: Number(e.target.value) })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Max XP per Message</label>
                <input
                  type="number"
                  value={config.xp_max}
                  onChange={(e) => setConfig({ ...config, xp_max: Number(e.target.value) })}
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
              <ChannelPicker
                label={config.xp_channel_mode === 'blacklist' ? 'Blacklisted Channels' : 'Whitelisted Channels'}
                value={config.xp_channel_list}
                onChange={(v) => setConfig({ ...config, xp_channel_list: (v as string[]) ?? [] })}
                multi
                placeholder="Select channels…"
              />
            </div>
          </div>

          {/* No-XP Role */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Level Curve</h2>
            <p className="mb-3 text-xs text-discord-text-muted">Tune the cumulative XP curve. Higher exponents make later levels take longer.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-discord-text-muted">Base XP<input type="number" min={1} max={1000000} step="any" value={config.level_curve.base} onChange={(e) => setConfig({ ...config, level_curve: { ...config.level_curve, base: Number(e.target.value) } })} className="mt-1 w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary" /></label>
              <label className="text-xs text-discord-text-muted">Exponent<input type="number" min={0.1} max={5} step="0.1" value={config.level_curve.exponent} onChange={(e) => setConfig({ ...config, level_curve: { ...config.level_curve, exponent: Number(e.target.value) } })} className="mt-1 w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary" /></label>
            </div>
          </div>

          {/* No-XP Role */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">XP Exclusion</h2>
            <RolePicker
              label="No-XP Role"
              value={config.no_xp_role_id}
              onChange={(v) => setConfig({ ...config, no_xp_role_id: (v as string) || null })}
              placeholder="Select a role (members with this role won't earn XP)"
              allowNone
            />
            <p className="mt-2 text-xs text-discord-text-muted">
              Members with this role will be completely excluded from earning XP. Useful for bots, staff, or other roles you want to opt out of the leveling system.
            </p>
          </div>

          {/* Level-Up Announcements */}
          <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">Level-Up Announcements</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <ChannelPicker
                  label="Announcement Channel"
                  value={config.level_up_channel_id}
                  onChange={(v) => setConfig({ ...config, level_up_channel_id: (v as string) || null })}
                  placeholder="Select channel (or none to disable)"
                  allowNone
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
              </label>
              <input
                ref={levelUpMessageRef}
                type="text"
                value={config.level_up_message ?? ''}
                onChange={(e) => setConfig({ ...config, level_up_message: e.target.value || null })}
                placeholder="🎉 {user} just reached **Level {level}**!"
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
              />
              <VariableChips
                targetRef={levelUpMessageRef}
                variables={[
                  { key: '{user}', desc: 'User mention' },
                  { key: '{level}', desc: 'New level' },
                  { key: '{totalXp}', desc: 'Total XP' },
                  { key: '{nextLevelXp}', desc: 'XP for next level' },
                ]}
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
                <RolePicker
                  label="Reward Role"
                  value={newRewardRoleId || null}
                  onChange={(v) => setNewRewardRoleId((v as string) ?? '')}
                  placeholder="Select role…"
                />
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
                <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-discord-accent/10 text-sm font-bold text-discord-accent">
                      {r.level}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-discord-text-primary [overflow-wrap:anywhere]">Level {r.level} → <RoleDisplay roleId={r.role_id} /></p>
                      <p className="text-xs text-discord-text-muted">
                        {r.remove_at_level ? `Removed at level ${r.remove_at_level}` : 'Permanent'}
                        {r.announce ? ' · Announced' : ''}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => setConfirmDelete({ type: 'reward', id: r.id })} className="shrink-0 text-sm text-discord-danger transition-standard hover:text-discord-danger/80">
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
                <RolePicker
                  label="Role"
                  value={newMultRoleId || null}
                  onChange={(v) => setNewMultRoleId((v as string) ?? '')}
                  placeholder="Select role…"
                />
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
                <div key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-discord-warning/10 text-sm font-bold text-discord-warning">
                      {m.multiplier}×
                    </span>
                    <p className="min-w-0 text-sm font-medium text-discord-text-primary [overflow-wrap:anywhere]"><RoleDisplay roleId={m.role_id} /></p>
                  </div>
                  <button onClick={() => setConfirmDelete({ type: 'multiplier', id: m.id })} className="shrink-0 text-sm text-discord-danger transition-standard hover:text-discord-danger/80">
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
              <EmptyState compact icon={Trophy} title="No XP data yet" description="Members will appear on the leaderboard as they earn XP." />
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
                        <MemberName memberId={entry.member_id} />
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

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.type === 'reward' ? 'Delete Level Reward' : 'Delete XP Multiplier'}
        description={confirmDelete?.type === 'reward'
          ? 'Remove this level reward? Members who already received the role will keep it.'
          : 'Remove this XP multiplier? It will no longer apply to matching members.'}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            if (confirmDelete.type === 'reward') await deleteReward(confirmDelete.id);
            else await deleteMultiplier(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
