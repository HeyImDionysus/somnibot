/**
 * Economy Fishing Management — fish species CRUD + fishing settings.
 *
 * Admins manage fish species (rarity, weight, price) and configure
 * fishing cooldowns, junk/treasure chances.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Fish, Plus, Pencil, Trash2 } from 'lucide-react';
import { saveGuildConfigWithReadback } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

// ── Types ─────────────────────────────────────────────────

interface FishSpecies {
  id: string;
  name: string;
  emoji: string;
  rarity: string;
  min_weight: number;
  max_weight: number;
  base_price: number;
  active: boolean;
}

interface FishingConfig {
  economy_fishing_enabled: boolean;
  economy_fishing_cooldown_seconds: number;
  economy_fishing_junk_chance_pct: number;
  economy_fishing_treasure_chance_pct: number;
  economy_fishing_collection_reward_enabled: boolean;
  economy_fishing_collection_reward_coins: number;
}

const DEFAULT_CONFIG: FishingConfig = {
  economy_fishing_enabled: true,
  economy_fishing_cooldown_seconds: 30,
  economy_fishing_junk_chance_pct: 15,
  economy_fishing_treasure_chance_pct: 5,
  economy_fishing_collection_reward_enabled: true,
  economy_fishing_collection_reward_coins: 5000,
};

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
const RARITY_COLORS: Record<string, string> = {
  common: 'text-discord-text-secondary',
  uncommon: 'text-green-400',
  rare: 'text-blue-400',
  epic: 'text-purple-400',
  legendary: 'text-orange-400',
};

const BLANK_SPECIES: Omit<FishSpecies, 'id'> & { id?: string } = {
  name: '',
  emoji: '🐟',
  rarity: 'common',
  min_weight: 0.5,
  max_weight: 5.0,
  base_price: 10,
  active: true,
};

// ── Page ──────────────────────────────────────────────────

export default function FishingPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<FishingConfig>(DEFAULT_CONFIG);
  const [species, setSpecies] = useState<FishSpecies[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<(Omit<FishSpecies, 'id'> & { id?: string }) | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Fetch ─────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, speciesRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/fishing'),
      ]);
      if (cfgRes.ok) {
        const cfgJson = await cfgRes.json();
        const gc = cfgJson.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (speciesRes.ok) {
        const sJson = await speciesRes.json();
        setSpecies(sJson.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load fishing data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Config save ───────────────────────────────────────

  const saveConfig = async (patch: Partial<FishingConfig>) => {
    try {
      await saveGuildConfigWithReadback(patch);
      setConfig((current) => ({ ...current, ...patch }));
      toast({ title: 'Settings saved!', variant: 'success' });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
      return 'failed' as const;
    }
  };

  // ── Species CRUD ──────────────────────────────────────

  const saveSpecies = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/fishing', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      if (!res.ok) throw new Error();
      toast({ title: editing.id ? 'Species updated!' : 'Species created!', variant: 'success' });
      setEditing(null);
      loadData();
    } catch {
      toast({ title: 'Failed to save species', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteSpecies = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/economy/fishing?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast({ title: 'Species deleted', variant: 'success' });
      setDeleteId(null);
      loadData();
    } catch {
      toast({ title: 'Failed to delete species', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-discord-text-primary">🎣 Fishing</h1>
          <p className="text-sm text-discord-text-secondary">Manage fish species, rarity weights, and fishing settings.</p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK_SPECIES })}
          className="flex items-center gap-2 rounded-md bg-discord-accent px-3 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
        >
          <Plus className="h-4 w-4" /> Add Species
        </button>
      </div>

      {/* Config */}
      <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
        <h2 className="text-base font-semibold text-discord-text-primary">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-discord-text-primary">Fishing Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={config.economy_fishing_enabled}
              onClick={() => saveConfig({ economy_fishing_enabled: !config.economy_fishing_enabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                config.economy_fishing_enabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                config.economy_fishing_enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <ValidatedNumberInput label="Fishing Cooldown (seconds)" help="Wait time between fishing attempts." value={config.economy_fishing_cooldown_seconds} onCommit={(value) => saveConfig({ economy_fishing_cooldown_seconds: value })} min={5} max={3600} />
          <ValidatedNumberInput label="Junk Catch Chance (%)" help="Percent chance that an attempt returns junk; 0 disables junk catches." value={config.economy_fishing_junk_chance_pct} onCommit={(value) => saveConfig({ economy_fishing_junk_chance_pct: value })} min={0} max={100} />
          <ValidatedNumberInput label="Treasure Catch Chance (%)" help="Percent chance that an attempt returns treasure; 0 disables treasure catches." value={config.economy_fishing_treasure_chance_pct} onCommit={(value) => saveConfig({ economy_fishing_treasure_chance_pct: value })} min={0} max={100} />
          <div className="flex items-center justify-between">
            <span className="text-sm text-discord-text-primary">Collection Completion Reward</span>
            <button
              type="button"
              role="switch"
              aria-checked={config.economy_fishing_collection_reward_enabled}
              onClick={() => saveConfig({ economy_fishing_collection_reward_enabled: !config.economy_fishing_collection_reward_enabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                config.economy_fishing_collection_reward_enabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                config.economy_fishing_collection_reward_enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <ValidatedNumberInput label="Collection Reward (coins)" help="Coins awarded when a member completes the fish collection." value={config.economy_fishing_collection_reward_coins} onCommit={(value) => saveConfig({ economy_fishing_collection_reward_coins: value })} min={1} max={2147483647} />
        </div>
      </div>

      {/* Species List */}
      {species.length === 0 ? (
        <EmptyState
          icon={Fish}
          title="No fish species yet"
          description="Add your first fish species to get started."
          action={{ label: 'Add Species', onClick: () => setEditing({ ...BLANK_SPECIES }) }}
        />
      ) : (
        <div className="space-y-2">
          {species.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{s.emoji}</span>
                <div>
                  <p className="font-semibold text-discord-text-primary">{s.name}</p>
                  <p className={`text-sm ${RARITY_COLORS[s.rarity] ?? 'text-discord-text-secondary'}`}>
                    {s.rarity.toUpperCase()} • {s.min_weight}–{s.max_weight} kg • 💰 {s.base_price}/ea
                  </p>
                </div>
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-discord-bg-tertiary">
                  <Pencil className="h-4 w-4 text-discord-text-secondary" />
                </button>
                <button type="button" aria-label={`Delete ${s.name}`} onClick={() => setDeleteId(s.id)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-discord-bg-tertiary">
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
          <div className="w-full max-w-lg rounded-lg border border-discord-bg-tertiary bg-discord-bg-primary p-6 space-y-4">
            <h2 className="text-lg font-semibold text-discord-text-primary">
              {editing.id ? 'Edit' : 'New'} Fish Species
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
              <span className="text-sm text-discord-text-secondary">Rarity</span>
              <select
                className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                value={editing.rarity}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditing({ ...editing, rarity: e.target.value })}
              >
                {RARITIES.map((r) => (
                  <option key={r} value={r}>{r.toUpperCase()}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Min Weight</span>
                <input
                  type="number"
                  step="0.1"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.min_weight}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, min_weight: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Max Weight</span>
                <input
                  type="number"
                  step="0.1"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.max_weight}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, max_weight: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Base Price</span>
                <input
                  type="number"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                  value={editing.base_price}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, base_price: parseInt(e.target.value) || 0 })}
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
                onClick={saveSpecies}
                disabled={saving || !editing.name}
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
        title="Delete Species"
        description="Are you sure you want to delete this fish species? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteSpecies}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
