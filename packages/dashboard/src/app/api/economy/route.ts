/**
 * GET  /api/economy — Economy config + wallet stats
 * PATCH /api/economy — Update economy guild_config columns
 *
 * This is for the FAKE economy (virtual currency). NOT real money.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

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
  economy_passive_mode_allowed: z.boolean().optional(),
  economy_pay_tax_pct: z.number().int().min(0).max(50).optional(),
  economy_max_wallet: z.number().int().min(0).optional(),
  economy_max_bank: z.number().int().min(0).optional(),
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
      .order('amount', { ascending: false });

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
    const message = err instanceof Error ? err.message : 'Failed to load economy config';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = economyPatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation failed',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

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
    const message = err instanceof Error ? err.message : 'Failed to update economy config';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
