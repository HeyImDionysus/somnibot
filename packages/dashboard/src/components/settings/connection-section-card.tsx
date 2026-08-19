'use client';

import { CheckCircle2, Loader2, RotateCcw, Save, XCircle } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/shared/card';
import { cn } from '@/lib/utils/cn';
import { ConnectionSettingField } from './connection-setting-field';
import type {
  ConnectionSectionConfig,
  ConnectionStatus,
  SettingSource,
} from './connection-settings-config';

interface ConnectionSectionCardProps {
  section: ConnectionSectionConfig;
  values: Record<string, string>;
  sources: Record<string, SettingSource>;
  lockedFields: Set<string>;
  status: ConnectionStatus;
  saving: boolean;
  canSave: boolean;
  canReset: boolean;
  editingSecrets: Record<string, boolean>;
  secretEdits: Record<string, string>;
  onFieldChange: (key: string, value: string) => void;
  onStartSecretEdit: (key: string) => void;
  onSecretEdit: (key: string, value: string) => void;
  onCancelSecretEdit: (key: string) => void;
  onSave: () => void;
  onReset: () => void;
}

function Status({ status }: { status: ConnectionStatus }) {
  const label = status === 'checking' ? 'Checking…'
    : status === 'connected' ? 'Configured'
      : status === 'bot-side' ? 'Configured on bot'
        : 'Not configured';

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {status === 'checking' ? (
        <Loader2 size={14} className="animate-spin text-discord-text-muted" aria-hidden="true" />
      ) : status === 'connected' || status === 'bot-side' ? (
        <CheckCircle2
          size={14}
          className={status === 'connected' ? 'text-discord-success' : 'text-discord-warning'}
          aria-hidden="true"
        />
      ) : (
        <XCircle size={14} className="text-discord-text-muted/50" aria-hidden="true" />
      )}
      <span className={cn(
        'text-xs font-medium',
        status === 'connected' ? 'text-discord-success'
          : status === 'bot-side' ? 'text-discord-warning'
            : 'text-discord-text-muted',
      )}>
        {label}
      </span>
    </div>
  );
}

export function ConnectionSectionCard({
  section,
  values,
  sources,
  lockedFields,
  status,
  saving,
  canSave,
  canReset,
  editingSecrets,
  secretEdits,
  onFieldChange,
  onStartSecretEdit,
  onSecretEdit,
  onCancelSecretEdit,
  onSave,
  onReset,
}: ConnectionSectionCardProps) {
  const Icon = section.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn('shrink-0 rounded-lg bg-discord-bg-tertiary p-2', section.iconColor)}>
              <Icon size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </div>
          </div>
          <Status status={status} />
        </div>
      </CardHeader>

      <div className="space-y-4 px-4 pb-5 sm:px-6 sm:pb-6">
        {section.fields.map((field) => (
          <ConnectionSettingField
            key={field.key}
            field={field}
            value={values[field.key] ?? ''}
            source={sources[field.key] ?? 'none'}
            locked={lockedFields.has(field.key)}
            editingSecret={editingSecrets[field.key] ?? false}
            secretEdit={secretEdits[field.key] ?? ''}
            onChange={(value) => onFieldChange(field.key, value)}
            onStartSecretEdit={() => onStartSecretEdit(field.key)}
            onSecretEdit={(value) => onSecretEdit(field.key, value)}
            onCancelSecretEdit={() => onCancelSecretEdit(field.key)}
          />
        ))}

        {section.bootstrapOnly ? (
          <p className="rounded-input border border-discord-border-subtle bg-discord-bg-tertiary/60 px-3 py-2 text-xs text-discord-text-muted">
            Supabase is the bootstrap connection used to load this page, so these three values remain deployment-managed.
          </p>
        ) : (
          <div className="flex flex-col gap-2 border-t border-discord-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-discord-text-muted">
              Connection changes are loaded the next time the bot and dashboard start.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {canReset && (
                <Button variant="secondary" onClick={onReset} className="gap-2 sm:shrink-0">
                  <RotateCcw size={14} aria-hidden="true" />
                  Use deployment defaults
                </Button>
              )}
              <Button onClick={onSave} disabled={saving || !canSave} className="gap-2 sm:shrink-0">
                {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                Save {section.title}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
