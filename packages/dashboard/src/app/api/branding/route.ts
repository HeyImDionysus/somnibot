/**
 * GET /api/branding — Read the guild's white-label brand kit columns
 * PUT /api/branding — Update brand kit columns (bot hot-reloads via notifyBot)
 *
 * The brand kit drives every member-facing bot surface (store header, ticket
 * embeds, game/economy embeds): brand name, primary/accent colors, voice
 * preset, and the powered-by attribution toggle.
 *
 * OWNER-ONLY (requireGuildOwner, matching the sibling settings routes):
 * store_brand_name feeds the PayPal checkout brand_name, so a delegated
 * dashboard role must never be able to rebrand the payment surface.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { recordGuildConfigChange } from '@/lib/admin-changes';

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
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  const { data: config, error } = await admin
    .from('guild_config')
    .select(BRANDING_COLUMNS.join(', '))
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return dbError(error, 'branding');
  }

  return NextResponse.json({ success: true, data: config ?? {} });
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, brandingUpdate);
  if (!parsed.ok) return parsed.response;

  const updates: Record<string, unknown> = { ...parsed.data };
  // A blank brand name means "fall back to the guild name" — store NULL, not ''.
  if (updates.store_brand_name === '') updates.store_brand_name = null;

  const admin = createAdminSupabase();

  // Read the changed keys' prior values BEFORE the write so the bot can fill
  // the config.updated audit row's before_state. The keys come from the
  // .strict() schema above, so they are known guild_config column names.
  // Best-effort: a failed/missing read never blocks the save (the bot falls
  // back to its own last-known snapshot).
  const { data: prior } = await admin
    .from('guild_config')
    .select(Object.keys(updates).join(', '))
    .eq('guild_id', guildId)
    .maybeSingle();
  const before = (prior as Record<string, unknown> | null) ?? undefined;

  // Upsert, not update: a pre-init guild has no guild_config row yet, and a
  // 0-row update would report success while persisting nothing (guild_id is
  // the table's PRIMARY KEY — same pattern as the sibling settings routes).
  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) {
    return dbError(error, 'branding');
  }

  // Notify bot to invalidate its brand kit cache, carrying the changed keys
  // and their prior values so the config.updated audit row isn't empty.
  await notifyBot(guildId, 'branding', updates, 'dashboard', undefined, before);

  // Make the change visible (and undoable) on the Admin Changes page. The
  // brand drives every member-facing surface, so this is a medium blast radius.
  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'branding.updated',
    area: 'branding',
    updates,
    before,
    blastRadius: 'medium',
  }, admin);

  return NextResponse.json({ success: true });
}
