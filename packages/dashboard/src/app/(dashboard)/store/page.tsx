/**
 * Store — Product management dashboard page.
 *
 * Architecture doc §30 — Commerce & Universal Licensing Platform.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import ProductFiles from '@/components/store/product-files';

// ── Types ─────────────────────────────────────────────────

interface Product {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  type: 'one_time' | 'subscription';
  delivery_type: 'file' | 'link' | 'access_pass' | 'mixed';
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
  delivery_type: 'file' | 'link' | 'access_pass' | 'mixed';
  price_cents: string;
  currency: string;
  granted_role_ids: string;
  active: boolean;
} = {
  name: '',
  description: '',
  type: 'one_time',
  delivery_type: 'access_pass',
  price_cents: '',
  currency: 'USD',
  granted_role_ids: '',
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
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filesProductId, setFilesProductId] = useState<string | null>(null);
  const [filesProductName, setFilesProductName] = useState<string>('');
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/store/products');
      const json = await res.json();
      if (json.success) setProducts(json.data);
    } finally {
      setLoading(false);
    }
  }, []);

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
      price_cents: String(p.price_cents),
      currency: p.currency,
      granted_role_ids: p.granted_role_ids.join(', '),
      active: p.active,
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name,
        description: form.description || null,
        type: form.type,
        delivery_type: form.delivery_type,
        price_cents: parseInt(form.price_cents, 10) || 0,
        currency: form.currency,
        granted_role_ids: form.granted_role_ids
          ? form.granted_role_ids.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        active: form.active,
      };

      await fetch('/api/store/products', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async (id: string) => {
    if (!confirm('Delete this product? This cannot be undone.')) return;
    await fetch(`/api/store/products?id=${id}`, { method: 'DELETE' });
    load();
  };

  const toggleActive = async (p: Product) => {
    await fetch('/api/store/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, active: !p.active }),
    });
    load();
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
                Price (cents) *
              </label>
              <input
                type="number"
                value={form.price_cents}
                onChange={(e) => setForm({ ...form, price_cents: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                placeholder="999 = $9.99"
              />
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
                    delivery_type: e.target.value as 'file' | 'link' | 'access_pass' | 'mixed',
                  })
                }
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              >
                <option value="access_pass">Access Pass</option>
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
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Granted Role IDs (comma-separated)
              </label>
              <input
                value={form.granted_role_ids}
                onChange={(e) => setForm({ ...form, granted_role_ids: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                placeholder="123456789012345678"
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
        <div className="text-center py-12 text-discord-text-muted">Loading products…</div>
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
                    onClick={() => deleteProduct(p.id)}
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
    </div>
  );
}
