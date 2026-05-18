'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { cn } from '@/lib/utils/cn';
import {
  Database, MessageSquare, CreditCard, Music, Server,
  CheckCircle2, XCircle, Loader2, Eye, EyeOff, Save, Lock,
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
      { key: 'paypal_webhook_id', label: 'Webhook ID', placeholder: 'REDACTED_PAYPAL_WEBHOOK_ID' },
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
      { key: 'lavalink_password', label: 'Password', placeholder: 'youshallnotpass', secret: true },
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
// Components
// ============================================================

function SecretField({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'w-full rounded-input bg-discord-bg-tertiary px-3 py-2 pr-10 text-sm text-discord-text-primary placeholder-discord-text-muted/50 outline-none ring-1 ring-discord-border-subtle focus:ring-discord-accent transition-standard',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-discord-text-muted hover:text-discord-text-secondary transition-standard"
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
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
  const [values, setValues] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, 'env' | 'db' | 'none'>>({});
  const [statuses, setStatuses] = useState<Record<string, 'connected' | 'disconnected' | 'checking'>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
  };

  const saveSection = async (sectionId: string) => {
    setSaving(sectionId);
    try {
      const section = SECTIONS.find((s) => s.id === sectionId);
      if (!section) return;

      const sectionValues: Record<string, string> = {};
      for (const field of section.fields) {
        if (values[field.key]) {
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
          setStatuses(data.statuses || {});
          setSources(data.sources || {});
        }
      }
    } catch {
      // Handle error
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-discord-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-discord-text-primary">Settings</h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure external connections. Features become available as you connect each service.
          Values set via environment variables are shown as locked — override them here or in your hosting provider.
        </p>
      </div>

      {/* Connection Sections */}
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        const status = statuses[section.id] || 'disconnected';

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
                    {field.secret ? (
                      <SecretField
                        value={values[field.key] || ''}
                        onChange={(v) => updateField(field.key, v)}
                        placeholder={field.placeholder}
                        disabled={isFromEnv}
                      />
                    ) : (
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
    </div>
  );
}
