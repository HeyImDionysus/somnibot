# SomniBot Bot Package

## Test Layout

Bot unit tests live under `src/__tests__/**/*.test.ts` and run with:

```bash
pnpm --filter @somnibot/bot test
```

Bot integration tests live under `src/__tests__/integration/**/*.integration.test.ts` and run with:

```bash
pnpm --filter @somnibot/bot test:integration
```

Do not add new colocated `*.test.ts` files under feature or service folders unless the package test convention is intentionally changed.

## Live Deploy E2E

`pnpm --filter @somnibot/bot test:e2e:deploy` is an opt-in live-resource check. It mutates Discord and Supabase, so it is not part of the default unit or CI test suite.

The script exits before connecting to Discord or Supabase unless all of these are true:

- `SOMNIBOT_DEPLOY_E2E_CONFIRMATION=I_UNDERSTAND_THIS_MUTATES_A_DISPOSABLE_DISCORD_GUILD_AND_LOCAL_SUPABASE`
- `NODE_ENV` is not `production`
- `DISCORD_GUILD_ID` matches `SOMNIBOT_E2E_DISPOSABLE_GUILD_ID`
- `SUPABASE_URL` points to local Supabase
- Discord and Supabase credentials are provided through environment variables
