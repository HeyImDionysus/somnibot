'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import { Badge } from '@/components/shared/badge';
import { rolesApi, type LiveRoleData } from '@/lib/api/client';
import { roleUpdatePayload } from '@/lib/api/role-update-payload';
import {
  Shield, Plus, Pencil, Trash2, Bot, Crown, Sparkles, Lock, Users,
  RefreshCw, AlertTriangle, X, Save, GripVertical, Star, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';

// ============================================================
// Types
// ============================================================

interface NewRoleForm {
  name: string;
  tier: string;
  color: string;
  hoist: boolean;
  mentionable: boolean;
}

// ============================================================
// Constants
// ============================================================

const TIER_ORDER = ['admin', 'moderator', 'member', 'cosmetic'] as const;

const TIER_META: Record<string, {
  label: string;
  description: string;
  badge: 'danger' | 'warning' | 'success' | 'pink' | 'info' | 'default';
  icon: typeof Shield;
}> = {
  admin: {
    label: 'Admin',
    description: 'Full server management — roles, channels, settings',
    badge: 'danger',
    icon: Crown,
  },
  moderator: {
    label: 'Moderator',
    description: 'Moderation tools — timeout, kick, ban, manage messages',
    badge: 'warning',
    icon: Shield,
  },
  member: {
    label: 'Member',
    description: 'Standard community access — chat, voice, reactions',
    badge: 'success',
    icon: Users,
  },
  cosmetic: {
    label: 'Cosmetic',
    description: 'Display only — name color, hoist. No functional permissions',
    badge: 'pink',
    icon: Sparkles,
  },
};

const TIER_OPTIONS = [
  { value: 'admin', label: 'Admin — full management' },
  { value: 'moderator', label: 'Moderator — moderation tools' },
  { value: 'member', label: 'Member — standard access' },
  { value: 'cosmetic', label: 'Cosmetic — display only' },
];

// ============================================================
// Helpers
// ============================================================

function intToHex(color: number): string {
  if (!color) return '#99AAB5';
  return '#' + color.toString(16).padStart(6, '0');
}

function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || 0;
}

function classifyUntieredRole(role: LiveRoleData): string {
  if (role.managed) return 'managed';
  return 'unassigned';
}

function getManagedLabel(role: LiveRoleData): string {
  if (role.tags.premiumSubscriberRole) return 'Nitro Booster';
  if (role.tags.botId) return 'Bot Role';
  if (role.tags.integrationId) return 'Integration';
  if (role.tags.availableForPurchase) return 'Server Shop';
  if (role.tags.guildConnections) return 'Linked Role';
  if (role.managed) return 'Managed';
  return '';
}

// ============================================================
// Permission Definitions (from architecture doc §10.1)
// ============================================================

interface PermDef {
  name: string;
  bit: string; // stored as string, converted to BigInt at runtime
  label: string;
  category: string;
  dangerTier?: 'admin';
}

function permBit(shift: number): string {
  return (BigInt(1) << BigInt(shift)).toString();
}

