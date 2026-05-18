/**
 * Customer Portal — Dashboard overview.
 * Shows quick stats: active licenses, recent orders, available downloads.
 */
'use client';

import { useEffect, useState } from 'react';

interface PortalData {
  licenses: number;
  activeSessions: number;
  recentOrders: number;
  downloads: number;
}

export default function PortalDashboard() {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const token = localStorage.getItem('portal_token');
      if (!token) {
        setError('not_authenticated');
        setLoading(false);
        return;
      }

      const headers = { 'x-portal-token': token };

      try {
        const [licensesRes, ordersRes, downloadsRes] = await Promise.all([
          fetch('/api/portal/licenses', { headers }),
          fetch('/api/portal/orders', { headers }),
          fetch('/api/portal/downloads', { headers }),
        ]);

        if (licensesRes.status === 401 || ordersRes.status === 401) {
          setError('not_authenticated');
          localStorage.removeItem('portal_token');
          return;
        }

        const [licensesJson, ordersJson, downloadsJson] = await Promise.all([
          licensesRes.json(),
          ordersRes.json(),
          downloadsRes.json(),
        ]);

        const licenses = licensesJson.data || [];
        const orders = ordersJson.data || [];
        const downloads = downloadsJson.data || [];

        setData({
          licenses: licenses.length,
          activeSessions: licenses.reduce(
            (sum: number, l: { license_sessions?: { active: boolean }[] }) =>
              sum + (l.license_sessions?.filter((s: { active: boolean }) => s.active).length || 0),
            0,
          ),
          recentOrders: orders.length,
          downloads: downloads.length,
        });
      } catch {
        setError('Failed to load portal data');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (error === 'not_authenticated') {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-6xl mb-4">🔐</div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Customer Portal</h1>
        <p className="mt-2 text-discord-text-muted max-w-md">
          Sign in with your Discord account to view your licenses, downloads, and order history.
        </p>
        <button
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-[#5865F2] px-6 py-3 text-sm font-medium text-white hover:bg-[#4752C4] transition-colors"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
          </svg>
          Sign in with Discord
        </button>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Welcome back</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Here&apos;s an overview of your account.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <a href="/portal/licenses" className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 hover:border-[#FF1493]/50 transition-colors">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">License Keys</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{data.licenses}</p>
          <p className="mt-1 text-xs text-discord-success">{data.activeSessions} active sessions</p>
        </a>
        <a href="/portal/downloads" className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 hover:border-[#FF1493]/50 transition-colors">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Downloads</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{data.downloads}</p>
          <p className="mt-1 text-xs text-discord-text-muted">Available products</p>
        </a>
        <a href="/portal/orders" className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 hover:border-[#FF1493]/50 transition-colors">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Orders</p>
          <p className="mt-1 text-2xl font-bold text-discord-text-primary">{data.recentOrders}</p>
          <p className="mt-1 text-xs text-discord-text-muted">All time</p>
        </a>
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
          <p className="text-xs text-discord-text-muted uppercase tracking-wide">Support</p>
          <p className="mt-2 text-sm text-discord-text-secondary">Need help? Open a ticket in Discord.</p>
        </div>
      </div>
    </div>
  );
}
