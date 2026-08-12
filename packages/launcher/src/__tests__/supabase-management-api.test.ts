import { describe, expect, it } from 'vitest';
import {
  getSupabaseProjectCredentials,
  getSupabaseSessionPoolerTemplate,
  listSupabaseProjects,
  updateSupabaseDatabasePassword,
} from '../main/supabase-management-api.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Supabase Management API project discovery', () => {
  it('lists only valid project summaries and never exposes token material', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const result = await listSupabaseProjects(' sbp-test-token ', {
      baseUrl: 'https://management.test',
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return response([
          { id: 'first-project', name: 'First project', region: 'us-east-1', status: 'ACTIVE' },
          { ref: 'second-project', name: 'Second project' },
          { id: 'not a valid ref', name: 'Ignore this row' },
        ]);
      },
    });

    expect(result).toEqual({
      ok: true,
      projects: [
        {
          ref: 'first-project',
          name: 'First project',
          region: 'us-east-1',
          status: 'ACTIVE',
          url: 'https://first-project.supabase.co',
        },
        {
          ref: 'second-project',
          name: 'Second project',
          url: 'https://second-project.supabase.co',
        },
      ],
    });
    expect(requests).toEqual([{
      url: 'https://management.test/v1/projects',
      authorization: 'Bearer sbp-test-token',
    }]);
    expect(JSON.stringify(result)).not.toContain('sbp-test-token');
  });

  it('normalizes current and legacy API key shapes for a selected project', async () => {
    let requestUrl = '';
    const result = await getSupabaseProjectCredentials('sbp-test-token', 'project-ref', {
      baseUrl: 'https://management.test',
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return response([
          { type: 'publishable', api_key: 'sb_publishable_value' },
          { type: 'legacy', name: 'service_role', api_key: 'eyJ_service_value' },
        ]);
      },
    });

    expect(result).toEqual({
      ok: true,
      credentials: {
        project: {
          ref: 'project-ref',
          name: 'project-ref',
          url: 'https://project-ref.supabase.co',
        },
        secretKey: 'eyJ_service_value',
        publishableKey: 'sb_publishable_value',
      },
    });
    expect(requestUrl).toBe('https://management.test/v1/projects/project-ref/api-keys?reveal=true');
    expect(JSON.stringify(result)).not.toContain('sbp-test-token');
  });

  it('returns an actionable permission error without leaking response bodies', async () => {
    const result = await listSupabaseProjects('sbp-test-token', {
      fetchImpl: async () => response({ error: 'token value must never be surfaced' }, 403),
    });

    expect(result).toEqual({
      ok: false,
      code: 403,
      error: 'The Supabase Management API token is missing the required permission or is not accepted.',
    });
    expect(JSON.stringify(result)).not.toContain('token value must never be surfaced');
  });

  it('rejects a blank token and invalid project reference before making network calls', async () => {
    const fetchImpl = async () => {
      throw new Error('must not be called');
    };
    await expect(listSupabaseProjects('   ', { fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'Enter a Supabase Management API token first.',
    });
    await expect(getSupabaseProjectCredentials('sbp-test-token', 'not a ref', { fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'Supabase project reference is invalid.',
    });
  });

  it('updates a database password without returning the password material', async () => {
    let request: { url: string; method: string | undefined; body: string | undefined } | undefined;
    const result = await updateSupabaseDatabasePassword('sbp-test-token', 'project-ref', 'a'.repeat(32), {
      baseUrl: 'https://management.test',
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        };
        return response({ message: 'updated' });
      },
    });

    expect(result).toEqual({ ok: true, updated: true });
    expect(request).toEqual({
      url: 'https://management.test/v1/projects/project-ref/database/password',
      method: 'PATCH',
      body: JSON.stringify({ password: 'a'.repeat(32) }),
    });
    expect(JSON.stringify(result)).not.toContain('a'.repeat(32));
  });

  it('returns a password-free IPv4 session-pooler template', async () => {
    const result = await getSupabaseSessionPoolerTemplate('sbp-test-token', 'project-ref', {
      baseUrl: 'https://management.test',
      fetchImpl: async (input) => {
        expect(String(input)).toBe('https://management.test/v1/projects/project-ref/config/database/pooler');
        return response([{
          database_type: 'PRIMARY',
          db_user: 'postgres',
          db_host: 'aws-0-ca-central-1.pooler.supabase.com',
          db_port: 5432,
          db_name: 'postgres',
          pool_mode: 'session',
        }]);
      },
    });

    expect(result).toEqual({
      ok: true,
      connectionTemplate: 'postgresql://postgres.project-ref@aws-0-ca-central-1.pooler.supabase.com:5432/postgres',
    });
    expect(JSON.stringify(result)).not.toContain('sbp-test-token');
  });

  it('derives the documented session port from a primary shared transaction-pooler row', async () => {
    const result = await getSupabaseSessionPoolerTemplate('sbp-test-token', 'project-ref', {
      fetchImpl: async () => response([{
        database_type: 'PRIMARY',
        db_user: 'postgres',
        db_host: 'aws-0-ca-central-1.pooler.supabase.com',
        db_port: 6543,
        db_name: 'postgres',
        pool_mode: 'transaction',
      }]),
    });
    expect(result).toEqual({
      ok: true,
      connectionTemplate: 'postgresql://postgres.project-ref@aws-0-ca-central-1.pooler.supabase.com:5432/postgres',
    });
  });

  it('rejects ambiguous primary shared-pooler metadata', async () => {
    const row = {
      database_type: 'PRIMARY',
      db_user: 'postgres',
      db_host: 'aws-0-ca-central-1.pooler.supabase.com',
      db_port: 6543,
      db_name: 'postgres',
      pool_mode: 'transaction',
    };
    const result = await getSupabaseSessionPoolerTemplate('sbp-test-token', 'project-ref', {
      fetchImpl: async () => response([row, row]),
    });
    expect(result).toEqual({
      ok: false,
      error: 'Supabase did not return one unambiguous primary shared-pooler endpoint for this project.',
    });
  });

  it('rejects an untrusted pooler host', async () => {
    const result = await getSupabaseSessionPoolerTemplate('sbp-test-token', 'project-ref', {
      fetchImpl: async () => response([{
        database_type: 'PRIMARY',
        db_user: 'postgres',
        db_host: 'pooler.supabase.com.evil.example',
        db_port: 5432,
        db_name: 'postgres',
        pool_mode: 'session',
      }]),
    });
    expect(result).toEqual({
      ok: false,
      error: 'Supabase did not return a trusted session-pooler host for this project.',
    });
  });
});
