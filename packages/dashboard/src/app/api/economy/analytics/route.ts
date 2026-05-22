/**
 * Economy Analytics API — Aggregate economy data for dashboard charts.
 *
 * V53 Phase 5 (Finding 5.1 — S-4)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
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

  // Current circulation snapshot
  const { data: circulationSnap } = await admin
    .from('economy_wallets')
    .select('wallet, bank')
    .eq('guild_id', guildId)
    .eq('suspended', false);

  const totalWallet = (circulationSnap ?? []).reduce((s, r) => s + (r.wallet ?? 0), 0);
  const totalBank = (circulationSnap ?? []).reduce((s, r) => s + (r.bank ?? 0), 0);

  return NextResponse.json({
    success: true,
    days,
    circulation: {
      total_wallet: totalWallet,
      total_bank: totalBank,
      total: totalWallet + totalBank,
      active_wallets: circulationSnap?.length ?? 0,
    },
    daily_totals: dailyTotals.data ?? [],
    tx_volume: txVolume.data ?? [],
    market_activity: marketActivity.data ?? [],
    top_earners: topEarners.data ?? [],
    popular_items: popularItems.data ?? [],
    feature_participation: featureParticipation.data ?? [],
  });
}
