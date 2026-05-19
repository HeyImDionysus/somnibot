/**
 * Moderation Overview — Escalation chain config, mod log channel, infraction expiry.
 *
 * Architecture doc §18.4, §18.5
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { useToast } from '@/components/shared/toast';

interface EscalationStep {
  threshold: number;
  action: 'warn' | 'mute' | 'kick' | 'ban';
  durationMinutes?: number;
  dmMember: boolean;
}

interface ModerationConfig {
  escalation_chain: EscalationStep[];
  mod_log_channel_id: string | null;
  infraction_expiry_days: number;
}

const ACTION_ICONS: Record<string, string> = {
  warn: '⚠️',
  mute: '🔇',
  kick: '👢',
  ban: '🔨',
};

const ACTION_COLORS: Record<string, string> = {
  warn: 'text-yellow-400',
  mute: 'text-orange-400',
  kick: 'text-red-400',
  ban: 'text-red-500',
};

const DEFAULT_CHAIN: EscalationStep[] = [
  { threshold: 1, action: 'warn', dmMember: true },
  { threshold: 2, action: 'warn', dmMember: true },
  { threshold: 3, action: 'mute', durationMinutes: 60, dmMember: true },
  { threshold: 4, action: 'mute', durationMinutes: 1440, dmMember: true },
  { threshold: 5, action: 'kick', dmMember: true },
  { threshold: 6, action: 'ban', dmMember: true },
];

export default function ModerationPage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<ModerationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/moderation/escalation');
      const json = await res.json();
      if (json.success) {
        setConfig(json.data);
      }
    } catch {
      setError('Failed to load moderation config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/moderation/escalation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: 'Settings saved', variant: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addStep = () => {
    if (!config) return;
    const maxThreshold = config.escalation_chain.length > 0
      ? Math.max(...config.escalation_chain.map((s) => s.threshold))
      : 0;
    setConfig({
      ...config,
      escalation_chain: [
        ...config.escalation_chain,
        { threshold: maxThreshold + 1, action: 'warn', dmMember: true },
      ],
    });
  };

  const removeStep = (index: number) => {
    if (!config) return;
    setConfig({
      ...config,
      escalation_chain: config.escalation_chain.filter((_, i) => i !== index),
    });
  };

  const updateStep = (index: number, updates: Partial<EscalationStep>) => {
    if (!config) return;
    const chain = [...config.escalation_chain];
    chain[index] = { ...chain[index], ...updates };
    setConfig({ ...config, escalation_chain: chain });
  };

  const resetToDefaults = () => {
    if (!config) return;
    setConfig({ ...config, escalation_chain: [...DEFAULT_CHAIN] });
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-discord-text-muted">Loading moderation settings...</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-red-400">Failed to load moderation config</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Moderation</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure auto-mod rules, escalation chain, and infraction settings.
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-2 gap-4">
        <Link
          href="/moderation/rules"
          className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 hover:border-somni-pink/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">🛡️</span>
            <div>
              <h3 className="font-semibold text-discord-text-primary">Auto-Mod Rules</h3>
              <p className="text-xs text-discord-text-muted">Word filter, spam detection, link blocking, and more</p>
            </div>
          </div>
        </Link>
        <Link
          href="/moderation/infractions"
          className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 hover:border-somni-pink/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">📋</span>
            <div>
              <h3 className="font-semibold text-discord-text-primary">Infractions</h3>
              <p className="text-xs text-discord-text-muted">View, search, and manage member infractions</p>
            </div>
          </div>
        </Link>
      </div>

      {/* General Settings */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">General Settings</h2>

        <div className="mt-6 space-y-5">
          {/* Mod Log Channel */}
          <div className="max-w-md">
            <ChannelPicker
              label="Mod Log Channel"
              hint="Channel where moderation actions are logged. Leave empty to disable."
              value={config.mod_log_channel_id}
              onChange={(v) => setConfig({ ...config, mod_log_channel_id: (v as string) || null })}
              placeholder="Select mod log channel…"
              allowNone
            />
          </div>

          {/* Infraction Expiry */}
          <div>
            <label className="block text-sm font-medium text-discord-text-primary">
              Warning Expiry (days)
            </label>
            <p className="text-xs text-discord-text-muted mb-2">
              Warnings automatically deactivate after this many days. They still appear in history but don&apos;t count toward escalation.
            </p>
            <input
              type="number"
              min={1}
              max={365}
              value={config.infraction_expiry_days}
              onChange={(e) =>
                setConfig({ ...config, infraction_expiry_days: parseInt(e.target.value) || 30 })
              }
              className="w-24 rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-somni-pink focus:outline-none"
            />
          </div>
        </div>
      </section>

      {/* Escalation Chain */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-discord-text-primary">Escalation Chain</h2>
            <p className="mt-1 text-sm text-discord-text-muted">
              Automatic punishment escalation based on active warning count.
            </p>
          </div>
          <button
            onClick={resetToDefaults}
            className="text-xs text-discord-text-muted hover:text-discord-text-primary"
          >
            Reset to Defaults
          </button>
        </div>

        <div className="mt-6 space-y-3">
          {config.escalation_chain.length === 0 && (
            <div className="rounded-lg border border-discord-border bg-discord-bg-tertiary p-4 text-center text-sm text-discord-text-muted">
              No escalation steps configured. Add steps below or reset to defaults.
            </div>
          )}

          {config.escalation_chain.map((step, idx) => (
            <div
              key={idx}
              className="flex items-center gap-3 rounded-lg border border-discord-border bg-discord-bg-tertiary p-3"
            >
              {/* Threshold */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-discord-text-muted whitespace-nowrap">At</span>
                <input
                  type="number"
                  min={1}
                  value={step.threshold}
                  onChange={(e) => updateStep(idx, { threshold: parseInt(e.target.value) || 1 })}
                  className="w-14 rounded border border-discord-border bg-discord-bg-secondary px-2 py-1 text-center text-sm text-discord-text-primary"
                />
                <span className="text-xs text-discord-text-muted whitespace-nowrap">warning(s)</span>
              </div>

              {/* Arrow */}
              <span className="text-discord-text-muted">→</span>

              {/* Action */}
              <div className="flex items-center gap-2">
                <span>{ACTION_ICONS[step.action]}</span>
                <select
                  value={step.action}
                  onChange={(e) => {
                    const action = e.target.value as EscalationStep['action'];
                    updateStep(idx, {
                      action,
                      durationMinutes: action === 'mute' ? 60 : undefined,
                    });
                  }}
                  className="rounded border border-discord-border bg-discord-bg-secondary px-2 py-1 text-sm text-discord-text-primary"
                >
                  <option value="warn">Warn</option>
                  <option value="mute">Mute</option>
                  <option value="kick">Kick</option>
                  <option value="ban">Ban</option>
                </select>
              </div>

              {/* Duration (for mutes) */}
              {step.action === 'mute' && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={step.durationMinutes ?? 60}
                    onChange={(e) => updateStep(idx, { durationMinutes: parseInt(e.target.value) || 60 })}
                    className="w-20 rounded border border-discord-border bg-discord-bg-secondary px-2 py-1 text-sm text-discord-text-primary"
                  />
                  <span className="text-xs text-discord-text-muted">min</span>
                </div>
              )}

              {/* DM toggle */}
              <label className="ml-auto flex items-center gap-1 text-xs text-discord-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={step.dmMember}
                  onChange={(e) => updateStep(idx, { dmMember: e.target.checked })}
                  className="rounded"
                />
                DM
              </label>

              {/* Remove */}
              <button
                onClick={() => removeStep(idx)}
                className="text-discord-text-muted hover:text-red-400"
                title="Remove step"
              >
                ✕
              </button>
            </div>
          ))}

          <button
            onClick={addStep}
            className="w-full rounded-lg border border-dashed border-discord-border p-3 text-sm text-discord-text-muted hover:border-somni-pink/50 hover:text-discord-text-primary"
          >
            + Add Escalation Step
          </button>
        </div>

        {/* Visual chain preview */}
        {config.escalation_chain.length > 0 && (
          <div className="mt-4 rounded-lg border border-discord-border bg-discord-bg-tertiary p-4">
            <h4 className="text-xs font-medium text-discord-text-muted uppercase mb-2">Preview</h4>
            <div className="flex flex-wrap items-center gap-2">
              {[...config.escalation_chain]
                .sort((a, b) => a.threshold - b.threshold)
                .map((step, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    {idx > 0 && <span className="text-discord-text-muted">→</span>}
                    <span className={`text-sm font-medium ${ACTION_COLORS[step.action]}`}>
                      {ACTION_ICONS[step.action]} {step.threshold}×:{' '}
                      {step.action === 'mute'
                        ? `Mute ${step.durationMinutes ? `(${step.durationMinutes >= 60 ? `${Math.floor(step.durationMinutes / 60)}h` : `${step.durationMinutes}m`})` : ''}`
                        : step.action.charAt(0).toUpperCase() + step.action.slice(1)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </section>

      {/* Commerce Interaction Info */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary mb-3">
          Moderation × Commerce
        </h2>
        <div className="space-y-2 text-sm text-discord-text-muted">
          <div className="flex items-center gap-3">
            <span className="w-16 text-right font-mono text-xs text-yellow-400">Warn</span>
            <span>No impact on entitlements</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-right font-mono text-xs text-orange-400">Mute</span>
            <span>No impact — member keeps roles, just can&apos;t interact (Discord timeout)</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-right font-mono text-xs text-red-400">Kick</span>
            <span>Entitlements preserved. Roles restored on rejoin.</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-right font-mono text-xs text-red-500">Ban</span>
            <span>Entitlements <strong className="text-red-400">suspended</strong> (not revoked). Owner can revoke from dashboard.</span>
          </div>
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-somni-pink px-6 py-2.5 text-sm font-semibold text-white hover:bg-somni-pink/80 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
