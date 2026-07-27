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
    const json = await res.json();
    if (json.success) setRoles(json.data);
  }, []);

  const loadMembers = useCallback(async () => {
    const res = await fetch('/api/rbac/users');
    const json = await res.json();
    if (json.success) setMembers(json.data);
  }, []);

  const loadInvitations = useCallback(async () => {
    const res = await fetch('/api/rbac/invitations');
    const json = await res.json();
    if (json.success) setInvitations(json.data);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadRoles(), loadMembers(), loadInvitations()]);
    setLoading(false);
  }, [loadRoles, loadMembers, loadInvitations]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const addMember = async () => {
    if (!newDiscordId || !selectedRoleId) return;
    const res = await fetch('/api/rbac/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord_id: newDiscordId, role_id: selectedRoleId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast({ title: json.error || 'Could not send invitation', variant: 'error' });
      return;
    }
    // Default (consent) model returns mode:'invitation'; the owner may have
    // enabled direct assignment (mode:'direct').
    toast(
      json.mode === 'direct'
        ? { title: 'Role assigned', variant: 'success' }
        : { title: 'Invitation sent — the member gains access once they accept', variant: 'success' },
    );
    setNewDiscordId('');
    setSelectedRoleId('');
    setShowAddMember(false);
    loadMembers();
    loadInvitations();
  };

  const removeMemberRole = async (assignmentId: string) => {
    await fetch(`/api/rbac/users?id=${assignmentId}`, { method: 'DELETE' });
    loadMembers();
  };

  const revokeInvitation = async (invitationId: string) => {
    const res = await fetch(`/api/rbac/invitations/${invitationId}`, { method: 'DELETE' });
    if (res.ok) {
      toast({ title: 'Invitation revoked', variant: 'success' });
    } else {
      const json = await res.json().catch(() => ({}));
      toast({ title: json.error || 'Could not revoke invitation', variant: 'error' });
    }
    loadInvitations();
  };

  const createRole = async () => {
    if (!newRoleName.trim()) return;
    await fetch('/api/rbac/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newRoleName, description: newRoleDesc, permissions: newRolePerms }),
    });
    setNewRoleName('');
    setNewRoleDesc('');
    setNewRolePerms([]);
    setShowAddRole(false);
    loadRoles();
  };

  const saveRolePerms = async (roleId: string) => {
    await fetch('/api/rbac/roles', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: roleId, permissions: editPerms }),
    });
    setEditingRole(null);
    loadRoles();
  };

  const deleteRole = async (roleId: string) => {
    await fetch(`/api/rbac/roles?id=${roleId}`, { method: 'DELETE' });
    loadRoles();
  };

  const togglePerm = (perm: string, perms: string[], setPerms: (p: string[]) => void) => {
    setPerms(perms.includes(perm) ? perms.filter(p => p !== perm) : [...perms, perm]);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/guild');
        if (!res.ok) return;
        const body = await res.json();
        const cfg = (body?.data ?? body?.config ?? body) as Record<string, unknown>;
        if (cancelled || !cfg) return;
        setDirectAssign((cfg.team_direct_assignment_enabled as boolean | undefined) ?? false);
        setInviteDm((cfg.team_invite_dm_enabled as boolean | undefined) ?? true);
        setMaxPending((cfg.team_max_pending_invitations as number | undefined) ?? 25);
        setExpiryMs((cfg.team_invitation_expiry_ms as number | undefined) ?? 259_200_000);
      } catch {
        // Non-fatal: the members/roles tabs still work without this card.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveTeamControls = async (patch: Record<string, string | number | boolean>) => {
    setCtrlSaving(true);
    setCtrlError(null);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCtrlError((body as { error?: string }).error ?? 'Could not save that setting.');
      }
    } catch {
      setCtrlError('Could not reach the server to save that setting.');
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
                className="mt-1 w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
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
                className="mt-1 w-full rounded-md border border-discord-border bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary"
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
              <input
                value={newDiscordId}
                onChange={(e) => setNewDiscordId(e.target.value)}
                placeholder="Discord User ID…"
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none font-mono"
              />
              <select
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
                    <button
                      onClick={() => revokeInvitation(inv.id)}
                      className="shrink-0 text-xs text-discord-text-muted hover:text-red-400 transition-colors"
                      title="Revoke invitation"
                    >
                      Revoke
                    </button>
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
                            onClick={() => removeMemberRole(r.assignment_id)}
                            className="text-xs text-discord-text-muted hover:text-red-400 transition-colors"
                            title="Remove role"
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
              <input
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="Role name…"
                className="w-full rounded-md bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none"
              />
              <input
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
        onConfirm={async () => {
          if (confirmDeleteRole) {
            await deleteRole(confirmDeleteRole.id);
            setConfirmDeleteRole(null);
          }
        }}
        onCancel={() => setConfirmDeleteRole(null)}
      />
    </div>
  );
}
