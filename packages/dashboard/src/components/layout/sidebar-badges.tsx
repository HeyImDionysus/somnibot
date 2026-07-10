/**
 * SidebarBadges — Count badges for sidebar navigation items.
 *
 * Counts are server-driven: fetched from /api/counts (service role, so
 * RLS-locked tables like action_queue_dlq still work) and refreshed by
 * interval polling. Supabase Realtime is deliberately NOT used here —
 * none of the badge tables are in the supabase_realtime publication,
 * and action_queue_dlq revokes client grants entirely, so client-side
 * postgres_changes subscriptions can never receive events.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { useEffect, useState } from 'react';

/** Matches the layout-banner polling cadence (bot-status-banner.tsx). */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface SidebarBadgeProps {
  /** Table name — must be in /api/counts ALLOWED_TABLES. Status filters are applied server-side. */
  table: string;
  /** How often to refresh the count (ms). Defaults to 30s. */
  pollIntervalMs?: number;
  className?: string;
}

export function SidebarBadge({
  table,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  className,
}: SidebarBadgeProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchCount() {
      try {
        const res = await fetch(`/api/counts?table=${encodeURIComponent(table)}`);
        const json = await res.json();
        if (!cancelled && typeof json.count === 'number') setCount(json.count);
      } catch {
        // Non-critical — keep the last known count
      }
    }

    fetchCount();
    const timer = setInterval(fetchCount, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [table, pollIntervalMs]);

  if (count === 0) return null;

  return (
    <span
      className={`ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-discord-accent px-1.5 text-[10px] font-bold text-white ${className ?? ''}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Pre-configured badges for common sidebar items.
 */
export function OpenTicketsBadge() {
  return <SidebarBadge table="tickets" />;
}

export function PendingOrdersBadge() {
  return <SidebarBadge table="orders" />;
}

export function ActiveGiveawaysBadge() {
  return <SidebarBadge table="giveaways" />;
}

/**
 * V53 Phase 2: DLQ badge — shows count of pending failed actions
 * (acknowledged = false AND retried = false, applied server-side).
 */
export function DlqBadge() {
  return <SidebarBadge table="action_queue_dlq" />;
}
