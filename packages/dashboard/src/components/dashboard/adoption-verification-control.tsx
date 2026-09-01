'use client';

import { type AdoptionVerification } from '@/lib/dashboard/adoption-verification';

export function AdoptionVerificationControl({ verification, pending, canManage, onCheck }: {
  readonly verification: AdoptionVerification | undefined;
  readonly pending: boolean;
  readonly canManage: boolean;
  readonly onCheck: () => void;
}) {
  return <div className="mt-3 space-y-2">
    <button type="button" disabled={!canManage || pending} onClick={onCheck} className="min-h-11 rounded-input bg-discord-bg-elevated px-3 text-sm font-medium text-discord-text-primary hover:bg-discord-bg-hover disabled:opacity-60">
      {pending ? 'Checking evidence…' : 'Check recorded evidence'}
    </button>
    <p className="text-xs text-discord-text-muted">Observes this server only. Does not send messages, place bets, make payments, or change Discord.</p>
    <div role="status" aria-live="polite" className="text-xs text-discord-text-secondary">
      {verification ? <>
        <p>{verification.result === 'pass' && verification.eligible ? 'Verified' : verification.result === 'fail' ? 'Failed' : 'Unknown'} — {verification.reason}</p>
        {verification.checkedAt && <p>Checked {new Date(verification.checkedAt).toLocaleString()}{verification.expiresAt && <> · Expires {new Date(verification.expiresAt).toLocaleString()}</>}</p>}
        {verification.evidenceIds.length > 0 && <p>Source: {verification.evidenceIds.length} recorded runtime evidence item(s).</p>}
      </> : <p>No check recorded. Complete the real feature action, then check its evidence here.</p>}
    </div>
  </div>;
}
