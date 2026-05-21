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
  const [config, setConfig] = useState<PollsConfig>({ polls_enabled: false, predictions_enabled: false });
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
        const gc = json.guild_config ?? json;
        setConfig({
          polls_enabled: gc.polls_enabled ?? false,
          predictions_enabled: gc.predictions_enabled ?? false,
        });
      }
      if (pollsRes.ok) {
        const json = await pollsRes.json();
        setPolls(json.polls ?? []);
        setPredictions(json.predictions ?? []);
      }
    } catch {
      toast({ title: 'Failed to load', variant: 'destructive' });
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
      toast({ title: 'Settings saved', variant: 'default' });
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-discord-text-primary flex items-center gap-2">
        <BarChart3 className="w-6 h-6" /> Polls & Predictions
      </h1>

      {/* Config */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 space-y-3">
        <Toggle label="Enable Polls" checked={config.polls_enabled} onChange={(v) => saveConfig({ polls_enabled: v })} />
        <Toggle label="Enable Predictions (currency bets)" checked={config.predictions_enabled} onChange={(v) => saveConfig({ predictions_enabled: v })} />
      </div>

      {/* Polls List */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
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
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
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
