/**
 * Fraud Controls — Monitor fraud signals, manage detection rules.
 * Phase D: SOTA fraud detection and prevention dashboard.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────

interface FraudSignal {
  id: string;
  signal_type: string;
  severity: string;
  entity_type: string;
  entity_id: string;
  discord_id: string | null;
  description: string;
  evidence: Record<string, unknown>;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  auto_action: string | null;
  created_at: string;
}

interface FraudRule {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  auto_action: string;
  trigger_count: number;
  last_triggered: string | null;
}

interface Summary {
  total: number;
  open: number;
  investigating: number;
  critical: number;
  confirmed: number;
}

// ── Helpers ───────────────────────────────────────────────

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-blue-500/20 text-blue-400',
};

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-red-500/20 text-red-400',
  investigating: 'bg-yellow-500/20 text-yellow-400',
  confirmed: 'bg-orange-500/20 text-orange-400',
  dismissed: 'bg-discord-bg-tertiary text-discord-text-muted',
  auto_resolved: 'bg-discord-success/20 text-discord-success',
};

const SIGNAL_ICONS: Record<string, string> = {
  velocity: '⚡',
  device_abuse: '📱',
  chargeback: '💸',
  ip_mismatch: '🌐',
  key_sharing: '🔑',
  payment_pattern: '🔍',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// ── Component ─────────────────────────────────────────────

export default function FraudPage() {
  const [tab, setTab] = useState<'signals' | 'rules'>('signals');
  const [signals, setSignals] = useState<FraudSignal[]>([]);
  const [rules, setRules] = useState<FraudRule[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, open: 0, investigating: 0, critical: 0, confirmed: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadSignals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/fraud/signals?${params}`);
      const json = await res.json();
      if (json.success) {
        setSignals(json.data);
        setSummary(json.summary);
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/fraud/rules');
    const json = await res.json();
    if (json.success) setRules(json.data);
  }, []);

  useEffect(() => {
    if (tab === 'signals') loadSignals();
    else loadRules();
  }, [tab, loadSignals, loadRules]);

  const updateSignalStatus = async (id: string, status: string, note?: string) => {
    await fetch('/api/fraud/signals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, resolution_note: note }),
    });
    loadSignals();
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    await fetch('/api/fraud/rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    loadRules();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Fraud Controls</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Monitor suspicious activity and configure detection rules</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {[
          { label: 'Total Signals', value: summary.total, color: 'text-discord-text-primary' },
          { label: 'Open', value: summary.open, color: 'text-red-400' },
          { label: 'Investigating', value: summary.investigating, color: 'text-yellow-400' },
          { label: 'Critical', value: summary.critical, color: 'text-red-400' },
          { label: 'Confirmed', value: summary.confirmed, color: 'text-orange-400' },
        ].map((s) => (
          <div key={s.label} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-3 text-center">
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-discord-text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-discord-border-subtle">
        {(['signals', 'rules'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-[#FF1493] text-discord-text-primary'
                : 'border-transparent text-discord-text-muted hover:text-discord-text-secondary'
            }`}
          >
            {t === 'signals' ? 'Fraud Signals' : 'Detection Rules'}
          </button>
        ))}
      </div>

      {/* Signals Tab */}
      {tab === 'signals' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {['', 'open', 'investigating', 'confirmed', 'dismissed'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-[#FF1493]/20 text-[#FF1493]'
                    : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
            </div>
          ) : signals.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">🛡️</div>
              <p className="text-discord-text-muted">No fraud signals detected. Looking good!</p>
            </div>
          ) : (
            signals.map((signal) => (
              <div key={signal.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
                <button
                  onClick={() => setExpandedId(expandedId === signal.id ? null : signal.id)}
                  className="w-full text-left px-4 py-3 hover:bg-discord-bg-tertiary/30 transition-colors rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{SIGNAL_ICONS[signal.signal_type] || '⚠️'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[signal.severity] || ''}`}>
                          {signal.severity}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[signal.status] || ''}`}>
                          {signal.status}
                        </span>
                        <span className="text-sm font-medium text-discord-text-primary">{signal.description}</span>
                      </div>
                      <div className="mt-1 text-xs text-discord-text-muted">
                        {signal.signal_type} • {signal.entity_type}: {signal.entity_id.slice(0, 12)}… • {formatDate(signal.created_at)}
                      </div>
                    </div>
                    <span className={`text-discord-text-muted transition-transform ${expandedId === signal.id ? 'rotate-90' : ''}`}>▶</span>
                  </div>
                </button>

                {expandedId === signal.id && (
                  <div className="border-t border-discord-border-subtle px-4 py-3 space-y-3">
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-discord-text-muted mb-1">Evidence</h4>
                      <pre className="overflow-x-auto rounded-md bg-discord-bg-primary p-3 text-xs text-discord-text-secondary">
                        {JSON.stringify(signal.evidence, null, 2)}
                      </pre>
                    </div>

                    {signal.discord_id && (
                      <p className="text-xs text-discord-text-muted">
                        Discord User: <code className="font-mono text-discord-text-secondary">{signal.discord_id}</code>
                      </p>
                    )}

                    {signal.status === 'open' || signal.status === 'investigating' ? (
                      <div className="flex gap-2">
                        {signal.status === 'open' && (
                          <button
                            onClick={() => updateSignalStatus(signal.id, 'investigating')}
                            className="rounded-md bg-yellow-500/20 px-3 py-1.5 text-xs font-medium text-yellow-400 hover:bg-yellow-500/30 transition-colors"
                          >
                            Investigate
                          </button>
                        )}
                        <button
                          onClick={() => updateSignalStatus(signal.id, 'confirmed', 'Confirmed by admin')}
                          className="rounded-md bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/30 transition-colors"
                        >
                          Confirm Fraud
                        </button>
                        <button
                          onClick={() => updateSignalStatus(signal.id, 'dismissed', 'False positive')}
                          className="rounded-md bg-discord-bg-tertiary px-3 py-1.5 text-xs font-medium text-discord-text-muted hover:text-discord-text-primary transition-colors"
                        >
                          Dismiss
                        </button>
                      </div>
                    ) : signal.resolution_note ? (
                      <p className="text-xs text-discord-text-muted">
                        Resolution: <span className="text-discord-text-secondary">{signal.resolution_note}</span>
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Rules Tab */}
      {tab === 'rules' && (
        <div className="space-y-3">
          {rules.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">⚙️</div>
              <p className="text-discord-text-muted">No fraud detection rules configured yet.</p>
              <p className="text-xs text-discord-text-muted mt-1">Rules automatically detect suspicious patterns in purchases, licenses, and device usage.</p>
            </div>
          ) : (
            rules.map((rule) => (
              <div key={rule.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-discord-text-primary">{rule.name}</span>
                      <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-[10px] text-discord-text-muted">
                        {rule.rule_type}
                      </span>
                      <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-[10px] text-discord-text-muted">
                        Action: {rule.auto_action}
                      </span>
                    </div>
                    {rule.description && (
                      <p className="mt-1 text-xs text-discord-text-muted">{rule.description}</p>
                    )}
                    <p className="mt-1 text-xs text-discord-text-muted">
                      Triggered {rule.trigger_count} times
                      {rule.last_triggered && ` • Last: ${formatDate(rule.last_triggered)}`}
                    </p>
                  </div>
                  <button
                    onClick={() => toggleRule(rule.id, !rule.enabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      rule.enabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        rule.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
