import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  useState: vi.fn(),
  useEffect: vi.fn(),
  useAutoRefresh: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: mocks.useState,
    useEffect: mocks.useEffect,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  };
});

vi.mock('@/hooks/use-realtime-events', () => ({ useAutoRefresh: mocks.useAutoRefresh }));
vi.mock('@/components/layout/pending-team-invitations', () => ({ PendingTeamInvitations: () => null }));
vi.mock('@/components/dashboard/dashboard-control-center', () => ({ DashboardControlCenter: () => null }));

import DashboardPage from '@/app/(dashboard)/dashboard/page';

describe('dashboard bot status', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    mocks.useState.mockReset();
    mocks.useEffect.mockReset();
    mocks.useAutoRefresh.mockReset();
  });

  it('does not render a gateway ping when diagnostics marks health metrics stale', () => {
    const guild = {
      guild: {
        id: 'guild-1',
        name: 'Example Guild',
        bot_joined_at: '2026-08-10T11:00:00.000Z',
        setup_completed: true,
        setup_confirmed_at: '2026-08-10T11:01:00.000Z',
        bot_role_position: 4,
      },
      config: null,
      totalRoles: 5,
    };
    const stats = {
      botOnline: true,
      memberCount: 1,
      trackedMembers: 1,
      activeTickets: 0,
      openInfractions: 0,
      revenueThisMonth: 0,
      activeGiveaways: 0,
      eventsToday: 0,
      uptime: null,
      uptimeSeconds: 0,
      wsPing: 50,
      activeVoice: 0,
      valkeyConnected: true,
      memoryMb: null,
      lastSnapshot: null,
      recentEvents: [],
    };
    const diagnostics = {
      success: true,
      data: {
        bot: {
          online: true,
          onlineSourceAt: '2026-08-10T11:59:45.000Z',
          onlineSourceAgeSecs: 15,
          metricsAvailable: true,
          metricsStale: true,
          metricsSnapshotAt: '2026-08-10T11:50:00.000Z',
          metricsAgeSecs: 600,
        },
      },
    };
    mocks.useState
      .mockReturnValueOnce([guild, vi.fn()])
      .mockReturnValueOnce([stats, vi.fn()])
      .mockReturnValueOnce([diagnostics, vi.fn()])
      .mockReturnValueOnce([false, vi.fn()])
      .mockReturnValueOnce([null, vi.fn()]);

    const markup = renderToStaticMarkup(React.createElement(DashboardPage));

    expect(markup).toContain('Online');
    expect(markup).not.toContain('50ms');
  });
});
