'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AlertTriangle, CheckCircle2, CircleOff, HelpCircle } from 'lucide-react';
import {
  deriveFeatureReadiness,
  featureForPath,
  type FeatureReadiness,
} from '@/lib/dashboard/feature-status';

const STATE_STYLE: Record<FeatureReadiness['state'], string> = {
  operational: 'border-discord-success/30 bg-discord-success/10 text-discord-success',
  disabled: 'border-discord-border-subtle bg-discord-bg-secondary text-discord-text-secondary',
  blocked: 'border-discord-danger/40 bg-discord-danger/10 text-discord-danger',
  unavailable: 'border-discord-warning/30 bg-discord-warning/10 text-discord-warning',
};

function StatusIcon({ state }: { state: FeatureReadiness['state'] }) {
  if (state === 'operational') return <CheckCircle2 size={18} />;
  if (state === 'disabled') return <CircleOff size={18} />;
  if (state === 'blocked') return <AlertTriangle size={18} />;
  return <HelpCircle size={18} />;
}

export function FeatureStatusPanel() {
  const pathname = usePathname();
  const feature = featureForPath(pathname);
  const [status, setStatus] = useState<FeatureReadiness | null>(null);
  // Monotonic request sequence. Navigating features while a status request is
  // in flight left BOTH requests able to call setStatus, so a slower response
  // for the previous route could overwrite the newer route's result — e.g. an
  // Economy page wearing "Store and fulfillment: enabled and reachable" until
  // the next refresh. Only the most recent request may publish.
  const requestSeq = useRef(0);

  const refresh = useCallback(async (background?: unknown) => {
    if (!feature) return;
    const seq = ++requestSeq.current;
    const publish = (next: FeatureReadiness | null) => {
      if (seq === requestSeq.current) setStatus(next);
    };
    // Background polls keep the last verdict visible while the new one loads;
    // only user-driven refreshes blank to "Checking…". Strict === true because
    // the button handler passes a MouseEvent here.
    if (background !== true) publish(null);
    try {
      const response = await fetch('/api/dashboard/feature-status');
      const payload = await response.json();
      const config = response.ok && payload.success && payload.data?.config
        && typeof payload.data.config === 'object'
        ? payload.data.config as Record<string, unknown>
        : null;
      const bot = response.ok && payload.success
        ? payload.data?.bot
        : null;
      publish(deriveFeatureReadiness({
        feature,
        config,
        botOnline: typeof bot?.online === 'boolean' ? bot.online : null,
        staleSecs: typeof bot?.staleSecs === 'number' ? bot.staleSecs : null,
        runtimeFeatures: response.ok && payload.success
          && Array.isArray(payload.data?.runtimeFeatures)
          ? payload.data.runtimeFeatures as string[]
          : null,
      }));
    } catch {
      publish({
        state: 'unavailable',
        heading: `${feature.label}: status unavailable`,
        detail: 'The saved configuration and bot heartbeat could not be verified.',
      });
    }
  }, [feature]);

  useEffect(() => {
    refresh();
    // A verdict derived from a fresh heartbeat goes stale while the page sits
    // open: the two-minute cutoff can pass with the panel still reading
    // "enabled and reachable" hours later. Re-derive on a cadence comfortably
    // inside the cutoff instead of trusting one load-time snapshot.
    const timer = setInterval(() => {
      void refresh(true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!feature) return null;

  if (!status) {
    return (
      <section className="mb-5 rounded-md border border-discord-border-subtle bg-discord-bg-secondary px-4 py-3" aria-label={`${feature.label} status`}>
        <p className="text-sm text-discord-text-muted">Checking {feature.label.toLowerCase()} status…</p>
      </section>
    );
  }

  return (
    <section
      className={`mb-5 flex items-start gap-3 rounded-md border px-4 py-3 ${STATE_STYLE[status.state]}`}
      aria-label={`${feature.label} status`}
      aria-live="polite"
    >
      <span className="mt-0.5 shrink-0"><StatusIcon state={status.state} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{status.heading}</p>
        <p className="mt-0.5 text-xs opacity-80">{status.detail}</p>
      </div>
      <button type="button" onClick={refresh} className="text-xs font-medium underline opacity-80 hover:opacity-100">
        Refresh
      </button>
    </section>
  );
}
