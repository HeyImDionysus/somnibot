'use client';

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/shared/button';
import { describePayPalReadiness } from '@/lib/store/commerce-onboarding';
import type { PayPalOnboardingStatus } from './onboarding-types';

type Props = {
  readonly onStatus: (status: PayPalOnboardingStatus) => void;
};

export function PayPalOnboardingStatusPanel({ onStatus }: Props) {
  const [status, setStatus] = useState<PayPalOnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch('/api/store/onboarding');
      const body: { success?: boolean; data?: PayPalOnboardingStatus; error?: string } = await response.json();
      if (!response.ok || body.success === false || !body.data) {
        setError(body.error ?? 'PayPal status could not be checked.');
        return;
      }
      setStatus(body.data);
      onStatus(body.data);
    } catch (caught) {
      if (caught instanceof Error) setError(`PayPal status could not be checked: ${caught.message}`);
    } finally {
      setChecking(false);
    }
  }, [onStatus]);

  useEffect(() => { void check(); }, [check]);
  const readiness = status ? describePayPalReadiness(status) : null;

  return (
    <section className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5" aria-labelledby="paypal-onboarding-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="paypal-onboarding-heading" className="text-lg font-semibold text-discord-text-primary">PayPal onboarding</h2>
          <p className="mt-1 text-xs text-discord-text-muted">Observed configuration and webhook evidence for the selected server. No payment is started by this check.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => void check()} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</Button>
      </div>
      {readiness && status && (
        <div className={`mt-4 rounded-input border p-3 ${readiness.ready ? 'border-discord-success/50 bg-discord-success/10' : 'border-discord-warning/50 bg-discord-warning/10'}`} aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm text-discord-text-primary">{readiness.title}</strong>
            <span className="rounded-full bg-discord-bg-primary px-2 py-0.5 text-xs text-discord-text-secondary">{status.environment === 'sandbox' ? 'Sandbox' : 'Live'} environment</span>
          </div>
          <p className="mt-1 text-xs text-discord-text-secondary">{readiness.detail}</p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-discord-text-muted">Webhook URL</dt><dd className="break-all font-mono text-discord-text-secondary">{status.webhookUrl ?? 'Not configured'}</dd></div>
            <div><dt className="text-discord-text-muted">Last checked</dt><dd className="text-discord-text-secondary">{new Date(status.checkedAt).toLocaleString()}</dd></div>
          </dl>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-discord-danger" role="alert">{error}</p>}
    </section>
  );
}
