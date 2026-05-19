/**
 * Welcome & Goodbye Configuration Page
 *
 * Controls welcome messages (channel + DM + card + auto-roles)
 * and goodbye messages. Architecture doc §17.5.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/components/shared/toast';

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

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_name?: string;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
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
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [welcomeRes, channelsRes, rolesRes] = await Promise.all([
          fetch('/api/welcome'),
          fetch('/api/channels'),
          fetch('/api/roles'),
        ]);
        const welcomeJson = await welcomeRes.json();
        const channelsJson = await channelsRes.json();
        const rolesJson = await rolesRes.json();

        if (welcomeJson.success && welcomeJson.data) {
          setConfig({ ...DEFAULT_CONFIG, ...welcomeJson.data });
        }
        if (channelsJson.success) setChannels(channelsJson.data ?? []);
        if (rolesJson.success) setRoles(rolesJson.data ?? []);
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
  }, [config]);

  const textChannels = channels.filter((c) => c.type === 0 || c.type === 5);

  const toggleAutoRole = (roleId: string) => {
    setConfig((prev) => {
      const current = prev.welcome_auto_roles ?? [];
      const next = current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId];
      return { ...prev, welcome_auto_roles: next };
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-discord-text-muted">Loading...</div>
      </div>
    );
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
              title={v.desc}
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
            <div>
              <label className="mb-1 block text-sm text-discord-text-muted">Channel</label>
              <select
                value={config.welcome_channel_id ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    welcome_channel_id: e.target.value || null,
                  }))
                }
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-somni-pink focus:outline-none"
              >
                <option value="">Select channel...</option>
                {textChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            </div>

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
        <div className="mt-4 space-y-2">
          {roles
            .filter((r) => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map((role) => (
              <label key={role.id} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={config.welcome_auto_roles?.includes(role.id) ?? false}
                  onChange={() => toggleAutoRole(role.id)}
                  className="h-4 w-4 rounded border-discord-border bg-discord-bg-tertiary accent-somni-pink"
                />
                <span
                  className="text-sm"
                  style={{ color: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : undefined }}
                >
                  {role.name}
                </span>
              </label>
            ))}
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
            <div>
              <label className="mb-1 block text-sm text-discord-text-muted">Channel</label>
              <select
                value={config.goodbye_channel_id ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    goodbye_channel_id: e.target.value || null,
                  }))
                }
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus:border-somni-pink focus:outline-none"
              >
                <option value="">Select channel...</option>
                {textChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            </div>

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
            </div>
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
