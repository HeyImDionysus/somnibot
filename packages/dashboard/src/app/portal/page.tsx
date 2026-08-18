/**
 * Customer Portal — Dashboard overview.
 * Shows quick stats: active licenses, recent orders, available downloads.
 */
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/shared/button';

interface PortalData {
  licenses: number;
  activeSessions: number;
  recentOrders: number;
  downloads: number;
}

/**
 * Build the Discord OAuth2 authorize URL for portal login.
 * Scopes: 'identify' only — we just need the user's Discord ID.
 *
 * FIX #2: Generate a random `state` parameter to prevent Login CSRF
 * (session-swapping attacks). State is stored in sessionStorage and
 * verified on callback.
 */
/**
 * The target guild whose store this portal is for. It arrives in the URL
 * (`/portal?guild=<id>`) and is persisted so it survives the OAuth round-trip and
 * the post-login URL cleanup. The portal MUST be per-guild: a Discord identity can
 * be a customer in many guilds, so the session is scoped to exactly one.
 */
function currentGuildId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('guild');
  if (fromUrl) {
    sessionStorage.setItem('portal_guild', fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem('portal_guild') || '';
}

function getDiscordOAuthUrl(clientId: string): string {
  const redirectUri = encodeURIComponent(`${window.location.origin}/portal`);
  // CSRF nonce + the target guild, both echoed back by Discord in `state` so the
  // guild survives the round-trip (query params are dropped on the redirect).
  const nonce = crypto.randomUUID();
  const state = `${nonce}.${currentGuildId()}`;
  sessionStorage.setItem('portal_oauth_state', state);
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=identify&state=${encodeURIComponent(state)}`;
}

export default function PortalDashboard() {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discordApplicationId, setDiscordApplicationId] = useState<string | null>(null);
  const [loginConfigError, setLoginConfigError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadLoginConfig() {
      try {
        const response = await fetch('/api/portal/config', { cache: 'no-store' });
        if (!response.ok) {
          if (active) {
            setLoginConfigError('Customer portal sign-in is not configured for this installation.');
          }
          return;
        }
        const body: unknown = await response.json();
        const applicationId = typeof body === 'object'
          && body !== null
          && 'data' in body
          && typeof body.data === 'object'
          && body.data !== null
          && 'discord_application_id' in body.data
          && typeof body.data.discord_application_id === 'string'
          ? body.data.discord_application_id
          : null;

        if (!active) return;
        if (applicationId) {
          setDiscordApplicationId(applicationId);
          setLoginConfigError(null);
        } else {
          setLoginConfigError('Customer portal sign-in is not configured for this installation.');
        }
      } catch {
        if (active) {
          setLoginConfigError('Customer portal sign-in configuration could not be loaded.');
        }
      }
    }

    void loadLoginConfig();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    async function load() {
      // Check for OAuth callback code in URL
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');

      if (code) {
        // FIX #2: Verify OAuth state parameter to prevent CSRF
        const returnedState = params.get('state');
        const storedState = sessionStorage.getItem('portal_oauth_state');
        sessionStorage.removeItem('portal_oauth_state');

        if (!returnedState || !storedState || returnedState !== storedState) {
          setError('Login failed: invalid state. Please try again.');
          setLoading(false);
          return;
        }

        // The target guild rides along in `state` as `<nonce>.<guildId>`.
        const guildId = returnedState.split('.').slice(1).join('.');
        if (!guildId) {
          setError("This portal link is missing its server. Please use your server's portal link (it looks like /portal?guild=…).");
          setLoading(false);
          return;
        }

        // Exchange the code for a portal session, scoped to this guild's store.
        try {
          const res = await fetch('/api/portal/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'login',
              code,
              guild_id: guildId,
              redirect_uri: `${window.location.origin}/portal`,
            }),
          });

          const json = await res.json();
          if (json.success && json.data?.token) {
            localStorage.setItem('portal_token', json.data.token);
            // Clean the URL (remove ?code=…)
            window.history.replaceState({}, '', '/portal');
          } else {
            setError(json.error || 'Login failed');
            setLoading(false);
            return;
          }
        } catch {
          setError('Login failed. Please try again.');
          setLoading(false);
          return;
        }
      }

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

        // V11 Re-Audit UX-2: Include downloadsRes in 401 check for consistency.
        if (licensesRes.status === 401 || ordersRes.status === 401 || downloadsRes.status === 401) {
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

  function startDiscordLogin() {
    if (!discordApplicationId) return;
    if (!currentGuildId()) {
      setError("This portal link is missing its server. Please use your server's portal link (it looks like /portal?guild=…).");
      return;
    }
    window.location.assign(getDiscordOAuthUrl(discordApplicationId));
  }

  const loginButton = (
    <Button
      type="button"
      onClick={startDiscordLogin}
      disabled={!discordApplicationId}
      size="lg"
      className="mt-6"
    >
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
      </svg>
      {discordApplicationId ? 'Sign in with Discord' : 'Preparing Discord sign-in…'}
    </Button>
  );

  if (error === 'not_authenticated') {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-6xl mb-4">🔐</div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Customer Portal</h1>
        <p className="mt-2 text-discord-text-muted max-w-md">
          Sign in with your Discord account to view your licenses, downloads, and order history.
        </p>
        {loginButton}
        {loginConfigError && (
          <p role="alert" className="mt-3 max-w-md text-sm text-discord-danger">
            {loginConfigError}
          </p>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-xl font-bold text-discord-text-primary">Login Error</h1>
        <p className="mt-2 text-discord-text-muted max-w-md">{error}</p>
        {loginButton}
        {loginConfigError && (
          <p role="alert" className="mt-3 max-w-md text-sm text-discord-danger">
            {loginConfigError}
          </p>
        )}
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
