import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../supabase/migrations/20260823173000_experience_runtime_controls.sql',
  ),
  'utf8',
);

describe('experience runtime controls migration', () => {
  it('ships production owner-notification policy and rollout defaults', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS owner_notification_policy JSONB NOT NULL');
    expect(migration).toContain('"minimumSeverity": "warning"');
    expect(migration).toContain('"acknowledgementRequired": ["critical"]');
    expect(migration).toContain('"state": "general_availability"');
  });

  it('rejects non-object policy and rollout documents', () => {
    expect(migration).toContain("CHECK (jsonb_typeof(owner_notification_policy) = 'object')");
    expect(migration).toContain("CHECK (jsonb_typeof(owner_notification_rollout) = 'object')");
  });
});
