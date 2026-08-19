/**
 * Scheduled Messages — Recurring bot posts via cron expressions.
 * Phase 4: Replaced raw embed_config_id UUID input with embed picker dropdown.
 *
 * Architecture doc §27
 */
'use client';

import { VariableChips } from '@/components/shared/variable-chips';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

// ── Types ─────────────────────────────────────────────────

interface ScheduledMessage {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string;
  message: string | null;
  embed_config_id: string | null;
  cron_expression: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  max_sends: number | null;
  current_sends: number;
  active: boolean;
  last_sent_at: string | null;
  created_at: string;
}

interface EmbedOption {
  id: string;
  name: string;
}

const PRESETS: Record<string, { label: string; cron: string }> = {
  'every_hour': { label: 'Every Hour', cron: '0 * * * *' },
  'every_6h': { label: 'Every 6 Hours', cron: '0 */6 * * *' },
  'daily_9am': { label: 'Daily at 9:00 AM', cron: '0 9 * * *' },
  'daily_noon': { label: 'Daily at 12:00 PM', cron: '0 12 * * *' },
  'daily_6pm': { label: 'Daily at 6:00 PM', cron: '0 18 * * *' },
  'weekdays_9am': { label: 'Weekdays at 9:00 AM', cron: '0 9 * * 1-5' },
  'weekly_monday': { label: 'Weekly (Monday 9 AM)', cron: '0 9 * * 1' },
  'monthly_first': { label: 'Monthly (1st at 9 AM)', cron: '0 9 1 * *' },
};

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai',
  'Australia/Sydney', 'Pacific/Auckland',
];

const emptyForm = {
  name: '',
  channel_id: '',
  message: '',
  embed_config_id: '',
  cron_expression: '0 9 * * *',
  timezone: 'UTC',
  start_date: '',
  end_date: '',
  max_sends: '',
  preset: 'daily_9am',
  use_custom_cron: false,
};

// ── Helpers ───────────────────────────────────────────────

