/**
 * Economy Games Management — per-game enable/disable, payout configs,
 * daily loss limit, lottery schedule + ticket price.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { Gamepad2 } from 'lucide-react';
import { GuildConfigSaveCoordinator, readConfirmedBoolean, readConfirmedNumber, readConfirmedString } from '../_components/guild-config-save';
import { ValidatedNumberInput } from '../_components/validated-number-input';

// ── Types ─────────────────────────────────────────────────

interface GamesConfig {
  economy_games_enabled: boolean;
  economy_daily_loss_limit: number;
  economy_coinflip_max_bet: number;
  economy_slots_max_bet: number;
  economy_blackjack_max_bet: number;
  economy_lottery_enabled: boolean;
  economy_lottery_schedule: string;
  economy_lottery_ticket_price: number;
  economy_lottery_max_tickets: number;
}

const DEFAULT_CONFIG: GamesConfig = {
  economy_games_enabled: true,
  economy_daily_loss_limit: 5000,
  economy_coinflip_max_bet: 500,
  economy_slots_max_bet: 500,
  economy_blackjack_max_bet: 1000,
  economy_lottery_enabled: false,
  economy_lottery_schedule: 'weekly',
  economy_lottery_ticket_price: 100,
  economy_lottery_max_tickets: 10,
};

// ── Helpers ───────────────────────────────────────────────

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
        onClick={() => onChange(!checked)}
      >
        <span className={`absolute h-6 w-11 rounded-full transition-colors ${checked ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'}`}>
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
        </span>
      </button>
      <span className="text-sm text-discord-text-primary">{label}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────

export default function GamesPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<GamesConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const saveCoordinator = useRef(new GuildConfigSaveCoordinator()).current;

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/guild');
      if (res.ok) {
        const json = await res.json();
        const gc = json.config ?? {};
        setConfig({
          economy_games_enabled: gc.economy_games_enabled ?? true,
          economy_daily_loss_limit: gc.economy_daily_loss_limit ?? 5000,
          economy_coinflip_max_bet: gc.economy_coinflip_max_bet ?? 500,
          economy_slots_max_bet: gc.economy_slots_max_bet ?? 500,
          economy_blackjack_max_bet: gc.economy_blackjack_max_bet ?? 1000,
          economy_lottery_enabled: gc.economy_lottery_enabled ?? false,
          economy_lottery_schedule: gc.economy_lottery_schedule ?? 'weekly',
          economy_lottery_ticket_price: gc.economy_lottery_ticket_price ?? 100,
          economy_lottery_max_tickets: gc.economy_lottery_max_tickets ?? 10,
        });
      }
    } catch {
      toast({ title: 'Failed to load', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<GamesConfig>) => {
    try {
      const result = await saveCoordinator.save(patch);
      if (result.status === 'superseded') return 'superseded' as const;
      setConfig({
        economy_games_enabled: readConfirmedBoolean(result.config, 'economy_games_enabled'),
        economy_daily_loss_limit: readConfirmedNumber(result.config, 'economy_daily_loss_limit'),
        economy_coinflip_max_bet: readConfirmedNumber(result.config, 'economy_coinflip_max_bet'),
        economy_slots_max_bet: readConfirmedNumber(result.config, 'economy_slots_max_bet'),
        economy_blackjack_max_bet: readConfirmedNumber(result.config, 'economy_blackjack_max_bet'),
        economy_lottery_enabled: readConfirmedBoolean(result.config, 'economy_lottery_enabled'),
        economy_lottery_schedule: readConfirmedString(result.config, 'economy_lottery_schedule'),
        economy_lottery_ticket_price: readConfirmedNumber(result.config, 'economy_lottery_ticket_price'),
        economy_lottery_max_tickets: readConfirmedNumber(result.config, 'economy_lottery_max_tickets'),
      });
      const [target] = Object.entries(patch)[0] ?? ['setting'];
      const value = result.config[target];
      toast({
        title: 'Mini-game setting confirmed',
        description: `${target} confirmed as ${String(value)} at ${new Date().toLocaleTimeString()}.`,
        variant: 'success',
      });
      return 'saved' as const;
    } catch {
      toast({ title: 'Failed to save', variant: 'error' });
      return 'failed' as const;
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-discord-text-primary flex items-center gap-2">
        <Gamepad2 className="w-6 h-6" /> Mini-Games & Lottery
      </h1>

      {/* Games Config */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Mini-Games</h2>
        <Toggle label="Enable Mini-Games" checked={config.economy_games_enabled} onChange={(v) => saveConfig({ economy_games_enabled: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <ValidatedNumberInput label="Daily Loss Limit (coins)" help="Maximum coins a member can lose per day; 0 removes the limit." value={config.economy_daily_loss_limit} onCommit={(value) => saveConfig({ economy_daily_loss_limit: value })} min={0} />
          <ValidatedNumberInput label="Coinflip Maximum Bet (coins)" help="Largest coinflip wager a member can place; 0 disables coinflip wagering." value={config.economy_coinflip_max_bet} onCommit={(value) => saveConfig({ economy_coinflip_max_bet: value })} min={0} />
          <ValidatedNumberInput label="Slots Maximum Bet (coins)" help="Largest slots wager a member can place; 0 disables slots wagering." value={config.economy_slots_max_bet} onCommit={(value) => saveConfig({ economy_slots_max_bet: value })} min={0} />
          <ValidatedNumberInput label="Blackjack Maximum Bet (coins)" help="Largest blackjack wager a member can place; 0 disables blackjack wagering." value={config.economy_blackjack_max_bet} onCommit={(value) => saveConfig({ economy_blackjack_max_bet: value })} min={0} />
        </div>
      </div>

      {/* Lottery Config */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Lottery</h2>
        <Toggle label="Enable Lottery" checked={config.economy_lottery_enabled} onChange={(v) => saveConfig({ economy_lottery_enabled: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label htmlFor="lottery-drawing-schedule" className="block text-sm text-discord-text-secondary mb-1">
              Drawing Schedule
            </label>
            <select
              id="lottery-drawing-schedule"
              className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border-subtle px-3 py-2 text-sm text-discord-text-primary"
              value={config.economy_lottery_schedule}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => saveConfig({ economy_lottery_schedule: e.target.value })}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <ValidatedNumberInput label="Ticket Price (coins)" help="Coins charged for each lottery ticket." value={config.economy_lottery_ticket_price} onCommit={(value) => saveConfig({ economy_lottery_ticket_price: value })} min={1} />
          <ValidatedNumberInput label="Maximum Tickets per Member" help="Ticket purchase cap for one drawing." value={config.economy_lottery_max_tickets} onCommit={(value) => saveConfig({ economy_lottery_max_tickets: value })} min={1} max={100} />
        </div>
      </div>
    </div>
  );
}
