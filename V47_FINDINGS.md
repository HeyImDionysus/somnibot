# V47 Comprehensive Audit — Findings

Branch: `audit/v47` ⟸ `main@2215335`

## CRITICAL (3)

### C-1. `resolvePrediction` not idempotent → double payouts
**File:** `packages/bot/src/features/polls/polls-manager.ts:404-485`

`/predict resolve` only verifies `prediction.creator_user_id === interaction.user.id`. It does **not** verify the prediction is still in `status='open'/'locked'`. Concurrent / spammed `/predict resolve` calls (or a deferReply gap + retry) re-walk the bet list and call `economy_add_balance` for every winner *again*. Money is created out of thin air.

Fix: replace the start of `resolvePrediction` with an atomic guarded UPDATE
```sql
UPDATE predictions
SET status='resolved', winning_option_id=$1, resolved_at=now()
WHERE id=$2 AND status IN ('open','locked')
RETURNING *
```
If 0 rows are returned the resolve attempt is rejected. Read `total_pool` from the RETURNING row so concurrent late bets cannot inflate the prize.

### C-2. Refund endpoint missing guild scope → cross-tenant order takeover
**File:** `packages/dashboard/src/app/api/orders/[id]/refund/route.ts`

`POST /api/orders/[id]/refund` only verifies the caller is *a* guild owner via `requireGuildOwner()`. The order row is fetched by id alone, with no `.eq('guild_id', guildId)` constraint. An attacker who owns guild B can refund and revoke entitlements + license keys for any order in guild A by sending its UUID. A PayPal refund is issued in guild A's name.

Same issue in:
* `GET /api/orders/[id]` — leaks customer email, license keys, payments of any order.
* `GET /api/license-keys/[key]` and `PUT /api/license-keys/[key]` — revoke any license key by UUID.
* `DELETE /api/license/sessions/[id]` — revoke any device session by UUID.
* `GET /api/license/sessions?key_id=…` — list sessions for any license key.
* `GET /api/customers/[id]` + `GET/POST/PUT /api/customers/[id]/entitlements` — read/modify any customer.
* `POST /api/webhooks/[id]/replay` — replay any webhook event.
* `GET /api/webhooks` — list all PayPal events globally.

These are batched as one fix (helper `assertGuildScopedRow`). Severity stays CRITICAL because under multi-tenant deployment (current schema supports it), any owner can revoke billing artifacts and trigger PayPal refunds for an unrelated guild.

### C-3. Webhook replay is broken AND missing refund handlers
**Files:**
* `packages/dashboard/src/app/api/webhooks/[id]/replay/route.ts`
* `packages/dashboard/src/app/api/paypal/webhook/route.ts`

`replay/route.ts` re-POSTs the stored payload to `/api/paypal/webhook` with an `X-Replay-Secret` header, but the webhook handler does **not** look at that header — it unconditionally calls `verifyWebhookSignature()` which forwards the *missing* `paypal-*` headers to PayPal's verify endpoint and gets `FAILURE`. Result: every replay returns 401 and the webhook is never re-processed. Failed events stay stuck forever.