function describeCron(expr: string): string {
  for (const [, preset] of Object.entries(PRESETS)) {
    if (preset.cron === expr) return preset.label;
  }
  return `Custom: ${expr}`;
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Name display helper ───────────────────────────────────

function SMChannelName({ id }: { id: string }) {
  const { resolveChannel } = useDiscordNames({ channelIds: [id] });
  return <span>{resolveChannel(id)}</span>;
}

// ── Main Component ────────────────────────────────────────

export default function ScheduledMessagesPage() {
  const { toast } = useToast();

  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [embedOptions, setEmbedOptions] = useState<EmbedOption[]>([]);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [defaults, setDefaults] = useState({ max_schedules_per_guild: 25, default_timezone: 'UTC', missed_run_policy: 'skip-missed', allow_embeds: true, variables_enabled: true });
  // Binds the form's variable chips to the message box so a click can never
  // insert into an unrelated field.
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const [msgRes, guildRes] = await Promise.all([
        fetch('/api/scheduled-messages'),
        fetch('/api/guild'),
      ]);
      const json = await msgRes.json();
      if (json.success) setMessages(json.data);
      if (json.success && json.config) setDefaults((d) => ({ ...d, ...json.config }));
      else setError(json.error);
      const guildJson = await guildRes.json();
      if (guildJson.success) {
        setFeatureEnabled(guildJson.config?.scheduled_messages_enabled ?? true);
      }
    } catch {
      setError('Failed to load scheduled messages');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEmbeds = useCallback(async () => {
    try {
      const res = await fetch('/api/embeds');
      const json = await res.json();
      if (json.success) {
        setEmbedOptions(
          (json.data as { id: string; name: string }[]).map((e) => ({
            id: e.id,
            name: e.name,
          })),
        );
      }
    } catch {
      // Non-critical — embed picker will just be empty
    }
  }, []);

  useEffect(() => {
    fetchMessages();
    fetchEmbeds();
  }, [fetchMessages, fetchEmbeds]);

  useAutoRefresh('scheduled_messages', undefined, fetchMessages);

  const toggleFeature = async () => {
    const newValue = !featureEnabled;
    setFeatureEnabled(newValue);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_messages_enabled: newValue }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeatureEnabled(!newValue);
        toast({ title: 'Failed to toggle scheduled messages', variant: 'error' });
      } else {
        toast({ title: newValue ? 'Scheduled messages enabled' : 'Scheduled messages disabled', variant: 'success' });
      }
    } catch {
      setFeatureEnabled(!newValue);
    }
  };

  const saveDefaults = async (patch: Partial<typeof defaults>) => {
    const next = { ...defaults, ...patch };
    setDefaults(next);
    const res = await fetch('/api/guild', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!res.ok) toast({ title: 'Failed to save schedule defaults', variant: 'error' });
  };

  const openEditor = (sm?: ScheduledMessage) => {
    if (sm) {
      setEditingId(sm.id);
      const matchedPreset = Object.entries(PRESETS).find(([, p]) => p.cron === sm.cron_expression);
      setForm({
        name: sm.name,
        channel_id: sm.channel_id,
        message: sm.message ?? '',
        embed_config_id: sm.embed_config_id ?? '',
        cron_expression: sm.cron_expression,
        timezone: sm.timezone,
        start_date: sm.start_date ? sm.start_date.slice(0, 16) : '',
        end_date: sm.end_date ? sm.end_date.slice(0, 16) : '',
        max_sends: sm.max_sends != null ? String(sm.max_sends) : '',
        preset: matchedPreset ? matchedPreset[0] : '',
        use_custom_cron: !matchedPreset,
      });
    } else {
      setEditingId(null);
      setForm({ ...emptyForm, timezone: defaults.default_timezone });
    }
    setShowForm(true);
  };

  const save = async () => {
    setError(null);
    if (!form.name || !form.channel_id || !form.cron_expression) {
      setError('Name, Channel ID, and schedule are required');
      return;
    }
    if (!form.message && !form.embed_config_id) {
      setError('Either a message or an embed config is required');
      return;
    }
    // Basic cron expression validation (5 or 6 parts)
    const cronParts = form.cron_expression.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      setError('Invalid cron expression — expected 5 or 6 fields (e.g. "0 9 * * 1-5")');
      toast({ title: 'Invalid cron expression', variant: 'error' });
      return;
    }

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      name: form.name,
      channel_id: form.channel_id,
      message: form.message || null,
      embed_config_id: form.embed_config_id || null,
      cron_expression: form.cron_expression,
      timezone: form.timezone || defaults.default_timezone,
      start_date: form.start_date ? new Date(form.start_date).toISOString() : null,
      end_date: form.end_date ? new Date(form.end_date).toISOString() : null,
      max_sends: form.max_sends ? parseInt(form.max_sends, 10) : null,
    };

    try {
      const res = await fetch('/api/scheduled-messages', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        if (editingId) {
          setMessages(messages.map((m) => (m.id === editingId ? json.data : m)));
        } else {
          setMessages([...messages, json.data]);
        }
        setShowForm(false);
        toast({ title: editingId ? 'Schedule updated' : 'Schedule created', variant: 'success' });
      } else {
        setError(json.error);
        toast({ title: json.error || 'Failed to save', variant: 'error' });
      }
    } catch {
      setError('Failed to save schedule');
      toast({ title: 'Failed to save schedule', variant: 'error' });
    }
  };

  const toggleActive = async (sm: ScheduledMessage) => {
    try {
      const res = await fetch('/api/scheduled-messages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sm.id, active: !sm.active }),
      });
      const json = await res.json();
      if (json.success) {
        setMessages(messages.map((m) => (m.id === sm.id ? json.data : m)));
      }
    } catch {
      setError('Failed to toggle schedule');
    }
  };

  const deleteMessage = async (id: string) => {
    try {
      const res = await fetch(`/api/scheduled-messages?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setMessages(messages.filter((m) => m.id !== id));
        toast({ title: 'Schedule deleted', variant: 'success' });
      }
    } catch {
      setError('Failed to delete schedule');
    }
  };

  /** Resolve embed name from ID */
  const resolveEmbedName = (id: string | null): string | null => {
    if (!id) return null;
    const found = embedOptions.find((e) => e.id === id);
    return found ? found.name : null;
  };

  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-0 sm:p-6">
      {/* Header */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start justify-between gap-3 sm:items-center sm:justify-start">
          <div>
            <h1 className="text-2xl font-bold text-discord-text-primary">Scheduled Messages</h1>
            <p className="text-sm text-discord-text-muted">Automatically send recurring messages on a schedule</p>
          </div>
          <button
            onClick={toggleFeature}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${featureEnabled ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
            title={featureEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${featureEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <button
          onClick={() => openEditor()}
          className="self-start rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard sm:self-auto"
        >
          + New Schedule
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}

      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3 text-sm text-discord-text-primary">
        <div className="flex flex-wrap gap-4 items-center">
          <label>Max schedules <input type="number" min={1} max={200} value={defaults.max_schedules_per_guild} onChange={(e) => saveDefaults({ max_schedules_per_guild: Number(e.target.value) })} className="ml-2 w-16 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
          <label>Default timezone <input value={defaults.default_timezone} onChange={(e) => saveDefaults({ default_timezone: e.target.value })} className="ml-2 w-40 rounded bg-discord-bg-tertiary px-2 py-1" /></label>
          <label>Missed runs <select value={defaults.missed_run_policy} onChange={(e) => saveDefaults({ missed_run_policy: e.target.value as typeof defaults.missed_run_policy })} className="ml-2 rounded bg-discord-bg-tertiary px-2 py-1"><option value="skip-missed">Skip + notify</option><option value="send-latest">Send latest</option></select></label>
          <label><input type="checkbox" checked={defaults.allow_embeds} onChange={(e) => saveDefaults({ allow_embeds: e.target.checked })} /> Allow embeds</label>
          <label><input type="checkbox" checked={defaults.variables_enabled} onChange={(e) => saveDefaults({ variables_enabled: e.target.checked })} /> Enable variables</label>
        </div>
      </div>

      {/* ── Editor Modal ─────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-discord-text-primary">
              {editingId ? 'Edit Schedule' : 'New Schedule'}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Name *</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Daily Reminder"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <ChannelPicker
                  label="Channel *"
                  value={form.channel_id || null}
                  onChange={(v) => setForm({ ...form, channel_id: (v as string) ?? '' })}
                  placeholder="Select target channel…"
                  channelTypes={['text', 'announcement']}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Message</label>
                <textarea ref={messageRef} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
                  rows={4} placeholder="Message text (supports {server}, {members}, {date}, {time})"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none" />
                <VariableChips
                  targetRef={messageRef}
                  variables={[
                    { key: '{server}', desc: 'Server name' },
                    { key: '{members}', desc: 'Member count' },
                    { key: '{date}', desc: 'Current date' },
                    { key: '{time}', desc: 'Current time' },
                    { key: '{timestamp}', desc: 'Unix timestamp' },
                    { key: '{memberCount}', desc: 'Member count' },
                  ]}
                />
              </div>

              {/* Embed picker — replaces raw UUID input */}
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Embed Template (optional)</label>
                <select
                  value={form.embed_config_id}
                  onChange={(e) => setForm({ ...form, embed_config_id: e.target.value })}
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none"
                >
                  <option value="">None — text message only</option>
                  {embedOptions.map((embed) => (
                    <option key={embed.id} value={embed.id}>
                      {embed.name}
                    </option>
                  ))}
                </select>
                {embedOptions.length === 0 && (
                  <p className="mt-1 text-xs text-discord-text-muted">
                    No embed templates yet — create one in the Embed Builder first.
                  </p>
                )}
              </div>

              {/* Schedule */}
              <div className="border-t border-discord-border-subtle pt-4">
                <label className="mb-2 block text-xs font-medium text-discord-text-muted">Schedule *</label>
                {!form.use_custom_cron ? (
                  <div className="space-y-2">
                    <select value={form.preset} onChange={(e) => {
                      const preset = PRESETS[e.target.value];
                      if (preset) {
                        setForm({ ...form, preset: e.target.value, cron_expression: preset.cron });
                      }
                    }}
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none">
                      {Object.entries(PRESETS).map(([key, p]) => (
                        <option key={key} value={key}>{p.label}</option>
                      ))}
                    </select>
                    <button onClick={() => setForm({ ...form, use_custom_cron: true })}
                      className="text-xs text-discord-accent hover:underline">
                      Use custom cron expression
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input type="text" value={form.cron_expression} onChange={(e) => setForm({ ...form, cron_expression: e.target.value })}
                      placeholder="0 9 * * *"
                      className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none font-mono" />
                    <p className="text-xs text-discord-text-muted">Format: minute hour dayOfMonth month dayOfWeek</p>
                    <button onClick={() => setForm({ ...form, use_custom_cron: false, preset: 'daily_9am', cron_expression: '0 9 * * *' })}
                      className="text-xs text-discord-accent hover:underline">
                      Use preset
                    </button>
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Timezone</label>
                  <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none">
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Max Sends</label>
                  <input type="number" value={form.max_sends} onChange={(e) => setForm({ ...form, max_sends: e.target.value })}
                    min="1" placeholder="Unlimited"
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">Start Date</label>
                  <input type="datetime-local" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-discord-text-muted">End Date</label>
                  <input type="datetime-local" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                    className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="rounded-input bg-discord-bg-tertiary px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-standard">
                Cancel
              </button>
              <button onClick={save} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
                {editingId ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Message List ─────────────────────────────── */}
      {messages.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">⏰</div>
          <h2 className="text-lg font-semibold text-discord-text-primary mb-1">No Scheduled Messages</h2>
          <p className="text-sm text-discord-text-muted mb-4">Set up recurring messages to automatically post in your channels.</p>
          <button onClick={() => openEditor()} className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard">
            + Create First Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((sm) => {
            const embedName = resolveEmbedName(sm.embed_config_id);

            return (
              <div key={sm.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
                <div className="flex flex-col items-stretch gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="text-2xl">⏰</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-discord-text-primary [overflow-wrap:anywhere]">{sm.name}</p>
                        <p className="text-xs text-discord-text-muted">
                          {describeCron(sm.cron_expression)} · {sm.timezone} · <SMChannelName id={sm.channel_id} />
                        </p>
                        <p className="text-xs text-discord-text-muted mt-0.5">
                          Sent: {sm.current_sends}{sm.max_sends != null ? `/${sm.max_sends}` : ''} · Last: {relativeTime(sm.last_sent_at)}
                          {embedName && <> · Embed: <span className="text-discord-accent">{embedName}</span></>}
                        </p>
                        {sm.message && (
                          <p className="text-xs text-discord-text-muted mt-0.5 truncate max-w-md">{sm.message}</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-4 sm:shrink-0">
                    <div
                      className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${sm.active ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                      onClick={() => toggleActive(sm)}
                    >
                      <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${sm.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <button onClick={() => openEditor(sm)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                      Edit
                    </button>
                    <button onClick={() => setConfirmDelete(sm.id)} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Variables Reference ───────────────────────── */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-3">Message Variables</h3>
        <VariableChips
          variables={[
                    { key: '{server}', desc: 'Server name' },
                    { key: '{members}', desc: 'Member count' },
                    { key: '{date}', desc: 'Current date' },
                    { key: '{time}', desc: 'Current time' },
                    { key: '{timestamp}', desc: 'Unix timestamp' },
                    { key: '{memberCount}', desc: 'Member count' },
                  ]}
        />
      </div>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Scheduled Message"
        description="Delete this scheduled message? It will no longer be sent at its scheduled times."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteMessage(confirmDelete);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
