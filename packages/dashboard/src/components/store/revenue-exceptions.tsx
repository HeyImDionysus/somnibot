'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';

const riskSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['suspected_fraud', 'confirmed_fraud', 'payment_dispute', 'chargeback', 'ordinary_refund', 'duplicate_payment', 'support_cancellation']),
  state: z.string(),
  fulfillment_action: z.string(),
  entitlement_action: z.string(),
  customer_notification: z.string(),
  version: z.number().int().positive(),
  commerce_risk_effect_actions: z.array(z.object({
    id: z.string().uuid(),
    effect_kind: z.enum(['fulfillment', 'entitlement', 'notification']),
    requested_action: z.string(),
    state: z.enum(['pending', 'processing', 'completed', 'failed', 'compensated']),
    attempt_count: z.number().int().nonnegative(),
  })).optional().default([]),
});
const exceptionSchema = z.object({
  id: z.string().uuid(),
  category: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  state: z.enum(['open', 'in_progress', 'resolved', 'compensated', 'dismissed']),
  owner_id: z.string().nullable(),
  operation_id: z.string().uuid(),
  order_id: z.string().uuid().nullable(),
  title: z.string(),
  safe_detail: z.string().nullable(),
  version: z.number().int().positive(),
  detected_at: z.string(),
  commerce_risk_cases: z.union([z.array(riskSchema), riskSchema.nullable()])
    .transform((value) => Array.isArray(value) ? value : value ? [value] : []),
});
type RevenueException = z.infer<typeof exceptionSchema>;
type ExceptionAction = 'claim' | 'resolve' | 'compensate' | 'dismiss';

