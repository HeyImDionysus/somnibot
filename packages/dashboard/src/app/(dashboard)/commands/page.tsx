/**
 * Custom Commands — CRUD + action builder for custom slash commands.
 *
 * Architecture doc §21
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface CommandAction {
  type: 'send_message' | 'send_embed' | 'give_role' | 'remove_role' | 'send_dm';
  message?: string;
  channelId?: string;
  roleId?: string;
  embedConfig?: {
    title?: string;
    description?: string;
    color?: number;
  };
}

interface CustomCommand {
  id: string;
  guild_id: string;
  name: string;
  description: string;
  actions: CommandAction[];
  allowed_roles: string[];
  allowed_channels: string[];
  denied_roles: string[];
  denied_channels: string[];
  cooldown_seconds: number;
  ephemeral: boolean;
  enabled: boolean;
  discord_command_id: string | null;
  created_at: string;
  updated_at: string;
}

const ACTION_META: Record<string, { label: string; icon: string }> = {
  send_message: { label: 'Send Message', icon: '💬' },
  send_embed: { label: 'Send Embed', icon: '📋' },
  give_role: { label: 'Give Role', icon: '🏷️' },
  remove_role: { label: 'Remove Role', icon: '🏷️' },
  send_dm: { label: 'Send DM', icon: '📩' },
};

const emptyDraft = {
  name: '',
  description: '',
  actions: [] as CommandAction[],
  allowed_roles: '',
  allowed_channels: '',
  denied_roles: '',
  denied_channels: '',
  cooldown_seconds: 0,
  ephemeral: false,
};

// ── Main Component ────────────────────────────────────────

export default function CustomCommandsPage() {
  const { toast } = useToast();

  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [search, setSearch] = useState('');


  const fetchCommands = useCallback(async () => {
    try {
      const res = await fetch('/api/custom-commands');
      const json = await res.json();
      if (json.success) setCommands(json.data);
      else setError(json.error);
    } catch {
      setError('Failed to load commands');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCommands();
  }, [fetchCommands]);

  useAutoRefresh('custom_commands', undefined, fetchCommands);

  const openEditor = (cmd?: CustomCommand) => {
    if (cmd) {
      setEditingId(cmd.id);
      setDraft({
        name: cmd.name,
        description: cmd.description,
        actions: cmd.actions,
        allowed_roles: cmd.allowed_roles.join(', '),
        allowed_channels: cmd.allowed_channels.join(', '),
        denied_roles: cmd.denied_roles.join(', '),
        denied_channels: cmd.denied_channels.join(', '),
        cooldown_seconds: cmd.cooldown_seconds,
        ephemeral: cmd.ephemeral,
      });
    } else {
      setEditingId(null);
      setDraft({ ...emptyDraft, actions: [] });
    }
    setShowEditor(true);
  };

  const addAction = (type: CommandAction['type']) => {
    setDraft({ ...draft, actions: [...draft.actions, { type }] });
  };

  const updateAction = (index: number, updates: Partial<CommandAction>) => {
    const newActions = [...draft.actions];
    newActions[index] = { ...newActions[index], ...updates };
    setDraft({ ...draft, actions: newActions });
  };

  const removeAction = (index: number) => {
    setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) });
  };

  const parseCsv = (str: string): string[] =>
    str.split(',').map((s) => s.trim()).filter(Boolean);

  const save = async () => {
    setError(null);
    if (!draft.name) {
      setError('Command name is required');
      return;
    }
    if (draft.actions.length === 0) {
      setError('At least one action is required');
      return;
    }
    if (draft.actions.length > 5) {
      setError('Maximum 5 actions per command');
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      name: draft.name.toLowerCase().replace(/\s+/g, '-'),
      description: draft.description || `Custom command: ${draft.name}`,
      actions: draft.actions,
      allowed_roles: parseCsv(draft.allowed_roles),
      allowed_channels: parseCsv(draft.allowed_channels),
      denied_roles: parseCsv(draft.denied_roles),
      denied_channels: parseCsv(draft.denied_channels),
      cooldown_seconds: draft.cooldown_seconds,
      ephemeral: draft.ephemeral,
    };

    try {
      const res = await fetch('/api/custom-commands', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setCommands(commands.map((c) => (c.id === editingId ? json.data : c)));
        } else {
          setCommands([...commands, json.data]);
        }
        setShowEditor(false);
        toast({ title: editingId ? 'Command updated' : 'Command created', variant: 'success' });
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save command');
    }
  };

  const toggleEnabled = async (cmd: CustomCommand) => {
    try {
      const res = await fetch('/api/custom-commands', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cmd.id, enabled: !cmd.enabled }),
      });
      const json = await res.json();
      if (json.success) {
        setCommands(commands.map((c) => (c.id === cmd.id ? json.data : c)));
      }
    } catch {
      setError('Failed to toggle command');
    }
  };

  const deleteCommand = async (id: string) => {
    try {
      const res = await fetch(`/api/custom-commands?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setCommands(commands.filter((c) => c.id !== id));
        toast({ title: 'Command deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete command');
    }
  };

  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Custom Commands</h1>
          <p className="text-sm text-discord-text-muted">Create custom slash commands with variable support and role restrictions</p>
        </div>
        <button
          onClick={() => openEditor()}
          disabled={commands.length >= 25}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard disabled:opacity-50"
        >
          + New Command
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      {/* ── Editor Modal ───────────────────────────────── */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 pt-12 pb-12">
          <div className="w-full max-w-2xl rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Command' : 'New Command'}
            </h2>
            <div className="space-y-4">
              {/* Basic Info */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Command Name *</label>
                  <div className="flex items-center gap-1">
                    <span className="text-discord-text-muted text-sm">/</span>
                    <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="command-name"
                      className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Description</label>
                  <input type="text" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What does this command do?"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>

              {/* Settings Row */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Cooldown (seconds)</label>
                  <input type="number" min={0} value={draft.cooldown_seconds} onChange={(e) => setDraft({ ...draft, cooldown_seconds: Number(e.target.value) })}
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-discord-text-secondary cursor-pointer">
                    <input type="checkbox" checked={draft.ephemeral} onChange={(e) => setDraft({ ...draft, ephemeral: e.target.checked })} className="rounded" />
                    Ephemeral (only visible to user)
                  </label>
                </div>
              </div>

              {/* Restrictions */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <RolePicker
                    label="Allowed Roles"
                    hint="Leave empty to allow all"
                    value={draft.allowed_roles ? draft.allowed_roles.split(',').map(s => s.trim()).filter(Boolean) : []}
                    onChange={(v) => setDraft({ ...draft, allowed_roles: (v as string[] ?? []).join(', ') })}
                    multi
                    placeholder="All roles allowed"
                  />
                </div>
                <div>
                  <RolePicker
                    label="Denied Roles"
                    value={draft.denied_roles ? draft.denied_roles.split(',').map(s => s.trim()).filter(Boolean) : []}
                    onChange={(v) => setDraft({ ...draft, denied_roles: (v as string[] ?? []).join(', ') })}
                    multi
                    placeholder="None denied"
                  />
                </div>
              </div>

              {/* Actions */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-discord-text-muted">Actions ({draft.actions.length}/5)</label>
                  {draft.actions.length < 5 && (
                    <div className="flex gap-1">
                      {Object.entries(ACTION_META).map(([type, meta]) => (
                        <button
                          key={type}
                          onClick={() => addAction(type as CommandAction['type'])}
                          className="rounded-input bg-discord-bg-tertiary px-2 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard"
                          title={meta.label}
                        >
                          {meta.icon}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {draft.actions.length === 0 && (
                  <div className="rounded-input bg-discord-bg-tertiary p-4 text-center text-xs text-discord-text-muted">
                    Add at least one action using the buttons above
                  </div>
                )}
                <div className="space-y-2">
                  {draft.actions.map((action, i) => {
                    const meta = ACTION_META[action.type];
                    return (
                      <div key={i} className="rounded-input border border-discord-border-subtle bg-discord-bg-tertiary p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-discord-text-primary">
                            {meta?.icon} {meta?.label ?? action.type}
                          </span>
                          <button onClick={() => removeAction(i)} className="text-discord-danger text-xs hover:text-discord-danger/80">
                            Remove
                          </button>
                        </div>
                        {(action.type === 'send_message' || action.type === 'send_dm') && (
                          <textarea
                            value={action.message ?? ''}
                            onChange={(e) => updateAction(i, { message: e.target.value })}
                            placeholder="Message content — variables: {user}, {server}, {channel}, {memberCount}"
                            rows={2}
                            className="w-full rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none"
                          />
                        )}
                        {(action.type === 'give_role' || action.type === 'remove_role') && (
                          <RolePicker
                            value={action.roleId || null}
                            onChange={(v) => updateAction(i, { roleId: (v as string) ?? '' })}
                            placeholder="Select role…"
                          />
                        )}
                        {action.type === 'send_embed' && (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={action.embedConfig?.title ?? ''}
                              onChange={(e) => updateAction(i, { embedConfig: { ...action.embedConfig, title: e.target.value } })}
                              placeholder="Embed title"
                              className="w-full rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                            />
                            <textarea
                              value={action.embedConfig?.description ?? ''}
                              onChange={(e) => updateAction(i, { embedConfig: { ...action.embedConfig, description: e.target.value } })}
                              placeholder="Embed description"
                              rows={2}
                              className="w-full rounded-input bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowEditor(false)} className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard">
                Cancel
              </button>
              <button onClick={save} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                {editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Search ────────────────────────────────────── */}
      {commands.length > 0 && (
        <div className="mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commands..."
            className="w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted outline-none focus:border-discord-accent"
          />
        </div>
      )}

      {/* ── Command List ───────────────────────────────── */}
      {commands.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">⌨️</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Custom Commands</h2>
          <p className="text-sm text-discord-text-muted mb-4">Create your first custom slash command to get started.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Command
          </button>
        </div>
      ) : (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary divide-y divide-discord-border-subtle">
          {commands.filter((cmd) => {
            if (!search) return true;
            const q = search.toLowerCase();
            return cmd.name.toLowerCase().includes(q) || cmd.description?.toLowerCase().includes(q);
          }).map((cmd) => (
            <div key={cmd.id} className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-discord-accent/10 text-lg">
                  ⌨️
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-discord-text-primary">/{cmd.name}</p>
                  <p className="truncate text-xs text-discord-text-muted">
                    {cmd.description}
                    {cmd.actions.length > 0 && ` · ${cmd.actions.length} action${cmd.actions.length > 1 ? 's' : ''}`}
                    {cmd.cooldown_seconds > 0 && ` · ${cmd.cooldown_seconds}s cooldown`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${cmd.enabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                  onClick={() => toggleEnabled(cmd)}
                >
                  <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${cmd.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <button onClick={() => openEditor(cmd)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                  Edit
                </button>
                <button onClick={() => setConfirmDelete({ id: cmd.id, name: cmd.name })} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-discord-text-muted text-center">
        {commands.length}/25 commands · Commands are registered as Discord slash commands and sync on bot restart.
      </p>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Command"
        description={`Delete /${confirmDelete?.name}? This will unregister the slash command from Discord.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteCommand(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
