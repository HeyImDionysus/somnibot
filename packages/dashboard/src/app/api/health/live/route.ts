import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Process liveness for supervision. Aggregate production readiness is /api/health. */
export async function GET() {
  return NextResponse.json({ status: 'alive', timestamp: new Date().toISOString() });
}
