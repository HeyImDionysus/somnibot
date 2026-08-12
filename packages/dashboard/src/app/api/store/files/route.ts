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
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';
import {
  isSupportedStaticFile,
  MAX_STATIC_SOURCE_BYTES,
} from '@/lib/store/static-delivery';
import { STATIC_FORMAT_SUMMARY } from '@/lib/store/static-format-contract';

/** The owner-facing name of a product file, whichever column carries it. */
function fileLabel(row: Record<string, unknown> | null | undefined): string {
  const candidates = [row?.display_name, row?.name, row?.file_name];
  const named = candidates.find((v) => typeof v === 'string' && v.trim() !== '');
  return typeof named === 'string' ? named : 'unnamed file';
}

const STORAGE_BUCKET = 'product-files';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * V5 Audit P3-4: Block executable MIME types to prevent the store
 * from being used to distribute malware. Guild owners can still
 * upload archives (.zip, .tar.gz, .rar) which is the normal delivery
 * format for software products.
 */
const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',      // .exe
  'application/x-msdos-program',   // .exe / .com
  'application/x-dosexec',         // .exe
  'application/x-msi',             // .msi
  'application/x-bat',             // .bat
  'application/x-sh',              // .sh
  'application/x-csh',             // .csh
  'application/vnd.microsoft.portable-executable', // PE
]);

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif', '.vbs',
  '.wsf', '.ps1', '.reg',
]);

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
    .order('sort_order', { ascending: true })
    .limit(500);

  if (error) {
    return dbError(error, 'store/files');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const formData = await req.formData();
  const file = formData.get('file') as File | null;

  // V5 Audit P3-4: Block executable file types at route level
  if (file) {
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
    if (BLOCKED_MIME_TYPES.has(file.type) || BLOCKED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { success: false, error: `File type not allowed: ${ext || file.type}. Executables cannot be uploaded — use an archive (.zip) instead.` },
        { status: 400 },
      );
    }
  }

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
    .select('id, name, delivery_type')
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

  if (product.delivery_type !== 'license_key') {
    if (!isSupportedStaticFile(file.type, file.name)) {
      return NextResponse.json(
        {
          success: false,
          error: `This file format has no verified Static buyer-derivative transformer. Current transformers: ${STATIC_FORMAT_SUMMARY}. Add and attack-test a transformer for this format, or use Dynamic licensing.`,
        },
        { status: 400 },
      );
    }
    if (file.size > MAX_STATIC_SOURCE_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `Static masters are limited to ${MAX_STATIC_SOURCE_BYTES / 1024 / 1024}MB so buyer-specific delivery can fail closed safely.`,
        },
        { status: 413 },
      );
    }
  }

  const { error: bucketError } = await supabase.storage.getBucket(STORAGE_BUCKET);
  if (bucketError) {
    await supabase.storage.createBucket(STORAGE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_FILE_SIZE,
      allowedMimeTypes: undefined,
    });
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
    console.error('[Store/Files] Upload failed:', uploadError.message);
    return NextResponse.json(
      { success: false, error: 'File upload failed. Please try again.' },
      { status: 500 },
    );
  }

  // Get existing file count for sort_order
  const { count } = await supabase
    .from('product_files')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId);

  // Create database record
  const { data: fileRecord, error: insertError } = await supabase
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

  if (insertError) {
    // Clean up uploaded file on DB failure
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    return dbError(insertError, 'store/files');
  }

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_file_uploaded',
      targetType: 'product download',
      targetId: (fileRecord as { id?: string } | null)?.id ?? null,
      description:
        `Uploaded "${displayName ?? file.name}" (version ${version ?? '1.0.0'}) to the `
        + `store product "${product.name}" — everyone who has bought it can download it`,
      after: fileRecord as Record<string, unknown> | null,
      blastRadius: 'medium',
      undoReason:
        'a newly uploaded file cannot be removed by an undo — delete it from the '
        + "product's file list instead",
    },
    supabase,
  );

  return NextResponse.json({ success: true, data: fileRecord });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

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
    return dbError(error, 'store/files');
  }

  // `fileRecord` was read (whole row) before both deletions, so the change
  // history still describes exactly what was removed.
  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'store.product_file_deleted',
      targetType: 'product download',
      targetId: fileId,
      description:
        `Deleted "${fileLabel(fileRecord as Record<string, unknown>)}" from a store `
        + 'product — the stored file itself was erased, so customers who paid for it '
        + 'can no longer download it',
      before: fileRecord as Record<string, unknown>,
      blastRadius: 'high',
      undoReason:
        'the file was erased from storage as well as the catalogue, so nothing remains '
        + 'to restore — upload the file again',
    },
    supabase,
  );

  return NextResponse.json({ success: true });
}
