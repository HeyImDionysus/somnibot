# Exact-candidate fleet observation bundle

Candidate: `f966761eb2ad3e0026422e61a1c4094abc37543a`

This record binds the unchanged 2,446-key operator ledger from `fc5d7b64ca30b68c648a6ebc6cddf68ee204f39d` to the final candidate and adds the two final PayPal observations. It does not replace an impacted live surface with a generic build. The current four strict manifests were compared by exact `(domain, scenario, assertion class)` key: all 2,446 prior keys remain present with no stale key, and the only two additions are the PayPal replay and portal-cancellation replay assertions described below.

## Exact-final structural and production readback

- GitHub CI run `32201940798` is bound to this exact SHA. All compile, type, lint, migration, package, unit, integration, live-stack, and four strict producer-shard jobs passed. The only failed job was the strict receipt aggregate before this candidate-bound receipt set existed.
- The four downloaded schema-v2 manifests identify this exact SHA, contain 46 unique catalog domains and 2,448 unique unresolved gate keys, and have no failed, errored, hung, duplicated, or missing domain report.
- The VPS checkout and all four production services identify this exact SHA. All services are healthy; 284/284 migrations are applied with no checksum drift; Supabase, Valkey, Lavalink, Discord gateway, public HTTPS, Caddy, and Tailscale checks passed.
- A scoped restart preserved Valkey state. The prior real rollback/recovery drill is non-impact reusable because the deployment and Compose boundary did not change; predeployment PostgreSQL and Valkey backups were checksum-verified and retained with mode `0600`.

## Real external and browser surfaces

- A real external webhook journey passed JSON and plain-text delivery, duplicate suppression, one-time URL rotation invalidation, disabled/deleted rejection, mention suppression, bounded attempts, durable delivered rows, Discord readback, and cleanup. The raw one-time URL and Discord identities were never recorded.
- The final dashboard inventory has 48 primary production PNGs: 16 routes at each of 375, 768, and 1280 pixels. Every route also passed live DOM readiness, no busy/loading residue, human-readable Discord names, no raw long IDs, and exact viewport-width overflow checks. Two independent visual reviewers returned PASS/HIGH against the same SHA and inventory.
- The final ChannelPicker change is dashboard-only. Prior live Discord interaction/readback for unchanged bot commands remains applicable; current exact-final bot packages and all strict producer shards passed. Temporary Discord resources and messages from the prior operator journeys were removed and rescanned.
- The prior owner-present production music journey observed audible first play, natural-end replay, forced-disconnect recovery with queue preservation, increasing playback position, and final Stop cleanup. Final music hardening preserves that normal playback boundary while adding durable outage fencing; exact-final music/type/build/integration gates and deployed Lavalink/Valkey health passed.

## Database, audit, Valkey, launcher, and license surfaces

- Prior hosted PostgreSQL scenario readbacks remain keyed to the same catalog assertions. The final candidate adds atomic occurrence fences, caller-side failure audits, retry-safe operations, and recovery state for the previously identified product gaps. Each focused real-PostgreSQL lane passed before integration; exact-final migration, type, build, live-stack, and strict shard jobs passed after integration.
- Prior persisted `audit_logs` observations remain applicable for unchanged actions. Newly changed denial, farming, profile, automation, moderation, ticket, statistics, store, commerce/license, and music audit seams have occurrence-keyed focused proof and are included in the exact-final CI-built tree.
- Prior Valkey cooldown, queue, and lock observations remain applicable for unchanged primitives. Exact-final deployment health, scoped restart persistence, and the final music queue recovery implementation cover the changed persistence boundary.
- The packaged launcher previously passed real Windows Local/VPS execution and Linux AppImage/runtime checks. Launcher code is unchanged by the final ChannelPicker-only UI delta; exact-final launcher CI and package gates passed.
- The live sandbox lifecycle has a real valid-then-revoked license validation history, inactive revoked session, expired entitlement, revoked key, completed fulfillment carrier, and no matching DLQ row. Exact-final provider and replay checks are described next.

## PayPal Sandbox exact-final observations

- Fresh provider authentication, disputes response shape, unapproved one-dollar order creation, exact order GET, and `PayPal-Request-Id` replay all passed on the deployed final SHA. The replay returned the same provider order and captured no sandbox money.
- A real stored sandbox lifecycle currently reads: provider order `COMPLETED`, capture `REFUNDED`, refund `COMPLETED`; local order `refunded`, payment `refunded`, one refund witness, entitlement `expired`, key `revoked`, zero active sessions, and both `valid` and later `revoked` license validations.
- The original signed event history contains successful capture-completed and capture-refunded events. The exact stored refund event was claimed once through the final replay fence and reposted to the deployed loopback webhook handler. It returned HTTP 200/success, incremented the replay counter once, retained exactly one payment/refund/fulfillment carrier, created no DLQ row, and left every customer-facing order, entitlement, license, session, and validation record unchanged.
- Exact-final portal-cancellation contract tests and the real-PostgreSQL cancellation-operation lane enforce one current provider request across duplicate/concurrent confirmations and immutable terminal history. The fresh Sandbox idempotency readback confirms the configured provider honors the request identity used by that rail.

## Source records and cleanup

- Reused ledger SHA-256: `fe5103f0d2b2c22ffa0c7707b54227779af52c3c94b67a977a37fd5f96f08e3c`
- Reused operator observation SHA-256: `e537e62e7aeb6b41464df3ea407d02752a3722c5544c34e4106324e23359450e`
- Final PayPal acceptance: `../paypal-final.md`
- Final webhook helper and visual capture inventory are under the same protected `final-release-f966` evidence root.
- Temporary VPS/container PayPal helpers were removed. The external webhook relay/messages were removed. Browser test tabs were closed and the user's original tab was preserved. Production data remains only in its correct terminal states.

Verdict: the 2,448 current strict-fleet gate keys have candidate-bound, content-addressed operator observations with exact-final refresh on every changed or runtime-sensitive boundary.
