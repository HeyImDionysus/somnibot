/**
 * Economy Shop Management — CRUD for shop items.
 *
 * Admins can create, edit, reorder, and archive items that members
 * buy with virtual currency via /buy and /shop commands.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ShoppingBag, Plus, Pencil, Archive } from 'lucide-react';
import { RolePicker } from '@/components/shared/role-picker';
import {
  ECONOMY_ITEM_EFFECT_TYPES,
  isManualEconomyItemEffect,
} from '@somnibot/shared/constants/economy';
import type { EconomyItemUseEffect } from '@somnibot/shared/types';

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
  use_effect: EconomyItemUseEffect | null;
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

const ITEM_EFFECT_META: Record<EconomyItemUseEffect['type'], { label: string; description: string }> = {
  padlock: { label: 'Padlock protection', description: 'Automatically blocks one robbery and is consumed.' },
  shovel: { label: 'Gathering shovel', description: 'Automatically used for digging gathering sources.' },
  pickaxe: { label: 'Gathering pickaxe', description: 'Automatically used for mining gathering sources.' },
  hunting_rifle: { label: 'Hunting tool', description: 'Automatically used for hunting gathering sources.' },
  wallet_credit: { label: 'Coin consumable', description: 'Members use this item to receive the configured virtual currency.' },
  xp_credit: { label: 'XP consumable', description: 'Members use this item to receive XP and any crossed level rewards.' },
  role_grant: { label: 'Role consumable', description: 'Members use this item to queue the selected Discord role grant.' },
};

function defaultEffect(type: EconomyItemUseEffect['type']): EconomyItemUseEffect {
  if (type === 'wallet_credit' || type === 'xp_credit') return { type, amount: 100 };
  if (type === 'role_grant') return { type, role_id: '' };
  if (type === 'shovel' || type === 'pickaxe' || type === 'hunting_rifle') return { type, tier: 1 };
  return { type };
}

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

  const effect = form.use_effect ?? null;
  const effectMeta = effect ? ITEM_EFFECT_META[effect.type] : undefined;
  const behaviorValid = (!effect || Boolean(effectMeta))
    && (effect?.type !== 'role_grant' || Boolean(effect.role_id));
  const setEffectType = (value: string) => {
    if (value === 'none') {
      setForm((prev) => ({ ...prev, usable: false, use_effect: null }));
      return;
    }
    const type = value as EconomyItemUseEffect['type'];
    setForm((prev) => ({
      ...prev,
      usable: isManualEconomyItemEffect(type),
      use_effect: defaultEffect(type),
    }));
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

        <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-primary/40 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-discord-text-primary">Item behavior</h3>
            <p className="text-xs text-discord-text-muted">
              Choose the exact bot behavior. Automatic tools work in their related game command; consumables are activated with /use.
            </p>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Behavior</span>
            <select
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              value={effect?.type ?? 'none'}
              onChange={(event) => setEffectType(event.target.value)}
            >
              <option value="none">Inventory or crafting material only</option>
              {effect && !effectMeta && (
                <option value={effect.type}>Legacy or unsupported behavior</option>
              )}
              {ECONOMY_ITEM_EFFECT_TYPES.map((type) => (
                <option key={type} value={type}>{ITEM_EFFECT_META[type].label}</option>
              ))}
            </select>
          </label>
          {effectMeta && (
            <p className="text-xs text-discord-text-secondary">{effectMeta.description}</p>
          )}
          {effect && !effectMeta && (
            <p className="text-xs text-yellow-300">
              This item contains an older behavior that SomniBot cannot run. Select a supported behavior before saving.
            </p>
          )}
          {effect && (effect.type === 'wallet_credit' || effect.type === 'xp_credit') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-discord-text-secondary">
                {effect.type === 'wallet_credit' ? 'Virtual currency awarded' : 'XP awarded'}
              </span>
              <input
                type="number"
                min={1}
                max={1_000_000_000}
                value={effect.amount ?? 1}
                onChange={(event) => update('use_effect', {
                  type: effect.type,
                  amount: Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                })}
                className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              />
            </label>
          )}
          {effect?.type === 'role_grant' && (
            <RolePicker
              label="Role granted when used"
              value={effect.role_id || null}
              onChange={(value) => update('use_effect', {
                type: 'role_grant',
                role_id: (value as string | null) ?? '',
              })}
              placeholder="Select role…"
            />
          )}
          {effect && (effect.type === 'shovel' || effect.type === 'pickaxe' || effect.type === 'hunting_rifle') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-discord-text-secondary">Tool tier</span>
              <input
                type="number"
                min={1}
                max={10}
                value={effect.tier ?? 1}
                onChange={(event) => update('use_effect', {
                  type: effect.type,
                  tier: Math.min(10, Math.max(1, Number.parseInt(event.target.value, 10) || 1)),
                })}
                className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
              />
            </label>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <RolePicker
            label="Required role to buy"
            value={form.require_role_id ?? null}
            onChange={(value) => update('require_role_id', (value as string | null) ?? null)}
            placeholder="No role required"
          />
          <RolePicker
            label="Role granted on purchase"
            value={form.grant_role_id ?? null}
            onChange={(value) => update('grant_role_id', (value as string | null) ?? null)}
            placeholder="No purchase role"
          />
        </div>

        {(effect?.type === 'shovel' || effect?.type === 'pickaxe' || effect?.type === 'hunting_rifle') && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-discord-text-secondary">Durability (empty = never wears out)</span>
            <input
              type="number"
              min={1}
              value={form.durability ?? ''}
              onChange={(event) => update('durability', event.target.value
                ? Math.max(1, Number.parseInt(event.target.value, 10) || 1)
                : null)}
              placeholder="Unlimited"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-accent"
            />
          </label>
        )}

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
            disabled={saving || !form.name?.trim() || !behaviorValid}
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
  const [archivingId, setArchivingId] = useState<string | null>(null);

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

  const handleArchiveItem = async () => {
    if (!archivingId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/economy/shop?id=${archivingId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        toast({ title: 'Item archived', variant: 'success' });
        setArchivingId(null);
        await loadItems();
      } else {
        toast({ title: json.error || 'Failed to archive', variant: 'error' });
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
                <div key={item.id} className="flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="text-xl">{item.emoji}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-discord-text-primary truncate">{item.name}</p>
                        {!item.active && (
                          <span className="rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] text-discord-text-muted uppercase">Hidden</span>
                        )}
                      </div>
                      <p className="text-xs text-discord-text-secondary truncate">{item.description || 'No description'}</p>
                      <p className="text-xs text-discord-text-muted">
                        {item.use_effect
                          ? ITEM_EFFECT_META[item.use_effect.type]?.label ?? 'Legacy or unsupported behavior'
                          : 'Inventory or crafting material'}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
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
                      {item.active && (
                        <button
                          onClick={() => setArchivingId(item.id)}
                          className="rounded p-1.5 text-discord-text-secondary hover:bg-red-500/10 hover:text-red-400"
                          title="Archive"
                          aria-label={`Archive ${item.name}`}
                        >
                          <Archive className="h-4 w-4" />
                        </button>
                      )}
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

      <ConfirmDialog
        open={!!archivingId}
        title="Archive Item"
        description="This item will no longer be purchasable, but existing inventory and configured rewards will remain valid. You can reactivate it by editing the item."
        confirmLabel="Archive"
        variant="danger"
        onConfirm={handleArchiveItem}
        onCancel={() => setArchivingId(null)}
      />
    </div>
  );
}
