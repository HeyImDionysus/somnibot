/**
 * AlertManager — Threshold-based alerting for the diagnostics dashboard.
 *
 * Phase C: Real diagnostics & alerts.
 *
 * Evaluates health snapshots against configurable thresholds and
 * creates/resolves alerts in the `alerts` table. Designed to run
 * after each DiagnosticsService snapshot write.
 *
 * Alert types:
 *  - memory_high      — RSS exceeds threshold
 *  - ws_ping_high     — Discord WS latency exceeds threshold
 *  - valkey_disconnected — Valkey cache is unreachable
 *  - lavalink_down    — All Lavalink nodes are disconnected
 *  - webhook_errors   — High webhook error rate
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import type { PlatformEventBus } from '../../services/event-bus.js';

const log = createLogger('AlertManager');

// ── Threshold Configuration ─────────────────────────────────

export interface AlertThresholds {
  memoryRssMb: number;
  wsPingMs: number;
  webhookErrorRate: number; // 0.0–1.0
}

/** Postgres numeric comes back as a string; coerce and reject nonsense. */
function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  memoryRssMb: 512,
  wsPingMs: 500,
  webhookErrorRate: 0.25,
};

// ── Snapshot Shape ──────────────────────────────────────────

export interface HealthSnapshot {
  guild_id: string;
  memory_rss_mb: number;
  discord_ws_ping: number;
  valkey_connected: boolean;
  lavalink_nodes: Array<{ name: string; connected: boolean; players: number }>;
}

// ── Alert Entry ─────────────────────────────────────────────

interface AlertEntry {
  guild_id: string;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

// ── AlertManager ────────────────────────────────────────────

export class AlertManager {
  private supabase: SupabaseClient;
  private thresholds: AlertThresholds;
  private activeAlerts: Set<string> = new Set();
  // Optional platform event bus — when present, alert lifecycle transitions
  // (raised / resolved, incl. dependency-down) are mirrored to the append-only
  // audit_logs trail via AuditService. Optional so the manager still works in
  // isolation (e.g. unit fixtures) without an event bus.
  private eventBus?: PlatformEventBus;

  constructor(
    supabase: SupabaseClient,
    thresholds?: Partial<AlertThresholds>,
    eventBus?: PlatformEventBus,
  ) {
    this.supabase = supabase;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.eventBus = eventBus;
  }

  /**
   * Per-guild threshold overrides, cached briefly.
   *
   * Snapshots arrive on a 60s tick, so a 60s TTL means an owner's change is
   * picked up on the next evaluation without adding a read to every call.
   */
  private thresholdCache = new Map<string, { value: AlertThresholds; time: number }>();

  /**
   * Thresholds for one guild: the owner's configured values over the shipped
   * defaults. A failed or missing read falls back to the defaults rather than
   * skipping evaluation — losing alerting entirely because a config read
   * blipped would be worse than alerting on the default numbers.
   */
  private async thresholdsFor(guildId: string): Promise<AlertThresholds> {
    const now = Date.now();
    const cached = this.thresholdCache.get(guildId);
    if (cached && now - cached.time < 60_000) return cached.value;

    let resolved = this.thresholds;
    try {
      const { data, error } = await this.supabase
        .from('guild_config')
        .select('memory_alert_threshold_mb, ws_ping_alert_threshold_ms, webhook_error_rate_threshold')
        .eq('guild_id', guildId)
        .maybeSingle();
      if (!error && data) {
        const row = data as Record<string, unknown>;
        resolved = {
          memoryRssMb: numberOr(row.memory_alert_threshold_mb, this.thresholds.memoryRssMb),
          wsPingMs: numberOr(row.ws_ping_alert_threshold_ms, this.thresholds.wsPingMs),
          webhookErrorRate: numberOr(row.webhook_error_rate_threshold, this.thresholds.webhookErrorRate),
        };
      }
    } catch (err) {
      log.warn('Could not read alert thresholds; using defaults', { guildId, error: String(err) });
    }

    this.thresholdCache.set(guildId, { value: resolved, time: now });
    return resolved;
  }

  /** Drop a guild's cached thresholds so the next evaluation re-reads them. */
  invalidateThresholds(guildId?: string): void {
    if (guildId) this.thresholdCache.delete(guildId);
    else this.thresholdCache.clear();
  }

