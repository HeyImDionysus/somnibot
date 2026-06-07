'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { Button } from '@/components/shared/button';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';
import { cn } from '@/lib/utils/cn';
import { DataRetentionSettings } from '@/components/settings/data-retention';
import {
  Database, MessageSquare, CreditCard, Music, Server,
  CheckCircle2, XCircle, Loader2, Save, Lock, Pencil, ShieldCheck,
  Plus, Trash2, Sparkles,
} from 'lucide-react';

// ============================================================
// Types
// ============================================================

interface ConnectionSection {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  fields: FieldConfig[];
}

interface FieldConfig {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  helpText?: string;
}

// ============================================================
// Configuration
// ============================================================

const SECTIONS: ConnectionSection[] = [
  {
    id: 'supabase',
    title: 'Supabase',
    description: 'Database, authentication, and real-time subscriptions',
    icon: Database,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'supabase_url', label: 'Project URL', placeholder: 'https://your-project.supabase.co' },
      { key: 'supabase_anon_key', label: 'Publishable Key', placeholder: 'sb_publishable_...', secret: true },
      { key: 'supabase_secret_key', label: 'Secret Key', placeholder: 'sb_secret_...', secret: true, helpText: 'Server-side only. Never exposed to the browser.' },
    ],
  },
  {
    id: 'discord',
    title: 'Discord',
    description: 'Bot connection, OAuth login, and server management',
    icon: MessageSquare,
    iconColor: 'text-[#5865F2]',
    fields: [
      { key: 'discord_application_id', label: 'Application ID', placeholder: '1234567890' },
      { key: 'discord_bot_token', label: 'Bot Token', placeholder: 'MTQ3...', secret: true },
      { key: 'discord_guild_id', label: 'Guild ID', placeholder: '1234567890', helpText: 'The Discord server this instance manages.' },
      { key: 'discord_client_secret', label: 'OAuth2 Client Secret', placeholder: 'AbCdEf...', secret: true, helpText: 'Used for Discord login on the dashboard.' },
    ],
  },
  {
    id: 'paypal',
    title: 'PayPal',
    description: 'Payment processing for the store and commerce features',
    icon: CreditCard,
    iconColor: 'text-[#00457C]',
    fields: [
      { key: 'paypal_client_id', label: 'Client ID', placeholder: 'AfDP...' },
      { key: 'paypal_client_secret', label: 'Client Secret', placeholder: 'EIAf...', secret: true },
      { key: 'paypal_webhook_id', label: 'Webhook ID', placeholder: 'YOUR_PAYPAL_WEBHOOK_ID' },
      {
        key: 'paypal_webhook_url',
        label: 'Webhook URL',
        placeholder: 'https://your-domain.example/api/paypal/webhook',
        helpText: 'Use <public-callback-base>/api/paypal/webhook.',
      },
      { key: 'paypal_sandbox', label: 'Sandbox Mode', placeholder: 'true or false', helpText: 'Set to "true" for testing, "false" for live payments.' },
    ],
  },
  {
    id: 'lavalink',
    title: 'Lavalink',
    description: 'Audio streaming for the music system — configured on the bot server, not here',
    icon: Music,
    iconColor: 'text-[#D770AD]',
    fields: [
      { key: 'lavalink_host', label: 'Host', placeholder: 'localhost' },
      { key: 'lavalink_port', label: 'Port', placeholder: '2333' },
      { key: 'lavalink_password', label: 'Password', placeholder: 'YOUR_LAVALINK_PASSWORD', secret: true },
    ],
  },
  {
    id: 'valkey',
    title: 'Valkey / Redis',
    description: 'In-memory cache for sessions, rate limits, and queues — configured on the bot server, not here',
    icon: Server,
    iconColor: 'text-red-400',
    fields: [
      { key: 'valkey_url', label: 'Connection URL', placeholder: 'redis://127.0.0.1:6379' },
    ],
  },
];

// ============================================================
// Helpers
// ============================================================

