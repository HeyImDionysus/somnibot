import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { notifyBot } from '@/lib/notify-bot';

const slotSchema = z.enum(['logo', 'header', 'background']);
const assetConfig = {
  logo: { url: 'brand_logo_url', path: 'brand_logo_storage_path' },
  header: { url: 'brand_header_url', path: 'brand_header_storage_path' },
  background: { url: 'brand_background_url', path: 'brand_background_storage_path' },
} as const;
const acceptedTypes = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function isOwnedAssetPath(path: string, guildId: string, slot: z.infer<typeof slotSchema>): boolean {
  return path.startsWith(`${guildId}/${slot}/`);
}

function hasImageSignature(type: string, bytes: Uint8Array): boolean {
  if (type === 'image/png') return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (type === 'image/webp') return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  return false;
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const slotResult = slotSchema.safeParse(form.get('slot'));
  const file = form.get('file');
  if (!slotResult.success || !(file instanceof File)) {
    return NextResponse.json({ error: 'A valid brand asset slot and image file are required' }, { status: 400 });
  }
  const extension = acceptedTypes.get(file.type);
  if (!extension || file.size < 1 || file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'Brand images must be PNG, JPEG, WebP, or GIF files up to 5 MB' }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasImageSignature(file.type, bytes)) {
    return NextResponse.json({ error: 'The uploaded file content does not match its image type' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const slot = slotResult.data;
  const columns = assetConfig[slot];
  const { data: before, error: readError } = await admin
    .from('guild_config')
    .select('brand_logo_storage_path, brand_header_storage_path, brand_background_storage_path')
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (readError) return dbError(readError, 'branding/assets');
  const previousPath = slot === 'logo'
    ? before?.brand_logo_storage_path
    : slot === 'header'
      ? before?.brand_header_storage_path
      : before?.brand_background_storage_path;
  const path = `${auth.ctx.guildId}/${slot}/${randomUUID()}.${extension}`;
  const { error: uploadError } = await admin.storage.from('brand-assets').upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) return dbError(uploadError, 'branding/assets');
  const { data: publicUrl } = admin.storage.from('brand-assets').getPublicUrl(path);
  const updates = { [columns.url]: publicUrl.publicUrl, [columns.path]: path };
  const { error: updateError } = await admin
    .from('guild_config')
    .upsert({ guild_id: auth.ctx.guildId, ...updates }, { onConflict: 'guild_id' });
  if (updateError) {
    await admin.storage.from('brand-assets').remove([path]);
    return dbError(updateError, 'branding/assets');
  }
  if (
    typeof previousPath === 'string'
    && previousPath !== path
    && isOwnedAssetPath(previousPath, auth.ctx.guildId, slot)
  ) {
    const { error: cleanupError } = await admin.storage.from('brand-assets').remove([previousPath]);
    if (cleanupError) {
      console.error('[Branding] Previous asset cleanup failed after replacement:', cleanupError.message);
    }
  }
  await notifyBot(auth.ctx.guildId, 'branding', updates);
  return NextResponse.json({ success: true, slot, url: publicUrl.publicUrl });
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const slotResult = slotSchema.safeParse(new URL(request.url).searchParams.get('slot'));
  if (!slotResult.success) return NextResponse.json({ error: 'A valid brand asset slot is required' }, { status: 400 });

  const admin = createAdminSupabase();
  const columns = assetConfig[slotResult.data];
  const { data: before, error: readError } = await admin
    .from('guild_config')
    .select('brand_logo_storage_path, brand_header_storage_path, brand_background_storage_path')
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (readError) return dbError(readError, 'branding/assets');
  const { error: updateError } = await admin
    .from('guild_config')
    .upsert({ guild_id: auth.ctx.guildId, [columns.url]: null, [columns.path]: null }, { onConflict: 'guild_id' });
  if (updateError) return dbError(updateError, 'branding/assets');
  const storagePath = slotResult.data === 'logo'
    ? before?.brand_logo_storage_path
    : slotResult.data === 'header'
      ? before?.brand_header_storage_path
      : before?.brand_background_storage_path;
  if (
    typeof storagePath === 'string'
    && isOwnedAssetPath(storagePath, auth.ctx.guildId, slotResult.data)
  ) {
    const { error: removeError } = await admin.storage.from('brand-assets').remove([storagePath]);
    if (removeError) return dbError(removeError, 'branding/assets');
  }
  await notifyBot(auth.ctx.guildId, 'branding', { [columns.url]: null, [columns.path]: null });
  return NextResponse.json({ success: true, slot: slotResult.data });
}
