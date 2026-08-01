'use client';

import { useMemo, useState } from 'react';
import { invalidateFraudCache } from '@/lib/fraud-data-cache';
import { velocityRuleConfigError } from '@/lib/fraud-rule-config';

export const FRAUD_RULE_TYPES = ['velocity_limit'] as const;

export function isSupportedFraudRuleType(value: string): value is 'velocity_limit' {
  return value === 'velocity_limit';
}

export interface EditableFraudRule {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  auto_action: string;
}

interface Props {
  rule?: EditableFraudRule | null;
  onCancel(): void;
  onSaved(): void | Promise<void>;
}

const DEFAULT_CONFIG: Record<(typeof FRAUD_RULE_TYPES)[number], Record<string, unknown>> = {
  velocity_limit: { threshold: 5, window_minutes: 60 },
};

export function FraudRuleForm({ rule, onCancel, onSaved }: Props) {
  const editing = Boolean(rule);
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [ruleType, setRuleType] = useState<'velocity_limit'>('velocity_limit');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [configText, setConfigText] = useState(
    JSON.stringify(rule?.config ?? DEFAULT_CONFIG.velocity_limit, null, 2),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configError = useMemo(() => {
    try {
      const parsed = JSON.parse(configText) as unknown;
      return velocityRuleConfigError(parsed);
    } catch {
      return 'Configuration must be valid JSON.';
    }
  }, [configText]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Rule name is required.');
      return;
    }
    if (configError) {
      setError(configError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...(rule ? { id: rule.id } : {}),
        name: name.trim(),
        description: description.trim() || null,
        rule_type: ruleType,
        enabled,
        auto_action: 'flag',
        config: JSON.parse(configText) as Record<string, unknown>,
      };
      const response = await fetch('/api/fraud/rules', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) {
        setError(typeof body.error === 'string' ? body.error : 'Could not save the fraud rule.');
        return;
      }
      invalidateFraudCache('/api/fraud/rules');
      await onSaved();
    } catch {
      setError('Could not reach the server to save the fraud rule.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-card border border-[#FF1493]/40 bg-discord-bg-secondary p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-discord-text-primary">
            {editing ? 'Edit detection rule' : 'Create detection rule'}
          </h3>
          <p className="mt-1 text-xs text-discord-text-muted">
            Purchase velocity is the detector currently evaluated at runtime.
            Matching signals are flagged for operator review.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="text-sm text-discord-text-muted hover:text-white">
          Cancel
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-discord-text-secondary">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-discord-text-primary"
          />
        </label>
        <label className="text-sm text-discord-text-secondary">
          Rule type
          <select
            value={ruleType}
            onChange={(event) => {
              const next = event.target.value as (typeof FRAUD_RULE_TYPES)[number];
              setRuleType(next);
              if (!editing) setConfigText(JSON.stringify(DEFAULT_CONFIG[next], null, 2));
            }}
            className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-discord-text-primary"
          >
            {FRAUD_RULE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="text-sm text-discord-text-secondary sm:col-span-2">
          Description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-discord-text-primary"
          />
        </label>
        <label className="flex items-center gap-2 pt-7 text-sm text-discord-text-secondary">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled immediately
        </label>
        <label className="text-sm text-discord-text-secondary sm:col-span-2">
          Detector configuration (JSON object)
          <textarea
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            rows={7}
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 font-mono text-xs text-discord-text-primary"
          />
          {configError && <span className="mt-1 block text-xs text-red-400">{configError}</span>}
        </label>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={saving || Boolean(configError)}
          onClick={() => void submit()}
          className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : editing ? 'Save rule' : 'Create rule'}
        </button>
      </div>
    </div>
  );
}
