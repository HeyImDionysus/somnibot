/**
 * Ticket Panels — Full panel builder + ticket management.
 *
 * Architecture doc §19.2
 */
'use client';

import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { useToast } from '@/components/shared/toast';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

import { useEffect, useState, useCallback } from 'react';
import { useAutoRefresh } from '@/hooks/use-realtime-events';
import Link from 'next/link';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { RolePicker } from '@/components/shared/role-picker';
import { useDiscordNames } from '@/hooks/use-discord-names';

interface TicketType {
  id: string;
  label: string;
  emoji: string;
  color: 'blue' | 'grey' | 'green' | 'red';
  description?: string;
  categoryOverride?: string;
  managerRoleOverride?: string[];
  introMessageOverride?: string;
}

interface TicketPanel {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string;
  message_id: string | null;
  panel_message: { title?: string; description?: string; footer?: string };
  input_mode: 'buttons' | 'dropdown';
  ticket_types: TicketType[];
  manager_roles: string[];
  open_category_id: string;
  closed_category_id: string | null;
  transcript_channel_id: string | null;
  dm_transcript_to_creator: boolean;
  max_open_per_user: number;
  introduction_message: string | null;
  active: boolean;
  created_at: string;
}

interface Ticket {
  id: string;
  ticket_number: number;
  creator_id: string;
  type: string;
  status: string;
  claimed_by: string | null;
  closed_by: string | null;
  close_reason: string | null;
  message_count: number;
  created_at: string;
  closed_at: string | null;
}

const COLOR_OPTIONS = [
  { value: 'blue', label: 'Blue', class: 'bg-blue-500' },
  { value: 'grey', label: 'Grey', class: 'bg-gray-500' },
  { value: 'green', label: 'Green', class: 'bg-green-500' },
  { value: 'red', label: 'Red', class: 'bg-red-500' },
];

const EMOJI_OPTIONS = ['🎫', '💳', '🔧', '❓', '📦', '🛡️', '💬', '🎁', '⚡', '🔑'];

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function TicketMemberName({ id }: { id: string }) {
  const { resolveMember } = useDiscordNames({ memberIds: [id] });
  return <span>{resolveMember(id)}</span>;
}

