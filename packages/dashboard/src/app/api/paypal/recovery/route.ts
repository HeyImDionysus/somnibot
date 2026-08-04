import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { executeProviderMoneyRecovery, sweepProviderMoneyRecovery } from '../webhook/handlers';

/** Cron/operator recovery consumer for captures that could not be safely fulfilled. */
export async function POST(req: NextRequest) {
  const expected = process.env.PAYPAL_RECONCILE_SECRET?.trim();
  if (!expected || req.headers.get('x-paypal-reconcile-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => null) as { webhook_event_id?: unknown } | null;
  if (!body || typeof body.webhook_event_id !== 'string' || body.webhook_event_id.trim() === '') {
    return NextResponse.json({ error: 'webhook_event_id is required' }, { status: 400 });
  }
  try {
    const result = await executeProviderMoneyRecovery(createAdminSupabase(), body.webhook_event_id);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  const expected = process.env.PAYPAL_RECONCILE_SECRET?.trim();
  if (!expected || req.headers.get('x-paypal-reconcile-secret') !== expected) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  let results;
  try {
    results = await sweepProviderMoneyRecovery(supabase, 20);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
  return NextResponse.json({ success: true, results });
}
