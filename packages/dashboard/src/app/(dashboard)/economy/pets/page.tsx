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

type PetTypeKey = 'hunting' | 'guard' | 'foraging' | 'lucky';
interface PetTypeDefinition { name: string; emoji: string; description: string; price: number }
type PetTypeConfig = Record<PetTypeKey, PetTypeDefinition>;

const DEFAULT_PET_TYPES: PetTypeConfig = {
  hunting: { name: 'Hunting', emoji: '🐺', description: 'Boosts hunt loot', price: 5000 },
  guard: { name: 'Guard', emoji: '🐕', description: 'Reduces rob success against you', price: 5000 },
  foraging: { name: 'Foraging', emoji: '🐿️', description: 'Passive item finds', price: 5000 },
  lucky: { name: 'Lucky', emoji: '🐈', description: 'Slight gambling boost', price: 7500 },
};
const PET_TYPE_KEYS = Object.keys(DEFAULT_PET_TYPES) as PetTypeKey[];

function normalizePetTypes(value: unknown): PetTypeConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PET_TYPES;
  return Object.fromEntries(PET_TYPE_KEYS.map((key) => {
    const fallback = DEFAULT_PET_TYPES[key];
    const candidate = Reflect.get(value, key);
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [key, fallback];
    const name = Reflect.get(candidate, 'name');
    const emoji = Reflect.get(candidate, 'emoji');
    const description = Reflect.get(candidate, 'description');
    const price = Reflect.get(candidate, 'price');
    return [key, {
      name: typeof name === 'string' ? name : fallback.name,
      emoji: typeof emoji === 'string' ? emoji : fallback.emoji,
      description: typeof description === 'string' ? description : fallback.description,
      price: typeof price === 'number' ? price : fallback.price,
    }];
  })) as PetTypeConfig;
}

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
  economy_pet_type_config: PetTypeConfig;
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
  economy_pet_type_config: DEFAULT_PET_TYPES,
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
        setConfig({ ...DEFAULT_CONFIG, ...gc, economy_pet_type_config: normalizePetTypes(gc.economy_pet_type_config) });
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
        economy_pet_type_config: normalizePetTypes(result.config.economy_pet_type_config),
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
          </div>

          <div className="space-y-4 rounded-lg bg-discord-bg-secondary p-4 md:col-span-2">
            <div>
              <h3 className="font-semibold text-discord-text-primary">Pet Types</h3>
              <p className="text-sm text-discord-text-secondary">Customize the names, Unicode or Discord custom emoji, descriptions, and purchase prices members see. The four behavior types remain stable so existing pets keep working.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {PET_TYPE_KEYS.map((key) => {
                const definition = config.economy_pet_type_config[key];
                const update = (patch: Partial<PetTypeDefinition>) => setConfig((current) => ({
                  ...current,
                  economy_pet_type_config: {
                    ...current.economy_pet_type_config,
                    [key]: { ...current.economy_pet_type_config[key], ...patch },
                  },
                }));
                return (
                  <div key={key} className="space-y-3 rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                      <label className="text-xs text-discord-text-secondary">Display name<input value={definition.name} maxLength={32} onChange={(event) => update({ name: event.target.value })} className="mt-1 w-full rounded bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary" /></label>
                      <label className="text-xs text-discord-text-secondary">Emoji<input value={definition.emoji} maxLength={64} onChange={(event) => update({ emoji: event.target.value })} className="mt-1 w-full rounded bg-discord-bg-primary px-3 py-2 text-center text-sm text-discord-text-primary" /></label>
                    </div>
                    <label className="block text-xs text-discord-text-secondary">Description<input value={definition.description} maxLength={128} onChange={(event) => update({ description: event.target.value })} className="mt-1 w-full rounded bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary" /></label>
                    <label className="block text-xs text-discord-text-secondary">Purchase price<input type="number" min={0} max={1_000_000_000} value={definition.price} onChange={(event) => update({ price: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary" /></label>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => saveConfig({ economy_pet_type_config: config.economy_pet_type_config })} className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover">Save Pet Types</button>
          </div>
        </div>
      )}
    </div>
  );
}
