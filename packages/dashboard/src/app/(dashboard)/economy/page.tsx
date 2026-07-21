/**
 * Economy Settings — Configure the fake-economy system.
 *
 * Controls: master toggle, currency name/emoji, earning rates, cooldowns,
 * rob/heist settings, passive income, chat income, wallet/bank caps, log channel.
 *
 * IMPORTANT: This is the FAKE economy (virtual currency).
 * The real-money store/commerce system is entirely separate.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Coins, TrendingUp, Wallet, Landmark } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────

interface EconomyConfig {
  economy_enabled: boolean;
  currency_name: string;
  currency_emoji: string;
  economy_starting_balance: number;
  economy_daily_amount: number;
  economy_weekly_amount: number;
  economy_monthly_amount: number;
  economy_streak_bonus_pct: number;
  economy_work_cooldown_seconds: number;
  economy_work_min: number;
  economy_work_max: number;
  economy_crime_success_pct: number;
  economy_crime_fine_pct: number;
  economy_crime_min: number;
  economy_crime_max: number;
  economy_chat_income_enabled: boolean;
  economy_chat_income_min: number;
  economy_chat_income_max: number;
  economy_chat_income_cooldown_seconds: number;
  economy_rob_enabled: boolean;
  economy_rob_success_pct: number;
  economy_rob_fine_pct: number;
  economy_heist_enabled: boolean;
  economy_passive_mode_allowed: boolean;
  economy_pay_tax_pct: number;
  economy_max_wallet: number;
  economy_max_bank: number;
  economy_log_channel_id: string | null;
  // Member-profile controls
  profiles_enabled: boolean;
  title_max_length: number;
  bio_max_length: number;
  profile_visibility: 'everyone' | 'members-after-onboarding';
  content_filter_mode: 'lenient' | 'strict';
  show_game_stats: boolean;
}

interface EconomyStats {
  totalWallets: number;
  totalCirculation: number;
  totalBanked: number;
  totalSupply: number;
  shopItems: number;
}

const DEFAULT_CONFIG: EconomyConfig = {
  economy_enabled: false,
  currency_name: 'Coins',
  currency_emoji: '🪙',
  economy_starting_balance: 0,
  economy_daily_amount: 500,
  economy_weekly_amount: 3500,
  economy_monthly_amount: 15000,
  economy_streak_bonus_pct: 5,
  economy_work_cooldown_seconds: 1800,
  economy_work_min: 100,
  economy_work_max: 500,
  economy_crime_success_pct: 40,
  economy_crime_fine_pct: 50,
  economy_crime_min: 200,
  economy_crime_max: 1000,
  economy_chat_income_enabled: false,
  economy_chat_income_min: 5,
  economy_chat_income_max: 15,
  economy_chat_income_cooldown_seconds: 60,
  economy_rob_enabled: true,
  economy_rob_success_pct: 35,
  economy_rob_fine_pct: 50,
  economy_heist_enabled: true,
  economy_passive_mode_allowed: true,
  economy_pay_tax_pct: 0,
  economy_max_wallet: 0,
  economy_max_bank: 0,
  economy_log_channel_id: null,
  profiles_enabled: true,
  title_max_length: 64,
  bio_max_length: 256,
  profile_visibility: 'everyone',
  content_filter_mode: 'lenient',
  show_game_stats: true,
};

// ── Helpers ───────────────────────────────────────────────

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-discord-bg-tertiary p-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-discord-bg-secondary">
        <Icon className="h-5 w-5 text-discord-text-secondary" />
      </div>
      <div>
        <p className="text-xs text-discord-text-secondary">{label}</p>
        <p className="text-lg font-semibold text-discord-text-primary">{value}</p>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold text-discord-text-primary">{title}</h3>
      <p className="text-sm text-discord-text-secondary">{description}</p>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-discord-text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="w-full rounded-md border border-discord-bg-tertiary bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
          value={value}
          onChange={(e) => onChange(Math.max(min ?? 0, Math.min(max ?? 999999999, parseInt(e.target.value) || 0)))}
          min={min}
          max={max}
          disabled={disabled}
        />
        {suffix && <span className="text-xs text-discord-text-muted whitespace-nowrap">{suffix}</span>}
      </div>
    </label>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-discord-text-primary">{label}</p>
        {description && <p className="text-xs text-discord-text-secondary">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
          checked ? 'bg-discord-blurple' : 'bg-discord-bg-tertiary'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function EconomyPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<EconomyConfig>(DEFAULT_CONFIG);
  const [stats, setStats] = useState<EconomyStats>({ totalWallets: 0, totalCirculation: 0, totalBanked: 0, totalSupply: 0, shopItems: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const originalRef = useState<string>('')[1];

  useUnsavedWarning(dirty);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/economy');
      const json = await res.json();
      if (json.success) {
        const merged = { ...DEFAULT_CONFIG, ...json.data.config };
        setConfig(merged);
        setStats(json.data.stats);
        originalRef(JSON.stringify(merged));
        setDirty(false);
      }
    } catch {
      toast({ title: 'Failed to load economy config', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [toast, originalRef]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateField = <K extends keyof EconomyConfig>(key: K, value: EconomyConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/economy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (json.success) {
        toast({ title: 'Economy settings saved!', variant: 'success' });
        setDirty(false);
        originalRef(JSON.stringify(config));
      } else {
        toast({ title: json.error || 'Failed to save', variant: 'error' });
      }
    } catch {
      toast({ title: 'Network error', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ConfigSkeleton />;

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">💰 Economy</h1>
          <p className="text-sm text-discord-text-secondary">
            Virtual currency system — members earn, spend, and trade fake money.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="rounded-md bg-discord-blurple px-4 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Master toggle */}
      <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6">
        <Toggle
          label="Enable Economy System"
          description="Turn on the virtual currency system. Members can earn coins via commands, chat, and tasks."
          checked={config.economy_enabled}
          onChange={(v) => updateField('economy_enabled', v)}
        />
      </div>

      {!config.economy_enabled ? (
        <EmptyState
          icon={Coins}
          title="Economy is disabled"
          description="Enable the economy system to configure currency settings, earning rates, and shop items."
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Total Wallets" value={stats.totalWallets.toLocaleString()} icon={Wallet} />
            <StatCard label="In Circulation" value={stats.totalCirculation.toLocaleString()} icon={TrendingUp} />
            <StatCard label="In Banks" value={stats.totalBanked.toLocaleString()} icon={Landmark} />
            <StatCard label="Shop Items" value={stats.shopItems.toLocaleString()} icon={Coins} />
          </div>

          {/* Currency */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Currency" description="Customize the name and look of your server's currency." />
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Currency Name</span>
                <input
                  type="text"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={config.currency_name}
                  onChange={(e) => updateField('currency_name', e.target.value.slice(0, 32))}
                  maxLength={32}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-discord-text-secondary">Currency Emoji</span>
                <input
                  type="text"
                  className="rounded-md border border-discord-bg-tertiary bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary outline-none focus:border-discord-blurple"
                  value={config.currency_emoji}
                  onChange={(e) => updateField('currency_emoji', e.target.value.slice(0, 64))}
                  maxLength={64}
                />
              </label>
            </div>
            <NumberField
              label="Starting Balance"
              value={config.economy_starting_balance}
              onChange={(v) => updateField('economy_starting_balance', v)}
              min={0}
              max={1000000}
              suffix="given to new users"
            />
          </div>

          {/* Timed Rewards */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Timed Rewards" description="How much members earn from /daily, /weekly, /monthly commands." />
            <div className="grid grid-cols-3 gap-4">
              <NumberField label="Daily Amount" value={config.economy_daily_amount} onChange={(v) => updateField('economy_daily_amount', v)} min={0} max={1000000} />
              <NumberField label="Weekly Amount" value={config.economy_weekly_amount} onChange={(v) => updateField('economy_weekly_amount', v)} min={0} max={10000000} />
              <NumberField label="Monthly Amount" value={config.economy_monthly_amount} onChange={(v) => updateField('economy_monthly_amount', v)} min={0} max={100000000} />
            </div>
            <NumberField
              label="Streak Bonus"
              value={config.economy_streak_bonus_pct}
              onChange={(v) => updateField('economy_streak_bonus_pct', v)}
              min={0}
              max={100}
              suffix="% per consecutive day"
            />
          </div>

          {/* Work & Crime */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Work & Crime" description="Settings for /work and /crime commands." />
            <NumberField
              label="Work Cooldown"
              value={config.economy_work_cooldown_seconds}
              onChange={(v) => updateField('economy_work_cooldown_seconds', v)}
              min={60}
              max={86400}
              suffix="seconds"
            />
            <div className="grid grid-cols-2 gap-4">
              <NumberField label="Work Min Payout" value={config.economy_work_min} onChange={(v) => updateField('economy_work_min', v)} min={0} max={1000000} />
              <NumberField label="Work Max Payout" value={config.economy_work_max} onChange={(v) => updateField('economy_work_max', v)} min={0} max={10000000} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <NumberField label="Crime Success %" value={config.economy_crime_success_pct} onChange={(v) => updateField('economy_crime_success_pct', v)} min={1} max={100} suffix="%" />
              <NumberField label="Crime Fine %" value={config.economy_crime_fine_pct} onChange={(v) => updateField('economy_crime_fine_pct', v)} min={0} max={100} suffix="% of wallet" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <NumberField label="Crime Min Payout" value={config.economy_crime_min} onChange={(v) => updateField('economy_crime_min', v)} min={0} max={1000000} />
              <NumberField label="Crime Max Payout" value={config.economy_crime_max} onChange={(v) => updateField('economy_crime_max', v)} min={0} max={10000000} />
            </div>
          </div>

          {/* Chat Income */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Chat Income" description="Earn passive income just by chatting." />
            <Toggle
              label="Enable Chat Income"
              description="Members earn a small random amount per message (with cooldown)."
              checked={config.economy_chat_income_enabled}
              onChange={(v) => updateField('economy_chat_income_enabled', v)}
            />
            {config.economy_chat_income_enabled && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <NumberField label="Min per Message" value={config.economy_chat_income_min} onChange={(v) => updateField('economy_chat_income_min', v)} min={0} max={10000} />
                  <NumberField label="Max per Message" value={config.economy_chat_income_max} onChange={(v) => updateField('economy_chat_income_max', v)} min={0} max={100000} />
                </div>
                <NumberField
                  label="Cooldown"
                  value={config.economy_chat_income_cooldown_seconds}
                  onChange={(v) => updateField('economy_chat_income_cooldown_seconds', v)}
                  min={1}
                  max={3600}
                  suffix="seconds between payouts"
                />
              </>
            )}
          </div>

          {/* Robbery & Safety */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Robbery & Safety" description="Rob, heist, and passive mode settings." />
            <Toggle
              label="Allow Robbing"
              description="Members can use /rob to steal from others."
              checked={config.economy_rob_enabled}
              onChange={(v) => updateField('economy_rob_enabled', v)}
            />
            {config.economy_rob_enabled && (
              <div className="grid grid-cols-2 gap-4">
                <NumberField label="Rob Success %" value={config.economy_rob_success_pct} onChange={(v) => updateField('economy_rob_success_pct', v)} min={1} max={100} suffix="%" />
                <NumberField label="Rob Fine %" value={config.economy_rob_fine_pct} onChange={(v) => updateField('economy_rob_fine_pct', v)} min={0} max={100} suffix="% of wallet" />
              </div>
            )}
            <Toggle
              label="Allow Heists"
              description="Group heist events (coming in a future update)."
              checked={config.economy_heist_enabled}
              onChange={(v) => updateField('economy_heist_enabled', v)}
            />
            <Toggle
              label="Allow Passive Mode"
              description="Members can toggle /passive to protect themselves from robbery."
              checked={config.economy_passive_mode_allowed}
              onChange={(v) => updateField('economy_passive_mode_allowed', v)}
            />
          </div>

          {/* Transfers & Caps */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Transfers & Caps" description="Pay tax, wallet and bank limits." />
            <NumberField
              label="Pay Tax"
              value={config.economy_pay_tax_pct}
              onChange={(v) => updateField('economy_pay_tax_pct', v)}
              min={0}
              max={50}
              suffix="% removed when using /pay"
            />
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                label="Max Wallet"
                value={config.economy_max_wallet}
                onChange={(v) => updateField('economy_max_wallet', v)}
                min={0}
                suffix="0 = no limit"
              />
              <NumberField
                label="Max Bank"
                value={config.economy_max_bank}
                onChange={(v) => updateField('economy_max_bank', v)}
                min={0}
                suffix="0 = no limit"
              />
            </div>
          </div>

          {/* Log Channel */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Logging" description="Send economy events to a Discord channel." />
            <ChannelPicker
              label="Economy Log Channel"
              value={config.economy_log_channel_id}
              onChange={(v) => updateField('economy_log_channel_id', typeof v === 'string' ? v : null)}
              allowNone
            />
          </div>

          {/* Member Profiles */}
          <div className="rounded-lg border border-discord-bg-tertiary bg-discord-bg-secondary p-6 space-y-4">
            <SectionHeader title="Member Profiles" description="Controls for /profile, /title, and /bio." />
            <Toggle
              label="Profiles Enabled"
              description="When off, profile commands explain the feature is disabled."
              checked={config.profiles_enabled}
              onChange={(v) => updateField('profiles_enabled', v)}
            />
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                label="Title Max Length"
                value={config.title_max_length}
                onChange={(v) => updateField('title_max_length', v)}
                min={1}
                max={64}
              />
              <NumberField
                label="Bio Max Length"
                value={config.bio_max_length}
                onChange={(v) => updateField('bio_max_length', v)}
                min={1}
                max={256}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-discord-text-secondary">Profile Visibility</label>
              <select
                value={config.profile_visibility}
                onChange={(e) => updateField('profile_visibility', e.target.value === 'members-after-onboarding' ? 'members-after-onboarding' : 'everyone')}
                className="mt-1 w-full rounded-md border border-discord-bg-tertiary bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-blurple focus:outline-none"
              >
                <option value="everyone">Everyone</option>
                <option value="members-after-onboarding">Members after onboarding</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-discord-text-secondary">Content Filter</label>
              <select
                value={config.content_filter_mode}
                onChange={(e) => updateField('content_filter_mode', e.target.value === 'strict' ? 'strict' : 'lenient')}
                className="mt-1 w-full rounded-md border border-discord-bg-tertiary bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-discord-blurple focus:outline-none"
              >
                <option value="lenient">Lenient (block only clear violations)</option>
                <option value="strict">Strict (block broader categories)</option>
              </select>
            </div>
            <Toggle
              label="Show Game Stats"
              description="Show play-money standing (net worth, wallet, bank) on the profile card."
              checked={config.show_game_stats}
              onChange={(v) => updateField('show_game_stats', v)}
            />
          </div>
        </>
      )}

      {/* Floating save bar */}
      {dirty && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-discord-bg-tertiary bg-discord-bg-secondary/95 backdrop-blur-sm px-6 py-3">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <p className="text-sm text-discord-text-secondary">You have unsaved changes</p>
            <div className="flex gap-2">
              <button
                onClick={loadData}
                className="rounded-md border border-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-primary hover:bg-discord-bg-tertiary"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-discord-blurple px-4 py-2 text-sm font-medium text-white hover:bg-discord-blurple/80 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
