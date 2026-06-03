/**
 * Portal Logout button — V11 Re-Audit UX-3.
 *
 * Clears the portal_token from localStorage and redirects to portal login.
 * Only renders when a token exists (i.e. user is logged in).
 */
'use client';

import { useEffect, useState } from 'react';

export function PortalLogout() {
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(!!localStorage.getItem('portal_token'));
  }, []);

  if (!hasToken) return null;

  function handleLogout() {
    localStorage.removeItem('portal_token');
    window.location.href = '/portal';
  }

  return (
    <button
      onClick={handleLogout}
      className="ml-2 rounded-md px-3 py-1.5 text-sm text-discord-text-muted hover:text-discord-danger hover:bg-discord-danger/10 transition-colors"
    >
      Sign Out
    </button>
  );
}
