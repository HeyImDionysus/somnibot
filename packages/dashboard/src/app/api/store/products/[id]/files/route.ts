/**
 * /api/store/products/[id]/files — Product file management.
 *
 * GET: List files for a product
 * POST: Add a file to a product
 * DELETE: Remove a file
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: productId } = await params;
  const supabase = createAdminSupabase();

  // V51: scope by guild_id to prevent cross-guild file enumeration
  const { data, error } = await supabase
    .from('product_files')
    .select('*')
    .eq('product_id', productId)
    .eq('guild_id', guildId)
    .order('sort_order', { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: productId } = await params;
  const supabase = createAdminSupabase();

  // V51: verify product belongs to this guild before adding files
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!product) {
    return NextResponse.json(
      { success: false, error: 'Product not found' },
      { status: 404 },
    );
  }

  const parsed = await parseBody(req, schemas.productFile.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { name, description, file_path, external_url, file_size_bytes, mime_type, sort_order } = body;

  if (!name) {
    return NextResponse.json(
      { success: false, error: 'Missing required field: name' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('product_files')
    .insert({
      product_id: productId,
      guild_id: guildId,
      name,
      description: description ?? null,
      file_path: file_path ?? null,
      external_url: external_url ?? null,
      file_size_bytes: file_size_bytes ?? null,
      mime_type: mime_type ?? null,
      sort_order: sort_order ?? 0,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  await params; // consume to satisfy Next.js
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get('fileId');

  if (!fileId) {
    return NextResponse.json({ success: false, error: 'Missing fileId' }, { status: 400 });
  }

  // Verify ownership before deleting
  const { data: fileRecord } = await supabase
    .from('product_files')
    .select('id, guild_id, storage_path, storage_bucket')
    .eq('id', fileId)
    .eq('guild_id', guildId)
    .single();

  if (!fileRecord) {
    return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('product_files')
    .delete()
    .eq('id', fileId)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
