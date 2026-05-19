/**
 * ChannelPicker — Searchable dropdown for selecting Discord channels.
 *
 * Fetches live channel data from /api/channels (guild_live_state).
 * Supports single and multi-select modes.
 * Filters by channel type (text, voice, category, etc.).
 *
 * Phase 1: Foundation — replaces all raw channel ID inputs.
 */
'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronDown, Search, X, Hash, Volume2, Megaphone, Folder } from 'lucide-react';

// Discord channel types
const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

type ChannelType = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

// Friendly string aliases for channel types
const CHANNEL_TYPE_ALIAS: Record<string, ChannelType> = {
  text: CHANNEL_TYPE.GUILD_TEXT,
  voice: CHANNEL_TYPE.GUILD_VOICE,
  category: CHANNEL_TYPE.GUILD_CATEGORY,
  announcement: CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  stage: CHANNEL_TYPE.GUILD_STAGE_VOICE,
  forum: CHANNEL_TYPE.GUILD_FORUM,
};

type ChannelTypeInput = ChannelType | keyof typeof CHANNEL_TYPE_ALIAS;

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
  parent_name?: string;
}

interface ChannelPickerProps {
  /** Currently selected channel ID(s) */
  value: string | string[] | null;
  /** Called when selection changes */
  onChange: (value: string | string[] | null) => void;
  /** Allow multiple selections */
  multi?: boolean;
  /** Filter by channel types. Accepts numbers or string aliases: 'text', 'voice', 'category', 'announcement', 'stage', 'forum' */
  channelTypes?: ChannelTypeInput[];
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
  /** CSS class for the container */
  className?: string;
}

// Channel type icon mapping
function ChannelIcon({ type, className }: { type: number; className?: string }) {
  switch (type) {
    case CHANNEL_TYPE.GUILD_VOICE:
    case CHANNEL_TYPE.GUILD_STAGE_VOICE:
      return <Volume2 size={14} className={className} />;
    case CHANNEL_TYPE.GUILD_ANNOUNCEMENT:
      return <Megaphone size={14} className={className} />;
    case CHANNEL_TYPE.GUILD_CATEGORY:
      return <Folder size={14} className={className} />;
    default:
      return <Hash size={14} className={className} />;
  }
}

// Shared channel cache to avoid re-fetching per picker instance
let channelCache: { data: DiscordChannel[]; ts: number } | null = null;
const CACHE_TTL = 30_000; // 30s

async function fetchChannels(): Promise<DiscordChannel[]> {
  if (channelCache && Date.now() - channelCache.ts < CACHE_TTL) {
    return channelCache.data;
  }
  const res = await fetch('/api/channels');
  const json = await res.json();
  const channels = json.success ? (json.channels ?? json.data ?? []) : [];
  channelCache = { data: channels, ts: Date.now() };
  return channels;
}

/** Invalidate the channel cache (call after creating/deleting channels) */
export function invalidateChannelCache() {
  channelCache = null;
}

export function ChannelPicker({
  value,
  onChange,
  multi = false,
  channelTypes = [CHANNEL_TYPE.GUILD_TEXT, CHANNEL_TYPE.GUILD_ANNOUNCEMENT],
  placeholder = 'Select channel…',
  label,
  hint,
  error,
  disabled = false,
  allowNone = false,
  className,
}: ChannelPickerProps) {
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Normalize value to array for internal use
  const selected = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  // Load channels
  useEffect(() => {
    fetchChannels()
      .then(setChannels)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Resolve string aliases to numeric channel types
  const resolvedTypes = useMemo(() => {
    return channelTypes.map((t) =>
      typeof t === 'string' ? (CHANNEL_TYPE_ALIAS[t] ?? t) : t
    ) as ChannelType[];
  }, [channelTypes]);

  // Filter channels by type and search
  const filtered = useMemo(() => {
    let list = channels.filter((c) => resolvedTypes.includes(c.type as ChannelType));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    return list.sort((a, b) => a.position - b.position);
  }, [channels, resolvedTypes, search]);

  // Group by category
  const grouped = useMemo(() => {
    const categories = channels.filter((c) => c.type === CHANNEL_TYPE.GUILD_CATEGORY);
    const catMap = new Map(categories.map((c) => [c.id, c.name]));
    const groups: Record<string, DiscordChannel[]> = { '': [] };

    for (const ch of filtered) {
      const catName = ch.parent_id ? (catMap.get(ch.parent_id) ?? 'Unknown') : '';
      if (!groups[catName]) groups[catName] = [];
      groups[catName].push(ch);
    }
    return groups;
  }, [filtered, channels]);

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

  // Focus search on open
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

  // Resolve selected channel names
  const selectedChannels = useMemo(
    () => selected.map((id) => channels.find((c) => c.id === id)).filter(Boolean) as DiscordChannel[],
    [selected, channels],
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
          {selectedChannels.length === 0 ? (
            <span className="text-discord-text-muted/60">{loading ? 'Loading…' : placeholder}</span>
          ) : multi ? (
            selectedChannels.map((ch) => (
              <span
                key={ch.id}
                className="inline-flex items-center gap-1 rounded bg-discord-bg-secondary px-1.5 py-0.5 text-xs text-discord-text-secondary"
              >
                <ChannelIcon type={ch.type} className="text-discord-text-muted" />
                {ch.name}
                <button
                  onClick={(e) => removeTag(ch.id, e)}
                  className="text-discord-text-muted hover:text-discord-text-primary ml-0.5"
                >
                  <X size={10} />
                </button>
              </span>
            ))
          ) : (
            <span className="flex items-center gap-1.5 text-discord-text-primary truncate">
              <ChannelIcon type={selectedChannels[0].type} className="text-discord-text-muted" />
              {selectedChannels[0].name}
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
                placeholder="Search channels…"
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

              {Object.entries(grouped).map(([catName, chans]) => {
                if (chans.length === 0) return null;
                return (
                  <div key={catName || '__root'}>
                    {catName && (
                      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-discord-text-muted/60">
                        {catName}
                      </div>
                    )}
                    {chans.map((ch) => {
                      const isSelected = selected.includes(ch.id);
                      return (
                        <button
                          key={ch.id}
                          onClick={() => toggle(ch.id)}
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
                                'h-3.5 w-3.5 rounded-sm border flex items-center justify-center',
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
                          <ChannelIcon type={ch.type} className="text-discord-text-muted shrink-0" />
                          <span className="truncate">{ch.name}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-discord-text-muted">
                  {search ? 'No channels match your search' : 'No channels available'}
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

// ── Utility: resolve a channel ID to name ─────────────────

export function useChannelName(channelId: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId) { setName(null); return; }
    fetchChannels().then((channels) => {
      const ch = channels.find((c) => c.id === channelId);
      setName(ch ? `#${ch.name}` : null);
    });
  }, [channelId]);

  return name;
}