Additionally `paypal/webhook/route.ts` switch covers `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `BILLING.SUBSCRIPTION.{ACTIVATED,CANCELLED,SUSPENDED}` and `PAYMENT.SALE.COMPLETED`, but **not** `PAYMENT.CAPTURE.REFUNDED` or `PAYMENT.CAPTURE.REVERSED`. Refunds initiated outside the dashboard (PayPal back-office, chargebacks, disputed transactions) are silently dropped — orders stay `completed`, entitlements stay `active`, license keys stay valid, paid roles are never revoked. Customer keeps benefits after refund.

Fix:
1. In webhook handler: if `X-Replay-Secret` matches the derived secret, bypass `verifyWebhookSignature` (replay is trusted because the row already exists in `webhook_events`).
2. Add `handleRefund(resource)` that looks up the order via `paypal_payment_id`, marks order `refunded`, expires entitlements + revokes license keys, and enqueues a `revoke_roles` bot action for any active role grants.

## MEDIUM (4)

### M-1. Fishing `consumeBait` ignores RPC return → free fish on race
**File:** `packages/bot/src/features/fishing/fishing-manager.ts:196-218`

`consumeBait` selects one bait row (qty>0), then calls `economy_decrement_inventory` but discards the boolean return. Under concurrent `/fish` calls, the FOR-UPDATE lock in the RPC means only one decrement succeeds; the loser sees `false` but the caller still proceeds to award fish, so 1 bait yields 2+ catches. (V44 fixed the same class for adventures/farming/gathering/crafting; fishing was missed.)

Fix: check the return value. If `false`, abort fishing and return null (treat as no-bait).

### M-2. `placeBet` debits before insert → silent coin loss on unique-bet race
**File:** `packages/bot/src/features/polls/polls-manager.ts:370-385`

Order is: pre-check existing bet → `economy_subtract_balance` → `prediction_bets` insert → `economy_increment_prediction_pool`. The `UNIQUE(prediction_id, user_id)` constraint will throw on the insert if two `/predict bet` invocations race past the existing-bet check — but the user has already been debited. Their coins evaporate.

Fix: insert bet first (let UNIQUE be the source of truth), then debit; on debit failure, delete the bet. Or even simpler — wrap both in a single SQL transaction via a new RPC.

### M-3. `economy_decrement_inventory` return value also ignored in other places
**Files:**
* `packages/bot/src/features/economy/economy-manager.ts:802` — padlock decrement.
* `packages/bot/src/features/adventures/adventure-manager.ts:828` — `economy_upsert_inventory` (write only, fine), but the surrounding code does not gate on durability decrement results.

Audited the rest; only `economy-manager` line 802 silently ignores `false`. The padlock branch promises the user the padlock protected them and was "consumed", but if the decrement returns false (already consumed by a concurrent attempt) we still apply the cooldown + tell the victim a padlock was consumed. Misleading but not a money-loss bug; rolled into the same fix as M-1 for consistency.

### M-4. Games `dailyLosses` is in-memory only → restart-bypass on loss limit
**File:** `packages/bot/src/features/games/games-manager.ts:68-94`

`economy_daily_loss_limit` is enforced via a `Map<string, number>` cleared at the next UTC midnight. Every bot restart wipes the counters, so a user can bypass the daily loss cap by waiting for any deploy/restart. Persist counters per (guild_id, user_id, utc_date) in a small DB table.

Fix: new `economy_daily_losses` table + new `economy_increment_daily_loss` RPC returning the new total; replace the Map.

## LOW (2)

### L-1. Cross-feature-bridge grants level-reward roles without honoring `remove_at_level`
**File:** `packages/bot/src/services/cross-feature-bridge.ts:64-86`

On `level.up`, the bridge `member.roles.add(reward.role_id)`. It does not consult `level_rewards.remove_at_level`, and it duplicates work already done by `level-announcer.ts` (which DOES handle removal). Result: stacked roles, plus a second source of truth that can disagree with the announcer.

Fix: delete the bridge handler; level-announcer is the canonical path.

### L-2. `closePoll` not idempotent
**File:** `packages/bot/src/features/polls/polls-manager.ts:200-242`

`/poll close` updates `status='closed'` without checking the current status, then sends a fresh embed with vote counts. Calling it twice posts the closed-poll embed twice and resets `closed_at`. No money lost, but cosmetic dupe.

Fix: gate UPDATE on `WHERE status='open'`, only proceed if a row was modified.

---

## Out of scope (not bugs)

* `handleUse` stub (V32+) — known.
* `handleCollectIncome` deferReply — known.
* Game commands deferReply — known.
* `next lint` CI step — known.
* `requireGuildOwner` `.single()` — works because deployment is single-guild-per-owner.
