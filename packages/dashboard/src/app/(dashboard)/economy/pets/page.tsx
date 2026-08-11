/**
 * Economy Pets Management — pet type settings, battle config, prestige config.
 * FAKE economy only.
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { PawPrint } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

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
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

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
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setConfig({
        economy_pets_enabled: readConfirmedBoolean(result.config, 'economy_pets_enabled'),
        economy_pet_decay_rate: readConfirmedNumber(result.config, 'economy_pet_decay_rate'),
        economy_pet_decay_interval_hours: readConfirmedNumber(result.config, 'economy_pet_decay_interval_hours'),
        economy_pet_low_stat_threshold: readConfirmedNumber(result.config, 'economy_pet_low_stat_threshold'),
        economy_pet_notify_owner: readConfirmedBoolean(result.config, 'economy_pet_notify_owner'),
        economy_pet_battle_enabled: readConfirmedBoolean(result.config, 'economy_pet_battle_enabled'),
        economy_pet_prestige_enabled: readConfirmedBoolean(result.config, 'economy_pet_prestige_enabled'),
        economy_pet_feed_cost: readConfirmedNumber(result.config, 'economy_pet_feed_cost'),
        economy_pet_train_cost: readConfirmedNumber(result.config, 'economy_pet_train_cost'),
      });
      if (result.status === 'failed') {
        toast({ title: 'Failed to save settings', variant: 'error' });
        return 'failed' as const;
      }
      toast({ title: 'Settings saved!', variant: 'success' });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
      return 'failed' as const;
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
            <ValidatedNumberInput label="Stat Decay Rate (% per day)" help="Daily care-stat loss; 0 disables decay." value={config.economy_pet_decay_rate} onCommit={(value) => saveConfig({ economy_pet_decay_rate: value })} min={0} max={100} />
            <ValidatedNumberInput label="Feed Cost (coins)" help="Coins charged each time a member feeds a pet; 0 makes feeding free." value={config.economy_pet_feed_cost} onCommit={(value) => saveConfig({ economy_pet_feed_cost: value })} min={0} />
            <ValidatedNumberInput label="Training Cost (coins)" help="Coins charged for each training action; 0 makes training free." value={config.economy_pet_train_cost} onCommit={(value) => saveConfig({ economy_pet_train_cost: value })} min={0} />
            <ValidatedNumberInput label="Decay Check Interval (hours)" help="How often the bot checks and applies stat decay." value={config.economy_pet_decay_interval_hours} onCommit={(value) => saveConfig({ economy_pet_decay_interval_hours: value })} min={1} max={168} />
            <ValidatedNumberInput label="Low Stat Warning Threshold (%)" help="Pets below this percentage are marked sad or sick; 0 disables the warning threshold." value={config.economy_pet_low_stat_threshold} onCommit={(value) => saveConfig({ economy_pet_low_stat_threshold: value })} min={0} max={100} />
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