/** Mask a secret value for display, showing first 4 + last 2 chars */
function maskSecret(value: string): string {
  if (!value || value.length < 8) return '••••••••••';
  return value.slice(0, 4) + '••••••' + value.slice(-2);
}

// ============================================================
// Components
// ============================================================

function LockedSecretField({
  maskedValue,
  onUnlock,
}: {
  maskedValue: string;
  onUnlock: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-muted/70 ring-1 ring-discord-border-subtle font-mono select-none">
        {maskedValue}
      </div>
      <button
        type="button"
        onClick={onUnlock}
        className="flex items-center gap-1.5 rounded-input bg-discord-bg-tertiary px-3 py-2 text-xs font-medium text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary ring-1 ring-discord-border-subtle transition-standard"
      >
        <Pencil size={12} />
        Change
      </button>
    </div>
  );
}

function EditableSecretField({
  value,
  onChange,
  placeholder,
  disabled,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  onCancel?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus
        className={cn(
          'flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted/50 outline-none ring-1 ring-discord-accent transition-standard',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      />
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-input bg-discord-bg-tertiary px-3 py-2 text-xs text-discord-text-muted hover:text-discord-text-secondary ring-1 ring-discord-border-subtle transition-standard"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: 'connected' | 'disconnected' | 'checking' | 'bot-side' }) {
  return (
    <div className="flex items-center gap-1.5">
      {status === 'checking' ? (
        <Loader2 size={14} className="animate-spin text-discord-text-muted" />
      ) : status === 'connected' ? (
        <CheckCircle2 size={14} className="text-green-500" />
      ) : status === 'bot-side' ? (
        <CheckCircle2 size={14} className="text-yellow-500" />
      ) : (
        <XCircle size={14} className="text-discord-text-muted/50" />
      )}
      <span className={cn(
        'text-xs font-medium',
        status === 'connected' ? 'text-green-500'
          : status === 'bot-side' ? 'text-yellow-500'
          : 'text-discord-text-muted',
      )}>
        {status === 'checking' ? 'Checking...'
          : status === 'connected' ? 'Connected'
          : status === 'bot-side' ? 'Bot-side only'
          : 'Not configured'}
      </span>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export default function SettingsPage() {
  const { toast } = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, 'env' | 'db' | 'none'>>({});
  const [statuses, setStatuses] = useState<Record<string, 'connected' | 'disconnected' | 'checking'>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty);
  /** Track which secret fields are in "edit mode" — key = field key */
  const [editingSecrets, setEditingSecrets] = useState<Record<string, boolean>>({});
  /** Temporary edit values for secrets being changed */
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          setValues(data.values || {});
          setStatuses(data.statuses || {});
          setSources(data.sources || {});
        }
      } catch {
        // Settings API might not exist yet
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const updateField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const startEditingSecret = (key: string) => {
    setEditingSecrets((prev) => ({ ...prev, [key]: true }));
    setSecretEdits((prev) => ({ ...prev, [key]: '' }));
  };

  const cancelEditingSecret = (key: string) => {
    setEditingSecrets((prev) => ({ ...prev, [key]: false }));
    setSecretEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const updateSecretEdit = (key: string, value: string) => {
    setSecretEdits((prev) => ({ ...prev, [key]: value }));
  };

  const saveSection = async (sectionId: string) => {
    setSaving(sectionId);
    try {
      const section = SECTIONS.find((s) => s.id === sectionId);
      if (!section) return;

      const sectionValues: Record<string, string> = {};
      for (const field of section.fields) {
        if (field.secret && editingSecrets[field.key] && secretEdits[field.key]) {
          // Use the new edit value for secrets being changed
          sectionValues[field.key] = secretEdits[field.key];
        } else if (!field.secret && values[field.key]) {
          sectionValues[field.key] = values[field.key];
        }
      }

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: sectionId, values: sectionValues }),
      });

      if (res.ok) {
        // Refresh to get updated statuses
        const refreshRes = await fetch('/api/settings');
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          setValues(data.values || {});
          setStatuses(data.statuses || {});
          setSources(data.sources || {});
        }
        // Clear all editing states for this section's secrets
        for (const field of section.fields) {
          if (field.secret) {
            cancelEditingSecret(field.key);
          }
        }
        toast({ title: `${section.title} settings saved`, variant: 'success' });
        setDirty(false);
      }
    } catch {
      toast({ title: 'Failed to save settings', variant: 'error' });
    } finally {
      setSaving(null);
    }
  };

  // ── Bot Presence (custom_bot_statuses) ────
  const [customStatuses, setCustomStatuses] = useState<string[]>([]);
  const [statusesLoading, setStatusesLoading] = useState(true);
  const [statusesSaving, setStatusesSaving] = useState(false);
  const [statusesDirty, setStatusesDirty] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/guild');
        const json = await res.json();
        if (json.config?.custom_bot_statuses) {
          setCustomStatuses(json.config.custom_bot_statuses);
        }
      } catch {
        // Non-fatal
      } finally {
        setStatusesLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <ConfigSkeleton />;
  }

  const addStatus = () => {
    if (customStatuses.length >= 20) return;
    setCustomStatuses((prev) => [...prev, '']);
    setStatusesDirty(true);
  };

  const removeStatus = (index: number) => {
    setCustomStatuses((prev) => prev.filter((_, i) => i !== index));
    setStatusesDirty(true);
  };

  const updateStatus = (index: number, value: string) => {
    setCustomStatuses((prev) => prev.map((s, i) => (i === index ? value : s)));
    setStatusesDirty(true);
  };

  const saveCustomStatuses = async () => {
    setStatusesSaving(true);
    try {
      const filtered = customStatuses.filter((s) => s.trim().length > 0);
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_bot_statuses: filtered }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setCustomStatuses(filtered);
        toast({ title: 'Bot statuses saved', variant: 'success' });
        setStatusesDirty(false);
      } else {
        toast({ title: json.error ?? 'Failed to save', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to save bot statuses', variant: 'error' });
    } finally {
      setStatusesSaving(false);
    }
  };

  // Count connected sections
  const connectedCount = Object.values(statuses).filter((s) => s === 'connected').length;
  const totalSections = SECTIONS.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-discord-text-primary">Settings</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure external connections. Features become available as you connect each service.
          Values set via environment variables are shown as locked.
        </p>
      </div>

      {/* Setup Progress */}
      {connectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-card border border-discord-border-subtle bg-discord-bg-secondary px-4 py-3">
          <ShieldCheck size={20} className={connectedCount === totalSections ? 'text-discord-success' : 'text-discord-warning'} />
          <div className="flex-1">
            <p className="text-sm font-medium text-discord-text-primary">
              {connectedCount === totalSections
                ? 'All services connected'
                : `${connectedCount} of ${totalSections} services connected`}
            </p>
            <p className="text-xs text-discord-text-muted">
              {connectedCount === totalSections
                ? 'Your dashboard is fully configured. Secrets are locked for security.'
                : 'Configure remaining services to unlock all features.'}
            </p>
          </div>
          {/* Progress bar */}
          <div className="w-24 h-2 rounded-full bg-discord-bg-tertiary overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                connectedCount === totalSections ? 'bg-discord-success' : 'bg-discord-warning',
              )}
              style={{ width: `${(connectedCount / totalSections) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Connection Sections */}
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        const status = statuses[section.id] || 'disconnected';
        const isConnected = status === 'connected';

        return (
          <Card key={section.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn('rounded-lg bg-discord-bg-tertiary p-2', section.iconColor)}>
                    <Icon size={20} />
                  </div>
                  <div>
                    <CardTitle className="text-base">{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                </div>
                <StatusDot status={status} />
              </div>
            </CardHeader>

            <div className="space-y-4 px-6 pb-6">
              {section.fields.map((field) => {
                const source = sources[field.key];
                const isFromEnv = source === 'env';
                const hasValue = !!values[field.key];
                const isSecretConfigured = field.secret && hasValue && isConnected;
                const isEditingThis = editingSecrets[field.key];

                return (
                  <div key={field.key}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <label className="text-sm font-medium text-discord-text-secondary">
                        {field.label}
                      </label>
                      {isFromEnv && (
                        <span className="flex items-center gap-1 rounded bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-discord-text-muted">
                          <Lock size={10} />
                          ENV
                        </span>
                      )}
                    </div>

                    {/* Secret fields: locked state when configured, edit mode when changing */}
                    {field.secret ? (
                      isFromEnv ? (
                        /* ENV-locked secret — just show masked, no edit */
                        <div className="rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-muted/70 ring-1 ring-discord-border-subtle font-mono select-none opacity-60">
                          {maskSecret(values[field.key] || '')}
                        </div>
                      ) : isSecretConfigured && !isEditingThis ? (
                        /* Configured secret — locked with Change button */
                        <LockedSecretField
                          maskedValue={maskSecret(values[field.key])}
                          onUnlock={() => startEditingSecret(field.key)}
                        />
                      ) : (
                        /* Unconfigured or actively editing */
                        <EditableSecretField
                          value={isEditingThis ? (secretEdits[field.key] ?? '') : (values[field.key] || '')}
                          onChange={(v) => {
                            if (isEditingThis) {
                              updateSecretEdit(field.key, v);
                            } else {
                              updateField(field.key, v);
                            }
                          }}
                          placeholder={field.placeholder}
                          disabled={false}
                          onCancel={isEditingThis ? () => cancelEditingSecret(field.key) : undefined}
                        />
                      )
                    ) : (
                      /* Non-secret fields — always editable */
                      <input
                        type="text"
                        value={values[field.key] || ''}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        disabled={isFromEnv}
                        className={cn(
                          'w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted/50 outline-none ring-1 ring-discord-border-subtle focus:ring-discord-accent transition-standard',
                          isFromEnv && 'opacity-60 cursor-not-allowed',
                        )}
                      />
                    )}

                    {field.helpText && (
                      <p className="mt-1 text-xs text-discord-text-muted">{field.helpText}</p>
                    )}
                  </div>
                );
              })}

              <div className="flex justify-end pt-2">
                <Button
                  onClick={() => saveSection(section.id)}
                  disabled={saving === section.id}
                  className="gap-2"
                >
                  {saving === section.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  Save {section.title}
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

      {/* Bot Presence — Custom Statuses */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-discord-bg-tertiary p-2 text-discord-accent">
              <Sparkles size={20} />
            </div>
            <div>
              <CardTitle className="text-base">Bot Presence</CardTitle>
              <CardDescription>
                Custom status messages that rotate in the bot&apos;s presence alongside built-in statuses (member count, uptime, now playing).
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <div className="space-y-3 px-6 pb-6">
          {customStatuses.map((status, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={status}
                onChange={(e) => updateStatus(index, e.target.value)}
                maxLength={128}
                placeholder="Custom status text..."
                className="flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted/50 outline-none ring-1 ring-discord-border-subtle focus:ring-discord-accent transition-standard"
              />
              <button
                type="button"
                onClick={() => removeStatus(index)}
                className="rounded-input p-2 text-discord-text-muted hover:text-discord-danger hover:bg-discord-danger/10 transition-standard"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {customStatuses.length < 20 && (
            <button
              type="button"
              onClick={addStatus}
              className="flex items-center gap-1.5 rounded-input px-3 py-2 text-xs font-medium text-discord-text-secondary hover:text-discord-text-primary hover:bg-discord-bg-primary/50 ring-1 ring-discord-border-subtle transition-standard"
            >
              <Plus size={12} />
              Add Status
            </button>
          )}
          <div className="flex justify-end pt-2">
            <Button
              onClick={saveCustomStatuses}
              disabled={statusesSaving || !statusesDirty}
              className="gap-2"
            >
              {statusesSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              Save Statuses
            </Button>
          </div>
        </div>
      </Card>

      {/* V5 Audit §5.2: Data Retention Settings */}
      <DataRetentionSettings />
    </div>
  );
}
