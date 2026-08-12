'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Clipboard, Plus, RefreshCw, RotateCw, Send, Webhook } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/shared/card';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Input } from '@/components/shared/input';
import { useToast } from '@/components/shared/toast';
import { useDiscordNames } from '@/hooks/use-discord-names';

const DEFAULT_TEMPLATE = '**{source} — {event}**\n{content}';

interface Relay {
  id: string;
  name: string;
  sourceLabel: string;
  channelId: string;
  messageTemplate: string;
  active: boolean;
  lastReceivedAt: string | null;
  lastDeliveryStatus: string | null;
  lastError: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  relayId: string;
  eventLabel: string;
  contentPreview: string;
  status: string;
  attemptCount: number;
  messageId: string | null;
  error: string | null;
  receivedAt: string;
}

interface RelayDraft {
  name: string;
  sourceLabel: string;
  channelId: string | null;
  messageTemplate: string;
}

type Confirmation = { kind: 'delete' | 'rotate'; relay: Relay } | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseRelay(value: unknown): Relay | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.source_label !== 'string'
    || typeof value.channel_id !== 'string'
    || typeof value.message_template !== 'string'
    || typeof value.active !== 'boolean'
    || typeof value.created_at !== 'string'
  ) return null;
  return {
    id: value.id,
    name: value.name,
    sourceLabel: value.source_label,
    channelId: value.channel_id,
    messageTemplate: value.message_template,
    active: value.active,
    lastReceivedAt: nullableString(value.last_received_at),
    lastDeliveryStatus: nullableString(value.last_delivery_status),
    lastError: nullableString(value.last_error),
    createdAt: value.created_at,
  };
}

function parseDelivery(value: unknown): Delivery | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.relay_id !== 'string'
    || typeof value.event_label !== 'string'
    || typeof value.content_preview !== 'string'
    || typeof value.status !== 'string'
    || typeof value.attempt_count !== 'number'
    || typeof value.received_at !== 'string'
  ) return null;
  return {
    id: value.id,
    relayId: value.relay_id,
    eventLabel: value.event_label,
    contentPreview: value.content_preview,
    status: value.status,
    attemptCount: value.attempt_count,
    messageId: nullableString(value.discord_message_id),
    error: nullableString(value.error),
    receivedAt: value.received_at,
  };
}

function parseListPayload(value: unknown): { relays: Relay[]; deliveries: Delivery[] } | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  if (!Array.isArray(value.data.relays) || !Array.isArray(value.data.deliveries)) return null;
  const relays = value.data.relays.map(parseRelay);
  const deliveries = value.data.deliveries.map(parseDelivery);
  if (relays.some((relay) => relay === null) || deliveries.some((delivery) => delivery === null)) return null;
  return {
    relays: relays.filter((relay): relay is Relay => relay !== null),
    deliveries: deliveries.filter((delivery): delivery is Delivery => delivery !== null),
  };
}

function responseError(value: unknown): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : 'The request failed. Try again.';
}

function receiverUrl(value: unknown): string | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  return typeof value.data.receiver_url === 'string' ? value.data.receiver_url : null;
}

function messageId(value: unknown): string | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  return typeof value.data.message_id === 'string' ? value.data.message_id : null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function mutateApi(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const payload = await json(response);
  if (!response.ok) throw new Error(responseError(payload));
  return payload;
}

function displayDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'Unknown time';
}

function RelayChannelName({ id }: { id: string }) {
  const { resolveChannel } = useDiscordNames({ channelIds: [id] });
  return <span>{resolveChannel(id)}</span>;
}

function StatusPill({ status }: { status: string | null }) {
  const label = status ?? 'Never received';
  const color = status === 'delivered'
    ? 'bg-discord-success/15 text-discord-success'
    : status === 'failed'
      ? 'bg-discord-danger/15 text-discord-danger'
      : status === 'retryable' || status === 'processing'
        ? 'bg-discord-warning/15 text-discord-warning'
        : 'bg-discord-bg-tertiary text-discord-text-muted';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{label}</span>;
}

