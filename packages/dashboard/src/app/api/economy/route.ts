/**
 * GET  /api/economy — Economy config + wallet stats
 * PATCH /api/economy — Update economy guild_config columns
 *
 * This is for the FAKE economy (virtual currency). NOT real money.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';

const ECONOMY_COLUMNS = [
  'economy_enabled',
  'currency_name',
  'currency_emoji',
  'economy_starting_balance',
  'economy_daily_amount',
  'economy_weekly_amount',
  'economy_monthly_amount',
  'economy_streak_bonus_pct',
  'economy_work_cooldown_seconds',
  'economy_work_min',
  'economy_work_max',
  'economy_crime_success_pct',
  'economy_crime_fine_pct',
  'economy_crime_min',
  'economy_crime_max',
  'economy_chat_income_enabled',
  'economy_chat_income_min',
  'economy_chat_income_max',
  'economy_chat_income_cooldown_seconds',
  'economy_rob_enabled',
  'economy_rob_success_pct',
  'economy_rob_fine_pct',
  'economy_heist_enabled',
  'economy_heist_min_participants',
  'economy_heist_max_participants',
  'economy_heist_join_window_secs',
  'economy_heist_cooldown_seconds',
  'economy_heist_base_payout',
  'economy_heist_success_base_pct',
  'economy_heist_entry_fee',
  'economy_passive_mode_allowed',
  'economy_pay_tax_pct',
  'economy_max_wallet',
  'economy_max_bank',
  'economy_log_channel_id',
] as const;

/** Zod schema for PATCH validation — matches column types + sane ranges */
const economyPatchSchema = z.object({
  economy_enabled: z.boolean().optional(),
  currency_name: z.string().min(1).max(32).optional(),
  currency_emoji: z.string().min(1).max(64).optional(),
  economy_starting_balance: z.number().int().min(0).max(1_000_000).optional(),
  economy_daily_amount: z.number().int().min(0).max(1_000_000).optional(),
  economy_weekly_amount: z.number().int().min(0).max(10_000_000).optional(),
  economy_monthly_amount: z.number().int().min(0).max(100_000_000).optional(),
  economy_streak_bonus_pct: z.number().int().min(0).max(100).optional(),
  economy_work_cooldown_seconds: z.number().int().min(60).max(86400).optional(),
  economy_work_min: z.number().int().min(0).max(1_000_000).optional(),
  economy_work_max: z.number().int().min(0).max(10_000_000).optional(),
  economy_crime_success_pct: z.number().int().min(1).max(100).optional(),
  economy_crime_fine_pct: z.number().int().min(0).max(100).optional(),
  economy_crime_min: z.number().int().min(0).max(1_000_000).optional(),
  economy_crime_max: z.number().int().min(0).max(10_000_000).optional(),
  economy_chat_income_enabled: z.boolean().optional(),
  economy_chat_income_min: z.number().int().min(0).max(10_000).optional(),
  economy_chat_income_max: z.number().int().min(0).max(100_000).optional(),
  economy_chat_income_cooldown_seconds: z.number().int().min(1).max(3600).optional(),
  economy_rob_enabled: z.boolean().optional(),
  economy_rob_success_pct: z.number().int().min(1).max(100).optional(),
  economy_rob_fine_pct: z.number().int().min(0).max(100).optional(),
  economy_heist_enabled: z.boolean().optional(),
  economy_heist_min_participants: z.number().int().min(1).max(50).optional(),
  economy_heist_max_participants: z.number().int().min(1).max(100).optional(),
  economy_heist_join_window_secs: z.number().int().min(10).max(600).optional(),
  economy_heist_cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  economy_heist_base_payout: z.number().int().min(0).max(10_000_000).optional(),
  economy_heist_success_base_pct: z.number().int().min(1).max(100).optional(),
  economy_heist_entry_fee: z.number().int().min(0).max(1_000_000).optional(),
  economy_passive_mode_allowed: z.boolean().optional(),
  economy_pay_tax_pct: z.number().int().min(0).max(50).optional(),
  // V5 Audit §5.P3a — cap at PG INT max to prevent overflow
  economy_max_wallet: z.number().int().min(0).max(2_147_483_647).optional(),
  economy_max_bank: z.number().int().min(0).max(2_147_483_647).optional(),
  economy_log_channel_id: z.string().nullable().optional(),
}).strict();

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    // Economy config
    const { data: config } = await admin
      .from('guild_config')
      .select(ECONOMY_COLUMNS.join(', '))
      .eq('guild_id', ctx.guildId)
      .maybeSingle();

    // Summary stats — use RPC for efficient DB-side aggregation (no row limit)
    const { data: walletStats } = await admin.rpc('economy_wallet_stats', {
      p_guild_id: ctx.guildId,
    });

    const totalWallets = walletStats?.[0]?.total_wallets ?? walletStats?.total_wallets ?? 0;
    const totalCirculation = walletStats?.[0]?.total_circulation ?? walletStats?.total_circulation ?? 0;
    const totalBanked = walletStats?.[0]?.total_banked ?? walletStats?.total_banked ?? 0;

    const { count: shopItems } = await admin
      .from('economy_items')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .eq('active', true);

    // Role income rules
    const { data: roleIncomes } = await admin
      .from('economy_role_income')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('amount', { ascending: false })
      .limit(500);

    return NextResponse.json({
      success: true,
      data: {
        config: config ?? {},
        stats: {
          totalWallets: totalWallets ?? 0,
          totalCirculation,
          totalBanked,
          totalSupply: totalCirculation + totalBanked,
          shopItems: shopItems ?? 0,
        },
        roleIncomes: roleIncomes ?? [],
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    const message = err instanceof Error ? err.message : 'Failed to load economy config';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');

    const parsed = await parseBody(request, economyPatchSchema);
    if (!parsed.ok) return parsed.response;

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
    }

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('guild_config')
      .update(updates)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Notify bot to reload economy config
    await notifyBot('economy');

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    const message = err instanceof Error ? err.message : 'Failed to update economy config';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
