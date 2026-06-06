/**
 * useDiscordNames — Batch-resolves Discord snowflake IDs to display names.
 *
 * Resolves member IDs, channel IDs, and role IDs from guild_live_state.
 * Results are cached across hook instances.
 *
 * Phase 1: Foundation — fixes all 12+ raw ID displays across 8 pages.
 *
 * Usage:
 *   const { resolveMember, resolveChannel, resolveRole } = useDiscordNames();
 *   <span>{resolveMember(entry.member_id)}</span>
 *
 * Or batch-resolve:
 *   const { memberNames } = useDiscordNames({ memberIds: ['123', '456'] });
 *   <span>{memberNames['123']}</span>
 */
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────

interface ResolvedName {
  name: string;
  color?: string;
  avatar?: string | null;
}

interface UseDiscordNamesOptions {
  /** Member IDs to pre-resolve */
  memberIds?: string[];
  /** Channel IDs to pre-resolve */
  channelIds?: string[];
  /** Role IDs to pre-resolve */
  roleIds?: string[];
}

interface UseDiscordNamesReturn {
  /** Look up a member name. Returns display_name or username or truncated ID. */
  resolveMember: (id: string) => string;
  /** Look up a channel name. Returns #name or truncated ID. */
  resolveChannel: (id: string) => string;
  /** Look up a role name. Returns name or truncated ID. */
  resolveRole: (id: string) => string;
  /** Get role color hex string */
  roleColor: (id: string) => string;
  /** All resolved member names keyed by ID */
  memberNames: Record<string, string>;
  /** All resolved channel names keyed by ID */
  channelNames: Record<string, string>;
  /** All resolved role names keyed by ID */
  roleNames: Record<string, string>;
  /** Whether still loading */
  loading: boolean;
}

// ── Global caches ─────────────────────────────────────────

const memberCache = new Map<string, ResolvedName>();
const channelCache = new Map<string, ResolvedName>();
const roleCache = new Map<string, ResolvedName>();
let channelsFetched = false;
let rolesFetched = false;

function truncateId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function ensureChannels(): Promise<void> {
  if (channelsFetched) return;
  try {
    const res = await fetch('/api/channels');
    const json = await res.json();
    if (json.success) {
      const channels = json.channels ?? json.data ?? [];
      for (const ch of channels) {
        channelCache.set(ch.id, { name: `#${ch.name}` });
      }
      // Also cache categories
      const categories = json.categories ?? [];
      for (const cat of categories) {
        channelCache.set(cat.id, { name: cat.name });
      }
    }
    channelsFetched = true;
  } catch {
    // Ignore — will show truncated IDs
  }
}

async function ensureRoles(): Promise<void> {
  if (rolesFetched) return;
  try {
    const res = await fetch('/api/roles');
    const json = await res.json();
    if (json.success) {
      const roles = json.data ?? [];
      for (const r of roles) {
        const color = r.color
          ? `#${r.color.toString(16).padStart(6, '0')}`
          : '#99aab5';
        roleCache.set(r.id, { name: r.name, color });
      }
    }
    rolesFetched = true;
  } catch {
    // Ignore
  }
}

async function resolveMembers(ids: string[]): Promise<void> {
  const uncached = ids.filter((id) => !memberCache.has(id));
  if (uncached.length === 0) return;

  try {
    const res = await fetch(`/api/members/search?ids=${uncached.join(',')}`);
    const json = await res.json();
    if (json.success) {
      for (const m of json.members) {
        const name = m.display_name || m.username || truncateId(m.id);
        memberCache.set(m.id, { name, avatar: m.avatar });
      }
    }
  } catch {
    // Will show truncated IDs
  }

  // Mark uncached that didn't resolve as unknown
  for (const id of uncached) {
    if (!memberCache.has(id)) {
      memberCache.set(id, { name: truncateId(id) });
    }
  }
}

// ── Hook ──────────────────────────────────────────────────

export function useDiscordNames(options?: UseDiscordNamesOptions): UseDiscordNamesReturn {
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);
  const memberIdsKey = options?.memberIds?.join(',') ?? '';
  const channelIdsKey = options?.channelIds?.join(',') ?? '';
  const roleIdsKey = options?.roleIds?.join(',') ?? '';

  // Force re-render to reflect cache updates
  const refresh = useCallback(() => {
    if (mountedRef.current) setTick((t) => t + 1);
  }, []);

  // Initial resolution
  useEffect(() => {
    mountedRef.current = true;

    async function load() {
      const promises: Promise<void>[] = [];
      const memberIds = memberIdsKey ? memberIdsKey.split(',') : [];
      const channelIds = channelIdsKey ? channelIdsKey.split(',') : [];
      const roleIds = roleIdsKey ? roleIdsKey.split(',') : [];

      // Always preload channels and roles (they're small and heavily used)
      promises.push(ensureChannels());
      promises.push(ensureRoles());

      if (memberIds.length) {
        promises.push(resolveMembers(memberIds));
      }
      if (channelIds.length) {
        promises.push(ensureChannels());
      }
      if (roleIds.length) {
        promises.push(ensureRoles());
      }

      await Promise.all(promises);
      if (mountedRef.current) {
        setLoading(false);
        refresh();
      }
    }

    load();
    return () => { mountedRef.current = false; };
  }, [
    memberIdsKey,
    channelIdsKey,
    roleIdsKey,
    refresh,
  ]);

  const resolveMember = useCallback((id: string): string => {
    if (!id) return 'Unknown';
    const cached = memberCache.get(id);
    if (cached) return cached.name;

    // Trigger async resolution for next render
    resolveMembers([id]).then(refresh);
    return truncateId(id);
  }, [refresh]);

  const resolveChannel = useCallback((id: string): string => {
    if (!id) return 'Unknown';
    const cached = channelCache.get(id);
    if (cached) return cached.name;
    ensureChannels().then(refresh);
    return truncateId(id);
  }, [refresh]);

  const resolveRole = useCallback((id: string): string => {
    if (!id) return 'Unknown';
    const cached = roleCache.get(id);
    if (cached) return cached.name;
    ensureRoles().then(refresh);
    return truncateId(id);
  }, [refresh]);

  const getRoleColor = useCallback((id: string): string => {
    return roleCache.get(id)?.color ?? '#99aab5';
  }, []);

  // Build name maps for batch usage
  const memberNames: Record<string, string> = {};
  const channelNames: Record<string, string> = {};
  const roleNames: Record<string, string> = {};

  if (options?.memberIds) {
    for (const id of options.memberIds) {
      memberNames[id] = memberCache.get(id)?.name ?? truncateId(id);
    }
  }
  if (options?.channelIds) {
    for (const id of options.channelIds) {
      channelNames[id] = channelCache.get(id)?.name ?? truncateId(id);
    }
  }
  if (options?.roleIds) {
    for (const id of options.roleIds) {
      roleNames[id] = roleCache.get(id)?.name ?? truncateId(id);
    }
  }

  return {
    resolveMember,
    resolveChannel,
    resolveRole,
    roleColor: getRoleColor,
    memberNames,
    channelNames,
    roleNames,
    loading,
  };
}
