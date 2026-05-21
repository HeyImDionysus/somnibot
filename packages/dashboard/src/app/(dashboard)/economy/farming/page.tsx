/**
 * Economy Farming Management — crop CRUD + farming settings.
 *
 * Admins manage crop types (name, emoji, grow/wilt times, sell price, seeds)
 * and configure farming-wide settings like grid size and fertilizer.
 *
 * IMPORTANT: This is the FAKE economy (virtual crops).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Sprout, Plus, Pencil, Trash2 } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface Crop {
  id: string;
  name: string;
  emoji: string;
  grow_seconds: number;
  wilt_seconds: number;
  sell_price: number;
  seeds_returned: number;
  seed_item_id: string | null;
  category: string;
  sort_order: number;
  is_default: boolean;
  active: boolean;
}

interface FarmingSettings {
  economy_farming_enabled: boolean;
  economy_farm_grid_size: number;
  economy_farming_wilt_enabled: boolean;
  economy_fertilizer_time_reduction_pct: number;
}

const CROP_CATEGORIES = ['Vegetable', 'Fruit', 'Grain', 'Herb', 'Flower', 'Special'] as const;

const BLANK_CROP: Partial<Crop> = {
  name: '',
  emoji: '🌱',
  grow_seconds: 7200,
  wilt_seconds: 86400,
  sell_price: 50,
  seeds_returned: 1,
  seed_item_id: null,
  category: 'Vegetable',
  sort_order: 0,
  active: true,
};

// ── Helpers ───────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── Crop Form Modal ───────────────────────────────────────

function CropFormModal({
  crop,
  onSave,
  onClose,
  saving,
}: {
  crop: Partial<Crop>;
  onSave: (crop: Partial<Crop>) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<Crop>>(crop);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-discord-bg-secondary border border-discord-bg-tertiary p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          {crop.id ? 'Edit Crop' : 'Create Crop'}
        </h2>

        {/* Name + Emoji */}
        <div className="grid grid-cols-[1fr_80px] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Name</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={form.name ?? ''}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value.slice(0, 64) }))}
              maxLength={64}
              placeholder="Tomato"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Emoji</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple text-center"
              value={form.emoji ?? '🌱'}
              onChange={(e) => setForm((p) => ({ ...p, emoji: e.target.value.slice(0, 64) }))}
              maxLength={64}
            />
          </label>
        </div>

        {/* Category */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Category</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
            value={form.category ?? 'Vegetable'}
            onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
          >
            {CROP_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        {/* Grow + Wilt time */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Grow Time (seconds)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              min={60}
              max={604800}
              value={form.grow_seconds ?? 7200}
              onChange={(e) => setForm((p) => ({ ...p, grow_seconds: Math.max(60, parseInt(e.target.value, 10) || 60) }))}
            />
            <span className="text-xs text-discord-text-secondary">= {formatDuration(form.grow_seconds ?? 7200)}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Wilt Time (seconds)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              min={3600}
              max={604800}
              value={form.wilt_seconds ?? 86400}
              onChange={(e) => setForm((p) => ({ ...p, wilt_seconds: Math.max(3600, parseInt(e.target.value, 10) || 3600) }))}
            />
            <span className="text-xs text-discord-text-secondary">= {formatDuration(form.wilt_seconds ?? 86400)}</span>
          </label>
        </div>

        {/* Sell price + Seeds returned */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Sell Price</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              min={0}
              max={1000000}
              value={form.sell_price ?? 50}
              onChange={(e) => setForm((p) => ({ ...p, sell_price: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Seeds Returned</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              min={0}
              max={10}
              value={form.seeds_returned ?? 1}
              onChange={(e) => setForm((p) => ({ ...p, seeds_returned: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
            />
          </label>
        </div>

        {/* Sort order + Active */}
        <div className="flex items-center gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Sort Order</span>
            <input
              type="number"
              className="w-24 rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              min={0}
              max={999}
              value={form.sort_order ?? 0}
              onChange={(e) => setForm((p) => ({ ...p, sort_order: parseInt(e.target.value, 10) || 0 }))}
            />
          </label>
          <label className="flex items-center gap-2 mt-4">
            <input
              type="checkbox"
              className="rounded"
              checked={form.active ?? true}
              onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
            />
            <span className="text-sm text-discord-text-primary">Active</span>
          </label>
        </div>

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
            className="rounded-md bg-discord-blurple px-4 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80 disabled:opacity-50"
            onClick={() => onSave(form)}
            disabled={saving || !form.name?.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────

export default function FarmingPage() {
  const [crops, setCrops] = useState<Crop[]>([]);
  const [settings, setSettings] = useState<FarmingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editCrop, setEditCrop] = useState<Partial<Crop> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchAll = useCallback(async () => {
    try {
      const [cropsRes, settingsRes] = await Promise.all([
        fetch('/api/economy/farming'),
        fetch('/api/guild'),
      ]);
      if (cropsRes.ok) {
        const data = await cropsRes.json();
        setCrops(data.crops ?? []);
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        const gc = data.config ?? {};
        setSettings({
          economy_farming_enabled: gc.economy_farming_enabled ?? false,
          economy_farm_grid_size: gc.economy_farm_grid_size ?? 9,
          economy_farming_wilt_enabled: gc.economy_farming_wilt_enabled ?? true,
          economy_fertilizer_time_reduction_pct: gc.economy_fertilizer_time_reduction_pct ?? 50,
        });
      }
    } catch {
      toast({ title: 'Failed to load farming data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saveSettings = async (patch: Partial<FarmingSettings>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      setSettings((prev) => prev ? { ...prev, ...patch } : prev);
      toast({ title: 'Settings saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const saveCrop = async (crop: Partial<Crop>) => {
    setSaving(true);
    try {
      const method = crop.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/farming', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(crop),
      });
      if (!res.ok) throw new Error();
      setEditCrop(null);
      await fetchAll();
      toast({ title: crop.id ? 'Crop updated' : 'Crop created', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save crop', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteCrop = async () => {
    if (!deleteId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/economy/farming', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteId }),
      });
      if (!res.ok) throw new Error();
      setDeleteId(null);
      await fetchAll();
      toast({ title: 'Crop deleted', variant: 'success' });
    } catch {
      toast({ title: 'Failed to delete crop', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Sprout className="h-6 w-6 text-discord-text-primary" />
          <div>
            <h1 className="text-xl font-bold text-discord-text-primary">Farming — Crop Manager</h1>
            <p className="text-sm text-discord-text-secondary">
              Manage crop types and farming settings for the virtual farm.
            </p>
          </div>
        </div>
        <button
          className="flex items-center gap-2 rounded-md bg-discord-blurple px-4 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80"
          onClick={() => setEditCrop({ ...BLANK_CROP })}
        >
          <Plus size={16} />
          Add Crop
        </button>
      </div>

      {/* Settings */}
      {settings && (
        <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 space-y-4">
          <h2 className="text-sm font-semibold text-discord-text-primary">Farming Settings</h2>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                checked={settings.economy_farming_enabled}
                onChange={(e) => saveSettings({ economy_farming_enabled: e.target.checked })}
                disabled={saving}
              />
              <span className="text-sm text-discord-text-primary">Enable Farming</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                checked={settings.economy_farming_wilt_enabled}
                onChange={(e) => saveSettings({ economy_farming_wilt_enabled: e.target.checked })}
                disabled={saving}
              />
              <span className="text-sm text-discord-text-primary">Enable Wilting</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2">
              <span className="text-xs text-discord-text-secondary">Grid Size</span>
              <input
                type="number"
                className="w-20 rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-2 py-1 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                min={1}
                max={25}
                value={settings.economy_farm_grid_size}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(25, parseInt(e.target.value, 10) || 9));
                  setSettings((p) => p ? { ...p, economy_farm_grid_size: v } : p);
                }}
                onBlur={() => saveSettings({ economy_farm_grid_size: settings.economy_farm_grid_size })}
                disabled={saving}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs text-discord-text-secondary">Fertilizer Reduction (%)</span>
              <input
                type="number"
                className="w-20 rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-2 py-1 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                min={0}
                max={90}
                value={settings.economy_fertilizer_time_reduction_pct}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(90, parseInt(e.target.value, 10) || 50));
                  setSettings((p) => p ? { ...p, economy_fertilizer_time_reduction_pct: v } : p);
                }}
                onBlur={() => saveSettings({ economy_fertilizer_time_reduction_pct: settings.economy_fertilizer_time_reduction_pct })}
                disabled={saving}
              />
            </label>
          </div>
        </div>
      )}

      {/* Crop List */}
      {crops.length === 0 ? (
        <EmptyState
          icon={Sprout}
          title="No crops yet"
          description="Create your first crop to get the farm growing."
        />
      ) : (
        <div className="space-y-2">
          {crops.map((crop) => (
            <div
              key={crop.id}
              className="flex items-center justify-between rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{crop.emoji}</span>
                  <span className="font-medium text-discord-text-primary">{crop.name}</span>
                  <span className="text-xs text-discord-text-secondary">({crop.category})</span>
                  {!crop.active && (
                    <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">disabled</span>
                  )}
                  {crop.is_default && (
                    <span className="text-xs bg-discord-blurple/20 text-discord-blurple px-1.5 py-0.5 rounded">default</span>
                  )}
                </div>
                <p className="text-xs text-discord-text-secondary mt-1">
                  Grow: {formatDuration(crop.grow_seconds)} • Wilt: {formatDuration(crop.wilt_seconds)} • Sell: 💰 {crop.sell_price.toLocaleString()} • Seeds back: {crop.seeds_returned}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  className="p-2 text-discord-text-secondary hover:text-discord-text-primary"
                  onClick={() => setEditCrop(crop)}
                  title="Edit"
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="p-2 text-discord-text-secondary hover:text-red-400"
                  onClick={() => setDeleteId(crop.id)}
                  title="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {editCrop && (
        <CropFormModal
          crop={editCrop}
          onSave={saveCrop}
          onClose={() => setEditCrop(null)}
          saving={saving}
        />
      )}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Crop"
        description="Are you sure you want to delete this crop? Players with this crop planted will lose their plants."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteCrop}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