  /**
   * Evaluate a health snapshot and create/resolve alerts as needed.
   */
  async evaluate(snapshot: HealthSnapshot): Promise<void> {
    const alerts: AlertEntry[] = [];
    const thresholds = await this.thresholdsFor(snapshot.guild_id);

    // 1. Memory pressure
    if (snapshot.memory_rss_mb > thresholds.memoryRssMb) {
      alerts.push({
        guild_id: snapshot.guild_id,
        alert_type: 'memory_high',
        severity: snapshot.memory_rss_mb > thresholds.memoryRssMb * 1.5 ? 'critical' : 'warning',
        title: 'High Memory Usage',
        message: `Bot RSS memory is ${snapshot.memory_rss_mb.toFixed(1)}MB (threshold: ${thresholds.memoryRssMb}MB)`,
        metadata: { rss_mb: snapshot.memory_rss_mb, threshold_mb: thresholds.memoryRssMb },
      });
    }

    // 2. High WS ping
    if (snapshot.discord_ws_ping > thresholds.wsPingMs) {
      alerts.push({
        guild_id: snapshot.guild_id,
        alert_type: 'ws_ping_high',
        severity: snapshot.discord_ws_ping > thresholds.wsPingMs * 2 ? 'critical' : 'warning',
        title: 'High Discord Latency',
        message: `WebSocket ping is ${snapshot.discord_ws_ping}ms (threshold: ${thresholds.wsPingMs}ms)`,
        metadata: { ping_ms: snapshot.discord_ws_ping, threshold_ms: thresholds.wsPingMs },
      });
    }

    // 3. Valkey disconnected
    if (!snapshot.valkey_connected) {
      alerts.push({
        guild_id: snapshot.guild_id,
        alert_type: 'valkey_disconnected',
        severity: 'critical',
        title: 'Valkey Cache Disconnected',
        message: 'The Valkey/Redis cache is unreachable. Caching, rate limiting, and session features may not work.',
        metadata: {},
      });
    }

    // 4. All Lavalink nodes down.
    // The length check is deliberate, not a guard against an empty array: a node
    // stays in Shoukaku's map while it retries, so a configured-but-unreachable
    // Lavalink still shows up here as connected:false and does alert. Zero nodes
    // only happens when no LAVALINK_PASSWORD was set, i.e. music was switched
    // off on purpose — paging someone about a feature they declined is noise.
    if (snapshot.lavalink_nodes.length > 0 && snapshot.lavalink_nodes.every((n) => !n.connected)) {
      alerts.push({
        guild_id: snapshot.guild_id,
        alert_type: 'lavalink_down',
        severity: 'warning',
        title: 'All Lavalink Nodes Down',
        message: `All ${snapshot.lavalink_nodes.length} Lavalink node(s) are disconnected. Music playback will not work.`,
        metadata: { nodeCount: snapshot.lavalink_nodes.length },
      });
    }

    // Upsert new alerts, resolve cleared ones
    const currentAlertTypes = new Set(alerts.map((a) => a.alert_type));

    // Create/update active alerts
    for (const alert of alerts) {
      try {
        // Check if an unresolved alert of this type already exists
        const { data: existing } = await this.supabase
          .from('alerts')
          .select('id')
          .eq('guild_id', alert.guild_id)
          .eq('alert_type', alert.alert_type)
          .eq('resolved', false)
          .maybeSingle();

        // The alert row id anchors the linked incident's source_ref_id below, so
        // capture it on every branch (existing update, fresh insert, or the race
        // where a concurrent evaluation already inserted it).
        let alertId: string | null = null;

        if (existing) {
          alertId = existing.id;
          // Update the existing alert with latest data
          await this.supabase
            .from('alerts')
            .update({
              message: alert.message,
              severity: alert.severity,
              metadata: alert.metadata,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
        } else {
          // Create new alert. The partial unique index
          // uniq_alerts_unresolved_diagnostics fences concurrent openers of the
          // same diagnostic type across processes/shards (the in-memory
          // activeAlerts Set is empty on a fresh boot, so it can't). A 23505
          // here means another evaluation already opened this exact alert — the
          // intended single-row outcome, not a failure; fall through and treat
          // it as open. Any other error surfaces via the catch below.
          const { error: insertErr } = await this.supabase
            .from('alerts')
            .insert(alert);
          if (insertErr && (insertErr as { code?: string }).code !== '23505') {
            throw insertErr;
          }
          // Only THIS evaluation's fresh insert (no error) mirrors an
          // alert.raised audit event — a 23505 means a concurrent evaluation
          // already opened it and emitted, so we must not double-audit.
          if (!insertErr) {
            this.eventBus?.emit('diagnostics.alert_raised', alert.guild_id, {
              alertType: alert.alert_type,
              severity: alert.severity,
              title: alert.title,
              message: alert.message,
            });
          }
          // Read back the id of the now-open alert (whether this evaluation
          // inserted it or lost the 23505 race to a concurrent one) so the
          // linked incident below binds to the single canonical alert row.
          const { data: openRow } = await this.supabase
            .from('alerts')
            .select('id')
            .eq('guild_id', alert.guild_id)
            .eq('alert_type', alert.alert_type)
            .eq('resolved', false)
            .maybeSingle();
          alertId = openRow?.id ?? null;
        }

        this.activeAlerts.add(alert.alert_type);

        // A critical diagnostics alert automatically opens a LINKED incident with
        // its source reference set to the alert, deduplicated per alert reference.
        if (alert.severity === 'critical' && alertId) {
          await this.openIncidentForCriticalAlert(alert, alertId);
        }
      } catch (err) {
        log.error(`Failed to upsert alert ${alert.alert_type}:`, err);
      }
    }

    // Resolve alerts that are no longer firing
    const alertTypesToResolve = [...this.activeAlerts].filter((t) => !currentAlertTypes.has(t));
    for (const alertType of alertTypesToResolve) {
      try {
        await this.supabase
          .from('alerts')
          .update({
            resolved: true,
            resolved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('guild_id', snapshot.guild_id)
          .eq('alert_type', alertType)
          .eq('resolved', false);

        this.activeAlerts.delete(alertType);

        // Mirror the auto-resolution to the append-only audit trail.
        this.eventBus?.emit('diagnostics.alert_resolved', snapshot.guild_id, {
          alertType,
        });
      } catch (err) {
        log.error(`Failed to resolve alert ${alertType}:`, err);
      }
    }
  }

  /**
   * Auto-open a LINKED incident for a critical diagnostics alert, deduplicated
   * per alert reference. The incident carries source='health_alert' and
   * source_ref_id=<alert.id> so the operations dashboard can trace the incident
   * back to the alert that opened it.
   *
   * Dedup is enforced two ways: a cheap check-then-insert (skip if an incident
   * already links this alert) plus the partial unique index uniq_incident_source_ref
   * (guild_id, source_ref_id) as the real cross-process/shard fence. A 23505 from
   * a racing evaluation is the intended single-row outcome — swallow it as an
   * idempotent no-op so one alert can never open (or re-page for) two incidents.
   */
  private async openIncidentForCriticalAlert(alert: AlertEntry, alertId: string): Promise<void> {
    // Already linked? Nothing to do — the alert stays bound to its one incident
    // across repeated evaluations while it remains unresolved.
    const { data: linked } = await this.supabase
      .from('incidents')
      .select('id')
      .eq('guild_id', alert.guild_id)
      .eq('source_ref_id', alertId)
      .limit(1);
    if (linked && linked.length > 0) return;

    // Atomic incident number (per the restored sequence draw).
    const { data: seqVal } = await this.supabase.rpc('nextval_incident');
    const nextNumber = typeof seqVal === 'number' ? seqVal : 1;

    const { data: incident, error: incidentError } = await this.supabase
      .from('incidents')
      .insert({
        guild_id: alert.guild_id,
        incident_number: nextNumber,
        title: `Critical alert: ${alert.title}`,
        description: alert.message,
        severity: 'critical',
        status: 'open',
        source: 'health_alert',
        source_ref_id: alertId,
        created_by: 'system:diagnostics',
      })
      .select()
      .single();

    if (incidentError) {
      // 23505 = a concurrent evaluation/shard already opened the linked incident
      // for this alert reference (uniq_incident_source_ref). Idempotent no-op.
      return;
    }

    if (incident) {
      await this.supabase.from('incident_events').insert({
        incident_id: incident.id,
        event_type: 'auto_created',
        actor_id: 'system:diagnostics',
        message: `Auto-created from critical diagnostics alert "${alert.alert_type}".`,
        metadata: { alert_type: alert.alert_type, alert_id: alertId },
      });
    }
  }
}
