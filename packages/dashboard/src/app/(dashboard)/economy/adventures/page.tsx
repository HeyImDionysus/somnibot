/**
 * Economy Adventures Management — adventure CRUD + adventure settings.
 *
 * Admins manage interactive adventures (type, difficulty, scene count)
 * and configure daily limits, ticket costs, max scenes.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Swords, Plus, Pencil, Trash2 } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface Adventure {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  adventure_type: string;
  difficulty: string;
  min_scenes: number;
  max_scenes: number;
  active: boolean;
}

interface AdventureConfig {
  economy_adventures_enabled: boolean;
  economy_adventure_daily_limit: number;
  economy_adventure_ticket_cost: number;
  economy_adventure_max_scenes: number;
}

const DEFAULT_CONFIG: AdventureConfig = {
  economy_adventures_enabled: false,
  economy_adventure_daily_limit: 3,
  economy_adventure_ticket_cost: 100,
  economy_adventure_max_scenes: 10,
};

const TYPES = ['dungeon', 'forest', 'ocean', 'space', 'mountain'] as const;
const DIFFICULTIES = ['easy', 'normal', 'hard', 'legendary'] as const;
const TYPE_EMOJI: Record<string, string> = {
  dungeon: '🏰', forest: '🌲', ocean: '🌊', space: '🚀', mountain: '⛰️',
};

const BLANK_ADVENTURE: Omit<Adventure, 'id'> & { id?: string } = {
  name: '',
  emoji: '⚔️',
  description: '',
  adventure_type: 'dungeon',
  difficulty: 'normal',
  min_scenes: 5,
  max_scenes: 10,
  active: true,
};

// ── Page ──────────────────────────────────────────────────

export default function AdventuresPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<AdventureConfig>(DEFAULT_CONFIG);
  const [adventures, setAdventures] = useState<Adventure[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<Adventure, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, advRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/adventures'),
      ]);
      if (cfgRes.ok) {
        const cfgJson = await cfgRes.json();
        const gc = cfgJson.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (advRes.ok) {
        const aJson = await advRes.json();
        setAdventures(aJson.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load adventures data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<AdventureConfig>) => {
    const merged = { ...config, ...patch };
    setConfig(merged);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Settings saved!', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    }
  };

  const saveAdventure = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/adventures', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error();
      toast({ title: editing.id ? 'Adventure updated!' : 'Adventure created!', variant: 'success' });
      setEditing(null);
      loadData();
    } catch {
      toast({ title: 'Failed to save adventure', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteAdventure = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/adventures?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast({ title: 'Adventure deleted', variant: 'success' });
      setDeleteId(null);
      loadData();
    } catch {
      toast({ title: 'Failed to delete adventure', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-discord-text-primary">⚔️ Adventures</h1>
          <p className="text-sm text-discord-text-secondary">Manage interactive story adventures with scenes and choices.</p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK_ADVENTURE })}
          className="flex items-center gap-2 rounded-md bg-discord-blurple px-3 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80"
        >
          <Plus className="h-4 w-4" /> Add Adventure
        </button>
      </div>

      {/* Config */}
      <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
        <h2 className="text-base font-semibold text-discord-text-primary">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-discord-text-primary">Adventures Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={config.economy_adventures_enabled}
              onClick={() => saveConfig({ economy_adventures_enabled: !config.economy_adventures_enabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                config.economy_adventures_enabled ? 'bg-discord-blurple' : 'bg-discord-bg-tertiary'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                config.economy_adventures_enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Daily Limit</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_adventure_daily_limit}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_adventure_daily_limit: parseInt(e.target.value) || 3 })
              }
              min={1}
              max={50}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Ticket Cost (coins)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_adventure_ticket_cost}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_adventure_ticket_cost: parseInt(e.target.value) || 100 })
              }
              min={0}
              max={1000000}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Max Scenes per Adventure</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_adventure_max_scenes}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_adventure_max_scenes: parseInt(e.target.value) || 10 })
              }
              min={3}
              max={30}
            />
          </label>
        </div>
      </div>

      {/* Adventure List */}
      {adventures.length === 0 ? (
        <EmptyState
          icon={Swords}
          title="No adventures yet"
          description="Create your first adventure to get started."
          action={{ label: 'Create Adventure', onClick: () => setEditing({ ...BLANK_ADVENTURE }) }}
        />
      ) : (
        <div className="space-y-2">
          {adventures.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{a.emoji}</span>
                <div>
                  <p className="font-semibold text-discord-text-primary">{a.name}</p>
                  <p className="text-sm text-discord-text-secondary">
                    {TYPE_EMOJI[a.adventure_type] ?? '❓'} {a.adventure_type} • {a.difficulty} • {a.min_scenes}–{a.max_scenes} scenes
                  </p>
                  {a.description && <p className="text-xs text-discord-text-muted mt-1">{a.description}</p>}
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setEditing(a)} className="rounded p-2 hover:bg-discord-bg-tertiary">
                  <Pencil className="h-4 w-4 text-discord-text-secondary" />
                </button>
                <button onClick={() => setDeleteId(a.id)} className="rounded p-2 hover:bg-discord-bg-tertiary">
                  <Trash2 className="h-4 w-4 text-red-400" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-lg border border-discord-bg-tertiary bg-discord-bg-primary p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-discord-text-primary">
              {editing.id ? 'Edit' : 'New'} Adventure
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Name</span>
                <input
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Emoji</span>
                <input
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.emoji}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, emoji: e.target.value })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-discord-text-secondary">Description</span>
              <textarea
                className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple resize-none"
                value={editing.description ?? ''}
                rows={2}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Type</span>
                <select
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.adventure_type}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, adventure_type: e.target.value })}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{TYPE_EMOJI[t]} {t}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Difficulty</span>
                <select
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.difficulty}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, difficulty: e.target.value })}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>{d.toUpperCase()}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Min Scenes</span>
                <input
                  type="number"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.min_scenes}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, min_scenes: parseInt(e.target.value) || 5 })}
                  min={1}
                  max={30}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Max Scenes</span>
                <input
                  type="number"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={editing.max_scenes}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, max_scenes: parseInt(e.target.value) || 10 })}
                  min={1}
                  max={30}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded-md px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={saveAdventure}
                disabled={saving || !editing.name}
                className="rounded-md bg-discord-blurple px-4 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Adventure"
        description="This will delete this adventure and all its scenes. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAdventure}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
