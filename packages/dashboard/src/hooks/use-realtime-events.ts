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
  // V11 Audit M-9: Store the latest handlers in a ref so the Realtime
  // callback always invokes the current closure. Previously the effect
  // dep array used `handlers.length`, meaning handler function updates
  // without length changes captured stale closures.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const subscriptionKey = handlers
    .map((handler) => `${handler.table}:${handler.filter ?? ''}`)
    .join('|');

  useEffect(() => {
    const activeHandlers = handlersRef.current;
    if (!enabled || activeHandlers.length === 0) return;

    const supabase = createClient();
    const channels: RealtimeChannel[] = [];

    for (let i = 0; i < activeHandlers.length; i++) {
      const handler = activeHandlers[i]!;
      const handlerIndex = i;
      const channelName = `events-${handler.table}-${Date.now()}-${crypto.randomUUID().slice(0, 4)}`;

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
            // Use ref to avoid stale closure
            handlersRef.current[handlerIndex]?.onEvent(eventType, record);
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
  }, [enabled, subscriptionKey]);
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
  // V11 Re-Audit N-2: Store refetchFn in a ref so the Realtime callback always
  // invokes the current closure without including it in the useEffect dep array.
  // This mirrors the handlersRef pattern used in useRealtimeEvents (M-9) and
  // prevents subscribe/unsubscribe churn when callers pass un-memoized callbacks.
  const refetchRef = useRef(refetchFn);
  refetchRef.current = refetchFn;

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
          refetchRef.current();
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [table, filter, enabled]);
}
