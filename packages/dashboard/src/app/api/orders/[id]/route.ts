/**
 * /api/orders/[id] — Order details.
 *
 * GET: Fetch a single order with related data
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

  const { data: order, error } = await supabase
    .from('orders')
    .select(
      '*, customers(discord_id, discord_username, email), products(name, type, delivery_type), license_keys(*), entitlements(*), payments(*)',
    )
    .eq('id', id)
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  if (!order) {
    return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: order });
}
