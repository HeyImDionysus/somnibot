'use client';

import { Lock, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { ConnectionFieldConfig, SettingSource } from './connection-settings-config';

interface ConnectionSettingFieldProps {
  field: ConnectionFieldConfig;
  value: string;
  source: SettingSource;
  locked: boolean;
  editingSecret: boolean;
  secretEdit: string;
  onChange: (value: string) => void;
  onStartSecretEdit: () => void;
  onSecretEdit: (value: string) => void;
  onCancelSecretEdit: () => void;
}

function sourceLabel(source: SettingSource, locked: boolean): string | null {
  if (locked) return 'Deployment only';
  if (source === 'db') return 'Saved override';
  if (source === 'env') return 'Environment default';
  return null;
}

function SourceBadge({ source, locked }: { source: SettingSource; locked: boolean }) {
  const label = sourceLabel(source, locked);
  if (!label) return null;

  return (
    <span className="flex items-center gap-1 rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-discord-text-muted">
      {locked && <Lock size={10} aria-hidden="true" />}
      {label}
    </span>
  );
}

function SecretDisplay({ value, onChange }: { value: string; onChange: () => void }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 select-none rounded-input bg-discord-bg-tertiary px-3 py-2 font-mono text-sm text-discord-text-muted/70 ring-1 ring-discord-border-subtle">
        {value || '••••••••'}
      </div>
      <button
        type="button"
        onClick={onChange}
        className="flex min-h-9 items-center justify-center gap-1.5 rounded-input bg-discord-bg-tertiary px-3 py-2 text-xs font-medium text-discord-text-secondary ring-1 ring-discord-border-subtle transition-standard hover:bg-discord-bg-primary/50 hover:text-discord-text-primary"
      >
        <Pencil size={12} aria-hidden="true" />
        Change
      </button>
    </div>
  );
}

export function ConnectionSettingField({
  field,
  value,
  source,
  locked,
  editingSecret,
  secretEdit,
  onChange,
  onStartSecretEdit,
  onSecretEdit,
  onCancelSecretEdit,
}: ConnectionSettingFieldProps) {
  const inputId = `setting-${field.key}`;
  const describedBy = `${inputId}-help`;

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-discord-text-secondary">
          {field.label}
        </label>
        <SourceBadge source={source} locked={locked} />
      </div>

      {field.secret && !editingSecret ? (
        locked ? (
          <div
            id={inputId}
            className="select-none rounded-input bg-discord-bg-tertiary px-3 py-2 font-mono text-sm text-discord-text-muted/70 opacity-60 ring-1 ring-discord-border-subtle"
          >
            {value || '••••••••'}
          </div>
        ) : value ? (
          <SecretDisplay value={value} onChange={onStartSecretEdit} />
        ) : (
          <input
            id={inputId}
            type="password"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            aria-describedby={describedBy}
            autoComplete="new-password"
            className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none ring-1 ring-discord-border-subtle transition-standard placeholder:text-discord-text-muted/50 focus:ring-discord-accent"
          />
        )
      ) : field.secret ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={inputId}
            type="password"
            value={secretEdit}
            onChange={(event) => onSecretEdit(event.target.value)}
            placeholder={field.placeholder}
            aria-describedby={describedBy}
            autoComplete="new-password"
            autoFocus
            className="min-w-0 flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none ring-1 ring-discord-accent transition-standard placeholder:text-discord-text-muted/50"
          />
          <button
            type="button"
            onClick={onCancelSecretEdit}
            className="min-h-9 rounded-input bg-discord-bg-tertiary px-3 py-2 text-xs text-discord-text-muted ring-1 ring-discord-border-subtle transition-standard hover:text-discord-text-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          disabled={locked}
          aria-describedby={describedBy}
          className={cn(
            'w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none ring-1 ring-discord-border-subtle transition-standard placeholder:text-discord-text-muted/50 focus:ring-discord-accent',
            locked && 'cursor-not-allowed opacity-60',
          )}
        />
      )}

      <p id={describedBy} className="mt-1 text-xs text-discord-text-muted">
        {locked
          ? 'This dashboard needs the Supabase bootstrap value before saved settings can be loaded. Change it in the deployment configuration.'
          : field.helpText ?? (source === 'env'
            ? 'Editing this creates a saved override; the environment value remains the fallback.'
            : 'Saved for this SomniBot installation.')}
      </p>
    </div>
  );
}
