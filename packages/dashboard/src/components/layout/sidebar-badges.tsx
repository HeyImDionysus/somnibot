/**
 * SidebarBadges — Live count badges for sidebar navigation items.
 * Uses Supabase Realtime to show open tickets, pending orders, active giveaways.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { useEffect, useState } from 'react';
import { useRealtimeCount } from '@/hooks/use-realtime';

const GUILD_ID = process.env.NEXT_PUBLIC_DISCORD_GUILD_ID ?? '';

interface SidebarBadgeProps {
  table: string;
  filter?: string;
  className?: string;
}

export function SidebarBadge({ table, filter, className }: SidebarBadgeProps) {
  const [initial, setInitial] = useState(0);
  const { count, isConnected } = useRealtimeCount(table, filter, initial);

  // Fetch initial count on mount
  useEffect(() => {
    async function fetchCount() {
      try {
        const res = await fetch(`/api/counts?table=${table}&filter=${encodeURIComponent(filter ?? '')}`);
        const json = await res.json();
        if (json.count !== undefined) setInitial(json.count);
      } catch {
        // Non-critical
      }
    }
    fetchCount();
  }, [table, filter]);

  if (count === 0) return null;

  return (
    <span
      className={`ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-discord-accent px-1.5 text-[10px] font-bold text-white ${className ?? ''}`}
      title={isConnected ? 'Live' : 'Cached'}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Pre-configured badges for common sidebar items.
 */
export function OpenTicketsBadge() {
  return (
    <SidebarBadge
      table="tickets"
      filter={`guild_id=eq.${GUILD_ID}`}
    />
  );
}

export function PendingOrdersBadge() {
  return (
    <SidebarBadge
      table="orders"
      filter={`guild_id=eq.${GUILD_ID}`}
    />
  );
}

export function ActiveGiveawaysBadge() {
  return (
    <SidebarBadge
      table="giveaways"
      filter={`guild_id=eq.${GUILD_ID}`}
    />
  );
}

/**
 * V53 Phase 2: DLQ badge — shows count of unacknowledged failed actions.
 */
export function DlqBadge() {
  return (
    <SidebarBadge
      table="action_queue_dlq"
      filter={`guild_id=eq.${GUILD_ID}&acknowledged=eq.false&retried=eq.false`}
    />
  );
}
