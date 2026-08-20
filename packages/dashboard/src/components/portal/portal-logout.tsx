/**
 * Portal Logout button — V11 Re-Audit UX-3.
 *
 * Clears the portal_token from localStorage and redirects to portal login.
 * Only renders when a token exists (i.e. user is logged in).
 */
'use client';

import { useEffect, useState } from 'react';
import {
  clearPortalToken,
  getPortalToken,
  PORTAL_TOKEN_CHANGED_EVENT,
  portalGuildId,
  suppressPortalAutoLogin,
} from '@/lib/portal-session-storage';

export function PortalLogout() {
  const [hasToken, setHasToken] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncToken = () => setHasToken(Boolean(getPortalToken()));
    syncToken();
    window.addEventListener(PORTAL_TOKEN_CHANGED_EVENT, syncToken);
    window.addEventListener('storage', syncToken);
    return () => {
      window.removeEventListener(PORTAL_TOKEN_CHANGED_EVENT, syncToken);
      window.removeEventListener('storage', syncToken);
    };
  }, []);

  if (!hasToken) return null;

  async function handleLogout() {
    const guildId = portalGuildId();
    const token = getPortalToken(guildId);
    if (!token || signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      const response = await fetch('/api/portal/auth', {
        method: 'DELETE',
        headers: { 'x-portal-token': token },
      });
      if (!response.ok && response.status !== 401) {
        setError('Sign out could not be completed. Please try again.');
        return;
      }
    } catch {
      setError('Sign out could not be completed. Please try again.');
      return;
    } finally {
      setSigningOut(false);
    }
    clearPortalToken(guildId);
    suppressPortalAutoLogin(guildId);
    window.location.href = guildId ? `/portal?guild=${encodeURIComponent(guildId)}` : '/portal';
  }

  return (
    <div className="ml-2 flex flex-col items-end">
      <button
        onClick={() => void handleLogout()}
        disabled={signingOut}
        className="rounded-md px-3 py-1.5 text-sm text-discord-text-muted hover:text-discord-danger hover:bg-discord-danger/10 transition-colors disabled:cursor-wait disabled:opacity-60"
      >
        {signingOut ? 'Signing Out…' : 'Sign Out'}
      </button>
      {error && <span role="alert" className="mt-1 max-w-52 text-right text-xs text-discord-danger">{error}</span>}
    </div>
  );
}
