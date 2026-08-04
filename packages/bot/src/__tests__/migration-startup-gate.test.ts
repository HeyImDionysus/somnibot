import { describe, expect, it } from 'vitest';
import { requireSuccessfulMigrations } from '../services/migration-startup-gate.js';

describe('requireSuccessfulMigrations', () => {
  it('allows startup when every migration completed', () => {
    expect(() => requireSuccessfulMigrations([])).not.toThrow();
  });

  it('blocks startup when a pending migration could not run', () => {
    expect(() => requireSuccessfulMigrations([
      '20260802020000_runtime_lease.sql: A direct database connection is required',
    ])).toThrow(/database migrations failed.*direct database connection/i);
  });
});
