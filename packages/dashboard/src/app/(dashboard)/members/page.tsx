/**
 * Members — Bulk operations on guild members.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 */
'use client';

import { DashboardSkeleton } from '@/components/shared/loading-skeleton';
import Image from 'next/image';
import { useEffect, useState, useCallback } from 'react';

interface Member {
  id: string;
  discord_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  roles: string[] | null;
  joined_at: string;
  xp: number;
  level: number;
  wallet: number;
  bank: number;
  is_muted: boolean;
  is_banned: boolean;
  suspended: boolean;
}

type BulkAction = 'assign_role' | 'remove_role' | 'reset_economy' | 'export' | 'send_dm';

type StatusFilter = 'active' | 'banned' | 'left';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'banned', label: 'Banned' },
  { value: 'left', label: 'Left' },
];

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | ''>('');
  const [actionParam, setActionParam] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const limit = 50;

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit), status });
      if (search) params.set('search', search);
      const res = await fetch(`/api/members?${params}`);
      const json = await res.json();
      if (json.success) {
        setMembers(json.members);
        setTotal(json.total);
      }
    } catch {
      setFeedback({ type: 'error', text: 'Failed to load members' });
    } finally {
      setLoading(false);
    }
  }, [page, search, status]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === members.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(members.map((m) => m.discord_id)));
    }
  };

  const executeBulk = async () => {
    if (!bulkAction || selected.size === 0) return;
    setActionLoading(true);
    setFeedback(null);

    try {
      const params: Record<string, unknown> = {};
      if (bulkAction === 'assign_role' || bulkAction === 'remove_role') {
        params.role_id = actionParam;
      } else if (bulkAction === 'send_dm') {
        params.message = actionParam;
      }

      const res = await fetch('/api/members/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_ids: Array.from(selected),
          action: bulkAction,
          params,
        }),
      });

      const json = await res.json();
      if (json.success) {
        if (bulkAction === 'export') {
          // Download as JSON
          const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `members_export_${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          setFeedback({ type: 'success', text: `Exported ${json.data.length} members` });
        } else {
          setFeedback({ type: 'success', text: json.message });
        }
        setSelected(new Set());
        setBulkAction('');
        setActionParam('');
      } else {
        setFeedback({ type: 'error', text: json.error });
      }
    } catch {
      setFeedback({ type: 'error', text: 'Failed to execute bulk action' });
    } finally {
      setActionLoading(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  if (loading && members.length === 0) return <DashboardSkeleton />;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Members</h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            {total} total members · {selected.size} selected
          </p>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            feedback.type === 'success'
              ? 'border-green-500/30 bg-green-500/10 text-green-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Search + Status Filter + Bulk Actions Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by username or Discord ID..."
          className="flex-1 min-w-[200px] rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:border-discord-accent/50 focus:outline-none"
        />

        <div className="flex overflow-hidden rounded border border-discord-border-subtle">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setStatus(f.value); setPage(1); setSelected(new Set()); }}
              className={`px-3 py-2 text-sm transition-colors ${
                status === f.value
                  ? 'bg-discord-accent text-white'
                  : 'bg-discord-bg-secondary text-discord-text-secondary hover:text-discord-text-primary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {selected.size > 0 && (
          <>
            <select
              value={bulkAction}
              onChange={(e) => { setBulkAction(e.target.value as BulkAction | ''); setActionParam(''); }}
              className="rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary"
            >
              <option value="">Bulk Action...</option>
              <option value="assign_role">Assign Role</option>
              <option value="remove_role">Remove Role</option>
              <option value="reset_economy">Reset Economy</option>
              <option value="export">Export Selected</option>
              <option value="send_dm">Send DM</option>
            </select>

            {(bulkAction === 'assign_role' || bulkAction === 'remove_role') && (
              <input
                type="text"
                value={actionParam}
                onChange={(e) => setActionParam(e.target.value)}
                placeholder="Role ID..."
                className="w-48 rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:outline-none"
              />
            )}

            {bulkAction === 'send_dm' && (
              <input
                type="text"
                value={actionParam}
                onChange={(e) => setActionParam(e.target.value)}
                placeholder="DM message..."
                className="flex-1 min-w-[200px] rounded border border-discord-border-subtle bg-discord-bg-secondary px-3 py-2 text-sm text-discord-text-primary placeholder-discord-text-muted focus:outline-none"
              />
            )}

            {bulkAction && (
              <button
                onClick={executeBulk}
                disabled={actionLoading || (bulkAction !== 'export' && bulkAction !== 'reset_economy' && !actionParam)}
                className="rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent-hover disabled:opacity-50"
              >
                {actionLoading ? 'Processing...' : `Execute (${selected.size})`}
              </button>
            )}
          </>
        )}
      </div>

      {/* Members Table */}
      <div className="overflow-x-auto rounded-lg border border-discord-border-subtle bg-discord-bg-secondary">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-discord-border-subtle text-left text-discord-text-muted">
              <th className="px-3 py-3 w-10">
                <input
                  type="checkbox"
                  checked={members.length > 0 && selected.size === members.length}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-discord-border-subtle"
                />
              </th>
              <th className="px-3 py-3">Member</th>
              <th className="px-3 py-3">Level</th>
              <th className="px-3 py-3">XP</th>
              <th className="px-3 py-3">Wallet</th>
              <th className="px-3 py-3">Bank</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr
                key={m.discord_id}
                className={`border-b border-discord-border-subtle/50 transition-colors ${
                  selected.has(m.discord_id) ? 'bg-discord-blurple/10' : 'hover:bg-discord-bg-tertiary/50'
                }`}
              >
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(m.discord_id)}
                    onChange={() => toggleSelect(m.discord_id)}
                    className="h-4 w-4 rounded border-discord-border-subtle"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {m.avatar_url ? (
                      <Image
                        src={m.avatar_url}
                        alt=""
                        width={32}
                        height={32}
                        unoptimized
                        className="h-8 w-8 rounded-full"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-discord-bg-tertiary text-xs text-discord-text-muted">
                        {(m.display_name ?? m.username)?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <div>
                      <div className="font-medium text-discord-text-primary">
                        {m.display_name ?? m.username}
                      </div>
                      <div className="text-xs text-discord-text-muted">
                        @{m.username}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-discord-text-secondary">{m.level}</td>
                <td className="px-3 py-2.5 text-discord-text-secondary">{m.xp?.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-discord-text-secondary">{m.wallet?.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-discord-text-secondary">{m.bank?.toLocaleString()}</td>
                <td className="px-3 py-2.5">
                  {m.is_banned ? (
                    <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">Banned</span>
                  ) : status === 'left' ? (
                    <span className="rounded-full bg-gray-500/20 px-2 py-0.5 text-xs text-gray-400">Left</span>
                  ) : m.suspended ? (
                    <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">Suspended</span>
                  ) : m.is_muted ? (
                    <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-xs text-orange-400">Muted</span>
                  ) : (
                    <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">Active</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-discord-text-muted text-xs">
                  {m.joined_at ? new Date(m.joined_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-discord-text-muted">
                  {search
                    ? 'No members matching search'
                    : status === 'banned'
                      ? 'No banned members'
                      : status === 'left'
                        ? 'No former members'
                        : 'No members found'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-discord-text-muted">
            Page {page} of {totalPages} · Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-md border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-30"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-md border border-discord-border-subtle px-3 py-1.5 text-xs text-discord-text-secondary hover:bg-discord-bg-tertiary disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
