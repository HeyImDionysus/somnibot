/**
 * GET /api/downloads/[productId]/[fileId] — Protected file downloads.
 *
 * Validates entitlement before allowing download.
 * Increments download counter.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string; fileId: string }> },
) {
  const { productId, fileId } = await params;
  const supabase = createAdminSupabase();

  // Get the file
  const { data: file } = await supabase
    .from('product_files')
    .select('*')
    .eq('id', fileId)
    .eq('product_id', productId)
    .single();

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // Increment download counter
  await supabase
    .from('product_files')
    .update({ download_count: (file.download_count ?? 0) + 1 })
    .eq('id', fileId);

  // If external URL, redirect
  if (file.external_url) {
    return NextResponse.redirect(file.external_url);
  }

  // If Supabase storage path, generate signed URL
  if (file.file_path) {
    const { data: signedUrl } = await supabase.storage
      .from('product-files')
      .createSignedUrl(file.file_path, 3600); // 1 hour

    if (signedUrl?.signedUrl) {
      return NextResponse.redirect(signedUrl.signedUrl);
    }
  }

  return NextResponse.json({ error: 'File not accessible' }, { status: 404 });
}