export default function TicketsPage() {
  const [panels, setPanels] = useState<TicketPanel[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'panels' | 'tickets'>('panels');
  const [editingPanel, setEditingPanel] = useState<TicketPanel | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: string; id: string; label: string } | null>(null);
  const { toast } = useToast();
  const [ticketFilter, setTicketFilter] = useState<string>('all');
  const [ticketPage, setTicketPage] = useState(0);
  const TICKET_PAGE_SIZE = 50;
  const [transcriptEnabled, setTranscriptEnabled] = useState(false);
  const [dmTranscript, setDmTranscript] = useState(false);
  const [togglingTranscript, setTogglingTranscript] = useState(false);

  const loadPanels = useCallback(async () => {
    try {
      const res = await fetch('/api/tickets/panels');
      const json = await res.json();
      if (json.success) setPanels(json.data);
    } catch {
      setError('Failed to load panels');
    }
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      const statusParam = ticketFilter !== 'all' ? `&status=${ticketFilter}` : '';
      const res = await fetch(`/api/tickets?limit=${TICKET_PAGE_SIZE}&offset=${ticketPage * TICKET_PAGE_SIZE}${statusParam}`);
      const json = await res.json();
      if (json.success) {
        setTickets(json.data);
        setTicketTotal(json.total);
      }
    } catch {
      setError('Failed to load tickets');
    }
  }, [ticketFilter, ticketPage]);

  const loadGuildDefaults = useCallback(async () => {
    try {
      const res = await fetch('/api/guild');
      const json = await res.json();
      if (json.config) {
        setTranscriptEnabled(json.config.ticket_transcript_enabled ?? false);
        setDmTranscript(json.config.ticket_dm_transcript ?? false);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    Promise.all([loadPanels(), loadTickets(), loadGuildDefaults()]).finally(() => setLoading(false));
  }, [loadPanels, loadTickets, loadGuildDefaults]);

  const toggleTranscriptDefault = async (key: 'ticket_transcript_enabled' | 'ticket_dm_transcript', value: boolean) => {
    setTogglingTranscript(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        if (key === 'ticket_transcript_enabled') setTranscriptEnabled(value);
        else setDmTranscript(value);
        toast({ title: 'Default updated', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to update', variant: 'error' });
    } finally {
      setTogglingTranscript(false);
    }
  };

  useEffect(() => {
    if (!loading) loadTickets();
  }, [ticketFilter, loading, loadTickets]);

  // GAP 2: Live updates — auto-refresh when ticket data changes in DB
  useAutoRefresh('tickets', undefined, loadTickets);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const openNewPanel = () => {
    setEditingPanel({
      id: '',
      guild_id: '',
      name: '',
      channel_id: '',
      message_id: null,
      panel_message: {
        title: '🎫 Support Tickets',
        description: 'Click a button below to open a ticket. Our team will assist you as soon as possible.',
      },
      input_mode: 'buttons',
      ticket_types: [
        { id: generateId(), label: 'General', emoji: '❓', color: 'blue', description: 'General support' },
      ],
      manager_roles: [],
      open_category_id: '',
      closed_category_id: null,
      transcript_channel_id: null,
      dm_transcript_to_creator: false,
      max_open_per_user: 3,
      introduction_message: null,
      active: true,
      created_at: '',
    });
    setShowEditor(true);
  };

  const editPanel = (panel: TicketPanel) => {
    setEditingPanel({ ...panel });
    setShowEditor(true);
  };

  const savePanel = async () => {
    if (!editingPanel) return;
    clearMessages();
    setSaving(true);

    try {
      const isNew = !editingPanel.id;
      const method = isNew ? 'POST' : 'PUT';
      const res = await fetch('/api/tickets/panels', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingPanel),
      });
      const json = await res.json();

      if (!json.success) throw new Error(json.error);

      const msg = isNew ? 'Panel created! Post it to Discord from the panel list.' : 'Panel updated!';
      setSuccess(msg);
      toast({ title: msg, variant: 'success' });
      setShowEditor(false);
      setEditingPanel(null);
      await loadPanels();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save panel';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deletePanel = async (id: string) => {
    clearMessages();
    try {
      const res = await fetch(`/api/tickets/panels?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setSuccess('Panel deleted');
      toast({ title: 'Panel deleted', variant: 'success' });
      await loadPanels();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete panel';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    }
  };

  const togglePanel = async (panel: TicketPanel) => {
    clearMessages();
    try {
      const res = await fetch('/api/tickets/panels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: panel.id, active: !panel.active }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast({ title: panel.active ? 'Panel disabled' : 'Panel enabled', variant: 'success' });
      await loadPanels();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to toggle panel';
      setError(msg);
      toast({ title: msg, variant: 'error' });
    }
  };

  // ── Ticket Type Helpers ──────────────────────────────

  const addTicketType = () => {
    if (!editingPanel) return;
    setEditingPanel({
      ...editingPanel,
      ticket_types: [
        ...editingPanel.ticket_types,
        { id: generateId(), label: '', emoji: '🎫', color: 'blue' },
      ],
    });
  };

  const removeTicketType = (index: number) => {
    if (!editingPanel) return;
    setEditingPanel({
      ...editingPanel,
      ticket_types: editingPanel.ticket_types.filter((_, i) => i !== index),
    });
  };

  const updateTicketType = (index: number, updates: Partial<TicketType>) => {
    if (!editingPanel) return;
    const types = [...editingPanel.ticket_types];
    types[index] = { ...types[index], ...updates };
    setEditingPanel({ ...editingPanel, ticket_types: types });
  };

  if (loading) {
    return <CardListSkeleton />;
  }

  // ── Panel Editor ─────────────────────────────────────

  if (showEditor && editingPanel) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-discord-text-primary">
            {editingPanel.id ? 'Edit Panel' : 'Create Panel'}
          </h1>
          <button
            onClick={() => { setShowEditor(false); setEditingPanel(null); clearMessages(); }}
            className="text-sm text-discord-text-muted hover:text-discord-text-primary"
          >
            ← Back
          </button>
        </div>

        {/* Panel Name */}
        <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6 space-y-5">
          <h2 className="text-lg font-semibold text-discord-text-primary">Panel Settings</h2>

          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Panel Name</label>
            <input
              type="text"
              value={editingPanel.name}
              onChange={(e) => setEditingPanel({ ...editingPanel, name: e.target.value })}
              placeholder="e.g., Support Tickets"
              className="w-full max-w-md rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <ChannelPicker
                label="Panel Channel"
                hint="The channel where the panel message will be posted."
                value={editingPanel.channel_id || null}
                onChange={(v) => setEditingPanel({ ...editingPanel, channel_id: (v as string) ?? '' })}
                placeholder="Select channel…"
                channelTypes={['text', 'announcement']}
              />
            </div>
            <div>
              <ChannelPicker
                label="Open Tickets Category"
                hint="Discord category where new tickets are created."
                value={editingPanel.open_category_id || null}
                onChange={(v) => setEditingPanel({ ...editingPanel, open_category_id: (v as string) ?? '' })}
                placeholder="Select category…"
                channelTypes={['category']}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <ChannelPicker
                label="Closed Tickets Category"
                hint="Optional. Move closed tickets here."
                value={editingPanel.closed_category_id}
                onChange={(v) => setEditingPanel({ ...editingPanel, closed_category_id: (v as string) || null })}
                placeholder="Select category (optional)"
                channelTypes={['category']}
                allowNone
              />
            </div>
            <div>
              <ChannelPicker
                label="Transcript Channel"
                hint="Optional. Post transcripts to this channel."
                value={editingPanel.transcript_channel_id}
                onChange={(v) => setEditingPanel({ ...editingPanel, transcript_channel_id: (v as string) || null })}
                placeholder="Select channel (optional)"
                channelTypes={['text']}
                allowNone
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-discord-text-primary mb-1">Input Mode</label>
              <select
                value={editingPanel.input_mode}
                onChange={(e) => setEditingPanel({ ...editingPanel, input_mode: e.target.value as 'buttons' | 'dropdown' })}
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
              >
                <option value="buttons">Buttons</option>
                <option value="dropdown">Dropdown</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-discord-text-primary mb-1">Max Open Per User</label>
              <input
                type="number"
                min={1}
                max={10}
                value={editingPanel.max_open_per_user}
                onChange={(e) => setEditingPanel({ ...editingPanel, max_open_per_user: parseInt(e.target.value) || 3 })}
                className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-discord-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingPanel.dm_transcript_to_creator}
                  onChange={(e) => setEditingPanel({ ...editingPanel, dm_transcript_to_creator: e.target.checked })}
                  className="rounded"
                />
                DM transcript to creator
              </label>
            </div>
          </div>

          <div>
            <RolePicker
              label="Manager Roles"
              hint="Roles that can see and manage tickets."
              value={editingPanel.manager_roles}
              onChange={(v) => setEditingPanel({ ...editingPanel, manager_roles: (v as string[]) ?? [] })}
              multi
              placeholder="Select manager roles…"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Introduction Message</label>
            <p className="text-xs text-discord-text-muted mb-2">Shown when a ticket is opened. Supports Discord markdown.</p>
            <textarea
              value={editingPanel.introduction_message || ''}
              onChange={(e) => setEditingPanel({ ...editingPanel, introduction_message: e.target.value || null })}
              placeholder="Welcome! A staff member will be with you shortly."
              rows={3}
              className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none resize-none"
            />
          </div>
        </section>

        {/* Panel Message (Embed) */}
        <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6 space-y-4">
          <h2 className="text-lg font-semibold text-discord-text-primary">Panel Message</h2>
          <p className="text-sm text-discord-text-muted">The embed shown in the panel channel.</p>

          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Embed Title</label>
            <input
              type="text"
              value={(editingPanel.panel_message.title as string) || ''}
              onChange={(e) => setEditingPanel({ ...editingPanel, panel_message: { ...editingPanel.panel_message, title: e.target.value } })}
              placeholder="🎫 Support Tickets"
              className="w-full max-w-md rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Embed Description</label>
            <textarea
              value={(editingPanel.panel_message.description as string) || ''}
              onChange={(e) => setEditingPanel({ ...editingPanel, panel_message: { ...editingPanel.panel_message, description: e.target.value } })}
              placeholder="Click a button below to open a ticket."
              rows={3}
              className="w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-discord-text-primary mb-1">Embed Footer</label>
            <input
              type="text"
              value={(editingPanel.panel_message.footer as string) || ''}
              onChange={(e) => setEditingPanel({ ...editingPanel, panel_message: { ...editingPanel.panel_message, footer: e.target.value } })}
              placeholder="Optional footer text"
              className="w-full max-w-md rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
            />
          </div>
        </section>

        {/* Ticket Types */}
        <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-discord-text-primary">Ticket Types</h2>
              <p className="text-sm text-discord-text-muted">Each type becomes a button or dropdown option.</p>
            </div>
          </div>

          <div className="space-y-3">
            {editingPanel.ticket_types.map((tt, idx) => (
              <div key={tt.id} className="rounded-lg border border-discord-border bg-discord-bg-tertiary p-4 space-y-3">
                <div className="flex items-center gap-3">
                  {/* Emoji picker */}
                  <select
                    value={tt.emoji}
                    onChange={(e) => updateTicketType(idx, { emoji: e.target.value })}
                    className="w-16 rounded border border-discord-border bg-discord-bg-secondary px-2 py-1.5 text-center text-lg"
                  >
                    {EMOJI_OPTIONS.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </select>

                  {/* Label */}
                  <input
                    type="text"
                    value={tt.label}
                    onChange={(e) => updateTicketType(idx, { label: e.target.value })}
                    placeholder="Type label (e.g., Billing)"
                    className="flex-1 rounded border border-discord-border bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
                  />

                  {/* Color */}
                  <div className="flex items-center gap-1">
                    {COLOR_OPTIONS.map((c) => (
                      <button
                        key={c.value}
                        onClick={() => updateTicketType(idx, { color: c.value as TicketType['color'] })}
                        className={`w-6 h-6 rounded-full ${c.class} ${tt.color === c.value ? 'ring-2 ring-white ring-offset-2 ring-offset-discord-bg-tertiary' : 'opacity-50 hover:opacity-80'}`}
                        title={c.label}
                      />
                    ))}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => removeTicketType(idx)}
                    className="text-discord-text-muted hover:text-red-400"
                    title="Remove type"
                  >
                    ✕
                  </button>
                </div>

                {/* Description (for dropdown) */}
                {editingPanel.input_mode === 'dropdown' && (
                  <input
                    type="text"
                    value={tt.description || ''}
                    onChange={(e) => updateTicketType(idx, { description: e.target.value || undefined })}
                    placeholder="Dropdown description (optional)"
                    className="w-full rounded border border-discord-border bg-discord-bg-secondary px-3 py-1.5 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
                  />
                )}

                {/* Category override */}
                <input
                  type="text"
                  value={tt.categoryOverride || ''}
                  onChange={(e) => updateTicketType(idx, { categoryOverride: e.target.value || undefined })}
                  placeholder="Category override ID (optional — uses panel default if empty)"
                  className="w-full rounded border border-discord-border bg-discord-bg-secondary px-3 py-1.5 text-xs text-discord-text-secondary placeholder-discord-text-muted focus:border-somni-pink focus:outline-none"
                />
              </div>
            ))}

            <button
              onClick={addTicketType}
              className="w-full rounded-lg border border-dashed border-discord-border p-3 text-sm text-discord-text-muted hover:border-somni-pink/50 hover:text-discord-text-primary"
            >
              + Add Ticket Type
            </button>
          </div>
        </section>

        {/* Preview */}
        <section className="rounded-lg border border-discord-border bg-discord-bg-secondary p-6">
          <h2 className="text-lg font-semibold text-discord-text-primary mb-4">Preview</h2>
          <div className="rounded-lg border-l-4 border-somni-pink bg-discord-bg-tertiary p-4">
            <div className="font-bold text-discord-text-primary mb-1">
              {(editingPanel.panel_message.title as string) || editingPanel.name || '🎫 Support Tickets'}
            </div>
            <div className="text-sm text-discord-text-secondary mb-3">
              {(editingPanel.panel_message.description as string) || 'Click a button below to open a ticket.'}
            </div>
            {(editingPanel.panel_message.footer as string) && (
              <div className="text-xs text-discord-text-muted border-t border-discord-border pt-2 mt-2">
                {editingPanel.panel_message.footer as string}
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {editingPanel.ticket_types.map((tt) => {
              const colorClasses: Record<string, string> = {
                blue: 'bg-blue-600 hover:bg-blue-700',
                grey: 'bg-gray-600 hover:bg-gray-700',
                green: 'bg-green-600 hover:bg-green-700',
                red: 'bg-red-600 hover:bg-red-700',
              };
              return (
                <span
                  key={tt.id}
                  className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-white ${colorClasses[tt.color] || colorClasses.blue}`}
                >
                  {tt.emoji} {tt.label || 'Untitled'}
                </span>
              );
            })}
          </div>
        </section>

        {/* Save */}
        <div className="flex items-center gap-4">
          <button
            onClick={savePanel}
            disabled={saving || !editingPanel.name || !editingPanel.channel_id || !editingPanel.open_category_id}
            className="rounded-md bg-somni-pink px-6 py-2.5 text-sm font-semibold text-white hover:bg-somni-pink/80 disabled:opacity-50"
          >
            {saving ? 'Saving...' : editingPanel.id ? 'Update Panel' : 'Create Panel'}
          </button>
          {error && <span className="text-sm text-red-400">{error}</span>}
          {success && <span className="text-sm text-green-400">✓ {success}</span>}
        </div>
      </div>
    );
  }

  // ── Main View ────────────────────────────────────────

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Ticketing System</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Manage ticket panels and view open/closed tickets.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/tickets/transcripts"
            className="rounded-md border border-discord-border px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary hover:text-discord-text-primary transition-colors"
          >
            📋 Transcripts
          </Link>
          <button
            onClick={openNewPanel}
            className="rounded-md bg-somni-pink px-4 py-2 text-sm font-semibold text-white hover:bg-somni-pink/80"
          >
            + New Panel
          </button>
        </div>
      </div>

      {/* Guild-Level Transcript Defaults */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-5 space-y-3">
        <h3 className="text-sm font-semibold text-discord-text-primary">Transcript Defaults</h3>
        <p className="text-xs text-discord-text-muted">
          Guild-level defaults for ticket transcripts. Individual panels can override these with per-panel settings.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-sm text-discord-text-secondary">Save transcripts on ticket close</span>
          <button
            onClick={() => toggleTranscriptDefault('ticket_transcript_enabled', !transcriptEnabled)}
            disabled={togglingTranscript}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              transcriptEnabled ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                transcriptEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-discord-text-secondary">DM transcript to ticket creator</span>
          <button
            onClick={() => toggleTranscriptDefault('ticket_dm_transcript', !dmTranscript)}
            disabled={togglingTranscript}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              dmTranscript ? 'bg-discord-accent' : 'bg-discord-bg-tertiary'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                dmTranscript ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
          ✓ {success}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-discord-border">
        <button
          onClick={() => setActiveTab('panels')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'panels'
              ? 'border-somni-pink text-white'
              : 'border-transparent text-discord-text-muted hover:text-discord-text-primary'
          }`}
        >
          Panels ({panels.length})
        </button>
        <button
          onClick={() => setActiveTab('tickets')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'tickets'
              ? 'border-somni-pink text-white'
              : 'border-transparent text-discord-text-muted hover:text-discord-text-primary'
          }`}
        >
          Tickets ({ticketTotal})
        </button>
      </div>

      {/* Panels Tab */}
      {activeTab === 'panels' && (
        <div className="space-y-4">
          {panels.length === 0 ? (
            <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-8 text-center">
              <div className="text-4xl mb-3">🎫</div>
              <h3 className="text-lg font-semibold text-discord-text-primary">No ticket panels yet</h3>
              <p className="mt-1 text-sm text-discord-text-muted">
                Create a panel to let members open support tickets in your Discord server.
              </p>
              <button
                onClick={openNewPanel}
                className="mt-4 rounded-md bg-somni-pink px-6 py-2 text-sm font-semibold text-white hover:bg-somni-pink/80"
              >
                Create Your First Panel
              </button>
            </div>
          ) : (
            panels.map((panel) => (
              <div
                key={panel.id}
                className="rounded-lg border border-discord-border bg-discord-bg-secondary p-5"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-discord-text-primary">{panel.name}</h3>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          panel.active
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}
                      >
                        {panel.active ? 'Active' : 'Disabled'}
                      </span>
                      <span className="text-xs text-discord-text-muted">
                        {panel.input_mode === 'buttons' ? '🔘 Buttons' : '📋 Dropdown'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {panel.ticket_types.map((tt) => (
                        <span
                          key={tt.id}
                          className="inline-flex items-center gap-1 rounded bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-secondary"
                        >
                          {tt.emoji} {tt.label}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-discord-text-muted">
                      Channel: {panel.channel_id} • Max per user: {panel.max_open_per_user} • Managers: {panel.manager_roles.length} role(s)
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => togglePanel(panel)}
                      className="text-xs text-discord-text-muted hover:text-discord-text-primary"
                    >
                      {panel.active ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => editPanel(panel)}
                      className="rounded-md border border-discord-border px-3 py-1 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmAction({ type: 'delete_panel', id: panel.id, label: panel.name })}
                      className="rounded-md border border-red-500/30 px-3 py-1 text-xs text-red-400 hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tickets Tab */}
      {activeTab === 'tickets' && (
        <div className="space-y-4">
          {/* Filter bar */}
          <div className="flex items-center gap-2">
            {['all', 'open', 'claimed', 'closed', 'deleted'].map((status) => (
              <button
                key={status}
                onClick={() => { setTicketFilter(status); setTicketPage(0); }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  ticketFilter === status
                    ? 'bg-somni-pink text-white'
                    : 'bg-discord-bg-secondary text-discord-text-muted hover:text-discord-text-primary'
                }`}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>

          {tickets.length === 0 ? (
            <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-8 text-center">
              <div className="text-4xl mb-3">📭</div>
              <h3 className="text-lg font-semibold text-discord-text-primary">No tickets found</h3>
              <p className="mt-1 text-sm text-discord-text-muted">
                {ticketFilter === 'all' ? 'No tickets have been created yet.' : `No ${ticketFilter} tickets.`}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-discord-border bg-discord-bg-secondary overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-discord-border text-left text-xs font-medium text-discord-text-muted uppercase">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Creator</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Claimed By</th>
                    <th className="px-4 py-3">Messages</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => {
                    const statusColors: Record<string, string> = {
                      open: 'text-green-400 bg-green-500/10',
                      claimed: 'text-blue-400 bg-blue-500/10',
                      closed: 'text-gray-400 bg-gray-500/10',
                      deleted: 'text-red-400 bg-red-500/10',
                    };
                    return (
                      <tr
                        key={ticket.id}
                        className="border-b border-discord-border/50 hover:bg-discord-bg-tertiary/50"
                      >
                        <td className="px-4 py-3 text-sm font-mono text-discord-text-primary">
                          {ticket.ticket_number}
                        </td>
                        <td className="px-4 py-3 text-sm text-discord-text-secondary">
                          <TicketMemberName id={ticket.creator_id} />
                        </td>
                        <td className="px-4 py-3 text-sm text-discord-text-secondary">
                          {ticket.type}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[ticket.status] || ''}`}>
                            {ticket.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-discord-text-muted">
                          {ticket.claimed_by ? <TicketMemberName id={ticket.claimed_by} /> : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-discord-text-muted">
                          {ticket.message_count}
                        </td>
                        <td className="px-4 py-3 text-xs text-discord-text-muted">
                          {new Date(ticket.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {ticketTotal > TICKET_PAGE_SIZE && (() => {
            const totalPages = Math.ceil(ticketTotal / TICKET_PAGE_SIZE);
            const startItem = ticketPage * TICKET_PAGE_SIZE + 1;
            const endItem = Math.min((ticketPage + 1) * TICKET_PAGE_SIZE, ticketTotal);
            return (
              <div className="flex items-center justify-between border-t border-discord-border pt-4">
                <span className="text-sm text-discord-text-muted">
                  Showing {startItem}–{endItem} of {ticketTotal}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTicketPage((p) => Math.max(0, p - 1))}
                    disabled={ticketPage === 0}
                    className="rounded-md border border-discord-border px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    let pageNum: number;
                    if (totalPages <= 7) {
                      pageNum = i;
                    } else if (ticketPage < 3) {
                      pageNum = i;
                    } else if (ticketPage > totalPages - 4) {
                      pageNum = totalPages - 7 + i;
                    } else {
                      pageNum = ticketPage - 3 + i;
                    }
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setTicketPage(pageNum)}
                        className={`rounded-md px-3 py-1.5 text-sm ${
                          pageNum === ticketPage
                            ? 'bg-somni-pink text-white'
                            : 'border border-discord-border text-discord-text-secondary hover:bg-discord-bg-secondary'
                        }`}
                      >
                        {pageNum + 1}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setTicketPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={ticketPage >= totalPages - 1}
                    className="rounded-md border border-discord-border px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.type === 'delete_panel' ? 'Delete Ticket Panel' : 'Confirm Action'}
        description={`Are you sure you want to delete "${confirmAction?.label ?? 'this panel'}"? Existing tickets won't be affected, but no new tickets can be created from it.`}
        confirmLabel="Delete Panel"
        variant="danger"
        onConfirm={() => {
          if (confirmAction?.type === 'delete_panel') deletePanel(confirmAction.id);
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
