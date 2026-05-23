# SomniBot V2 Roadmap — Audit-Driven Improvements

Tracking items from the Production Readiness Audit V2 that are deferred to V2 or require ongoing work.

## CSP Nonce for Next.js (Finding 3.6)

**Status**: Tracked for Next.js upgrade cycle
**Priority**: Low (current `unsafe-inline` is standard for Next.js apps)

### Current State
- `next.config.mjs` uses `unsafe-inline` in `style-src` CSP directive
- This is the Next.js default — required for Next.js's inline style injection
- No XSS vector exists because all user input is sanitized server-side

### Migration Path
1. Wait for Next.js to ship built-in CSP nonce support (tracking: [next.js#42177](https://github.com/vercel/next.js/discussions/42177))
2. When available, add `nonce` to `<script>` and `<style>` tags via middleware
3. Replace `unsafe-inline` with `nonce-{random}` in CSP header
4. Test all dashboard pages for style breakage

### Workaround (if needed before Next.js support)
- Use `next-secure-headers` package with nonce middleware
- Inject nonce into `_document.tsx` for all inline scripts/styles

---

## Multi-Guild Boot (Finding 9.1)

**Status**: Tracked for V2
**Priority**: Low (single-guild boot is correct for V1 self-hosted model)

### Current State
- Bot boots with a single primary guild (`client.guildId`)
- `GuildRouter` exists and handles multi-guild event routing
- Feature managers are initialized for primary guild only
- This is intentional for V1: each instance serves one server

### V2 Migration Plan
1. **Lazy feature initialization**: Initialize feature managers per-guild on first event
2. **Config per guild**: Move `guild_config` lookups to be guild-scoped (already done)
3. **Resource limits**: Add per-guild memory/connection budgets
4. **Shared instance mode**: Allow one bot process to serve N guilds with resource isolation
5. **Testing**: Add integration tests for cross-guild event isolation

### Why V1 is Fine
- Self-hosted model = one bot per server
- The `GuildRouter` already routes events correctly
- No customer has requested multi-guild support
- Adding it prematurely would increase complexity without benefit

---

## Ongoing Improvements

### Structured Logger Adoption (Finding 6.1)
- [x] Economy manager — migrated in PR #87
- [x] Commerce fulfillment — migrated in PR #87
- [ ] Auth flows (packages/dashboard/src/lib/auth/)
- [ ] Webhook handlers (packages/dashboard/src/app/api/webhooks/)
- [ ] Remaining bot event handlers (~37 files with console.* calls)

### API Route Tests (Finding 12.2)
- [ ] Add integration test framework (vitest + supertest or similar)
- [ ] Priority routes to test:
  - `POST /api/members/bulk` (validated in PR #86)
  - `POST /api/store/files` (validated in PR #86)
  - `POST /api/webhooks/paypal` (payment processing)
  - `POST /api/automations` (automation CRUD)
  - `GET /api/economy` (economy config)
