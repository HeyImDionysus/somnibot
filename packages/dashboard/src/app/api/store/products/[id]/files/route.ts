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
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

/** The owner-facing name of a product file, whichever column carries it. */
function fileLabel(row: Record<string, unknown> | null | undefined): string {
  const candidates = [row?.display_name, row?.name, row?.file_name];
  const named = candidates.find((v) => typeof v === 'string' && v.trim() !== '');
  return typeof named === 'string' ? named : 'unnamed file';
}

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
    return dbError(error, 'store/products/files');
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

  // V51: verify product belongs to this guild before adding files.
  // `name` is read here too so the recorded change can say WHICH product's
  // buyers just gained a download.
  const { data: product } = await supabase
    .from('products')
    .select('id, name, delivery_type')
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

  if (product.delivery_type !== 'license_key') {
    return NextResponse.json(
      {
        success: false,
        error: 'Static licensed products require an uploaded supported master so SomniBot can generate the buyer-specific derivative. Upload the file from the product file manager.',
      },
      { status: 409 },
    );
  }

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
    return dbError(error, 'store/products/files');
  }

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_file_added',
      targetType: 'product download',
      targetId: (data as { id?: string } | null)?.id ?? null,
      description:
        `Added the download "${name}" to the store product `
        + `"${(product as { name?: string }).name ?? productId}" — `
        + 'everyone who has bought it can download this file',
      after: data as Record<string, unknown> | null,
      blastRadius: 'medium',
      undoReason:
        'a newly added download cannot be removed by an undo — delete it from the '
        + "product's file list instead",
    },
    supabase,
  );

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

  // Verify ownership before deleting. The whole row is read (not just the
  // storage locator) because the delete below destroys it: what is captured
  // here is the only surviving description of what the customer lost.
  const { data: fileRecord } = await supabase
    .from('product_files')
    .select('*')
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
    return dbError(error, 'store/products/files');
  }

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_file_removed',
      targetType: 'product download',
      targetId: fileId,
      description:
        `Removed the download "${fileLabel(fileRecord as Record<string, unknown>)}" from a `
        + 'store product — customers who paid for it can no longer download this file',
      before: fileRecord as Record<string, unknown>,
      blastRadius: 'high',
      undoReason:
        'the download entry was permanently deleted — add the file again from the '
        + "product's file list to restore it",
    },
    supabase,
  );

  return NextResponse.json({ success: true });
}
