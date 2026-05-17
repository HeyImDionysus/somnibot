/**
 * DELETE /api/license/sessions/[id] — Remotely revoke a device session (admin).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  const supabase = createAdminSupabase();

  const { error } = await supabase
    .from('license_sessions')
    .update({
      active: false,
      deactivated_at: new Date().toISOString(),
      deactivation_reason: 'admin_revoked',
    })
    .eq('id', sessionId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
