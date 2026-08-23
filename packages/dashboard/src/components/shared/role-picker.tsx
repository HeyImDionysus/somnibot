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

import { useEffect, useState, useRef, useCallback, useMemo, useId } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, Search, X, Shield } from 'lucide-react';

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed?: boolean;
  hoist?: boolean;
  editableByBot?: boolean;
}

interface RoleSnapshot {
  roles: DiscordRole[];
  authoritative: boolean;
  /**
   * The snapshot's OWN timestamp (server snapshotAt), not the browser fetch
   * time; authority EXPIRES past the age window while the picker stays
   * mounted. Anchoring to fetch time would restart the ten-minute clock on an
   * almost-expired snapshot.
   */
  snapshotAtMs: number;
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
  /** Require a role SomniBot can currently assign (for grants and rewards). */
  requireAssignable?: boolean;
  /** CSS class for the container */
  className?: string;
}

function roleColor(color: number): string {
  if (!color) return '#99aab5'; // Discord default gray
  return `#${color.toString(16).padStart(6, '0')}`;
}

// Shared role cache
let roleCache: { data: RoleSnapshot; ts: number } | null = null;
const CACHE_TTL = 30_000;
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1_000;
const MAX_SNAPSHOT_FUTURE_SKEW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidRoleShape(value: unknown): value is DiscordRole {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.color === 'number'
    && Number.isFinite(value.color)
    && typeof value.position === 'number'
    && Number.isFinite(value.position)
    && typeof value.editableByBot === 'boolean';
}

