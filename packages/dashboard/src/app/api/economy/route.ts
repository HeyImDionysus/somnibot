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

    // Summary stats
    const { count: totalWallets } = await admin
      .from('economy_wallets')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    const { data: econStats } = await admin
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', ctx.guildId)
      .limit(10000);

    let totalCirculation = 0;
    let totalBanked = 0;
    for (const w of econStats ?? []) {
      totalCirculation += w.wallet ?? 0;
      totalBanked += w.bank ?? 0;
    }

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
    const body = await request.json();
    const admin = createAdminSupabase();

    // Only allow known economy columns
    const updates: Record<string, unknown> = {};
    for (const col of ECONOMY_COLUMNS) {
      if (col in body) {
        updates[col] = body[col];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
    }

    const { error } = await admin
      .from('guild_config')
      .update(updates)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Notify bot to reload economy config
    await notifyBot(ctx.guildId, 'economy', ctx.userId);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update economy config';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
