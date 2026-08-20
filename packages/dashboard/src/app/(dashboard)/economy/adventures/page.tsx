/**
 * Economy Adventures Management — adventure CRUD + adventure settings.
 *
 * Admins manage interactive adventures (type, difficulty, scene count)
 * and configure daily limits, ticket costs, max scenes.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Swords, Plus, Pencil, Trash2 } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

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
  scenes: AdventureScene[];
}

interface AdventureLoot {
  item_id?: string;
  item_name: string;
  qty: number;
  chance_pct: number;
}

interface AdventureChoice {
  label: string;
  emoji: string;
  next_scene_index: number | null;
  loot: AdventureLoot[];
  currency: number;
  damage_pct: number;
  requires_item: string | null;
}

interface AdventureScene {
  text: string;
  image_url: string | null;
  choices: AdventureChoice[];
  loot: AdventureLoot[];
  is_ending: boolean;
  ending_type: 'success' | 'death' | 'partial' | null;
}

interface EconomyItem {
  id: string;
  name: string;
  emoji: string;
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
  min_scenes: 2,
  max_scenes: 2,
  active: true,
  scenes: [
    {
      text: 'Your adventure begins. What do you do?',
      image_url: null,
      choices: [{ label: 'Continue', emoji: '➡️', next_scene_index: 1, loot: [], currency: 0, damage_pct: 0, requires_item: null }],
      loot: [],
      is_ending: false,
      ending_type: null,
    },
    {
      text: 'You completed the adventure.',
      image_url: null,
      choices: [],
      loot: [],
      is_ending: true,
      ending_type: 'success',
    },
  ],
};

// ── Page ──────────────────────────────────────────────────

export default function AdventuresPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<AdventureConfig>(DEFAULT_CONFIG);
  const [adventures, setAdventures] = useState<Adventure[]>([]);
  const [items, setItems] = useState<EconomyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<Adventure, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, advRes, itemsRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/adventures'),
        fetch('/api/economy/shop'),
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
      if (itemsRes.ok) {
        const itemsJson = await itemsRes.json();
        setItems(Array.isArray(itemsJson.data) ? itemsJson.data : []);
      }
    } catch {
      toast({ title: 'Failed to load adventures data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<AdventureConfig>) => {
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setConfig({
        economy_adventures_enabled: readConfirmedBoolean(result.config, 'economy_adventures_enabled'),
        economy_adventure_daily_limit: readConfirmedNumber(result.config, 'economy_adventure_daily_limit'),
        economy_adventure_ticket_cost: readConfirmedNumber(result.config, 'economy_adventure_ticket_cost'),
        economy_adventure_max_scenes: readConfirmedNumber(result.config, 'economy_adventure_max_scenes'),
      });
      if (result.status === 'failed') {
        toast({ title: 'Failed to save settings', variant: 'error' });
        return 'failed' as const;
      }
      toast({ title: 'Settings saved!', variant: 'success' });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
      return 'failed' as const;
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
          className="flex items-center gap-2 rounded-md bg-discord-accent px-3 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
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
                config.economy_adventures_enabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                config.economy_adventures_enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <ValidatedNumberInput label="Daily Adventure Limit" help="Maximum adventures one member can start per day." value={config.economy_adventure_daily_limit} onCommit={(value) => saveConfig({ economy_adventure_daily_limit: value })} min={1} max={50} />
          <ValidatedNumberInput label="Adventure Ticket Cost (coins)" help="Coins charged to start an adventure; 0 makes tickets free." value={config.economy_adventure_ticket_cost} onCommit={(value) => saveConfig({ economy_adventure_ticket_cost: value })} min={0} max={1000000} />
          <ValidatedNumberInput label="Maximum Scenes per Adventure" help="Hard cap on scenes generated for one adventure." value={config.economy_adventure_max_scenes} onCommit={(value) => saveConfig({ economy_adventure_max_scenes: value })} min={3} max={30} />
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
            <div key={a.id} className="flex flex-col items-stretch gap-3 rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="text-2xl">{a.emoji}</span>
                <div className="min-w-0">
                  <p className="font-semibold text-discord-text-primary [overflow-wrap:anywhere]">{a.name}</p>
                  <p className="text-sm text-discord-text-secondary">
                    {TYPE_EMOJI[a.adventure_type] ?? '❓'} {a.adventure_type} • {a.difficulty} • {a.scenes.length} configured scenes
                  </p>
                  {a.description && <p className="text-xs text-discord-text-muted mt-1">{a.description}</p>}
                </div>
              </div>
              <div className="flex justify-end gap-1 sm:shrink-0">
                <button type="button" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-discord-bg-tertiary">
                  <Pencil className="h-4 w-4 text-discord-text-secondary" />
                </button>
                <button type="button" aria-label={`Delete ${a.name}`} onClick={() => setDeleteId(a.id)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-discord-bg-tertiary">
                  <Trash2 className="h-4 w-4 text-red-400" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-3xl rounded-lg border border-discord-bg-tertiary bg-discord-bg-primary p-4 sm:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-discord-text-primary">
              {editing.id ? 'Edit' : 'New'} Adventure
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Name</span>
                <input
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Emoji</span>
                <input
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.emoji}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, emoji: e.target.value })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-discord-text-secondary">Description</span>
              <textarea
                className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent resize-none"
                value={editing.description ?? ''}
                rows={2}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Type</span>
                <select
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
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
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.difficulty}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, difficulty: e.target.value })}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>{d.toUpperCase()}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="space-y-3 rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-discord-text-primary">Story scenes</h3>
                  <p className="text-xs text-discord-text-muted">Choices move to another numbered scene and can award coins, an inventory item, or deal damage.</p>
                </div>
                <button
                  type="button"
                  disabled={editing.scenes.length >= 30}
                  onClick={() => {
                    const previousFinal = editing.scenes.length - 1;
                    const scenes = editing.scenes.map((scene, index) => index === previousFinal
                      ? {
                          ...scene,
                          is_ending: false,
                          ending_type: null,
                          choices: scene.choices.length > 0 ? scene.choices : [{
                            label: 'Continue', emoji: '➡️', next_scene_index: previousFinal + 1,
                            loot: [], currency: 0, damage_pct: 0, requires_item: null,
                          }],
                        }
                      : scene);
                    scenes.push({ text: 'Describe the next scene.', image_url: null, choices: [], loot: [], is_ending: true, ending_type: 'success' });
                    setEditing({ ...editing, scenes, min_scenes: scenes.length, max_scenes: scenes.length });
                  }}
                  className="rounded-md bg-discord-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  <Plus className="mr-1 inline h-3 w-3" /> Add scene
                </button>
              </div>

              {editing.scenes.map((scene, sceneIndex) => (
                <div key={sceneIndex} className="space-y-3 rounded-md border border-discord-border-subtle bg-discord-bg-primary p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-discord-text-primary">Scene {sceneIndex + 1}</span>
                    {editing.scenes.length > 2 && (
                      <button
                        type="button"
                        aria-label={`Remove scene ${sceneIndex + 1}`}
                        onClick={() => {
                          const scenes = editing.scenes
                            .filter((_, index) => index !== sceneIndex)
                            .map((existing, index, remaining) => ({
                              ...existing,
                              is_ending: index === remaining.length - 1 ? true : existing.is_ending,
                              ending_type: index === remaining.length - 1 ? (existing.ending_type ?? 'success') : existing.ending_type,
                              choices: existing.choices.map((choice) => ({
                                ...choice,
                                next_scene_index: choice.next_scene_index === null
                                  ? null
                                  : choice.next_scene_index === sceneIndex
                                    ? Math.min(index + 1, remaining.length - 1)
                                    : choice.next_scene_index > sceneIndex
                                      ? choice.next_scene_index - 1
                                      : choice.next_scene_index,
                              })),
                            }));
                          setEditing({ ...editing, scenes, min_scenes: scenes.length, max_scenes: scenes.length });
                        }}
                        className="rounded p-2 text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={scene.text}
                    rows={2}
                    onChange={(event) => {
                      const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? { ...existing, text: event.target.value } : existing);
                      setEditing({ ...editing, scenes });
                    }}
                    placeholder="What the member sees in this scene"
                    className="w-full resize-y rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  />
                  <label className="flex items-center gap-2 text-xs text-discord-text-secondary">
                    <input
                      type="checkbox"
                      checked={scene.is_ending}
                      onChange={(event) => {
                        const scenes = editing.scenes.map((existing, index) => index === sceneIndex
                          ? { ...existing, is_ending: event.target.checked, ending_type: event.target.checked ? (existing.ending_type ?? 'success') : null }
                          : existing);
                        setEditing({ ...editing, scenes });
                      }}
                    />
                    End the adventure here
                  </label>
                  {scene.is_ending ? (
                    <select
                      value={scene.ending_type ?? 'success'}
                      onChange={(event) => {
                        const endingType = event.target.value as 'success' | 'death' | 'partial';
                        const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? { ...existing, ending_type: endingType } : existing);
                        setEditing({ ...editing, scenes });
                      }}
                      className="w-full rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary"
                    >
                      <option value="success">Success: keep all rewards</option>
                      <option value="partial">Partial: keep part of the loot</option>
                      <option value="death">Failure: lose collected loot</option>
                    </select>
                  ) : (
                    <div className="space-y-2">
                      {scene.choices.map((choice, choiceIndex) => (
                        <div key={choiceIndex} className="grid grid-cols-1 gap-2 rounded border border-discord-border-subtle p-2 sm:grid-cols-2">
                          <input
                            value={choice.label}
                            placeholder="Choice label"
                            onChange={(event) => {
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.map((item, itemIndex) => itemIndex === choiceIndex ? { ...item, label: event.target.value } : item),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            className="rounded bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary"
                          />
                          <select
                            value={choice.next_scene_index ?? ''}
                            onChange={(event) => {
                              const nextScene = event.target.value === '' ? null : Number(event.target.value);
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.map((item, itemIndex) => itemIndex === choiceIndex ? { ...item, next_scene_index: nextScene } : item),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            className="rounded bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary"
                          >
                            <option value="">End after this choice</option>
                            {editing.scenes.map((_, destination) => (
                              <option key={destination} value={destination}>Go to scene {destination + 1}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={0}
                            max={1_000_000}
                            value={choice.currency}
                            aria-label={`Coins for choice ${choiceIndex + 1}`}
                            onChange={(event) => {
                              const currency = Math.max(0, Number(event.target.value) || 0);
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.map((item, itemIndex) => itemIndex === choiceIndex ? { ...item, currency } : item),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            placeholder="Coin reward"
                            className="rounded bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary"
                          />
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={choice.damage_pct}
                            aria-label={`Damage percent for choice ${choiceIndex + 1}`}
                            onChange={(event) => {
                              const damagePct = Math.max(0, Math.min(100, Number(event.target.value) || 0));
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.map((item, itemIndex) => itemIndex === choiceIndex ? { ...item, damage_pct: damagePct } : item),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            placeholder="Damage %"
                            className="rounded bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary"
                          />
                          <select
                            value={choice.loot[0]?.item_id ?? items.find((item) => item.name === choice.loot[0]?.item_name)?.id ?? ''}
                            onChange={(event) => {
                              const selected = items.find((item) => item.id === event.target.value);
                              const loot = selected ? [{ item_id: selected.id, item_name: selected.name, qty: 1, chance_pct: 100 }] : [];
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.map((item, itemIndex) => itemIndex === choiceIndex ? { ...item, loot } : item),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            className="rounded bg-discord-bg-secondary px-2 py-1.5 text-sm text-discord-text-primary sm:col-span-2"
                          >
                            <option value="">No item reward</option>
                            {items.filter((item) => item.active).map((item) => (
                              <option key={item.id} value={item.id}>{item.emoji} Award {item.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                                ...existing,
                                choices: existing.choices.filter((_, itemIndex) => itemIndex !== choiceIndex),
                              } : existing);
                              setEditing({ ...editing, scenes });
                            }}
                            className="text-left text-xs text-red-400 sm:col-span-2"
                          >
                            Remove choice
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        disabled={scene.choices.length >= 5}
                        onClick={() => {
                          const scenes = editing.scenes.map((existing, index) => index === sceneIndex ? {
                            ...existing,
                            choices: [...existing.choices, {
                              label: 'Continue', emoji: '➡️', next_scene_index: Math.min(sceneIndex + 1, editing.scenes.length - 1),
                              loot: [], currency: 0, damage_pct: 0, requires_item: null,
                            }],
                          } : existing);
                          setEditing({ ...editing, scenes });
                        }}
                        className="text-xs text-discord-accent disabled:opacity-50"
                      >
                        + Add choice
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-discord-text-primary">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) => setEditing({ ...editing, active: event.target.checked })}
              />
              Available to members
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded-md px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={saveAdventure}
                disabled={
                  saving
                  || !editing.name.trim()
                  || editing.scenes.some((scene) => !scene.text.trim() || (!scene.is_ending && scene.choices.length === 0))
                  || !editing.scenes.at(-1)?.is_ending
                }
                className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50"
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
