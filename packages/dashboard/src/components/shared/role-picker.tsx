/**
 * RolePicker — Searchable dropdown for selecting Discord roles.
 *
 * Fetches live role data from /api/roles (guild_live_state).
 * Supports single and multi-select modes.
 * Shows role color swatches.
 *
 * Phase 1: Foundation — replaces all raw role ID inputs.
 */
'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, Search, X, Shield } from 'lucide-react';

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed?: boolean;
  hoist?: boolean;
}

interface RolePickerProps {
  /** Currently selected role ID(s) */
  value: string | string[] | null;
  /** Called when selection changes */
  onChange: (value: string | string[] | null) => void;
  /** Allow multiple selections */
  multi?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Label above the picker */
  label?: string;
  /** Hint text below label */
  hint?: string;
  /** Error message */
  error?: string;
  /** Disable the picker */
  disabled?: boolean;
  /** Show "None" option for optional fields */
  allowNone?: boolean;
  /** Hide managed roles (bot roles) */
  hideManaged?: boolean;
  /** Hide @everyone */
  hideEveryone?: boolean;
  /** CSS class for the container */
  className?: string;
}

function roleColor(color: number): string {
  if (!color) return '#99aab5'; // Discord default gray
  return `#${color.toString(16).padStart(6, '0')}`;
}

// Shared role cache
let roleCache: { data: DiscordRole[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

async function fetchRoles(): Promise<DiscordRole[]> {
  if (roleCache && Date.now() - roleCache.ts < CACHE_TTL) {
    return roleCache.data;
  }
  const res = await fetch('/api/roles');
  const json = await res.json();
  const roles = json.success ? (json.data ?? []) : [];
  roleCache = { data: roles, ts: Date.now() };
  return roles;
}

/** Invalidate the role cache */
export function invalidateRoleCache() {
  roleCache = null;
}

export function RolePicker({
  value,
  onChange,
  multi = false,
  placeholder = 'Select role…',
  label,
  hint,
  error,
  disabled = false,
  allowNone = false,
  hideManaged = false,
  hideEveryone = true,
  className,
}: RolePickerProps) {
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  useEffect(() => {
    fetchRoles()
      .then(setRoles)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = roles;
    if (hideEveryone) list = list.filter((r) => r.name !== '@everyone');
    if (hideManaged) list = list.filter((r) => !r.managed);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.position - a.position);
  }, [roles, hideEveryone, hideManaged, search]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const toggle = useCallback(
    (id: string) => {
      if (multi) {
        const next = selected.includes(id)
          ? selected.filter((s) => s !== id)
          : [...selected, id];
        onChange(next.length > 0 ? next : null);
      } else {
        onChange(id || null);
        setOpen(false);
        setSearch('');
      }
    },
    [multi, selected, onChange],
  );

  const clear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange(multi ? [] : null);
    },
    [multi, onChange],
  );

  const removeTag = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const next = selected.filter((s) => s !== id);
      onChange(next.length > 0 ? next : multi ? [] : null);
    },
    [multi, selected, onChange],
  );

  const selectedRoles = useMemo(
    () => selected.map((id) => roles.find((r) => r.id === id)).filter(Boolean) as DiscordRole[],
    [selected, roles],
  );

  return (
    <div className={cn('space-y-1', className)} ref={containerRef}>
      {label && (
        <label className="mb-1 block text-xs font-medium text-discord-text-muted">
          {label}
        </label>
      )}
      {hint && (
        <p className="text-xs text-discord-text-muted/70 mb-1">{hint}</p>
      )}

      {/* Trigger */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          'flex w-full items-center gap-2 rounded-input border px-3 py-2 text-sm text-left transition-colors',
          'bg-discord-bg-tertiary',
          open
            ? 'border-discord-accent'
            : error
              ? 'border-discord-danger'
              : 'border-discord-border-subtle hover:border-discord-border-strong',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className="flex-1 min-w-0 flex flex-wrap gap-1">
          {selectedRoles.length === 0 ? (
            <span className="text-discord-text-muted/60">{loading ? 'Loading…' : placeholder}</span>
          ) : multi ? (
            selectedRoles.map((role) => (
              <span
                key={role.id}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
                style={{
                  backgroundColor: `${roleColor(role.color)}15`,
                  color: roleColor(role.color),
                }}
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: roleColor(role.color) }}
                />
                {role.name}
                <button
                  onClick={(e) => removeTag(role.id, e)}
                  className="opacity-60 hover:opacity-100 ml-0.5"
                >
                  <X size={10} />
                </button>
              </span>
            ))
          ) : (
            <span className="flex items-center gap-1.5 text-discord-text-primary truncate">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: roleColor(selectedRoles[0].color) }}
              />
              {selectedRoles[0].name}
            </span>
          )}
        </div>
        {selected.length > 0 && (
          <button
            onClick={clear}
            className="shrink-0 text-discord-text-muted hover:text-discord-text-primary"
          >
            <X size={14} />
          </button>
        )}
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-discord-text-muted transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="relative z-50">
          <div className="absolute top-1 left-0 right-0 max-h-64 overflow-hidden rounded-lg border border-discord-border-subtle bg-discord-bg-floating shadow-lg">
            {/* Search */}
            <div className="flex items-center gap-2 border-b border-discord-border-subtle px-3 py-2">
              <Search size={14} className="text-discord-text-muted" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search roles…"
                className="flex-1 bg-transparent text-sm text-discord-text-primary placeholder:text-discord-text-muted/50 outline-none"
              />
            </div>

            {/* Options */}
            <div className="max-h-52 overflow-y-auto py-1">
              {allowNone && !multi && (
                <button
                  onClick={() => toggle('')}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    !value
                      ? 'bg-discord-accent/10 text-discord-text-primary'
                      : 'text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary',
                  )}
                >
                  <span className="italic">None</span>
                </button>
              )}

              {filtered.map((role) => {
                const isSelected = selected.includes(role.id);
                return (
                  <button
                    key={role.id}
                    onClick={() => toggle(role.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                      isSelected
                        ? 'bg-discord-accent/10 text-discord-text-primary'
                        : 'text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary',
                    )}
                  >
                    {multi && (
                      <div
                        className={cn(
                          'h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0',
                          isSelected
                            ? 'border-discord-accent bg-discord-accent'
                            : 'border-discord-border-strong',
                        )}
                      >
                        {isSelected && (
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                            <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    )}
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: roleColor(role.color) }}
                    />
                    <span className="truncate" style={{ color: role.color ? roleColor(role.color) : undefined }}>
                      {role.name}
                    </span>
                    {role.managed && (
                      <span title="Managed role"><Shield size={12} className="ml-auto text-discord-text-muted/50 shrink-0" /></span>
                    )}
                  </button>
                );
              })}

              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-discord-text-muted">
                  {search ? 'No roles match your search' : 'No roles available'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-discord-danger">{error}</p>}
    </div>
  );
}

// ── Utility: resolve a role ID to name ─────────────────────

export function useRoleName(roleId: string | null | undefined): { name: string | null; color: string } {
  const [info, setInfo] = useState<{ name: string | null; color: string }>({ name: null, color: '#99aab5' });

  useEffect(() => {
    if (!roleId) { setInfo({ name: null, color: '#99aab5' }); return; }
    fetchRoles().then((roles) => {
      const role = roles.find((r) => r.id === roleId);
      setInfo(role ? { name: role.name, color: roleColor(role.color) } : { name: null, color: '#99aab5' });
    });
  }, [roleId]);

  return info;
}
