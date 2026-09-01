import { NextResponse, type NextRequest } from 'next/server';

const LAUNCHER_HANDOFF = {
  authority: 'launcher',
  dashboardSetup: 'handoff-only',
  mutationAllowed: false,
  setupPath: '/setup',
  message: 'Installation setup is managed in the SomniBot Launcher.',
} as const;

export function GET(): NextResponse {
  return NextResponse.json(LAUNCHER_HANDOFF, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

function rejectSetupMutation(request: NextRequest): NextResponse {
  void request;
  return NextResponse.json(
    {
      ...LAUNCHER_HANDOFF,
      error: 'Dashboard setup mutations are disabled. Continue in the SomniBot Launcher.',
    },
    {
      status: 405,
      headers: {
        Allow: 'GET',
        'Cache-Control': 'no-store',
      },
    },
  );
}

export const POST = rejectSetupMutation;
export const PUT = rejectSetupMutation;
export const PATCH = rejectSetupMutation;
export const DELETE = rejectSetupMutation;
