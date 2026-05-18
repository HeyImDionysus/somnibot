/**
 * GET /api/customers/[id]/timeline — Unified customer timeline.
 * Merges: orders, entitlements, tickets, infractions, license sessions, level events.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

interface TimelineEvent {
  id: string;
  type: string;
  category: 'commerce' | 'support' | 'moderation' | 'engagement' | 'system';
  title: string;
  description: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePermission('dashboard.manage_customers');
    const { id } = await params;
    const admin = createAdminSupabase();

    // Get customer
    const { data: customer } = await admin
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .single();

    if (!customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    const timeline: TimelineEvent[] = [];

    // ── Orders ────────────────────────────────────────
    const { data: orders } = await admin
      .from('orders')
      .select('*, products(name)')
      .eq('customer_id', id)
      .order('created_at', { ascending: false });

    for (const o of orders || []) {
      timeline.push({
        id: `order-${o.id}`,
        type: 'order',
        category: 'commerce',
        title: `Order ${o.order_number} — ${o.status}`,
        description: `${(o as Record<string, { name: string }>).products?.name || 'Unknown product'} • $${(o.amount_cents / 100).toFixed(2)} ${o.currency}`,
        timestamp: o.created_at,
        metadata: { orderId: o.id, status: o.status, source: o.source },
      });
    }

    // ── Entitlements ──────────────────────────────────
    const { data: entitlements } = await admin
      .from('entitlements')
      .select('*, products(name)')
      .eq('customer_id', id)
      .order('created_at', { ascending: false });

    for (const e of entitlements || []) {
      timeline.push({
        id: `entitlement-${e.id}`,
        type: `entitlement.${e.status}`,
        category: 'commerce',
        title: `Entitlement ${e.status} — ${(e as Record<string, { name: string }>).products?.name || 'Unknown'}`,
        description: `${e.type} entitlement • Source: ${e.source}`,
        timestamp: e.created_at,
        metadata: { entitlementId: e.id, status: e.status, type: e.type },
      });
    }

    // ── License sessions ──────────────────────────────
    const { data: licenseKeys } = await admin
      .from('license_keys')
      .select('id, key_prefix, key_suffix')
      .eq('customer_id', id);

    if (licenseKeys && licenseKeys.length > 0) {
      const keyIds = licenseKeys.map(k => k.id);
      const { data: sessions } = await admin
        .from('license_sessions')
        .select('*')
        .in('license_key_id', keyIds)
        .order('first_seen_at', { ascending: false })
        .limit(50);

      for (const s of sessions || []) {
        const key = licenseKeys.find(k => k.id === s.license_key_id);
        timeline.push({
          id: `session-${s.id}`,
          type: s.active ? 'license.session_active' : 'license.session_ended',
          category: 'system',
          title: `License session ${s.active ? 'started' : 'ended'}`,
          description: `Key: ${key?.key_prefix || ''}…${key?.key_suffix || ''} • Device: ${s.device_name || s.device_fingerprint?.slice(0, 12) || 'Unknown'}`,
          timestamp: s.first_seen_at,
          metadata: { sessionId: s.id, deviceFingerprint: s.device_fingerprint, active: s.active },
        });
      }
    }

    // ── Tickets ───────────────────────────────────────
    const { data: tickets } = await admin
      .from('tickets')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .eq('creator_id', customer.discord_id)
      .order('created_at', { ascending: false });

    for (const t of tickets || []) {
      timeline.push({
        id: `ticket-${t.id}`,
        type: `ticket.${t.status}`,
        category: 'support',
        title: `Ticket #${t.ticket_number} — ${t.status}`,
        description: `Type: ${t.type} • Messages: ${t.message_count}${t.close_reason ? ` • Reason: ${t.close_reason}` : ''}`,
        timestamp: t.created_at,
        metadata: { ticketId: t.id, status: t.status, messageCount: t.message_count },
      });
    }

    // ── Infractions ───────────────────────────────────
    const { data: infractions } = await admin
      .from('infractions')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .eq('member_id', customer.discord_id)
      .order('created_at', { ascending: false });

    for (const inf of infractions || []) {
      timeline.push({
        id: `infraction-${inf.id}`,
        type: `infraction.${inf.type}`,
        category: 'moderation',
        title: `${inf.type.charAt(0).toUpperCase() + inf.type.slice(1)}${inf.pardoned ? ' (Pardoned)' : ''}`,
        description: inf.reason || 'No reason provided',
        timestamp: inf.created_at,
        metadata: { infractionId: inf.id, type: inf.type, active: inf.active, pardoned: inf.pardoned },
      });
    }

    // ── Level events (from audit log) ─────────────────
    const { data: levelEvents } = await admin
      .from('audit_logs')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .eq('target_id', customer.discord_id)
      .like('action', 'level%')
      .order('timestamp', { ascending: false })
      .limit(20);

    for (const le of levelEvents || []) {
      timeline.push({
        id: `level-${le.id}`,
        type: 'level.event',
        category: 'engagement',
        title: le.action.replace('.', ' ').replace(/_/g, ' '),
        description: JSON.stringify(le.details || {}),
        timestamp: le.timestamp,
        metadata: le.details || {},
      });
    }

    // Sort by timestamp descending
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json({
      success: true,
      data: {
        customer,
        timeline,
        summary: {
          totalOrders: (orders || []).length,
          totalSpent: customer.total_spent_cents,
          activeEntitlements: (entitlements || []).filter(e => e.status === 'active').length,
          openTickets: (tickets || []).filter(t => t.status === 'open' || t.status === 'claimed').length,
          infractions: (infractions || []).filter(i => i.active).length,
          activeLicenseSessions: licenseKeys ? (await admin
            .from('license_sessions')
            .select('*', { count: 'exact', head: true })
            .in('license_key_id', licenseKeys.map(k => k.id))
            .eq('active', true)).count || 0 : 0,
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
