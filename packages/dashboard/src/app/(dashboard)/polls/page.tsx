/**
 * Polls & Predictions Management — active/history view, management.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { BarChart3 } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface Poll {
  id: string;
  title: string;
  status: string;
  allow_multiple: boolean;
  created_at: string;
  closed_at: string | null;
}

interface Prediction {
  id: string;
  title: string;
  status: string;
  total_pool: number;
  created_at: string;
  resolved_at: string | null;
}

interface PollsConfig {
  polls_enabled: boolean;
  predictions_enabled: boolean;
  max_poll_options: number;
  allow_multiple_default: boolean;
  prediction_min_bet: number;
  prediction_max_bet: number;
}

// ── Helpers ───────────────────────────────────────────────

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-brand-primary' : 'bg-discord-bg-tertiary'}`}
        onClick={() => onChange(!checked)}
      >
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </div>
      <span className="text-sm text-discord-text-primary">{label}</span>
    </label>
  );
}

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400',
  closed: 'bg-gray-500/20 text-gray-400',
  open: 'bg-green-500/20 text-green-400',
  locked: 'bg-yellow-500/20 text-yellow-400',
  resolved: 'bg-blue-500/20 text-blue-400',
  cancelled: 'bg-red-500/20 text-red-400',
};

// ── Page ──────────────────────────────────────────────────

export default function PollsPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<PollsConfig>({ polls_enabled: false, predictions_enabled: false, max_poll_options: 10, allow_multiple_default: false, prediction_min_bet: 1, prediction_max_bet: 0 });
  const [polls, setPolls] = useState<Poll[]>([]);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, pollsRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/polls'),
      ]);
      if (cfgRes.ok) {
        const json = await cfgRes.json();
        const gc = json.config ?? {};
        setConfig({
          polls_enabled: gc.polls_enabled ?? false,
          predictions_enabled: gc.predictions_enabled ?? false,
          max_poll_options: gc.max_poll_options ?? 10,
          allow_multiple_default: gc.allow_multiple_default ?? false,
          prediction_min_bet: gc.prediction_min_bet ?? 1,
          prediction_max_bet: gc.prediction_max_bet ?? 0,
        });
      }
      if (pollsRes.ok) {
        const json = await pollsRes.json();
        setPolls(json.polls ?? []);
        setPredictions(json.predictions ?? []);
      }
    } catch {
      toast({ title: 'Failed to load', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<PollsConfig>) => {
    const updated = { ...config, ...patch };
    setConfig(updated);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Settings saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-discord-text-primary flex items-center gap-2">
        <BarChart3 className="w-6 h-6" /> Polls & Predictions
      </h1>

      {/* Config */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3">
        <Toggle label="Enable Polls" checked={config.polls_enabled} onChange={(v) => saveConfig({ polls_enabled: v })} />
        <Toggle label="Enable Predictions (currency bets)" checked={config.predictions_enabled} onChange={(v) => saveConfig({ predictions_enabled: v })} />
        <label className="flex items-center gap-3 text-sm text-discord-text-primary">Max poll options
          <input type="number" min={2} max={10} value={config.max_poll_options} onChange={(e) => saveConfig({ max_poll_options: Number(e.target.value) })} className="w-20 rounded bg-discord-bg-tertiary px-2 py-1" />
        </label>
        <Toggle label="Allow multiple selections by default" checked={config.allow_multiple_default} onChange={(v) => saveConfig({ allow_multiple_default: v })} />
        <div className="flex flex-wrap gap-4 text-sm text-discord-text-primary">
          <label>Minimum prediction bet <input type="number" min={1} value={config.prediction_min_bet} onChange={(e) => saveConfig({ prediction_min_bet: Number(e.target.value) })} className="ml-2 w-28 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
          <label>Maximum (0 = uncapped) <input type="number" min={0} value={config.prediction_max_bet} onChange={(e) => saveConfig({ prediction_max_bet: Number(e.target.value) })} className="ml-2 w-28 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
        </div>
      </div>

      {/* Polls List */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4">
        <h2 className="text-lg font-semibold text-discord-text-primary mb-3">Polls ({polls.length})</h2>
        {polls.length === 0 ? (
          <EmptyState icon={BarChart3} title="No polls" description="Polls created with /poll will appear here." />
        ) : (
          <div className="space-y-2">
            {polls.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-3">
                <div>
                  <p className="text-sm text-discord-text-primary">{p.title}</p>
                  <p className="text-xs text-discord-text-secondary">{new Date(p.created_at).toLocaleDateString()}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[p.status] ?? ''}`}>{p.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Predictions List */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4">
        <h2 className="text-lg font-semibold text-discord-text-primary mb-3">Predictions ({predictions.length})</h2>
        {predictions.length === 0 ? (
          <EmptyState icon={BarChart3} title="No predictions" description="Predictions created with /predict will appear here." />
        ) : (
          <div className="space-y-2">
            {predictions.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-3">
                <div>
                  <p className="text-sm text-discord-text-primary">{p.title}</p>
                  <p className="text-xs text-discord-text-secondary">Pool: {p.total_pool.toLocaleString()} coins • {new Date(p.created_at).toLocaleDateString()}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[p.status] ?? ''}`}>{p.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
