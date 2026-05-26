/**
 * Supabase mock factory — reusable across all dashboard API tests.
 *
 * Creates a chainable mock that mimics the Supabase PostgREST builder.
 * Every builder method returns `this` so chains like
 *   .from('x').select('*').eq('id', '1').single()
 * work without extra wiring.
 */
import { vi } from 'vitest';

export interface MockQueryBuilder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  lte: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: ReturnType<typeof vi.fn>;
}

export interface MockSupabase {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  storage: {
    from: ReturnType<typeof vi.fn>;
  };
  auth: {
    getUser: ReturnType<typeof vi.fn>;
  };
  /** Direct handle to the last query builder returned by .from() */
  _query: MockQueryBuilder;
  /** Map of table → MockQueryBuilder for multi-table tests */
  _tables: Map<string, MockQueryBuilder>;
}

/** Create a fresh chainable query builder. */
export function createMockQueryBuilder(): MockQueryBuilder {
  const builder: MockQueryBuilder = {} as MockQueryBuilder;
  const chainMethods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'ilike',
    'order', 'limit',
  ] as const;

  for (const method of chainMethods) {
    builder[method] = vi.fn().mockReturnThis();
  }

  // Terminal methods — resolve to { data, error }
  builder.single = vi.fn().mockResolvedValue({ data: null, error: null });
  builder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  builder.then = vi.fn().mockImplementation((resolve) => resolve?.({ data: null, error: null }));

  return builder;
}

/**
 * Build a full mock Supabase client.
 *
 * Usage:
 *   const { mock, query } = createMockSupabase();
 *   (createAdminSupabase as Mock).mockReturnValue(mock);
 *   query.single.mockResolvedValue({ data: { id: '1' }, error: null });
 */
export function createMockSupabase(): MockSupabase {
  const defaultQuery = createMockQueryBuilder();
  const tables = new Map<string, MockQueryBuilder>();

  const mock: MockSupabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (tables.has(table)) return tables.get(table)!;
      return defaultQuery;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: {
      from: vi.fn().mockReturnValue({
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.example.com/signed' } }),
      }),
    },
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    },
    _query: defaultQuery,
    _tables: tables,
  };

  return mock;
}

/**
 * Register a per-table mock so different .from('x') calls return distinct builders.
 *
 * const userQuery = registerTable(mock, 'users');
 * userQuery.single.mockResolvedValue({ data: { id: 'u1' }, error: null });
 */
export function registerTable(mock: MockSupabase, table: string): MockQueryBuilder {
  const builder = createMockQueryBuilder();
  mock._tables.set(table, builder);
  return builder;
}
