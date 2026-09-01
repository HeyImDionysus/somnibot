'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, CirclePause, FlaskConical, LockKeyhole } from 'lucide-react';
import { ADOPTION_TRACKS, adoptionMapMutationFromState, adoptionTrackStateSchema, blockedDependencies, defaultAdoptionMapState, type AdoptionMapState, type AdoptionTrackState } from '@/lib/dashboard/adoption-map';
import { z } from 'zod';
import { adoptionVerificationSchema, currentVerifiedTrackIds, type AdoptionVerification } from '@/lib/dashboard/adoption-verification';
import { AdoptionVerificationControl } from './adoption-verification-control';

const STATE_LABEL: Record<AdoptionTrackState, string> = {
  not_started: 'Not started', in_progress: 'In progress', ready: 'Ready to test', active: 'Active', paused: 'Paused', skipped: 'Skipped',
};

export function AdoptionMap({ canManage }: { readonly canManage: boolean }) {
  const [state, setState] = useState<AdoptionMapState>(defaultAdoptionMapState);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<AdoptionVerification[]>([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void fetch('/api/dashboard/adoption').then(async (response) => {
      if (!response.ok) throw new Error('adoption-map-unavailable');
      const result: { readonly data: { readonly state: AdoptionMapState; readonly updatedAt: string | null; readonly verifications: unknown } } = await response.json();
      setVerifications(z.array(adoptionVerificationSchema).parse(result.data.verifications));
      setState(result.data.state); setUpdatedAt(result.data.updatedAt);
    }).catch(() => setMessage('The saved adoption map could not be loaded.')).finally(() => setLoading(false));
  }, []);

  const checkEvidence = async (trackId: string) => {
    setChecking(true); setMessage(null);
    try {
      const response = await fetch('/api/dashboard/adoption/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ trackId }) });
      if (!response.ok) throw new Error('Evidence could not be checked. Retry when the service is available.');
      const refreshed = await fetch('/api/dashboard/adoption');
      if (!refreshed.ok) throw new Error('The check completed, but current evidence could not be refreshed. Reload before activating.');
      const result: { readonly data: { readonly verifications: unknown } } = await refreshed.json();
      const current = z.array(adoptionVerificationSchema).max(13).parse(result.data.verifications);
      setVerifications(current);
      setState((draft) => ({ ...draft, verifiedTrackIds: [...currentVerifiedTrackIds(current, Date.now())] }));
      setMessage('Current evidence refreshed. Draft selections are unchanged.');
    } catch (error) {
      setState((draft) => ({ ...draft, verifiedTrackIds: draft.verifiedTrackIds.filter((id) => id !== trackId) }));
      setMessage(error instanceof Error ? error.message : 'Evidence check failed.');
    } finally { setChecking(false); }
  };

  const selectedTracks = useMemo(() => ADOPTION_TRACKS.filter((track) => state.selectedTrackIds.includes(track.id)), [state.selectedTrackIds]);
  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch('/api/dashboard/adoption', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(adoptionMapMutationFromState(state)) });
      const result: { readonly data?: { readonly state: AdoptionMapState; readonly updatedAt: string }; readonly error?: string } = await response.json();
      if (!response.ok || !result.data) throw new Error(result.error ?? 'save-failed');
      setState(result.data.state); setUpdatedAt(result.data.updatedAt); setMessage('Adoption map saved from authoritative readback.');
    } catch (error) {
      setMessage(error instanceof Error && error.message !== 'save-failed' ? error.message : 'The adoption map could not be saved. Your selections remain on this page.');
    } finally { setSaving(false); }
  };

  if (loading) return <section aria-label="Adoption map loading" className="h-64 animate-pulse rounded-card bg-discord-bg-elevated motion-reduce:animate-none" />;

  return (
    <section aria-labelledby="adoption-heading" className="rounded-panel bg-discord-bg-elevated p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div><h2 id="adoption-heading" className="text-lg font-semibold text-discord-text-primary">Adoption and readiness map</h2><p className="mt-1 max-w-3xl text-sm text-discord-text-secondary">Choose independent setup tracks, see real dependency blocks, pause work, test before activation, and reopen guidance whenever needed.</p>{updatedAt && <p className="mt-1 text-xs text-discord-text-muted">Saved {new Date(updatedAt).toLocaleString()}</p>}</div>
        <div className="flex flex-wrap gap-3"><label className="text-xs text-discord-text-muted">Working mode<select disabled={!canManage} value={state.mode} onChange={(event) => setState({ ...state, mode: event.target.value === 'expert' ? 'expert' : 'guided' })} className="ml-2 min-h-11 rounded-input border border-discord-border-strong bg-discord-bg-primary px-3 text-sm text-discord-text-primary disabled:opacity-60"><option value="guided">Guided</option><option value="expert">Expert</option></select></label><button type="button" disabled={!canManage} onClick={() => setState({ ...state, tutorialVisible: !state.tutorialVisible })} className="min-h-11 rounded-input bg-discord-bg-primary px-3 text-sm font-medium text-discord-text-primary disabled:opacity-60">{state.tutorialVisible ? 'Hide guidance' : 'Show guidance'}</button></div>
      </div>

      {state.tutorialVisible && <div className="mt-5 rounded-card border border-discord-accent/30 bg-discord-accent/10 p-4 text-sm text-discord-text-secondary"><strong className="text-discord-text-primary">{state.mode === 'guided' ? 'Guided mode:' : 'Expert mode:'}</strong> {state.mode === 'guided' ? 'Follow each selected track from configure, through its test surface, to activation. Required infrastructure cannot be skipped.' : 'All controls remain visible, but dependency and verification gates still apply.'}</div>}

      <fieldset disabled={!canManage} className="mt-5"><legend className="text-sm font-medium text-discord-text-primary">Tracks in this plan</legend><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ADOPTION_TRACKS.map((track) => <label key={track.id} className="flex min-h-11 items-center gap-3 rounded-input bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-secondary"><input type="checkbox" checked={state.selectedTrackIds.includes(track.id)} disabled={track.required || !canManage} onChange={(event) => setState({ ...state, selectedTrackIds: event.target.checked ? [...state.selectedTrackIds, track.id] : state.selectedTrackIds.filter((id) => id !== track.id) })} className="h-5 w-5 accent-discord-accent" /><span>{track.label}{track.required && <span className="ml-2 text-xs text-discord-warning">Required</span>}</span></label>)}</div></fieldset>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">{selectedTracks.map((track) => {
        const dependencies = blockedDependencies(track, state);
        const verified = state.verifiedTrackIds.includes(track.id);
        const trackState = state.trackStates[track.id] ?? 'not_started';
        return <article key={track.id} className="rounded-card bg-discord-bg-primary p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium text-discord-text-primary">{track.label}</h3><p className="mt-1 text-sm text-discord-text-muted">{track.description}</p></div>{verified ? <CheckCircle2 className="shrink-0 text-discord-success" size={20} aria-label="Verified by recorded feature evidence" /> : <FlaskConical className="shrink-0 text-discord-text-muted" size={20} aria-label="Verified feature evidence required" />}</div>{dependencies.length > 0 && <p className="mt-3 flex items-start gap-2 text-xs text-discord-warning"><LockKeyhole size={14} className="mt-0.5 shrink-0" aria-hidden="true" />Blocked by {dependencies.map((id) => ADOPTION_TRACKS.find((candidate) => candidate.id === id)?.label ?? id).join(', ')}</p>}<div className="mt-4 flex flex-wrap items-center gap-2"><Link href={track.href} className="inline-flex min-h-11 items-center rounded-input bg-discord-bg-elevated px-3 text-sm font-medium text-discord-text-primary hover:bg-discord-bg-hover">Configure</Link><Link href={track.testHref} className="inline-flex min-h-11 items-center rounded-input bg-discord-bg-elevated px-3 text-sm font-medium text-discord-text-primary hover:bg-discord-bg-hover">Open test</Link><label className="text-xs text-discord-text-muted">State<select disabled={!canManage} value={trackState} onChange={(event) => { const nextState = adoptionTrackStateSchema.safeParse(event.target.value); if (nextState.success) setState({ ...state, trackStates: { ...state.trackStates, [track.id]: nextState.data } }); }} className="ml-2 min-h-11 rounded-input border border-discord-border-strong bg-discord-bg-elevated px-3 text-sm text-discord-text-primary"><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="ready">Ready to test</option><option value="paused">Paused</option><option value="active" disabled={!verified || dependencies.length > 0}>Active</option>{!track.required && <option value="skipped">Skipped</option>}</select></label>{trackState === 'paused' && <CirclePause size={18} className="text-discord-warning" aria-label="Paused" />}</div><p className="mt-2 text-xs text-discord-text-muted">Current state: {STATE_LABEL[trackState]}{verified ? ' · Verified by recorded feature evidence' : ' · no valid feature evidence recorded'}</p><AdoptionVerificationControl verification={verifications.find((item) => item.trackId === track.id)} pending={checking} canManage={canManage && !saving} onCheck={() => { void checkEvidence(track.id); }} /></article>;
      })}</div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" aria-live="polite" className="text-sm text-discord-text-secondary">{message ?? (canManage ? 'Changes remain draft until saved.' : 'Only the server owner can change this map.')}</p>{canManage && <button type="button" disabled={saving || checking} onClick={save} className="min-h-11 rounded-input bg-discord-accent px-5 text-sm font-semibold text-white hover:bg-discord-accent-hover disabled:opacity-60">{saving ? 'Saving…' : 'Save adoption map'}</button>}</div>
    </section>
  );
}
