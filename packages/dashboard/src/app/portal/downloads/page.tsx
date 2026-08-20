/**
 * Customer Portal — Product downloads.
 */
'use client';

import { useEffect, useState } from 'react';
import { clearPortalToken, getPortalToken, portalLoginUrl } from '@/lib/portal-session-storage';

interface Download {
  entitlement_id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  description: string | null;
  files: Array<{ name: string; url: string; size?: number }>;
  entitled_since: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PortalDownloads() {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const token = getPortalToken();
      // V11 Re-Audit UX-1: Redirect to portal login if no token.
      if (!token) {
        window.location.href = portalLoginUrl();
        return;
      }
      try {
        const res = await fetch('/api/portal/downloads', { headers: { 'x-portal-token': token } });
        if (res.status === 401) {
          clearPortalToken();
          window.location.href = portalLoginUrl();
          return;
        }
        const json = await res.json();
        if (json.success) setDownloads(json.data);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-discord-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Your Downloads</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Download files for products you own.</p>
      </div>

      {downloads.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-discord-text-muted">No downloads available. Purchases with downloadable files will appear here.</p>
        </div>
      ) : (
        downloads.map((dl) => (
          <div key={dl.entitlement_id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-discord-text-primary">{dl.product_name}</p>
                {dl.description && (
                  <p className="mt-0.5 text-xs text-discord-text-muted">{dl.description}</p>
                )}
                <p className="mt-0.5 text-xs text-discord-text-muted">
                  Owned since {formatDate(dl.entitled_since)}
                </p>
              </div>
              <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-[10px] text-discord-text-muted">
                {dl.product_type}
              </span>
            </div>

            {dl.files.length > 0 ? (
              <div className="mt-3 space-y-1">
                {dl.files.map((file, i) => (
                  <a
                    key={i}
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-md bg-discord-bg-tertiary p-2 hover:bg-discord-bg-primary transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">📄</span>
                      <span className="text-sm text-discord-text-primary">{file.name}</span>
                    </div>
                    <span className="text-xs text-[#FF1493]">Download ↓</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-discord-text-muted">No files attached to this product.</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
