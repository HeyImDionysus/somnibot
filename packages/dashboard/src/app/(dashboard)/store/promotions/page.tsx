'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useToast } from '@/components/shared/toast';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';

interface Promotion {
  id: string;
  name: string;
  type: 'percentage' | 'fixed_amount';
  coupon_code: string;
  value: number;
  applies_to_product_ids: string[];
  start_date: string | null;
  end_date: string | null;
  max_uses: number | null;
  current_uses: number;
  min_purchase_cents: number | null;
  first_purchase_only: boolean;
  active: boolean;
}

interface Product { id: string; name: string; type: string }
type PromotionDraft = Omit<Promotion, 'id' | 'current_uses'> & { id?: string };

const EMPTY_DRAFT: PromotionDraft = {
  name: '', type: 'percentage', coupon_code: '', value: 10,
  applies_to_product_ids: [], start_date: null, end_date: null,
  max_uses: null, min_purchase_cents: null, first_purchase_only: false, active: true,
};

function dateInputValue(value: string | null): string {
  if (value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  return value ? new Date(value).toISOString().slice(0, 16) : '';
}

function formatDiscount(promotion: Promotion): string {
  return promotion.type === 'percentage'
    ? `${promotion.value}% off`
    : `$${(promotion.value / 100).toFixed(2)} off`;
}

export default function PromotionsPage() {
  const { toast } = useToast();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const firstEditorInputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  savingRef.current = saving;
  const editorOpen = draft !== null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [promotionResponse, productResponse] = await Promise.all([
        fetch('/api/store/promotions'), fetch('/api/store/products'),
      ]);
      const promotionBody = await promotionResponse.json();
      const productBody = await productResponse.json();
      if (!promotionResponse.ok || !promotionBody.success) throw new Error(promotionBody.error ?? 'Promotions could not be loaded.');
      if (!productResponse.ok || !productBody.success) throw new Error(productBody.error ?? 'Products could not be loaded.');
      setPromotions(promotionBody.data ?? []);
      setProducts((productBody.data ?? []).filter((product: Product) => product.type === 'one_time'));
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Promotions could not be loaded.', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!editorOpen) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstEditorInputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        setDraft(null);
        return;
      }
      if (event.key !== 'Tab' || !editorRef.current) return;
      const controls = Array.from(editorRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      returnFocus?.focus();
    };
  }, [editorOpen]);

  const save = async () => {
    if (!draft || !draft.name.trim() || !draft.coupon_code.trim()) return;
    setSaving(true);
    try {
      const promotion = {
        name: draft.name.trim(), type: draft.type, value: draft.value,
        coupon_code: draft.coupon_code.trim().toUpperCase(),
        applies_to_product_ids: draft.applies_to_product_ids, applies_to_plan_ids: [],
        start_date: draft.start_date ? new Date(draft.start_date).toISOString() : null,
        end_date: draft.end_date ? new Date(draft.end_date).toISOString() : null,
        max_uses: draft.max_uses, min_purchase_cents: draft.min_purchase_cents,
        first_purchase_only: draft.first_purchase_only, active: draft.active,
      };
      const response = await fetch('/api/store/promotions', {
        method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft.id ? { id: draft.id, promotion } : promotion),
      });
      const body = await response.json().catch(() => ({ success: false, error: 'Promotion could not be saved.' }));
      if (!response.ok || !body.success) throw new Error(body.error ?? 'Promotion could not be saved.');
      const wasUpdate = Boolean(draft.id);
      setDraft(null);
      toast({ title: wasUpdate ? 'Promotion updated' : 'Promotion created', variant: 'success' });
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Promotion could not be saved.', variant: 'error' });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/store/promotions?id=${deleteTarget.id}`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !body.success) throw new Error(body.error ?? 'Promotion could not be deleted.');
      setDeleteTarget(null);
      toast({ title: body.archived ? 'Promotion archived' : 'Promotion deleted', variant: 'success' });
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Promotion could not be deleted.', variant: 'error' });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><h1 className="text-2xl font-bold text-discord-text-primary">Promotions</h1><p className="text-sm text-discord-text-muted">Create checkout-enforced coupon codes for one-time products.</p></div>
        <button type="button" onClick={() => setDraft({ ...EMPTY_DRAFT })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white"><Plus className="h-4 w-4" /> New promotion</button>
      </div>

      <div className="rounded-card border border-discord-accent/35 bg-discord-accent/10 p-4 text-sm text-discord-text-secondary">
        Members enter a code with <code>/store coupon:CODE</code>. Eligibility, dates, first-purchase rules, usage limits, and the final integer-cent price are verified before PayPal opens. The order records the promotion and exact discount.
      </div>

      {loading ? <TableSkeleton rows={3} /> : promotions.length === 0 ? (
        <EmptyState icon={Tags} title="No promotions" description="Create a code for all one-time products or select specific products." />
      ) : <div className="space-y-3">{promotions.map((promotion) => (
        <div key={promotion.id} className="flex flex-col gap-3 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-discord-text-primary">{promotion.name}</span><code className="rounded bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-secondary">{promotion.coupon_code}</code><span className={`rounded-full px-2 py-0.5 text-xs ${promotion.active ? 'bg-discord-success/15 text-discord-success' : 'bg-discord-bg-tertiary text-discord-text-muted'}`}>{promotion.active ? 'Active' : 'Inactive'}</span></div>
            <p className="text-sm text-discord-text-secondary">{formatDiscount(promotion)} · {promotion.applies_to_product_ids.length || 'All'} eligible product{promotion.applies_to_product_ids.length === 1 ? '' : 's'}</p>
            <p className="text-xs text-discord-text-muted">{promotion.current_uses}/{promotion.max_uses ?? 'unlimited'} completed uses{promotion.end_date ? ` · ends ${new Date(promotion.end_date).toLocaleString()}` : ''}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" aria-label={`Edit ${promotion.name}`} onClick={() => setDraft({ ...promotion, start_date: dateInputValue(promotion.start_date), end_date: dateInputValue(promotion.end_date) })} className="flex h-11 w-11 items-center justify-center rounded-input bg-discord-bg-tertiary text-discord-text-secondary hover:text-discord-text-primary"><Pencil className="h-4 w-4" /></button>
            <button type="button" aria-label={`Delete ${promotion.name}`} onClick={() => setDeleteTarget(promotion)} className="flex h-11 w-11 items-center justify-center rounded-input bg-discord-danger/15 text-discord-danger"><Trash2 className="h-4 w-4" /></button>
          </div>
        </div>
      ))}</div>}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDraft(null); }}>
          <div ref={editorRef} role="dialog" aria-modal="true" aria-labelledby="promotion-editor-title" className="my-auto w-full max-w-2xl space-y-5 rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 shadow-xl sm:p-6">
            <h2 id="promotion-editor-title" className="text-lg font-semibold text-discord-text-primary">{draft.id ? 'Edit promotion' : 'New promotion'}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm text-discord-text-secondary">Name<input ref={firstEditorInputRef} value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Coupon code<input value={draft.coupon_code} maxLength={32} onChange={(event) => setDraft({ ...draft, coupon_code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} placeholder="SUMMER25" className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 font-mono text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Discount type<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as PromotionDraft['type'] })} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary"><option value="percentage">Percentage</option><option value="fixed_amount">Fixed amount</option></select></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">{draft.type === 'percentage' ? 'Percent off (1–99)' : 'Amount off (cents)'}<input type="number" min={1} max={draft.type === 'percentage' ? 99 : undefined} value={draft.value} onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Minimum purchase (cents)<input type="number" min={0} value={draft.min_purchase_cents ?? ''} onChange={(event) => setDraft({ ...draft, min_purchase_cents: event.target.value ? Number(event.target.value) : null })} placeholder="No minimum" className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Maximum completed uses<input type="number" min={1} value={draft.max_uses ?? ''} onChange={(event) => setDraft({ ...draft, max_uses: event.target.value ? Number(event.target.value) : null })} placeholder="Unlimited" className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Starts at<input type="datetime-local" value={dateInputValue(draft.start_date)} onChange={(event) => setDraft({ ...draft, start_date: event.target.value || null })} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
              <label className="space-y-1 text-sm text-discord-text-secondary">Ends at<input type="datetime-local" value={dateInputValue(draft.end_date)} onChange={(event) => setDraft({ ...draft, end_date: event.target.value || null })} className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-discord-text-primary" /></label>
            </div>

            <fieldset className="space-y-2 rounded-card border border-discord-border-subtle p-3">
              <legend className="px-1 text-sm font-medium text-discord-text-primary">Eligible one-time products</legend><p className="text-xs text-discord-text-muted">Select none to apply to every one-time product.</p>
              <div className="grid max-h-40 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">{products.map((product) => (
                <label key={product.id} className="flex items-center gap-2 text-sm text-discord-text-secondary"><input type="checkbox" checked={draft.applies_to_product_ids.includes(product.id)} onChange={(event) => setDraft({ ...draft, applies_to_product_ids: event.target.checked ? [...draft.applies_to_product_ids, product.id] : draft.applies_to_product_ids.filter((id) => id !== product.id) })} /><span className="min-w-0 truncate">{product.name}</span></label>
              ))}</div>
            </fieldset>

            <div className="flex flex-col gap-2 text-sm text-discord-text-secondary sm:flex-row sm:gap-6"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.first_purchase_only} onChange={(event) => setDraft({ ...draft, first_purchase_only: event.target.checked })} /> First purchase only</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Accept this code</label></div>
            <div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={() => setDraft(null)} className="min-h-11 rounded-input px-4 py-2 text-discord-text-secondary">Cancel</button><button type="button" disabled={saving || !draft.name.trim() || draft.coupon_code.length < 2 || draft.value < 1 || (draft.type === 'percentage' && draft.value > 99)} onClick={() => void save()} className="min-h-11 rounded-input bg-discord-accent px-4 py-2 font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save promotion'}</button></div>
          </div>
        </div>
      )}

      <ConfirmDialog open={deleteTarget !== null} title="Remove promotion" description={`Remove “${deleteTarget?.name ?? ''}”? Unused promotions are deleted. Promotions referenced by an order are archived so purchase history remains accurate.`} confirmLabel="Remove" variant="danger" loading={saving} onConfirm={() => void remove()} onCancel={() => setDeleteTarget(null)} />
    </div>
  );
}
