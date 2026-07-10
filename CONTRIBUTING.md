# Contributing to SomniBot

> This guide covers coding standards, patterns, and workflows for SomniBot development.

---

## Repository Structure

```
packages/
  bot/          # Discord bot (TypeScript, discord.js)
  dashboard/    # Admin dashboard (Next.js, Supabase auth)
  shared/       # Shared types and utilities
  supabase/     # Migrations, seed data, edge functions
  launcher/     # Desktop launcher (Electron)
  license-sdk/  # License validation SDK
```

## Critical Invariants

These are load-bearing rules. **Each one has caused, or nearly caused, a production
bug.** New code and reviews must uphold them; several are enforced by CI.

### Two separate economies — never conflate them

SomniBot has **two distinct money systems**:

- **Real paid store (actual money):** PayPal → dashboard webhook → `bot_action_queue`
  → `CommerceFulfillmentService` → entitlements, license keys, downloads, role grants.
  Tables: `products`, `orders`, `entitlements`, `license_keys`, `customers`.
- **Game economy (play money):** the `economy_*` tables — wallets, shop, market,
  lottery, heists, casino games, fishing/farming/etc.

Never route real-money events through game-economy tables or vice versa. Label
commerce records, queue jobs, and tests explicitly (`[commerce]` vs `[game-economy]`).
A past audit finding was exactly this confusion — commerce `purchase.completed` events
being looked up in the game `economy_items` table.

### Compliance wall — no real-money gambling

SomniBot has games of chance (lottery, casino, heist). Therefore:

- **Game currency is NEVER purchasable with real money.** Selling wagerable currency
  is gambling with real-world value → Discord policy, gambling-law, and PayPal AUP
  violations (merchant-account-freeze risk).
- Real money may grant only **account-bound** virtual goods: non-tradeable,
  non-market-listable, never convertible to currency. This blocks the
  item → market → coins laundering path.
- No `fulfillment_type` may credit a game wallet; commerce-granted items must be
  rejected from market listing.
- **A commerce-granted Discord role must not be eligible for game `economy_role_income`.**
  Otherwise a paid product grants a role, and the buyer later collects wagerable game
  currency from it — a real-money → game-currency path that bypasses the direct-credit
  ban above. Enforce this where role income is collected (exclude commerce-granted roles)
  or where a role is configured for income (reject roles used by paid products).

### Money paths — one source of truth

For any value that moves (real or game):

- **Freeze amounts** when they are committed; never re-derive a payout/refund from
  mutable config on a retry.
- **Do not duplicate *live, mutable* state** (e.g. a denormalized crew array *and* the
  participant rows it mirrors). Derive it instead. The heist feature took nine rounds of
  bugs to learn this — it now derives crew size and odds from the participant rows.
  **This does not apply to immutable snapshots frozen for money/entitlement rollback** —
  those are required: e.g. `entitlements.granted_role_ids` captures what was sold at
  purchase time so a later product edit can't retroactively revoke/re-grant the wrong
  roles. Freezing a snapshot is the *same* principle as "freeze amounts" above; deriving
  entitlement state from the mutable `products` record would be the bug.
- **Idempotent + retryable:** guard on a committed marker (e.g. `paid_at`), retry on
  failure, and finalize/announce only after the money commits.

## Getting Started

```bash
pnpm install          # Install all workspace dependencies
pnpm -r build         # Build all packages
pnpm --filter @somnibot/bot dev # Run the bot in dev mode
```

Use the pnpm version pinned by `packageManager` in the root `package.json`.
`pnpm-lock.yaml` is the only committed package-manager lockfile; do not commit
npm, Yarn, or Bun lockfiles.

## Key Patterns

### Guild Context

Every function that touches guild-specific data **must** use `getGuildId()` to extract the guild ID:

```ts
import { getGuildId } from '../guild-router.js';

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const guildId = getGuildId(interaction); // throws if not in guild
  // ... use guildId
}
```

**Never** access `client.guildId` directly in new code — it exists for legacy compatibility. Use `getGuildId(interaction)` or `GuildContext`.

### Error Handling

**No silent catches.** Every error must be logged with context:

```ts
// ❌ Bad
.catch(() => {});

// ✅ Good
.catch(err => {
  writeAuditLog(supabase, {
    guild_id: guildId,
    action: 'feature_name.operation',
    actorType: 'bot',
    actorId: 'system',
    description: `Failed to do X: ${err instanceof Error ? err.message : String(err)}`,
    severity: 'error',
  });
});
```

Valid `actorType` values: `'bot' | 'dashboard' | 'system' | 'discord'`

### Event Bus

Use the `PlatformEventBus` singleton for cross-feature communication:

```ts
import { eventBus } from '../services/event-bus.js';

// Emit (type, guildId, data)
eventBus.emit('member.verified', guildId, { discordId, username });

// Listen
eventBus.on('member.verified', async (event) => {
  console.log(event.type, event.guildId, event.data);
});
```

No `once()` method — use `on()` + `off()` manually if needed.

### Dashboard Auth