function RelayForm({
  initial,
  submitLabel,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: RelayDraft;
  submitLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: RelayDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [authoritative, setAuthoritative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => draft.messageTemplate
    .replaceAll('{source}', draft.sourceLabel || 'Rust server')
    .replaceAll('{event}', 'server.started')
    .replaceAll('{content}', 'Map wipe completed'), [draft]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.channelId || !authoritative) {
      setError('Choose a destination from a fresh live Discord snapshot.');
      return;
    }
    setError(null);
    await onSubmit(draft);
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={busy || undefined}>
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Relay name"
          value={draft.name}
          maxLength={80}
          required
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="Production game events"
        />
        <Input
          label="Source label"
          value={draft.sourceLabel}
          maxLength={80}
          required
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, sourceLabel: event.target.value }))}
          placeholder="Rust server"
        />
      </div>
      <ChannelPicker
        label="Discord destination"
        hint="Only text and announcement channels where SomniBot can view and send are selectable."
        value={draft.channelId}
        onChange={(value) => setDraft((current) => ({ ...current, channelId: typeof value === 'string' ? value : null }))}
        channelTypes={['text', 'announcement']}
        requiredBotPermissions={['ViewChannel', 'SendMessages']}
        onAuthorityChange={setAuthoritative}
        disabled={busy}
      />
      <div className="space-y-1">
        <label htmlFor="relay-template" className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
          Message template
        </label>
        <textarea
          id="relay-template"
          value={draft.messageTemplate}
          maxLength={1900}
          required
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, messageTemplate: event.target.value }))}
          className="min-h-28 w-full resize-y rounded-input border border-transparent bg-discord-bg-tertiary px-3 py-2 font-mono text-sm text-discord-text-primary focus-visible:border-discord-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent focus-visible:ring-offset-2 focus-visible:ring-offset-discord-bg-primary disabled:opacity-50"
          aria-describedby="relay-template-help"
        />
        <p id="relay-template-help" className="text-xs text-discord-text-muted">
          Variables: {'{source}'}, {'{event}'}, and {'{content}'}.
        </p>
      </div>
      <div className="rounded-input bg-discord-bg-tertiary p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Preview</p>
        <p className="whitespace-pre-wrap break-words text-sm text-discord-text-primary">{preview}</p>
      </div>
      {error ? <p role="alert" className="text-sm text-discord-danger">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !authoritative}>{busy ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}