const PERMISSION_DEFS: PermDef[] = [
  // General
  { name: 'VIEW_CHANNEL',             bit: permBit(10), label: 'View Channels',             category: 'General' },
  { name: 'CHANGE_NICKNAME',          bit: permBit(26), label: 'Change Nickname',            category: 'General' },
  { name: 'CREATE_INSTANT_INVITE',    bit: permBit(0),  label: 'Create Invite',              category: 'General' },
  { name: 'USE_EXTERNAL_APPS',        bit: permBit(50), label: 'Use External Apps',          category: 'General' },
  // Text
  { name: 'SEND_MESSAGES',            bit: permBit(11), label: 'Send Messages',              category: 'Text' },
  { name: 'SEND_MESSAGES_IN_THREADS', bit: permBit(38), label: 'Send Messages in Threads',   category: 'Text' },
  { name: 'CREATE_PUBLIC_THREADS',    bit: permBit(35), label: 'Create Public Threads',      category: 'Text' },
  { name: 'CREATE_PRIVATE_THREADS',   bit: permBit(36), label: 'Create Private Threads',     category: 'Text' },
  { name: 'EMBED_LINKS',              bit: permBit(14), label: 'Embed Links',                category: 'Text' },
  { name: 'ATTACH_FILES',             bit: permBit(15), label: 'Attach Files',               category: 'Text' },
  { name: 'ADD_REACTIONS',            bit: permBit(6),  label: 'Add Reactions',              category: 'Text' },
  { name: 'USE_EXTERNAL_EMOJIS',      bit: permBit(18), label: 'Use External Emojis',        category: 'Text' },
  { name: 'USE_EXTERNAL_STICKERS',    bit: permBit(37), label: 'Use External Stickers',      category: 'Text' },
  { name: 'READ_MESSAGE_HISTORY',     bit: permBit(16), label: 'Read Message History',       category: 'Text' },
  { name: 'USE_APPLICATION_COMMANDS', bit: permBit(31), label: 'Use Slash Commands',         category: 'Text' },
  { name: 'SEND_VOICE_MESSAGES',      bit: permBit(46), label: 'Send Voice Messages',        category: 'Text' },
  { name: 'SEND_POLLS',               bit: permBit(49), label: 'Send Polls',                 category: 'Text' },
  { name: 'MENTION_EVERYONE',         bit: permBit(17), label: 'Mention @everyone',          category: 'Text' },
  { name: 'SEND_TTS_MESSAGES',        bit: permBit(12), label: 'Send TTS Messages',          category: 'Text' },
  // Voice
  { name: 'CONNECT',                  bit: permBit(20), label: 'Connect',                    category: 'Voice' },
  { name: 'SPEAK',                    bit: permBit(21), label: 'Speak',                      category: 'Voice' },
  { name: 'USE_VAD',                  bit: permBit(25), label: 'Use Voice Activity',         category: 'Voice' },
  { name: 'STREAM',                   bit: permBit(9),  label: 'Video / Screen Share',       category: 'Voice' },
  { name: 'USE_SOUNDBOARD',           bit: permBit(42), label: 'Use Soundboard',             category: 'Voice' },
  { name: 'USE_EXTERNAL_SOUNDS',      bit: permBit(45), label: 'Use External Sounds',        category: 'Voice' },
  { name: 'PRIORITY_SPEAKER',         bit: permBit(8),  label: 'Priority Speaker',           category: 'Voice' },
  { name: 'MUTE_MEMBERS',             bit: permBit(22), label: 'Mute Members',               category: 'Voice' },
  { name: 'DEAFEN_MEMBERS',           bit: permBit(23), label: 'Deafen Members',             category: 'Voice' },
  { name: 'MOVE_MEMBERS',             bit: permBit(24), label: 'Move Members',               category: 'Voice' },
  { name: 'REQUEST_TO_SPEAK',         bit: permBit(32), label: 'Request to Speak',           category: 'Voice' },
  // Moderation
  { name: 'MANAGE_MESSAGES',          bit: permBit(13), label: 'Manage Messages',            category: 'Moderation' },
  { name: 'MANAGE_THREADS',           bit: permBit(34), label: 'Manage Threads',             category: 'Moderation' },
  { name: 'MODERATE_MEMBERS',         bit: permBit(40), label: 'Timeout Members',            category: 'Moderation' },
  { name: 'KICK_MEMBERS',             bit: permBit(1),  label: 'Kick Members',               category: 'Moderation' },
  { name: 'BAN_MEMBERS',              bit: permBit(2),  label: 'Ban Members',                category: 'Moderation' },
  { name: 'MANAGE_NICKNAMES',         bit: permBit(27), label: 'Manage Nicknames',           category: 'Moderation' },
  { name: 'VIEW_AUDIT_LOG',           bit: permBit(7),  label: 'View Audit Log',             category: 'Moderation' },
  { name: 'MANAGE_EVENTS',            bit: permBit(33), label: 'Manage Events',              category: 'Moderation' },
  { name: 'CREATE_EVENTS',            bit: permBit(44), label: 'Create Events',              category: 'Moderation' },
  // Server Management (admin)
  { name: 'MANAGE_ROLES',             bit: permBit(28), label: 'Manage Roles',               category: 'Server Management', dangerTier: 'admin' },
  { name: 'MANAGE_CHANNELS',          bit: permBit(4),  label: 'Manage Channels',            category: 'Server Management', dangerTier: 'admin' },
  { name: 'MANAGE_GUILD',             bit: permBit(5),  label: 'Manage Server',              category: 'Server Management', dangerTier: 'admin' },
  { name: 'MANAGE_WEBHOOKS',          bit: permBit(29), label: 'Manage Webhooks',            category: 'Server Management', dangerTier: 'admin' },
  { name: 'MANAGE_GUILD_EXPRESSIONS', bit: permBit(30), label: 'Manage Expressions',         category: 'Server Management', dangerTier: 'admin' },
  { name: 'CREATE_GUILD_EXPRESSIONS', bit: permBit(43), label: 'Create Expressions',         category: 'Server Management' },
  { name: 'VIEW_GUILD_INSIGHTS',      bit: permBit(19), label: 'View Server Insights',       category: 'Server Management' },
];

