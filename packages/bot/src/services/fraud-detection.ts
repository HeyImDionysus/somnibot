/**
 * Fraud Detection Service — Monitors purchases, license activations, and
 * device patterns for suspicious behavior. Emits fraud signals.
 *
 * Phase D: SOTA bot-side fraud engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from './event-bus.js';
import type { FraudSignalType, FraudSeverity } from '@somnibot/shared';

interface FraudContext {
  supabase: SupabaseClient;
  guildId: string;
  eventBus?: PlatformEventBus;
}

interface CreateSignalParams {
  signal_type: FraudSignalType;
  severity: FraudSeverity;
  entity_type: string;
  entity_id: string;
  discord_id: string | null;
  description: string;
  evidence: Record<string, unknown>;
  auto_action?: string;
}

// ── Signal Creation ────────────────────────────────────────

async function createSignal(ctx: FraudContext, params: CreateSignalParams): Promise<void> {
  const { error } = await ctx.supabase.from('fraud_signals').insert({
    guild_id: ctx.guildId,
    ...params,
    status: 'open',
  });

  if (error) {
    // 23505 = an OPEN signal for this (guild, signal_type, entity) already
    // exists (uniq_open_signal_entity partial index). A re-delivered webhook or
    // re-run detector must not duplicate the signal OR re-alert the owner —
    // treat the conflict as an idempotent no-op. Any other insert error is a
    // genuine failure; do not emit a fraud alert we didn't durably record.
    return;
  }

  // Notify owner via event bus only when a NEW signal was actually recorded.
  ctx.eventBus?.emit('fraud.detected', ctx.guildId, {
    signal: params.signal_type,
    severity: params.severity,
    discordId: params.discord_id ?? undefined,
    action: params.auto_action,
    evidence: params.evidence,
  });
}

// ── Configurable Thresholds ────────────────────────────────
// The catalog (commerce.json commerce-fraud) advertises velocity/payment/
// critical thresholds as owner-configurable. The dashboard persists them as
// fraud_rules rows (rule_type + typed jsonb config). Load them once per event
// and thread them into the detectors so a lowered rule actually takes effect
// bot-side; anything unset falls back to the shipped/catalog default so a guild
// that never customized fraud behaves exactly as before.

export interface FraudThresholds {
  velocityThreshold: number;
  velocityWindowMs: number;
  failedPaymentThreshold: number;
  criticalIncidentThreshold: number;
}

export const DEFAULT_FRAUD_THRESHOLDS: FraudThresholds = {
  velocityThreshold: 5,
  velocityWindowMs: 3_600_000,
  failedPaymentThreshold: 3,
  criticalIncidentThreshold: 3,
};

function toPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Load per-guild fraud thresholds from the enabled fraud_rules rows the
 * dashboard writes (/api/fraud/rules). Best-effort: on any read failure or
 * missing rule, the catalog default (== shipped detector value) is used, so
 * detection never blocks fulfillment.
 */
export async function loadFraudThresholds(
  supabase: SupabaseClient,
  guildId: string,
): Promise<FraudThresholds> {
  const result: FraudThresholds = { ...DEFAULT_FRAUD_THRESHOLDS };
  try {
    const { data: rules } = await supabase
      .from('fraud_rules')
      .select('rule_type, config, enabled')
      .eq('guild_id', guildId)
      .eq('enabled', true)
      .limit(500);

    for (const rule of rules ?? []) {
      const config = (rule.config ?? {}) as Record<string, unknown>;
      const threshold = toPositiveInt(config.threshold);
      switch (rule.rule_type) {
        case 'velocity_limit': {
          if (threshold !== null) result.velocityThreshold = threshold;
          const windowMs = toPositiveInt(config.window_ms);
          const windowMinutes = toPositiveInt(config.window_minutes);
          if (windowMs !== null) result.velocityWindowMs = windowMs;
          else if (windowMinutes !== null) result.velocityWindowMs = windowMinutes * 60_000;
          break;
        }
        case 'failed_payment':
        case 'payment_pattern': {
          if (threshold !== null) result.failedPaymentThreshold = threshold;
          break;
        }
        case 'critical_incident': {
          if (threshold !== null) result.criticalIncidentThreshold = threshold;
          break;
        }
      }
    }
  } catch {
    // keep defaults
  }
  return result;
}

