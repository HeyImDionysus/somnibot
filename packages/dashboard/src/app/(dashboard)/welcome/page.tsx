/**
 * Welcome & Goodbye Configuration Page
 * Phase 4: Added "Send Test" buttons and ChannelPicker + RolePicker.
 *
 * Architecture doc §17.5.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { Send, Loader2 } from 'lucide-react';

interface WelcomeConfig {
  welcome_enabled: boolean;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  welcome_card_enabled: boolean;
  welcome_card_background: string | null;
  welcome_dm_enabled: boolean;
  welcome_dm_message: string | null;
  welcome_auto_roles: string[];
  goodbye_enabled: boolean;
  goodbye_channel_id: string | null;
  goodbye_message: string | null;
}

const DEFAULT_CONFIG: WelcomeConfig = {
  welcome_enabled: false,
  welcome_channel_id: null,
  welcome_message: 'Welcome to {server}, {user}! 🎉 You\'re member {memberNumber}.',
  welcome_card_enabled: true,
  welcome_card_background: null,
  welcome_dm_enabled: false,
  welcome_dm_message: 'Hey {user.name}! Welcome to {server}. Check out the channels to get started.',
  welcome_auto_roles: [],
  goodbye_enabled: false,
  goodbye_channel_id: null,
  goodbye_message: '{user.name} left. They were with us for {duration}. 👋',
};

const VARIABLES = [
  { key: '{user}', desc: 'User mention' },
  { key: '{user.name}', desc: 'Username' },
  { key: '{user.tag}', desc: 'Full tag' },
  { key: '{server}', desc: 'Server name' },
  { key: '{memberCount}', desc: 'Total members' },
  { key: '{memberNumber}', desc: 'Join number (#1,234)' },
  { key: '{level}', desc: 'Member level' },
  { key: '{duration}', desc: 'Time in server (goodbye only)' },
];

export default function WelcomePage() {
  const { toast } = useToast();

  const [config, setConfig] = useState<WelcomeConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState<'welcome' | 'goodbye' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/welcome');
        const json = await res.json();
        if (json.success && json.data) {
          setConfig({ ...DEFAULT_CONFIG, ...json.data });
        }
      } catch {
        setError('Failed to load configuration');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/welcome', {
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
  }, [config, toast]);

  const sendTest = async (type: 'welcome' | 'goodbye') => {
    const channelId = type === 'welcome' ? config.welcome_channel_id : config.goodbye_channel_id;
    if (!channelId) {
      toast({ title: `Select a ${type} channel first`, variant: 'error' });
      return;
    }
    setSendingTest(type);
    try {
      const res = await fetch('/api/welcome/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, type }),
      });
      const json = await res.json();
      if (json.success) {
        toast({ title: `Test ${type} message queued — check Discord`, variant: 'success' });
      } else {
        toast({ title: json.error || 'Failed to send test', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to send test', variant: 'error' });
    } finally {
      setSendingTest(null);
    }
  };

  if (loading) {
    return <ConfigSkeleton />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">
          Welcome &amp; Goodbye
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure messages sent when members are verified or leave.
        </p>
      </div>

      {/* Variable Reference */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-2">
          Available Variables
        </h3>
        <div className="flex flex-wrap gap-2">
          {VARIABLES.map((v) => (
            <span
              key={v.key}
              className="rounded bg-discord-bg-tertiary px-2 py-1 text-xs text-discord-text-muted"
            >
              <code className="text-somni-cyan">{v.key}</code>{' '}
              <span className="text-discord-text-muted">— {v.desc}</span>
            </span>
          ))}
        </div>
      </section>

      {/* ═══ Welcome Message ═══ */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-discord-text-primary">
            Welcome Message
          </h2>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={config.welcome_enabled}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, welcome_enabled: e.target.checked }))
              }
            />
            <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
          </label>
        </div>

        {config.welcome_enabled && (
          <div className="mt-4 space-y-4">
            {/* Channel */}
            <ChannelPicker
              label="Channel"
              value={config.welcome_channel_id}
              onChange={(v) =>
                setConfig((prev) => ({ ...prev, welcome_channel_id: v as string | null }))
              }
              placeholder="Select welcome channel…"
              channelTypes={['text', 'announcement']}
            />

            {/* Message */}
            <div>
              <label className="mb-1 block text-sm text-discord-text-muted">Message</label>
              <textarea
                value={config.welcome_message ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, welcome_message: e.target.value }))
                }
                rows={3}
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
                placeholder="Welcome to {server}, {user}!"
              />
              <p className="mt-1.5 text-xs text-discord-text-muted">
                <span className="font-medium text-discord-text-secondary">Variables:</span>{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{user}'}</code> mention,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{user.name}'}</code> name,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{server}'}</code> server name,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{memberCount}'}</code> total members,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{memberNumber}'}</code> join position
              </p>
            </div>

            {/* Welcome Card */}
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={config.welcome_card_enabled}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    welcome_card_enabled: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-discord-border bg-discord-bg-tertiary accent-somni-pink"
              />
              <span className="text-sm text-discord-text-primary">
                Include welcome card image
              </span>
            </label>

            {config.welcome_card_enabled && (
              <div>
                <label className="mb-1 block text-sm text-discord-text-muted">
                  Card Background URL (optional — leave blank for default)
                </label>
                <input
                  type="url"
                  value={config.welcome_card_background ?? ''}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      welcome_card_background: e.target.value || null,
                    }))
                  }
                  className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
                  placeholder="https://example.com/background.png"
                />
              </div>
            )}

            {/* Send Test Welcome */}
            <button
              onClick={() => sendTest('welcome')}
              disabled={!config.welcome_channel_id || sendingTest === 'welcome'}
              className="flex items-center gap-2 rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary transition-colors disabled:opacity-50 ring-1 ring-discord-border-subtle"
            >
              {sendingTest === 'welcome' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              Send Test Welcome
            </button>
          </div>
        )}
      </section>

      {/* ═══ Welcome DM ═══ */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-discord-text-primary">
            Welcome DM
          </h2>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={config.welcome_dm_enabled}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, welcome_dm_enabled: e.target.checked }))
              }
            />
            <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
          </label>
        </div>

        {config.welcome_dm_enabled && (
          <div className="mt-4">
            <label className="mb-1 block text-sm text-discord-text-muted">DM Message</label>
            <textarea
              value={config.welcome_dm_message ?? ''}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, welcome_dm_message: e.target.value }))
              }
              rows={3}
              className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
              placeholder="Hey {user.name}! Welcome to {server}."
            />
          </div>
        )}
      </section>

      {/* ═══ Auto-Roles ═══ */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <h2 className="text-lg font-semibold text-discord-text-primary">
          Auto-Roles
        </h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Additional roles granted alongside the Member role when a member is verified.
        </p>
        <div className="mt-4">
          <RolePicker
            label="Roles to assign on join"
            value={config.welcome_auto_roles ?? []}
            onChange={(v) =>
              setConfig((prev) => ({ ...prev, welcome_auto_roles: v as string[] }))
            }
            placeholder="Select roles…"
            multi
          />
        </div>
      </section>

      {/* ═══ Goodbye Message ═══ */}
      <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-discord-text-primary">
            Goodbye Message
          </h2>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={config.goodbye_enabled}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, goodbye_enabled: e.target.checked }))
              }
            />
            <div className="peer h-6 w-11 rounded-full bg-discord-bg-tertiary after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:bg-green-500 peer-checked:after:translate-x-full" />
          </label>
        </div>

        {config.goodbye_enabled && (
          <div className="mt-4 space-y-4">
            <ChannelPicker
              label="Channel"
              value={config.goodbye_channel_id}
              onChange={(v) =>
                setConfig((prev) => ({ ...prev, goodbye_channel_id: v as string | null }))
              }
              placeholder="Select goodbye channel…"
              channelTypes={['text', 'announcement']}
            />

            <div>
              <label className="mb-1 block text-sm text-discord-text-muted">Message</label>
              <textarea
                value={config.goodbye_message ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, goodbye_message: e.target.value }))
                }
                rows={2}
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder:text-discord-text-muted focus:border-somni-pink focus:outline-none"
                placeholder="{user.name} left. They were with us for {duration}. 👋"
              />
              <p className="mt-1.5 text-xs text-discord-text-muted">
                <span className="font-medium text-discord-text-secondary">Variables:</span>{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{user.name}'}</code> name,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{server}'}</code> server name,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{memberCount}'}</code> total members,{' '}
                <code className="rounded bg-discord-bg-tertiary px-1 py-0.5">{'{duration}'}</code> time in server
              </p>
            </div>

            {/* Send Test Goodbye */}
            <button
              onClick={() => sendTest('goodbye')}
              disabled={!config.goodbye_channel_id || sendingTest === 'goodbye'}
              className="flex items-center gap-2 rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:bg-discord-bg-primary/50 hover:text-discord-text-primary transition-colors disabled:opacity-50 ring-1 ring-discord-border-subtle"
            >
              {sendingTest === 'goodbye' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              Send Test Goodbye
            </button>
          </div>
        )}
      </section>

      {/* Save Button */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-somni-pink px-6 py-2.5 text-sm font-semibold text-white hover:bg-somni-pink/80 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
