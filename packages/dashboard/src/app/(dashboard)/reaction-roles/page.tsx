/**
 * Reaction Roles — Configure emoji-to-role mappings for messages.
 *
 * Architecture doc §23
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface ReactionRole {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  emoji: string;
  role_id: string;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
  max_per_group: number | null;
  remove_on_unreact: boolean;
  log_actions: boolean;
  active: boolean;
  created_at: string;
}

const emptyForm = {
  channel_id: '',
  message_id: '',
  emoji: '',
  role_id: '',
  exclusive_group: '',
  require_role: '',
  require_level: '',
  max_per_group: '',
  remove_on_unreact: true,
  log_actions: false,
};

// ── Name display helpers ──────────────────────────────────

function RRChannelName({ id }: { id: string }) {
  const { resolveChannel } = useDiscordNames({ channelIds: [id] });
  return <span>{resolveChannel(id)}</span>;
}

function RRRoleName({ id }: { id: string }) {
  const { resolveRole, roleColor } = useDiscordNames({ roleIds: [id] });
  return <span style={{ color: roleColor(id) }}>{resolveRole(id)}</span>;
}

// ── Main Component ────────────────────────────────────────

export default function ReactionRolesPage() {
  const { toast } = useToast();

  const [roles, setRoles] = useState<ReactionRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; emoji: string } | null>(null);
  const [form, setForm] = useState(emptyForm);


  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch('/api/reaction-roles');
      const json = await res.json();
      if (json.success) setRoles(json.data);
      else setError(json.error);
    } catch {
      setError('Failed to load reaction roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  const openEditor = (rr?: ReactionRole) => {
    if (rr) {
      setEditingId(rr.id);
      setForm({
        channel_id: rr.channel_id,
        message_id: rr.message_id,
        emoji: rr.emoji,
        role_id: rr.role_id,
        exclusive_group: rr.exclusive_group ?? '',
        require_role: rr.require_role ?? '',
        require_level: rr.require_level != null ? String(rr.require_level) : '',
        max_per_group: rr.max_per_group != null ? String(rr.max_per_group) : '',
        remove_on_unreact: rr.remove_on_unreact,
        log_actions: rr.log_actions,
      });
    } else {
      setEditingId(null);
      setForm({ ...emptyForm });
    }
    setShowForm(true);
  };

  const save = async () => {
    setError(null);
    if (!form.channel_id || !form.message_id || !form.emoji || !form.role_id) {
      setError('Channel ID, Message ID, Emoji, and Role ID are required');
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      channel_id: form.channel_id,
      message_id: form.message_id,
      emoji: form.emoji,
      role_id: form.role_id,
      exclusive_group: form.exclusive_group || null,
      require_role: form.require_role || null,
      require_level: form.require_level ? parseInt(form.require_level, 10) : null,
      max_per_group: form.max_per_group ? parseInt(form.max_per_group, 10) : null,
      remove_on_unreact: form.remove_on_unreact,
      log_actions: form.log_actions,
    };

    try {
      const res = await fetch('/api/reaction-roles', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setRoles(roles.map((r) => (r.id === editingId ? json.data : r)));
        } else {
          setRoles([...roles, json.data]);
        }
        setShowForm(false);
        toast({ title: editingId ? 'Reaction role updated' : 'Reaction role created', variant: 'success' });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save reaction role');
    }
  };

  const toggleActive = async (rr: ReactionRole) => {
    try {
      const res = await fetch('/api/reaction-roles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rr.id, active: !rr.active }),
      });
      const json = await res.json();
      if (json.success) {
        setRoles(roles.map((r) => (r.id === rr.id ? json.data : r)));
      }
    } catch {
      setError('Failed to toggle reaction role');
    }
  };

  const deleteRole = async (id: string) => {
    try {
      const res = await fetch(`/api/reaction-roles?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setRoles(roles.filter((r) => r.id !== id));
        toast({ title: 'Reaction role deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete reaction role');
    }
  };

  // Group by message_id for display
  const groupedByMessage = roles.reduce<Record<string, ReactionRole[]>>((acc, rr) => {
    const key = `${rr.channel_id}:${rr.message_id}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(rr);
    return acc;
  }, {});

  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Reaction Roles</h1>
          <p className="text-sm text-discord-text-muted">Let members self-assign roles by reacting to messages</p>
        </div>
        <button
          onClick={() => openEditor()}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard"
        >
          + Add Mapping
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      {/* ── Editor Modal ───────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Reaction Role' : 'New Reaction Role'}
            </h2>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <ChannelPicker
                    label="Channel *"
                    value={form.channel_id || null}
                    onChange={(v) => setForm({ ...form, channel_id: (v as string) ?? '' })}
                    placeholder="Select channel…"
                    channelTypes={['text', 'announcement']}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Message ID *</label>
                  <input type="text" value={form.message_id} onChange={(e) => setForm({ ...form, message_id: e.target.value })}
                    placeholder="Right-click message → Copy ID"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Emoji *</label>
                  <input type="text" value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="⭐ or custom emoji ID"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <RolePicker
                    label="Role *"
                    value={form.role_id || null}
                    onChange={(v) => setForm({ ...form, role_id: (v as string) ?? '' })}
                    placeholder="Select role to assign…"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Exclusive Group</label>
                  <input type="text" value={form.exclusive_group} onChange={(e) => setForm({ ...form, exclusive_group: e.target.value })} placeholder="e.g. colors"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <RolePicker
                    label="Required Role"
                    value={form.require_role || null}
                    onChange={(v) => setForm({ ...form, require_role: (v as string) ?? '' })}
                    placeholder="Optional"
                    allowNone
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Required Level</label>
                  <input type="text" value={form.require_level} onChange={(e) => setForm({ ...form, require_level: e.target.value })} placeholder="Min level"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                  <input type="checkbox" checked={form.remove_on_unreact} onChange={(e) => setForm({ ...form, remove_on_unreact: e.target.checked })} className="rounded" />
                  Remove on unreact
                </label>
                <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                  <input type="checkbox" checked={form.log_actions} onChange={(e) => setForm({ ...form, log_actions: e.target.checked })} className="rounded" />
                  Log actions
                </label>
              </div>
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

      {/* ── List ───────────────────────────────────────── */}
      {Object.keys(groupedByMessage).length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🎭</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Reaction Roles</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create your first reaction role mapping to let members self-assign roles.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Mapping
          </button>
        </div>
      ) : (
        Object.entries(groupedByMessage).map(([key, mappings]) => (
          <div key={key} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
            <div className="border-b border-discord-border-subtle px-5 py-3">
              <p className="text-sm font-medium text-discord-text-primary">Message: {mappings[0].message_id}</p>
              <p className="text-xs text-discord-text-muted">Channel: <RRChannelName id={mappings[0].channel_id} /></p>
            </div>
            <div className="divide-y divide-discord-border-subtle">
              {mappings.map((rr) => (
                <div key={rr.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{rr.emoji}</span>
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary"><RRRoleName id={rr.role_id} /></p>
                      <p className="text-xs text-discord-text-muted">
                        {rr.exclusive_group ? `Group: ${rr.exclusive_group}` : 'No group'}
                        {rr.require_level != null ? ` · Min level ${rr.require_level}` : ''}
                        {rr.remove_on_unreact ? ' · Revoke on unreact' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${rr.active ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                      onClick={() => toggleActive(rr)}
                    >
                      <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${rr.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <button onClick={() => openEditor(rr)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                      Edit
                    </button>
                    <button onClick={() => setConfirmDelete({ id: rr.id, emoji: rr.emoji })} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Reaction Role"
        description={`Remove the ${confirmDelete?.emoji} reaction role mapping? Members will no longer receive the role from this reaction.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteRole(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
