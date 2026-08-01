# SomniBot 60-item walkthrough verification

Verified 2026-07-30 against the `codex/backlog-c-e` candidate and the owner's
provided Discord test guild. This document classifies the original 60-item
`WALKTHROUGH.md`; it does not replace functional proof with a manual checklist.

## What “verified” means

- **Functional**: adversarial code trace plus meaningful automated behavior,
  integration, or route tests.
- **Live readback**: authenticated, read-only Discord gateway evidence from the
  owner-provided test guild. The gate loads only `DISCORD_TOKEN`,
  `DISCORD_GUILD_ID`, and `DISCORD_APPLICATION_ID` into its process and never
  prints them.
- **Aesthetic pass**: the remaining human judgment about appearance, wording,
  voice, timing, or interaction feel. A functional failure observed during this
  pass is still a product bug.

Current live Discord readback:

- gateway authenticated and application identity matched;
- target guild and 26 channels readable;
- 14 text channels readable and sendable by the bot;
- bot role is above `@everyone`;
- 90 guild commands registered;
- every command named by the walkthrough is registered;
- `/setup` is registered with a non-empty description.

Repeat the gate with:

```powershell
$env:SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK='1'
pnpm discord:live-readback
```

The caller must inject the three approved Discord variables first. The script
does not read `.env`.

## Evidence bundles

- **Discord/live** — `scripts/discord-live-readback.mjs`.
- **Setup** — `setup-wizard-surfaces`, `setup-wizard`,
  `setup-verification-wizard-contract`, and `interaction-verification-gate`.
- **Bot/full** — the complete bot Vitest suite, plus the focused files named in
  the table: 274 files / 4,173 tests passed (2026-08-01, final candidate).
- **Dashboard/full** — the complete dashboard Vitest suite, including the
  focused route/UI files named in the table: 141 files / 2,103 tests passed
  (2026-08-01, final candidate).
- **Database** — 44 local PostgreSQL integration files / 604 tests passed; a
  final fresh-database twin (2026-08-01) applied all 243 migrations through
  `20260731130000` in order and live-asserted the newest semantics — stale
  occurrence reclaim, occurrence-owned ticket/temp-channel inserts, the
  per-occurrence idempotent scheduled-send reservation (same occurrence
  re-asked → same slot, counter unchanged; paid slot honored even at the send
  cap), interrupted-execution terminalization (a stale STARTED claim turns
  truthful without re-running; unstarted and held rows refused), and durable
  hold progress (lease renewals persist a lower bound that lease-expiry
  recovery restores into history instead of zeros). The security-definer
  audit passed across all 243 migration files / 283 effective function
  definitions, and regenerated database types have no drift.
- **Discord/deploy** — 23 guarded live-deployment assertions passed against the
  owner-provided test guild, including role hierarchy, channel creation,
  persisted mappings, audit, setup confirmation, and exact cleanup.
- **Scenario** — `administration-automations`: 43 PASS, 41 honestly GATED,
  0 FAIL, 0 findings. Remaining gates require an interaction-driving Discord
  user lane; basic gateway readback is now proven live.

## Item-by-item disposition

