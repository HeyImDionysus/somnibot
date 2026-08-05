'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/shared/toast';

interface PendingInvitation {
  id: string;
  guild_id: string;
  expires_at: string;
  dashboard_roles?: { name?: string | null } | null;
}

function hoursUntil(iso: string): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000));
}

/**
 * Discovery card for an invitee who has not been assigned a dashboard role
 * yet. It intentionally uses the identity-bound `/mine` API; no guild id or
 * invitation details can be supplied by the browser to enumerate somebody
 * else's invitations.
 */
export function PendingTeamInvitations() {
  const { toast } = useToast();
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/rbac/invitations/mine');
      if (!response.ok) return;
      const body = await response.json() as { data?: PendingInvitation[] };
      setInvitations(Array.isArray(body.data) ? body.data : []);
    } catch {
      // Discovery is additive; the rest of the dashboard remains usable when
      // an instance is temporarily offline.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const respond = async (id: string, action: 'accept' | 'decline') => {
    const response = await fetch(`/api/rbac/invitations/${id}/${action}`, { method: 'POST' });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (!response.ok) {
      toast({ title: body.error ?? 'That invitation is no longer available.', variant: 'error' });
      await load();
      return;
    }
    toast({
      title: body.message ?? (action === 'accept' ? 'Team invitation accepted.' : 'Team invitation declined.'),
      variant: 'success',
    });
    await load();
  };

  if (invitations.length === 0) return null;

  return (
    <section
      aria-labelledby="pending-team-invitations"
      className="mb-6 rounded-card border border-discord-accent/30 bg-discord-bg-secondary p-4"
    >
      <h2 id="pending-team-invitations" className="text-sm font-semibold text-discord-text-primary">
        Dashboard team invitations
      </h2>
      <p className="mt-1 text-xs text-discord-text-muted">
        Review these invitations before access is granted. Nothing changes until you accept.
      </p>
      <div className="mt-3 space-y-2">
        {invitations.map((invitation) => (
          <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-discord-bg-tertiary px-3 py-2">
            <div>
              <p className="text-sm text-discord-text-primary">
                {invitation.dashboard_roles?.name ?? 'Dashboard role'}
              </p>
              <p className="text-xs text-discord-text-muted">
                Expires in {hoursUntil(invitation.expires_at)} hour{hoursUntil(invitation.expires_at) === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void respond(invitation.id, 'decline')}
                className="rounded-md px-3 py-1.5 text-xs text-discord-text-muted hover:text-discord-text-primary"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void respond(invitation.id, 'accept')}
                className="rounded-md bg-[#FF1493] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#FF1493]/80"
              >
                Accept invitation
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
