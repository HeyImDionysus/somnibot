import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../packages/supabase/migrations/20260818105000_portal_cancellation_operations.sql',
  import.meta.url,
);

test('failed cancellation history does not consume the current entitlement identity', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.doesNotMatch(sql, /entitlement_id\s+UUID\s+NOT NULL\s+UNIQUE/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX[\s\S]+ON public\.portal_cancellation_operations \(entitlement_id\)[\s\S]+WHERE status IN \('pending', 'uncertain', 'provider_confirmed', 'completed'\)/i,
  );
});

test('claim serialization precedes current-operation lookup and insertion', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const advisoryLock = sql.indexOf('pg_advisory_xact_lock');
  const currentLookup = sql.indexOf("operation.status IN ('pending', 'uncertain', 'provider_confirmed', 'completed')");
  const insertion = sql.indexOf('INSERT INTO public.portal_cancellation_operations');

  assert.ok(advisoryLock >= 0);
  assert.ok(currentLookup > advisoryLock);
  assert.ok(insertion > currentLookup);
});
