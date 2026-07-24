/**
 * Temp Channels — Hub-based temporary voice channel configuration.
 *
 * Architecture doc §25
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface TempChannelHub {
  id: string;
  guild_id: string;
  hub_channel_id: string;
  category_id: string;
  naming_format: string;
  default_user_limit: number;
  default_bitrate: number;
  keep_alive_minutes: number;
  empty_grace_seconds: number;
  allow_text_channel: boolean;
  allow_claim: boolean;
  moderator_roles: string[];
  active: boolean;
  created_at: string;
}

const emptyForm = {
  hub_channel_id: '',
  category_id: '',
  naming_format: "{owner-name}'s room",
  default_user_limit: '0',
  default_bitrate: '64000',
  keep_alive_minutes: '1',
  empty_grace_seconds: '15',
  allow_text_channel: false,
  allow_claim: true,
  moderator_roles: '',
};

// ── Name display helper ───────────────────────────────────

function TCChannelName({ id }: { id: string }) {
  const { resolveChannel } = useDiscordNames({ channelIds: [id] });
  return <span>{resolveChannel(id)}</span>;
}

// ── Main Component ────────────────────────────────────────

export default function TempChannelsPage() {
  const { toast } = useToast();

  const [hubs, setHubs] = useState<TempChannelHub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [featureEnabled, setFeatureEnabled] = useState(true);

  const fetchHubs = useCallback(async () => {
    try {
      const [hubsRes, guildRes] = await Promise.all([
        fetch('/api/temp-channels'),
        fetch('/api/guild'),
      ]);
      const json = await hubsRes.json();
      if (json.success) setHubs(json.data);
      else setError(json.error);
      const guildJson = await guildRes.json();
      if (guildJson.success) {
        setFeatureEnabled(guildJson.config?.temp_channels_enabled ?? true);
      }
    } catch {
      setError('Failed to load temp channel hubs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHubs();
  }, [fetchHubs]);

  useAutoRefresh('temp_channel_hubs', undefined, fetchHubs);

  const toggleFeature = async () => {
    const newValue = !featureEnabled;
    setFeatureEnabled(newValue);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temp_channels_enabled: newValue }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeatureEnabled(!newValue);
        toast({ title: 'Failed to toggle temp channels', variant: 'error' });
      } else {
        toast({ title: newValue ? 'Temp channels enabled' : 'Temp channels disabled', variant: 'success' });
      }
    } catch {
      setFeatureEnabled(!newValue);
    }
  };

  const openEditor = (hub?: TempChannelHub) => {
    if (hub) {
      setEditingId(hub.id);
      setForm({
        hub_channel_id: hub.hub_channel_id,
        category_id: hub.category_id,
        naming_format: hub.naming_format,
        default_user_limit: String(hub.default_user_limit),
        default_bitrate: String(hub.default_bitrate),
        keep_alive_minutes: String(hub.keep_alive_minutes),
        empty_grace_seconds: String(hub.empty_grace_seconds ?? 15),
        allow_text_channel: hub.allow_text_channel,
        allow_claim: hub.allow_claim ?? true,
        moderator_roles: hub.moderator_roles.join(', '),
      });
    } else {
      setEditingId(null);
      setForm({ ...emptyForm });
    }
    setShowForm(true);
  };

  const save = async () => {
    setError(null);
    if (!form.hub_channel_id || !form.category_id) {
      setError('Hub Channel ID and Category ID are required');
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      hub_channel_id: form.hub_channel_id,
      category_id: form.category_id,
      naming_format: form.naming_format || "{owner-name}'s room",
      default_user_limit: parseInt(form.default_user_limit, 10) || 0,
      default_bitrate: parseInt(form.default_bitrate, 10) || 64000,
      keep_alive_minutes: parseInt(form.keep_alive_minutes, 10) || 1,
      empty_grace_seconds: Number.isFinite(parseInt(form.empty_grace_seconds, 10)) ? parseInt(form.empty_grace_seconds, 10) : 15,
      allow_text_channel: form.allow_text_channel,
      allow_claim: form.allow_claim,
      moderator_roles: form.moderator_roles ? form.moderator_roles.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };

    try {
      const res = await fetch('/api/temp-channels', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setHubs(hubs.map((h) => (h.id === editingId ? json.data : h)));
        } else {
          setHubs([...hubs, json.data]);
        }
        setShowForm(false);
        toast({ title: editingId ? 'Hub updated' : 'Hub created', variant: 'success' });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save hub');
    }
  };

  const toggleActive = async (hub: TempChannelHub) => {
    try {
      const res = await fetch('/api/temp-channels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hub.id, active: !hub.active }),
      });
      const json = await res.json();
      if (json.success) {
        setHubs(hubs.map((h) => (h.id === hub.id ? json.data : h)));
      }
    } catch {
      setError('Failed to toggle hub');
    }
  };

  const deleteHub = async (id: string) => {
    try {
      const res = await fetch(`/api/temp-channels?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setHubs(hubs.filter((h) => h.id !== id));
        toast({ title: 'Hub deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete hub');
    }
  };

  const bitrateLabel = (br: number) => `${Math.round(br / 1000)} kbps`;

  if (loading) {
    return <ConfigSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-discord-text-primary">Temporary Voice Channels</h1>
            <p className="text-sm text-discord-text-muted">Members join a hub → bot creates a personal voice channel → deleted when empty</p>
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
          onClick={() => openEditor()}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard"
        >
          + Add Hub
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
              {editingId ? 'Edit Hub' : 'New Hub'}
            </h2>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <ChannelPicker
                    label="Hub Voice Channel *"
                    value={form.hub_channel_id || null}
                    onChange={(v) => setForm({ ...form, hub_channel_id: (v as string) ?? '' })}
                    placeholder="Select voice channel…"
                    channelTypes={['voice']}
                  />
                </div>
                <div>
                  <ChannelPicker
                    label="Category *"
                    value={form.category_id || null}
                    onChange={(v) => setForm({ ...form, category_id: (v as string) ?? '' })}
                    placeholder="Select category…"
                    channelTypes={['category']}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Naming Format</label>
                <input type="text" value={form.naming_format} onChange={(e) => setForm({ ...form, naming_format: e.target.value })}
                  placeholder="{owner-name}'s room"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                <p className="mt-1 text-xs text-discord-text-muted">Variables: {'{owner-name}'}, {'{username}'}, {'{user}'}, {'{tag}'}, {'{count}'}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">User Limit</label>
                  <input type="number" value={form.default_user_limit} onChange={(e) => setForm({ ...form, default_user_limit: e.target.value })}
                    min="0" max="99" placeholder="0 = unlimited"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Bitrate</label>
                  <select value={form.default_bitrate} onChange={(e) => setForm({ ...form, default_bitrate: e.target.value })}
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none">
                    <option value="8000">8 kbps</option>
                    <option value="32000">32 kbps</option>
                    <option value="64000">64 kbps</option>
                    <option value="96000">96 kbps</option>
                    <option value="128000">128 kbps</option>
                    <option value="256000">256 kbps</option>
                    <option value="384000">384 kbps</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Empty grace (sec)</label>
                  <input type="number" value={form.empty_grace_seconds} onChange={(e) => setForm({ ...form, empty_grace_seconds: e.target.value })}
                    min="0" max="3600"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
              <div>
                <RolePicker
                  label="Moderator Roles"
                  value={form.moderator_roles ? form.moderator_roles.split(',').map(s => s.trim()).filter(Boolean) : []}
                  onChange={(v) => setForm({ ...form, moderator_roles: (v as string[] ?? []).join(', ') })}
                  multi
                  placeholder="Roles that can control any temp channel"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                <input type="checkbox" checked={form.allow_text_channel} onChange={(e) => setForm({ ...form, allow_text_channel: e.target.checked })} className="rounded" />
                Create paired text channel
              </label>
              <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                <input type="checkbox" checked={form.allow_claim} onChange={(e) => setForm({ ...form, allow_claim: e.target.checked })} className="rounded" />
                Allow members to claim an abandoned channel (/voice claim)
              </label>
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

      {/* ── Hub List ─────────────────────────────────── */}
      {hubs.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🔊</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Temp Channel Hubs</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create a hub to let members generate personal voice channels by joining a designated voice channel.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Hub
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {hubs.map((hub) => (
            <div key={hub.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">🔊</span>
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary">Hub: <TCChannelName id={hub.hub_channel_id} /></p>
                      <p className="text-xs text-discord-text-muted">
                        Category: <TCChannelName id={hub.category_id} /> · Format: <code className="bg-discord-bg-tertiary px-1 rounded">{hub.naming_format}</code>
                      </p>
                      <p className="text-xs text-discord-text-muted mt-0.5">
                        {bitrateLabel(hub.default_bitrate)} · {hub.default_user_limit === 0 ? 'No limit' : `${hub.default_user_limit} users`} · Grace: {hub.empty_grace_seconds ?? (hub.keep_alive_minutes * 60)}s
                        {hub.allow_text_channel ? ' · +Text' : ''}{hub.allow_claim === false ? ' · No claim' : ''}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <div
                    className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${hub.active ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                    onClick={() => toggleActive(hub)}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${hub.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <button onClick={() => openEditor(hub)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                    Edit
                  </button>
                  <button onClick={() => setConfirmDelete(hub.id)} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Owner Commands Reference ─────────────────── */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-3">Voice Commands (for channel owners)</h3>
        <div className="grid gap-2 text-xs text-discord-text-muted sm:grid-cols-2">
          <div><code className="text-discord-accent">/voice lock</code> — Lock the channel</div>
          <div><code className="text-discord-accent">/voice unlock</code> — Unlock the channel</div>
          <div><code className="text-discord-accent">/voice limit</code> — Set user limit</div>
          <div><code className="text-discord-accent">/voice name</code> — Rename the channel</div>
          <div><code className="text-discord-accent">/voice permit @user</code> — Allow a user in</div>
          <div><code className="text-discord-accent">/voice deny @user</code> — Remove access</div>
          <div><code className="text-discord-accent">/voice ban @user</code> — Kick + deny</div>
          <div><code className="text-discord-accent">/voice claim</code> — Claim ownership</div>
        </div>
      </div>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Hub"
        description="Delete this temp channel hub? New members joining the hub voice channel will no longer get personal channels."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteHub(confirmDelete);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
