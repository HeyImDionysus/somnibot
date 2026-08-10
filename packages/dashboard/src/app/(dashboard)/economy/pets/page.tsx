/**
 * Economy Pets Management — pet type settings, battle config, prestige config.
 * FAKE economy only.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { PawPrint } from 'lucide-react';

interface PetsConfig {
  economy_pets_enabled: boolean;
  economy_pet_decay_rate: number;
  economy_pet_decay_interval_hours: number;
  economy_pet_low_stat_threshold: number;
  economy_pet_notify_owner: boolean;
  economy_pet_battle_enabled: boolean;
  economy_pet_prestige_enabled: boolean;
  economy_pet_feed_cost: number;
  economy_pet_train_cost: number;
}

const DEFAULT_CONFIG: PetsConfig = {
  economy_pets_enabled: true,
  economy_pet_decay_rate: 5,
  economy_pet_decay_interval_hours: 1,
  economy_pet_low_stat_threshold: 20,
  economy_pet_notify_owner: true,
  economy_pet_battle_enabled: true,
  economy_pet_prestige_enabled: true,
  economy_pet_feed_cost: 50,
  economy_pet_train_cost: 100,
};

export default function PetsPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<PetsConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/guild');
      if (res.ok) {
        const json = await res.json();
        const gc = json.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
    } catch {
      toast({ title: 'Failed to load pet settings', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<PetsConfig>) => {
    const merged = { ...config, ...patch };
    setConfig(merged);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Settings saved!', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Virtual Pets</h1>
          <p className="text-discord-text-secondary">Configure the pet system — types, care, battles, prestige.</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.economy_pets_enabled}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pets_enabled: e.target.checked })}
            className="rounded"
          />
          <span className="text-sm text-discord-text-primary">Enable Pets</span>
        </label>
      </div>

      {!config.economy_pets_enabled ? (
        <EmptyState icon={PawPrint} title="Pets Disabled" description="Enable the pet system above to let users buy, care for, train, and battle virtual pets." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-discord-bg-secondary rounded-lg p-4 space-y-3">
            <h3 className="font-semibold text-discord-text-primary">Care Settings</h3>
            <div>
              <label className="text-sm text-discord-text-secondary">Stat Decay Rate (%/day)</label>
              <input type="number" min={0} max={100} value={config.economy_pet_decay_rate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_decay_rate: parseInt(e.target.value) || 0 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Feed Cost (coins)</label>
              <input type="number" min={0} value={config.economy_pet_feed_cost}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_feed_cost: parseInt(e.target.value) || 0 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Train Cost (coins)</label>
              <input type="number" min={0} value={config.economy_pet_train_cost}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_train_cost: parseInt(e.target.value) || 0 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Decay Check Interval (hours)</label>
              <input type="number" min={1} max={168} value={config.economy_pet_decay_interval_hours}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_decay_interval_hours: parseInt(e.target.value) || 1 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
              <p className="text-xs text-discord-text-secondary mt-1">How often the bot checks and applies stat decay.</p>
            </div>
            <div>
              <label className="text-sm text-discord-text-secondary">Low Stat Warning Threshold (%)</label>
              <input type="number" min={0} max={100} value={config.economy_pet_low_stat_threshold}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_low_stat_threshold: parseInt(e.target.value) || 20 })}
                className="w-full mt-1 bg-discord-bg-tertiary text-discord-text-primary rounded px-3 py-2" />
              <p className="text-xs text-discord-text-secondary mt-1">Pets below this threshold are marked as sad or sick.</p>
            </div>
          </div>

          <div className="bg-discord-bg-secondary rounded-lg p-4 space-y-3">
            <h3 className="font-semibold text-discord-text-primary">Features</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.economy_pet_battle_enabled}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_battle_enabled: e.target.checked })}
                className="rounded" />
              <span className="text-sm text-discord-text-primary">Enable Pet Battles</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.economy_pet_prestige_enabled}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_prestige_enabled: e.target.checked })}
                className="rounded" />
              <span className="text-sm text-discord-text-primary">Enable Pet Prestige</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.economy_pet_notify_owner}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => saveConfig({ economy_pet_notify_owner: e.target.checked })}
                className="rounded" />
              <span className="text-sm text-discord-text-primary">DM Owner When Pet Is Sad/Sick</span>
            </label>
            <div className="mt-4 p-3 bg-discord-bg-tertiary rounded text-sm text-discord-text-secondary">
              <strong>Pet Types:</strong><br />
              🐺 Hunting — Boosts /hunt loot<br />
              🐕 Guard — Reduces rob success against owner<br />
              🐿️ Foraging — Passive item finds<br />
              🐈 Lucky — Slight gambling boost
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
