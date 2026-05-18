/**
 * useRealtimeSubscription — Subscribe to Supabase Realtime table changes.
 *
 * Provides live updates for any dashboard page that needs real-time data.
 * Automatically manages subscription lifecycle with React cleanup.
 *
 * Usage:
 *   const { data, isConnected } = useRealtimeSubscription<Order>({
 *     table: 'orders',
 *     filter: `guild_id=eq.${guildId}`,
 *     event: '*',  // INSERT, UPDATE, DELETE, or *
 *     initialData: existingOrders,
 *     onInsert: (newOrder) => { ... },
 *     onUpdate: (updatedOrder) => { ... },
 *   });
 */
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

export type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface UseRealtimeOptions<T extends Record<string, unknown>> {
  /** The database table to subscribe to */
  table: string;
  /** Postgres filter expression, e.g. `guild_id=eq.abc123` */
  filter?: string;
  /** Which events to listen for */
  event?: RealtimeEvent;
  /** Initial data (fetched via API) */
  initialData?: T[];
  /** Primary key field name (default: 'id') */
  primaryKey?: keyof T & string;
  /** Callback when a new row is inserted */
  onInsert?: (record: T) => void;
  /** Callback when a row is updated */
  onUpdate?: (record: T) => void;
  /** Callback when a row is deleted */
  onDelete?: (oldRecord: T) => void;
  /** Whether the subscription is enabled (default: true) */
  enabled?: boolean;
}

export interface UseRealtimeResult<T> {
  /** Live data array */
  data: T[];
  /** Whether the Realtime connection is active */
  isConnected: boolean;
  /** Number of live updates received */
  updateCount: number;
  /** Force re-fetch from initial data source */
  reset: (newData: T[]) => void;
}

export function useRealtimeSubscription<T extends Record<string, unknown>>(
  options: UseRealtimeOptions<T>,
): UseRealtimeResult<T> {
  const {
    table,
    filter,
    event = '*',
    initialData = [],
    primaryKey = 'id' as keyof T & string,
    onInsert,
    onUpdate,
    onDelete,
    enabled = true,
  } = options;

  const [data, setData] = useState<T[]>(initialData);
  const [isConnected, setIsConnected] = useState(false);
  const [updateCount, setUpdateCount] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Update data when initialData changes
  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  const reset = useCallback((newData: T[]) => {
    setData(newData);
    setUpdateCount(0);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    const channelName = `realtime-${table}-${filter ?? 'all'}-${Date.now()}`;

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: event === '*' ? '*' : event,
          schema: 'public',
          table,
          filter: filter ?? undefined,
        },
        (payload: RealtimePostgresChangesPayload<T>) => {
          setUpdateCount((c) => c + 1);

          if (payload.eventType === 'INSERT') {
            const newRecord = payload.new as T;
            setData((prev) => {
              // Avoid duplicates
              const exists = prev.some((item) => item[primaryKey] === newRecord[primaryKey]);
              if (exists) return prev;
              return [...prev, newRecord];
            });
            onInsert?.(newRecord);
          }

          if (payload.eventType === 'UPDATE') {
            const updatedRecord = payload.new as T;
            setData((prev) =>
              prev.map((item) =>
                item[primaryKey] === updatedRecord[primaryKey] ? updatedRecord : item,
              ),
            );
            onUpdate?.(updatedRecord);
          }

          if (payload.eventType === 'DELETE') {
            const oldRecord = payload.old as T;
            setData((prev) =>
              prev.filter((item) => item[primaryKey] !== oldRecord[primaryKey]),
            );
            onDelete?.(oldRecord);
          }
        },
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') {
          console.log(`[Realtime] Subscribed to ${table}${filter ? ` (${filter})` : ''}`);
        }
        if (status === 'CHANNEL_ERROR') {
          console.error(`[Realtime] Channel error for ${table}`);
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [table, filter, event, enabled, primaryKey]);

  return { data, isConnected, updateCount, reset };
}

/**
 * useRealtimeCount — Subscribe to a table and get live row count.
 * Useful for badges and counters.
 */
export function useRealtimeCount(
  table: string,
  filter?: string,
  initialCount: number = 0,
): { count: number; isConnected: boolean } {
  const [count, setCount] = useState(initialCount);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    setCount(initialCount);
  }, [initialCount]);

  useEffect(() => {
    const supabase = createClient();
    const channelName = `count-${table}-${filter ?? 'all'}-${Date.now()}`;

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
        (payload) => {
          if (payload.eventType === 'INSERT') setCount((c) => c + 1);
          if (payload.eventType === 'DELETE') setCount((c) => Math.max(0, c - 1));
        },
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      channel.unsubscribe();
    };
  }, [table, filter]);

  return { count, isConnected };
}

/**
 * usePresence — Simple Realtime presence for "who's online" display.
 */
export function usePresence(
  channelName: string,
  userId: string,
  userData: Record<string, unknown> = {},
): { presences: Record<string, unknown>[]; onlineCount: number } {
  const [presences, setPresences] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase.channel(channelName, {
      config: { presence: { key: userId } },
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const allPresences: Record<string, unknown>[] = [];
        for (const presenceList of Object.values(state)) {
          for (const p of presenceList as Record<string, unknown>[]) {
            allPresences.push(p);
          }
        }
        setPresences(allPresences);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ ...userData, online_at: new Date().toISOString() });
        }
      });

    return () => {
      channel.untrack();
      channel.unsubscribe();
    };
  }, [channelName, userId]);

  return { presences, onlineCount: presences.length };
}
