/**
 * /api/customers/[id] — Customer detail.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id } = await params;
  const supabase = createAdminSupabase();

  // V47-C2: prevent reading customers from other guilds by UUID guess.
  const { data: customer, error } = await supabase
    .from('customers')
    .select('*, orders(*, products(name)), entitlements(*, products(name))')
    .eq('id', id)
    .eq('guild_id', guildId)
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  if (!customer) {
    return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: customer });
}
