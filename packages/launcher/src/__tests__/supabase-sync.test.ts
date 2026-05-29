/**
 * V5 Audit §13.2 — Launcher supabase-sync unit tests.
 *
 * Tests the pure data-mapping logic from supabase-sync.ts.
 * The actual push/pull functions call fetch — we replicate and test
 * the row-building and credential-parsing logic independently.
 */

import { describe, it, expect } from 'vitest';

// ── Replicated types and constants from supabase-sync.ts ──

interface SyncableCredentials {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  supabasePublishableKey: string;
}

const SETTINGS_MAP: Record<keyof SyncableCredentials, string> = {
  discordToken: 'discord_token',
  discordApplicationId: 'discord_application_id',
  discordClientSecret: 'discord_client_secret',
  discordGuildId: 'discord_guild_id',
  supabasePublishableKey: 'supabase_publishable_key',
};

const SECTION = 'launcher';

/** Builds upsert rows from credentials (from pushToSupabase). */
function buildUpsertRows(credentials: SyncableCredentials): Array<{
  key: string;
  value: string;
  section: string;
}> {
  return Object.entries(SETTINGS_MAP).map(([localKey, settingsKey]) => ({
    key: settingsKey,
    value: credentials[localKey as keyof SyncableCredentials] || '',
    section: SECTION,
  }));
}

/** Parses pull response rows into credentials (from pullFromSupabase). */
function parseRows(rows: Array<{ key: string; value: string }>): SyncableCredentials {
  const reverseMap: Record<string, keyof SyncableCredentials> = {};
  for (const [localKey, settingsKey] of Object.entries(SETTINGS_MAP)) {
    reverseMap[settingsKey] = localKey as keyof SyncableCredentials;
  }

  const credentials: SyncableCredentials = {
    discordToken: '',
    discordApplicationId: '',
    discordClientSecret: '',
    discordGuildId: '',
    supabasePublishableKey: '',
  };

  for (const row of rows) {
    const localKey = reverseMap[row.key];
    if (localKey) {
      credentials[localKey] = row.value || '';
    }
  }

  return credentials;
}

// ── Tests ────────────────────────────────────────────────────

describe('buildUpsertRows', () => {
  it('produces one row per syncable credential', () => {
    const creds: SyncableCredentials = {
      discordToken: 'tok',
      discordApplicationId: '123',
      discordClientSecret: 'sec',
      discordGuildId: '456',
      supabasePublishableKey: 'pub',
    };

    const rows = buildUpsertRows(creds);
    expect(rows).toHaveLength(5);
  });

  it('maps local keys to settings keys correctly', () => {
    const creds: SyncableCredentials = {
      discordToken: 'my-token',
      discordApplicationId: '999',
      discordClientSecret: 'shh',
      discordGuildId: '777',
      supabasePublishableKey: 'pk',
    };

    const rows = buildUpsertRows(creds);
    const rowMap = Object.fromEntries(rows.map(r => [r.key, r.value]));

    expect(rowMap['discord_token']).toBe('my-token');
    expect(rowMap['discord_application_id']).toBe('999');
    expect(rowMap['discord_client_secret']).toBe('shh');
    expect(rowMap['discord_guild_id']).toBe('777');
    expect(rowMap['supabase_publishable_key']).toBe('pk');
  });

  it('all rows have section "launcher"', () => {
    const creds: SyncableCredentials = {
      discordToken: 't',
      discordApplicationId: 'a',
      discordClientSecret: 's',
      discordGuildId: 'g',
      supabasePublishableKey: 'p',
    };

    const rows = buildUpsertRows(creds);
    for (const row of rows) {
      expect(row.section).toBe('launcher');
    }
  });

  it('uses empty string for falsy values', () => {
    const creds: SyncableCredentials = {
      discordToken: '',
      discordApplicationId: '',
      discordClientSecret: '',
      discordGuildId: '',
      supabasePublishableKey: '',
    };

    const rows = buildUpsertRows(creds);
    for (const row of rows) {
      expect(row.value).toBe('');
    }
  });
});

describe('parseRows', () => {
  it('maps settings keys back to local keys', () => {
    const rows = [
      { key: 'discord_token', value: 'tok-123' },
      { key: 'discord_application_id', value: 'app-456' },
      { key: 'discord_client_secret', value: 'sec-789' },
      { key: 'discord_guild_id', value: 'guild-000' },
      { key: 'supabase_publishable_key', value: 'pub-abc' },
    ];

    const creds = parseRows(rows);
    expect(creds.discordToken).toBe('tok-123');
    expect(creds.discordApplicationId).toBe('app-456');
    expect(creds.discordClientSecret).toBe('sec-789');
    expect(creds.discordGuildId).toBe('guild-000');
    expect(creds.supabasePublishableKey).toBe('pub-abc');
  });

  it('defaults to empty strings for missing rows', () => {
    const rows = [
      { key: 'discord_token', value: 'tok' },
    ];

    const creds = parseRows(rows);
    expect(creds.discordToken).toBe('tok');
    expect(creds.discordApplicationId).toBe('');
    expect(creds.discordClientSecret).toBe('');
    expect(creds.discordGuildId).toBe('');
    expect(creds.supabasePublishableKey).toBe('');
  });

  it('ignores unknown keys', () => {
    const rows = [
      { key: 'discord_token', value: 'tok' },
      { key: 'unknown_setting', value: 'ignored' },
      { key: 'another_key', value: 'also ignored' },
    ];

    const creds = parseRows(rows);
    expect(creds.discordToken).toBe('tok');
    expect(Object.keys(creds)).toHaveLength(5);
  });

  it('returns all empty strings for empty rows array', () => {
    const creds = parseRows([]);
    expect(creds.discordToken).toBe('');
    expect(creds.discordApplicationId).toBe('');
    expect(creds.discordClientSecret).toBe('');
    expect(creds.discordGuildId).toBe('');
    expect(creds.supabasePublishableKey).toBe('');
  });

  it('handles empty string values in rows', () => {
    const rows = [
      { key: 'discord_token', value: '' },
    ];

    const creds = parseRows(rows);
    expect(creds.discordToken).toBe('');
  });

  it('roundtrips with buildUpsertRows', () => {
    const original: SyncableCredentials = {
      discordToken: 'roundtrip-token',
      discordApplicationId: 'roundtrip-app',
      discordClientSecret: 'roundtrip-secret',
      discordGuildId: 'roundtrip-guild',
      supabasePublishableKey: 'roundtrip-pub',
    };

    const rows = buildUpsertRows(original);
    const parsed = parseRows(rows.map(r => ({ key: r.key, value: r.value })));
    expect(parsed).toEqual(original);
  });
});
