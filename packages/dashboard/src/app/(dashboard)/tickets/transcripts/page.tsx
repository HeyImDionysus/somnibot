/**
 * Transcript Viewer — View and browse ticket transcripts.
 *
 * Architecture doc §19.6
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface TranscriptSummary {
  id: string;
  ticket_id: string;
  ticket_number: number;
  creator_id: string;
  closed_by_id: string;
  message_count: number;
  participant_ids: string[];
  created_at: string;
}

interface TranscriptFull extends TranscriptSummary {
  html_content: string;
}

export default function TranscriptsPage() {
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<TranscriptFull | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTranscripts = useCallback(async () => {
    try {
      const res = await fetch('/api/tickets/transcripts?limit=50');
      const json = await res.json();
      if (json.success) {
        setTranscripts(json.data);
        setTotal(json.total);
      }
    } catch {
      setError('Failed to load transcripts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTranscripts();
  }, [loadTranscripts]);

  const viewTranscript = async (ticketId: string) => {
    setViewLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/tickets/transcripts?ticket_id=${ticketId}`);
      const json = await res.json();

      if (json.success && json.data) {
        setViewing(json.data);
      } else {
        setError('Transcript not found');
      }
    } catch {
      setError('Failed to load transcript');
    } finally {
      setViewLoading(false);
    }
  };

  const downloadTranscript = () => {
    if (!viewing) return;
    const blob = new Blob([viewing.html_content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ticket-${viewing.ticket_number}-transcript.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-discord-text-muted">Loading transcripts...</div>
      </div>
    );
  }

  // ── Viewing a specific transcript ──────────────────

  if (viewing) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setViewing(null)}
              className="text-sm text-discord-text-muted hover:text-discord-text-primary"
            >
              ← Back
            </button>
            <h1 className="text-xl font-bold text-discord-text-primary">
              Ticket #{viewing.ticket_number} — Transcript
            </h1>
          </div>
          <button
            onClick={downloadTranscript}
            className="rounded-md border border-discord-border px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary hover:text-discord-text-primary"
          >
            ⬇️ Download HTML
          </button>
        </div>

        <div className="text-xs text-discord-text-muted flex gap-4">
          <span>💬 {viewing.message_count} messages</span>
          <span>👥 {viewing.participant_ids.length} participants</span>
          <span>📅 {new Date(viewing.created_at).toLocaleString()}</span>
        </div>

        {/* Render the HTML transcript in an iframe */}
        <div className="rounded-lg border border-discord-border overflow-hidden" style={{ height: '70vh' }}>
          <iframe
            srcDoc={viewing.html_content}
            title={`Ticket #${viewing.ticket_number} Transcript`}
            className="w-full h-full border-0"
            sandbox="allow-same-origin"
          />
        </div>
      </div>
    );
  }

  // ── Transcript List ────────────────────────────────

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Transcripts</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            {total} transcript{total !== 1 ? 's' : ''} saved from closed tickets.
          </p>
        </div>
        <Link
          href="/tickets"
          className="text-sm text-discord-text-muted hover:text-discord-text-primary"
        >
          ← Back to Tickets
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {transcripts.length === 0 ? (
        <div className="rounded-lg border border-discord-border bg-discord-bg-secondary p-8 text-center">
          <div className="text-4xl mb-3">📋</div>
          <h3 className="text-lg font-semibold text-discord-text-primary">No transcripts yet</h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            Transcripts are automatically generated when tickets are closed.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {transcripts.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-discord-border bg-discord-bg-secondary p-4 hover:border-somni-pink/30 transition-colors cursor-pointer"
              onClick={() => viewTranscript(t.ticket_id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-discord-text-primary">
                    Ticket #{t.ticket_number}
                  </h3>
                  <div className="mt-1 flex items-center gap-4 text-xs text-discord-text-muted">
                    <span>💬 {t.message_count} messages</span>
                    <span>👥 {t.participant_ids.length} participants</span>
                    <span>👤 Creator: {t.creator_id}</span>
                    <span>🔒 Closed by: {t.closed_by_id}</span>
                  </div>
                </div>
                <div className="text-xs text-discord-text-muted">
                  {new Date(t.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewLoading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="rounded-lg bg-discord-bg-secondary p-6 text-discord-text-primary">
            Loading transcript...
          </div>
        </div>
      )}
    </div>
  );
}