Every admin API route must call `requireGuildOwner()`:

```ts
import { requireGuildOwner } from '@/lib/api/require-owner';

export async function POST(request: Request) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;
  // ...
}
```

### Rate Limiting

Use `checkAdminRateLimit()` for API routes:

```ts
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const limited = await checkAdminRateLimit(request, 'write'); // 'standard' | 'write' | 'bulk'
if (limited) return limited;
```

## Testing

Tests live in `packages/<pkg>/src/__tests__/`. Build shared first, then run
the package tests:

```bash
pnpm --filter @somnibot/shared build
pnpm --filter @somnibot/bot test       # Bot tests
pnpm --filter @somnibot/bot test:watch # Watch mode
```

### Test Requirements

- All exported pure functions must have unit tests
- Business logic tests (escalation chains, state machines, validation)
- Use `vitest` — already configured per package
- Mock external deps (Supabase, Discord, Valkey) — never hit real APIs in tests

## Migrations

### Naming Convention

```
YYYYMMDDHHMMSS_descriptive_name.sql
```

Example: `20260601000004_v53_dead_table_cleanup.sql`

### Rules

1. **Always use `IF EXISTS` / `IF NOT EXISTS`** for DROP/CREATE to be idempotent
2. **Enable RLS** on every new table
3. **Include `guild_id`** column on every table (multi-guild support)
4. **Add indexes** for any column used in WHERE/ORDER BY with >10k rows expected
5. **Test migrations** against a fresh Supabase instance before merging
6. **`SECURITY DEFINER` functions must `SET search_path = ''` AND schema-qualify every
   reference.** With an empty search_path, unqualified names resolve to nothing and fail
   at **runtime** (not at apply time). Write `public.<table>` and `extensions.<fn>`
   (e.g. `extensions.gen_random_bytes`); `pg_catalog` functions such as `gen_random_uuid`
   are implicit and need no prefix. This class of bug caused a full lottery outage and a
   broken GDPR purge function. CI's `db-security-audit` checks that these functions set a
   `search_path`, and the `migration-lint` job runs `scripts/check-secdef-search-path.py`,
   which **automatically fails the build on unqualified extension-function references**
   (the lottery-outage class). Unqualified **table** references are NOT yet gated — the
   script's `--include-tables` mode is advisory only — so reviewers must still verify
   `public.<table>` qualification by hand.
7. **RLS policies must be role-scoped.** Never `CREATE POLICY ... FOR ALL USING (true)`
   without a `TO` clause on a table holding sensitive data — combined with the legacy
   anon default-grant window, that lets anyone with the publishable key read (and often
   write) the table directly. Lock sensitive tables to `service_role` and add them to
   `SENSITIVE_TABLES` in the CI `db-security-audit` job. Three tables shipped with this
   hole before it was found.
8. **For any table only the bot/dashboard-server touches**, `REVOKE ALL ... FROM PUBLIC,
   anon, authenticated;` then `GRANT ... TO service_role;` (the bot uses the service key;
   dashboard mutations go through `createAdminSupabase`).

### Timestamp Collisions

If two migrations have the same timestamp, suffix with `000001`, `000002`, etc.

### Database types (hand-maintained vs generated)

There are two type files, and they play different roles:

- `packages/shared/src/types/database.ts` is the **hand-maintained source of truth**
  imported by the bot and dashboard. When a migration changes the schema, update the
  corresponding `Db*` interface here by hand — with the correct nullability
  (`NOT NULL DEFAULT` → required non-null; nullable → `T | null`).
- `packages/shared/src/types/database.generated.ts` is a **generated tripwire snapshot**,
  not imported by app code. After **any** migration change, run
  `python scripts/generate-db-types.py` and commit the regenerated snapshot, or the
  required **DB Type Drift Check** CI job fails. Never hand-edit the generated file.

## Code Style

- TypeScript strict mode
- Explicit return types on exported functions
- No `any` — use `unknown` and narrow
- Prefer `const` over `let`
- Use `node:` prefix for Node.js imports (`import { EventEmitter } from 'node:events'`)
- Dashboard components: server components by default, `'use client'` only when needed

## Pull Request Process

1. Create feature branch: `feat/v<version>-<phase>-<description>`
2. All required CI checks must pass for the current head SHA: install, build, lint, typecheck, security, unit tests, migration lint, integration tests, and CI Gate
3. If a preview/deployment check exists for the branch, record whether it passed, failed, or is not relevant to the change
4. Before handoff or merge, include a PR review-thread ledger:
   - PR number, head SHA, base branch, CI run URL/status
   - every review thread with URL, path, resolved state, outdated state, and disposition
   - evidence for each fixed thread, such as code references, tests, CI, or a linked follow-up issue
   - any watcher/worker session IDs used, their final status, and any missing/failed watcher state
5. Do not call a PR done or merge-ready while a non-outdated review thread is unresolved unless it has a tracked blocker or follow-up explicitly accepted for later
6. Squash merge to `main` only after CI and review-thread ledger gates are clean

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): description
fix(scope): description
docs: description
chore: description
```
