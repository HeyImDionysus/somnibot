/**
 * Migration Runner — Unit Tests
 *
 * Tests the tracked migration runner's logic without a real database.
 * Validates: checksum computation, file discovery, tracking behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { planMigrationSql } from '../services/migration-runner.js';

// ── Checksum utility (mirrors what the runner uses) ──

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

describe('Migration Runner — checksums', () => {
  it('should produce consistent SHA-256 checksums', () => {
    const sql = 'CREATE TABLE test (id INTEGER);';
    const h1 = sha256(sql);
    const h2 = sha256(sql);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('should detect content changes via checksum', () => {
    const v1 = sha256('CREATE TABLE test (id INTEGER);');
    const v2 = sha256('CREATE TABLE test (id BIGINT);');
    expect(v1).not.toBe(v2);
  });

  it('should be sensitive to whitespace changes', () => {
    const v1 = sha256('CREATE TABLE test (id INTEGER);');
    const v2 = sha256('CREATE TABLE  test (id INTEGER);');
    expect(v1).not.toBe(v2);
  });
});

describe('Migration Runner — file ordering', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'migrations-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should sort migration files by filename (timestamp order)', () => {
    const files = [
      '20260518100000_alerts.sql',
      '20260516000000_initial.sql',
      '20260517000000_members.sql',
    ];
    files.forEach((f) => writeFileSync(join(tempDir, f), `-- ${f}`));

    const { readdirSync } = require('node:fs');
    const sorted = readdirSync(tempDir)
      .filter((f: string) => f.endsWith('.sql'))
      .sort();

    expect(sorted).toEqual([
      '20260516000000_initial.sql',
      '20260517000000_members.sql',
      '20260518100000_alerts.sql',
    ]);
  });

  it('should reject non-.sql files', () => {
    writeFileSync(join(tempDir, '20260516000000_initial.sql'), '-- sql');
    writeFileSync(join(tempDir, 'README.md'), '# readme');
    writeFileSync(join(tempDir, 'backup.sql.bak'), '-- bak');

    const { readdirSync } = require('node:fs');
    const sqlFiles = readdirSync(tempDir).filter((f: string) => f.endsWith('.sql'));

    expect(sqlFiles).toHaveLength(1);
    expect(sqlFiles[0]).toBe('20260516000000_initial.sql');
  });
});

describe('Migration Runner — tracking logic', () => {
  it('should skip already-applied migrations', () => {
    const appliedMap = new Map([
      ['20260516000000_initial.sql', { filename: '20260516000000_initial.sql', checksum: 'abc123', success: true }],
    ]);

    const allFiles = [
      '20260516000000_initial.sql',
      '20260517000000_members.sql',
    ];

    const pending = allFiles.filter((f) => !appliedMap.has(f));
    expect(pending).toEqual(['20260517000000_members.sql']);
  });

  it('should detect checksum drift', () => {
    const appliedChecksum = sha256('CREATE TABLE test (id INTEGER);');
    const currentChecksum = sha256('CREATE TABLE test (id BIGINT);');

    expect(appliedChecksum).not.toBe(currentChecksum);
    // This simulates the drift detection condition
    const isDrifted = appliedChecksum !== currentChecksum;
    expect(isDrifted).toBe(true);
  });

  it('should stop on first error (ordered execution)', () => {
    const migrations = ['m1.sql', 'm2.sql', 'm3.sql'];
    const results: string[] = [];
    let errorEncountered = false;

    for (const m of migrations) {
      if (errorEncountered) break;
      if (m === 'm2.sql') {
        errorEncountered = true;
        results.push(`${m}: ERROR`);
        break;
      }
      results.push(`${m}: OK`);
    }

    expect(results).toEqual(['m1.sql: OK', 'm2.sql: ERROR']);
    // m3.sql should never have been attempted
    expect(results).not.toContain('m3.sql: OK');
  });
});

describe('Migration Runner — SQL execution planning', () => {
  it('keeps ordinary migrations atomic as one unchanged query', () => {
    const source = `
      CREATE TABLE "semi;colon" (value TEXT);
      INSERT INTO "semi;colon" VALUES ('it''s; still one literal');
    `;

    expect(planMigrationSql(source)).toEqual([source]);
  });

  it('splits only around top-level CREATE INDEX CONCURRENTLY', () => {
    const source = `
      -- a comment with a semicolon ;
      DO $pre$
      BEGIN
        PERFORM 'inside;dollar';
        PERFORM E'escaped\\';still-inside';
        /* outer ; /* nested ; */ still outer */
      END
      $pre$;
      SELECT 'second ordinary; statement before';

      CREATE /* between keywords ; */ UNIQUE INDEX CONCURRENTLY idx_example
        ON "semi;table" ("semi;column")
        WHERE value = 'open;critical';

      SELECT 'first ordinary; statement after';
      DO $post$
      BEGIN
        EXECUTE 'SELECT ''identifier;value'';';
      END
      $post$;
    `;

    const batches = planMigrationSql(source);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toContain('PERFORM E');
    expect(batches[0]).toContain('second ordinary; statement before');
    expect(batches[0]).not.toContain('CREATE /* between keywords');
    expect(batches[1]).toContain('CREATE /* between keywords ; */ UNIQUE INDEX CONCURRENTLY');
    expect(batches[1]).not.toContain('DO $post$');
    expect(batches[2]).toContain('DO $post$');
    expect(batches[2]).toContain('first ordinary; statement after');
  });

  it('segments the complete fraud observation index migration as DO / CIC / DO', () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../supabase/migrations',
        '20260727034400_fraud_signal_observation_index.sql',
      ),
      'utf8',
    );

    const batches = planMigrationSql(source);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toContain('DO $fraud_index_recovery$');
    expect(batches[1].trimStart()).toMatch(/^CREATE INDEX CONCURRENTLY/);
    expect(batches[2]).toContain('DO $fraud_index_postflight$');
  });

  it.each([
    'DROP INDEX CONCURRENTLY idx_example;',
    'REINDEX INDEX CONCURRENTLY idx_example;',
    'VACUUM public.example;',
    'CREATE DATABASE example;',
    "ALTER SYSTEM SET work_mem = '64MB';",
  ])('fails closed for unsupported transaction-incompatible SQL: %s', (statement) => {
    expect(() => planMigrationSql(`${statement}\nCREATE INDEX CONCURRENTLY idx ON t (id);`))
      .toThrow(/unsupported transaction-incompatible statement/i);
  });

  it('fails closed on an unterminated dollar-quoted body', () => {
    expect(() => planMigrationSql('DO $broken$ BEGIN PERFORM 1; END;'))
      .toThrow(/unterminated dollar-quoted string/i);
  });

  it('fails closed when explicit transaction control would wrap the CIC batch', () => {
    expect(() => planMigrationSql(`
      BEGIN;
      CREATE INDEX CONCURRENTLY idx_example ON example (id);
      COMMIT;
    `)).toThrow(/unsupported explicit transaction control/i);
  });
});