// ── Velocity Check ─────────────────────────────────────────
// Triggers if a customer places too many orders in a short window.

export async function checkPurchaseVelocity(
  ctx: FraudContext,
  customerId: string,
  discordId: string | null,
  opts?: { threshold?: number; windowMs?: number },
): Promise<void> {
  const threshold = opts?.threshold ?? DEFAULT_FRAUD_THRESHOLDS.velocityThreshold;
  const windowMs = opts?.windowMs ?? DEFAULT_FRAUD_THRESHOLDS.velocityWindowMs;
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));

  const since = new Date(Date.now() - windowMs).toISOString();

  const { count } = await ctx.supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .gte('created_at', since);

  if (count && count >= threshold) {
    await createSignal(ctx, {
      signal_type: 'velocity',
      severity: count >= threshold * 2 ? 'critical' : 'high',
      entity_type: 'customer',
      entity_id: customerId,
      discord_id: discordId,
      description: `${count} orders in the last ${windowMinutes} minutes (threshold: ${threshold})`,
      evidence: { order_count: count, window_minutes: windowMinutes, threshold },
    });
  }
}

// ── Device Abuse Check ─────────────────────────────────────
// Triggers if a license key is activated on too many unique devices.
// NOTE: License validation runs in the dashboard API, which has its own
// inline copy of this check (packages/dashboard/src/app/api/license/validate/route.ts).
// This export is kept for bot-side use if license events are ever processed here.

export async function checkDeviceAbuse(
  ctx: FraudContext,
  licenseKeyId: string,
  maxDevices: number,
  discordId: string | null,
): Promise<void> {
  const { count } = await ctx.supabase
    .from('license_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('license_key_id', licenseKeyId);

  const totalDevices = count || 0;

  // Flag if total unique sessions exceed 3x the allowed device limit
  if (totalDevices > maxDevices * 3) {
    await createSignal(ctx, {
      signal_type: 'device_abuse',
      severity: totalDevices > maxDevices * 5 ? 'critical' : 'high',
      entity_type: 'license_key',
      entity_id: licenseKeyId,
      discord_id: discordId,
      description: `${totalDevices} total device sessions on a ${maxDevices}-device license`,
      evidence: { total_sessions: totalDevices, max_devices: maxDevices, ratio: totalDevices / maxDevices },
    });
  }
}

// ── IP Mismatch Check ──────────────────────────────────────
// Triggers if license activations come from many different IPs rapidly.
// NOTE: See checkDeviceAbuse note above — dashboard has its own inline copy.

export async function checkIPMismatch(
  ctx: FraudContext,
  licenseKeyId: string,
  discordId: string | null,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: sessions } = await ctx.supabase
    .from('license_sessions')
    .select('ip_address')
    .eq('license_key_id', licenseKeyId)
    .gte('first_seen_at', since)
    .limit(1000);

  const uniqueIPs = new Set((sessions || []).map(s => s.ip_address).filter(Boolean));

  if (uniqueIPs.size >= 5) {
    await createSignal(ctx, {
      signal_type: 'ip_mismatch',
      severity: uniqueIPs.size >= 10 ? 'critical' : 'medium',
      entity_type: 'license_key',
      entity_id: licenseKeyId,
      discord_id: discordId,
      description: `${uniqueIPs.size} unique IPs in the last 24 hours`,
      evidence: { unique_ips: uniqueIPs.size, window_hours: 24, ips: Array.from(uniqueIPs).slice(0, 10) },
    });
  }
}