export function roleSnapshotTimestampMs(payload: unknown): number | null {
  if (!isRecord(payload) || typeof payload.snapshotAt !== 'string') return null;
  const parsed = Date.parse(payload.snapshotAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isAuthoritativeRoleSnapshot(
  payload: unknown,
  nowMs = Date.now(),
): boolean {
  if (!isRecord(payload) || payload.awaitingSnapshot === true) return false;
  const snapshotMs = roleSnapshotTimestampMs(payload) ?? Number.NaN;
  return payload.snapshotVersion === 2
    && Number.isFinite(snapshotMs)
    && nowMs - snapshotMs <= MAX_SNAPSHOT_AGE_MS
    && snapshotMs - nowMs <= MAX_SNAPSHOT_FUTURE_SKEW_MS
    && Array.isArray(payload.data)
    && payload.data.every(hasValidRoleShape);
}

async function fetchRoles(): Promise<RoleSnapshot> {
  if (roleCache && Date.now() - roleCache.ts < CACHE_TTL) {
    return roleCache.data;
  }
  const res = await fetch('/api/roles');
  if (!res.ok) {
    throw new Error(`Role lookup failed (${res.status})`);
  }
  const json = await res.json();
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error('Role lookup returned a non-authoritative response');
  }
  // A non-authoritative payload may carry no snapshotAt; the fallback is
  // inert because expiry is only consulted when authority already held.
  const snapshot = {
    roles: json.data as DiscordRole[],
    authoritative: isAuthoritativeRoleSnapshot(json),
    snapshotAtMs: roleSnapshotTimestampMs(json) ?? Date.now(),
  };
  roleCache = { data: snapshot, ts: Date.now() };
  return snapshot;
}

export function missingRoleIds(
  selected: string[],
  roles: DiscordRole[],
  authoritative: boolean,
): string[] {
  if (!authoritative) return [];
  return selected.filter((id) => !roles.some((role) => role.id === id));
}

/**
 * Why a role cannot be safely selected in a requireAssignable picker, or null
 * when it can. A non-authoritative snapshot FAILS CLOSED: its editableByBot
 * bits may predate the bot losing Manage Roles or being moved below the role,
 * and active-product submission only fails later at server validation — the
 * picker must not offer a choice it cannot verify.
 */
export function roleAssignmentIssue(
  role: Pick<DiscordRole, 'editableByBot'>,
  requireAssignable: boolean,
  rolesAuthoritative: boolean,
): string | null {
  if (!requireAssignable) return null;
  if (!rolesAuthoritative) {
    return 'Live bot role authority cannot be verified right now — retry after the bot refreshes its snapshot.';
  }
  if (role.editableByBot === false) {
    return 'Move SomniBot above this role and grant Manage Roles first';
  }
  return null;
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
  requireAssignable = false,
  className,
}: RolePickerProps) {
  const labelId = useId();
  const listboxId = useId();
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolesAuthoritative, setRolesAuthoritative] = useState(false);
  const [snapshotAtMs, setSnapshotAtMs] = useState(0);
  // Ticks while mounted so authority can EXPIRE: a page left open past the
  // snapshot's ten-minute validity must not keep enabling roles from stale
  // editableByBot bits (same contract as the channel picker).
  const [authorityNowMs, setAuthorityNowMs] = useState(() => Date.now());
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  useEffect(() => {
    fetchRoles()
      .then((snapshot) => {
        setRoles(snapshot.roles);
        setRolesAuthoritative(snapshot.authoritative);
        setSnapshotAtMs(snapshot.snapshotAtMs);
        setLoadFailed(false);
      })
      .catch(() => {
        setRolesAuthoritative(false);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setAuthorityNowMs(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // Authority as of NOW, anchored to the snapshot's own timestamp. Once the
  // snapshot outlives its validity window the picker treats assignability as
  // unverifiable again — the same state a stale fetch would have produced.
  const liveRolesAuthoritative = rolesAuthoritative
    && snapshotAtMs > 0
    && authorityNowMs - snapshotAtMs <= MAX_SNAPSHOT_AGE_MS;

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

  const selectedRoles = useMemo(
    () => selected.map((id) => roles.find((r) => r.id === id)).filter(Boolean) as DiscordRole[],
    [selected, roles],
  );
  const missingSelected = useMemo(
    () => missingRoleIds(selected, roles, liveRolesAuthoritative),
    [selected, roles, liveRolesAuthoritative],
  );
  // Only ids the stale payload cannot resolve render as unresolved chips —
  // ids still resolvable from the (stale) snapshot keep their single normal
  // chip. Rendering both produced two chips per configured role.
  const unresolvedSelected = liveRolesAuthoritative
    ? []
    : selected.filter((id) => !roles.some((role) => role.id === id));
  const unreachableSelected = useMemo(
    () => requireAssignable
      ? selectedRoles.filter((role) => role.editableByBot === false)
      : [],
    [requireAssignable, selectedRoles],
  );

  return (
    <div
      className={cn('space-y-1', className)}
      ref={containerRef}
      onKeyDownCapture={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setSearch('');
        queueMicrotask(() => triggerRef.current?.focus());
      }}
    >
      {label && (
        <label id={labelId} className="mb-1 block text-xs font-medium text-discord-text-muted">
          {label}
        </label>
      )}
      {hint && (
        <p className="text-xs text-discord-text-muted/70 mb-1">{hint}</p>
      )}

      {/* Trigger */}
      <div
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
        <button
          ref={triggerRef}
          type="button"
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : placeholder}
          aria-haspopup="listbox"
          aria-controls={open ? listboxId : undefined}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <div className="flex-1 min-w-0 flex flex-wrap gap-1">
            {selectedRoles.length === 0 && missingSelected.length === 0 && unresolvedSelected.length === 0 ? (
              <span className="text-discord-text-muted/60">{loading ? 'Loading…' : placeholder}</span>
            ) : !multi && unresolvedSelected.length > 0 ? (
              <span className="truncate text-discord-text-muted">
                Configured role ({unresolvedSelected[0]})
              </span>
            ) : !multi && selectedRoles.length === 0 ? (
              <span className="truncate text-discord-danger">
                Deleted role ({missingSelected[0]})
              </span>
            ) : multi ? (
              <>
                {selectedRoles.map((role) => (
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
                    <span aria-hidden="true" className="opacity-60 ml-0.5">
                      <X size={10} />
                    </span>
                  </span>
                ))}
                {missingSelected.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded bg-discord-danger/15 px-1.5 py-0.5 text-xs text-discord-danger"
                  >
                    Deleted role ({id})
                    <span aria-hidden="true" className="opacity-60">
                      <X size={10} />
                    </span>
                  </span>
                ))}
                {unresolvedSelected.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded bg-discord-text-muted/10 px-1.5 py-0.5 text-xs text-discord-text-muted"
                  >
                    Configured role ({id})
                    <span aria-hidden="true" className="opacity-60">
                      <X size={10} />
                    </span>
                  </span>
                ))}
              </>
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
          <ChevronDown
            size={14}
            className={cn('shrink-0 text-discord-text-muted transition-transform', open && 'rotate-180')}
          />
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            aria-label={multi ? 'Clear selected roles' : 'Clear selected role'}
            onClick={clear}
            className="shrink-0 text-discord-text-muted hover:text-discord-text-primary"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="relative z-50">
          <div
            className="absolute top-1 left-0 right-0 max-h-64 max-w-full overflow-hidden rounded-lg border border-discord-border-subtle bg-discord-bg-floating shadow-lg"
          >
            {/* Search */}
            <div className="flex items-center gap-2 border-b border-discord-border-subtle px-3 py-2">
              <Search size={14} className="text-discord-text-muted" />
              <input
                 ref={searchRef}
                 value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search roles"
                placeholder="Search roles…"
                className="flex-1 bg-transparent text-sm text-discord-text-primary placeholder:text-discord-text-muted/50 outline-none"
              />
            </div>

            {/* Options */}
            <div
              id={listboxId}
              role="listbox"
              aria-labelledby={label ? labelId : undefined}
              aria-label={label ? undefined : placeholder}
              aria-multiselectable={multi || undefined}
              className="max-h-52 overflow-y-auto py-1"
            >
              {allowNone && !multi && (
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
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
                const assignIssue = roleAssignmentIssue(
                  role,
                  requireAssignable,
                  liveRolesAuthoritative,
                );
                const cannotAssign = assignIssue !== null;
                return (
                  <button
                    key={role.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={cannotAssign}
                    onClick={() => toggle(role.id)}
                    title={assignIssue ?? undefined}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                      cannotAssign && 'cursor-not-allowed opacity-45',
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
                    {cannotAssign && !role.managed && (
                      <span className="ml-auto text-[10px] text-discord-warning">Above bot</span>
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
      {!error && missingSelected.length > 0 && (
        <p className="text-xs text-discord-danger">Remove the deleted role before saving.</p>
      )}
      {!error && loadFailed && (
        <p className="text-xs text-discord-warning">
          Roles could not be refreshed. Existing role IDs are preserved until Discord data is available.
        </p>
      )}
      {!error && unreachableSelected.length > 0 && (
        <p className="text-xs text-discord-warning">
          Move SomniBot above {unreachableSelected.map((role) => role.name).join(', ')} before saving.
        </p>
      )}
    </div>
  );
}

// ── Utility: resolve a role ID to name ─────────────────────

export function useRoleName(roleId: string | null | undefined): { name: string | null; color: string } {
  const [info, setInfo] = useState<{ name: string | null; color: string }>({ name: null, color: '#99aab5' });

  useEffect(() => {
    if (!roleId) { setInfo({ name: null, color: '#99aab5' }); return; }
    let cancelled = false;
    void fetchRoles()
      .then((snapshot) => {
        if (cancelled) return;
        const role = snapshot.roles.find((r) => r.id === roleId);
        setInfo(role ? { name: role.name, color: roleColor(role.color) } : { name: null, color: '#99aab5' });
      })
      .catch(() => {
        // Keep the last authoritative display value during a transient lookup failure.
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  return info;
}
