'use client';

import { useEffect, useId, useState } from 'react';

type CommitResult = 'saved' | 'failed' | 'superseded';

interface ValidatedNumberInputProps {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (value: number) => Promise<CommitResult>;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly help?: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function ValidatedNumberInput({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  help,
  className,
  disabled = false,
}: ValidatedNumberInputProps) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saving && error === null) setDraft(String(value));
  }, [error, saving, value]);

  const commit = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError(`${label} is required.`);
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || (step >= 1 && !Number.isInteger(parsed))) {
      setError(`${label} must be a valid ${step >= 1 ? 'whole ' : ''}number.`);
      return;
    }
    if (min !== undefined && parsed < min) {
      setError(`${label} must be at least ${min}.`);
      return;
    }
    if (max !== undefined && parsed > max) {
      setError(`${label} must be no more than ${max}.`);
      return;
    }

    setError(null);
    setSaving(true);
    const result = await onCommit(parsed);
    setSaving(false);
    if (result === 'failed') {
      setDraft(String(value));
      setError('Save failed; restored the last confirmed value.');
    }
  };

  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null]
    .filter((item): item is string => item !== null)
    .join(' ') || undefined;

  return (
    <label className="block text-sm text-discord-text-secondary" htmlFor={id}>
      <span>{label}</span>
      {help ? <span id={`${id}-help`} className="mt-0.5 block text-xs text-discord-text-muted">{help}</span> : null}
      <input
        id={id}
        type="number"
        inputMode={step >= 1 ? 'numeric' : 'decimal'}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled || saving}
        aria-invalid={error !== null}
        aria-describedby={describedBy}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={className ?? 'mt-1 w-full rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary'}
      />
      {error ? <span id={`${id}-error`} role="alert" className="mt-1 block text-xs text-discord-danger">{error}</span> : null}
    </label>
  );
}