// ── Payment Pattern Check ──────────────────────────────────
// Triggers on repeated failed payments from same customer.

export async function checkPaymentPattern(
  ctx: FraudContext,
  customerId: string,
  discordId: string | null,
  opts?: { threshold?: number },
): Promise<void> {
  const threshold = opts?.threshold ?? DEFAULT_FRAUD_THRESHOLDS.failedPaymentThreshold;
  const escalateAt = threshold + 2; // default 3 → escalate to 'high' at 5
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: failedCount } = await ctx.supabase
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('status', 'failed')
    .gte('created_at', since);

  if (failedCount && failedCount >= threshold) {
    await createSignal(ctx, {
      signal_type: 'payment_pattern',
      severity: failedCount >= escalateAt ? 'high' : 'medium',
      entity_type: 'customer',
      entity_id: customerId,
      discord_id: discordId,
      description: `${failedCount} failed payments in the last 24 hours (threshold: ${threshold})`,
      evidence: { failed_count: failedCount, window_hours: 24, threshold },
    });
  }
}

// ── Auto-Incident Creation ─────────────────────────────────
// Creates incidents from critical fraud signals or alert thresholds.

export async function checkCriticalThreshold(
  ctx: FraudContext,
  opts?: { threshold?: number },
): Promise<void> {
  const threshold = opts?.threshold ?? DEFAULT_FRAUD_THRESHOLDS.criticalIncidentThreshold;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last hour

  const { count } = await ctx.supabase
    .from('fraud_signals')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', ctx.guildId)
    .eq('status', 'open')
    .eq('severity', 'critical')
    .gte('last_observed_at', since);

  if (count && count >= threshold) {
    // Check if we already created an incident for this burst
    const { data: existing } = await ctx.supabase
      .from('incidents')
      .select('id')
      .eq('guild_id', ctx.guildId)
      .eq('source', 'fraud_auto')
      .not('status', 'eq', 'resolved')
      .gte('created_at', since)
      .limit(1);

    if (!existing || existing.length === 0) {
      // Get next incident number (atomic sequence — no race condition)
      const { data: seqVal } = await ctx.supabase.rpc('nextval_incident');
      const nextNumber = typeof seqVal === 'number' ? seqVal : 1;

      // The check-above/insert-below is a check-then-act: two concurrent bursts
      // can both find no open incident and both reach here. The partial unique
      // index uniq_open_fraud_auto_incident (guild_id) WHERE source='fraud_auto'
      // AND status<>'resolved' is the real fence — the losing racer's insert
      // fails with 23505 and must no-op (no duplicate incident, no double page)
      // rather than surface an error or emit incident.created.
      const { data: incident, error: incidentError } = await ctx.supabase
        .from('incidents')
        .insert({
          guild_id: ctx.guildId,
          incident_number: nextNumber,
          title: `Fraud alert: ${count} critical signals in the last hour`,
          description: 'Auto-created incident due to elevated critical fraud signals.',
          severity: 'critical',
          status: 'open',
          source: 'fraud_auto',
          created_by: 'system:fraud',
        })
        .select()
        .single();

      if (incidentError) {
        // 23505 = another concurrent burst already opened the live fraud_auto
        // incident for this guild. Treat as idempotent no-op.
        return;
      }

      if (incident) {
        await ctx.supabase.from('incident_events').insert({
          incident_id: incident.id,
          event_type: 'auto_created',
          actor_id: 'system:fraud',
          message: `${count} critical fraud signals detected in the last hour. Automatic incident created.`,
          metadata: { signal_count: count },
        });

        // Notify owner via event bus
        ctx.eventBus?.emit('incident.created', ctx.guildId, {
          incidentId: incident.id,
          incidentNumber: nextNumber,
          title: incident.title,
          severity: 'critical',
          source: 'fraud_auto',
        });
      }
    }
  }
}
