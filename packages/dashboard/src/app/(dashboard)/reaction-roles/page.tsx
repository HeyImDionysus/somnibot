/**
 * Reaction Roles — Configure emoji-to-role mappings for messages.
 *
 * Architecture doc §23
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { parseReactionRoleMessageReference } from '@/lib/community/reaction-role-message-reference';

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

interface ReactionRoleDefaults {
  reaction_roles_enabled: boolean;
  default_style: 'buttons' | 'reaction' | 'select-menu';
  default_max_per_group: number;
  default_require_level: number;
  default_remove_on_unreact: boolean;
}

interface MessageTarget {
  readonly key: string;
  readonly channelId: string;
  readonly messageId: string;
}

const initialDefaults: ReactionRoleDefaults = {
  reaction_roles_enabled: true,
  default_style: 'buttons',
  default_max_per_group: 0,
  default_require_level: 0,
  default_remove_on_unreact: true,
};

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

function messageTargetFor(role: ReactionRole): MessageTarget {
  return {
    key: `${role.channel_id}:${role.message_id}`,
    channelId: role.channel_id,
    messageId: role.message_id,
  };
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
  const [defaults, setDefaults] = useState<ReactionRoleDefaults>(initialDefaults);
  const [savedDefaults, setSavedDefaults] = useState<ReactionRoleDefaults>(initialDefaults);
  const [messageLink, setMessageLink] = useState('');
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [mappingReadback, setMappingReadback] = useState<MessageTarget | null>(null);


  const fetchRoles = useCallback(async (): Promise<ReactionRole[] | null> => {
    try {
      const [res, guildRes] = await Promise.all([fetch('/api/reaction-roles'), fetch('/api/guild')]);
      const json = await res.json();
      if (json.success) setRoles(json.data);
      else {
        setError(json.error);
        return null;
      }
      const guildJson = await guildRes.json();
      if (guildJson.success) {
        const nextDefaults: ReactionRoleDefaults = {
          reaction_roles_enabled: guildJson.config?.reaction_roles_enabled ?? initialDefaults.reaction_roles_enabled,
          default_style: guildJson.config?.default_style ?? initialDefaults.default_style,
          default_max_per_group: guildJson.config?.default_max_per_group ?? initialDefaults.default_max_per_group,
          default_require_level: guildJson.config?.default_require_level ?? initialDefaults.default_require_level,
          default_remove_on_unreact: guildJson.config?.default_remove_on_unreact ?? initialDefaults.default_remove_on_unreact,
        };
        setDefaults(nextDefaults);
        setSavedDefaults(nextDefaults);
        return json.data as ReactionRole[];
      }
      setError(guildJson.error ?? 'Failed to load reaction role defaults');
      return null;
    } catch {
      setError('Failed to load reaction roles');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  useAutoRefresh('reaction_role_panels', undefined, fetchRoles);

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
      setSelectedTargetKey(messageTargetFor(rr).key);
      setMessageLink('');
    } else {
      setEditingId(null);
      setForm({ ...emptyForm, remove_on_unreact: defaults.default_remove_on_unreact, max_per_group: defaults.default_max_per_group ? String(defaults.default_max_per_group) : '', require_level: defaults.default_require_level ? String(defaults.default_require_level) : '' });
      setSelectedTargetKey('');
      setMessageLink('');
    }
    setShowForm(true);
  };

  const save = async () => {
    setError(null);
    const selectedTarget = knownTargets.find((target) => target.key === selectedTargetKey);
    const linkedTarget = parseReactionRoleMessageReference(messageLink);
    const target = selectedTarget ?? (linkedTarget.kind === 'valid'
      ? { key: `${linkedTarget.channelId}:${linkedTarget.messageId}`, channelId: linkedTarget.channelId, messageId: linkedTarget.messageId }
      : null);

    if (!form.channel_id || !target || !form.emoji || !form.role_id) {
      setError('Choose a channel, select an existing Discord message, an emoji, and a role.');
      return;
    }
    if (target.channelId !== form.channel_id) {
      setError('The selected message belongs to a different channel. Choose that channel or copy a message link from the selected channel.');
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      channel_id: form.channel_id,
      message_id: target.messageId,
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
        const readback = await fetchRoles();
        const mappingReadBack = readback?.some((role) => role.id === json.data.id) ?? false;
        if (mappingReadBack) {
          setMappingReadback({
            key: `${json.data.channel_id}:${json.data.message_id}`,
            channelId: json.data.channel_id,
            messageId: json.data.message_id,
          });
        }
        setShowForm(false);
        toast({
          title: mappingReadBack
            ? editingId ? 'Reaction role updated and read back' : 'Reaction role saved and read back'
            : 'Reaction role saved; server readback is unavailable',
          variant: mappingReadBack ? 'success' : 'error',
        });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save reaction role');
    }
  };

  const saveDefaults = async () => {
    const patch = Object.fromEntries(
      Object.entries(defaults).filter(([key, value]) => savedDefaults[key as keyof ReactionRoleDefaults] !== value),
    );
    if (Object.keys(patch).length === 0) return;

    const res = await fetch('/api/guild', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!res.ok) {
      toast({ title: 'Failed to save defaults', variant: 'error' });
      return;
    }
    const readbackLoaded = (await fetchRoles()) !== null;
    toast({
      title: readbackLoaded
        ? 'Defaults saved and read back from this server'
        : 'Defaults saved; server readback is unavailable',
      variant: readbackLoaded ? 'success' : 'error',
    });
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
  const knownTargets = Object.values(groupedByMessage).map((mappings) => messageTargetFor(mappings[0]));
  const selectedTarget = knownTargets.find((target) => target.key === selectedTargetKey) ?? null;
  const linkedTarget = parseReactionRoleMessageReference(messageLink);
  const previewTarget = selectedTarget ?? (linkedTarget.kind === 'valid'
    ? { key: `${linkedTarget.channelId}:${linkedTarget.messageId}`, channelId: linkedTarget.channelId, messageId: linkedTarget.messageId }
    : null);
  const defaultsDirty = Object.entries(defaults).some(
    ([key, value]) => savedDefaults[key as keyof ReactionRoleDefaults] !== value,
  );

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

      <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3" aria-labelledby="reaction-role-defaults-heading">
        <div>
          <h2 id="reaction-role-defaults-heading" className="text-sm font-medium text-discord-text-primary">Defaults for new mappings</h2>
          <p className="text-xs text-discord-text-muted">Changes stay staged here until you save them. Saving reads the server configuration back before this page reports success.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-discord-text-primary"><input type="checkbox" checked={defaults.reaction_roles_enabled} onChange={(e) => setDefaults({ ...defaults, reaction_roles_enabled: e.target.checked })} /> Enable reaction roles</label>
        <div className="flex flex-wrap gap-3 text-sm text-discord-text-primary">
          <label>Default style <select value={defaults.default_style} onChange={(e) => setDefaults({ ...defaults, default_style: e.target.value as ReactionRoleDefaults['default_style'] })} className="ml-2 rounded bg-discord-bg-tertiary px-2 py-1"><option value="buttons">Buttons</option><option value="reaction">Reaction</option><option value="select-menu">Select menu</option></select></label>
          <label>Max per group <input type="number" min={0} max={25} value={defaults.default_max_per_group} onChange={(e) => setDefaults({ ...defaults, default_max_per_group: Number(e.target.value) })} className="ml-2 w-16 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
          <label>Required level <input type="number" min={0} max={1000} value={defaults.default_require_level} onChange={(e) => setDefaults({ ...defaults, default_require_level: Number(e.target.value) })} className="ml-2 w-16 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
        </div>
        {defaultsDirty && <div className="flex gap-2"><button onClick={saveDefaults} className="rounded-input bg-discord-accent px-3 py-2 text-sm font-medium text-white">Save defaults</button><button onClick={() => setDefaults(savedDefaults)} className="rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-secondary">Cancel defaults</button></div>}
      </section>

      {mappingReadback && (
        <section className="rounded-card border border-discord-success/40 bg-discord-success/10 p-4" aria-live="polite">
          <p className="text-sm font-medium text-discord-text-primary">Saved mapping read back</p>
          <p className="text-xs text-discord-text-secondary">Role message in <RRChannelName id={mappingReadback.channelId} /> is saved. Test member behavior by reacting to that message in Discord; this dashboard cannot perform a member reaction on your behalf.</p>
        </section>
      )}

      {/* ── Editor Modal ───────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Reaction Role' : 'New Reaction Role'}
            </h2>
            <div className="space-y-4">
              <div className="space-y-3 rounded-input border border-discord-border-subtle bg-discord-bg-primary/30 p-3">
                <ChannelPicker
                  label="Channel *"
                  value={form.channel_id || null}
                  onChange={(v) => setForm({ ...form, channel_id: (v as string) ?? '' })}
                  placeholder="Select the channel that contains the role message…"
                  channelTypes={['text', 'announcement']}
                />
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted" htmlFor="existing-role-message">Existing role message</label>
                  <select id="existing-role-message" value={selectedTargetKey} onChange={(event) => {
                    const nextTarget = knownTargets.find((target) => target.key === event.target.value);
                    setSelectedTargetKey(event.target.value);
                    setMessageLink('');
                    if (nextTarget) setForm({ ...form, channel_id: nextTarget.channelId, message_id: nextTarget.messageId });
                  }} className="w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary">
                    <option value="">Choose a previously configured role message, or paste a Discord message link below</option>
                    {knownTargets.map((target) => <option key={target.key} value={target.key}>Role message in {target.channelId === form.channel_id ? 'this channel' : 'another channel'}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted" htmlFor="discord-message-link">Discord message link *</label>
                  <input id="discord-message-link" type="url" value={messageLink} onChange={(event) => {
                    setSelectedTargetKey('');
                    setMessageLink(event.target.value);
                  }} placeholder="Right-click the existing message in Discord → Copy Message Link"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  <p className="mt-1 text-xs text-discord-text-muted">The link identifies the existing message without requiring you to find a raw Message ID. SomniBot does not read arbitrary message contents from the dashboard.</p>
                </div>
                {previewTarget && (
                  <div className={`rounded-input border px-3 py-2 text-xs ${previewTarget.channelId === form.channel_id ? 'border-discord-success/40 bg-discord-success/10 text-discord-text-primary' : 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger'}`}>
                    <p className="font-medium">Role message in <RRChannelName id={previewTarget.channelId} /></p>
                    <p className="mt-1 text-discord-text-muted">Message ID is shown only for diagnostics: <code>{previewTarget.messageId}</code></p>
                    {previewTarget.channelId !== form.channel_id && <p className="mt-1">Choose the message&apos;s channel before saving this mapping.</p>}
                  </div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted" htmlFor="reaction-role-emoji">Emoji *</label>
                  <input id="reaction-role-emoji" type="text" value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="⭐ or custom emoji ID"
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
                {editingId ? 'Save mapping' : 'Save mapping'}
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
            <div className="flex items-start justify-between gap-3 border-b border-discord-border-subtle px-5 py-3">
              <div>
                <p className="text-sm font-medium text-discord-text-primary">Role message in <RRChannelName id={mappings[0].channel_id} /></p>
                <p className="text-xs text-discord-text-muted">Message ID (diagnostic): {mappings[0].message_id}</p>
              </div>
              <button onClick={async () => {
                const readback = await fetchRoles();
                if (readback?.some((role) => role.id === mappings[0].id)) {
                  setMappingReadback(messageTargetFor(mappings[0]));
                  toast({ title: 'Saved mapping read back from the server', variant: 'success' });
                } else {
                  toast({ title: 'Saved mapping readback is unavailable', variant: 'error' });
                }
              }} className="rounded-input border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary">
                Read saved mapping
              </button>
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
