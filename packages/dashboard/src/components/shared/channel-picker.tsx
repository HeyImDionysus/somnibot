'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CHANNEL_TYPE,
  channelPermissionIssue,
  fetchChannels,
  resolveChannelTypes,
  resolveSelectedChannels,
  snapshotAuthorityAsOf,
  type ChannelTypeInput,
  type DiscordChannel,
  type RequiredChannelPermission,
} from './channel-picker-model';
import { ChannelPickerView } from './channel-picker-view';
import { useChannelPickerKeyboard } from './use-channel-picker-keyboard';

export type { DiscordChannel, RequiredChannelPermission } from './channel-picker-model';
export {
  channelPermissionIssue,
  invalidateChannelCache,
  isAuthoritativeChannelSnapshot,
  normalizeSnapshotChannels,
  resolveSelectedChannels,
  snapshotAuthorityAsOf,
  snapshotTimestampMs,
} from './channel-picker-model';

interface ChannelPickerProps {
  readonly value: string | readonly string[] | null;
  readonly onChange: (value: string | string[] | null) => void;
  readonly multi?: boolean;
  readonly channelTypes?: readonly ChannelTypeInput[];
  readonly placeholder?: string;
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly allowNone?: boolean;
  readonly className?: string;
  readonly requiredBotPermissions?: readonly RequiredChannelPermission[];
  readonly onAuthorityChange?: (authoritative: boolean) => void;
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
  onAuthorityChange,
}: ChannelPickerProps) {
  const fieldId = useId();
  const [channels, setChannels] = useState<readonly DiscordChannel[]>([]);
  const [snapshotAuthoritative, setSnapshotAuthoritative] = useState(false);
  const [snapshotAtMs, setSnapshotAtMs] = useState(0);
  const [authorityNowMs, setAuthorityNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const selected = useMemo<readonly string[]>(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  useEffect(() => {
    fetchChannels()
      .then((snapshot) => {
        setChannels(snapshot.channels);
        setSnapshotAuthoritative(snapshot.authoritative);
        setSnapshotAtMs(snapshot.snapshotAtMs);
      })
      .catch(() => setLoadError('Live Discord channels are unavailable. Retry after the bot refreshes its snapshot.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setAuthorityNowMs(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const liveAuthoritative = snapshotAuthorityAsOf(
    snapshotAuthoritative,
    snapshotAtMs,
    authorityNowMs,
  );

  useEffect(() => {
    onAuthorityChange?.(liveAuthoritative);
  }, [liveAuthoritative, onAuthorityChange]);

  const permissionIssue = useCallback(
    (channel: DiscordChannel): string | null =>
      channelPermissionIssue(channel, requiredBotPermissions, liveAuthoritative),
    [requiredBotPermissions, liveAuthoritative],
  );

  const resolvedTypes = useMemo(
    () => resolveChannelTypes(channelTypes),
    [channelTypes],
  );

  const filtered = useMemo(() => {
    const matchingTypes = channels.filter((channel) =>
      resolvedTypes.some((type) => type === channel.type));
    const matchingSearch = search
      ? matchingTypes.filter((channel) => channel.name.toLowerCase().includes(search.toLowerCase()))
      : matchingTypes;
    return [...matchingSearch].sort((left, right) => left.position - right.position);
  }, [channels, resolvedTypes, search]);

  const grouped = useMemo(() => {
    const categories = channels.filter((channel) => channel.type === CHANNEL_TYPE.GUILD_CATEGORY);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    const groups: Record<string, DiscordChannel[]> = { '': [] };
    for (const channel of filtered) {
      const categoryName = channel.parent_id ? (categoryNames.get(channel.parent_id) ?? 'Unknown') : '';
      const group = groups[categoryName] ?? [];
      group.push(channel);
      groups[categoryName] = group;
    }
    return groups;
  }, [filtered, channels]);

  const {
    closePicker,
    onBlurCapture,
    onOptionKeyDown,
    onSearchKeyDown,
    onTriggerKeyDown,
    openPicker,
  } = useChannelPickerKeyboard({
    listboxRef,
    open,
    searchRef,
    setOpen,
    setSearch,
    triggerRef,
  });

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node
        && containerRef.current
        && !containerRef.current.contains(event.target)
      ) {
        closePicker(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [closePicker, open]);

  const toggle = useCallback((id: string) => {
    const channel = channels.find((item) => item.id === id);
    if (id && (!channel || permissionIssue(channel))) return;
    if (multi) {
      const next = selected.includes(id)
        ? selected.filter((selectedId) => selectedId !== id)
        : [...selected, id];
      onChange(next.length > 0 ? [...next] : []);
      return;
    }
    onChange(id || null);
    closePicker(true);
  }, [channels, closePicker, multi, onChange, permissionIssue, selected]);

  const clear = useCallback(() => {
    onChange(multi ? [] : null);
  }, [multi, onChange]);

  const removeTag = useCallback((id: string) => {
    const next = selected.filter((selectedId) => selectedId !== id);
    onChange(next.length > 0 ? [...next] : multi ? [] : null);
  }, [multi, onChange, selected]);

  const selectedChannels = useMemo(
    () => resolveSelectedChannels(selected, channels, liveAuthoritative),
    [selected, channels, liveAuthoritative],
  );
  const selectedIssues = selectedChannels
    .map(permissionIssue)
    .filter((issue): issue is string => issue !== null);

  return (
    <ChannelPickerView
      allowNone={allowNone}
      className={className}
      containerRef={containerRef}
      disabled={disabled}
      error={error}
      fieldId={fieldId}
      filteredCount={filtered.length}
      grouped={grouped}
      hint={hint}
      label={label}
      listboxRef={listboxRef}
      loadError={loadError}
      loading={loading}
      multi={multi}
      onBlurCapture={onBlurCapture}
      onClear={clear}
      onOptionKeyDown={onOptionKeyDown}
      onRemove={removeTag}
      onSearchChange={setSearch}
      onSearchKeyDown={onSearchKeyDown}
      onSelect={toggle}
      onToggleOpen={() => open ? closePicker(false) : openPicker('search')}
      onTriggerKeyDown={onTriggerKeyDown}
      open={open}
      permissionIssue={permissionIssue}
      placeholder={placeholder}
      search={search}
      searchRef={searchRef}
      selected={selected}
      selectedChannels={selectedChannels}
      selectedIssues={selectedIssues}
      triggerRef={triggerRef}
      value={value}
    />
  );
}

export function useChannelName(channelId: string | null | undefined): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId) {
      setName(null);
      return;
    }
    fetchChannels().then((snapshot) => {
      const channel = snapshot.channels.find((item) => item.id === channelId);
      setName(channel ? `#${channel.name}` : null);
    });
  }, [channelId]);

  return name;
}
