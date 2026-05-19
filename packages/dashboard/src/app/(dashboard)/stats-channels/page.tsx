/**
 * Stats Channels — Voice channels that display live server statistics.
 *
 * Architecture doc §26
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface StatsChannel {
  id: string;
  guild_id: string;
  channel_id: string | null;
  stat_type: string;
  stat_config: Record<string, unknown>;
  name_format: string;
  active: boolean;
  last_value: string | null;
  last_updated_at: string | null;
  created_at: string;
}

const STAT_TYPES: Record<string, { label: string; icon: string; defaultFormat: string }> = {
  total_members: { label: 'Total Members', icon: '👥', defaultFormat: '👥 Members: {value}' },
  online_members: { label: 'Online Members', icon: '🟢', defaultFormat: '🟢 Online: {value}' },
  bot_count: { label: 'Bot Count', icon: '🤖', defaultFormat: '🤖 Bots: {value}' },
  role_count: { label: 'Role Count', icon: '🏷️', defaultFormat: '🏷️ Roles: {value}' },
  channel_count: { label: 'Channel Count', icon: '📂', defaultFormat: '📂 Channels: {value}' },
  premium_members: { label: 'Boosters', icon: '💎', defaultFormat: '💎 Boosts: {value}' },
  active_tickets: { label: 'Open Tickets', icon: '🎫', defaultFormat: '🎫 Tickets: {value}' },
  total_xp_earned: { label: 'Total XP Earned', icon: '✨', defaultFormat: '✨ Total XP: {value}' },
  highest_level: { label: 'Highest Level', icon: '🏆', defaultFormat: '🏆 Top Level: {value}' },
  custom_counter: { label: 'Custom Counter', icon: '🔢', defaultFormat: '🔢 Count: {value}' },
};

const emptyForm = {
  stat_type: 'total_members',
  name_format: '👥 Members: {value}',
  category_id: '',
  custom_value: '',
};

// ── Main Component ────────────────────────────────────────

export default function StatsChannelsPage() {
  const { toast } = useToast();

  const [channels, setChannels] = useState<StatsChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  const [form, setForm] = useState(emptyForm);


  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/stats-channels');
      const json = await res.json();
      if (json.success) setChannels(json.data);
      else setError(json.error);
    } catch {
      setError('Failed to load stats channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const openEditor = (sc?: StatsChannel) => {
    if (sc) {
      setEditingId(sc.id);
      const cfg = sc.stat_config as Record<string, string> | undefined;
      setForm({
        stat_type: sc.stat_type,
        name_format: sc.name_format,
        category_id: cfg?.category_id ?? '',
        custom_value: cfg?.value ?? '',
      });
    } else {
      setEditingId(null);
      setForm({ ...emptyForm });
    }
    setShowForm(true);
  };

  const handleStatTypeChange = (type: string) => {
    const meta = STAT_TYPES[type];
    setForm({
      ...form,
      stat_type: type,
      name_format: meta?.defaultFormat ?? form.name_format,
    });
  };

  const save = async () => {
    setError(null);
    if (!form.stat_type || !form.name_format) {
      setError('Stat type and name format are required');
      return;
    }

    const stat_config: Record<string, unknown> = {};
    if (form.category_id) stat_config.category_id = form.category_id;
    if (form.stat_type === 'custom_counter' && form.custom_value) {
      stat_config.value = form.custom_value;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      stat_type: form.stat_type,
      name_format: form.name_format,
      stat_config,
    };

    try {
      const res = await fetch('/api/stats-channels', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setChannels(channels.map((c) => (c.id === editingId ? json.data : c)));
        } else {
          setChannels([...channels, json.data]);
        }
        setShowForm(false);
        toast({ title: editingId ? 'Stats channel updated' : 'Stats channel created', variant: 'success' });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save stats channel');
    }
  };

  const toggleActive = async (sc: StatsChannel) => {
    try {
      const res = await fetch('/api/stats-channels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sc.id, active: !sc.active }),
      });
      const json = await res.json();
      if (json.success) {
        setChannels(channels.map((c) => (c.id === sc.id ? json.data : c)));
      }
    } catch {
      setError('Failed to toggle stats channel');
    }
  };

  const deleteChannel = async (id: string) => {
    try {
      const res = await fetch(`/api/stats-channels?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setChannels(channels.filter((c) => c.id !== id));
        toast({ title: 'Stats channel deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete stats channel');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-discord-text-muted">Loading stats channels…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Statistics Channels</h1>
          <p className="text-sm text-discord-text-muted">Voice channels that display live server stats (updated every 10 minutes)</p>
        </div>
        <button
          onClick={() => openEditor()}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard"
        >
          + Add Stats Channel
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      {/* ── Editor Modal ─────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Stats Channel' : 'New Stats Channel'}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Stat Type *</label>
                <select value={form.stat_type} onChange={(e) => handleStatTypeChange(e.target.value)}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none">
                  {Object.entries(STAT_TYPES).map(([key, meta]) => (
                    <option key={key} value={key}>{meta.icon} {meta.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Channel Name Format *</label>
                <input type="text" value={form.name_format} onChange={(e) => setForm({ ...form, name_format: e.target.value })}
                  placeholder="👥 Members: {value}"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                <p className="mt-1 text-xs text-discord-text-muted">Use {'{value}'} or {'{count}'} where the number should appear</p>
              </div>
              <div>
                <ChannelPicker
                  label="Category (optional)"
                  value={form.category_id || null}
                  onChange={(v) => setForm({ ...form, category_id: (v as string) ?? '' })}
                  placeholder="Place channel in this category"
                  channelTypes={['category']}
                  allowNone
                />
              </div>
              {form.stat_type === 'custom_counter' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Custom Value</label>
                  <input type="text" value={form.custom_value} onChange={(e) => setForm({ ...form, custom_value: e.target.value })}
                    placeholder="Static value to display"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard">
                Cancel
              </button>
              <button onClick={save} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                {editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Channel List ─────────────────────────────── */}
      {channels.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">📊</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Stats Channels</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create stats channels to display live server metrics as voice channel names.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Stats Channel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((sc) => {
            const meta = STAT_TYPES[sc.stat_type];
            return (
              <div key={sc.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
                <div className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{meta?.icon ?? '📊'}</span>
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary">{meta?.label ?? sc.stat_type}</p>
                      <p className="text-xs text-discord-text-muted">
                        Format: <code className="bg-discord-bg-tertiary px-1 rounded">{sc.name_format}</code>
                      </p>
                      <p className="text-xs text-discord-text-muted mt-0.5">
                        Current: {sc.last_value ?? 'Not yet updated'}
                        {sc.last_updated_at ? ` · Updated: ${new Date(sc.last_updated_at).toLocaleString()}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${sc.active ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                      onClick={() => toggleActive(sc)}
                    >
                      <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${sc.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <button onClick={() => openEditor(sc)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                      Edit
                    </button>
                    <button onClick={() => setConfirmDelete({ id: sc.id, label: meta?.label ?? sc.stat_type })} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Stats Channel"
        description={`Delete the "${confirmDelete?.label}" stats channel? The voice channel will be removed from Discord.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteChannel(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
