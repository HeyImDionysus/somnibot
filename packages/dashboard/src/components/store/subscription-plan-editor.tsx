'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import type {
  BillingInterval,
  SubscriptionPlan,
  SubscriptionPlanDraft,
} from './onboarding-types';

type Props = {
  readonly productId: string | null;
  readonly currency: string;
  readonly draft: SubscriptionPlanDraft;
  readonly initialPlans: readonly SubscriptionPlan[];
  readonly onDraftChange: (draft: SubscriptionPlanDraft) => void;
  readonly onReadback: (plans: readonly SubscriptionPlan[]) => void;
};

const intervalOptions = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;

export function SubscriptionPlanEditor({
  productId,
  currency,
  draft,
  initialPlans,
  onDraftChange,
  onReadback,
}: Props) {
  const [plans, setPlans] = useState<readonly SubscriptionPlan[]>(initialPlans);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPlans(initialPlans), [initialPlans]);

  const refreshExisting = async () => {
    if (!productId) return;
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/store/plans?product_id=${encodeURIComponent(productId)}`);
      const body: { success?: boolean; data?: SubscriptionPlan[]; error?: string } = await response.json();
      if (!response.ok || body.success === false || !body.data) {
        setError(body.error ?? 'Authoritative plan readback failed. Retry before relying on these values.');
        return;
      }
      setPlans(body.data);
      onReadback(body.data);
    } catch (caught) {
      if (caught instanceof Error) {
        setError(`Plan readback failed: ${caught.message}.`);
      }
    } finally {
      setChecking(false);
    }
  };

  const fields = (
    value: SubscriptionPlanDraft,
    change: (update: Partial<SubscriptionPlanDraft>) => void,
  ) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Input id="plan-name" label="Plan name" value={value.name} onChange={(event) => change({ name: event.target.value })} className="bg-discord-bg-primary" />
      <Select id="plan-interval" label="Billing interval" value={value.interval_unit} onChange={(event) => change({ interval_unit: event.target.value as BillingInterval })} options={intervalOptions.map((interval) => ({ value: interval, label: interval.toLowerCase() }))} className="bg-discord-bg-primary" />
      <Input id="plan-interval-count" label="Charge every" type="number" min={1} max={12} value={value.interval_count} onChange={(event) => change({ interval_count: Math.max(1, Math.min(12, Number(event.target.value) || 1)) })} className="bg-discord-bg-primary" />
      <Input id="plan-price" label={`Price (${currency})`} type="number" min={0} step="0.01" value={(value.price_cents / 100).toFixed(2)} onChange={(event) => change({ price_cents: Math.max(0, Math.round((Number(event.target.value) || 0) * 100)) })} className="bg-discord-bg-primary" />
      <Input id="plan-trial-days" label="Free trial (days)" type="number" min={0} max={365} value={value.trial_days} onChange={(event) => change({ trial_days: Math.max(0, Math.min(365, Number(event.target.value) || 0)) })} className="bg-discord-bg-primary" />
      <div className="pt-5"><Toggle label="Available for new subscriptions" checked={value.active} onChange={(active) => change({ active })} /></div>
    </div>
  );

  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-tertiary/40 p-4" aria-labelledby="subscription-plan-heading">
      <h3 id="subscription-plan-heading" className="text-sm font-semibold text-discord-text-primary">Subscription plan</h3>
      <p className="mt-1 text-xs text-discord-text-muted">Set the customer-facing cadence, price, trial, and availability. Saved plans are reloaded from the server before they are shown as confirmed.</p>
      <div className="mt-3 space-y-4">
        {productId && plans.length > 0 ? plans.map((plan) => (
          <div key={plan.id} className="space-y-3 rounded-input border border-discord-border-subtle bg-discord-bg-secondary p-3">
            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              <div><dt className="text-discord-text-muted">Plan</dt><dd className="text-discord-text-primary">{plan.name}</dd></div>
              <div><dt className="text-discord-text-muted">Billing</dt><dd className="text-discord-text-primary">{(plan.price_cents / 100).toFixed(2)} {plan.currency} every {plan.interval_count} {plan.interval_unit.toLowerCase()}(s)</dd></div>
              <div><dt className="text-discord-text-muted">Trial and availability</dt><dd className="text-discord-text-primary">{plan.trial_days} trial day(s), {plan.active ? 'available' : 'inactive'}</dd></div>
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-discord-text-muted">PayPal plan ID: {plan.paypal_plan_id ?? 'Not assigned'}</span>
              <Button type="button" variant="secondary" size="sm" disabled={checking} onClick={() => void refreshExisting()}>{checking ? 'Checking…' : 'Refresh saved plan'}</Button>
            </div>
            <p className="text-[11px] text-discord-text-muted">PayPal does not safely rewrite an existing plan&apos;s cadence or trial. Create the intended plan during product setup; this view reports the saved contract without pretending a local edit changed PayPal.</p>
          </div>
        )) : fields(draft, (update) => onDraftChange({ ...draft, ...update }))}
      </div>
      {error && <p className="mt-3 text-sm text-discord-danger" role="alert">{error}</p>}
    </section>
  );
}
