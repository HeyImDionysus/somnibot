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

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
  parent_name?: string;
  botPermissions?: string | null;
  manageableByBot?: boolean;
  missing?: boolean;
}

export type RequiredChannelPermission =
  | 'ViewChannel'
  | 'SendMessages'
  | 'EmbedLinks'
  | 'AttachFiles'
  | 'ReadMessageHistory'
  | 'Connect'
  | 'Speak'
  | 'ManageChannels';

const PERMISSION_BITS: Record<RequiredChannelPermission, bigint> = {
  ManageChannels: BigInt(1) << BigInt(4),
  ViewChannel: BigInt(1) << BigInt(10),
  SendMessages: BigInt(1) << BigInt(11),
  EmbedLinks: BigInt(1) << BigInt(14),
  AttachFiles: BigInt(1) << BigInt(15),
  ReadMessageHistory: BigInt(1) << BigInt(16),
  Connect: BigInt(1) << BigInt(20),
  Speak: BigInt(1) << BigInt(21),
};

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
  /** Bot permissions that must be proven by the live snapshot before selection. */
  requiredBotPermissions?: RequiredChannelPermission[];
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

interface ChannelSnapshot {
  channels: DiscordChannel[];
  authoritative: boolean;
}

// Shared channel cache to avoid re-fetching per picker instance
let channelCache: { data: ChannelSnapshot; ts: number } | null = null;
const CACHE_TTL = 30_000; // 30s

async function fetchChannels(): Promise<ChannelSnapshot> {
  if (channelCache && Date.now() - channelCache.ts < CACHE_TTL) {
    return channelCache.data;
  }
  const res = await fetch('/api/channels');
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Failed to load live Discord channels');
  }
  const channels = json.channels ?? json.data ?? [];
  if (!Array.isArray(channels)) {
    throw new Error('Live Discord channel snapshot is malformed');
  }
  const snapshot = {
    channels,
    authoritative: json.awaitingSnapshot !== true,
  };
  channelCache = { data: snapshot, ts: Date.now() };
  return snapshot;
}

/** Invalidate the channel cache (call after creating/deleting channels) */
export function invalidateChannelCache() {
  channelCache = null;
}

export function resolveSelectedChannels(
  selected: string[],
  channels: DiscordChannel[],
  snapshotAuthoritative: boolean,
): DiscordChannel[] {
  return selected.map((id) => channels.find((channel) => channel.id === id) ?? {
    id,
    name: snapshotAuthoritative
      ? `Deleted channel (${id})`
      : `Configured channel (${id}) — awaiting live snapshot`,
    type: CHANNEL_TYPE.GUILD_TEXT,
    position: Number.MAX_SAFE_INTEGER,
    missing: snapshotAuthoritative,
  });
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
  requiredBotPermissions = [],
}: ChannelPickerProps) {
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [snapshotAuthoritative, setSnapshotAuthoritative] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
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
      .then((snapshot) => {
        setChannels(snapshot.channels);
        setSnapshotAuthoritative(snapshot.authoritative);
      })
      .catch(() => setLoadError('Live Discord channels are unavailable. Retry after the bot refreshes its snapshot.'))
      .finally(() => setLoading(false));
  }, []);

  const permissionIssue = useCallback((channel: DiscordChannel): string | null => {
    if (channel.missing) return 'This channel was deleted or is no longer in this server.';
    if (requiredBotPermissions.length === 0) return null;
    if (channel.botPermissions == null) return 'Live bot permissions are unavailable for this channel.';
    try {
      const available = BigInt(channel.botPermissions);
      const missing = requiredBotPermissions.filter(
        (permission) => (available & PERMISSION_BITS[permission]) !== PERMISSION_BITS[permission],
      );
      return missing.length > 0
        ? `SomniBot is missing ${missing.join(', ')} in #${channel.name}.`
        : null;
    } catch {
      return 'Live bot permissions are malformed for this channel.';
    }
  }, [requiredBotPermissions]);

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
      const channel = channels.find((item) => item.id === id);
      if (id && (!channel || permissionIssue(channel))) return;
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
    [multi, selected, onChange, channels, permissionIssue],
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
    () => resolveSelectedChannels(selected, channels, snapshotAuthoritative),
    [selected, channels, snapshotAuthoritative],
  );
  const selectedIssues = selectedChannels
    .map(permissionIssue)
    .filter((issue): issue is string => issue !== null);

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
      <div
        role="button"
        aria-label={label ?? placeholder}
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-expanded={open}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            setOpen(!open);
          }
        }}
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
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label={`Remove ${ch.name}`}
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
            onKeyDown={(event) => event.stopPropagation()}
            aria-label="Clear channel selection"
            className="shrink-0 text-discord-text-muted hover:text-discord-text-primary"
          >
            <X size={14} />
          </button>
        )}
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-discord-text-muted transition-transform', open && 'rotate-180')}
        />
      </div>

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
                      const issue = permissionIssue(ch);
                      return (
                        <button
                          key={ch.id}
                          onClick={() => toggle(ch.id)}
                          disabled={issue !== null}
                          title={issue ?? undefined}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                            issue && 'cursor-not-allowed opacity-50',
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
                          {issue && <span className="ml-auto text-[10px] text-discord-danger">Unavailable</span>}
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

      {(error || loadError) && <p className="text-xs text-discord-danger">{error || loadError}</p>}
      {selectedIssues.map((issue) => (
        <p key={issue} className="text-xs text-discord-danger">{issue}</p>
      ))}
    </div>
  );
}

// ── Utility: resolve a channel ID to name ─────────────────

export function useChannelName(channelId: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId) { setName(null); return; }
    fetchChannels().then((snapshot) => {
      const ch = snapshot.channels.find((channel) => channel.id === channelId);
      setName(ch ? `#${ch.name}` : null);
    });
  }, [channelId]);

  return name;
}
