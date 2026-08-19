/**
 * Economy Gathering Management — loot table CRUD + gathering settings.
 *
 * Admins manage loot tables for /hunt, /dig, /mine commands,
 * set gathering cooldowns, and toggle the gathering system.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Pickaxe, Plus, Pencil, Trash2 } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

// ── Types ─────────────────────────────────────────────────

type SourceType = 'hunt' | 'dig' | 'mine';
type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

interface LootEntry {
  id: string;
  source_type: SourceType;
  item_name: string;
  emoji: string;
  rarity: Rarity;
  min_qty: number;
  max_qty: number;
  weight: number;
  tool_tier: number;
  sell_value: number;
  gives_item_id: string | null;
  active: boolean;
}

interface GatheringSettings {
  economy_gathering_enabled: boolean;
  economy_gathering_cooldown_seconds: number;
}

const SOURCE_TYPES: { value: SourceType; label: string; emoji: string }[] = [
  { value: 'hunt', label: 'Hunt', emoji: '🏹' },
  { value: 'dig', label: 'Dig', emoji: '⛏️' },
  { value: 'mine', label: 'Mine', emoji: '⛰️' },
];

const RARITIES: { value: Rarity; label: string; color: string }[] = [
  { value: 'common', label: 'Common', color: 'bg-gray-500/20 text-gray-400' },
  { value: 'uncommon', label: 'Uncommon', color: 'bg-green-500/20 text-green-400' },
  { value: 'rare', label: 'Rare', color: 'bg-blue-500/20 text-blue-400' },
  { value: 'epic', label: 'Epic', color: 'bg-purple-500/20 text-purple-400' },
  { value: 'legendary', label: 'Legendary', color: 'bg-orange-500/20 text-orange-400' },
];

const BLANK_ENTRY: Partial<LootEntry> = {
  source_type: 'hunt',
  item_name: '',
  emoji: '📦',
  rarity: 'common',
  min_qty: 1,
  max_qty: 1,
  weight: 100,
  tool_tier: 0,
  sell_value: 10,
  gives_item_id: null,
  active: true,
};

// ── Loot Entry Form Modal ─────────────────────────────────

function LootFormModal({
  entry,
  onSave,
  onClose,
  saving,
}: {
  entry: Partial<LootEntry>;
  onSave: (entry: Partial<LootEntry>) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<LootEntry>>({ ...entry });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-discord-bg-secondary border border-discord-bg-tertiary p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          {entry.id ? 'Edit Loot Entry' : 'Create Loot Entry'}
        </h2>

        {/* Source Type */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Source Type</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            value={form.source_type ?? 'hunt'}
            onChange={(e) => setForm((p) => ({ ...p, source_type: e.target.value as SourceType }))}
          >
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>
            ))}
          </select>
        </label>

        {/* Item Name + Emoji */}
        <div className="grid grid-cols-[1fr_80px] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Item Name</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.item_name ?? ''}
              onChange={(e) => setForm((p) => ({ ...p, item_name: e.target.value.slice(0, 64) }))}
              maxLength={64}
              placeholder="Oak Wood"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Emoji</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent text-center"
              value={form.emoji ?? '📦'}
              onChange={(e) => setForm((p) => ({ ...p, emoji: e.target.value.slice(0, 64) }))}
              maxLength={64}
            />
          </label>
        </div>

        {/* Rarity */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Rarity</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            value={form.rarity ?? 'common'}
            onChange={(e) => setForm((p) => ({ ...p, rarity: e.target.value as Rarity }))}
          >
            {RARITIES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>

        {/* Quantity Range + Weight */}
        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Min Qty</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={1}
              max={999}
              value={form.min_qty ?? 1}
              onChange={(e) => setForm((p) => ({ ...p, min_qty: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Max Qty</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={1}
              max={999}
              value={form.max_qty ?? 1}
              onChange={(e) => setForm((p) => ({ ...p, max_qty: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Weight</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={1}
              max={10000}
              value={form.weight ?? 100}
              onChange={(e) => setForm((p) => ({ ...p, weight: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
            />
          </label>
        </div>

        {/* Tool Tier + Sell Value */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Required Tool Tier</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={0}
              max={10}
              value={form.tool_tier ?? 0}
              onChange={(e) => setForm((p) => ({ ...p, tool_tier: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Sell Value</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={0}
              max={1000000}
              value={form.sell_value ?? 10}
              onChange={(e) => setForm((p) => ({ ...p, sell_value: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
            />
          </label>
        </div>

        {/* Active toggle */}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="rounded"
            checked={form.active ?? true}
            onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
          />
          <span className="text-sm text-discord-text-primary">Active</span>
        </label>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="rounded-md px-4 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50"
            onClick={() => onSave(form)}
            disabled={saving || !form.item_name?.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────

export default function GatheringPage() {
  const [entries, setEntries] = useState<LootEntry[]>([]);
  const [settings, setSettings] = useState<GatheringSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editEntry, setEditEntry] = useState<Partial<LootEntry> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState<SourceType | 'all'>('all');
  const { toast } = useToast();
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

  const fetchAll = useCallback(async () => {
    try {
      const [entriesRes, settingsRes] = await Promise.all([
        fetch('/api/economy/gathering'),
        fetch('/api/guild'),
      ]);
      if (entriesRes.ok) {
        const data = await entriesRes.json();
        setEntries(data.entries ?? []);
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        const gc = data.config ?? {};
        setSettings({
          economy_gathering_enabled: gc.economy_gathering_enabled ?? true,
          economy_gathering_cooldown_seconds: gc.economy_gathering_cooldown_seconds ?? 30,
        });
      }
    } catch {
      toast({ title: 'Failed to load gathering data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saveSettings = async (patch: Partial<GatheringSettings>) => {
    setSaving(true);
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setSettings({
        economy_gathering_enabled: readConfirmedBoolean(result.config, 'economy_gathering_enabled'),
        economy_gathering_cooldown_seconds: readConfirmedNumber(result.config, 'economy_gathering_cooldown_seconds'),
      });
      if (result.status === 'failed') {
        toast({ title: 'Failed to save settings', variant: 'error' });
        return 'failed' as const;
      }
      toast({ title: 'Settings saved', variant: 'success' });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
      return 'failed' as const;
    } finally {
      setSaving(false);
    }
  };

  const saveEntry = async (entry: Partial<LootEntry>) => {
    setSaving(true);
    try {
      const method = entry.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/gathering', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      if (!res.ok) throw new Error();
      setEditEntry(null);
      await fetchAll();
      toast({ title: entry.id ? 'Loot entry updated' : 'Loot entry created', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save loot entry', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async () => {
    if (!deleteId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/economy/gathering', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteId }),
      });
      if (!res.ok) throw new Error();
      setDeleteId(null);
      await fetchAll();
      toast({ title: 'Loot entry deleted', variant: 'success' });
    } catch {
      toast({ title: 'Failed to delete loot entry', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const filtered = filterSource === 'all'
    ? entries
    : entries.filter((e) => e.source_type === filterSource);

  const getRarityStyle = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity)?.color ?? 'bg-gray-500/20 text-gray-400';

  const getSourceLabel = (source: SourceType) =>
    SOURCE_TYPES.find((s) => s.value === source);

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Pickaxe className="h-6 w-6 text-discord-text-primary" />
          <div>
            <h1 className="text-xl font-bold text-discord-text-primary">Gathering &amp; Loot Tables</h1>
            <p className="text-sm text-discord-text-secondary">
              Manage loot drops for /hunt, /dig, and /mine commands.
            </p>
          </div>
        </div>
        <button
          className="flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
          onClick={() => setEditEntry({ ...BLANK_ENTRY })}
        >
          <Plus size={16} />
          Add Loot
        </button>
      </div>

      {/* Settings */}
      {settings && (
        <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 space-y-4">
          <h2 className="text-sm font-semibold text-discord-text-primary">Gathering Settings</h2>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                checked={settings.economy_gathering_enabled}
                onChange={(e) => saveSettings({ economy_gathering_enabled: e.target.checked })}
                disabled={saving}
              />
              <span className="text-sm text-discord-text-primary">Enable Gathering</span>
            </label>
            <ValidatedNumberInput label="Gathering Cooldown (seconds)" help="Wait time between gathering commands; 0 removes the cooldown." value={settings.economy_gathering_cooldown_seconds} onCommit={(value) => saveSettings({ economy_gathering_cooldown_seconds: value })} min={0} max={86400} disabled={saving} className="mt-1 w-28 rounded-input border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-sm text-discord-text-primary" />
          </div>
        </div>
      )}

      {/* Source Filter */}
      <div className="flex gap-2">
        <button
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            filterSource === 'all'
              ? 'bg-discord-accent text-white'
              : 'bg-discord-bg-secondary text-discord-text-secondary hover:text-discord-text-primary'
          }`}
          onClick={() => setFilterSource('all')}
        >
          All ({entries.length})
        </button>
        {SOURCE_TYPES.map((s) => {
          const count = entries.filter((e) => e.source_type === s.value).length;
          return (
            <button
              key={s.value}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                filterSource === s.value
                  ? 'bg-discord-accent text-white'
                  : 'bg-discord-bg-secondary text-discord-text-secondary hover:text-discord-text-primary'
              }`}
              onClick={() => setFilterSource(s.value)}
            >
              {s.emoji} {s.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Loot Entry List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Pickaxe}
          title="No loot entries yet"
          description={
            filterSource === 'all'
              ? 'Create your first loot entry to populate the gathering drop tables.'
              : `No loot entries for ${filterSource}. Add some drops!`
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => {
            const source = getSourceLabel(entry.source_type);
            return (
              <div
                key={entry.id}
                className="flex flex-col items-stretch gap-3 rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg">{entry.emoji}</span>
                    <span className="font-medium text-discord-text-primary">{entry.item_name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${getRarityStyle(entry.rarity)}`}>
                      {entry.rarity}
                    </span>
                    <span className="text-xs bg-discord-bg-primary text-discord-text-secondary px-1.5 py-0.5 rounded">
                      {source?.emoji} {source?.label}
                    </span>
                    {!entry.active && (
                      <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">disabled</span>
                    )}
                  </div>
                  <p className="text-xs text-discord-text-secondary mt-1">
                    Qty: {entry.min_qty}–{entry.max_qty} · Weight: {entry.weight} · Sell: {entry.sell_value.toLocaleString()} · Tier ≥ {entry.tool_tier}
                  </p>
                </div>
                <div className="flex items-center justify-end gap-1 sm:ml-2 sm:shrink-0">
                  <button
                    className="flex h-11 w-11 items-center justify-center rounded text-discord-text-secondary hover:text-discord-text-primary"
                    onClick={() => setEditEntry(entry)}
                    aria-label={`Edit ${entry.item_name}`}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="flex h-11 w-11 items-center justify-center rounded text-discord-text-secondary hover:text-red-400"
                    onClick={() => setDeleteId(entry.id)}
                    aria-label={`Delete ${entry.item_name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {editEntry && (
        <LootFormModal
          entry={editEntry}
          onSave={saveEntry}
          onClose={() => setEditEntry(null)}
          saving={saving}
        />
      )}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Loot Entry"
        description="Are you sure you want to delete this loot entry? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteEntry}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
