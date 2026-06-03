/**
 * /api/economy/farming — CRUD for farming crops.
 *
 * GET    — List all crops
 * POST   — Create a new crop
 * PUT    — Update an existing crop
 * DELETE — Delete a crop (by { id } in body)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, apiServerError} from '@/lib/api/response';

const cropSchema = z.object({
  name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  grow_seconds: z.number().int().min(60).max(604800).optional(),
  wilt_seconds: z.number().int().min(3600).max(604800).optional(),
  sell_price: z.number().int().min(0).max(1000000).optional(),
  seeds_returned: z.number().int().min(0).max(10).optional(),
  seed_item_id: z.string().uuid().nullable().optional(),
  category: z.string().min(1).max(32).optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_crops')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('sort_order')
      .order('name')
      .limit(500);

    if (error) {
      return dbError(error, 'economy/farming');
    }

    return NextResponse.json({ success: true, crops: data ?? [] });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/farming');
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, cropSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    const admin = createAdminSupabase();

    // Limit: max 30 crops per guild
    const { count } = await admin
      .from('economy_crops')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    if ((count ?? 0) >= 30) {
      return NextResponse.json({ success: false, error: 'Maximum 30 crops reached.' }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_crops')
      .insert({ ...parsed, guild_id: ctx.guildId })
      .select('*')
      .single();

    if (error) {
      return dbError(error, 'economy/farming');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/farming');
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const putSchema = z.object({ id: z.string().uuid() }).merge(cropSchema.partial());
    const result = await parseBody(request, putSchema);
    if (!result.ok) return result.response;
    const { id, ...parsed } = result.data;
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_crops')
      .update({ ...parsed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) {
      return dbError(error, 'economy/farming');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/farming');
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const deleteSchema = z.object({ id: z.string().uuid() });
    const result = await parseBody(request, deleteSchema);
    if (!result.ok) return result.response;
    const { id } = result.data;

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('economy_crops')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return dbError(error, 'economy/farming');
    }

    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/farming');
  }
}
