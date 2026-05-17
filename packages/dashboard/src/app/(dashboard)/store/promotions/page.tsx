/**
 * Store / Promotions — Coupon and discount management.
 *
 * Architecture doc §32 — Promotions & coupons.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface Promotion {
  id: string;
  guild_id: string;
  name: string;
  type: 'percentage' | 'fixed_amount' | 'trial_extension' | 'free';
  coupon_code: string | null;
  discount_value: number;
  max_uses: number | null;
  current_uses: number;
  applies_to_product_ids: string[];
  applies_to_plan_ids: string[];
  min_purchase_cents: number;
  first_purchase_only: boolean;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  created_at: string;
}

const emptyForm: {
  name: string;
  type: 'percentage' | 'fixed_amount' | 'trial_extension' | 'free';
  coupon_code: string;
  discount_value: string;
  max_uses: string;
  min_purchase_cents: string;
  first_purchase_only: boolean;
  starts_at: string;
  ends_at: string;
  active: boolean;
} = {
  name: '',
  type: 'percentage',
  coupon_code: '',
  discount_value: '',
  max_uses: '',
  min_purchase_cents: '0',
  first_purchase_only: false,
  starts_at: '',
  ends_at: '',
  active: true,
};

// ── Helpers ───────────────────────────────────────────────

function typeBadge(type: string) {
  switch (type) {
    case 'percentage':
      return { label: '% Off', color: 'bg-[#FF1493]/20 text-[#FF1493]' };
    case 'fixed_amount':
      return { label: '$ Off', color: 'bg-discord-success/20 text-discord-success' };
    case 'trial_extension':
      return { label: 'Trial+', color: 'bg-discord-info/20 text-discord-info' };
    case 'free':
      return { label: 'Free', color: 'bg-yellow-500/20 text-yellow-400' };
    default:
      return { label: type, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

function formatDiscount(type: string, value: number): string {
  switch (type) {
    case 'percentage':
      return `${value}%`;
    case 'fixed_amount':
      return `$${(value / 100).toFixed(2)}`;
    case 'trial_extension':
      return `+${value} days`;
    case 'free':
      return 'Free';
    default:
      return String(value);
  }
}

// ── Component ─────────────────────────────────────────────

export default function PromotionsPage() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/store/promotions');
      const json = await res.json();
      if (json.success) setPromos(json.data);
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

  const openEdit = (p: Promotion) => {
    setForm({
      name: p.name,
      type: p.type,
      coupon_code: p.coupon_code ?? '',
      discount_value: String(p.discount_value),
      max_uses: p.max_uses ? String(p.max_uses) : '',
      min_purchase_cents: String(p.min_purchase_cents),
      first_purchase_only: p.first_purchase_only,
      starts_at: p.starts_at?.slice(0, 16) ?? '',
      ends_at: p.ends_at?.slice(0, 16) ?? '',
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
        type: form.type,
        coupon_code: form.coupon_code || null,
        discount_value: parseInt(form.discount_value, 10) || 0,
        max_uses: form.max_uses ? parseInt(form.max_uses, 10) : null,
        min_purchase_cents: parseInt(form.min_purchase_cents, 10) || 0,
        first_purchase_only: form.first_purchase_only,
        starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null,
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
        active: form.active,
      };

      await fetch('/api/store/promotions', {
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

  const deletePromo = async (id: string) => {
    if (!confirm('Delete this promotion?')) return;
    await fetch(`/api/store/promotions?id=${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Promotions</h1>
          <p className="text-sm text-discord-text-muted">
            Manage coupons, discounts, and trial extensions
          </p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-input bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-standard"
        >
          + New Promotion
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
          <h2 className="mb-4 text-lg font-bold text-discord-text-primary">
            {editingId ? 'Edit Promotion' : 'New Promotion'}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Name *</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
                placeholder="Summer Sale"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Coupon Code</label>
              <input
                value={form.coupon_code}
                onChange={(e) => setForm({ ...form, coupon_code: e.target.value.toUpperCase() })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none font-mono"
                placeholder="SUMMER25"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as Promotion['type'] })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              >
                <option value="percentage">Percentage Off</option>
                <option value="fixed_amount">Fixed Amount Off</option>
                <option value="trial_extension">Trial Extension</option>
                <option value="free">Free</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Discount Value ({form.type === 'percentage' ? '%' : form.type === 'trial_extension' ? 'days' : 'cents'})
              </label>
              <input
                type="number"
                value={form.discount_value}
                onChange={(e) => setForm({ ...form, discount_value: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Max Uses (blank = unlimited)</label>
              <input
                type="number"
                value={form.max_uses}
                onChange={(e) => setForm({ ...form, max_uses: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Min Purchase (cents)</label>
              <input
                type="number"
                value={form.min_purchase_cents}
                onChange={(e) => setForm({ ...form, min_purchase_cents: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Starts At</label>
              <input
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">Ends At</label>
              <input
                type="datetime-local"
                value={form.ends_at}
                onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-discord-text-secondary">
                <input
                  type="checkbox"
                  checked={form.first_purchase_only}
                  onChange={(e) => setForm({ ...form, first_purchase_only: e.target.checked })}
                  className="h-4 w-4 rounded bg-discord-bg-tertiary"
                />
                First purchase only
              </label>
              <label className="flex items-center gap-2 text-sm text-discord-text-secondary">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  className="h-4 w-4 rounded bg-discord-bg-tertiary"
                />
                Active
              </label>
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

      {/* Promotion List */}
      {loading ? (
        <div className="text-center py-12 text-discord-text-muted">Loading promotions…</div>
      ) : promos.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🏷️</div>
          <p className="text-discord-text-muted">No promotions yet. Create one to offer discounts.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {promos.map((p) => {
            const badge = typeBadge(p.type);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4"
              >
                <div className="flex items-center gap-4">
                  <div className={`h-2 w-2 rounded-full ${p.active ? 'bg-discord-success' : 'bg-discord-text-muted'}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-discord-text-primary">{p.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.color}`}>
                        {badge.label}
                      </span>
                      {p.coupon_code && (
                        <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-xs font-mono text-discord-text-secondary">
                          {p.coupon_code}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-discord-text-muted">
                      <span className="font-semibold text-discord-text-secondary">{formatDiscount(p.type, p.discount_value)}</span>
                      <span>{p.current_uses}{p.max_uses ? `/${p.max_uses}` : ''} uses</span>
                      {p.ends_at && (
                        <span>Ends {new Date(p.ends_at).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEdit(p)}
                    className="rounded-input bg-discord-bg-tertiary px-3 py-1 text-xs text-discord-text-secondary hover:text-discord-text-primary transition-standard"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deletePromo(p.id)}
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
    </div>
  );
}
