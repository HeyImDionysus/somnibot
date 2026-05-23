/**
 * /api/store/files — Product file upload and management.
 *
 * POST: Upload a file to Supabase Storage and link to product
 * GET: List files for a product
 * DELETE: Remove a file from storage and database
 *
 * Audit V2 Finding 3.4 — Added Zod validation on POST FormData fields
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { randomBytes } from 'crypto';
import { z } from 'zod';
const STORAGE_BUCKET = 'product-files';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const productId = searchParams.get('product_id');

  if (!productId) {
    return NextResponse.json(
      { success: false, error: 'Missing product_id' },
      { status: 400 },
    );
  }

  // V51: scope by guild_id to prevent cross-guild file enumeration
  const { data, error } = await supabase
    .from('product_files')
    .select('*')
    .eq('product_id', productId)
    .eq('guild_id', guildId)
    .order('sort_order', { ascending: true });
    .limit(500)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Ensure storage bucket exists
  const { error: bucketError } = await supabase.storage.getBucket(STORAGE_BUCKET);
  if (bucketError) {
    await supabase.storage.createBucket(STORAGE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_FILE_SIZE,
      allowedMimeTypes: undefined, // Allow all file types
    });
  }

  const formData = await req.formData();
  const file = formData.get('file') as File | null;

  // Validate text fields with Zod
  const fileUploadSchema = z.object({
    product_id: z.string().uuid(),
    display_name: z.string().max(255).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    version: z.string().max(50).regex(/^[\d]+\.[\d]+\.[\d]+.*$/, 'Must be a semver string (e.g. 1.0.0)').optional().nullable(),
  });

  const fieldResult = fileUploadSchema.safeParse({
    product_id: formData.get('product_id'),
    display_name: formData.get('display_name'),
    description: formData.get('description'),
    version: formData.get('version'),
  });

  if (!file || !fieldResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: !file
          ? 'Missing file'
          : 'Validation failed',
        details: !file
          ? undefined
          : fieldResult.error?.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
      },
      { status: 400 },
    );
  }

  const { product_id: productId, display_name: displayName, description, version } = fieldResult.data;

  // Verify product exists and belongs to this guild
  const { data: product } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('guild_id', guildId)
    .single();

  if (!product) {
    return NextResponse.json(
      { success: false, error: 'Product not found' },
      { status: 404 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { success: false, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` },
      { status: 413 },
    );
  }

  // Generate unique storage path
  const fileId = randomBytes(8).toString('hex');
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${guildId}/${productId}/${fileId}/${safeFileName}`;

  // Upload to Supabase Storage
  const arrayBuffer = await file.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, arrayBuffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json(
      { success: false, error: `Upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // Get existing file count for sort_order
  const { count } = await supabase
    .from('product_files')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId);

  // Create database record
  const { data: fileRecord, error: dbError } = await supabase
    .from('product_files')
    .insert({
      product_id: productId,
      guild_id: guildId,
      file_name: file.name,
      display_name: displayName ?? file.name,
      description: description ?? null,
      version: version ?? '1.0.0',
      storage_path: storagePath,
      storage_bucket: STORAGE_BUCKET,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      sort_order: (count ?? 0),
    })
    .select()
    .single();

  if (dbError) {
    // Clean up uploaded file on DB failure
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    return NextResponse.json(
      { success: false, error: `Database error: ${dbError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, data: fileRecord });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get('id');

  if (!fileId) {
    return NextResponse.json(
      { success: false, error: 'Missing file id' },
      { status: 400 },
    );
  }

  // Fetch file record
  const { data: fileRecord } = await supabase
    .from('product_files')
    .select('*')
    .eq('id', fileId)
    .eq('guild_id', guildId)
    .single();

  if (!fileRecord) {
    return NextResponse.json(
      { success: false, error: 'File not found' },
      { status: 404 },
    );
  }

  // Remove from storage
  if (fileRecord.storage_path) {
    await supabase.storage
      .from(fileRecord.storage_bucket ?? STORAGE_BUCKET)
      .remove([fileRecord.storage_path]);
  }

  // Delete database record
  const { error } = await supabase
    .from('product_files')
    .delete()
    .eq('id', fileId);

  if (error) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
