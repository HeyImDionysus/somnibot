/**
 * Scheduled Messages — Recurring bot posts via cron expressions.
 *
 * Architecture doc §27
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

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

// ── Main Component ────────────────────────────────────────

export default function ScheduledMessagesPage() {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const flash = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduled-messages');
      const json = await res.json();
      if (json.success) setMessages(json.data);
      else setError(json.error);
    } catch {
      setError('Failed to load scheduled messages');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

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
      setForm({ ...emptyForm });
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

    const payload = {
      ...(editingId ? { id: editingId } : {}),
      name: form.name,
      channel_id: form.channel_id,
      message: form.message || null,
      embed_config_id: form.embed_config_id || null,
      cron_expression: form.cron_expression,
      timezone: form.timezone,
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
        flash(editingId ? 'Schedule updated' : 'Schedule created');
      } else {
        setError(json.error);
      }
    } catch {
      setError('Failed to save schedule');
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
        flash('Schedule deleted');
      }
    } catch {
      setError('Failed to delete schedule');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-discord-text-muted">Loading scheduled messages…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Scheduled Messages</h1>
          <p className="text-sm text-discord-text-muted">Automatically send recurring messages on a schedule</p>
        </div>
        <button
          onClick={() => openEditor()}
          className="rounded-input bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-standard"
        >
          + New Schedule
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="rounded-card bg-discord-danger/10 border border-discord-danger/30 px-4 py-3 text-sm text-discord-danger">{error}</div>
      )}
      {success && (
        <div className="rounded-card bg-discord-success/10 border border-discord-success/30 px-4 py-3 text-sm text-discord-success">{success}</div>
      )}

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
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Channel ID *</label>
                <input type="text" value={form.channel_id} onChange={(e) => setForm({ ...form, channel_id: e.target.value })}
                  placeholder="Target channel ID"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Message</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
                  rows={4} placeholder="Message text (supports {server}, {members}, {date}, {time})"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none resize-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-discord-text-muted">Embed Config ID (optional)</label>
                <input type="text" value={form.embed_config_id} onChange={(e) => setForm({ ...form, embed_config_id: e.target.value })}
                  placeholder="UUID from Embed Builder"
                  className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary border border-discord-border-subtle focus:border-discord-accent focus:outline-none" />
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
          {messages.map((sm) => (
            <div key={sm.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">⏰</span>
                    <div>
                      <p className="text-sm font-medium text-discord-text-primary">{sm.name}</p>
                      <p className="text-xs text-discord-text-muted">
                        {describeCron(sm.cron_expression)} · {sm.timezone} · Channel: {sm.channel_id}
                      </p>
                      <p className="text-xs text-discord-text-muted mt-0.5">
                        Sent: {sm.current_sends}{sm.max_sends != null ? `/${sm.max_sends}` : ''} · Last: {relativeTime(sm.last_sent_at)}
                      </p>
                      {sm.message && (
                        <p className="text-xs text-discord-text-muted mt-0.5 truncate max-w-md">{sm.message}</p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <div
                    className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${sm.active ? 'bg-discord-success' : 'bg-discord-bg-tertiary'}`}
                    onClick={() => toggleActive(sm)}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${sm.active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <button onClick={() => openEditor(sm)} className="text-discord-text-muted hover:text-discord-accent text-sm transition-standard">
                    Edit
                  </button>
                  <button onClick={() => deleteMessage(sm.id)} className="text-discord-text-muted hover:text-discord-danger text-sm transition-standard">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Variables Reference ───────────────────────── */}
      <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-discord-text-primary mb-3">Message Variables</h3>
        <div className="grid gap-2 text-xs text-discord-text-muted sm:grid-cols-2">
          <div><code className="text-discord-accent">{'{server}'}</code> — Server name</div>
          <div><code className="text-discord-accent">{'{members}'}</code> — Member count</div>
          <div><code className="text-discord-accent">{'{date}'}</code> — Current date</div>
          <div><code className="text-discord-accent">{'{time}'}</code> — Current time</div>
          <div><code className="text-discord-accent">{'{timestamp}'}</code> — Unix timestamp</div>
          <div><code className="text-discord-accent">{'{memberCount}'}</code> — Member count</div>
        </div>
      </div>
    </div>
  );
}
