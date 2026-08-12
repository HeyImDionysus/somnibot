/**
 * Economy Analytics API — Aggregate economy data for dashboard charts.
 *
 * V53 Phase 5 (Finding 5.1 — S-4)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId } = auth.ctx;
  const url = new URL(req.url);
  // Enforce date range: default 30 days, max 90 days
  const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
  const days = Math.min(Math.max(rawDays, 1), 90);

  const admin = createAdminSupabase();

  // Run all analytics RPCs in parallel
  const [dailyTotals, txVolume, marketActivity, topEarners, popularItems, featureParticipation] =
    await Promise.all([
      admin.rpc('economy_daily_totals', { p_guild_id: guildId, p_days: days }),
      admin.rpc('economy_tx_volume_by_type', { p_guild_id: guildId, p_days: days }),
      admin.rpc('economy_market_activity', { p_guild_id: guildId, p_days: days }),
      admin.rpc('economy_top_earners', { p_guild_id: guildId, p_limit: 10 }),
      admin.rpc('economy_popular_items', { p_guild_id: guildId, p_days: days, p_limit: 10 }),
      admin.rpc('economy_feature_participation', { p_guild_id: guildId, p_days: Math.min(days, 7) }),
    ]);

  // Current circulation snapshot (V5 audit 4.2 — use RPC instead of fetching all rows)
  const { data: walletStats } = await admin.rpc('economy_wallet_stats', { p_guild_id: guildId });

  const stats = walletStats?.[0] ?? { total_wallets: 0, total_circulation: 0, total_banked: 0 };
  const totalWallet = stats.total_circulation ?? 0;
  const totalBank = stats.total_banked ?? 0;

  return NextResponse.json({
    success: true,
    days,
    circulation: {
      total_wallet: totalWallet,
      total_bank: totalBank,
      total: totalWallet + totalBank,
      active_wallets: stats.total_wallets ?? 0,
    },
    daily_totals: dailyTotals.data ?? [],
    tx_volume: txVolume.data ?? [],
    market_activity: marketActivity.data ?? [],
    top_earners: topEarners.data ?? [],
    popular_items: popularItems.data ?? [],
    feature_participation: featureParticipation.data ?? [],
  });
}
