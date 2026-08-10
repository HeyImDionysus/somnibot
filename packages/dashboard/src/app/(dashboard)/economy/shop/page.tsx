/**
 * Economy Shop Management — CRUD for shop items.
 *
 * Admins can create, edit, reorder, and delete items that members
 * buy with virtual currency via /buy and /shop commands.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ShoppingBag, Plus, Pencil, Trash2 } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface ShopItem {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  emoji: string;
  category: string;
  price: number;
  sell_price: number;
  stock: number | null;
  max_per_user: number | null;
  require_role_id: string | null;
  grant_role_id: string | null;
  usable: boolean;
  use_effect: Record<string, unknown> | null;
  durability: number | null;
  tradeable: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Canonical shop categories — keep in sync with the bot's /shop category
// choices (features/economy/commands.ts) and the categories used by the
// content seeder and crafting outputs.
const CATEGORIES = ['Tools', 'Protection', 'Farming', 'Accessories', 'Bait', 'Seeds', 'Materials', 'Consumables', 'Roles', 'Cosmetics', 'Lootboxes'] as const;

const BLANK_ITEM: Partial<ShopItem> = {
  name: '',
  description: '',
  emoji: '📦',
  category: 'Consumables',
  price: 100,
  sell_price: 0,
  stock: null,
  max_per_user: null,
  require_role_id: null,
  grant_role_id: null,
  usable: false,
  use_effect: null,
  durability: null,
  tradeable: true,
  active: true,
  sort_order: 0,
};

// ── Item Form Modal ───────────────────────────────────────

function ItemFormModal({
  item,
  onSave,
  onClose,
  saving,
}: {
  item: Partial<ShopItem>;
  onSave: (item: Partial<ShopItem>) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<ShopItem>>(item);

  const update = <K extends keyof ShopItem>(key: K, value: ShopItem[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-discord-bg-secondary border border-discord-bg-tertiary p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          {item.id ? 'Edit Item' : 'Create Item'}
        </h2>

        {/* Name + Emoji */}
        <div className="grid grid-cols-[1fr_80px] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Name</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.name ?? ''}
              onChange={(e) => update('name', e.target.value.slice(0, 64))}
              maxLength={64}
              placeholder="Padlock"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Emoji</span>
            <input
              type="text"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent text-center"
              value={form.emoji ?? '📦'}
              onChange={(e) => update('emoji', e.target.value.slice(0, 64))}
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
            onChange={(e) => update('description', e.target.value.slice(0, 256) || null)}
            maxLength={256}
            rows={2}
            placeholder="Protects you from robbery once"
          />
        </label>

        {/* Category */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-discord-text-secondary">Category</span>
          <select
            className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            value={form.category ?? 'Consumables'}
            onChange={(e) => update('category', e.target.value)}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        {/* Price / Sell Price */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Buy Price</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.price ?? 0}
              onChange={(e) => update('price', Math.max(0, parseInt(e.target.value) || 0))}
              min={0}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Sell Price (0 = not sellable)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.sell_price ?? 0}
              onChange={(e) => update('sell_price', Math.max(0, parseInt(e.target.value) || 0))}
              min={0}
            />
          </label>
        </div>

        {/* Stock / Max per user */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Stock (empty = unlimited)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.stock ?? ''}
              onChange={(e) => update('stock', e.target.value ? Math.max(0, parseInt(e.target.value) || 0) : null)}
              min={0}
              placeholder="∞"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Max per User (empty = unlimited)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={form.max_per_user ?? ''}
              onChange={(e) => update('max_per_user', e.target.value ? Math.max(1, parseInt(e.target.value) || 1) : null)}
              min={1}
              placeholder="∞"
            />
          </label>
        </div>

        {/* Toggles */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm text-discord-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={form.tradeable ?? true}
              onChange={(e) => update('tradeable', e.target.checked)}
              className="rounded border-discord-bg-tertiary bg-discord-bg-primary text-discord-accent focus:ring-discord-accent"
            />
            Tradeable
          </label>
          <label className="flex items-center gap-2 text-sm text-discord-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={form.active ?? true}
              onChange={(e) => update('active', e.target.checked)}
              className="rounded border-discord-bg-tertiary bg-discord-bg-primary text-discord-accent focus:ring-discord-accent"
            />
            Active
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-primary hover:bg-discord-bg-tertiary"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.name?.trim()}
            className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : item.id ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function ShopPage() {
  const { toast } = useToast();

  const [items, setItems] = useState<ShopItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState<Partial<ShopItem> | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch('/api/economy/shop');
      const json = await res.json();
      if (json.success) {
        setItems(json.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load shop items', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const handleSaveItem = async (item: Partial<ShopItem>) => {
    setSaving(true);
    try {
      const isEdit = !!item.id;
      const res = await fetch('/api/economy/shop', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      const json = await res.json();
      if (json.success) {
        toast({ title: isEdit ? 'Item updated!' : 'Item created!', variant: 'success' });
        setEditingItem(null);
        await loadItems();
      } else {
        const errMsg = typeof json.error === 'string' ? json.error : 'Failed to save item';
        toast({ title: errMsg, variant: 'error' });
      }
    } catch {
      toast({ title: 'Network error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!deletingId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/economy/shop?id=${deletingId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        toast({ title: 'Item deleted', variant: 'success' });
        setDeletingId(null);
        await loadItems();
      } else {
        toast({ title: json.error || 'Failed to delete', variant: 'error' });
      }
    } catch {
      toast({ title: 'Network error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ConfigSkeleton />;

  // Group by category
  const grouped = items.reduce<Record<string, ShopItem[]>>((acc, item) => {
    const cat = item.category || 'Uncategorized';
    (acc[cat] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">🏪 Shop Items</h1>
          <p className="text-sm text-discord-text-secondary">
            {items.length} item{items.length !== 1 ? 's' : ''} — members buy these with virtual currency.
          </p>
        </div>
        <button
          onClick={() => setEditingItem({ ...BLANK_ITEM })}
          className="flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80"
        >
          <Plus className="h-4 w-4" />
          Add Item
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="No shop items yet"
          description="Create your first shop item — members will buy it with virtual currency."
          action={{
            label: 'Create Item',
            onClick: () => setEditingItem({ ...BLANK_ITEM }),
          }}
        />
      ) : (
        Object.entries(grouped).map(([category, catItems]) => (
          <div key={category} className="space-y-2">
            <h3 className="text-sm font-semibold text-discord-text-secondary uppercase tracking-wider">{category}</h3>
            <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary divide-y divide-discord-bg-tertiary">
              {catItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xl">{item.emoji}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-discord-text-primary truncate">{item.name}</p>
                        {!item.active && (
                          <span className="rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] text-discord-text-muted uppercase">Hidden</span>
                        )}
                      </div>
                      <p className="text-xs text-discord-text-secondary truncate">{item.description || 'No description'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-medium text-discord-text-primary">{item.price.toLocaleString()}</p>
                      {item.stock !== null && (
                        <p className="text-xs text-discord-text-muted">{item.stock} left</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingItem(item)}
                        className="rounded p-1.5 text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeletingId(item.id)}
                        className="rounded p-1.5 text-discord-text-secondary hover:bg-red-500/10 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Item form modal */}
      {editingItem && (
        <ItemFormModal
          item={editingItem}
          onSave={handleSaveItem}
          onClose={() => setEditingItem(null)}
          saving={saving}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deletingId}
        title="Delete Item"
        description="This will permanently delete this item and remove it from all inventories. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteItem}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}
