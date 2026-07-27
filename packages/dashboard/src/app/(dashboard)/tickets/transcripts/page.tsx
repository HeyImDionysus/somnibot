/**
 * Transcript Viewer — View and browse ticket transcripts.
 *
 * Architecture doc §19.6
 * V53 Phase 3 (Finding 3.8): Added pagination + search by ticket number.
 */
'use client';

import { TableSkeleton } from '@/components/shared/loading-skeleton';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

const PAGE_SIZE = 50;

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
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<TranscriptFull | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTranscripts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (search.trim()) params.set('search', search.trim());
      const res = await fetch(`/api/tickets/transcripts?${params}`);
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
  }, [page, search]);

  useEffect(() => {
    loadTranscripts();
  }, [loadTranscripts]);

  // Reset page when search changes
  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startItem = page * PAGE_SIZE + 1;
  const endItem = Math.min((page + 1) * PAGE_SIZE, total);

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

  if (loading && transcripts.length === 0) {
    return <TableSkeleton />;
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
            className="rounded-md border border-discord-border-subtle px-4 py-2 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary hover:text-discord-text-primary"
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
        <div className="rounded-lg border border-discord-border-subtle overflow-hidden" style={{ height: '70vh' }}>
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

      {/* Search */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Search by ticket number..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent/50 focus:outline-none"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {transcripts.length === 0 ? (
        <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-8 text-center">
          <div className="text-4xl mb-3">📋</div>
          <h3 className="text-lg font-medium text-discord-text-primary">
            {search ? 'No matching transcripts' : 'No transcripts yet'}
          </h3>
          <p className="mt-1 text-sm text-discord-text-muted">
            {search
              ? 'Try a different ticket number.'
              : 'Transcripts are automatically generated when tickets are closed.'}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {transcripts.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-4 hover:border-discord-accent/30 transition-colors cursor-pointer"
                onClick={() => viewTranscript(t.ticket_id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-discord-text-primary">
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

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-discord-border-subtle pt-4">
              <span className="text-sm text-discord-text-muted">
                Showing {startItem}–{endItem} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-md border border-discord-border-subtle px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  // Show pages around current page
                  let pageNum: number;
                  if (totalPages <= 7) {
                    pageNum = i;
                  } else if (page < 3) {
                    pageNum = i;
                  } else if (page > totalPages - 4) {
                    pageNum = totalPages - 7 + i;
                  } else {
                    pageNum = page - 3 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={`rounded-md px-3 py-1.5 text-sm ${
                        pageNum === page
                          ? 'bg-discord-accent text-white'
                          : 'border border-discord-border-subtle text-discord-text-secondary hover:bg-discord-bg-secondary'
                      }`}
                    >
                      {pageNum + 1}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded-md border border-discord-border-subtle px-3 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
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
