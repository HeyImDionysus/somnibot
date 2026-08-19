/**
 * Giveaways — Manage timed giveaways with entry requirements and winner selection.
 *
 * Architecture doc §28
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ChannelPicker, useChannelName } from '@/components/shared/channel-picker';
import { RolePicker, useRoleName } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface Giveaway {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  prize: string;
  prize_product_id: string | null;
  prize_license_count: number;
  winner_count: number;
  ends_at: string;
  required_role_id: string | null;
  required_level: number | null;
  required_entitlement_product_id: string | null;
  entries: string[];
  winners: string[];
  status: 'active' | 'ended' | 'cancelled';
  created_by: string;
  created_at: string;
}

const emptyForm = {
  channel_id: '',
  prize: '',
  winner_count: '1',
  duration_hours: '24',
  required_role_id: '',
  required_level: '',
  prize_product_id: '',
  prize_license_count: '1',
};

// ── Helpers ───────────────────────────────────────────────

function timeRemaining(endsAt: string): string {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return { label: 'Active', color: 'bg-discord-success/20 text-discord-success' };
    case 'ended':
      return { label: 'Ended', color: 'bg-discord-text-muted/20 text-discord-text-muted' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'bg-discord-danger/20 text-discord-danger' };
    default:
      return { label: status, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

// ── Name display helpers ──────────────────────────────────

function GiveawayChannelName({ id }: { id: string }) {
  const { resolveChannel } = useDiscordNames({ channelIds: [id] });
  return <span>{resolveChannel(id)}</span>;
}

function GiveawayRoleName({ id }: { id: string }) {
  const { resolveRole, roleColor } = useDiscordNames({ roleIds: [id] });
  return <span style={{ color: roleColor(id) }}>{resolveRole(id)}</span>;
}

function GiveawayWinners({ winnerIds }: { winnerIds: string[] }) {
  const { resolveMember } = useDiscordNames({ memberIds: winnerIds });
  return (
    <p className="text-xs text-discord-success mt-0.5">
      🏆 Winners: {winnerIds.map((id, i) => (
        <span key={id}>{i > 0 ? ', ' : ''}{resolveMember(id)}</span>
      ))}
    </p>
  );
}

// ── Main Component ────────────────────────────────────────

export default function GiveawaysPage() {
  const { toast } = useToast();

  const [giveaways, setGiveaways] = useState<Giveaway[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState<'all' | 'active' | 'ended'>('all');
  const [confirmAction, setConfirmAction] = useState<{ type: 'end' | 'cancel' | 'delete'; id: string; prize: string } | null>(null);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [settings, setSettings] = useState({
    giveaway_default_winner_count: 1,
    giveaway_dm_winners: true,
    giveaway_entry_button_label: 'Count me in!',
    giveaway_winner_announcement_style: 'embed' as 'embed' | 'plain',
  });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchGiveaways = useCallback(async () => {
    try {
      const [giveRes, guildRes, settingsRes] = await Promise.all([
        fetch('/api/giveaways'),
        fetch('/api/guild'),
        fetch('/api/giveaways/settings'),
      ]);
      const json = await giveRes.json();
      if (json.success) setGiveaways(json.data);
      else setError(json.error);
      const guildJson = await guildRes.json();
      if (guildJson.success) {
        setFeatureEnabled(guildJson.config?.giveaways_enabled ?? true);
      }
      const settingsJson = await settingsRes.json();
      if (settingsJson.success) setSettings(settingsJson.data);
    } catch {
      setError('Failed to load giveaways');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/giveaways/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (json.success) {
        toast({ title: 'Giveaway defaults saved', variant: 'success' });
        setSettingsDirty(false);
      } else {
        toast({ title: json.error || 'Failed to save', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to save giveaway defaults', variant: 'error' });
    } finally {
      setSavingSettings(false);
    }
  };

  const updateSetting = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsDirty(true);
  };

  useEffect(() => {
    fetchGiveaways();
  }, [fetchGiveaways]);

  const toggleFeature = async () => {
    const newValue = !featureEnabled;
    setFeatureEnabled(newValue);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ giveaways_enabled: newValue }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeatureEnabled(!newValue);
        toast({ title: 'Failed to toggle giveaways', variant: 'error' });
      } else {
        toast({ title: newValue ? 'Giveaways enabled' : 'Giveaways disabled', variant: 'success' });
      }
    } catch {
      setFeatureEnabled(!newValue);
    }
  };

  // GAP 2: Live updates — auto-refresh when giveaway data changes in DB
  useAutoRefresh('giveaways', undefined, fetchGiveaways);

  const createGiveaway = async () => {
    setError(null);
    if (!form.channel_id || !form.prize) {
      setError('Channel ID and Prize are required');
      return;
    }
    const winnerCount = parseInt(form.winner_count, 10) || 1;
    if (winnerCount < 1 || winnerCount > 50) {
      setError('Winner count must be between 1 and 50');
      toast({ title: 'Winner count must be between 1 and 50', variant: 'error' });
      return;
    }

    const hours = parseFloat(form.duration_hours) || 24;
    if (hours < 0.0167 || hours > 720) { // min ~1 minute, max 30 days
      setError('Duration must be between 1 minute and 30 days');
      toast({ title: 'Duration must be between 1 minute and 30 days', variant: 'error' });
      return;
    }
    const endsAt = new Date(Date.now() + hours * 3_600_000);

    const payload = {
      channel_id: form.channel_id,
      prize: form.prize,
      winner_count: parseInt(form.winner_count, 10) || 1,
      ends_at: endsAt.toISOString(),
      required_role_id: form.required_role_id || null,
      required_level: form.required_level ? parseInt(form.required_level, 10) : null,
      prize_product_id: form.prize_product_id || null,
      prize_license_count: parseInt(form.prize_license_count, 10) || 1,
      created_by: 'dashboard',
    };

    try {
      const res = await fetch('/api/giveaways', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        setGiveaways([json.data, ...giveaways]);
        setShowForm(false);
        setForm({ ...emptyForm });
        toast({ title: 'Giveaway created! The bot will post the entry embed in the channel.', variant: 'success' });
      } else {
        setError(json.error);
        toast({ title: json.error || 'Failed to create giveaway', variant: 'error' });
      }
    } catch {
      setError('Failed to create giveaway');
      toast({ title: 'Failed to create giveaway', variant: 'error' });
    }
  };

  const endGiveaway = async (id: string) => {
    try {
      const res = await fetch('/api/giveaways', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'ended' }),
      });
      const json = await res.json();
      if (json.success) {
        setGiveaways(giveaways.map((g) => (g.id === id ? json.data : g)));
        toast({ title: 'Giveaway ended', variant: 'success' });
      }
    } catch {
      setError('Failed to end giveaway');
    }
  };

  const cancelGiveaway = async (id: string) => {
    try {
      const res = await fetch('/api/giveaways', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'cancelled' }),
      });
      const json = await res.json();
      if (json.success) {
        setGiveaways(giveaways.map((g) => (g.id === id ? json.data : g)));
        toast({ title: 'Giveaway cancelled', variant: 'success' });
      }
    } catch {
      setError('Failed to cancel giveaway');
    }
  };

  const deleteGiveaway = async (id: string) => {
    try {
      const res = await fetch(`/api/giveaways?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setGiveaways(giveaways.filter((g) => g.id !== id));
        toast({ title: 'Giveaway deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete giveaway');
    }
  };

  const filtered = giveaways.filter((g) => {
    if (filter === 'active') return g.status === 'active';
    if (filter === 'ended') return g.status === 'ended' || g.status === 'cancelled';
    return true;
  });

  const activeCount = giveaways.filter((g) => g.status === 'active').length;
  const totalEntries = giveaways.reduce((sum, g) => sum + g.entries.length, 0);

  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-0 sm:p-6">
      {/* Header */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start justify-between gap-3 sm:items-center sm:justify-start">
          <div>
            <h1 className="text-2xl font-bold text-discord-text-primary">Giveaways</h1>
            <p className="text-sm text-discord-text-muted">Create and manage timed giveaways with button entry</p>
          </div>
          <button
            onClick={toggleFeature}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${featureEnabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
            title={featureEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${featureEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <button
          onClick={() => { setForm({ ...emptyForm }); setShowForm(true); }}
          className="self-start rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard sm:self-auto"
        >
          + New Giveaway
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-accent">{activeCount}</p>
          <p className="text-xs text-discord-text-muted">Active</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-text-primary">{giveaways.length}</p>
          <p className="text-xs text-discord-text-muted">Total</p>
        </div>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center">
          <p className="text-2xl font-bold text-discord-success">{totalEntries}</p>
          <p className="text-xs text-discord-text-muted">Total Entries</p>
        </div>
      </div>

      {/* Default Settings */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-discord-text-primary">Default Settings</h2>
          <button
            onClick={saveSettings}
            disabled={savingSettings || !settingsDirty}
            className={`rounded-input px-3 py-1.5 text-xs font-medium transition-standard ${
              settingsDirty ? 'bg-discord-accent text-white hover:bg-discord-accent/80' : 'bg-discord-bg-tertiary text-discord-text-muted cursor-not-allowed'
            }`}
          >
            {savingSettings ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs font-medium text-discord-text-secondary">Default winner count</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.giveaway_default_winner_count}
              onChange={(e) => updateSetting('giveaway_default_winner_count', Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
              className="mt-1 w-24 rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-2 py-1.5 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-discord-text-secondary">Entry button label</span>
            <input
              type="text"
              maxLength={80}
              value={settings.giveaway_entry_button_label}
              onChange={(e) => updateSetting('giveaway_entry_button_label', e.target.value)}
              className="mt-1 w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-2 py-1.5 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-discord-text-secondary">Winner announcement style</span>
            <select
              value={settings.giveaway_winner_announcement_style}
              onChange={(e) => updateSetting('giveaway_winner_announcement_style', e.target.value === 'plain' ? 'plain' : 'embed')}
              className="mt-1 w-40 rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-2 py-1.5 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            >
              <option value="embed">Embed</option>
              <option value="plain">Plain text</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pt-5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.giveaway_dm_winners}
              onChange={(e) => updateSetting('giveaway_dm_winners', e.target.checked)}
              className="accent-discord-accent"
            />
            <span className="text-sm text-discord-text-secondary">DM winners a personal congratulations</span>
          </label>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(['all', 'active', 'ended'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-input px-3 py-1.5 text-xs font-medium transition-standard ${filter === f ? 'bg-discord-accent text-white' : 'bg-discord-bg-tertiary text-discord-text-muted hover:text-discord-text-primary'}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      {/* ── Create Modal ─────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">New Giveaway</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Prize *</label>
                <input type="text" value={form.prize} onChange={(e) => setForm({ ...form, prize: e.target.value })}
                  placeholder="e.g. Nitro, custom role, product key"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <ChannelPicker
                  label="Channel *"
                  value={form.channel_id || null}
                  onChange={(v) => setForm({ ...form, channel_id: (v as string) ?? '' })}
                  placeholder="Select channel to post giveaway in…"
                  channelTypes={['text', 'announcement']}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Duration (hours)</label>
                  <input type="number" value={form.duration_hours} onChange={(e) => setForm({ ...form, duration_hours: e.target.value })}
                    min="0.1" step="0.5" placeholder="24"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Winner Count</label>
                  <input type="number" value={form.winner_count} onChange={(e) => setForm({ ...form, winner_count: e.target.value })}
                    min="1" max="50" placeholder="1"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <RolePicker
                    label="Required Role"
                    value={form.required_role_id || null}
                    onChange={(v) => setForm({ ...form, required_role_id: (v as string) ?? '' })}
                    placeholder="Optional role restriction"
                    allowNone
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Required Level</label>
                  <input type="number" value={form.required_level} onChange={(e) => setForm({ ...form, required_level: e.target.value })}
                    min="1" placeholder="Min level"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Prize Product ID</label>
                  <input type="text" value={form.prize_product_id} onChange={(e) => setForm({ ...form, prize_product_id: e.target.value })}
                    placeholder="Commerce integration"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">License Count</label>
                  <input type="number" value={form.prize_license_count} onChange={(e) => setForm({ ...form, prize_license_count: e.target.value })}
                    min="1" placeholder="1"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard">
                Cancel
              </button>
              <button onClick={createGiveaway} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Giveaway List ────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🎉</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Giveaways</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create a giveaway to engage your community!</p>
          <button onClick={() => { setForm({ ...emptyForm }); setShowForm(true); }} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Giveaway
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((g) => {
            const badge = statusBadge(g.status);
            return (
              <div key={g.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
                <div className="flex flex-col items-stretch gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="text-2xl">🎉</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-discord-text-primary [overflow-wrap:anywhere]">{g.prize}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.color}`}>
                            {badge.label}
                          </span>
                        </div>
                        <p className="text-xs text-discord-text-muted">
                          {g.entries.length} entries · {g.winner_count} winner{g.winner_count > 1 ? 's' : ''} · <GiveawayChannelName id={g.channel_id} />
                        </p>
                        <p className="text-xs text-discord-text-muted mt-0.5">
                          {g.status === 'active'
                            ? `⏰ Ends in ${timeRemaining(g.ends_at)}`
                            : `Ended ${new Date(g.ends_at).toLocaleDateString()}`}
                          {g.required_role_id ? <> · <GiveawayRoleName id={g.required_role_id} /></> : ''}
                          {g.required_level ? ` · Level ${g.required_level}+` : ''}
                        </p>
                        {g.winners.length > 0 && (
                          <GiveawayWinners winnerIds={g.winners} />
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-3 sm:ml-4 sm:shrink-0">
                    {g.status === 'active' && (
                      <>
                        <button onClick={() => setConfirmAction({ type: 'end', id: g.id, prize: g.prize })}
                          className="rounded-input bg-discord-success/20 px-3 py-1.5 text-xs font-medium text-discord-success hover:bg-discord-success/30 transition-standard">
                          End
                        </button>
                        <button onClick={() => setConfirmAction({ type: 'cancel', id: g.id, prize: g.prize })}
                          className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                          Cancel
                        </button>
                      </>
                    )}
                    <button onClick={() => setConfirmAction({ type: 'delete', id: g.id, prize: g.prize })}
                      className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Commands Reference ────────────────────────── */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-3">Giveaway Commands</h3>
        <div className="grid gap-2 text-xs text-discord-text-muted sm:grid-cols-2">
          <div><code className="text-discord-accent">/giveaway start</code> — Start a new giveaway</div>
          <div><code className="text-discord-accent">/giveaway end</code> — End early &amp; pick winners</div>
          <div><code className="text-discord-accent">/giveaway reroll</code> — Re-pick winners</div>
          <div><code className="text-discord-accent">/giveaway list</code> — List active giveaways</div>
        </div>
      </div>

      {/* Confirm Action Dialog */}
      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.type === 'delete' ? 'Delete Giveaway' : confirmAction?.type === 'end' ? 'End Giveaway' : 'Cancel Giveaway'}
        description={
          confirmAction?.type === 'delete'
            ? `Permanently delete the "${confirmAction?.prize}" giveaway and all its entries?`
            : confirmAction?.type === 'end'
              ? `End the "${confirmAction?.prize}" giveaway now and pick winners?`
              : `Cancel the "${confirmAction?.prize}" giveaway? No winners will be selected.`
        }
        confirmLabel={confirmAction?.type === 'delete' ? 'Delete' : confirmAction?.type === 'end' ? 'End Now' : 'Cancel Giveaway'}
        variant={confirmAction?.type === 'delete' ? 'danger' : 'warning'}
        onConfirm={async () => {
          if (confirmAction) {
            if (confirmAction.type === 'end') await endGiveaway(confirmAction.id);
            else if (confirmAction.type === 'cancel') await cancelGiveaway(confirmAction.id);
            else await deleteGiveaway(confirmAction.id);
            setConfirmAction(null);
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
