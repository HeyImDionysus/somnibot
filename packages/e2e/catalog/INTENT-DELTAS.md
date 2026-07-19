# E2E Catalog — Intent-vs-Code Deltas (v1 acceptance backlog)

Generated during 46-domain catalog authoring. 184 flags: 41 decision-vs-code conflicts, 18 missing-surface gaps, 5 behavior bugs, 120 flagged defaults.

Each item is where the catalog (the owner's LOCKED intent) diverges from current code. The catalog authors the INTENT; these deltas are the implementation work list for goal-plan steps 3-5 (SAFE blockers + domain completion) and the adjudication list surfaced per-domain when real-stack proofs run (definition of done). Nothing here is a catalog error — it is the known gap between intent and today's code.

## accelerated
- **[DEFAULT]** Accelerated growth/harvest windows assumed available to the E2E harness (time-travel/timer injection) since real timers are hours-to-days; DEF/RESTART/SET-A depend on this.

## achievements
- **[GAP]** Achievements exactly-once gap: checkAndUnlock() in achievements-manager.ts is read-then-insert (non-atomic), and prestige() zeroes the wallet before writing the prestige record (non-atomic). Contract asserts exactly-once unlock under RACE/REPLAY and atomic all-or-nothing prestige (failures: prestige-partial-write); E2E will expose these code gaps for a user decision.

## anti
- **[DEFAULT]** ANTI-LAUNDERING WALL NOT ENFORCED IN CODE (locked decision wins): economy_items.tradeable column exists, but economy_market_atomic_create_listing (20260709120000) and MarketManager.listItem() never check tradeable/commerce-origin before escrowing inventory — a commerce-granted item is currently listable. Contract authored to require rejection (INVALID/UNAUTH + failure commerce-item-list-blocked); code change needed to actually gate the listing path.

## audit
- **[CONFLICT]** audit: AuditService re-queue is bounded at 500 entries and can drop under prolonged outage; contract requires durable zero-loss buffering per never-deleted decision (code conflict)
- **[DEFAULT]** audit: retention scrub authored as anonymize-personal-data-in-place with rows retained (consistent with anonymize-over-delete decision B); code retention purge behavior not verified against this
- **[GAP]** audit REPLAY: AuditService has no occurrence-level dedupe on event redelivery; contract requires one row per occurrence (code gap)
- **[DEFAULT]** audit CLEANUP: reconciled run-cleanup with never-delete — teardown anonymizes run identifiers in audit rows in place, deletes zero audit rows
- **[GAP]** audit: decision requires tamper-evident trail; code writes plain audit_logs rows with no update/delete protection surfaced at the API layer. Contract asserts rows are never updated or deleted (anonymize-over-delete, retention scrub anonymizes in place per merged PR behavior); tamper-evidence enforcement mechanism is the gap to prove.
- **[CONFLICT]** audit: /api/audit gates on requireGuildOwner while shared RBAC defines dashboard.view_audit for admin/moderator/support/finance system roles — least-privilege conflict; contract authors permission-gated access (view_audit suffices), current code will fail UNAUTH/SET scenarios for non-owner roleholders.

## authored
- **[DEFAULT]** Authored controls not yet in code (deep-config theme): tickets inactivity-warn-hours/inactivity-close-hours (currently hardcoded 24h/48h defaults in checkInactiveTickets options) and feedback-prompt-enabled; message-logging log-edits-enabled, log-deletes-enabled, ignored-channel-ids (code has only message_log_enabled + message_log_channel_id).
- **[DEFAULT]** Authored owner-notification alert on ending-payout failure (payout-delayed, ownerNotification:true); code today only marks the session row status=payout_failed for admin investigation and sends NO owner alert.
- **[DEFAULT]** Authored requirement that the completion embed flags a delayed payout instead of showing false success; current endSession() still renders the success/rewards embed even when economy_add_balance fails.
- **[DEFAULT]** Authored audit events adventures.ticket_refunded / adventures.payout_failed / adventures.backend_unavailable; no such audit emission exists in the adventure feature code today.

## automations
- **[CONFLICT]** automations: durable exactly-once execution decided, but engine uses in-memory occurrenceId with no durable occurrence pipeline (known pending follow-up); REPLAY/RESTART scenarios authored to the decision (code conflict)
- **[GAP]** automations: preview-before-enable (preview-required default true) and mass-action guard (threshold 25, 'held' state) authored per decisions; neither exists in code today (code gap)
- **[DEFAULT]** automations DEPFAIL: with Valkey down, chose fail-safe suppression of fires (never unlimited firing); code currently throws inside processAutomation with unspecified net behavior
- **[GAP]** automations: owner decision requires durable exactly-once execution, but the engine (packages/bot/src/features/automations/automation-engine.ts) uses an in-memory occurrenceId that does not survive restart or gateway redelivery (matches the pending 'wire automation durable-occurrence pipeline' follow-up). Contract authors durable occurrence dedupe; REPLAY/RESTART scenarios will surface the gap.
- **[DEFAULT]** automations: mass-action guard (hold-for-owner-confirmation above a per-occurrence member threshold, default 25) is decision-driven; no such guard exists in code today. Threshold default chosen per guardrails theme and flagged.

## behavior
- **[BUG]** BEHAVIOR BUG to surface (infractions): code applies punishment BEFORE writing the infraction record and does not roll back on insert failure (commands.ts mute path: member.timeout at line 281, createInfraction at 299; kick/ban DM+action also precede the insert). Contract's infraction-write-failed failure authors the stricter rule 'no punishment stands without its auditable record - already-applied timeout is rolled back'; needs user decision + code change.
- **[BUG]** BEHAVIOR GAP (anti-raid replay safety): recordJoinAndCount zadds a fresh randomUUID member per event (anti-raid/index.ts:227), so a re-delivered guildMemberAdd gateway event would double-count the sliding window. Contract's REPLAY scenario requires each real join to count exactly once; join-event dedup keying needs implementing.

## both
- **[BUG]** both domains: current music embeds use hardcoded emoji/English strings with no white-label brand voice or powered-by-SomniBot attribution; contract requires owner-branded voice + subtle attribution on every music surface per the cross-cutting decision — proof suites will surface this as a behavior gap

## bounded
- **[CONFLICT]** Bounded prestige conflict: decision says bounded, but achievements-manager.ts prestige() has no cap. Authored prestige-max-level control (default 10, i.e. +100% multiplier ceiling) with a prestige-capped state/message; not in code.

## branding
- **[CONFLICT]** Branding conflict: transcript-generator.ts hardcodes 'Generated by SomniBot' footer and Discord-stock styling in transcript HTML; contract requires owner-branded transcript with powered-by-SomniBot attribution per the white-label decision.

## catch
- **[CONFLICT]** Catch payout resilience authored as operator-retry under one idempotency key; code only sets paid=false and logs 'coins lost' on economy_add_balance failure with no retry queue and no idempotency key. CONFLICT flagged.

## chose
- **[DEFAULT]** Chose adventure-daily-limit min=1 guardrail because code's >= comparison would soft-block all starts at 0; conservative default kept at code's 3.

## code
- **[CONFLICT]** CODE CONFLICT: prompt says '/lottery buy|draw' but the actual bot (packages/bot/src/features/lottery/commands.ts) exposes only '/lottery buy' and '/lottery view' — there is no member 'draw' subcommand; draws run solely on the always-on scheduler (scheduleLotteryDraws/checkAndDraw). Authored draw as scheduler-only and added a force-lottery-draw permission (deny) so no member can trigger or influence a draw. '/lottery view' is documented alongside buy.
- **[CONFLICT]** CODE CONFLICT: prompt names config key 'economy_lottery_buy_tickets' but that is the RPC (actual name lottery_buy_tickets), not a config key. Real config keys are economy_lottery_enabled/ticket_price/max_tickets/schedule. Grounded controls in the real economy_lottery_* keys and referenced the real RPCs (lottery_buy_tickets, lottery_claim_drawing, lottery_award_jackpot, lottery_cancel_drawing_if_empty).

## collection
- **[CONFLICT]** Collection completion reward is AUTHORED as a locked intended feature (controls fishing-collection-reward-enabled/coins, collection-completed message, collection-finished transition, collection-reward-failed failure) but NOT in code: fishing-manager.getCollection() only renders discovered X/Y species with no completion-bonus payout and no economy_fishing_collection_* config keys exist. CONFLICT flagged.

## command
- **[DEFAULT]** Command surface: prompt named only /heist join|start, but actual commands.ts exposes start|join|status; authored all three (status is read-only) per code.
- **[DEFAULT]** Command mapping: prompt named /sell and /listing, but actual code has no standalone market /sell or /listing — server-shop resale is /sell (economy commands.ts) and player-market create/cancel are /market list and /market cancel subcommands. Grounded contract in the real subcommand names.

## commerce
- **[DEFAULT]** commerce-product-store: gifting — locked decision requires gifting through the same idempotent fulfillment path, but no gift purchase path exists in packages/bot/src/features/commerce or packages/bot/src/services/commerce-fulfillment.ts; contract authors gifting-enabled=true per decision (behavior-bug report expected at proof time)
- **[DEFAULT]** commerce-product-store: public celebration — decision requires optional public celebration without leaking private checkout details, but no celebration surface exists in code; contract defaults public-celebration-enabled=false with empty celebration-channel (member-respectful default: opt-in, never leak price/buyer by surprise)
- **[DEFAULT]** commerce-product-store: free products — decision requires free claims recorded as completed auditable $0 orders with one-claim default, but no zero-amount claim path exists in current fulfillment code; contract authors free product type + free-claim-policy=one-claim per decision
- **[DEFAULT]** commerce-portal: license key rotation — decision is rotation-not-reveal, but no portal rotation endpoint exists under packages/dashboard/src/app/api/portal; contract authors rotate-and-invalidate self-service rotation per decision
- **[DEFAULT]** commerce-portal: end-of-term subscription cancellation — no cancel endpoint exists under /api/portal in code; contract authors self-service-cancellation=true with cancellation-timing=end-of-term per decision
- **[DEFAULT]** commerce-paypal: legacy USD tolerance — commerce-fulfillment.ts enforces exact currency match on order rows; contract authors legacy-usd-sale-tolerance=true (legacy USD sales remain honorable/refundable) per decision
- **[DEFAULT]** commerce-fraud: staff-alert-channel default is empty string meaning 'not yet configured; dashboard mirror + owner DM still fire' — chosen because no owner decision names a default channel; flagged for owner confirmation
- **[DEFAULT]** commerce-store: max-storefront-products default 9 chosen to fit Discord select-menu/embed limits observed in /store command rendering; exact pagination behavior beyond 9 products flagged as owner call
- **[DEFAULT]** commerce-crossover and fish-for-others permissions authored from the two-economies HARD rule (commerce role/item earns no fishing income, catches not real-store sellable); not represented as explicit code checks. Flagged decision.

## config
- **[DEFAULT]** Config keys economy_farming_max_plots and economy_farming_base_growth_hours exist in guild_config/tests but are NOT read by the live FarmingManager (uses economy_farm_grid_size + per-crop grow_seconds); deliberately excluded from controls to avoid contracting unproven behavior.

## conflict
- **[CONFLICT]** CONFLICT (automod): locked decision says observe-only DEFAULT, but code has no observe/monitor mode - automod-engine.ts loads enabled rules and automod-actions.ts executes each rule's action (delete/warn/mute/kick/ban) immediately. Contract authors an 'automod-mode' control (enum observe|enforce, default observe); an observe branch must be implemented in the engine.
- **[CONFLICT]** CONFLICT (anti-raid): locked decision requires graduated containment, but code (anti-raid/index.ts) uses a single anti_raid_action mode (kick|ban|lockdown) with no escalation between stages. Contract authors a 'containment-ladder' json control (default stage 1 kick -> stage 2 lockdown on persisting flood); ladder logic needs implementing. Also 'raid-cooldown-minutes' is authored as a control (default 5) though RAID_MODE_COOLDOWN is a hardcoded constant in code.
- **[CONFLICT]** CONFLICT (decision-vs-code): control economy-farming-enabled authored default true per flagship out-of-box theme, but live FarmingManager.getConfig() defaults it to false when guild_config is unset — owner decision to ship farming on must be persisted at guild-init or the code default changed.
- **[CONFLICT]** CONFLICT (decision-vs-code): DEPFAIL promises a distinct branded farming-unavailable reply during a Supabase outage, but current code returns the generic 'Farming is not enabled' message because getConfig() swallows the read error into the false default — needs a real reachability/degradation branch.

## contracted
- **[DEFAULT]** Contracted exactly-once idempotency keys on ticket debit / scene advance / ending payout; code relies on state progression (current_scene_id) and best-effort .catch refunds, with no explicit idempotency keys.

## control
- **[DEFAULT]** Control min/max constraints are not enforced in heist-manager.ts (validation lives in dashboard/config layer not read); chose conservative caps per owner conservative-wager theme.
- **[DEFAULT]** control commerce-items-market-locked has no backing guild_config key — it is a policy, not a setting. Modeled as a locked-on boolean enforced via the per-item tradeable flag / commerce source, per the locked no-conflation decision.
- **[DEFAULT]** control market-max-price-per-unit is authored as owner-configurable per the 'configurable caps' owner theme, but in code it is the hardcoded constant MAX_PRICE_PER_UNIT (1e9) in market-manager.ts, not a guild_config column — flagged as aspirational config.

## crafting
- **[CONFLICT]** crafting-enabled default authored TRUE per owner 'maximal out-of-box' theme, but this CONFLICTS with code: the economy_crafting_enabled column defaults FALSE (migration 20260521210000) and guild-init.ts only registers /craft and /recipes when the flag is on — flagged decision-vs-code conflict.
- **[DEFAULT]** crafting-cooldown-seconds (economy_crafting_cooldown_seconds) is only a FALLBACK — per-recipe cooldown_seconds takes precedence in craft() (cooldownMs = recipe.cooldown_seconds || config); authored SET-A around fallback-cooldown recipes and described the precedence in the control.

## crew
- **[DEFAULT]** crew-settlement-failed retry mapped to enum 'automatic' with ownerNotification true, but code does bounded in-process backoff (max 5) then resumePendingHeists on restart; enum has no 'bounded-then-resume' value.

## crop
- **[DEFAULT]** Crop economics (grow_seconds, wilt_seconds, sell_price, seeds_returned) are per-row in economy_crops seeded from DEFAULT_CROPS, not guild_config keys, so not exposed as dashboard controls; Potato=30 coins/2h used as DEF baseline.

## cross
- **[DEFAULT]** cross-cutting: Discord/dashboard parity decision — administration domains have no Discord slash-command surfaces (no /audit, /diagnostics, /incident, /sync commands in packages/bot); contract asserts parity via mirrored owner notifications and flags the absent command surfaces for adjudication
- **[DEFAULT]** cross-cutting: owner-notification message templates (rbac-degraded, drift-alert, health-alert, incident-opened, etc.) authored fresh in the playful owner-branded voice; no template system exists in code for these surfaces yet

## custom
- **[CONFLICT]** custom-commands: engine denial/cooldown replies are hardcoded generic English with emoji; contract requires owner-voiced parameterized templates per branding decision (code conflict)
- **[DEFAULT]** custom-commands: ephemeral-replies default false (public) chosen for community-visible richness; DB default not confirmed in code
- **[DEFAULT]** custom-commands DEPFAIL: with Valkey down, cooldown-protected commands decline gracefully rather than bypass cooldowns; code would throw on valkey.get (chosen fail-safe)
- **[CONFLICT]** custom-commands RACE: code cooldown is non-atomic get-then-set; contract requires atomic single-admission per window (code conflict)
- **[DEFAULT]** custom-commands: out-of-box cooldown default 0s with mention-safety=true (replies never parse @everyone/@here/role mentions) chosen where the owner decisions only said 'safe'; max-commands-per-guild=1000 mirrors the code's query cap though Discord's own guild command ceiling is lower — flagged for owner awareness.

## daily
- **[DEFAULT]** Daily loss cap default: code default economy_daily_loss_limit is 0 (unlimited). Owner theme mandates a sane non-zero cap, so authored a 5000 default; flagged the divergence from the code's unlimited default.

## decision
- **[CONFLICT]** DECISION vs CODE CONFLICT (tickets): the locked decision says 'button panel -> private thread', but packages/bot/src/features/tickets/ticket-service.ts createTicket() creates a private GuildText CHANNEL with permission overwrites, not a thread. The contract authors the private-thread workflow per the decision; implementation must migrate or the decision be amended.
- **[CONFLICT]** DECISION vs CODE CONFLICT (message-logging): the locked decision says per-guild caches, but packages/bot/src/features/message-log/index.ts loadConfig() uses a single module-level cache (_configCache) keyed by nothing — guild A's cached config can be served for guild B within the 60s TTL (cross-guild config bleed). Contract authors strict per-guild caches (config-cache-ttl-ms control, XGUILD scenario); code needs a per-guild cache map.
- **[DEFAULT]** DECISION AUTHORED (automod): the 250ms per-regex and 500ms per-message budgets are code constants, authored as constrained controls (regex-eval-budget-ms max 250, message-rule-budget-ms max 2000) with budget-exceeded owner alerts naming the expensive rule; no dashboard exposure or owner alert for budget exhaustion exists yet (currently only log.warn).
- **[DEFAULT]** DECISION AUTHORED (automod DEF): shipped starter rule set (spam, mention-spam, own-server-allowing invite filter, duplicate) chosen per the maximal-experience/great-defaults theme so observe mode has something to show; code ships with zero rules until the owner creates them.
- **[DEFAULT]** DECISION AUTHORED (both automod + infractions): mod-log/appeal/raid log channel ids default to empty string with documented fallbacks (setup-flow nudge assumed); code defaults are null with silent no-post.
- **[DEFAULT]** DECISION NUANCE: locked design phrases cancel-if-empty as 'refund all on no-participant draw', but a genuinely empty drawing has collected no coins so there is nothing to refund. Authored as: an empty draw is cancelled under the row lock and the pot reset, and the only refund path is the race where a /lottery buy commits as the cancel lands (post-lock 'is not active' guard triggers a full economy_add_balance refund), so no coins are ever trapped in a cancelled drawing.

## default
- **[DEFAULT]** DEFAULT CHOICE (flagged): ticket-price=100, per-member max-tickets=10, schedule=weekly, lottery-enabled=true chosen per owner themes (conservative configurable wager cap, real-but-recoverable stakes, great defaults + deep config, ship-on flagship loop); all owner-tunable and not pinned by an explicit locked value.
- **[DEFAULT]** DEFAULT CHOICE (flagged): SET-B is authored as tightening the per-member wager cap to 1 (strict one-ticket-per-member) rather than toggling a distinct sub-feature, because the lottery has no independent on/off pieces besides the master switch; picked to exercise the configurable-cap guardrail theme.

## defaults
- **[DEFAULT]** Defaults chosen to match code fallbacks in getConfig(): cooldown 30s, junk 15%, treasure 5% (fallback used only when guild_config row is absent; actual DB column defaults not verified). Flagged default.
- **[DEFAULT]** Defaults economy-daily-amount=500, economy-streak-bonus-pct=5, economy-starting-balance=0 chosen per owner 'earned quick early wins, not handed' theme (match code fallbacks) — flag if owner prefers a seeded starting balance.

## diagnostics
- **[GAP]** diagnostics: 'guided' decision has no code surface (plain snapshot dashboard); contract adds guided-mode control default true with plain-language explanations + suggested next steps (code gap)
- **[GAP]** diagnostics: alert thresholds authored as owner-configurable controls; code has constructor-level AlertThresholds with no dashboard configuration surface (code gap)
- **[CONFLICT]** diagnostics RACE: AlertManager check-then-insert is racy; contract requires exactly one unresolved alert row per type under concurrency (code conflict)
- **[DEFAULT]** diagnostics: 'guided' plain-language metric explanations with suggested next steps are decision-driven (guided-mode=true default); current dashboard page shows raw snapshots/alerts only. Default chosen per maximal-experience theme.

## economy
- **[DEFAULT]** economy-max-wallet default 0 (uncapped) chosen for frictionless start over the 'conservative configurable caps' guardrail; owner may want a non-zero default cap.

## failed
- **[DEFAULT]** Failed-credit turn loss: in gather(), the cooldown is claimed (SET PX NX) and tool durability is consumed BEFORE the wallet/inventory credit; if economy_add_balance/economy_upsert_inventory then fails, the member loses a cooldown + one durability with no reward. Contract authors this as 'the only cost is the claimed cooldown/durability' — owner should decide whether that should be refunded on failure.

## fishing
- **[DEFAULT]** fishing-collection-reward-coins default 5000 chosen per owner theme (real-but-recoverable stakes, quality/long-term-mastery); no code or locked value exists. Flagged default.

## fraud
- **[DEFAULT]** fraud: staff-channel mirroring is not implemented (owner DM via event bus + dashboard rows only); authored staff-alert-channel control defaulting to empty (dashboard + owner DM only until configured) per the 'alerts mirrored to dashboard + staff channel' decision.
- **[DEFAULT]** fraud: detection thresholds are hardcoded constants in fraud-detection.ts (velocity 5/60min, device-abuse 3x, ip-mismatch 5/24h, failed-payment 3/24h, incident 3 critical/hr); authored them as dashboard-configurable controls with the shipped values as defaults per the deep-config theme.

## gap
- **[GAP]** GAP (infractions-appeals): appeal surface does not exist anywhere in code - zero 'appeal' matches across packages/bot/src and packages/dashboard/src. Contract authors the decision: appeals-enabled default true, Discord entry point AND member portal, appeal-review-channel-id falling back to mod log, 24h per-infraction cooldown, human review, upheld appeals pardon + lift live timeout/ban. Entire flow needs building.
- **[GAP]** GAP (infractions-appeals): current moderation DMs (commands.ts warn/mute/kick/ban embeds, escalation.ts dmMember, automod-actions.ts DMs) state what and why but never how-to-appeal; contract requires the appeal path in every warn/punishment DM and in automod enforcement notices.

## gathering
- **[CONFLICT]** gathering-enabled default: authored true per owner 'great-defaults/maximal out-of-box' theme, but code conflicts — migration 20260521210000 sets guild_config.economy_gathering_enabled DEFAULT false and GatheringManager.getConfig() falls back to false. Owner must confirm ship-on vs ship-off.

## general
- **[CONFLICT]** rbac/audit/diagnostics/automations/custom-commands/sync: several APIs use requireGuildOwner while ROUTE_PERMISSIONS grants finer permissions (e.g. /api/audit owner-only vs dashboard.view_audit, /api/automations owner-only vs dashboard.manage_automations); contract authored to the RBAC permission model per the parity+delegation decision (code conflict)
- **[DEFAULT]** RACE/RESTART/XGUILD lean on partial unique index uniq_active_adventure_session_per_user referenced in code comments; assumed present in DB migration (not verified, no DB access).
- **[CONFLICT]** Replay/idempotency assertions assume idempotency keys on the economy_fish_catches insert and the economy_add_balance auto-sell credit; code has neither today (plain insert + RPC). Authored per definition-of-done proven-behavior bar. CONFLICT flagged.
- **[CONFLICT]** junk+treasure <=100 validation authored as a control constraint and INVALID scenario; code computes treasureThreshold = junk + treasure with no upper-bound guard. CONFLICT flagged.
- **[DEFAULT]** economy_coinflip_max_bet is shared in code by coinflip, rps, dice, scratch, and guess (and, per the authored decision, roulette). Modeled one coinflip-max-bet control governing all of them rather than a per-game cap; note tests reference economy_rps_max_bet / economy_dice_max_bet keys that do not exist in DbGuildConfig and are not honored by the manager.
- **[DEFAULT]** /pay per-interaction idempotency is a LOCKED DECISION I authored (REPLAY/RACE assert one effect per /pay interaction id), but current pay() in economy-manager.ts has NO idempotency key (calls economy_subtract_balance/economy_add_balance with only guild/user/amount), so a re-delivered interaction would transfer twice; needs an interaction-id-keyed guard like /collect-income's p_request_id.
- **[DEFAULT]** economy_heist_enabled has no default in bot code (falsy=disabled); defaulted true per owner maximal-experience theme - decision-over-code.

## giveaways
- **[DEFAULT]** giveaways: Discord command layer enforces prize setMaxLength(1000) but I could not confirm an API/DB-level btrim/left(1000) canonicalization exists — contract requires canonical storage per locked decision (INVALID scenario asserts it); verify at proof time

## idempotency
- **[DEFAULT]** Idempotency assumed: replay-safety/RETRY/REPLAY assertions assume per-action idempotency keys on the plot upsert and harvest payout, but economy_add_balance and the economy_farm_plots upsert currently carry no explicit key — replay dedup must be added.

## incidents
- **[GAP]** incidents: auto-create-from-critical-alerts default true per rich-defaults theme; no such pipeline exists in code (alerts and incidents are unlinked) (code gap)
- **[DEFAULT]** incidents: create API allows severities info/warning/critical while the UI styles include 'outage'; contract keeps the three creatable severities and reserves escalation via auto-create-from-critical-alerts=true. Default chosen and flagged.

## invalid
- **[DEFAULT]** INVALID scenario for message-logging assumes dashboard rejects enable-without-channel; current code silently no-ops instead of validating. Chose reject-atomically per guardrails theme.

## launcher
- **[DEFAULT]** launcher: OWNER DECISION requires somnibot-* destination only + rejection of Somni/Hermes paths, but code (packages/launcher/src/main/vps-preflight.ts isSafeDeployPath) only enforces absolute path / safe chars / no traversal — no somnibot- prefix check and no Somni/Hermes rejection. Contract authored per decision (control vps-deploy-path constraints + failure vps-unsafe-path + INVALID scenario); expect a behavior-bug report when proofs run.
- **[GAP]** launcher: decision says secure credential storage, but config-store.ts silently falls back to plaintext with only a console.warn when safeStorage/keychain is unavailable. Contract default (keychain-required=true) requires a prominent operator-facing warning + explicit acknowledgment before any plaintext write — guardrails-consistent default, flagged as a code gap.
- **[DEFAULT]** launcher: decision requires unsigned-build SmartScreen guidance + checksums; no checksum publication or in-app SmartScreen guidance surface found in launcher code. Contract authors a first-run smartscreen-guidance message with a {checksum} variable verified against the download page; flagged default.
- **[DEFAULT]** launcher: update feed is hard-pinned to GitHub HeyImDionysus/somnibot (updater.ts setFeedURL) while branding is white-label. Default chosen: vendor-supplied updates are compatible with white-label (owner brand on all prompt copy, subtle attribution); flagged in case the owner wants owner-controlled feeds.
- **[DEFAULT]** launcher: ownerNotification=false chosen for update-feed failures and blocked VPS plans (surfaced inline to the operator, who is the owner locally) and true for keychain-unavailable, VPS command failure, and process crashes; notification-parity split flagged for owner confirmation.
- **[BUG]** launcher: DECISION-vs-CODE conflict — contract requires deploy path final segment prefixed somnibot- and outright rejection of Somni/Hermes destinations, but isSafeDeployPath (packages/launcher/src/main/vps-preflight.ts:60) only checks absolute/safe-chars/no-traversal; proofs will flag this as a behavior bug for owner adjudication
- **[DEFAULT]** launcher: SmartScreen guidance + checksum verification has no code surface yet (no SmartScreen/checksum strings in packages/launcher); default chosen — first-run guidance panel plus download page render the SHA-256 checksum message
- **[DEFAULT]** launcher: owner-brand-name control has no field in config-store.ts today; default chosen — ships as 'SomniBot' until guided onboarding rebrand, per white-label cross-cutting decision
- **[DEFAULT]** launcher: contract requires durable audit rows for lifecycle events (launcher.update_failed, launcher.vps_plan_blocked, etc.) but the launcher currently has no Supabase audit write path; default chosen — audit via the stack's Supabase once credentials exist
- **[DEFAULT]** launcher: autoInstallOnAppQuit=true installs a staged update on quit without a second prompt; default chosen — the operator's download approval covers install, exposed as configurable auto-install-on-quit control defaulting true (prompt-before-DOWNLOAD is the locked invariant)

## levels
- **[DEFAULT]** levels: exact XP curve formula not owner-specified — defaulted level-curve to { base: 100, exponent: 1.9 } (quick early wins, meaningful late grind), owner-tunable; flagged for owner confirmation

## license
- **[DEFAULT]** license-sdk: license_mode is a free-form string (max 32) in the dashboard validation schema with only 'portal_only' observable as canonical; contract models it as a string control with portal_only default rather than inventing an enum; flagged for the owner to enumerate intended modes.
- **[GAP]** license-sdk: 'recovery reset' authored as freeing device slots — owner-side session revoke exists (DELETE /api/license/sessions/[id], reason admin_revoked), but no customer-initiated device-session reset endpoint exists in the portal API (portal licenses view is read-only; /api/portal/sessions is owner-invoked and covers portal login sessions). Contract's permission customer-portal-access and device-limit messaging assume customer self-service slot freeing per the portal-self-service theme; flagged as a code gap the owner adjudicates.
- **[CONFLICT]** license-sdk: require_discord_guild_membership config key exists and defaults true, but /api/license/validate performs no guild-membership check; contract authors enforcement-when-true as the acceptance bar — conflict to adjudicate
- **[GAP]** license-sdk: offline_grace_period_seconds is server-side product config but is never delivered to the SDK (client-side offlineGraceMs constructor option only); SET-B asserts the server-configured window takes effect — plumbing gap to adjudicate
- **[DEFAULT]** license-sdk: PUT /api/license/config schema types feature_flags as a record/object while the GET default and SDK contract deliver string[]; contract authors string-list per SDK ValidationResponse.features

## licenses
- **[DEFAULT]** licenses: no key-rotation endpoint exists anywhere in portal or dashboard code; authored rotation-not-reveal (rotate-and-invalidate default, one-time display, old key dies instantly) per the locked decision.
- **[DEFAULT]** licenses: out-of-box max-devices default not verifiable from code (per-product config exists at /api/license/config); chose 3 and flagged; heartbeat-interval-ms default 3600000 also chosen, code constant unverified.

## locked
- **[CONFLICT]** LOCKED default adventures-enabled=true (maximal out-of-box, matches pets/quests) CONFLICTS with code fallback economy_adventures_enabled=false in adventure-manager.ts getConfig().

## loot
- **[DEFAULT]** Loot-table auto-seeding: default loot seeds lazily on first gather per source (seedDefaultLoot), so a freshly-enabled guild's first /hunt|/dig|/mine both seeds and rolls — contract's toggled-on transition reflects this; owner may prefer eager seeding at enable-time.

## market
- **[DEFAULT]** market-enabled default authored false to match code (economy_market_enabled defaults false) as a deliberate coin-movement guardrail, diverging from the 'great defaults ship on' theme used for shop-enabled; DEF scenario asserts market ships disabled until owner opts in.

## max
- **[DEFAULT]** max-open-per-user default of 1 chosen (schema/DB default not confirmed in code).

## message
- **[DEFAULT]** Message-log erasure: no code path today anonymizes already-captured forensic data after /forgetme (forgetme-command.ts anonymizes tickets/audit only); contract extends anonymize-over-delete to message-log records per the privacy-aware decision.

## music
- **[CONFLICT]** music-player-fairness: DECISION-vs-CODE CONFLICT — code (music-player.ts isDJ) makes EVERYONE a DJ when no dj_role_id is set, so any member can force-skip/stop/volume out of the box; owner decision says listener-majority vote-skip for others' tracks is the default. Contract authored per decision: no DJ role = self-skip + majority vote only, DJ role is opt-in arbitration.
- **[CONFLICT]** music-player-fairness: DECISION-vs-CODE CONFLICT — no self-skip fast path exists in code (/skip routes to DJ force-skip or vote-skip only, never checks requestedBy); decision says a requester always skips their own track instantly. Contract authored per decision (self-skip-enabled control, default true).
- **[CONFLICT]** music-player-fairness: DECISION-vs-CODE CONFLICT — no member-facing surface exists for a requester to move their own queued tracks (MusicQueueManager.moveEntry has no command; /remove is DJ-only); decision says requester moves own queued tracks. Contract authored per decision (requester-move-enabled, default true; moving others' tracks stays DJ-only).
- **[DEFAULT]** music-player-fairness: voting-based priority has NO code surface at all; per the maximal-experience theme I authored priority-voting-enabled (default true) with vote-driven promotion that never displaces the playing track and includes a priority-updated message. Owner should confirm the exact command/UI shape.
- **[GAP]** music-player-fairness: code counts vote-skip votes without verifying the voter is a non-bot listener in the session voice channel, and computes the threshold from current VC humans; contract requires listener-only votes and threshold ceil(listeners*percent/100). Flagged as a fairness gap the proofs will expose.
- **[DEFAULT]** music-player-fairness: vote threshold is hardcoded ceil(n/2) in code and not dashboard-configurable; authored vote-skip-threshold-percent control (default 50) per deep-config theme — SET-B proves it at 100.
- **[DEFAULT]** music-player-fairness RESTART: Valkey persists skip votes across restarts, so contract says the tally survives restart (with departed-listener votes pruned at evaluation); alternative (reset votes on restart) was rejected as it silently strips cast votes.
- **[DEFAULT]** music-collaborative-queue: queue caps are hardcoded (MAX_QUEUE_SIZE 5000, MAX_PER_USER_QUEUE 50 in music-queue.ts) and the dashboard page header mentions 'queue limits' but exposes none; authored max-queue-length and per-user-queue-cap as dashboard controls with those code values as defaults.
- **[DEFAULT]** music-collaborative-queue: allowDuplicates exists in the bot's DEFAULT_CONFIG but is never loaded from DB nor exposed anywhere; authored allow-duplicates control, default true (member-respectful).
- **[DEFAULT]** music-collaborative-queue: code SILENTLY TRIMS additions past the global cap (addEntries slices excess) — contract authored as decline-with-branded-message, never silent trimming (guardrails + member-respect theme).
- **[DEFAULT]** music-collaborative-queue INVALID: PUT /api/music silently CLAMPS out-of-range values (Math.max/min in route.ts) instead of rejecting; contract authored as reject-with-field-level-validation-error, nothing persisted.
- **[CONFLICT]** music-collaborative-queue: RANGE CONFLICT — dashboard zod schema caps music_auto_destroy_minutes at 60 (validation.ts:700) while the route clamps to 120 (route.ts:75) and the dashboard default docs say 1-120; contract authored as 1-120. Also GuildQueue comments volume as 0-100 while command/API allow 0-150; contract authored as 0-150.
- **[CONFLICT]** music-player-fairness: DECISION-vs-CODE conflict — owner decision says a requester ALWAYS self-skips their own playing track, but handleSkip (packages/bot/src/features/music/commands.ts) routes every non-DJ /skip to voteSkip with no requester check; contract authors the decision (DEF/REPLAY scenarios assume instant self-skip)
- **[CONFLICT]** music-player-fairness: DECISION-vs-CODE conflict — with no DJ role configured, MusicPlayerManager.isDJ() returns true for everyone (music-player.ts line 190), so any member can force-skip/stop/volume out of the box; decision requires listener-majority vote for others' tracks by default; contract authors the decision
- **[DEFAULT]** music-player-fairness: vote-skip-threshold-percent control (default 50) has no existing config surface — code hardcodes Math.ceil(humans/2); authored as a dashboard control per the deep-config theme so SET-B can prove a distinct threshold takes effect
- **[GAP]** music-player-fairness: requester-move (decision: requester repositions own queued tracks) — MusicQueueManager.moveEntry exists but no user-facing /move command; /remove is DJ-only; contract includes move-own-track allow permission as the intended behavior; command surface is a gap
- **[DEFAULT]** music-player-fairness: voting-based queue priority has zero code surface; authored priority-voting-enabled control (default true) and priority-updated message per the locked decision, maximal-experience default chosen
- **[CONFLICT]** music-collaborative-queue: DECISION-vs-CODE conflict — INVALID contract requires atomic rejection with a field-naming validation error and no silent clamping, but PUT /api/music silently clamps music_default_volume via Math.max(0, Math.min(150, v)) (packages/dashboard/src/app/api/music/route.ts line 68)
- **[DEFAULT]** music-collaborative-queue: max-queue-length (5000), per-user-queue-cap (50), and allow-duplicates authored as dashboard controls per deep-config theme; code has the first two as hardcoded constants (MAX_QUEUE_SIZE, MAX_PER_USER_QUEUE in music-queue.ts) and no duplicates policy at all; defaults chosen to match the constants
- **[CONFLICT]** music-collaborative-queue: DECISION-vs-CODE conflict — addEntries silently trims entries past the global cap ('excess entries are silently trimmed', music-queue.ts); contract requires the member-facing queue-full message instead of silent trimming (member-respectful theme)

## no
- **[DEFAULT]** No 'skill' scaling exists in code — progression is tool-tier only (tool_tier 0=bare hands..3=master via economy_items.use_effect.tier). The prompt's 'tool/skill scaling' is authored as tool-tier scaling; a skill/XP dimension is not implemented.
- **[DEFAULT]** No dedicated economy_shop_enabled key exists — the server shop is gated by the economy master switch economy_enabled, modeled here as control shop-enabled.

## only
- **[DEFAULT]** Only two real economy_* config keys exist for crafting (economy_crafting_enabled, economy_crafting_cooldown_seconds), so the domain has 2 controls vs the reference's 9; recipe/output quantities are per-recipe DB columns, not guild config, and were not invented as controls per the grounding rule.

## owner
- **[DEFAULT]** Owner-tunable 'rates' are modeled via economy_loot_tables per-row fields (weight, sell_value, tool_tier, max_qty) edited on the dashboard gathering page, NOT as guild_config scalar keys — only economy_gathering_enabled and economy_gathering_cooldown_seconds are real guild_config columns. Loot-entry control defaults (weight 40 / sell 15 / tier 0 / max_qty 3) are representative seeded common-drop values, not global scalars.
- **[DEFAULT]** owner-notification on payout/refund failure: heist-manager.ts only logs warn/error (no explicit owner-alert send seen); authored heist-payout-delayed alert as intended notification-parity - decision-over-code.

## paypal
- **[DEFAULT]** paypal: webhook-verify-attempts (3) and webhook-stale-processing-ms (300000) are code constants authored as controls with observed defaults; paypal-environment defaults to 'sandbox' because every proof runs on sandbox — live is an explicit owner cutover.

## pets
- **[DEFAULT]** Pets battle-payout failure: code only logs and appends a warning line to the embed; contract escalates to owner alert + operator retry under an idempotency key per the owner-notification theme.

## polls
- **[DEFAULT]** polls-predictions: payout confirmed proportional pot split with per-bet idempotent payout markers (polls-manager.ts:604-617); prediction-max-bet default 0 (uncapped) chosen and flagged since code shows no cap; play-money only per two-economies rule

## portal
- **[DEFAULT]** portal: portal API is read-only + auth + download-link + sessions; no cancellation, refund-request, service-request, or rotation endpoints exist; authored the full self-service contract (end-of-term cancellation default, refund/service request queues) per the locked decision.

## product
- **[CONFLICT]** product-store: DECISION-vs-CODE CONFLICT — products.type in code is only 'one_time'|'subscription' (database.ts:836) and the buy handler refuses 'free' (payment-handler.ts buyability guard), but the locked decision requires free products as completed auditable $0 orders; authored the decision (free-claim-policy control, $0-order scenarios). Behavior-bug report expected when proofs run.
- **[CONFLICT]** product-store: DECISION-vs-CODE CONFLICT — payment-handler.ts hard-blocks any repurchase while an entitlement is active/pending/grace ('Already Purchased'), but the decision requires per-product unique/stackable/renewable/seat-based; authored repeat-purchase-policy with default 'unique' (matching current behavior) and SET-A proving 'stackable'.
- **[CONFLICT]** product-store: DECISION-vs-CODE CONFLICT — PayPal checkout brand_name is hardcoded 'SomniBot Store' and /store embeds are titled 'Server Store' with fixed colors; decision requires owner brand + subtle 'powered by SomniBot'; authored owner-brand contract (store-brand-source, branding assertions).
- **[DEFAULT]** product-store: gifting has no checkout-side implementation (only non-commerce grant sources manual/giveaway/automation exist in entitlement-service.ts); authored gifting through the same idempotent fulfillment path per the locked decision, default enabled.
- **[DEFAULT]** product-store: public celebration feature absent from code; chose default OFF with empty celebration-channel (member-respectful theme), owner opts in — flagged as my default choice.
- **[DEFAULT]** product-store: no ticket-fulfilled service delivery type exists (delivery_type union is file|link|access_pass|license_key|mixed); authored 'ticket-service' as an enabled product type per the decision.

## profiles
- **[DEFAULT]** profiles: no dedicated dashboard page exists in packages/dashboard/src/app/(dashboard) — contract's configure surface (limits, visibility, filter mode) has no current code home; behavior-bug candidate for owner adjudication

## provably
- **[DEFAULT]** Provably-fair: code uses the project CSPRNG (randomIntRange/randomChance/cryptoShuffle) for uniform outcomes but has NO published commit-reveal/seed-publication provably-fair scheme. Authored fairness as CSPRNG-uniform + harness-seeded determinism per the guardrails theme; flagged that no verifiable published-seed mechanism exists in code.

## quality
- **[DEFAULT]** Quality-weighted XP interplay asserted via the quests trackProgress bridge (real for work/crime/shop_buy); /daily and /pay XP mirroring is authored intent and may need explicit bridge wiring to match.

## quest
- **[DEFAULT]** quest-reward-base default: economy_quest_reward_base exists in schema and on the dashboard quests page but no default was visible in code read; chose 100.

## quests
- **[CONFLICT]** Quests cadence conflict: locked decision says always-on daily/weekly auto-refresh, but quests-manager.ts assigns slates lazily on /quests view (plus an hourly Monday-cleanup timer only). Contract authored to the decision (proactive per-cycle assignment, exactly-once via the unique guild/user/template/assigned_date key); implementation needs a real cadence scheduler.

## race
- **[DEFAULT]** RACE double-pay risk: harvest() sets harvested=true per plot then calls economy_add_balance with no atomic claim guard, so concurrent /farm harvest could both read a plot as ready; contract asserts intended exactly-once — needs an atomic harvest RPC. Flagged for owner decision per DoD.

## rbac
- **[CONFLICT]** rbac: hasRouteAccess in packages/shared/src/constants/rbac.ts returns TRUE for unmapped routes; least-privilege decision wins — contract sets unknown-route-access default 'deny' (code conflict to adjudicate)

## reaction
- **[CONFLICT]** reaction-roles: owner decision says 'all styles' but code implements reaction-engine.ts and button-roles.ts only — select-menu style is authored into the contract as a decision-over-code conflict; also chose default-style 'buttons' as the most discoverable default

## replay
- **[DEFAULT]** Replay-safety has NO dedicated per-craft idempotency key in code; authored replay guard relies on the atomic Valkey SET PX NX cooldown lock (economy:craft:{guild}:{user}), which only dedups a re-delivered craft WITHIN the cooldown window — flagged as a real, window-bounded limitation.
- **[GAP]** replay-safety is authored as intended-behavior, not code-backed: gather has NO per-interaction idempotency key. Dedup relies only on the Valkey SET PX NX cooldown lock (key economy:gather:guild:user:source), which absorbs rapid re-delivery within the cooldown window but does NOT guarantee exactly-once for a replay after the window elapses. Flagged as a real gap vs the contract's replay promise.

## reward
- **[BUG]** reward-credit-failed: I authored recoverable-stakes intent (auto-retry, member not locked out of an unpaid claim), but claimTimedReward claims the SET NX cooldown slot BEFORE crediting, so an economy_add_balance failure consumes the daily/weekly/monthly slot with zero payout and forces a full-cooldown wait — a real behavior bug to surface for owner decision.

## roulette
- **[GAP]** Roulette is named as an advertised casino game in the locked prompt but has NO implementation in packages/bot/src/features/games/ (only coinflip, slots, rps, dice, blackjack, highlow, scratch, guess exist). Authored roulette into the contract as a locked decision (shares economy_coinflip_max_bet cap); flagged as a code gap the implementation must close.

## scheduled
- **[CONFLICT]** scheduled-messages: missed-occurrence policy under downtime unspecified — defaulted missed-run-policy 'skip-missed' with an owner missed-occurrence notice. CONFLICT: current runner.ts is a cron-match interval loop with no durable per-occurrence records, so contract's exactly-once REPLAY/RACE/RESTART promises likely fail against current code (matches known pending durable-occurrence pipeline work)
- **[CONFLICT]** Scheduled trivia conflict: domain scope says 'scheduled + on-command, hosted', but trivia-manager.ts has no scheduler. Authored scheduled-trivia-enabled (default true, inert until channel set), scheduled-trivia-channel-id (default ''), scheduled-trivia-interval-hours (default 24) per the owner theme; these controls do not exist in guild_config yet.

## server
- **[DEFAULT]** server-sync: auto-repair default false (detect-and-report first, member-respectful); sync-interval default 60 min — code bounds 5-1440 but no authoritative default found
- **[DEFAULT]** server-sync INVALID: /api/sync/config silently clamps out-of-range intervals while /api/sync update_config zod rejects; contract = reject with 400 and no partial write (code inconsistency)
- **[DEFAULT]** server-sync: code silently clamps sync_interval_minutes into 5-1440 instead of rejecting; contract's INVALID scenario requires out-of-domain config to be rejected without partial write. Recorded as decision-over-code.
- **[DEFAULT]** server-sync retention of least-privilege: sync config PUT requires guild owner rather than dashboard.manage_server; contract follows the RBAC least-privilege decision. Flagged for owner adjudication.

## set
- **[DEFAULT]** SET-A 'live effect without restart': crafting-manager.ts caches config for 30s (configCacheTTL); authored the change as taking effect 'after the short config cache window' rather than strictly instantly, since dashboard-save invalidation was not confirmed.

## starboard
- **[DEFAULT]** starboard: no dedicated dashboard page — starboard config currently lives on the moderation page and app/api/guild/route.ts; contract expects an owner-reachable starboard config surface; flagged. Default threshold chosen as 3 (code default not confirmed)

## statistics
- **[DEFAULT]** statistics-channels: refresh-interval-minutes defaulted to 10 to match Discord's 2-renames-per-10-minutes limit (code loop cadence not confirmed); stat-type set taken verbatim from stats-manager.ts computeStats keys plus custom_counter

## success
- **[DEFAULT]** success-base-pct control max set to 95 because code caps the DERIVED chance at 95 while the base anchor per comment sits 25..40; chose 95 as safe configurable ceiling.

## team
- **[GAP]** team-management: decision says invitations, but code (settings/team page + /api/rbac/users) assigns roles directly by Discord ID with no invitation flow; contract authors a full pending/accept/decline/expire/revoke invitation lifecycle with direct-assignment-enabled default false (major code gap)
- **[DEFAULT]** team-management: invitation expiry default 72h, max 25 pending, DM-notify default true — no code source; chosen per guardrails+notification-parity themes
- **[DEFAULT]** team-management: owner decision requires consent-based invitations, but current code (packages/dashboard/src/app/api/rbac/users/route.ts POST) direct-assigns dashboard roles by Discord snowflake with no invite/accept/expiry step. Contract authors the invitation flow with default direct-assignment-enabled=false — proofs will fail until an invitation surface exists (behavior-bug report for owner).

## temporary
- **[DEFAULT]** temporary-channels: empty-room deletion grace not specified — defaulted empty-grace-seconds 15 and allow-claim true; code deletes on empty without an obvious grace window, so the grace default is a decision-over-code delta

## ticket
- **[DEFAULT]** Ticket lifecycle authorization: code read did not show explicit manager-role checks on claim/reopen/delete/add/remove handlers; contract authors manager-roles/creator model (creators may close their own ticket, everything else manager-only) per the guardrails theme — verify handlers actually enforce it.

## trivia
- **[DEFAULT]** trivia-cooldown-seconds: economy_trivia_cooldown_seconds exists in schema/dashboard but trivia-manager.ts never reads it; authored as a per-channel round cooldown with default 30 to prevent payout farming.
- **[DEFAULT]** Trivia RESTART: activeRounds is in-memory, so a restart mid-round currently drops the round silently (streaks survive via Valkey). Contract asserts the member-respectful behavior: no stranded round-already-active state, no double payout, streaks continue — the 'interrupted round never strands' promise may need a small recovery path.

## wager
- **[DEFAULT]** Wager-cap defaults: code fallback in validateBet is 10000 when a max-bet key is unset, but owner theme mandates conservative caps. Authored conservative defaults (coinflip/slots 500, blackjack 1000) that diverge from the 10000 in-code fallback; flagged so guild-init seeding can be aligned.

## wallet
- **[DEFAULT]** wallet-credit-failed / inventory-upsert-failed retry set to 'never' (not 'operator'): code queues nothing — the member simply re-runs after cooldown — so no operator/automatic retry path exists; owner-notification kept true for repeated wallet-credit failures only.

## welcome
- **[DEFAULT]** welcome-onboarding: safe-fallback behavior when DMs/native onboarding unavailable not specified — defaulted to fallback-mode grant-after-timeout with a 10-minute timeout and one owner alert (member-respectful theme)

## privacy (added post-review)
- **[GAP]** member-data-rights: the catalog now contracts member view+export+delete (moderation-message-logging), but the member-facing view/export SURFACE (DM/portal /mydata-style export) does not exist in code yet — /forgetme delete exists, view+export must be built. Intended v1 per locked privacy decision.
