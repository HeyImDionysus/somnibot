/**
 * GuildSelector — Dropdown for switching between guilds (multi-guild support).
 *
 * V53 Phase 4 (Finding 4.3.2 — S-2)
 *
 * Shows when user owns multiple guilds. Stores selection in cookie.
 * Hidden for single-guild users.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

interface GuildInfo {
  id: string;
  name: string;
}

export function GuildSelector() {
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [activeGuildId, setActiveGuildId] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const fetchGuilds = useCallback(async () => {
    try {
      const res = await fetch('/api/guilds');
      const json = await res.json();
      if (json.success && json.guilds) {
        setGuilds(json.guilds);
        setActiveGuildId(json.active_guild_id ?? json.guilds[0]?.id ?? '');
      }
    } catch {
      // Silently fail — single-guild setup
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGuilds();
  }, [fetchGuilds]);

  const switchGuild = async (guildId: string) => {
    setActiveGuildId(guildId);
    // Set cookie
    document.cookie = `active_guild_id=${guildId};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    // Reload page to refresh all data for new guild
    window.location.reload();
  };

  // Don't render if loading, no guilds, or single guild
  if (loading || guilds.length <= 1) return null;

  const activeGuild = guilds.find(g => g.id === activeGuildId);

  return (
    <div className="px-3 py-2">
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-discord-text-muted">
        Active Server
      </label>
      <select
        value={activeGuildId}
        onChange={(e) => switchGuild(e.target.value)}
        className="w-full rounded border border-discord-border-subtle bg-discord-bg-tertiary px-2.5 py-1.5 text-sm text-discord-text-primary focus:border-somni-pink/50 focus:outline-none"
        title={activeGuild?.name ?? 'Select server'}
      >
        {guilds.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  );
}
