/**
 * useRealtimeEvents — High-level hook that listens to multi-table Realtime events
 * and dispatches toast notifications + data refreshes.
 *
 * This connects the existing Realtime hooks to the dashboard UX
 * so that operators see live updates without manual refresh.
 *
 * GAP 2: Realtime Hooks Wired Into Pages
 */
'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RealtimeEventHandler {
  table: string;
  filter?: string;
  /** Called when any change happens. Return a user-facing string for toasts. */
  onEvent: (event: 'INSERT' | 'UPDATE' | 'DELETE', record: Record<string, unknown>) => string | null;
}

/**
 * Subscribe to multiple tables at once and call event handlers.
 * Useful for the dashboard home page that needs to react to orders, tickets, etc.
 */
export function useRealtimeEvents(
  handlers: RealtimeEventHandler[],
  enabled: boolean = true,
) {
  const channelsRef = useRef<RealtimeChannel[]>([]);

  useEffect(() => {
    if (!enabled || handlers.length === 0) return;

    const supabase = createClient();
    const channels: RealtimeChannel[] = [];

    for (const handler of handlers) {
      const channelName = `events-${handler.table}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: handler.table,
            filter: handler.filter ?? undefined,
          },
          (payload) => {
            const eventType = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
            const record = (eventType === 'DELETE' ? payload.old : payload.new) as Record<string, unknown>;
            handler.onEvent(eventType, record);
          },
        )
        .subscribe();

      channels.push(channel);
    }

    channelsRef.current = channels;

    return () => {
      for (const ch of channels) {
        ch.unsubscribe();
      }
      channelsRef.current = [];
    };
  }, [enabled, handlers.length]);
}

/**
 * useAutoRefresh — Automatically refetch data on Realtime changes to a table.
 * Simpler than full subscription when you just want to trigger a refetch.
 */
export function useAutoRefresh(
  table: string,
  filter: string | undefined,
  refetchFn: () => void,
  enabled: boolean = true,
) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    const channelName = `auto-refresh-${table}-${Date.now()}`;

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: filter ?? undefined,
        },
        () => {
          refetchFn();
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [table, filter, enabled, refetchFn]);
}