const PERM_CATEGORIES = ['General', 'Text', 'Voice', 'Moderation', 'Server Management'] as const;

function permHas(permissions: string | undefined, bitStr: string): boolean {
  if (!permissions) return false;
  try {
    const bit = BigInt(bitStr);
    return (BigInt(permissions) & bit) === bit;
  } catch {
    return false;
  }
}

function permToggle(permissions: string | undefined, bitStr: string, on: boolean): string {
  const bit = BigInt(bitStr);
  const current = permissions ? BigInt(permissions) : BigInt(0);
  const updated = on ? current | bit : current & ~bit;
  return updated.toString();
}

// ============================================================
// Permission Editor Component
// ============================================================

function PermissionEditor({
  permissions,
  tier,
  onChange,
}: {
  permissions: string | undefined;
  tier: string;
  onChange: (perms: string) => void;
}) {
  const { toast } = useToast();

  const [expanded, setExpanded] = useState(false);
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

  const toggleCategory = (cat: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const enabledCount = PERMISSION_DEFS.filter((p) => permHas(permissions, p.bit)).length;

  return (
    <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-discord-text-muted" />
          <span className="text-sm font-medium text-discord-text-primary">
            Permissions
          </span>
          <Badge variant="default">
            {enabledCount}/{PERMISSION_DEFS.length}
          </Badge>
        </div>
        {expanded ? <ChevronDown size={14} className="text-discord-text-muted" /> : <ChevronRight size={14} className="text-discord-text-muted" />}
      </button>

      {expanded && (
        <div className="border-t border-discord-border-subtle px-4 pb-4 pt-2 space-y-2">
          <p className="text-[10px] text-discord-text-muted">
            Toggle individual permissions. Changes are based on the tier default — toggling resets to your custom set.
          </p>
          {PERM_CATEGORIES.map((cat) => {
            const perms = PERMISSION_DEFS.filter((p) => p.category === cat);
            const catOpen = openCategories.has(cat);
            const catEnabled = perms.filter((p) => permHas(permissions, p.bit)).length;

            return (
              <div key={cat}>
                <button
                  onClick={() => toggleCategory(cat)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-discord-text-muted hover:bg-discord-bg-secondary/50"
                >
                  {catOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {cat}
                  <span className="text-[10px] font-normal">({catEnabled}/{perms.length})</span>
                </button>

                {catOpen && (
                  <div className="ml-4 space-y-0.5 pt-1">
                    {perms.map((perm) => {
                      const isOn = permHas(permissions, perm.bit);
                      const isDangerous = perm.dangerTier === 'admin' && tier !== 'admin';

                      return (
                        <label
                          key={perm.name}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-discord-bg-secondary/30',
                            isDangerous && isOn && 'bg-red-500/10',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={(e) => onChange(permToggle(permissions, perm.bit, e.target.checked))}
                            className="rounded"
                          />
                          <span className={cn(
                            'text-discord-text-secondary',
                            isOn && 'text-discord-text-primary',
                          )}>
                            {perm.label}
                          </span>
                          {isDangerous && isOn && (
                            <AlertTriangle size={10} className="text-red-400" />
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export default function RolesPage() {
  const { toast } = useToast();
  const [roles, setRoles] = useState<LiveRoleData[]>([]);
  const [botRoleId, setBotRoleId] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [awaitingSnapshot, setAwaitingSnapshot] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<LiveRoleData | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newRoleForm, setNewRoleForm] = useState<NewRoleForm>({
    name: '', tier: 'member', color: '#99AAB5', hoist: false, mentionable: false,
  });
  const [actionPending, setActionPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LiveRoleData | null>(null);

  // ── Load roles from live state ──
  const loadRoles = useCallback(async () => {
    try {
      setLoading(true);
      const response = await rolesApi.list();
      setRoles(response.data);
      setBotRoleId(response.botRoleId ?? null);
      setSnapshotAt(response.snapshotAt);
      setAwaitingSnapshot(response.awaitingSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  // ── Group roles ──
  const botRole = roles.find((r) => r.id === botRoleId);
  const managedRoles = roles.filter(
    (r) => r.managed && r.id !== botRoleId,
  );
  const tieredRoles: Record<string, LiveRoleData[]> = {
    admin: [], moderator: [], member: [], cosmetic: [],
  };
  const unassignedRoles: LiveRoleData[] = [];

  for (const role of roles) {
    if (role.id === botRoleId) continue;
    if (role.managed) continue;
    if (role.tier && tieredRoles[role.tier]) {
      tieredRoles[role.tier].push(role);
    } else {
      unassignedRoles.push(role);
    }
  }

  // ── Create role ──
  const handleCreateRole = async () => {
    if (!newRoleForm.name || !newRoleForm.tier) return;
    setActionPending(true);
    try {
      await rolesApi.create({
        name: newRoleForm.name,
        tier: newRoleForm.tier,
        color: hexToInt(newRoleForm.color),
        hoist: newRoleForm.hoist,
        mentionable: newRoleForm.mentionable,
      });
      setShowNewForm(false);
      setNewRoleForm({ name: '', tier: 'member', color: '#99AAB5', hoist: false, mentionable: false });
      // Poll for updated snapshot
      setTimeout(loadRoles, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role');
    } finally {
      setActionPending(false);
    }
  };

  // ── Update role ──
  const handleUpdateRole = async () => {
    if (!editingRole) return;
    setActionPending(true);
    try {
      const requested = roleUpdatePayload(editingRole);
      await rolesApi.update(requested);
      let confirmed: LiveRoleData | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await rolesApi.list();
        setRoles(response.data);
        confirmed = response.data.find((role) => role.id === editingRole.id);
        if (
          confirmed
          && confirmed.name === requested.name
          && confirmed.color === requested.color
          && confirmed.hoist === requested.hoist
          && confirmed.mentionable === requested.mentionable
          && confirmed.permissions === requested.permissions
          && (requested.tier === undefined || confirmed.tier === requested.tier)
        ) break;
        confirmed = undefined;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!confirmed) {
        throw new Error('The bot accepted this role change but did not publish the updated role and tier within 10 seconds. Check the Action Queue for the exact failure.');
      }
      setEditingRole(null);
      toast({ title: `Saved ${confirmed.name} and confirmed its ${confirmed.tier ?? 'unassigned'} tier`, variant: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setActionPending(false);
    }
  };

  // ── Delete role ──
  const handleDeleteRole = async (role: LiveRoleData) => {
    if (role.managed) return;
    setActionPending(true);
    try {
      await rolesApi.delete(role.id, role.templateKey ?? undefined);
      if (selectedRoleId === role.id) {
        setSelectedRoleId(null);
        setEditingRole(null);
      }
      setTimeout(loadRoles, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role');
    } finally {
      setActionPending(false);
    }
  };

  // ── Select role for editing ──
  const selectRole = (role: LiveRoleData) => {
    setSelectedRoleId(role.id);
    if (!role.managed) {
      setEditingRole({ ...role });
    } else {
      setEditingRole(null);
    }
    setShowNewForm(false);
  };

  // ── Role row component ──
  const RoleRow = ({ role, readOnly }: { role: LiveRoleData; readOnly?: boolean }) => (
    <div
      onClick={() => selectRole(role)}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-input px-3 py-2 transition-standard',
        selectedRoleId === role.id
          ? 'bg-discord-accent/15 ring-1 ring-discord-accent/40'
          : 'hover:bg-discord-bg-primary/50',
      )}
    >
      {/* Color dot */}
      <div
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: intToHex(role.color) }}
      />

      {/* Name */}
      <span className="flex-1 truncate text-sm font-medium text-discord-text-primary">
        {role.name}
      </span>

      {/* Members count */}
      <span className="text-xs text-discord-text-muted">{role.memberCount}</span>

      {/* Managed badge */}
      {role.managed && (
        <Badge variant="default">
          {getManagedLabel(role)}
        </Badge>
      )}

      {/* Tier badge */}
      {role.tier && !role.managed && (
        <Badge variant={TIER_META[role.tier]?.badge ?? 'default'}>
          {role.tier}
        </Badge>
      )}

      {/* Actions for editable roles */}
      {!readOnly && !role.managed && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
          <button
            onClick={(e) => { e.stopPropagation(); selectRole(role); }}
            className="rounded p-1 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
            title="Edit role"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(role); }}
            className="rounded p-1 text-discord-text-muted hover:bg-discord-danger/20 hover:text-discord-danger"
            title="Delete role"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {readOnly && (
        <Lock size={12} className="shrink-0 text-discord-text-muted/40" />
      )}
    </div>
  );

  // ── Loading state ──
  if (loading) {
    return <CardListSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
            <Shield size={22} />
            Role Management
          </h1>
          <p className="mt-1 text-sm text-discord-text-muted">
            Manage your server&apos;s roles. Roles are grouped by permission tier. Managed roles (bot, Nitro Booster) are shown read-only.
          </p>
          {snapshotAt && (
            <p className="mt-0.5 text-xs text-discord-text-muted">
              Last synced: {new Date(snapshotAt).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={loadRoles} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => { setShowNewForm(true); setEditingRole(null); setSelectedRoleId(null); }}>
            <Plus size={14} />
            Create Role
          </Button>
        </div>
      </div>

      {/* Awaiting snapshot warning */}
      {awaitingSnapshot && (
        <Card variant="warning">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-discord-warning" />
            <p className="text-sm text-discord-warning">
              Waiting for the bot to send its first snapshot. Make sure the bot is online and connected.
            </p>
          </div>
        </Card>
      )}

      {/* Error */}
      {error && (
        <Card variant="danger">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-discord-danger" />
            <p className="text-sm text-discord-danger">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        {/* Left: Role hierarchy */}
        <Card>
          <div className="space-y-1">
            {/* Bot role (always top) */}
            {botRole && (
              <>
                <div className="flex items-center gap-2 rounded-input border border-dashed border-discord-accent/40 bg-discord-accent/5 px-3 py-2">
                  <Bot size={14} className="text-discord-accent" />
                  <span className="flex-1 text-xs font-medium text-discord-accent">
                    {botRole.name}
                  </span>
                  <Badge variant="info">Bot</Badge>
                  <span className="text-[10px] text-discord-text-muted">Must stay #1</span>
                </div>
                <div className="border-l-2 border-discord-border-subtle ml-4 h-2" />
              </>
            )}

            {/* Tiered roles */}
            {TIER_ORDER.map((tier) => {
              const meta = TIER_META[tier];
              const tierRoles = tieredRoles[tier];
              const TierIcon = meta.icon;

              return (
                <div key={tier} className="space-y-0.5">
                  {/* Tier header */}
                  <div className="flex items-center gap-2 px-1 pt-3 pb-1">
                    <TierIcon size={12} className="text-discord-text-muted" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-discord-text-muted">
                      — {meta.description}
                    </span>
                  </div>

                  {/* Roles in this tier */}
                  {tierRoles.length > 0 ? (
                    tierRoles.map((role) => <RoleRow key={role.id} role={role} />)
                  ) : (
                    <div className="px-3 py-1.5">
                      <span className="text-xs italic text-discord-text-muted/50">
                        No {meta.label.toLowerCase()} roles yet
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Unassigned roles (roles created outside SomniBot) */}
            {unassignedRoles.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 px-1 pt-3 pb-1">
                  <Star size={12} className="text-discord-text-muted" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
                    Unassigned
                  </span>
                  <span className="text-[10px] text-discord-text-muted">
                    — created outside SomniBot, assign a tier to manage
                  </span>
                </div>
                {unassignedRoles.map((role) => <RoleRow key={role.id} role={role} />)}
              </div>
            )}

            {/* Managed roles (read-only) */}
            {managedRoles.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 px-1 pt-3 pb-1">
                  <Lock size={12} className="text-discord-text-muted" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
                    Managed
                  </span>
                  <span className="text-[10px] text-discord-text-muted">
                    — Discord-managed, read-only
                  </span>
                </div>
                {managedRoles.map((role) => (
                  <RoleRow key={role.id} role={role} readOnly />
                ))}
              </div>
            )}

            {/* @everyone (always bottom) */}
            <div className="flex items-center gap-2 rounded-input border border-dashed border-discord-border-subtle px-3 py-2 mt-2">
              <div className="h-3 w-3 rounded-full bg-discord-bg-tertiary" />
              <span className="text-xs font-medium text-discord-text-muted">
                @everyone — permissions locked to 0
              </span>
              <Badge variant="default">everyone</Badge>
            </div>
          </div>
        </Card>

        {/* Right: Editor */}
        <Card>
          {showNewForm ? (
            /* ── New role form ── */
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>Create New Role</CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowNewForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={handleCreateRole} disabled={!newRoleForm.name || actionPending}>
                    <Plus size={12} />
                    {actionPending ? 'Creating...' : 'Create'}
                  </Button>
                </div>
              </CardHeader>

              <Input
                label="Role Name"
                id="new-role-name"
                value={newRoleForm.name}
                onChange={(e) => setNewRoleForm({ ...newRoleForm, name: e.target.value })}
                placeholder="e.g. Head Moderator, VIP, Team Red"
              />

              <Select
                label="Permission Tier"
                id="new-role-tier"
                options={TIER_OPTIONS}
                value={newRoleForm.tier}
                onChange={(e) => setNewRoleForm({ ...newRoleForm, tier: e.target.value })}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="new-role-color" className="mb-1 block text-xs font-medium text-discord-text-secondary">
                    Color
                  </label>
                  <input
                    type="color"
                    id="new-role-color"
                    value={newRoleForm.color}
                    onChange={(e) => setNewRoleForm({ ...newRoleForm, color: e.target.value })}
                    className="h-10 w-full cursor-pointer rounded-input border border-discord-border-subtle bg-discord-bg-primary"
                  />
                </div>
              </div>

              <Toggle
                label="Hoist"
                description="Show members with this role separately in the member list"
                checked={newRoleForm.hoist}
                onChange={(hoist) => setNewRoleForm({ ...newRoleForm, hoist })}
              />
              <Toggle
                label="Mentionable"
                description="Allow anyone to @mention this role"
                checked={newRoleForm.mentionable}
                onChange={(mentionable) => setNewRoleForm({ ...newRoleForm, mentionable })}
              />

              <p className="text-xs text-discord-text-muted">
                Permissions are automatically set based on the selected tier. You can fine-tune them after creation.
              </p>
            </div>
          ) : editingRole ? (
            /* ── Edit existing role ── */
            <div className="space-y-4">
              <CardHeader>
                <CardTitle>
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 rounded-full" style={{ backgroundColor: intToHex(editingRole.color) }} />
                    Edit: {editingRole.name}
                  </div>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { setEditingRole(null); setSelectedRoleId(null); }}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleUpdateRole} disabled={actionPending}>
                    <Save size={12} />
                    {actionPending ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </CardHeader>

              <Input
                label="Role Name"
                id="edit-role-name"
                value={editingRole.name}
                onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })}
              />

              <Select
                label="Permission Tier"
                id="edit-role-tier"
                options={TIER_OPTIONS}
                value={editingRole.tier ?? 'member'}
                onChange={(e) => setEditingRole({ ...editingRole, tier: e.target.value })}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="edit-role-color" className="mb-1 block text-xs font-medium text-discord-text-secondary">
                    Color
                  </label>
                  <input
                    type="color"
                    id="edit-role-color"
                    value={intToHex(editingRole.color)}
                    onChange={(e) => setEditingRole({ ...editingRole, color: hexToInt(e.target.value) })}
                    className="h-10 w-full cursor-pointer rounded-input border border-discord-border-subtle bg-discord-bg-primary"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <p className="text-xs text-discord-text-muted">
                    Members with this role: <span className="font-medium text-discord-text-primary">{editingRole.memberCount}</span>
                  </p>
                  <p className="text-xs text-discord-text-muted">
                    Discord position: <span className="font-medium text-discord-text-primary">{editingRole.position}</span>
                  </p>
                </div>
              </div>

              <Toggle
                label="Hoist"
                description="Show members with this role separately in the member list"
                checked={editingRole.hoist}
                onChange={(hoist) => setEditingRole({ ...editingRole, hoist })}
              />
              <Toggle
                label="Mentionable"
                description="Allow anyone to @mention this role"
                checked={editingRole.mentionable}
                onChange={(mentionable) => setEditingRole({ ...editingRole, mentionable })}
              />

              {/* Per-role permission editor */}
              <PermissionEditor
                permissions={editingRole.permissions}
                tier={editingRole.tier ?? 'member'}
                onChange={(permissions) => setEditingRole({ ...editingRole, permissions })}
              />

              {editingRole.source === 'deployed' && (
                <div className="rounded-input bg-discord-bg-primary p-3">
                  <p className="text-xs text-discord-text-muted">
                    <span className="font-medium text-discord-accent">Deployed by SomniBot</span> — template key: <code className="text-[10px]">{editingRole.templateKey}</code>
                  </p>
                </div>
              )}
            </div>
          ) : selectedRoleId && roles.find((r) => r.id === selectedRoleId)?.managed ? (
            /* ── Managed role detail view ── */
            (() => {
              const role = roles.find((r) => r.id === selectedRoleId)!;
              return (
                <div className="space-y-4">
                  <CardHeader>
                    <CardTitle>
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 rounded-full" style={{ backgroundColor: intToHex(role.color) }} />
                        {role.name}
                        <Badge variant="default">{getManagedLabel(role)}</Badge>
                      </div>
                    </CardTitle>
                  </CardHeader>

                  <div className="rounded-input bg-discord-bg-primary p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <Lock size={14} className="text-discord-text-muted" />
                      <p className="text-sm text-discord-text-secondary">
                        This role is managed by Discord and cannot be edited or deleted through the dashboard.
                      </p>
                    </div>

                    {role.tags.premiumSubscriberRole && (
                      <p className="text-xs text-discord-text-muted">
                        Automatically assigned to Nitro Boosters. Discord manages membership.
                        You can enhance the booster experience through channel access and level bonuses.
                      </p>
                    )}

                    {role.tags.botId && (
                      <p className="text-xs text-discord-text-muted">
                        Created by Discord for a bot integration. Position determines what the bot can manage.
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-input bg-discord-bg-primary p-3">
                      <p className="text-[10px] uppercase tracking-wide text-discord-text-muted">Members</p>
                      <p className="text-lg font-bold text-discord-text-primary">{role.memberCount}</p>
                    </div>
                    <div className="rounded-input bg-discord-bg-primary p-3">
                      <p className="text-[10px] uppercase tracking-wide text-discord-text-muted">Position</p>
                      <p className="text-lg font-bold text-discord-text-primary">{role.position}</p>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            /* ── Empty state ── */
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Shield size={32} className="mb-2 text-discord-text-muted/30" />
              <p className="text-sm text-discord-text-muted">
                Select a role to view or edit, or create a new role.
              </p>
              <CardDescription>
                {roles.length} roles in your Discord server
              </CardDescription>
            </div>
          )}
        </Card>
      </div>

      {/* Summary bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="default">{roles.length} total roles</Badge>
          {TIER_ORDER.map((tier) => (
            <Badge key={tier} variant={TIER_META[tier].badge}>
              {tieredRoles[tier].length} {TIER_META[tier].label}
            </Badge>
          ))}
          {managedRoles.length > 0 && (
            <Badge variant="default">{managedRoles.length} managed</Badge>
          )}
          {unassignedRoles.length > 0 && (
            <Badge variant="info">{unassignedRoles.length} unassigned</Badge>
          )}
        </div>
      </Card>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Role"
        description={`Delete role "${confirmDelete?.name}"? This will remove it from Discord and cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await handleDeleteRole(confirmDelete);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
