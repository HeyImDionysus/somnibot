'use client';

import { cn } from '@/lib/utils/cn';
import { Shield, GripVertical, Pencil, Trash2, Plus } from 'lucide-react';
import { Badge } from '@/components/shared/badge';
import { Button } from '@/components/shared/button';

// ============================================================
// Types
// ============================================================

export interface RoleItem {
  id: string;
  name: string;
  tier: string;
  color: string;
  permissions: number;
  isBuiltin: boolean;
  description?: string;
}

interface RoleHierarchyStackProps {
  roles: RoleItem[];
  selectedRoleId: string | null;
  onSelect: (id: string) => void;
  onReorder: (roles: RoleItem[]) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

// ============================================================
// Constants
// ============================================================

const tierBadgeVariant: Record<string, 'danger' | 'warning' | 'success' | 'info' | 'default' | 'pink'> = {
  admin: 'danger',
  moderator: 'warning',
  member: 'success',
  cosmetic: 'pink',
  everyone: 'default',
  custom: 'info',
};

// ============================================================
// Component
// ============================================================

export function RoleHierarchyStack({
  roles,
  selectedRoleId,
  onSelect,
  onReorder,
  onAdd,
  onEdit,
  onDelete,
}: RoleHierarchyStackProps) {
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sourceIndex === targetIndex) return;

    const newRoles = [...roles];
    const [moved] = newRoles.splice(sourceIndex, 1);
    newRoles.splice(targetIndex, 0, moved);
    onReorder(newRoles);
  };

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-discord-text-muted" />
          <span className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
            Role Hierarchy
          </span>
          <span className="text-[10px] text-discord-text-muted">
            (highest → lowest)
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus size={14} />
          Add Role
        </Button>
      </div>

      {/* Bot role indicator */}
      <div className="flex items-center gap-2 rounded-input border border-dashed border-discord-border-subtle px-3 py-2">
        <div className="h-3 w-3 rounded-full bg-discord-accent" />
        <span className="text-xs font-medium text-discord-text-muted">
          — Bot role (must stay above all managed roles) —
        </span>
      </div>

      {/* Role stack */}
      <div className="space-y-0.5">
        {roles.map((role, index) => (
          <div
            key={role.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, index)}
            onClick={() => onSelect(role.id)}
            className={cn(
              'group flex cursor-pointer items-center gap-2 rounded-input px-3 py-2 transition-standard',
              selectedRoleId === role.id
                ? 'bg-discord-accent/15 ring-1 ring-discord-accent/40'
                : 'hover:bg-discord-bg-primary/50',
            )}
          >
            {/* Drag handle */}
            <GripVertical
              size={14}
              className="shrink-0 cursor-grab text-discord-text-muted/40 active:cursor-grabbing group-hover:text-discord-text-muted"
            />

            {/* Color dot */}
            <div
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: role.color || '#99AAB5' }}
            />

            {/* Name */}
            <span className="flex-1 truncate text-sm font-medium text-discord-text-primary">
              {role.name}
            </span>

            {/* Tier badge */}
            <Badge variant={tierBadgeVariant[role.tier] ?? 'default'}>
              {role.tier}
            </Badge>

            {/* Actions (visible on hover) */}
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-standard group-hover:opacity-100">
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(role.id); }}
                className="rounded p-1 text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary"
                title="Edit role"
              >
                <Pencil size={12} />
              </button>
              {!role.isBuiltin && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(role.id); }}
                  className="rounded p-1 text-discord-text-muted hover:bg-discord-danger/20 hover:text-discord-danger"
                  title="Delete role"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* @everyone indicator (always at bottom) */}
      <div className="flex items-center gap-2 rounded-input border border-dashed border-discord-border-subtle px-3 py-2">
        <div className="h-3 w-3 rounded-full bg-discord-bg-tertiary" />
        <span className="text-xs font-medium text-discord-text-muted">
          @everyone — permissions locked to 0
        </span>
        <Badge variant="default">everyone</Badge>
      </div>
    </div>
  );
}
