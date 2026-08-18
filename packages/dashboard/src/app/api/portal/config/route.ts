import { NextResponse } from 'next/server';

const APPLICATION_ID_PATTERN = /^\d{17,20}$/;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
} as const;

export async function GET() {
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim() ?? '';

  if (!APPLICATION_ID_PATTERN.test(applicationId)) {
    return NextResponse.json(
      { error: 'Customer portal sign-in is not configured.' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    {
      success: true,
      data: { discord_application_id: applicationId },
    },
    { headers: NO_STORE_HEADERS },
  );
}
