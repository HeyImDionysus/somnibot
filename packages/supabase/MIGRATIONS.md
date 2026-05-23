# Migration Management

## Current State

- **70 migrations** (8,674 lines of SQL)
- All timestamped, snake_case named, validated by CI migration-lint

## Baseline Squash (V5 Audit §5.1)

The migration chain is long. On the next major release (e.g., V6), consider
squashing all existing migrations into a single baseline migration:

1. Dump the current schema: `supabase db dump --schema public > baseline.sql`
2. Replace all 70 migration files with a single `00000000000000_baseline.sql`
3. Test fresh `supabase db reset` against the squashed baseline
4. Verify all RLS policies, indexes, RPC functions, and grants are preserved
5. Document that existing deployments must be on V5 before upgrading to V6

**Do NOT squash in-place** — existing deployments track applied migrations in
`supabase_migrations.schema_migrations`. A squash requires a coordinated release.
