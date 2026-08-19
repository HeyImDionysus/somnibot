import { NextResponse } from 'next/server';
import { getDiscordRuntimeConfig } from '@/lib/discord-runtime-config';

const APPLICATION_ID_PATTERN = /^\d{17,20}$/;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
} as const;

export async function GET() {
  let applicationId = '';
  try {
    ({ applicationId } = await getDiscordRuntimeConfig());
  } catch {
    return NextResponse.json(
      { error: 'Customer portal sign-in is temporarily unavailable.' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

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
