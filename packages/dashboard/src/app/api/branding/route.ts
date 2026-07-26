/**
 * GET /api/branding — Read the guild's white-label brand kit columns
 * PUT /api/branding — Update brand kit columns (bot hot-reloads via notifyBot)
 *
 * The brand kit drives every member-facing bot surface (store header, ticket
 * embeds, game/economy embeds): brand name, primary/accent colors, voice
 * preset, and the powered-by attribution toggle.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, apiServerError } from '@/lib/api/response';

const BRANDING_COLUMNS = [
  'store_brand_name',
  'store_show_powered_by',
  'brand_primary_color',
  'brand_accent_color',
  'brand_voice_preset',
] as const;

/**
 * Zod schema for PUT validation — MUST mirror the guild_config CHECK
 * constraints exactly (migrations 20260723120200 + 20260724160000), or a
 * passing payload dies later as a raw 23514 CHECK violation:
 *   - colors: integer BETWEEN 0 AND 16777215, or NULL (→ SomniBot palette)
 *   - voice preset: default | professional | friendly | playful (NOT NULL)
 *   - store_brand_name: nullable text (64-char dashboard ceiling)
 *   - store_show_powered_by: boolean NOT NULL
 */
const brandingUpdate = z.object({
  store_brand_name: z.string().trim().max(64).nullable().optional(),
  store_show_powered_by: z.boolean().optional(),
  brand_primary_color: z.number().int().min(0).max(16777215).nullable().optional(),
  brand_accent_color: z.number().int().min(0).max(16777215).nullable().optional(),
  brand_voice_preset: z.enum(['default', 'professional', 'friendly', 'playful']).optional(),
}).strict().refine((obj) => Object.keys(obj).length > 0, 'At least one field required');

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_server');
    const admin = createAdminSupabase();

    const { data: config, error } = await admin
      .from('guild_config')
      .select(BRANDING_COLUMNS.join(', '))
      .eq('guild_id', ctx.guildId)
      .maybeSingle();

    if (error) {
      return dbError(error, 'branding');
    }

    return NextResponse.json({ success: true, data: config ?? {} });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'branding');
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_server');

    const parsed = await parseBody(request, brandingUpdate);
    if (!parsed.ok) return parsed.response;

    const updates: Record<string, unknown> = { ...parsed.data };
    // A blank brand name means "fall back to the guild name" — store NULL, not ''.
    if (updates.store_brand_name === '') updates.store_brand_name = null;

    const admin = createAdminSupabase();

    const { error } = await admin
      .from('guild_config')
      .update(updates)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return dbError(error, 'branding');
    }

    // Notify bot to invalidate its brand kit cache
    await notifyBot('branding');

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'branding');
  }
}