export function RevenueExceptions({ onInspectOrder }: { readonly onInspectOrder: (orderId: string) => void }) {
  const [rows, setRows] = useState<RevenueException[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/store/revenue-exceptions');
      const body = await response.json();
      const parsed = z.array(exceptionSchema).safeParse(body.data);
      if (!response.ok || !parsed.success) {
        setError(typeof body.error === 'string' ? body.error : 'Revenue exceptions could not be verified.');
        return;
      }
      setRows(parsed.data.filter((row) => row.state === 'open' || row.state === 'in_progress'));
      setCheckedAt(typeof body.checkedAt === 'string' ? body.checkedAt : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Revenue exceptions could not be verified.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (row: RevenueException, action: ExceptionAction) => {
    const note = notes[row.id]?.trim() ?? '';
    if (action !== 'claim' && !note) return;
    setBusy(row.id);
    setError(null);
    try {
      const response = await fetch(`/api/store/revenue-exceptions/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'claim'
          ? { action, version: row.version }
          : { action, version: row.version, resolutionCode: action, resolutionNote: note }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'The exception could not be updated.');
      } else {
        setNotes((current) => ({ ...current, [row.id]: '' }));
        await load();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The exception could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  const risk = async (
    row: RevenueException,
    riskCase: z.infer<typeof riskSchema>,
    transition: 'confirm_fraud' | 'record_chargeback' | 'record_refund' | 'dismiss',
  ) => {
    const note = notes[row.id]?.trim() ?? '';
    if (!note) return;
    setBusy(row.id);
    setError(null);
    try {
      const response = await fetch(`/api/store/revenue-exceptions/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'risk_transition', riskCaseId: riskCase.id, riskVersion: riskCase.version, transition, resolutionNote: note }),
      });
      const body = await response.json();
      if (!response.ok) setError(typeof body.error === 'string' ? body.error : 'The risk case could not be updated.');
      else await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The risk case could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="revenue-exceptions-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="revenue-exceptions-heading" className="text-lg font-semibold text-discord-text-primary">Revenue exceptions</h2>
          <p className="mt-1 text-xs text-discord-text-muted">Payment state and SomniBot entitlement state stay separate. Claim, investigate, compensate, or resolve each durable exception with operation history.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load()}>Refresh</Button>
      </div>
      {checkedAt && <p className="mt-2 text-[11px] text-discord-text-muted">Authoritative readback {new Date(checkedAt).toLocaleString()}</p>}
      {error && <p className="mt-3 text-sm text-discord-danger" role="alert">{error}</p>}
      <div className="mt-4 space-y-3">
        {rows.length === 0 && <p className="text-sm text-discord-text-muted">No open commerce exception was recorded.</p>}
        {rows.map((row) => {
          const note = notes[row.id] ?? '';
          const riskCase = row.commerce_risk_cases[0];
          return (
            <article key={row.id} className={`rounded-input border p-4 ${row.severity === 'critical' ? 'border-discord-danger/40 bg-discord-danger/5' : 'border-discord-warning/40 bg-discord-warning/5'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-discord-bg-primary px-2 py-0.5 text-[11px] text-discord-text-secondary">{row.severity}</span>
                    <span className="rounded-full bg-discord-bg-primary px-2 py-0.5 text-[11px] text-discord-text-secondary">{row.category.replaceAll('_', ' ')}</span>
                    <span className="text-xs text-discord-text-muted">{row.state}</span>
                  </div>
                  <h3 className="mt-2 text-sm font-medium text-discord-text-primary">{row.title}</h3>
                  {row.safe_detail && <p className="mt-1 text-xs text-discord-text-secondary">{row.safe_detail}</p>}
                  <p className="mt-1 font-mono text-[11px] text-discord-text-muted">Operation {row.operation_id}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {row.order_id && <Button size="sm" variant="secondary" onClick={() => onInspectOrder(row.order_id ?? '')}>Inspect access map</Button>}
                  {row.state === 'open' && <Button size="sm" onClick={() => void act(row, 'claim')} disabled={busy !== null}>Claim</Button>}
                </div>
              </div>
              <label className="mt-3 block text-xs font-medium text-discord-text-secondary">
                Resolution or investigation note
                <textarea value={note} onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))} rows={2} maxLength={2000} className="mt-1 w-full rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary" />
              </label>
              {riskCase && (
                <div className="mt-3 rounded-input bg-discord-bg-primary p-3">
                  <p className="text-xs text-discord-text-secondary">Risk: {riskCase.kind.replaceAll('_', ' ')} · fulfillment {riskCase.fulfillment_action} · entitlement {riskCase.entitlement_action} · notification {riskCase.customer_notification}</p>
                  {riskCase.commerce_risk_effect_actions.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-discord-text-muted">
                      {riskCase.commerce_risk_effect_actions.map((effect) => (
                        <li key={effect.id}>{effect.effect_kind}: {effect.requested_action} · {effect.state} · {effect.attempt_count} attempt{effect.attempt_count === 1 ? '' : 's'}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {riskCase.kind === 'suspected_fraud' && <Button size="sm" variant="danger" disabled={!note.trim() || busy !== null} onClick={() => void risk(row, riskCase, 'confirm_fraud')}>Confirm fraud</Button>}
                    {riskCase.kind === 'payment_dispute' && <Button size="sm" variant="danger" disabled={!note.trim() || busy !== null} onClick={() => void risk(row, riskCase, 'record_chargeback')}>Record chargeback</Button>}
                    {['payment_dispute', 'duplicate_payment', 'support_cancellation'].includes(riskCase.kind) && <Button size="sm" variant="secondary" disabled={!note.trim() || busy !== null} onClick={() => void risk(row, riskCase, 'record_refund')}>Record ordinary refund</Button>}
                    {['suspected_fraud', 'ordinary_refund', 'support_cancellation'].includes(riskCase.kind) && <Button size="sm" variant="ghost" disabled={!note.trim() || busy !== null} onClick={() => void risk(row, riskCase, 'dismiss')}>Dismiss risk</Button>}
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={!note.trim() || busy !== null} onClick={() => void act(row, 'dismiss')}>Dismiss exception</Button>
                <Button size="sm" variant="secondary" disabled={!note.trim() || busy !== null} onClick={() => void act(row, 'compensate')}>Record compensation</Button>
                <Button size="sm" disabled={!note.trim() || busy !== null} onClick={() => void act(row, 'resolve')}>Resolve with evidence</Button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
