/**
 * Economy Crafting Management — recipe CRUD + crafting settings.
 *
 * Admins manage crafting recipes (input materials → output item),
 * set crafting cooldowns, and toggle the crafting system.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Hammer, Plus, Pencil, Trash2 } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

// ── Types ─────────────────────────────────────────────────

interface RecipeInput {
  item_id?: string;
  item_name: string;
  qty: number;
}

interface Recipe {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  inputs: RecipeInput[];
  output_item_id: string | null;
  output_qty: number;
  cooldown_seconds: number;
  category: string;
  is_default: boolean;
  active: boolean;
}

interface CraftingItem {
  id: string;
  name: string;
  emoji: string;
  active: boolean;
}

interface CraftingSettings {
  economy_crafting_enabled: boolean;
  economy_crafting_cooldown_seconds: number;
}

const CATEGORIES = ['General', 'Tools', 'Consumables', 'Farming', 'Materials', 'Protection', 'Accessories'] as const;

const BLANK_RECIPE: Partial<Recipe> = {
  name: '',
  emoji: '🔨',
  description: '',
  inputs: [{ item_id: '', item_name: '', qty: 1 }],
  output_item_id: null,
  output_qty: 1,
  cooldown_seconds: 60,
  category: 'General',
  active: true,
};

// ── Recipe Form Modal ─────────────────────────────────────

function RecipeFormModal({
  recipe,
  onSave,
  onClose,
  saving,
  items,
}: {
  recipe: Partial<Recipe>;
  onSave: (recipe: Partial<Recipe>) => void;
  onClose: () => void;
  saving: boolean;
  items: CraftingItem[];
}) {
  const [form, setForm] = useState<Partial<Recipe>>({
    ...recipe,
    inputs: recipe.inputs && recipe.inputs.length > 0
      ? [...recipe.inputs]
      : [{ item_id: '', item_name: '', qty: 1 }],
  });

  const updateInputs = (idx: number, field: keyof RecipeInput, value: string | number) => {
    const newInputs = [...(form.inputs ?? [])];
    newInputs[idx] = { ...newInputs[idx], [field]: value };
    setForm((prev) => ({ ...prev, inputs: newInputs }));
  };

  const addInput = () => {
    setForm((prev) => ({
      ...prev,
      inputs: [...(prev.inputs ?? []), { item_id: '', item_name: '', qty: 1 }],
    }));
  };

  const removeInput = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      inputs: (prev.inputs ?? []).filter((_, i) => i !== idx),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-discord-bg-secondary border border-discord-bg-tertiary p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          {recipe.id ? 'Edit Recipe' : 'Create Recipe'}
        </h2>

        {/* Name + Emoji */}
        <div className="grid grid-cols-[1fr_80px] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Name</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.name ?? ''}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value.slice(0, 64) }))}
              maxLength={64}
              placeholder="Health Potion"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Emoji</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent text-center"
              value={form.emoji ?? '🔨'}
              onChange={(e) => setForm((p) => ({ ...p, emoji: e.target.value.slice(0, 64) }))}
              maxLength={64}
            />
          </label>
        </div>

        {/* Description */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Description</span>
          <textarea
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent resize-none"
            value={form.description ?? ''}
            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value.slice(0, 256) || null }))}
            maxLength={256}
            rows={2}
            placeholder="What does this recipe produce?"
          />
        </label>

        {/* Category */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Category</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            value={form.category ?? 'General'}
            onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        {/* Inputs (materials) */}
        <div className="space-y-2">
          <span className="text-xs text-discord-text-secondary">Input Materials</span>
          {(form.inputs ?? []).map((input, idx) => (
            <div key={idx} className="flex gap-2 items-center">
              <select
                className="flex-1 rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                value={input.item_id ?? items.find((item) => item.name.toLowerCase() === input.item_name.toLowerCase())?.id ?? ''}
                onChange={(event) => {
                  const item = items.find((candidate) => candidate.id === event.target.value);
                  const newInputs = [...(form.inputs ?? [])];
                  newInputs[idx] = { ...input, item_id: item?.id ?? '', item_name: item?.name ?? '' };
                  setForm((previous) => ({ ...previous, inputs: newInputs }));
                }}
              >
                <option value="">Select an inventory item</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.emoji} {item.name}{item.active ? '' : ' (inactive)'}</option>)}
              </select>
              <input
                type="number"
                className="w-20 rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
                min={1}
                max={999}
                value={input.qty}
                onChange={(e) => updateInputs(idx, 'qty', Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
              {(form.inputs ?? []).length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ingredient ${idx + 1}`}
                  className="flex h-11 w-11 items-center justify-center rounded text-discord-text-secondary hover:text-red-400"
                  onClick={() => removeInput(idx)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="text-xs text-discord-accent hover:underline"
            onClick={addInput}
          >
            + Add material
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Crafted Output</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            value={form.output_item_id ?? ''}
            onChange={(event) => setForm((previous) => ({ ...previous, output_item_id: event.target.value || null }))}
          >
            <option value="">Select the item this recipe creates</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.emoji} {item.name}{item.active ? '' : ' (inactive)'}</option>)}
          </select>
          <span className="text-xs text-discord-text-muted">Items and their actual behavior are configured in Economy → Shop.</span>
        </label>

        {/* Output qty + Cooldown */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Output Quantity</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={1}
              max={100}
              value={form.output_qty ?? 1}
              onChange={(e) => setForm((p) => ({ ...p, output_qty: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Cooldown (seconds)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              min={0}
              max={86400}
              value={form.cooldown_seconds ?? 60}
              onChange={(e) => setForm((p) => ({ ...p, cooldown_seconds: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
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
            disabled={saving || !form.name?.trim() || !form.output_item_id || !(form.inputs ?? []).every((input) => input.item_id)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────

export default function CraftingPage() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [items, setItems] = useState<CraftingItem[]>([]);
  const [settings, setSettings] = useState<CraftingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editRecipe, setEditRecipe] = useState<Partial<Recipe> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { toast } = useToast();
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

  const fetchAll = useCallback(async () => {
    try {
      const [recipesRes, settingsRes, itemsRes] = await Promise.all([
        fetch('/api/economy/crafting'),
        fetch('/api/guild'),
        fetch('/api/economy/shop'),
      ]);
      if (recipesRes.ok) {
        const data = await recipesRes.json();
        setRecipes(data.recipes ?? []);
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        const gc = data.config ?? {};
        setSettings({
          economy_crafting_enabled: gc.economy_crafting_enabled ?? true,
          economy_crafting_cooldown_seconds: gc.economy_crafting_cooldown_seconds ?? 60,
        });
      }
      if (itemsRes.ok) {
        const data = await itemsRes.json();
        setItems(Array.isArray(data.data) ? data.data : []);
      }
    } catch {
      toast({ title: 'Failed to load crafting data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saveSettings = async (patch: Partial<CraftingSettings>) => {
    setSaving(true);
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setSettings({
        economy_crafting_enabled: readConfirmedBoolean(result.config, 'economy_crafting_enabled'),
        economy_crafting_cooldown_seconds: readConfirmedNumber(result.config, 'economy_crafting_cooldown_seconds'),
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

  const saveRecipe = async (recipe: Partial<Recipe>) => {
    setSaving(true);
    try {
      const method = recipe.id ? 'PUT' : 'POST';
      const res = await fetch('/api/economy/crafting', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recipe),
      });
      if (!res.ok) throw new Error();
      setEditRecipe(null);
      await fetchAll();
      toast({ title: recipe.id ? 'Recipe updated' : 'Recipe created', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save recipe', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteRecipe = async () => {
    if (!deleteId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/economy/crafting', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteId }),
      });
      if (!res.ok) throw new Error();
      setDeleteId(null);
      await fetchAll();
      toast({ title: 'Recipe deleted', variant: 'success' });
    } catch {
      toast({ title: 'Failed to delete recipe', variant: 'error' });
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
          <Hammer className="h-6 w-6 text-discord-text-primary" />
          <div>
            <h1 className="text-xl font-bold text-discord-text-primary">Crafting Recipes</h1>
            <p className="text-sm text-discord-text-secondary">
              Manage crafting recipes — input materials → output item.
            </p>
          </div>
        </div>
        <button
          className="flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
          onClick={() => setEditRecipe({ ...BLANK_RECIPE })}
        >
          <Plus size={16} />
          Add Recipe
        </button>
      </div>

      {/* Settings */}
      {settings && (
        <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 space-y-4">
          <h2 className="text-sm font-semibold text-discord-text-primary">Crafting Settings</h2>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                checked={settings.economy_crafting_enabled}
                onChange={(e) => saveSettings({ economy_crafting_enabled: e.target.checked })}
                disabled={saving}
              />
              <span className="text-sm text-discord-text-primary">Enable Crafting</span>
            </label>
            <ValidatedNumberInput label="Default Crafting Cooldown (seconds)" help="Wait time between recipes when a recipe has no override; 0 removes the cooldown." value={settings.economy_crafting_cooldown_seconds} onCommit={(value) => saveSettings({ economy_crafting_cooldown_seconds: value })} min={0} max={86400} disabled={saving} className="mt-1 w-28 rounded-input border border-discord-border-subtle bg-discord-bg-primary px-2 py-1 text-sm text-discord-text-primary" />
          </div>
        </div>
      )}

      {/* Recipe List */}
      {recipes.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No recipes yet"
          description="Create your first crafting recipe to get started."
        />
      ) : (
        <div className="space-y-2">
          {recipes.map((recipe) => (
            <div
              key={recipe.id}
              className="flex flex-col items-stretch gap-3 rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg">{recipe.emoji}</span>
                  <span className="font-medium text-discord-text-primary">{recipe.name}</span>
                  <span className="text-xs text-discord-text-secondary">({recipe.category})</span>
                  {!recipe.active && (
                    <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">disabled</span>
                  )}
                  {recipe.is_default && (
                    <span className="text-xs bg-discord-accent/20 text-discord-accent px-1.5 py-0.5 rounded">default</span>
                  )}
                </div>
                <p className="text-xs text-discord-text-secondary mt-1">
                  {recipe.inputs.map((i) => `${i.qty}x ${i.item_name}`).join(' + ')} → {recipe.output_qty}x {items.find((item) => item.id === recipe.output_item_id)?.name ?? 'unlinked output'}
                </p>
              </div>
              <div className="flex items-center justify-end gap-1 sm:ml-2 sm:shrink-0">
                <button
                  className="flex h-11 w-11 items-center justify-center rounded text-discord-text-secondary hover:text-discord-text-primary"
                  onClick={() => setEditRecipe(recipe)}
                  aria-label={`Edit ${recipe.name}`}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="flex h-11 w-11 items-center justify-center rounded text-discord-text-secondary hover:text-red-400"
                  onClick={() => setDeleteId(recipe.id)}
                  aria-label={`Delete ${recipe.name}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {editRecipe && (
        <RecipeFormModal
          recipe={editRecipe}
          onSave={saveRecipe}
          onClose={() => setEditRecipe(null)}
          saving={saving}
          items={items}
        />
      )}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete Recipe"
        description="Are you sure you want to delete this recipe? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRecipe}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
