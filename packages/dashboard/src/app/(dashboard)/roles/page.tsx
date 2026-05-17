'use client';

import { useState, useEffect, useCallback } from 'react';
import { RoleHierarchyStack, type RoleItem } from '@/components/roles/role-hierarchy-stack';
import { PermissionMatrix, PERMISSION_CATEGORIES } from '@/components/permissions/permission-matrix';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/shared/card';
import { Button } from '@/components/shared/button';
import { Input, Select } from '@/components/shared/input';
import { Badge } from '@/components/shared/badge';
import { rolesApi, type RoleTemplateRow } from '@/lib/api/client';
import { Shield, Save, X, AlertTriangle } from 'lucide-react';

// ============================================================
// Types
// ============================================================

type PermValue = 'allow' | 'deny' | 'inherit';

interface EditingRole {
  id: string | null; // null = creating new
  name: string;
  tier: string;
  description: string;
  color: string;
  permissionValues: Record<string, PermValue>;
}

// ============================================================
// Constants
// ============================================================

const TIER_OPTIONS = [
  { value: 'admin', label: 'Admin — Full server management' },
  { value: 'moderator', label: 'Moderator — Member management' },
  { value: 'member', label: 'Member — Standard access' },
  { value: 'cosmetic', label: 'Cosmetic — Visual only, no permissions' },
  { value: 'custom', label: 'Custom — Manually configured' },
];

const TIER_COLORS: Record<string, string> = {
  admin: '#ED4245',
  moderator: '#FEE75C',
  member: '#57F287',
  cosmetic: '#FF1493',
  custom: '#5865F2',
  everyone: '#99AAB5',
};

// ============================================================
// Page
// ============================================================

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<EditingRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load roles from API
  const loadRoles = useCallback(async () => {
    try {
      setLoading(true);
      const data = await rolesApi.list();
      setRoles(data.map(rowToRoleItem));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  // Convert DB row to UI item
  function rowToRoleItem(row: RoleTemplateRow): RoleItem {
    return {
      id: row.id,
      name: row.name,
      tier: row.tier,
      color: TIER_COLORS[row.tier] ?? '#99AAB5',
      permissions: row.permissions,
      isBuiltin: row.is_builtin,
      description: row.description ?? undefined,
    };
  }

  // Start editing a role
  const handleEdit = (id: string) => {
    const role = roles.find((r) => r.id === id);
    if (!role) return;

    setEditingRole({
      id: role.id,
      name: role.name,
      tier: role.tier,
      description: role.description ?? '',
      color: role.color,
      permissionValues: {}, // TODO: derive from permission bitfield
    });
    setSelectedRoleId(id);
  };

  // Start creating a new role
  const handleAdd = () => {
    setEditingRole({
      id: null,
      name: '',
      tier: 'member',
      description: '',
      color: TIER_COLORS['member'],
      permissionValues: {},
    });
    setSelectedRoleId(null);
  };

  // Save role
  const handleSave = async () => {
    if (!editingRole) return;

    try {
      setSaving(true);
      setError(null);

      if (editingRole.id) {
        await rolesApi.update({
          id: editingRole.id,
          name: editingRole.name,
          tier: editingRole.tier,
          description: editingRole.description,
        });
      } else {
        await rolesApi.create({
          name: editingRole.name,
          tier: editingRole.tier,
          description: editingRole.description,
        });
      }

      setEditingRole(null);
      await loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  // Delete role
  const handleDelete = async (id: string) => {
    const role = roles.find((r) => r.id === id);
    if (!role) return;

    if (role.isBuiltin) {
      setError('Cannot delete built-in templates');
      return;
    }

    try {
      await rolesApi.delete(id);
      setSelectedRoleId(null);
      setEditingRole(null);
      await loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role');
    }
  };

  // Reorder
  const handleReorder = (newRoles: RoleItem[]) => {
    setRoles(newRoles);
    // TODO: save order to backend
  };

  // Permission matrix change
  const handlePermissionChange = (roleId: string, permKey: string, value: PermValue) => {
    if (!editingRole || editingRole.id !== roleId) return;
    setEditingRole({
      ...editingRole,
      permissionValues: {
        ...editingRole.permissionValues,
        [permKey]: value,
      },
    });
  };

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-sm text-discord-text-muted">Loading roles...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-discord-text-primary">
          <Shield size={22} />
          Role Templates
        </h1>
        <p className="mt-1 text-sm text-discord-text-muted">
          Define roles and their permissions. The bot will create these roles in Discord during deployment.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <Card variant="danger">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-discord-danger" />
            <p className="text-sm text-discord-danger">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto">
              <X size={14} className="text-discord-danger" />
            </button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        {/* Left: Role hierarchy */}
        <Card>
          <RoleHierarchyStack
            roles={roles}
            selectedRoleId={selectedRoleId}
            onSelect={(id) => { setSelectedRoleId(id); handleEdit(id); }}
            onReorder={handleReorder}
            onAdd={handleAdd}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        </Card>

        {/* Right: Editor panel */}
        <Card>
          {editingRole ? (
            <div className="space-y-6">
              {/* Editor header */}
              <CardHeader>
                <CardTitle>
                  {editingRole.id ? `Edit: ${editingRole.name}` : 'New Role'}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditingRole(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving || !editingRole.name}>
                    <Save size={12} />
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </CardHeader>

              {/* Basic fields */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Role Name"
                  id="role-name"
                  value={editingRole.name}
                  onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })}
                  placeholder="e.g. Community Manager"
                />
                <Select
                  label="Tier"
                  id="role-tier"
                  options={TIER_OPTIONS}
                  value={editingRole.tier}
                  onChange={(e) =>
                    setEditingRole({
                      ...editingRole,
                      tier: e.target.value,
                      color: TIER_COLORS[e.target.value] ?? '#99AAB5',
                    })
                  }
                />
              </div>
              <Input
                label="Description"
                id="role-desc"
                value={editingRole.description}
                onChange={(e) => setEditingRole({ ...editingRole, description: e.target.value })}
                placeholder="What this role is for..."
              />

              {/* Permission matrix */}
              {editingRole.tier !== 'cosmetic' && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
                    Permissions
                  </h4>
                  <PermissionMatrix
                    categories={PERMISSION_CATEGORIES}
                    roles={[
                      {
                        id: editingRole.id ?? 'new',
                        name: editingRole.name || 'New Role',
                        color: editingRole.color,
                        tier: editingRole.tier,
                      },
                    ]}
                    values={{ [editingRole.id ?? 'new']: editingRole.permissionValues }}
                    onChange={handlePermissionChange}
                  />
                </div>
              )}

              {editingRole.tier === 'cosmetic' && (
                <Card variant="warning">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-discord-warning" />
                    <p className="text-sm text-discord-text-secondary">
                      Cosmetic roles have zero permissions — they&apos;re purely visual (name color, badge).
                    </p>
                  </div>
                </Card>
              )}
            </div>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Shield size={32} className="mb-2 text-discord-text-muted/30" />
              <p className="text-sm text-discord-text-muted">
                Select a role to edit, or click &quot;Add Role&quot; to create a new one.
              </p>
              <CardDescription>
                Roles define what members can do. Drag to reorder the hierarchy.
              </CardDescription>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