| # | Surface | Functional evidence | Aesthetic/live action |
|---:|---|---|---|
| 1 | Bot online | **Live readback passed**; health, heartbeat, presence, and boot-decision tests. | Confirm the presence text and status feel right. |
| 2 | Run `/setup` | **Live `/setup` registration passed**; real command builder and routing tests. | Open it as the server owner and judge the first response. |
| 3 | Complete setup wizard | Real embeds, button rows, modal fields, IDs, limits, completion and unreachable states are serialized and asserted. | Judge wording, field order, and flow pacing. |
| 4 | Dashboard sign-in | Dashboard auth, RBAC, CSRF, guild selection, and middleware tests. | Judge Discord OAuth handoff and landing-page feel. |
| 5 | Server Setup page | `server-setup`, `setup-route`, `setup-wizard-client`, readiness-path, deployer, and setup-gate tests. | Judge page clarity and progress presentation. |
| 6 | Branding | Branding route, brand-kit cache, branded embed, branding voice, and live Discord-fact tests. | Use a loud custom palette/voice and inspect visual consistency. |
| 7 | Settings | Settings route, validation, admin-change, and config-watcher tests. | Walk every field and judge labels/help text. |
| 8 | Roles and Channels | Live guild/channel/permission readback plus roles/channels route and picker tests. | Judge picker search, hierarchy warnings, and empty states. |
| 9 | Member joins | Welcome flow, variables, member service/backfill, audit, and owner-notification tests. | Join with a second account and inspect the delivered message. |
| 10 | Onboarding | Onboarding handlers, sync, role handling, and coverage tests. | Complete it as the second account and judge flow/copy. |
| 11 | Member leaves | Goodbye service and welcome/goodbye integration tests. | Leave and inspect final message appearance. |
| 12 | Reaction roles | Reaction engine, button roles, routing, and config reload tests. | Deploy and click with a second account; judge the panel. |
| 13 | Levels | XP tracker, multipliers, rewards, announcer, and members/levels DB integration. | Chat and inspect level-up timing/card appearance. |
| 14 | `/rank`, `/leaderboard` | Both commands are live-registered; rank-card parity and level-command tests pass. | Judge card readability and leaderboard pagination. |
| 15 | `/xp set` | Live-registered; XP admin permission and command coverage tests. | Run as an authorized admin and inspect confirmation copy. |
| 16 | AutoMod rule | AutoMod filters/actions/sync/observe-pipeline and dashboard validation tests. | Trigger a configured rule and inspect Discord feedback. |
| 17 | Warn/mute/kick | All commands live-registered; moderation command, audit, replay, and outage tests. | Exercise/undo actions and judge moderator/member feedback. |
| 18 | Infractions | Live command registration, moderation DB integration, idempotency, escalation, and route tests. | Compare dashboard and Discord presentation. |
| 19 | Appeals | Appeal command/manager plus dashboard decision-route tests. | Submit and decide an appeal; judge both sides' wording. |
| 20 | Anti-raid | Config integration, resume, auto-unban, audit, and staged action tests. | Optional controlled simulation for timing/notification feel. |
| 21 | Message log | Edit/delete coverage, occurrence dedupe, degraded behavior, audit, and privacy tests. | Edit/delete a real message and inspect formatting. |
| 22 | Tickets | Panel controls, interactions, transcripts, claims, audit, and per-guild numbering integration. | Open/claim/close a ticket and judge panel/transcript UX. |
| 23 | Polls | Live command registration, vote/prediction ledger, manager, and DB integration tests. | Vote from two accounts and inspect updates. |
| 24 | Giveaways | Live command registration, entry, fulfillment, prize snapshot, reroll, audit, and DB integration. | Run through expiry/reroll and inspect messages. |
| 25 | Starboard | Star threshold, self-star, audit, and ship-on-default tests. | Cross the threshold and judge the starboard post. |
| 26 | Scheduled messages | Delivery, retry, latest/skip policy, occurrence fence, audit, and integration tests. | Schedule a near-term post and inspect timing/render. |
| 27 | Embeds | Branded-embed, brand-kit, variable-chip target, validation, and allowed-mention tests. | Build/send one and judge preview parity. |
| 28 | Custom commands | Engine, degraded-path, audit, execution-result, routing, and scenario evidence. | Run success and deliberately broken actions; judge explanations. |
| 29 | Tutorial | Live command registration and tutorial engine coverage. | Judge navigation, wording, and completion feel. |
| 30 | Shop | Live commands plus atomic buy, inventory, shop, item, and role-income-wall tests. | Walk CRUD and member commands; inspect currency branding. |
| 31 | Core economy | Every named command live-registered; wallet, transfer, cooldown, ledger, and economy-manager tests. | Judge command copy and custom currency consistency. |
| 32 | Games | Every named command live-registered; game manager, wager, loss-limit, audit, and Valkey-lock tests. | Play each and judge pacing/embeds. |
| 33 | Gathering/crafting | Live commands, recipes DB integration, atomic consumption, audit, and manager tests. | Judge item/currency wording and result embeds. |
| 34 | Farming | Live command plus seed-honesty, plant/water/harvest/fertilize, audit, and manager tests. | Confirm dashboard crop copy matches real seed behavior. |
| 35 | Fishing | Live command, rarity, collection reward, idempotency, and manager tests. | Inspect rarity colors and branded collection views. |
| 36 | Market | **Live failure found and repaired**: `/market` is now always registered and hot-configurable; disabled enforcement, atomic listing/buy/cancel, idempotency, and DB tests pass. Live re-readback confirms registration. | Walk list/browse/buy/my-listings/cancel and judge presentation. |
| 37 | Pets/quests/achievements | All commands live-registered; pet battle/decay, quest progress, badges, prestige, reward, and failure tests. | Judge cards, progress feedback, and reward wording. |
| 38 | Trivia | Live command, schedules, payouts, streaks, retries, audit, and action-queue tests. | Let two rounds finish and inspect timing/results. |
| 39 | Lottery/heist/adventure | All commands live-registered; atomic lottery, heist resume, adventure choices, audit, and idempotency tests. | Judge the three flows and brand consistency. |
| 40 | Double-click safety | Game Valkey locks, deterministic request IDs, action-queue idempotency, and crafting/fishing/adventure regression tests. | Double-click once to judge visible duplicate suppression. |
| 41 | Music | All named commands live-registered; queue, filters, player, embeds, audit, and status tests. | Requires voice playback to judge audio and controls. |
| 42 | Temp channels | Live `/voice`; hub/template/control, cleanup, occurrence, audit, and permission tests. | Join a hub and judge room message/control UX. |
| 43 | Stats channels | Stats lifecycle, throttling, alert, cleanup, and audit tests. | Inspect names and update cadence in Discord. |
| 44 | Store/promotions | Live `/store`; products, promotions, control-room, tenant, entitlement, and PayPal-readiness tests. | Create a sandbox product/promotion and judge dashboard UX. |
| 45 | PayPal sandbox checkout | Checkout/webhook/refund/reconcile/idempotency tests; live sandbox authentication passed, disputes shape passed, and request-ID replay returned the same unapproved order. **Transaction Search is externally blocked by PayPal `403 NOT_AUTHORIZED`.** | Enable Transaction Search permission, rerun `pnpm paypal:sandbox-pass`, then complete buyer approval and judge checkout/return UX. |
| 46 | Orders/customers/licenses | Order, customer, entitlement, license lifecycle/session/heartbeat/tenancy tests and DB integration. | Inspect populated pages after the approved sandbox purchase. |
| 47 | Receipt DM | Receipt builder/delivery, branding, license-key, and failure tests. | Inspect the real DM after the approved sandbox purchase. |
| 48 | Customer portal | Portal auth/scope, device removal, key rotation, session reuse, and license tests. | Judge buyer sign-in and device/key controls. |
| 49 | Store requests | Portal request, notifier, dashboard decision, audit, and tenancy tests. | File/decide one request and judge both views. |
| 50 | Fraud | Fraud signal/detection tests, R2 request cache, R3 create/edit form, route validation, and observation-clock DB tests. | Configure alerts and judge rule editor/explanations. |
| 51 | Admin Changes | Record, allowlisted undo, Discord undo, route-mirror, and non-reversible action tests. | Judge descriptions and undo confirmation UX. |
| 52 | Audit | Audit service drain/recovery, occurrence keys, retention, category rows, and route/page tests. | Judge filters, detail view, and export readability. |
| 53 | Diagnostics | Health snapshots, guidance, alerts, audit, and failure tests. | Judge operator guidance and live status readability. |
| 54 | Operations surfaces | Incidents, alerts, action queue, workflows/automations, sync, analytics, retry, and admin-change tests. | Walk pages and judge information hierarchy. |
| 55 | Team | RBAC roles/users, invitation accept/revoke/decline/expiry, CSRF invalidation, and audit tests. | Invite a real collaborator and judge the invite/access flow. |
| 56 | Retention/privacy | Live `/mydata` and `/forgetme`; export, erasure marker, retained-validation wording, and privacy tests. | Read the final wording as a member and judge clarity. |
| 57 | Database outage | Moderation, custom-command, message-log, download, license, audit, diagnostics, and content-seeder outage tests. | Optional controlled outage to judge visible degraded copy. |
| 58 | Restart mid-operation | Bot shutdown, audit residue recovery, anti-raid/heist reconciliation, session reuse, occurrence fences, and scenario restart evidence. | Optional controlled restart to judge visible recovery. |
| 59 | `@everyone` safety | Full allowed-mentions sweep plus welcome, giveaway, tickets, temp-channel, message-log, and automation tests. | Post one literal mention to confirm the visible text is inert. |
| 60 | Invalid config | Real PostgreSQL CHECK constraints, reference-shape/snowflake/URL validation, route validation, and config tests. | Enter bad values and judge the inline error copy. |

## Current blockers and residual live work

1. PayPal Transaction Search permission is denied by the sandbox account
   (`403 NOT_AUTHORIZED`). Credentials and the other sandbox capabilities are
   valid. This is an external account permission, not a missing-credential gate.
2. The remaining actions in the last column are the human aesthetic pass or
   deliberately controlled external-event checks. They do not replace the
   functional evidence above.
3. Any functional failure found while doing those actions is a release blocker,
   not a cosmetic waiver.
