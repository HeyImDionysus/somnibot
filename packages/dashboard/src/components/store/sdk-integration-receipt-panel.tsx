'use client';

import * as React from 'react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/shared/button';
import { sdkIntegrationReceiptSchema, type SdkIntegrationDriftState } from '@/lib/store/sdk-contract-identity';
import { sdkVerificationAttestationSchema } from '@/lib/store/licensing-sdk-verification';

const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    identity: z.object({
      contractHash: z.string(),
      sdkSchemaVersion: z.number(),
      sdkProtocolVersion: z.number(),
      productPolicyRevision: z.string(),
      storeProductId: z.string(),
      deploymentOrigin: z.string(),
    }),
    receipt: sdkIntegrationReceiptSchema.nullable(),
    driftState: z.enum([
      'current',
      'reintegration_required',
      'implementation_unverified',
      'older_protocol',
    ]),
  }),
});

const stateCopy: Record<SdkIntegrationDriftState, { readonly label: string; readonly detail: string; readonly tone: string }> = {
  current: {
    label: 'Current',
    detail: 'The recorded implementation passed conformance against this generated contract and saved policy.',
    tone: 'border-discord-success/40 bg-discord-success/10 text-discord-success',
  },
  reintegration_required: {
    label: 'Reintegration required',
    detail: 'The generated contract, saved product policy, product identity, or deployment origin changed.',
    tone: 'border-discord-warning/40 bg-discord-warning/10 text-discord-warning',
  },
  implementation_unverified: {
    label: 'Implementation unverified',
    detail: 'No passing conformance receipt is recorded for this product.',
    tone: 'border-discord-border-strong bg-discord-bg-primary text-discord-text-secondary',
  },
  older_protocol: {
    label: 'Older protocol',
    detail: 'The recorded implementation uses an older SomniBot protocol and must be regenerated.',
    tone: 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger',
  },
};

export function SdkIntegrationReceiptPanel({ productId }: { readonly productId: string }) {
  const [state, setState] = useState<z.infer<typeof responseSchema>['data'] | null>(null);
  const [receiptText, setReceiptText] = useState('');
  const [message, setMessage] = useState('Loading integration status…');
  const [saving, setSaving] = useState(false);

  const endpoint = `/api/license/config/${encodeURIComponent(productId)}/integration-receipt`;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(endpoint);
        const parsed = responseSchema.safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error('invalid receipt status');
        if (!cancelled) {
          setState(parsed.data.data);
          setMessage('');
        }
      } catch {
        if (!cancelled) setMessage('Integration status could not be loaded. Reload and try again.');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [endpoint]);

  const recordReceipt = async () => {
    setSaving(true);
    try {
      const candidate: unknown = JSON.parse(receiptText);
      const verification = sdkVerificationAttestationSchema.safeParse(candidate);
      if (!verification.success) throw new Error('invalid verification');
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verification: verification.data }),
      });
      const parsed = responseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error('receipt rejected');
      setState(parsed.data.data);
      setReceiptText('');
      setMessage('Server-issued receipt recorded from signed conformance evidence.');
    } catch {
      setMessage('Receipt was not recorded. Paste the signed conformance verification package and try again.');
    } finally {
      setSaving(false);
    }
  };

  const presentation = state ? stateCopy[state.driftState] : null;
  return (
    <section className="mt-5 rounded-input border border-discord-border-subtle bg-discord-bg-primary p-4" aria-labelledby={`sdk-receipt-${productId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`sdk-receipt-${productId}`} className="text-sm font-semibold text-discord-text-primary">SDK integration receipt</h3>
          <p className="mt-1 text-xs text-discord-text-muted">After the conformance runner verifies the built project, paste its signed verification package. SomniBot validates it and issues the receipt; an owner cannot self-attest a passing result.</p>
        </div>
        {presentation && <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${presentation.tone}`}>{presentation.label}</span>}
      </div>
      {presentation && <p className="mt-3 text-xs text-discord-text-secondary">{presentation.detail}</p>}
      {state && (
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-discord-text-muted">Contract hash</dt><dd className="break-all font-mono text-discord-text-secondary">{state.identity.contractHash}</dd></div>
          <div><dt className="text-discord-text-muted">Policy revision</dt><dd className="break-all font-mono text-discord-text-secondary">{state.identity.productPolicyRevision}</dd></div>
          <div><dt className="text-discord-text-muted">Protocol</dt><dd className="text-discord-text-secondary">v{state.identity.sdkProtocolVersion}</dd></div>
          <div><dt className="text-discord-text-muted">Target project</dt><dd className="text-discord-text-secondary">{state.receipt ? `${state.receipt.targetProjectVersion} · ${state.receipt.targetProjectCommit}` : 'Not recorded'}</dd></div>
          <div><dt className="text-discord-text-muted">Verification environment</dt><dd className="break-words text-discord-text-secondary">{state.receipt?.verificationEnvironment.description ?? 'Not recorded'}</dd></div>
          <div><dt className="text-discord-text-muted">Proof results</dt><dd className="break-words text-discord-text-secondary">{state.receipt ? `Integrity ${state.receipt.integrityResult} · Authenticity ${state.receipt.authenticityResult} · Conformance ${state.receipt.conformanceResult}` : 'Not recorded'}</dd></div>
          <div><dt className="text-discord-text-muted">Capabilities exercised</dt><dd className="break-words text-discord-text-secondary">{state.receipt ? state.receipt.capabilitiesExercised.join(', ') || 'None' : 'Not recorded'}</dd></div>
          <div><dt className="text-discord-text-muted">Still unverified</dt><dd className="break-words text-discord-text-secondary">{state.receipt ? state.receipt.remainingUnverifiedRequirements.join('; ') || 'None' : 'Not recorded'}</dd></div>
        </dl>
      )}
      <label htmlFor={`sdk-receipt-json-${productId}`} className="mt-4 block text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Signed verification JSON</label>
      <textarea
        id={`sdk-receipt-json-${productId}`}
        rows={6}
        value={receiptText}
        onChange={(event) => setReceiptText(event.target.value)}
        placeholder="Paste signed SomniBot conformance verification"
        className="mt-1 w-full resize-y rounded-input border border-transparent bg-discord-bg-tertiary px-3 py-2 font-mono text-xs text-discord-text-primary focus:border-discord-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void recordReceipt()} disabled={saving || receiptText.trim().length === 0}>
          {saving ? 'Verifying…' : 'Verify and record receipt'}
        </Button>
        {message && <p className="text-xs text-discord-text-secondary" role="status">{message}</p>}
      </div>
    </section>
  );
}
