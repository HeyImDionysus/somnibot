/**
 * MemberPicker — Searchable dropdown for selecting Discord guild members.
 *
 * Searches members via /api/members/search (from guild_live_state).
 * Supports single and multi-select. Shows avatars.
 *
 * Phase 1: Foundation — replaces all raw user/member ID inputs.
 */
'use client';

import Image from 'next/image';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, Search, X, User, Bot } from 'lucide-react';

interface MemberInfo {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  bot?: boolean;
}

interface MemberPickerProps {
  /** Currently selected member ID(s) */
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
  /** Hide bot users */
  hideBots?: boolean;
  /** CSS class for the container */
  className?: string;
}

function memberName(m: MemberInfo): string {
  return m.display_name || m.username || m.id;
}

// Cache for resolved member info
const memberNameCache = new Map<string, MemberInfo>();

async function searchMembers(query: string): Promise<MemberInfo[]> {
  const res = await fetch(`/api/members/search?q=${encodeURIComponent(query)}`);
  const json = await res.json();
  const members: MemberInfo[] = json.success ? (json.members ?? []) : [];
  // Cache results
  for (const m of members) {
    if (m.username) memberNameCache.set(m.id, m);
  }
  return members;
}

async function resolveMembers(ids: string[]): Promise<MemberInfo[]> {
  // Check cache first
  const uncached = ids.filter((id) => !memberNameCache.has(id));
  if (uncached.length > 0) {
    const res = await fetch(`/api/members/search?ids=${uncached.join(',')}`);
    const json = await res.json();
    if (json.success) {
      for (const m of json.members) {
        if (m.username) memberNameCache.set(m.id, m);
      }
    }
  }
  return ids.map((id) => memberNameCache.get(id) ?? { id, username: null, display_name: null, avatar: null });
}

export function MemberPicker({
  value,
  onChange,
  multi = false,
  placeholder = 'Search members…',
  label,
  hint,
  error,
  disabled = false,
  hideBots = false,
  className,
}: MemberPickerProps) {
  const [results, setResults] = useState<MemberInfo[]>([]);
  const [resolvedSelected, setResolvedSelected] = useState<MemberInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const selected = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  // Resolve selected member names
  useEffect(() => {
    if (selected.length === 0) { setResolvedSelected([]); return; }
    resolveMembers(selected).then(setResolvedSelected);
  }, [selected]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!search || search.length < 1) {
      setResults([]);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      let members = await searchMembers(search);
      if (hideBots) members = members.filter((m) => !m.bot);
      setResults(members);
      setSearching(false);
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, open, hideBots]);

  // Close on outside click
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
          {resolvedSelected.length === 0 ? (
            <span className="text-discord-text-muted/60">{placeholder}</span>
          ) : multi ? (
            resolvedSelected.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 rounded bg-discord-bg-secondary px-1.5 py-0.5 text-xs text-discord-text-secondary"
              >
                <User size={10} className="text-discord-text-muted" />
                {memberName(m)}
                <button
                  onClick={(e) => removeTag(m.id, e)}
                  className="text-discord-text-muted hover:text-discord-text-primary ml-0.5"
                >
                  <X size={10} />
                </button>
              </span>
            ))
          ) : (
            <span className="flex items-center gap-1.5 text-discord-text-primary truncate">
              <User size={14} className="text-discord-text-muted" />
              {memberName(resolvedSelected[0])}
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
                placeholder="Type to search members…"
                className="flex-1 bg-transparent text-sm text-discord-text-primary placeholder:text-discord-text-muted/50 outline-none"
              />
              {searching && (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-discord-text-muted/30 border-t-discord-text-muted" />
              )}
            </div>

            {/* Results */}
            <div className="max-h-52 overflow-y-auto py-1">
              {!search && (
                <div className="px-3 py-4 text-center text-xs text-discord-text-muted">
                  Start typing to search members
                </div>
              )}

              {search && results.length === 0 && !searching && (
                <div className="px-3 py-4 text-center text-xs text-discord-text-muted">
                  No members found
                </div>
              )}

              {results.map((member) => {
                const isSelected = selected.includes(member.id);
                return (
                  <button
                    key={member.id}
                    onClick={() => toggle(member.id)}
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
                    {member.avatar ? (
                      <Image
                        src={`https://cdn.discordapp.com/avatars/${member.id}/${member.avatar}.png?size=32`}
                        alt=""
                        width={20}
                        height={20}
                        className="h-5 w-5 rounded-full shrink-0"
                      />
                    ) : (
                      <div className="h-5 w-5 rounded-full bg-discord-bg-tertiary flex items-center justify-center shrink-0">
                        <User size={10} className="text-discord-text-muted" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0 text-left">
                      <span className="truncate block">{memberName(member)}</span>
                      {member.display_name && member.username && member.display_name !== member.username && (
                        <span className="text-[10px] text-discord-text-muted truncate block">{member.username}</span>
                      )}
                    </div>
                    {member.bot && <span title="Bot"><Bot size={12} className="text-discord-accent shrink-0" /></span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-discord-danger">{error}</p>}
    </div>
  );
}
