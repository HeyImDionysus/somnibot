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

## Getting Started

```bash
pnpm install          # Install all workspace dependencies
pnpm -r build         # Build all packages
pnpm --filter bot dev # Run the bot in dev mode
```

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

Tests live in `packages/<pkg>/src/__tests__/`. Run with:

```bash
pnpm --filter bot test       # Bot tests
pnpm --filter bot test:watch  # Watch mode
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

### Timestamp Collisions

If two migrations have the same timestamp, suffix with `000001`, `000002`, etc.

## Code Style

- TypeScript strict mode
- Explicit return types on exported functions
- No `any` — use `unknown` and narrow
- Prefer `const` over `let`
- Use `node:` prefix for Node.js imports (`import { EventEmitter } from 'node:events'`)
- Dashboard components: server components by default, `'use client'` only when needed

## Pull Request Process

1. Create feature branch: `feat/v<version>-<phase>-<description>`
2. All CI checks must pass (Install, Build, Lint, Typecheck, Security, Unit Tests, Migration Lint, Vercel)
3. Squash merge to `main`
4. Vercel auto-deploys dashboard on merge to `main`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): description
fix(scope): description
docs: description
chore: description
```
