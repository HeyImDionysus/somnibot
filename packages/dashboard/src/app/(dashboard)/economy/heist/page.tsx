/**
 * Economy Heist Management — heist config + heist history.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Swords, CheckCircle, XCircle, Clock, Minus } from 'lucide-react';

interface HeistConfig {
  economy_heist_enabled: boolean;
  economy_heist_min_participants: number;
  economy_heist_max_participants: number;
  economy_heist_join_window_secs: number;
  economy_heist_cooldown_seconds: number;
  economy_heist_base_payout: number;
  economy_heist_success_base_pct: number;
  economy_heist_entry_fee: number;
}

interface HeistRecord {
  id: string;
  status: string;
  target_name: string;
  target_payout: number;
  // Derived by /api/economy/heist from the participant ROWS (the single source of
  // truth) + base_success_chance — the economy_heists.participants[] array and the
  // stored success_chance counter were dropped (migration 20260710180000). The API
  // synthesizes these two fields so this shape is unchanged for the UI.
  participants: string[];
  success_chance: number;
  created_at: string;
  resolved_at: string | null;
}

const DEFAULT_CONFIG: HeistConfig = {
  economy_heist_enabled: false,
  economy_heist_min_participants: 2,
  economy_heist_max_participants: 8,
  economy_heist_join_window_secs: 60,
  economy_heist_cooldown_seconds: 300,
  economy_heist_base_payout: 500,
  economy_heist_success_base_pct: 40,
  economy_heist_entry_fee: 100,
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  success: <CheckCircle className="w-4 h-4 text-green-400" />,
  failed: <XCircle className="w-4 h-4 text-red-400" />,
  recruiting: <Clock className="w-4 h-4 text-yellow-400" />,
  in_progress: <Clock className="w-4 h-4 text-orange-400" />,
  cancelled: <Minus className="w-4 h-4 text-gray-400" />,
};

export default function HeistPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<HeistConfig>(DEFAULT_CONFIG);
  const [heists, setHeists] = useState<HeistRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, heistRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/heist'),
      ]);
      if (cfgRes.ok) {
        const json = await cfgRes.json();
        const gc = json.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (heistRes.ok) {
        const hJson = await heistRes.json();
        setHeists(hJson.data ?? []);
      }
    } catch {
      toast({ title: 'Failed to load heist data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<HeistConfig>) => {
    const merged = { ...config, ...patch };
    setConfig(merged);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Heist settings saved!', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Heists</h1>
          <p className="text-discord-text-secondary">Configure multi-user cooperative heist settings.</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={config.economy_heist_enabled}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_enabled: e.target.checked })}
            className="rounded" />
          <span className="text-sm text-discord-text-primary">Enable Heists</span>
        </label>
      </div>

      {!config.economy_heist_enabled ? (
        <EmptyState icon={Swords} title="Heists Disabled" description="Enable heists above to let users plan and execute multi-user heists." />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Entry Fee (coins)</label>
              <input type="number" min={0} value={config.economy_heist_entry_fee}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_entry_fee: parseInt(e.target.value) || 0 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Base Payout (coins)</label>
              <input type="number" min={100} value={config.economy_heist_base_payout}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_base_payout: parseInt(e.target.value) || 500 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Base Success %</label>
              <input type="number" min={5} max={95} value={config.economy_heist_success_base_pct}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_success_base_pct: parseInt(e.target.value) || 40 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Cooldown (seconds)</label>
              <input type="number" min={60} value={config.economy_heist_cooldown_seconds}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_cooldown_seconds: parseInt(e.target.value) || 300 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Min Participants</label>
              <input type="number" min={2} max={10} value={config.economy_heist_min_participants}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_min_participants: parseInt(e.target.value) || 2 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Max Participants</label>
              <input type="number" min={2} max={20} value={config.economy_heist_max_participants}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_max_participants: parseInt(e.target.value) || 8 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div className="bg-discord-bg-secondary rounded-lg p-4">
              <label className="text-sm text-discord-text-secondary">Join Window (seconds)</label>
              <input type="number" min={15} max={300} value={config.economy_heist_join_window_secs}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_heist_join_window_secs: parseInt(e.target.value) || 60 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary mb-3">Recent Heists</h2>
            {heists.length === 0 ? (
              <EmptyState icon={Swords} title="No Heists Yet" description="No heists have been attempted. Users can start one with /heist start." />
            ) : (
              <div className="space-y-2">
                {heists.map((h) => (
                  <div key={h.id} className="bg-discord-bg-secondary rounded-lg p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {STATUS_ICONS[h.status] ?? null}
                      <div>
                        <span className="text-discord-text-primary font-medium">{h.target_name}</span>
                        <span className="ml-2 text-sm text-discord-text-secondary">
                          👥 {h.participants.length} — 💰 {h.target_payout.toLocaleString()} — 🎯 {h.success_chance}%
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        h.status === 'success' ? 'bg-green-500/20 text-green-300' :
                        h.status === 'failed' ? 'bg-red-500/20 text-red-300' :
                        h.status === 'cancelled' ? 'bg-gray-500/20 text-gray-300' :
                        'bg-yellow-500/20 text-yellow-300'
                      }`}>
                        {h.status.toUpperCase()}
                      </span>
                      <div className="text-xs text-discord-text-secondary mt-1">
                        {new Date(h.resolved_at ?? h.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
