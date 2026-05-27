/**
 * Store — Product management dashboard page.
 *
 * Architecture doc §30 — Commerce & Universal Licensing Platform.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import ProductFiles from '@/components/store/product-files';
import { RolePicker } from '@/components/shared/role-picker';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';

// ── Types ─────────────────────────────────────────────────

interface Product {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  type: 'one_time' | 'subscription';
  delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  paypal_product_id: string | null;
  price_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  active: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  plans?: Plan[];
  product_license_config?: LicenseConfig[];
}

interface Plan {
  id: string;
  product_id: string;
  name: string;
  paypal_plan_id: string | null;
  interval_unit: string;
  interval_count: number;
  price_cents: number;
  currency: string;
  trial_days: number;
  active: boolean;
}

interface LicenseConfig {
  product_id: string;
  license_mode: string;
  max_devices: number;
  heartbeat_interval_seconds: number;
  offline_grace_period_seconds: number;
  feature_flags: string[];
  require_discord_guild_membership: boolean;
}

const emptyForm: {
  name: string;
  description: string;
  type: 'one_time' | 'subscription';
  delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  price_dollars: string;
  currency: string;
  granted_role_ids: string[];
  active: boolean;
} = {
  name: '',
  description: '',
  type: 'one_time',
  delivery_type: 'access_pass',
  price_dollars: '',
  currency: 'USD',
  granted_role_ids: [],
  active: true,
};

// ── Helpers ───────────────────────────────────────────────

function formatPrice(cents: number, currency: string = 'USD'): string {
  return `$${(cents / 100).toFixed(2)} ${currency}`;
}

function typeBadge(type: string) {
  switch (type) {
    case 'one_time':
      return { label: 'One-Time', color: 'bg-discord-info/20 text-discord-info' };
    case 'subscription':
      return { label: 'Subscription', color: 'bg-[#FF1493]/20 text-[#FF1493]' };
    default:
      return { label: type, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

function deliveryBadge(type: string) {
  switch (type) {
    case 'file':
      return '📁 File';
    case 'link':
      return '🔗 Link';
    case 'access_pass':
      return '🔑 Access Pass';
    case 'mixed':
      return '📦 Mixed';
    default:
      return type;
  }
}

// ── Component ─────────────────────────────────────────────

export default function StorePage() {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filesProductId, setFilesProductId] = useState<string | null>(null);
  const [filesProductName, setFilesProductName] = useState<string>('');
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [storeEnabled, setStoreEnabled] = useState(false);
  const [paypalEnabled, setPaypalEnabled] = useState(false);
  const [togglingStore, setTogglingStore] = useState(false);
  const [togglingPaypal, setTogglingPaypal] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState(3);
  const [savingGrace, setSavingGrace] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [productsRes, guildRes] = await Promise.all([
        fetch('/api/store/products'),
        fetch('/api/guild'),
      ]);
      const productsJson = await productsRes.json();
      if (productsJson.success) setProducts(productsJson.data);
      const guildJson = await guildRes.json();
      if (guildJson.config) {
        setStoreEnabled(guildJson.config.store_enabled ?? false);
        setPaypalEnabled(guildJson.config.paypal_enabled ?? false);
        setGracePeriodDays(guildJson.config.grace_period_days ?? 3);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleStoreEnabled = async (value: boolean) => {
    setTogglingStore(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_enabled: value }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setStoreEnabled(value);
        toast({ title: value ? 'Store enabled' : 'Store disabled', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to toggle store', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to toggle store', variant: 'error' });
    } finally {
      setTogglingStore(false);
    }
  };

  const togglePaypalEnabled = async (value: boolean) => {
    setTogglingPaypal(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paypal_enabled: value }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setPaypalEnabled(value);
        toast({ title: value ? 'PayPal enabled' : 'PayPal disabled', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to toggle PayPal', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to toggle PayPal', variant: 'error' });
    } finally {
      setTogglingPaypal(false);
    }
  };

  const saveGracePeriod = async (value: number) => {
    setSavingGrace(true);
    try {
      const clamped = Math.max(0, Math.min(30, value));
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grace_period_days: clamped }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setGracePeriodDays(clamped);
        toast({ title: 'Grace period saved', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to save', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to save grace period', variant: 'error' });
    } finally {
      setSavingGrace(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (p: Product) => {
    setForm({
      name: p.name,
      description: p.description ?? '',
      type: p.type,
      delivery_type: p.delivery_type,
      price_dollars: (p.price_cents / 100).toFixed(2),
      currency: p.currency,
      granted_role_ids: p.granted_role_ids,
      active: p.active,
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const save = async () => {
    // Client-side validation
    const priceCents = Math.round((parseFloat(form.price_dollars) || 0) * 100);
    if (priceCents < 0) {
      toast({ title: 'Price cannot be negative', variant: 'error' });
      return;
    }
    if (!form.currency.trim()) {
      toast({ title: 'Currency is required', variant: 'error' });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name,
        description: form.description || null,
        type: form.type,
        delivery_type: form.delivery_type,
        price_cents: priceCents,
        currency: form.currency.toUpperCase(),
        granted_role_ids: form.granted_role_ids,
        active: form.active,
      };

      const res = await fetch('/api/store/products', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast({ title: json.error ?? 'Failed to save product', variant: 'error' });
        return;
      }

      setShowForm(false);
      toast({ title: editingId ? 'Product updated' : 'Product created', variant: 'success' });
      load();
    } catch {
      toast({ title: 'Network error — could not save product', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async (id: string) => {
    try {
      const res = await fetch(`/api/store/products?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast({ title: json.error ?? 'Failed to delete product', variant: 'error' });
        return;
      }
      toast({ title: 'Product deleted', variant: 'success' });
      load();
    } catch {
      toast({ title: 'Network error — could not delete product', variant: 'error' });
    }
  };

  const toggleActive = async (p: Product) => {
    try {
      const res = await fetch('/api/store/products', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, active: !p.active }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast({ title: json.error ?? 'Failed to update product', variant: 'error' });
        return;
      }
      toast({ title: p.active ? 'Product deactivated' : 'Product activated', variant: 'success' });
      load();
    } catch {
      toast({ title: 'Network error — could not update product', variant: 'error' });
    }
  };

  // ── Stats ──

  const activeCount = products.filter((p) => p.active).length;
  const totalProducts = products.length;
  const oneTimeCount = products.filter((p) => p.type === 'one_time').length;
  const subCount = products.filter((p) => p.type === 'subscription').length;

  // ── Render ──

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Store</h1>
          <p className="text-sm text-discord-text-muted">
            Manage products, pricing, and delivery
          </p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-input bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-standard"
        >
          + New Product
        </button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Total Products', value: totalProducts },
          { label: 'Active', value: activeCount },
          { label: 'One-Time', value: oneTimeCount },
          { label: 'Subscriptions', value: subCount },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center"
          >
            <p className="text-2xl font-bold text-discord-text-primary">{s.value}</p>
            <p className="text-xs text-discord-text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Commerce Toggles */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Commerce Settings</h2>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-discord-text-primary">Store</span>
            <p className="text-xs text-discord-text-muted">
              Enable or disable the store system. When disabled, /store commands and buy buttons are blocked.
            </p>
          </div>
          <button
            onClick={() => toggleStoreEnabled(!storeEnabled)}
            disabled={togglingStore}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              storeEnabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                storeEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-discord-text-primary">PayPal Payments</span>
            <p className="text-xs text-discord-text-muted">
              Enable PayPal as a payment provider. Requires PayPal API credentials in Settings.
            </p>
          </div>
          <button
            onClick={() => togglePaypalEnabled(!paypalEnabled)}
            disabled={togglingPaypal}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              paypalEnabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                paypalEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-discord-text-primary">Subscription Grace Period</span>
            <p className="text-xs text-discord-text-muted">
              Days after a subscription expires before entitlements are revoked. Set to 0 for immediate revocation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={30}
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(parseInt(e.target.value) || 0)}
              className="w-20 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-1.5 text-sm text-discord-text-primary focus:border-discord-accent focus:outline-none"
            />
            <span className="text-xs text-discord-text-muted">days</span>
            <button
              onClick={() => saveGracePeriod(gracePeriodDays)}
              disabled={savingGrace}
              className="rounded-md bg-discord-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-discord-accent/80 disabled:opacity-50"
            >
              {savingGrace ? '…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Product Form Modal */}
      {showForm && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
          <h2 className="mb-4 text-lg font-bold text-discord-text-primary">
            {editingId ? 'Edit Product' : 'New Product'}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Name *
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                placeholder="Product name"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Price ($) *
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-discord-text-muted">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.price_dollars}
                  onChange={(e) => setForm({ ...form, price_dollars: e.target.value })}
                  className="w-full rounded-input bg-discord-bg-tertiary pl-7 pr-3 py-2 text-sm text-discord-text-primary outline-none"
                  placeholder="9.99"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Type
              </label>
              <select
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as 'one_time' | 'subscription' })
                }
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              >
                <option value="one_time">One-Time</option>
                <option value="subscription">Subscription</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Delivery Type
              </label>
              <select
                value={form.delivery_type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    delivery_type: e.target.value as 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed',
                  })
                }
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              >
                <option value="access_pass">Access Pass</option>
                <option value="license_key">License Key</option>
                <option value="file">File</option>
                <option value="link">Link</option>
                <option value="mixed">Mixed</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none resize-none"
                placeholder="Product description"
              />
            </div>
            <div>
              <RolePicker
                label="Granted Roles"
                hint="Roles given to buyers on purchase"
                value={form.granted_role_ids}
                onChange={(v) => setForm({ ...form, granted_role_ids: (v as string[]) ?? [] })}
                multi
                placeholder="Select roles to grant…"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Currency
              </label>
              <input
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                placeholder="USD"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="h-4 w-4 rounded bg-discord-bg-tertiary"
              />
              <label className="text-sm text-discord-text-secondary">Active</label>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={save}
              disabled={saving || !form.name}
              className="rounded-input bg-discord-success px-4 py-2 text-sm font-medium text-white hover:bg-discord-success/80 transition-standard disabled:opacity-50"
            >
              {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-tertiary/80 transition-standard"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Product List */}
      {loading ? (
        <CardListSkeleton cards={4} />
      ) : products.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🏪</div>
          <p className="text-discord-text-muted">No products yet. Create your first product to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {products.map((p) => {
            const badge = typeBadge(p.type);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`h-2 w-2 rounded-full ${p.active ? 'bg-discord-success' : 'bg-discord-text-muted'}`}
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-discord-text-primary">{p.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.color}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-discord-text-muted">
                        {deliveryBadge(p.delivery_type)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-discord-text-muted">
                      <span className="font-semibold text-discord-text-secondary">
                        {formatPrice(p.price_cents, p.currency)}
                      </span>
                      {p.granted_role_ids.length > 0 && (
                        <span>{p.granted_role_ids.length} role(s)</span>
                      )}
                      {p.plans && p.plans.length > 0 && (
                        <span>{p.plans.length} plan(s)</span>
                      )}
                      {p.product_license_config && p.product_license_config.length > 0 && (
                        <span>🔑 Licensed</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleActive(p)}
                    className={`rounded-input px-3 py-1 text-xs font-medium transition-standard ${
                      p.active
                        ? 'bg-discord-success/20 text-discord-success hover:bg-discord-success/30'
                        : 'bg-discord-bg-tertiary text-discord-text-muted hover:text-discord-text-secondary'
                    }`}
                  >
                    {p.active ? 'Active' : 'Inactive'}
                  </button>
                  <button
                    onClick={() => { setFilesProductId(p.id); setFilesProductName(p.name); }}
                    className="rounded-input bg-discord-bg-tertiary px-3 py-1 text-xs text-discord-text-secondary hover:text-discord-text-primary transition-standard"
                  >
                    📁 Files
                  </button>
                  <button
                    onClick={() => openEdit(p)}
                    className="rounded-input bg-discord-bg-tertiary px-3 py-1 text-xs text-discord-text-secondary hover:text-discord-text-primary transition-standard"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                    className="rounded-input bg-discord-danger/20 px-3 py-1 text-xs text-discord-danger hover:bg-discord-danger/30 transition-standard"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* File Manager Drawer */}
      {filesProductId && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-white">Product Files</h2>
            <button
              onClick={() => setFilesProductId(null)}
              className="text-xs text-discord-text-muted hover:text-white"
            >
              ✕ Close
            </button>
          </div>
          <ProductFiles productId={filesProductId} productName={filesProductName} />
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Product"
        description={`Delete "${confirmDelete?.name}"? This cannot be undone. All associated files and configurations will be removed.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteProduct(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
