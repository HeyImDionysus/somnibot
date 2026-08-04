/**
 * Economy Market Settings — configure the P2P marketplace.
 *
 * Admin toggles and settings for the player-to-player
 * market system. Listings are managed by players in-bot.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { ShieldCheck, Store, ShoppingCart } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface MarketConfig {
  economy_market_enabled: boolean;
  economy_market_fee_pct: number;
  economy_market_listing_days: number;
  economy_market_max_listings: number;
  economy_market_max_price_per_unit: number;
}

const DEFAULT_CONFIG: MarketConfig = {
  economy_market_enabled: false,
  economy_market_fee_pct: 5,
  economy_market_listing_days: 7,
  economy_market_max_listings: 10,
  economy_market_max_price_per_unit: 1000000000,
};

// ── Page ──────────────────────────────────────────────────

export default function MarketPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<MarketConfig>(DEFAULT_CONFIG);
  const [activeListings, setActiveListings] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [cfgRes, mktRes] = await Promise.all([
        fetch('/api/guild'),
        fetch('/api/economy/market'),
      ]);
      if (cfgRes.ok) {
        const cfgJson = await cfgRes.json();
        const gc = cfgJson.config ?? {};
        setConfig({ ...DEFAULT_CONFIG, ...gc });
      }
      if (mktRes.ok) {
        const mJson = await mktRes.json();
        setActiveListings(mJson.data?.active_listings ?? 0);
      }
    } catch {
      toast({ title: 'Failed to load market data', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveConfig = async (patch: Partial<MarketConfig>) => {
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
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-discord-text-primary">🏪 Market</h1>
        <p className="text-sm text-discord-text-secondary">Configure the player-to-player marketplace. Listings are managed by players via bot commands.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex items-center gap-3 rounded-lg bg-discord-bg-tertiary p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-discord-bg-secondary">
            <ShoppingCart className="h-5 w-5 text-discord-text-secondary" />
          </div>
          <div>
            <p className="text-xs text-discord-text-secondary">Active Listings</p>
            <p className="text-lg font-semibold text-discord-text-primary">{activeListings}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-discord-bg-tertiary p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-discord-bg-secondary">
            <Store className="h-5 w-5 text-discord-text-secondary" />
          </div>
          <div>
            <p className="text-xs text-discord-text-secondary">Listing Fee</p>
            <p className="text-lg font-semibold text-discord-text-primary">{config.economy_market_fee_pct}%</p>
          </div>
        </div>
      </div>

      {/* Config */}
      <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
        <h2 className="text-base font-semibold text-discord-text-primary">Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-discord-text-primary">Market Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={config.economy_market_enabled}
              onClick={() => saveConfig({ economy_market_enabled: !config.economy_market_enabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                config.economy_market_enabled ? 'bg-discord-blurple' : 'bg-discord-bg-tertiary'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                config.economy_market_enabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Transaction Fee (%)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_market_fee_pct}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_market_fee_pct: parseInt(e.target.value) || 5 })
              }
              min={0}
              max={50}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Listing Duration (days)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_market_listing_days}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_market_listing_days: parseInt(e.target.value) || 7 })
              }
              min={1}
              max={30}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Max Listings per Player</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_market_max_listings}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_market_max_listings: parseInt(e.target.value) || 10 })
              }
              min={1}
              max={50}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-discord-text-secondary">Maximum Price per Unit (coins)</span>
            <input
              type="number"
              className="rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
              value={config.economy_market_max_price_per_unit}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                saveConfig({ economy_market_max_price_per_unit: parseInt(e.target.value, 10) || 1000000000 })
              }
              min={1}
              max={2147483647}
            />
          </label>
        </div>
      </div>

      {/*
       * This is a policy, not an owner setting.  The bot rejects every item
       * flagged `tradeable=false` before the listing RPC, and the atomic
       * Supabase RPC repeats that guard for callers that bypass the bot.  Keep
       * this surface explicit so owners understand why there is no toggle.
       */}
      <div
        data-control-id="commerce-items-market-locked"
        data-policy-state="locked"
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-6"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-discord-text-primary">Commerce items: market locked</h2>
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-200">Locked on</span>
            </div>
            <p className="text-sm text-discord-text-secondary">
              Items flagged <code>tradeable=false</code> — including real-money commerce grants — can never be listed on the player market.
              This anti-laundering wall is permanent and is not an owner-configurable setting.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-discord-text-muted">
              <li>The bot rejects the listing before any inventory is decremented.</li>
              <li>The atomic database listing RPC repeats the same guard for defense in depth.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6">
        <h2 className="text-base font-semibold text-discord-text-primary mb-2">How It Works</h2>
        <ul className="space-y-2 text-sm text-discord-text-secondary list-disc list-inside">
          <li><code>/market list</code> — List an item from your inventory for sale</li>
          <li><code>/market browse</code> — Browse all active marketplace listings</li>
          <li><code>/market buy</code> — Purchase a listed item</li>
          <li><code>/market my-listings</code> — View your active listings</li>
          <li><code>/market cancel</code> — Remove a listing from the market</li>
        </ul>
        <p className="mt-3 text-xs text-discord-text-muted">
          A {config.economy_market_fee_pct}% transaction fee is deducted from the seller. Listings expire after {config.economy_market_listing_days} day{config.economy_market_listing_days !== 1 ? 's' : ''}.
        </p>
      </div>
    </div>
  );
}
