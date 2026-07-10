/**
 * POST   /api/economy/role-income — Create or update a role-income rule.
 * DELETE /api/economy/role-income — Remove a role-income rule.
 *
 * FAKE economy (virtual currency). NOT real money.
 *
 * COMPLIANCE WALL: role-income pays wagerable game currency for holding a role.
 * A role that is granted by any PAID product must never earn role-income, or a
 * real-money purchase could fund in-game gambling currency. This route rejects
 * such roles at config time (see commerce-income-wall.ts). The store product
 * routes enforce the same rule from the other side, and the bot's
 * collect-income guard is the defense-in-depth backstop.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody, schemas } from '@/lib/api/validation';
import { dbError, apiError, apiServerError } from '@/lib/api/response';
import { assertIncomeRoleNotCommerceGranted } from '@/lib/api/commerce-income-wall';

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');

    const parsed = await parseBody(request, schemas.economyRoleIncome.upsert);
    if (!parsed.ok) return parsed.response;
    const { role_id, amount, interval_minutes } = parsed.data;

    const admin = createAdminSupabase();

    // Compliance wall — reject configuring income on a paid product's role.
    const wall = await assertIncomeRoleNotCommerceGranted(admin, ctx.guildId, role_id);
    if (!wall.ok) {
      return apiError(wall.message, 409);
    }

    // One rule per (guild_id, role_id) — UNIQUE constraint backs the upsert.
    const { error } = await admin
      .from('economy_role_income')
      .upsert(
        { guild_id: ctx.guildId, role_id, amount, interval_minutes },
        { onConflict: 'guild_id,role_id' },
      );

    if (error) {
      return dbError(error, 'economy/role-income');
    }

    await notifyBot('economy');

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/role-income');
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');

    const parsed = await parseBody(request, schemas.economyRoleIncome.delete);
    if (!parsed.ok) return parsed.response;
    const { role_id } = parsed.data;

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('economy_role_income')
      .delete()
      .eq('guild_id', ctx.guildId)
      .eq('role_id', role_id);

    if (error) {
      return dbError(error, 'economy/role-income');
    }

    await notifyBot('economy');

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/role-income');
  }
}
