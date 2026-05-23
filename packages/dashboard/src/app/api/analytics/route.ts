/**
 * GET /api/analytics — Commerce analytics: revenue, customers, products.
 * Aggregates data from orders, payments, customers, entitlements.
 *
 * Query params:
 *   period: '7d' | '30d' | '90d' | '1y' | 'all' (default: '30d')
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.view_analytics');
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '30d';

    const admin = createAdminSupabase();

    // Calculate date range
    const now = new Date();
    let startDate: Date;
    switch (period) {
      case '7d': startDate = new Date(now.getTime() - 7 * 86400000); break;
      case '30d': startDate = new Date(now.getTime() - 30 * 86400000); break;
      case '90d': startDate = new Date(now.getTime() - 90 * 86400000); break;
      case '1y': startDate = new Date(now.getTime() - 365 * 86400000); break;
      default: startDate = new Date('2020-01-01');
    }
    const startIso = startDate.toISOString();

    // Previous period for comparison
    const periodMs = now.getTime() - startDate.getTime();
    const prevStart = new Date(startDate.getTime() - periodMs).toISOString();

    // ── Revenue metrics ────────────────────────────────
    // V5 audit 7.1 — safety LIMIT caps on period-bounded queries
    const { data: currentOrders } = await admin
      .from('orders')
      .select('amount_cents, discount_cents, currency, status, source, created_at, product_id')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', startIso)
      .in('status', ['completed', 'refunded'])
      .limit(10000);

    const { data: prevOrders } = await admin
      .from('orders')
      .select('amount_cents, status')
      .eq('guild_id', ctx.guildId)
      .gte('created_at', prevStart)
      .lt('created_at', startIso)
      .in('status', ['completed', 'refunded'])
      .limit(10000);

    const completedOrders = (currentOrders || []).filter(o => o.status === 'completed');
    const refundedOrders = (currentOrders || []).filter(o => o.status === 'refunded');
    const prevCompleted = (prevOrders || []).filter(o => o.status === 'completed');

    const totalRevenue = completedOrders.reduce((sum, o) => sum + o.amount_cents - o.discount_cents, 0);
    const prevRevenue = prevCompleted.reduce((sum, o) => sum + o.amount_cents - (o as Record<string, number>).discount_cents || 0, 0);
    const totalRefunds = refundedOrders.reduce((sum, o) => sum + o.amount_cents, 0);
    const avgOrderValue = completedOrders.length > 0 ? Math.round(totalRevenue / completedOrders.length) : 0;

    // Revenue by day for chart
    const revenueByDay: Record<string, number> = {};
    for (const order of completedOrders) {
      const day = order.created_at.slice(0, 10);
      revenueByDay[day] = (revenueByDay[day] || 0) + order.amount_cents - order.discount_cents;
    }

    // Revenue by product
    const revenueByProduct: Record<string, { revenue: number; orders: number }> = {};
    for (const order of completedOrders) {
      const pid = order.product_id;
      if (!revenueByProduct[pid]) revenueByProduct[pid] = { revenue: 0, orders: 0 };
      revenueByProduct[pid].revenue += order.amount_cents - order.discount_cents;
      revenueByProduct[pid].orders += 1;
    }

    // ── Customer metrics ───────────────────────────────
    const { data: allCustomers } = await admin
      .from('customers')
      .select('id, total_spent_cents, first_purchase_at, created_at')
      .eq('guild_id', ctx.guildId)
      .limit(10000);

    const { count: newCustomersCount } = await admin
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .gte('first_purchase_at', startIso);

    const { count: prevNewCustomers } = await admin
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .gte('first_purchase_at', prevStart)
      .lt('first_purchase_at', startIso);

    const customers = allCustomers || [];
    const totalCustomers = customers.length;
    const totalLTV = customers.reduce((sum, c) => sum + c.total_spent_cents, 0);
    const avgLTV = totalCustomers > 0 ? Math.round(totalLTV / totalCustomers) : 0;

    // ── Entitlement / Churn metrics ────────────────────
    const { count: activeEntitlements } = await admin
      .from('entitlements')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .eq('status', 'active');

    const { count: cancelledEntitlements } = await admin
      .from('entitlements')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .in('status', ['cancelled', 'expired'])
      .gte('updated_at', startIso);

    const { count: totalEntitlements } = await admin
      .from('entitlements')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    const churnRate = totalEntitlements && totalEntitlements > 0
      ? Math.round(((cancelledEntitlements || 0) / totalEntitlements) * 10000) / 100
      : 0;

    // ── Product performance ────────────────────────────
    const { data: products } = await admin
      .from('products')
      .select('id, name, price_cents, type, active')
      .eq('guild_id', ctx.guildId);

    const productPerformance = (products || []).map(p => {
      const stats = revenueByProduct[p.id] || { revenue: 0, orders: 0 };
      return {
        id: p.id,
        name: p.name,
        price_cents: p.price_cents,
        type: p.type,
        active: p.active,
        revenue: stats.revenue,
        orders: stats.orders,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // ── Promotion performance ──────────────────────────
    const { data: promotions } = await admin
      .from('promotions')
      .select('id, name, type, value, coupon_code, current_uses, max_uses, active')
      .eq('guild_id', ctx.guildId);

    // ── Failed payments ────────────────────────────────
    const { data: failedPayments } = await admin
      .from('payments')
      .select('id, amount_cents, status, created_at')
      .eq('guild_id', ctx.guildId)
      .eq('status', 'failed')
      .gte('created_at', startIso)
      .limit(10000);

    return NextResponse.json({
      success: true,
      data: {
        period,
        revenue: {
          total: totalRevenue,
          previous: prevRevenue,
          change: prevRevenue > 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 10000) / 100 : 0,
          refunds: totalRefunds,
          avgOrderValue,
          orderCount: completedOrders.length,
          byDay: revenueByDay,
        },
        customers: {
          total: totalCustomers,
          new: newCustomersCount || 0,
          previousNew: prevNewCustomers || 0,
          avgLTV,
        },
        entitlements: {
          active: activeEntitlements || 0,
          churned: cancelledEntitlements || 0,
          churnRate,
        },
        products: productPerformance,
        promotions: promotions || [],
        failedPayments: {
          count: (failedPayments || []).length,
          totalAmount: (failedPayments || []).reduce((sum, p) => sum + p.amount_cents, 0),
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
