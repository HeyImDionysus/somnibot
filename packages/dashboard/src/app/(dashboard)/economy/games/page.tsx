/**
 * Economy Games Management — per-game enable/disable, payout configs,
 * daily loss limit, lottery schedule + ticket price.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { Gamepad2 } from 'lucide-react';

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
  economy_games_enabled: false,
  economy_daily_loss_limit: 0,
  economy_coinflip_max_bet: 10000,
  economy_slots_max_bet: 5000,
  economy_blackjack_max_bet: 10000,
  economy_lottery_enabled: false,
  economy_lottery_schedule: 'weekly',
  economy_lottery_ticket_price: 100,
  economy_lottery_max_tickets: 10,
};

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

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div>
      <span className="block text-sm text-discord-text-secondary mb-1">{label}</span>
      <input
        type="number"
        className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
        value={value}
        min={min}
        max={max}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────

export default function GamesPage() {
  const { toast } = useToast();
  const [config, setConfig] = useState<GamesConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/guild');
      if (res.ok) {
        const json = await res.json();
        const gc = json.config ?? {};
        setConfig({
          economy_games_enabled: gc.economy_games_enabled ?? false,
          economy_daily_loss_limit: gc.economy_daily_loss_limit ?? 0,
          economy_coinflip_max_bet: gc.economy_coinflip_max_bet ?? 10000,
          economy_slots_max_bet: gc.economy_slots_max_bet ?? 5000,
          economy_blackjack_max_bet: gc.economy_blackjack_max_bet ?? 10000,
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
        <Gamepad2 className="w-6 h-6" /> Mini-Games & Lottery
      </h1>

      {/* Games Config */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Mini-Games</h2>
        <Toggle label="Enable Mini-Games" checked={config.economy_games_enabled} onChange={(v) => saveConfig({ economy_games_enabled: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <NumberField label="Daily Loss Limit (0 = none)" value={config.economy_daily_loss_limit} onChange={(v) => saveConfig({ economy_daily_loss_limit: v })} min={0} />
          <NumberField label="Coinflip Max Bet" value={config.economy_coinflip_max_bet} onChange={(v) => saveConfig({ economy_coinflip_max_bet: v })} min={0} />
          <NumberField label="Slots Max Bet" value={config.economy_slots_max_bet} onChange={(v) => saveConfig({ economy_slots_max_bet: v })} min={0} />
          <NumberField label="Blackjack Max Bet" value={config.economy_blackjack_max_bet} onChange={(v) => saveConfig({ economy_blackjack_max_bet: v })} min={0} />
        </div>
      </div>

      {/* Lottery Config */}
      <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Lottery</h2>
        <Toggle label="Enable Lottery" checked={config.economy_lottery_enabled} onChange={(v) => saveConfig({ economy_lottery_enabled: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <span className="block text-sm text-discord-text-secondary mb-1">Drawing Schedule</span>
            <select
              className="w-full rounded-md bg-discord-bg-tertiary border border-discord-border px-3 py-2 text-sm text-discord-text-primary"
              value={config.economy_lottery_schedule}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => saveConfig({ economy_lottery_schedule: e.target.value })}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <NumberField label="Ticket Price" value={config.economy_lottery_ticket_price} onChange={(v) => saveConfig({ economy_lottery_ticket_price: v })} min={1} />
          <NumberField label="Max Tickets per Member" value={config.economy_lottery_max_tickets} onChange={(v) => saveConfig({ economy_lottery_max_tickets: v })} min={1} max={100} />
        </div>
      </div>
    </div>
  );
}
