import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260804133000_mod_music_dashboard_controls.sql',
);

describe('moderation and music dashboard controls migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('declares every dashboard-backed moderation control with bounded defaults', () => {
    expect(sql).toMatch(/anti_raid_containment_ladder\s+jsonb\s+NOT NULL/i);
    expect(sql).toMatch(/anti_raid_raid_cooldown_minutes\s+integer\s+NOT NULL\s+DEFAULT\s+5/i);
    expect(sql).toMatch(/appeals_enabled\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
    expect(sql).toMatch(/appeal_cooldown_hours\s+integer\s+NOT NULL\s+DEFAULT\s+24/i);
    expect(sql).toMatch(/appeal_review_channel_id\s+text/i);
    expect(sql).toMatch(/message_log_config_cache_ttl_ms\s+integer\s+NOT NULL\s+DEFAULT\s+60000/i);
    expect(sql).toMatch(/data_export_enabled\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
  });

  it('declares queue controls with safe upper bounds', () => {
    expect(sql).toMatch(/max_queue_length\s+integer\s+NOT NULL\s+DEFAULT\s+5000\s+CHECK\s*\(max_queue_length\s+BETWEEN\s+1\s+AND\s+5000\)/i);
    expect(sql).toMatch(/allow_duplicates\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
    expect(sql).toMatch(/per_user_queue_cap\s+integer\s+NOT NULL\s+DEFAULT\s+50\s+CHECK\s*\(per_user_queue_cap\s+BETWEEN\s+1\s+AND\s+500\)/i);
  });
});
