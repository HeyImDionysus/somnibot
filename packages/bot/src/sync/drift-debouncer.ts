/**
 * Drift Debouncer — batches rapid drift events per guild.
 *
 * V5 Audit §14.P3a: During bulk admin actions (e.g., reorganizing 20 channels
 * or roles), Discord fires individual events for each change. Without
 * debouncing, each event triggers its own Supabase query + eventBus emit,
 * creating unnecessary load. This module collects drift items over a short
 * window and flushes them in a single batch.
 *
 * Critical events (@everyone drift) bypass the debounce and flush immediately.
 */

import type { DriftItem, DriftSeverity } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('DriftDebouncer');

/** Debounce window in ms — short enough for responsive detection, long enough to batch. */
const DEBOUNCE_MS = 2_000;

interface PendingBatch {
  items: DriftItem[];
  timer: ReturnType<typeof setTimeout>;
}

const _pending = new Map<string, PendingBatch>();

/**
 * Flush a guild's pending drift items to Supabase + eventBus.
 */
async function flush(
  client: SomniClient,
  guildId: string,
  items: DriftItem[],
): Promise<void> {
  if (items.length === 0) return;

  try {
    // Merge into existing drift_details
    const { data: current } = await client.supabase
      .from('guild_desired_state')
      .select('drift_details')
      .eq('guild_id', guildId)
      .maybeSingle();

    const existingItems: DriftItem[] = Array.isArray(current?.drift_details)
      ? current.drift_details
      : [];

    const merged = [...existingItems];
    for (const item of items) {
      const idx = merged.findIndex(
        (e) => e.entityType === item.entityType && e.entityName === item.entityName,
      );
      if (idx >= 0) {
        merged[idx] = item;
      } else {
        merged.push(item);
      }
    }

    await client.supabase
      .from('guild_desired_state')
      .update({
        drift_detected: merged.length > 0,
        drift_details: merged,
        last_sync_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId);

    // Emit a single batched event
    const criticalCount = items.filter((i) => i.severity === 'critical').length;
    client.eventBus.emit('drift.detected', guildId, {
      driftCount: items.length,
      criticalCount,
      autoRepaired: false,
      items: items.map((i) => ({
        type: i.type,
        entityName: i.entityName,
        severity: i.severity,
      })),
    });
  } catch (err) {
    log.error(`Failed to flush drift batch for guild ${guildId}:`, { error: String(err) });
  }
}

/**
 * Queue a drift item for batched recording. If `immediate` is true (critical
 * events), flush the entire pending batch right away.
 */
export function queueDriftItem(
  client: SomniClient,
  guildId: string,
  item: DriftItem,
  immediate = false,
): void {
  const existing = _pending.get(guildId);

  if (immediate) {
    // Critical item — flush everything now (including any pending items)
    if (existing) {
      clearTimeout(existing.timer);
      _pending.delete(guildId);
      flush(client, guildId, [...existing.items, item]).catch((err) => {
        log.error('Immediate flush failed:', { error: String(err) });
      });
    } else {
      flush(client, guildId, [item]).catch((err) => {
        log.error('Immediate flush failed:', { error: String(err) });
      });
    }
    return;
  }

  if (existing) {
    existing.items.push(item);
    // Reset the timer — extend the debounce window
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      _pending.delete(guildId);
      flush(client, guildId, existing.items).catch((err) => {
        log.error('Debounced flush failed:', { error: String(err) });
      });
    }, DEBOUNCE_MS);
  } else {
    const batch: PendingBatch = {
      items: [item],
      timer: setTimeout(() => {
        _pending.delete(guildId);
        flush(client, guildId, batch.items).catch((err) => {
          log.error('Debounced flush failed:', { error: String(err) });
        });
      }, DEBOUNCE_MS),
    };
    _pending.set(guildId, batch);
  }
}
