'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/shared/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/shared/card';
import { useToast } from '@/components/shared/toast';
import { useUnsavedWarning } from '@/hooks/use-unsaved-warning';

export function BotPresenceSettings() {
  const { toast } = useToast();
  const [statuses, setStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isPrimaryGuild, setIsPrimaryGuild] = useState<boolean | null>(null);
  useUnsavedWarning(dirty);

  useEffect(() => {
    void fetch('/api/guild')
      .then(async (response) => {
        const data = await response.json() as {
          config?: { custom_bot_statuses?: string[] };
          isPrimaryGuild?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? 'Bot presence could not be loaded');
        setStatuses(data.config?.custom_bot_statuses ?? []);
        setIsPrimaryGuild(data.isPrimaryGuild === true);
      })
      .catch((error: unknown) => {
        toast({ title: error instanceof Error ? error.message : 'Bot presence could not be loaded', variant: 'error' });
      })
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    setSaving(true);
    try {
      const filtered = statuses.map((status) => status.trim()).filter(Boolean);
      const response = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_bot_statuses: filtered }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? 'Bot statuses could not be saved');
      setStatuses(filtered);
      setDirty(false);
      toast({ title: 'Bot statuses saved', variant: 'success' });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Bot statuses could not be saved', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg bg-discord-bg-tertiary p-2 text-discord-accent">
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-base">Bot Presence</CardTitle>
            <CardDescription>
              Status messages that rotate alongside member count, uptime, and now playing.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <div className="space-y-3 px-4 pb-5 sm:px-6 sm:pb-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-discord-text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Loading statuses…
          </div>
        ) : isPrimaryGuild === false ? (
          <div className="rounded-input bg-discord-bg-tertiary p-3 text-sm text-discord-text-secondary ring-1 ring-discord-border-subtle">
            Bot presence is installation-wide. Switch to the primary server to edit the statuses used by the running bot.
          </div>
        ) : statuses.map((status, index) => (
          <div key={index} className="flex min-w-0 items-center gap-2">
            <label htmlFor={`custom-status-${index}`} className="sr-only">Custom status {index + 1}</label>
            <input
              id={`custom-status-${index}`}
              type="text"
              value={status}
              onChange={(event) => {
                setStatuses((current) => current.map((item, itemIndex) => (
                  itemIndex === index ? event.target.value : item
                )));
                setDirty(true);
              }}
              maxLength={128}
              placeholder="Custom status text…"
              className="min-w-0 flex-1 rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none ring-1 ring-discord-border-subtle transition-standard placeholder:text-discord-text-muted/50 focus:ring-discord-accent"
            />
            <button
              type="button"
              onClick={() => {
                setStatuses((current) => current.filter((_, itemIndex) => itemIndex !== index));
                setDirty(true);
              }}
              aria-label={`Remove custom status ${index + 1}`}
              className="shrink-0 rounded-input p-2 text-discord-text-muted transition-standard hover:bg-discord-danger/10 hover:text-discord-danger"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        {!loading && isPrimaryGuild === true && statuses.length < 20 && (
          <button
            type="button"
            onClick={() => {
              setStatuses((current) => [...current, '']);
              setDirty(true);
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-input px-3 py-2 text-xs font-medium text-discord-text-secondary ring-1 ring-discord-border-subtle transition-standard hover:bg-discord-bg-primary/50 hover:text-discord-text-primary"
          >
            <Plus size={12} aria-hidden="true" />
            Add Status
          </button>
        )}
        {isPrimaryGuild === true && <div className="flex justify-end pt-2">
          <Button onClick={() => void save()} disabled={loading || saving || !dirty} className="gap-2">
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            Save Statuses
          </Button>
        </div>}
      </div>
    </Card>
  );
}
