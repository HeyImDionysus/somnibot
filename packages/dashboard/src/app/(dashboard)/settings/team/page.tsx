/**
 * Team Settings — RBAC role management and team member assignments.
 * Phase D: SOTA dashboard access control management.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { UserCog } from 'lucide-react';
import { requireApiSuccess } from '@/lib/client-api-result';

// ── Types ─────────────────────────────────────────────────

interface DashboardRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  priority: number;
  dashboard_user_roles: { count: number }[];
}

interface TeamMember {
  discord_id: string;
  roles: Array<{
    assignment_id: string;
    role: { name: string; description: string; permissions: string[]; priority: number } | null;
    assigned_at: string;
    assigned_by: string | null;
  }>;
}

interface PendingInvitation {
  id: string;
  discord_id: string;
  role_id: string;
  status: string;
  dm_status: string;
  delivery_mode: string | null;
  invited_by: string | null;
  expires_at: string;
  created_at: string;
  dashboard_roles: { name: string; description: string | null; priority: number } | null;
}

// ── Permission display ────────────────────────────────────

const PERM_LABELS: Record<string, string> = {
  'dashboard.full_access': '🔑 Full Access',
  'dashboard.view_analytics': '📊 View Analytics',
  'dashboard.manage_store': '🏪 Manage Store',
  'dashboard.manage_products': '📦 Manage Products',
  'dashboard.manage_orders': '🧾 Manage Orders',
  'dashboard.manage_customers': '👥 Manage Customers',
  'dashboard.manage_licenses': '🔐 Manage Licenses',
  'dashboard.manage_moderation': '🛡️ Moderation',
  'dashboard.manage_tickets': '🎫 Tickets',
  'dashboard.manage_automations': '⚡ Automations',
  'dashboard.manage_server': '⚙️ Server Settings',
  'dashboard.manage_roles': '👑 Manage Roles',
  'dashboard.manage_channels': '📢 Channels',
  'dashboard.manage_team': '👥 Manage Team',
  'dashboard.view_audit': '📋 View Audit',
  'dashboard.view_diagnostics': '🔧 Diagnostics',
  'dashboard.manage_incidents': '🚨 Incidents',
  'dashboard.view_fraud': '🔍 View Fraud',
  'dashboard.manage_fraud': '🛡️ Manage Fraud',
  'dashboard.view_workflows': '📋 View Workflows',
  'dashboard.manage_workflows': '⚡ Manage Workflows',
  'dashboard.undo_changes': '↩️ Undo Changes',
};

const ALL_PERMISSIONS = Object.keys(PERM_LABELS);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dmStatusLabel(inv: PendingInvitation): string {
  switch (inv.dm_status) {
    case 'sent': return '📨 DM delivered';
    case 'failed': return '⚠️ DM failed — share the dashboard link';
    case 'skipped': return 'Dashboard-only';
    default: return '⏳ DM queued';
  }
}

// ── Component ─────────────────────────────────────────────

export default function TeamSettingsPage() {
  const { toast } = useToast();
  const [confirmDeleteRole, setConfirmDeleteRole] = useState<{ id: string; name: string } | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState<
    | { readonly kind: 'assignment'; readonly id: string; readonly memberId: string; readonly roleName: string }
    | { readonly kind: 'invitation'; readonly id: string; readonly memberId: string; readonly roleName: string }
    | null
  >(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationLoading, setMutationLoading] = useState(false);

  const [tab, setTab] = useState<'members' | 'roles'>('members');
  // Invitation controls. These columns and the bot's sweeper have existed since
  // migration 20260723193000; the dashboard never surfaced them, so the consent
  // model they implement was not something an owner could actually choose.
  const [directAssign, setDirectAssign] = useState(false);
  const [inviteDm, setInviteDm] = useState(true);
  const [maxPending, setMaxPending] = useState(25);
  const [expiryMs, setExpiryMs] = useState(259_200_000);
  const [ctrlSaving, setCtrlSaving] = useState(false);
  const [ctrlError, setCtrlError] = useState<string | null>(null);
  const [roles, setRoles] = useState<DashboardRole[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false);
  const [newDiscordId, setNewDiscordId] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');

  // Add role form
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [newRolePerms, setNewRolePerms] = useState<string[]>([]);

  // Edit role
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);

  const loadRoles = useCallback(async () => {
    const res = await fetch('/api/rbac/roles');
    const json = await requireApiSuccess(res, 'Could not read back dashboard roles. Retry from this page.');
    if (!Array.isArray(json.data)) throw new Error('The roles readback was invalid. Retry from this page.');
    setRoles(json.data as DashboardRole[]);
  }, []);

  const loadMembers = useCallback(async () => {
    const res = await fetch('/api/rbac/users');
    const json = await requireApiSuccess(res, 'Could not read back team members. Retry from this page.');
    if (!Array.isArray(json.data)) throw new Error('The team-member readback was invalid. Retry from this page.');
    setMembers(json.data as TeamMember[]);
  }, []);

  const loadInvitations = useCallback(async () => {
    const res = await fetch('/api/rbac/invitations');
    const json = await requireApiSuccess(res, 'Could not read back pending invitations. Retry from this page.');
    if (!Array.isArray(json.data)) throw new Error('The invitation readback was invalid. Retry from this page.');
    setInvitations(json.data as PendingInvitation[]);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadRoles(), loadMembers(), loadInvitations()]);
    } catch (loadError) {
      setMutationError(loadError instanceof Error ? loadError.message : 'Could not load team access. Retry from this page.');
    } finally {
      setLoading(false);
    }
  }, [loadRoles, loadMembers, loadInvitations]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const addMember = async () => {
    if (!newDiscordId || !selectedRoleId) return;
    setMutationLoading(true);
    setMutationError(null);
    try {
      const res = await fetch('/api/rbac/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discord_id: newDiscordId, role_id: selectedRoleId }),
      });
      const json = await requireApiSuccess(res, 'Could not add this member. Check the Discord user ID and selected role, then retry.');
      await Promise.all([loadMembers(), loadInvitations()]);
      toast(
        json.mode === 'direct'
          ? { title: 'Role assigned', variant: 'success' }
          : { title: 'Invitation sent — the member gains access once they accept', variant: 'success' },
      );
      setNewDiscordId('');
      setSelectedRoleId('');
      setShowAddMember(false);
    } catch (addError) {
      const message = addError instanceof Error ? addError.message : 'Could not add this member. Check the fields and retry.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    } finally {
      setMutationLoading(false);
    }
  };

  const executeRemoval = async () => {
    if (!confirmRemoval) return;
    setMutationLoading(true);
    setMutationError(null);
    try {
      const url = confirmRemoval.kind === 'assignment'
        ? `/api/rbac/users?id=${confirmRemoval.id}`
        : `/api/rbac/invitations/${confirmRemoval.id}`;
      const res = await fetch(url, { method: 'DELETE' });
      await requireApiSuccess(
        res,
        confirmRemoval.kind === 'assignment'
          ? 'Could not remove this role assignment. The member still has access.'
          : 'Could not revoke this invitation. It remains usable.',
      );
      if (confirmRemoval.kind === 'assignment') await loadMembers();
      else await loadInvitations();
      toast({ title: confirmRemoval.kind === 'assignment' ? 'Role assignment removed' : 'Invitation revoked', variant: 'success' });
      setConfirmRemoval(null);
    } catch (removeError) {
      const message = removeError instanceof Error ? removeError.message : 'Could not remove this access. Retry from this page.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    } finally {
      setMutationLoading(false);
    }
  };

  const resendInvitation = async (invitationId: string) => {
    try {
      const res = await fetch(`/api/rbac/invitations/${invitationId}/resend`, { method: 'POST' });
      const json = await requireApiSuccess(res, 'Could not resend this invitation. The existing invitation remains valid.');
      await loadInvitations();
      toast({ title: typeof json.message === 'string' ? json.message : 'Invitation delivery re-queued', variant: 'success' });
    } catch (resendError) {
      const message = resendError instanceof Error ? resendError.message : 'Could not resend this invitation. Retry from this page.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    }
  };

  const createRole = async () => {
    if (!newRoleName.trim()) return;
    setMutationLoading(true);
    setMutationError(null);
    try {
      const response = await fetch('/api/rbac/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newRoleName, description: newRoleDesc, permissions: newRolePerms }),
      });
      await requireApiSuccess(response, 'Could not create this role. Your name, description, and permission choices are still here.');
      await loadRoles();
      setNewRoleName('');
      setNewRoleDesc('');
      setNewRolePerms([]);
      setShowAddRole(false);
      toast({ title: 'Role created', variant: 'success' });
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Could not create this role. Retry from this page.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    } finally {
      setMutationLoading(false);
    }
  };

  const saveRolePerms = async (roleId: string) => {
    setMutationLoading(true);
    setMutationError(null);
    try {
      const response = await fetch('/api/rbac/roles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: roleId, permissions: editPerms }),
      });
      await requireApiSuccess(response, 'Could not save these permissions. Your permission choices are still selected.');
      await loadRoles();
      setEditingRole(null);
      toast({ title: 'Role permissions saved', variant: 'success' });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Could not save these permissions. Retry from this page.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    } finally {
      setMutationLoading(false);
    }
  };

  const deleteRole = async (roleId: string) => {
    setMutationLoading(true);
    setMutationError(null);
    try {
      const response = await fetch(`/api/rbac/roles?id=${roleId}`, { method: 'DELETE' });
      await requireApiSuccess(response, 'Could not delete this role. It remains available and assigned.');
      await loadRoles();
      toast({ title: 'Role deleted', variant: 'success' });
      setConfirmDeleteRole(null);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Could not delete this role. Retry from this page.';
      setMutationError(message);
      toast({ title: message, variant: 'error' });
    } finally {
      setMutationLoading(false);
    }
  };

  const togglePerm = (perm: string, perms: string[], setPerms: (p: string[]) => void) => {
    setPerms(perms.includes(perm) ? perms.filter(p => p !== perm) : [...perms, perm]);
  };

  const loadTeamControls = useCallback(async () => {
    const response = await fetch('/api/guild');
    const body = await requireApiSuccess(response, 'Could not read team invitation controls. Retry from this page.');
    const candidate = body.data ?? body.config ?? body;
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('The server returned an invalid team-controls readback. Retry from this page.');
    }
    const cfg = candidate as Record<string, unknown>;
    setDirectAssign(typeof cfg.team_direct_assignment_enabled === 'boolean' ? cfg.team_direct_assignment_enabled : false);
    setInviteDm(typeof cfg.team_invite_dm_enabled === 'boolean' ? cfg.team_invite_dm_enabled : true);
    setMaxPending(typeof cfg.team_max_pending_invitations === 'number' ? cfg.team_max_pending_invitations : 25);
    setExpiryMs(typeof cfg.team_invitation_expiry_ms === 'number' ? cfg.team_invitation_expiry_ms : 259_200_000);
  }, []);

  useEffect(() => {
    void loadTeamControls().catch((controlsError: unknown) => {
      setCtrlError(controlsError instanceof Error ? controlsError.message : 'Could not load team invitation controls.');
    });
  }, [loadTeamControls]);

  const saveTeamControls = async (patch: Record<string, string | number | boolean>) => {
    setCtrlSaving(true);
    setCtrlError(null);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await requireApiSuccess(res, 'Could not save that setting. Your selected value is still shown; correct it or retry.');
      await loadTeamControls();
    } catch (controlsError) {
      setCtrlError(controlsError instanceof Error ? controlsError.message : 'Could not reach the server to save that setting.');
    } finally {
      setCtrlSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-discord-text-primary">Team</h1>
        <p className="mt-1 text-sm text-discord-text-muted">Manage dashboard access with role-based permissions</p>
      </div>

      {mutationError && (
        <p role="alert" className="rounded-card border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {mutationError}
        </p>
      )}

      {/* How invitations work */}
      <div className="rounded-lg bg-discord-bg-secondary p-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">How invitations work</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          By default, adding someone sends an invitation they have to accept.
        </p>

        <div className="mt-4 space-y-4">
          <label className="flex items-start gap-2 text-sm text-discord-text-primary">
            <input
              type="checkbox"
              className="mt-1 rounded"
              checked={directAssign}
              disabled={ctrlSaving}
              onChange={(e) => {
                setDirectAssign(e.target.checked);
                void saveTeamControls({ team_direct_assignment_enabled: e.target.checked });
              }}
            />
            <span>
              Add people without asking them first
              <span className="block text-xs text-yellow-400/90">
                Skips consent — someone gains dashboard access to your server without
                agreeing to it. Leave this off unless you have a specific reason.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-discord-text-primary">
            <input
              type="checkbox"
              className="mt-1 rounded"
              checked={inviteDm}
              disabled={ctrlSaving}
              onChange={(e) => {
                setInviteDm(e.target.checked);
                void saveTeamControls({ team_invite_dm_enabled: e.target.checked });
              }}
            />
            <span>
              DM the invitation
              <span className="block text-xs text-discord-text-muted">
                With this off, invitees have to be told some other way — the invite still exists.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-discord-text-muted">Most invitations pending at once</span>
              <input
                type="number"
                min={1}
                max={100}
                value={maxPending}
                disabled={ctrlSaving}
                onChange={(e) => setMaxPending(Number(e.target.value))}
                onBlur={(e) => void saveTeamControls({ team_max_pending_invitations: Number(e.target.value) })}
                className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
              />
            </label>
            <label className="block text-sm">
              <span className="text-discord-text-muted">Invitations expire after</span>
              <select
                value={String(expiryMs)}
                disabled={ctrlSaving}
                onChange={(e) => {
                  setExpiryMs(Number(e.target.value));
                  void saveTeamControls({ team_invitation_expiry_ms: Number(e.target.value) });
                }}
                className="mt-1 w-full rounded-md border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
              >
                <option value="86400000">24 hours</option>
                <option value="259200000">3 days</option>
                <option value="604800000">7 days</option>
              </select>
            </label>
          </div>
        </div>

        {ctrlError && <p className="mt-3 text-sm text-red-400">{ctrlError}</p>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-discord-border-subtle">
        {(['members', 'roles'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize ${
              tab === t
                ? 'border-[#FF1493] text-discord-text-primary'
                : 'border-transparent text-discord-text-muted hover:text-discord-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <ConfigSkeleton />
      ) : tab === 'members' ? (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
            >
              Add Member
            </button>
          </div>

          {showAddMember && (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3">
              <h3 className="text-sm font-semibold text-discord-text-primary">Add Team Member</h3>
              <label htmlFor="team-discord-id" className="text-xs text-discord-text-muted">Member Discord ID</label>
              <input
                id="team-discord-id"
                value={newDiscordId}
                onChange={(e) => setNewDiscordId(e.target.value)}
                placeholder="Discord User ID…"
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none font-mono"
              />
              <label htmlFor="team-role" className="text-xs text-discord-text-muted">Dashboard role</label>
              <select
                id="team-role"
                value={selectedRoleId}
                onChange={(e) => setSelectedRoleId(e.target.value)}
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              >
                <option value="">Select role…</option>
                {roles.filter(r => r.name !== 'owner').map((r) => (
                  <option key={r.id} value={r.id}>{r.name} — {r.description || 'No description'}</option>
                ))}
              </select>
              <button
                onClick={addMember}
                disabled={mutationLoading || !newDiscordId || !selectedRoleId}
                className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
              >
                Assign Role
              </button>
            </div>
          )}

          {invitations.length > 0 && (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-discord-text-primary">Pending Invitations</h3>
                <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-[10px] text-discord-text-muted">
                  {invitations.length}
                </span>
              </div>
              <p className="text-xs text-discord-text-muted">
                Invitees gain access only after they accept from the dashboard. Invitations expire automatically.
              </p>
              <div className="space-y-2">
                {invitations.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between rounded-md bg-discord-bg-tertiary px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-discord-text-primary truncate">{inv.discord_id}</span>
                        <span className="rounded-full bg-[#FF1493]/20 px-2 py-0.5 text-[10px] font-medium text-[#FF1493]">
                          {inv.dashboard_roles?.name || 'role'}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-discord-text-muted">
                        <span>{dmStatusLabel(inv)}</span>
                        <span>Expires {formatDate(inv.expires_at)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        onClick={() => void resendInvitation(inv.id)}
                        className="text-xs text-discord-text-muted hover:text-[#FF1493] transition-colors"
                        title="Retry delivery without creating another invitation"
                      >
                        Resend
                      </button>
                      <button
                        onClick={() => setConfirmRemoval({
                          kind: 'invitation',
                          id: inv.id,
                          memberId: inv.discord_id,
                          roleName: inv.dashboard_roles?.name ?? 'selected role',
                        })}
                        className="text-xs text-discord-text-muted hover:text-red-400 transition-colors"
                        title="Revoke invitation"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {members.length === 0 ? (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
              <div className="text-4xl mb-3">👥</div>
              <EmptyState compact icon={UserCog} title="No team members yet" description="Only the owner has dashboard access. Add team members to delegate permissions." />
            </div>
          ) : (
            members.map((member) => (
              <div key={member.discord_id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-mono text-discord-text-primary">{member.discord_id}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {member.roles.map((r) => (
                        <div key={r.assignment_id} className="flex items-center gap-1">
                          <span className="rounded-full bg-[#FF1493]/20 px-2 py-0.5 text-xs font-medium text-[#FF1493]">
                            {r.role?.name || 'Unknown'}
                          </span>
                          <button
                            onClick={() => setConfirmRemoval({
                              kind: 'assignment',
                              id: r.assignment_id,
                              memberId: member.discord_id,
                              roleName: r.role?.name ?? 'Unknown role',
                            })}
                            className="text-xs text-discord-text-muted hover:text-red-400 transition-colors"
                            aria-label={`Remove ${r.role?.name ?? 'role'} from member ${member.discord_id}`}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs text-discord-text-muted">
                    Assigned {member.roles[0] ? formatDate(member.roles[0].assigned_at) : ''}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        /* Roles Tab */
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddRole(!showAddRole)}
              className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
            >
              Create Role
            </button>
          </div>

          {showAddRole && (
            <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 space-y-3">
              <h3 className="text-sm font-semibold text-discord-text-primary">Create Custom Role</h3>
              <label htmlFor="new-role-name" className="text-xs text-discord-text-muted">Role name</label>
              <input
                id="new-role-name"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="Role name…"
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
              <label htmlFor="new-role-description" className="text-xs text-discord-text-muted">Role description</label>
              <input
                id="new-role-description"
                value={newRoleDesc}
                onChange={(e) => setNewRoleDesc(e.target.value)}
                placeholder="Description (optional)…"
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
              <div className="flex flex-wrap gap-2">
                {ALL_PERMISSIONS.filter(p => p !== 'dashboard.full_access').map((perm) => (
                  <button
                    key={perm}
                    onClick={() => togglePerm(perm, newRolePerms, setNewRolePerms)}
                    aria-pressed={newRolePerms.includes(perm)}
                    className={`rounded-md px-2 py-1 text-xs transition-colors ${
                      newRolePerms.includes(perm)
                        ? 'bg-[#FF1493]/20 text-[#FF1493]'
                        : 'bg-discord-bg-tertiary text-discord-text-muted hover:text-discord-text-primary'
                    }`}
                  >
                    {PERM_LABELS[perm] || perm}
                  </button>
                ))}
              </div>
              <button
                onClick={createRole}
                disabled={mutationLoading || !newRoleName.trim()}
                className="rounded-md bg-[#FF1493] px-4 py-2 text-sm font-medium text-white hover:bg-[#FF1493]/80 transition-colors"
              >
                Create
              </button>
            </div>
          )}

          {roles.map((role) => (
            <div key={role.id} className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-discord-text-primary">{role.name}</span>
                    {role.is_system && (
                      <span className="rounded-full bg-discord-bg-tertiary px-1.5 py-0.5 text-[10px] text-discord-text-muted">system</span>
                    )}
                    <span className="text-xs text-discord-text-muted">
                      Priority: {role.priority} • {role.dashboard_user_roles?.[0]?.count || 0} members
                    </span>
                  </div>
                  {role.description && (
                    <p className="mt-0.5 text-xs text-discord-text-muted">{role.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  {!role.is_system && role.name !== 'owner' && (
                    <>
                      <button
                        onClick={() => {
                          if (editingRole === role.id) {
                            setEditingRole(null);
                          } else {
                            setEditingRole(role.id);
                            setEditPerms([...role.permissions]);
                          }
                        }}
                        className="text-xs text-discord-text-muted hover:text-discord-text-primary transition-colors"
                      >
                        {editingRole === role.id ? 'Cancel' : 'Edit'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteRole({ id: role.id, name: role.name })}
                        className="text-xs text-discord-text-muted hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Permissions display */}
              {editingRole === role.id ? (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {ALL_PERMISSIONS.filter(p => p !== 'dashboard.full_access').map((perm) => (
                      <button
                        key={perm}
                        onClick={() => togglePerm(perm, editPerms, setEditPerms)}
                        aria-pressed={editPerms.includes(perm)}
                        className={`rounded-md px-2 py-1 text-xs transition-colors ${
                          editPerms.includes(perm)
                            ? 'bg-[#FF1493]/20 text-[#FF1493]'
                            : 'bg-discord-bg-tertiary text-discord-text-muted hover:text-discord-text-primary'
                        }`}
                      >
                        {PERM_LABELS[perm] || perm}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => saveRolePerms(role.id)}
                    disabled={mutationLoading}
                    className="rounded-md bg-discord-success/20 px-3 py-1.5 text-xs font-medium text-discord-success hover:bg-discord-success/30 transition-colors"
                  >
                    Save Permissions
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1">
                  {role.permissions.map((perm) => (
                    <span key={perm} className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-[10px] text-discord-text-muted">
                      {PERM_LABELS[perm] || perm}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDeleteRole}
        title="Delete Role"
        description={`Delete role "${confirmDeleteRole?.name}"? Members assigned this role will lose these permissions.`}
        confirmLabel="Delete"
        variant="danger"
        loading={mutationLoading}
        onConfirm={() => {
          if (confirmDeleteRole) return deleteRole(confirmDeleteRole.id);
        }}
        onCancel={() => {
          if (!mutationLoading) setConfirmDeleteRole(null);
        }}
      />

      <ConfirmDialog
        open={confirmRemoval !== null}
        title={confirmRemoval?.kind === 'assignment' ? 'Remove team role' : 'Revoke team invitation'}
        description={confirmRemoval ? confirmRemoval.kind === 'assignment'
          ? `Remove “${confirmRemoval.roleName}” from Discord member ${confirmRemoval.memberId}. The member immediately loses every dashboard permission granted only by this role.`
          : `Revoke the pending “${confirmRemoval.roleName}” invitation for Discord member ${confirmRemoval.memberId}. The invitation link can no longer grant dashboard access.` : undefined}
        confirmLabel={confirmRemoval?.kind === 'assignment' ? 'Remove role access' : 'Revoke invitation'}
        variant="danger"
        loading={mutationLoading}
        onConfirm={executeRemoval}
        onCancel={() => {
          if (!mutationLoading) setConfirmRemoval(null);
        }}
      />
    </div>
  );
}