export default function WebhookRelaysPage() {
  const { toast } = useToast();
  const [relays, setRelays] = useState<Relay[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [oneTimeUrl, setOneTimeUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch('/api/external-webhook-relays', { cache: 'no-store' });
      const payload = await json(response);
      if (!response.ok) throw new Error(responseError(payload));
      const parsed = parseListPayload(payload);
      if (!parsed) throw new Error('The relay response was incomplete.');
      setRelays(parsed.relays);
      setDeliveries(parsed.deliveries);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Webhook relays could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (draft: RelayDraft) => {
    setBusyId('create');
    try {
      const payload = await mutateApi('/api/external-webhook-relays', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name,
          source_label: draft.sourceLabel,
          channel_id: draft.channelId,
          message_template: draft.messageTemplate,
        }),
      });
      const url = receiverUrl(payload);
      if (!url) throw new Error('The one-time receiver URL was missing.');
      setOneTimeUrl(url);
      setCreating(false);
      await refresh();
      toast({ title: 'Webhook relay created', description: 'Copy the receiver URL before leaving this page.', variant: 'success', duration: 8000 });
    } catch (error) {
      toast({ title: 'Relay was not created', description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const update = async (relay: Relay, draft: RelayDraft) => {
    setBusyId(relay.id);
    try {
      await mutateApi('/api/external-webhook-relays', {
        method: 'PATCH',
        body: JSON.stringify({
          id: relay.id,
          name: draft.name,
          source_label: draft.sourceLabel,
          channel_id: draft.channelId,
          message_template: draft.messageTemplate,
        }),
      });
      setEditingId(null);
      await refresh();
      toast({ title: 'Relay updated', variant: 'success' });
    } catch (error) {
      toast({ title: 'Relay was not updated', description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (relay: Relay) => {
    setBusyId(relay.id);
    try {
      await mutateApi('/api/external-webhook-relays', { method: 'PATCH', body: JSON.stringify({ id: relay.id, active: !relay.active }) });
      await refresh();
      toast({ title: relay.active ? 'Relay disabled' : 'Relay enabled', variant: 'success' });
    } catch (error) {
      toast({ title: 'Relay status was not changed', description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const sendTest = async (relay: Relay) => {
    setBusyId(relay.id);
    try {
      const payload = await mutateApi(`/api/external-webhook-relays/${relay.id}/test`, { method: 'POST' });
      const receipt = messageId(payload);
      if (!receipt) throw new Error('Discord did not return a message receipt.');
      await refresh();
      toast({ title: 'Test delivered to Discord', description: `Message ${receipt}`, variant: 'success' });
    } catch (error) {
      toast({ title: 'Test delivery failed', description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const confirmMutation = async () => {
    if (!confirmation) return;
    const action = confirmation;
    setBusyId(action.relay.id);
    try {
      if (action.kind === 'rotate') {
        const payload = await mutateApi(`/api/external-webhook-relays/${action.relay.id}/rotate`, { method: 'POST' });
        const url = receiverUrl(payload);
        if (!url) throw new Error('The one-time receiver URL was missing.');
        setOneTimeUrl(url);
        toast({ title: 'Receiver URL rotated', description: 'The previous URL no longer works.', variant: 'success', duration: 8000 });
      } else {
        await mutateApi(`/api/external-webhook-relays?id=${encodeURIComponent(action.relay.id)}`, { method: 'DELETE' });
        toast({ title: 'Relay deleted', variant: 'success' });
      }
      setConfirmation(null);
      await refresh();
    } catch (error) {
      toast({ title: action.kind === 'rotate' ? 'Rotation failed' : 'Delete failed', description: error instanceof Error ? error.message : undefined, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const copyUrl = async () => {
    if (!oneTimeUrl) return;
    try {
      await navigator.clipboard.writeText(oneTimeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the URL and copy it manually.', variant: 'warning' });
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Webhook Relays</h1>
          <p className="mt-1 max-w-2xl text-sm text-discord-text-muted">
            Turn JSON or plain-text events from external services into safe Discord messages.
          </p>
        </div>
        <Button onClick={() => { setCreating(true); setEditingId(null); }} disabled={creating}>
          <Plus size={16} aria-hidden="true" /> New relay
        </Button>
      </div>

      {oneTimeUrl ? (
        <Card variant="warning" className="space-y-3" aria-live="polite">
          <div>
            <CardTitle>Copy this receiver URL now</CardTitle>
            <CardDescription>SomniBot stores only its SHA-256 hash. You cannot reveal this URL again.</CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input aria-label="One-time webhook receiver URL" readOnly value={oneTimeUrl} className="min-w-0 flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 font-mono text-sm text-discord-text-primary focus:outline-none focus:ring-2 focus:ring-discord-accent" />
            <Button type="button" variant="secondary" onClick={copyUrl}>
              {copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOneTimeUrl(null)}>Dismiss</Button>
          </div>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardHeader><div><CardTitle>Create webhook relay</CardTitle><CardDescription>The receiver URL is shown once after creation.</CardDescription></div></CardHeader>
          <RelayForm
            initial={{ name: '', sourceLabel: '', channelId: null, messageTemplate: DEFAULT_TEMPLATE }}
            submitLabel="Create relay"
            busy={busyId === 'create'}
            onCancel={() => setCreating(false)}
            onSubmit={create}
          />
        </Card>
      ) : null}

      {loading ? (
        <Card className="animate-pulse" aria-busy="true"><span className="sr-only">Loading webhook relays</span><div className="h-5 w-40 rounded bg-discord-bg-tertiary" /><div className="mt-4 h-20 rounded bg-discord-bg-tertiary" /></Card>
      ) : loadError ? (
        <Card variant="danger" className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div><CardTitle>Webhook relays could not be loaded</CardTitle><CardDescription>{loadError}</CardDescription></div>
          <Button variant="secondary" onClick={() => { setLoading(true); void refresh(); }}><RefreshCw size={16} aria-hidden="true" /> Retry</Button>
        </Card>
      ) : relays.length === 0 ? (
        <Card className="py-10 text-center">
          <Webhook size={32} aria-hidden="true" className="mx-auto mb-3 text-discord-accent" />
          <CardTitle>No webhook relays yet</CardTitle>
          <p className="mx-auto mt-2 max-w-md text-sm text-discord-text-muted">Create one to give an external service a private inbound URL.</p>
          <Button className="mt-5" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Create your first relay</Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {relays.map((relay) => {
            const recent = deliveries.filter((delivery) => delivery.relayId === relay.id).slice(0, 3);
            const busy = busyId === relay.id;
            return (
              <Card key={relay.id} className="space-y-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="break-words text-lg font-medium text-discord-text-primary">{relay.name}</h2>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${relay.active ? 'bg-discord-success/15 text-discord-success' : 'bg-discord-bg-tertiary text-discord-text-muted'}`}>{relay.active ? 'Active' : 'Disabled'}</span>
                      <StatusPill status={relay.lastDeliveryStatus} />
                    </div>
                    <p className="mt-2 text-sm text-discord-text-muted">{relay.sourceLabel} → <RelayChannelName id={relay.channelId} /></p>
                    <p className="mt-1 text-xs text-discord-text-muted">{relay.lastReceivedAt ? `Last received ${displayDate(relay.lastReceivedAt)}` : 'Waiting for the first event'}</p>
                    {relay.lastError ? <p role="status" className="mt-2 text-sm text-discord-danger">{relay.lastError}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busy || !relay.active} onClick={() => void sendTest(relay)}><Send size={14} aria-hidden="true" /> Test</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setEditingId(editingId === relay.id ? null : relay.id); setCreating(false); }}>Edit</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggleActive(relay)}>{relay.active ? 'Disable' : 'Enable'}</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmation({ kind: 'rotate', relay })}><RotateCw size={14} aria-hidden="true" /> Rotate</Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmation({ kind: 'delete', relay })}>Delete</Button>
                  </div>
                </div>

                {editingId === relay.id ? (
                  <div className="border-t border-discord-border-subtle pt-5">
                    <RelayForm
                      initial={{ name: relay.name, sourceLabel: relay.sourceLabel, channelId: relay.channelId, messageTemplate: relay.messageTemplate }}
                      submitLabel="Save changes"
                      busy={busy}
                      onCancel={() => setEditingId(null)}
                      onSubmit={(draft) => update(relay, draft)}
                    />
                  </div>
                ) : null}

                <div className="border-t border-discord-border-subtle pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">Recent deliveries</h3>
                  {recent.length === 0 ? <p className="mt-2 text-sm text-discord-text-muted">No delivery evidence yet.</p> : (
                    <ul className="mt-2 divide-y divide-discord-border-subtle">
                      {recent.map((delivery) => (
                        <li key={delivery.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0"><p className="truncate text-sm text-discord-text-primary">{delivery.eventLabel}</p><p className="truncate text-xs text-discord-text-muted">{delivery.contentPreview || '(empty payload)'} · attempt {delivery.attemptCount}</p></div>
                          <div className="flex shrink-0 items-center gap-2"><StatusPill status={delivery.status} /><span className="text-xs text-discord-text-muted">{displayDate(delivery.receivedAt)}</span></div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.kind === 'rotate' ? 'Rotate receiver URL?' : 'Delete webhook relay?'}
        description={confirmation?.kind === 'rotate'
          ? 'The current receiver URL will stop working immediately. The replacement is shown once.'
          : 'This permanently removes the relay, its token hash, and its delivery history.'}
        confirmLabel={confirmation?.kind === 'rotate' ? 'Rotate URL' : 'Delete relay'}
        variant={confirmation?.kind === 'rotate' ? 'warning' : 'danger'}
        loading={confirmation !== null && busyId === confirmation.relay.id}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmMutation}
      />
    </div>
  );
}
