import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDbUrl } from './helpers.js';

const MIGRATION = '20260818104000_ticket_transcript_idempotency.sql';
const databaseName = `somnibot_ticket_transcript_${process.pid}_${Date.now()}`;
const cleanDatabaseName = `somnibot_ticket_clean_${process.pid}_${Date.now()}`;

describe('ticket transcript idempotency migration', () => {
  let adminSql: Sql | undefined;
  let sql: Sql | undefined;
  let cleanSql: Sql | undefined;
  let migrationSql = '';

  beforeAll(async () => {
    adminSql = postgres(getTestDbUrl(), { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(getTestDbUrl());
    databaseUrl.pathname = `/${databaseName}`;
    sql = postgres(databaseUrl.toString(), { max: 2 });
    await adminSql.unsafe(`CREATE DATABASE "${cleanDatabaseName}"`);
    const cleanDatabaseUrl = new URL(getTestDbUrl());
    cleanDatabaseUrl.pathname = `/${cleanDatabaseName}`;
    cleanSql = postgres(cleanDatabaseUrl.toString(), { max: 2 });
    const tableSql = `
      CREATE TABLE public.ticket_transcripts (
        id UUID PRIMARY KEY,
        guild_id TEXT,
        ticket_id UUID,
        html_content TEXT NOT NULL
      )
    `;
    await sql.unsafe(tableSql);
    await cleanSql.unsafe(tableSql);
    migrationSql = await readFile(
      resolve(process.cwd(), '../supabase/migrations', MIGRATION),
      'utf8',
    );
  });

  afterAll(async () => {
    await sql?.end();
    await cleanSql?.end();
    if (adminSql) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${cleanDatabaseName}" WITH (FORCE)`);
      await adminSql.end();
    }
  });

  it('fails closed and preserves every historical row when duplicates exist', async () => {
    // Given: two historical transcript rows for one guild/ticket pair.
    if (!sql) throw new Error('Isolated transcript database was not initialized');
    const ticketId = randomUUID();
    const rowIds = [randomUUID(), randomUUID()];
    await sql`
      INSERT INTO public.ticket_transcripts (id, guild_id, ticket_id, html_content)
      VALUES
        (${rowIds[0]}, ${'guild-duplicate'}, ${ticketId}, ${'first'}),
        (${rowIds[1]}, ${'guild-duplicate'}, ${ticketId}, ${'second'})
    `;
    // When: the exact migration runs against the conflicting history.
    let migrationError: unknown;
    try {
      await sql.unsafe(migrationSql);
    } catch (error) {
      migrationError = error;
    }

    // Then: the preflight reports only the conflicting identifiers/count and
    // leaves both historical rows unchanged.
    expect(migrationError).toBeInstanceOf(Error);
    expect(migrationError).toBeInstanceOf(postgres.PostgresError);
    if (!(migrationError instanceof postgres.PostgresError)) {
      throw new Error('Expected PostgreSQL duplicate-preflight failure');
    }
    expect(migrationError.message).toContain('ticket_transcripts duplicate preflight failed');
    expect(migrationError.detail).toContain('guild-duplicate');
    expect(migrationError.detail).toContain(ticketId);
    expect(migrationError.detail).toContain('count=2');
    const rows = await sql<Array<{ id: string; html_content: string }>>`
      SELECT id::text, html_content
        FROM public.ticket_transcripts
       ORDER BY html_content
    `;
    expect(rows).toEqual([
      { id: rowIds[0], html_content: 'first' },
      { id: rowIds[1], html_content: 'second' },
    ]);
  });

  it('enforces one transcript row for each guild and ticket pair', async () => {
    // Given: a clean transcript table with the exact migration applied.
    if (!cleanSql) throw new Error('Clean transcript database was not initialized');
    await cleanSql.unsafe(migrationSql);
    const ticketId = randomUUID();
    await cleanSql`
      INSERT INTO public.ticket_transcripts (id, guild_id, ticket_id, html_content)
      VALUES (${randomUUID()}, ${'guild-clean'}, ${ticketId}, ${'winner'})
    `;

    // When: a replay attempts to store a second transcript for the same pair.
    const replay = cleanSql`
      INSERT INTO public.ticket_transcripts (id, guild_id, ticket_id, html_content)
      VALUES (${randomUUID()}, ${'guild-clean'}, ${ticketId}, ${'replay'})
    `;

    // Then: PostgreSQL rejects the replay with the named uniqueness backstop.
    await expect(replay).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'ticket_transcripts_guild_ticket_key',
    });
    const [{ transcriptCount }] = await cleanSql<Array<{ transcriptCount: number }>>`
      SELECT count(*)::int AS "transcriptCount"
      FROM public.ticket_transcripts
      WHERE guild_id = ${'guild-clean'} AND ticket_id = ${ticketId}
    `;
    expect(transcriptCount).toBe(1);
  });
});
