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
  await ctx.supabase.from('fraud_signals').insert({
    guild_id: ctx.guildId,
    ...params,
    status: 'open',
  });

  // Notify owner via event bus (if available)
  ctx.eventBus?.emit('fraud.detected', ctx.guildId, {
    signal: params.signal_type,
    severity: params.severity,
    discordId: params.discord_id ?? undefined,
    action: params.auto_action,
    evidence: params.evidence,
  });
}

// ── Velocity Check ─────────────────────────────────────────
// Triggers if a customer places too many orders in a short window.

export async function checkPurchaseVelocity(
  ctx: FraudContext,
  customerId: string,
  discordId: string | null,
): Promise<void> {
  const windowMinutes = 60;
  const threshold = 5;

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

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
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: failedCount } = await ctx.supabase
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('status', 'failed')
    .gte('created_at', since);

  if (failedCount && failedCount >= 3) {
    await createSignal(ctx, {
      signal_type: 'payment_pattern',
      severity: failedCount >= 5 ? 'high' : 'medium',
      entity_type: 'customer',
      entity_id: customerId,
      discord_id: discordId,
      description: `${failedCount} failed payments in the last 24 hours`,
      evidence: { failed_count: failedCount, window_hours: 24 },
    });
  }
}

// ── Auto-Incident Creation ─────────────────────────────────
// Creates incidents from critical fraud signals or alert thresholds.

export async function checkCriticalThreshold(ctx: FraudContext): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last hour

  const { count } = await ctx.supabase
    .from('fraud_signals')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', ctx.guildId)
    .eq('status', 'open')
    .eq('severity', 'critical')
    .gte('created_at', since);

  if (count && count >= 3) {
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

      const { data: incident } = await ctx.supabase
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
