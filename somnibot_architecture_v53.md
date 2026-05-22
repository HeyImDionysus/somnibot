# SomniBot — Architecture Document v53

> Version 53.0 · May 2026
> A production-grade Discord business operating system: bot, dashboard, commerce, music, and community — unified.

### What Changed in v53

| Area | v4 | v53 |
|------|----|-----|
| Error Handling | 84 silent `.catch(() => {})` blocks across 20+ bot files | All 84 replaced with structured `writeAuditLog()` calls, capturing error context, guild context, and operation name. Every error is now observable. |
| Entitlement Scoping | `revokeEntitlement()` not scoped to guild | Added `guild_id` filter to entitlement revocation queries — prevents cross-guild leaks. |
| XP Cache Scoping | 3 module-level caches in xp-tracker shared across guilds | All 3 caches (`cooldownMap`, `pendingXP`, `levelCache`) now keyed by `guildId:userId`. |
| CSRF Protection | No CSRF tokens on dashboard API mutations | CSRF middleware on all state-changing API routes. Token generation + validation with HMAC-SHA256. |
| Privacy | No data deletion command | `/forgetme` slash command with full `purge_user_data()` RPC — deletes across 15+ tables with audit trail. |
| Observability | No alerting, no heartbeat visibility, no DLQ | Bot heartbeat/config sync alerts, automation failure alerts, DLQ visibility dashboard with retry/purge, real health metrics (event throughput, queue depth, automation success rate). |
| Member Features | Static bot interactions | `/timers`, tutorial system, `/mydata` export, interactive button commands, market search with filters/sorting, music UX with volume/seek controls, embed theming, ticket pagination. |
| Multi-Guild | Single-guild hardwired (`client.guildId`) | `GuildContext` + `GuildRouter` classes, `getGuildId()` helper, dashboard guild selector, launcher multi-guild config. DB already fully scoped with RLS. |
| Sync Engine | Drift detection only, no auto-repair | Full auto-repair for MISSING_RESOURCE (roles/channels/categories) and PERMISSION_DRIFT (roles/@everyone). Sync reports table. |
| Cross-Feature | Features isolated | Level up → feature unlock, milestone bonus. Ticket close → satisfaction survey DM. Economy purchase → role grant (temp/permanent). |
| Bulk Ops | Dashboard single-item only | Bulk member management: assign/remove role, reset economy, export, send DM. Checkbox selection + search + pagination. |
| Analytics | No economy analytics | Full economy analytics dashboard: daily totals, tx volume by type, market activity, top earners, popular items, feature DAU. 6 SQL RPCs. |
| Performance | No targeted indexes | Composite leaderboard index, time-range indexes on transactions/market, XP index, paginated leaderboard RPC. Transcript 10k message cap. |
| Testing | No unit tests | 82 tests across 8 suites: escalation, guild router, economy, action queue, CSRF, drift detection, event bus, launcher config. |
| Dead Code | `economy_trivia_sessions` and `server_templates` tables unused | Both tables dropped. `server_template_id` column removed from `guild_desired_state`. |
| Migrations | 2 timestamp collisions | Fixed: `20260520000000` and `20260520400000` collisions resolved with `000001` suffixes. |
| Portal Sessions | No revocation UI | Portal session management page with active session list, revoke button, and revoke-all. |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Core Design Principles](#2-core-design-principles)
3. [Technology Stack](#3-technology-stack)
4. [Repository Structure](#4-repository-structure)
5. [System Architecture](#5-system-architecture)
6. [The Member Lifecycle — Central Connection Chain](#6-the-member-lifecycle)
7. [Feature Connection Map](#7-feature-connection-map)
8. [Discord Bot (`packages/bot`)](#8-discord-bot)
9. [Web Dashboard (`packages/dashboard`)](#9-web-dashboard)
10. [Permission Template System](#10-permission-template-system)
11. [Channel Template System](#11-channel-template-system)
12. [Server Setup & Deployment Flow](#12-server-setup--deployment-flow)
13. [Discord Permission Engine](#13-discord-permission-engine)
14. [Bot Role Position Enforcement](#14-bot-role-position-enforcement)
15. [Server Sync & Drift Detection](#15-server-sync--drift-detection)
16. [@everyone & Onboarding System](#16-everyone--onboarding-system)
17. [Welcome & Goodbye System](#17-welcome--goodbye-system)
18. [Moderation System](#18-moderation-system)
19. [Ticketing System](#19-ticketing-system)
20. [Automations Engine](#20-automations-engine)
21. [Custom Commands](#21-custom-commands)
22. [Embed & Message Builder](#22-embed--message-builder)
23. [Reaction Roles System](#23-reaction-roles-system)
24. [Levels & XP System](#24-levels--xp-system)
25. [Temporary Voice Channels](#25-temporary-voice-channels)
26. [Statistics Channels](#26-statistics-channels)
27. [Scheduled Messages](#27-scheduled-messages)
28. [Giveaways](#28-giveaways)
29. [Lavalink Music System](#29-lavalink-music-system)
30. [Commerce & Identity-Bound Licensing](#30-commerce--identity-bound-licensing)
31. [Order Lifecycle & Customer Receipts](#31-order-lifecycle--customer-receipts)
32. [Promotions & Coupons](#32-promotions--coupons)
33. [Admin, Audit & Operations](#33-admin-audit--operations)
34. [Shared Library (`packages/shared`)](#34-shared-library)
35. [Supabase Backend (`packages/supabase`)](#35-supabase-backend)
36. [Database Schema](#36-database-schema)
37. [API Design](#37-api-design)
38. [Deployment & Environment Parity](#38-deployment--environment-parity)
39. [Security Model](#39-security-model)
40. [Implementation Phases](#40-implementation-phases)
41. [Virtual Economy System](#41-virtual-economy-system)
42. [Player Market](#42-player-market)
43. [Heist System](#43-heist-system)
44. [Lottery System](#44-lottery-system)
45. [Mini-Games](#45-mini-games)
46. [Economy Subsystems (Fishing, Farming, Crafting, Gathering, Adventures, Pets)](#46-economy-subsystems)
47. [Quests, Achievements & Prestige](#47-quests-achievements--prestige)
48. [Trivia System](#48-trivia-system)
49. [Polls & Prediction Markets](#49-polls--prediction-markets)
50. [Profiles](#50-profiles)
51. [Starboard](#51-starboard)
52. [Message Log](#52-message-log)
53. [Anti-Raid System](#53-anti-raid-system)
54. [Desktop Launcher (`packages/launcher`)](#54-desktop-launcher)
55. [Dashboard RBAC & Team Management](#55-dashboard-rbac--team-management)
56. [Customer Portal](#56-customer-portal)

---

## 1. Executive Summary

SomniBot is a unified Discord business platform. It is not a multi-tenant SaaS — it is a single-guild operating system built for one owner, one server, one dashboard. The platform consists of:

- **Discord Bot** — The executor. Deploys server structure, manages permissions, enforces entitlements, plays music, handles reactions, runs automations, moderates, manages tickets, tracks levels, processes giveaways, and operates temporary channels. All configuration comes from the dashboard.
- **Web Dashboard** — The control surface. Where the owner designs server structure, builds automations, manages products, creates custom commands, configures moderation, views customers, and monitors operations. No feature is slash-command-first; the dashboard drives everything.
- **Commerce Engine** — Discord-native storefront with PayPal payments and identity-bound licensing. Customers buy through Discord, not a website. License keys are cryptographically bound to Discord accounts.
- **Community Engine** — Levels/XP progression, welcome flows, giveaways, scheduled messages, statistics channels, and temporary voice channels. The engagement layer that makes the server feel alive.
- **Music System** — Lavalink-powered YouTube playback with Components v2 rich controls and self-healing recovery.
- **Automations Engine** — Trigger → condition → action workflows that connect every feature into one reactive platform. When something happens anywhere (purchase, level up, role change, member join), automations make other things happen automatically.

### What Changed in v4

| Area | v3 | v4 |
|------|----|----|
| Guild Selection | "There is no guild selection page. The dashboard is hardwired to the one guild." | Full guild selection flow documented: owner logs in → Discord OAuth shows guilds → picks one → bot invited → dashboard locks to it. Still single-guild, but the Discord OAuth invite flow requires guild selection. |
| Contradictions | View Only template description said "cannot react" but `ADD_REACTIONS` was ✅ | Full document contradiction audit. View Only description fixed. `REQUEST_TO_SPEAK` corrected to ✅ for Members. All branding/template/permission inconsistencies resolved. |
| Ticket Channel Template | Listed as built-in channel template | Removed. Ticket channels are dynamically created by the bot with runtime permissions — not a reusable template. Ticket panel channels use View Only. |
| Stage Channel | `REQUEST_TO_SPEAK` for Moderator+ only | `REQUEST_TO_SPEAK` ✅ for Member+ (all verified). Discord's native stage moderator system handles approvals — highest-ranking role present decides. |
| Ticket Intro | Included "Staff: Use the dashboard to look up orders at /orders" in user-visible message | Removed. Staff instructions are internal, not shown to ticket creator. |
| Automation Scoping | No per-user/per-channel filtering | Added `target_user_ids`, `target_channel_ids`, `exclude_user_ids`, `exclude_channel_ids` on every trigger. Empty = full server scope. Dashboard UI: expandable "Scope" section. |
| Automation Templates | Empty automation builder only | Pre-built template library (Welcome DM, Level Role Reward, Auto-mute Escalation, Purchase Announcement, Ticket Auto-Claim, Subscription Lapse Warning, Voice XP Bonus, VIP Welcome, etc.). One-click deploy with auto-mapped roles/channels. |
| Branding | `INSOMNIA_PALETTE`, "Insomnia LLC brand palette", "Insomnia branded" throughout | All "Insomnia" branding removed. Renamed to `SOMNI_PALETTE`. Bot never says "Insomnia LLC" or "Insomnia branded." All references → "SomniBot default theme." |
| Rank Card Customization | Per-server only | Per-user customization: background image (URL/upload), accent color, opacity, progress bar color. Server owner sets defaults, users override via `/rank customize`. New `member_rank_settings` table. |
| Licensing | Time-limited signed URLs for file delivery, basic key validation | Universal Licensing Platform: `@somnibot/license-sdk` for every platform (desktop, web, mobile, CLI). Phone-home validation API, heartbeat sessions, multi-device tracking, feature flags, real-time revocation. Portal-gated downloads with dynamic watermarking for documents. Per-product `license_mode`. SDK documentation included in repo. |
| Palette | `PURE_BLACK: #000000` | `NEAR_BLACK: #0D0D0D` — subtle warmth, premium feel, no harsh contrast. |

### What Changed in v3 (previous)

| Area | v2 | v3 |
|------|----|----|
| @everyone | Mentioned as "base permissions (minimal)" | Full specification: @everyone grants ZERO functional permissions. All new members land here with no channel access until Discord onboarding completes and bot grants Member role. |
| Onboarding | Not specified | Full flow: @everyone (sees nothing) → Discord native onboarding (rules, age, interests) → completion detected → bot grants Member role → welcome flow triggers. |
| Welcome/Goodbye | `welcome_channel_id` and `welcome_message` in guild_config | Full system: customizable welcome cards with variables, goodbye messages, DM welcome, auto-role on join, integration with Discord onboarding, configurable delays. |
| Moderation | "Use Discord native AutoMod" | Full system: auto-mod rules (word/link/invite/spam/caps filters), warning/infraction system, escalation chains (3 warns → mute, 5 → kick, etc.), mod log channel, per-rule configurable actions. |
| Ticketing | Zero coverage | Full system: ticket panels with buttons/dropdowns, auto-created private channels, ticket categories, manager roles, claim/close/delete, transcripts, commerce integration (INS-XXXXX lookup). |
| Automations | Zero coverage | Full engine: trigger → condition → action workflows. 15+ trigger types, 10+ conditions, 12+ actions. Connects every feature. |
| Custom Commands | Zero coverage | Dashboard-created slash commands with up to 5 actions (send message, give/remove role, send in channel). Per-command permissions, cooldowns, up to 200 commands. |
| Embed Builder | Components v2 for bot commands only | Visual embed/message builder in dashboard. Owner can compose rich messages, schedule posting, use for announcements/rules/FAQ. |
| Levels/XP | Zero coverage | Full system: message-based XP, level-up announcements, rank cards, role rewards at level thresholds, XP multipliers per role/channel, leaderboard, /rank and /leaderboard commands. |
| Temporary Channels | Zero coverage | Hub voice channel system: join hub → bot creates personal VC → deleted when empty. Owner controls. Optional paired text channel. |
| Statistics Channels | Zero coverage | Voice channels displaying live server stats as names: member count, online count, role counts, custom counters. |
| Scheduled Messages | Zero coverage | Recurring automated messages at configurable intervals. For announcements, reminders, engagement posts. |
| Giveaways | Zero coverage | Timed giveaways with role requirements, multiple winners, commerce integration (give away products/licenses). |
| Feature connections | Features operated independently | Automations engine + member lifecycle chain + commerce↔community bridge + moderation↔commerce interaction + ticket↔everything pipeline. Features are connected. |
| Permission corrections | USE_EXTERNAL_STICKERS denied for Member | USE_EXTERNAL_STICKERS ✅ granted for Member (stickers are standard expression). USE_SOUNDBOARD ✅ granted for Member (standard voice feature). USE_EXTERNAL_SOUNDS stays ❌ (external sounds from other servers — disruptive, Moderator+). |

---

## 2. Core Design Principles

1. **Dashboard controls, bot executes.** The owner never types commands to configure the server. They design in the dashboard; the bot makes it real in Discord.

2. **Single guild, single purpose.** No multi-tenant architecture. The database, auth, and API are built for exactly one guild. This eliminates complexity and keeps everything fast.

3. **Discord is the runtime.** The bot orchestrates Discord's native systems — it doesn't reimplement them. Native permissions, native audit log, native onboarding, native timeout, native AutoMod. The bot adds the business logic layer on top.

4. **Discord is the storefront.** Customers discover, browse, and purchase products inside Discord. The dashboard is the back office — customers never see it.

5. **Identity is Discord identity.** Every purchase, license key, and entitlement is bound to a Discord account. No separate login system for customers. Discord OAuth is the single identity chain.

6. **Features are connected, not isolated.** Every system feeds into and reacts to every other system through the automations engine and shared event bus. A purchase isn't just a payment — it triggers role grants, welcome messages, statistics updates, and audit logs. A level-up isn't just XP — it triggers role rewards, channel access, and announcements. Nothing operates in a vacuum.

7. **@everyone is the locked door.** New members start with zero access. Discord onboarding is the verification gate. The Member role is the key. Everything flows from this.

8. **No shortcuts, no MVPs.** Every feature is production-grade. Same behavior on local machine or VPS. No "we'll add that later" placeholders.

9. **Sequential unlocking.** Features are locked until prerequisites are met. Server setup → manual confirmation → database connection → features unlock. No partial states.

---

## 3. Technology Stack

### Confirmed Dependencies (2026-current)

| Component | Technology | Version | Rationale |
|-----------|-----------|---------|-----------|
| **Runtime** | Node.js | ≥22.12.0 | Required by discord.js v14.24+ |
| **Language** | TypeScript | 5.x | Type safety across all packages |
| **Bot Framework** | discord.js | 14.24.x | Most mature Discord library, Components v2 support since 14.19 |
| **Lavalink Client** | Shoukaku | 4.x | Most stable Node.js Lavalink wrapper, platform-agnostic, DAVE support, clean reconnection/resume |
| **Music Server** | Lavalink | 4.x | Java 17+, YouTube plugin 1.17.0, OAuth integration |
| **Dashboard** | Next.js | 16.x | App Router, Turbopack, React 19.2, cache components |
| **UI** | Tailwind CSS 4 + Radix UI | Latest | Discord-native dark theme, accessible primitives |
| **Backend** | Supabase | Current | Auth, Postgres, Edge Functions, RLS, real-time, storage |
| **Cache** | Valkey | 7.2+ | Redis-compatible, via `iovalkey` Node.js client |
| **Payments** | PayPal REST API v2 | Current | Orders, Subscriptions, Catalog Products, Webhooks |
| **Cron/Scheduling** | `node-cron` | Latest | In-process scheduling for recurring tasks (stats updates, scheduled messages, subscription checks) |
| **Image Generation** | `@napi-rs/canvas` | Latest | Rank cards, welcome cards, leaderboard images |
| **Monorepo** | Turborepo | Latest | Shared types, parallel builds, caching |
| **Package Manager** | pnpm | Latest | Workspace protocol, fast, disk-efficient |

### Why These Choices

**Shoukaku over other Lavalink clients**: Most battle-tested Node.js Lavalink wrapper. Platform-agnostic (works with any Discord library), actively maintained by shipgirlproject, full Lavalink v4 support including DAVE protocol, clean reconnection/resume logic, supports custom player structures. Alternatives (Magmastream, Moonlink.js, Riffy) are less mature or less documented.

**Next.js 16 over 15**: Turbopack as default (2-5x faster builds), cache components (opt-in instead of implicit), `proxy.ts` for cleaner network boundary, React 19.2 with View Transitions. App Router fully stable.

**iovalkey over Valkey GLIDE**: For our use case (queue state, session cache, rate limiting), iovalkey (ioredis fork for Valkey) is simpler and more mature. GLIDE is for high-availability clusters — overkill here.

**@napi-rs/canvas over node-canvas**: Pure Rust bindings via N-API — no Cairo/Pango system dependencies, faster, cross-platform, smaller binary. Used for generating rank cards and welcome card images.

**node-cron over external schedulers**: Lightweight, in-process. Perfect for single-instance bot. Scheduled messages, statistics updates, subscription expiry checks, giveaway endings.

**Supabase new key format**: Project uses `sb_publishable` and `sb_secret` keys (new format, old `anon`/`service_role` deprecated by end of 2026).

---

## 4. Repository Structure

```
somnibot/
├── .github/
│   └── workflows/           # CI/CD pipelines
├── packages/
│   ├── bot/                 # Discord bot (discord.js + Shoukaku)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry, client bootstrap
│   │   │   ├── config.ts             # Env config with Zod validation
│   │   │   ├── client.ts             # Extended Discord client
│   │   │   ├── commands/             # Slash commands
│   │   │   │   ├── music/            # play, skip, queue, nowplaying, etc.
│   │   │   │   ├── store/            # /store — browse & buy in Discord
│   │   │   │   ├── license/          # /license check, /license activate
│   │   │   │   ├── levels/           # /rank, /leaderboard
│   │   │   │   ├── giveaway/         # /giveaway (admin-only shortcut)
│   │   │   │   ├── ticket/           # /ticket close, /ticket add
│   │   │   │   ├── voice/            # /voice-lock, /voice-limit, etc.
│   │   │   │   ├── custom/           # Dynamic command loader (dashboard-created)
│   │   │   │   └── utility/          # help, info, rank, birthday, diagnostics
│   │   │   ├── events/               # Gateway event handlers
│   │   │   │   ├── ready.ts
│   │   │   │   ├── interaction-create.ts
│   │   │   │   ├── guild-member-add.ts       # Onboarding + welcome
│   │   │   │   ├── guild-member-remove.ts    # Goodbye
│   │   │   │   ├── guild-member-update.ts    # Role change → automations
│   │   │   │   ├── message-create.ts         # XP tracking + auto-mod + custom commands
│   │   │   │   ├── message-reaction-add.ts   # Reaction roles
│   │   │   │   ├── message-reaction-remove.ts
│   │   │   │   ├── voice-state-update.ts     # Music + temp channels
│   │   │   │   ├── role-events.ts            # Drift detection
│   │   │   │   ├── channel-events.ts         # Drift detection
│   │   │   │   └── guild-audit-log.ts        # Discord audit log forwarding
│   │   │   ├── deployers/            # Server structure deployment from dashboard configs
│   │   │   │   ├── role-deployer.ts
│   │   │   │   ├── channel-deployer.ts
│   │   │   │   ├── permission-deployer.ts
│   │   │   │   └── hierarchy-deployer.ts
│   │   │   ├── modules/              # Feature modules
│   │   │   │   ├── music/            # Shoukaku manager, queue, self-healing
│   │   │   │   ├── moderation/       # Auto-mod rules, infraction tracking, escalation
│   │   │   │   ├── tickets/          # Ticket lifecycle, panel management, transcripts
│   │   │   │   ├── automations/      # Automation engine, trigger/condition/action eval
│   │   │   │   ├── levels/           # XP tracking, level calc, rank cards, rewards
│   │   │   │   ├── welcome/          # Welcome/goodbye cards, messages, DM
│   │   │   │   ├── giveaways/        # Giveaway lifecycle, entry, winner selection
│   │   │   │   ├── temp-channels/    # Hub monitoring, channel creation/cleanup
│   │   │   │   ├── stats-channels/   # Statistics channel updates
│   │   │   │   ├── scheduled/        # Scheduled message cron runner
│   │   │   │   ├── custom-commands/  # Dynamic command registry + execution
│   │   │   │   └── embeds/           # Embed posting from dashboard configs
│   │   │   ├── permissions/          # Permission engine, hierarchy logic
│   │   │   ├── sync/                 # Server sync, drift detection
│   │   │   ├── reactions/            # Reaction role engine
│   │   │   ├── commerce/             # Entitlement enforcement, key validation
│   │   │   ├── components/           # Components v2 builders (SomniBot palette)
│   │   │   ├── services/             # Supabase client, Valkey client
│   │   │   ├── scheduler/            # node-cron job registry
│   │   │   └── utils/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── dashboard/           # Next.js 16 web dashboard (admin-only)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/           # Discord OAuth login/callback
│   │   │   │   ├── (dashboard)/      # Main dashboard layout
│   │   │   │   │   ├── setup/        # Server setup wizard (roles, channels, perms)
│   │   │   │   │   ├── roles/        # Role template management
│   │   │   │   │   ├── channels/     # Channel template management
│   │   │   │   │   ├── onboarding/   # @everyone → onboarding → member flow config
│   │   │   │   │   ├── welcome/      # Welcome & goodbye configuration
│   │   │   │   │   ├── moderation/   # Auto-mod rules, infraction settings, escalation
│   │   │   │   │   ├── tickets/      # Ticket panel builder, category settings, transcripts
│   │   │   │   │   ├── automations/  # Automation builder (trigger → condition → action)
│   │   │   │   │   ├── commands/     # Custom command creator
│   │   │   │   │   ├── embeds/       # Embed/message builder
│   │   │   │   │   ├── reactions/    # Reaction role management
│   │   │   │   │   ├── levels/       # XP settings, role rewards, rank card customization
│   │   │   │   │   ├── temp-channels/# Temporary channel hub configuration
│   │   │   │   │   ├── stats/        # Statistics channel configuration
│   │   │   │   │   ├── scheduled/    # Scheduled message management
│   │   │   │   │   ├── giveaways/    # Giveaway creation and management
│   │   │   │   │   ├── music/        # Music settings
│   │   │   │   │   ├── store/        # Product/file/link management (admin)
│   │   │   │   │   ├── customers/    # Customer & entitlement admin
│   │   │   │   │   ├── orders/       # Order history & receipts
│   │   │   │   │   ├── promotions/   # Promotions & coupons
│   │   │   │   │   ├── audit/        # Audit logs & diagnostics
│   │   │   │   │   └── settings/     # System settings
│   │   │   │   └── api/              # API routes (webhooks, internal)
│   │   │   ├── components/
│   │   │   │   ├── ui/               # Discord-styled primitives
│   │   │   │   ├── layout/           # Dashboard shell, sidebar, nav
│   │   │   │   ├── setup/            # Setup wizard components
│   │   │   │   ├── templates/        # Template editor (drag-and-drop)
│   │   │   │   ├── permissions/      # Permission matrix, template picker
│   │   │   │   ├── automations/      # Visual automation builder
│   │   │   │   ├── embeds/           # Visual embed composer
│   │   │   │   ├── commerce/         # Product editor, file uploader
│   │   │   │   └── charts/           # Stats & visualization
│   │   │   ├── lib/
│   │   │   │   ├── supabase/         # Supabase client (browser + server)
│   │   │   │   ├── discord/          # Discord API helpers
│   │   │   │   └── utils/
│   │   │   ├── hooks/
│   │   │   └── styles/               # Global styles, Discord dark theme
│   │   ├── public/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── shared/              # Shared types, constants, validators
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── discord.ts
│   │   │   │   ├── database.ts       # Auto-generated from Supabase
│   │   │   │   ├── commerce.ts
│   │   │   │   ├── templates.ts
│   │   │   │   ├── permissions.ts
│   │   │   │   ├── automations.ts    # Trigger/condition/action type defs
│   │   │   │   ├── moderation.ts     # Infraction, auto-mod rule types
│   │   │   │   ├── tickets.ts        # Ticket, panel, transcript types
│   │   │   │   ├── levels.ts         # XP, level, rank card types
│   │   │   │   └── community.ts      # Giveaway, welcome, stats types
│   │   │   ├── constants/
│   │   │   │   ├── permissions.ts    # Full Discord permission registry
│   │   │   │   ├── templates.ts      # Built-in template definitions
│   │   │   │   ├── brand.ts          # SomniBot default palette
│   │   │   │   ├── discord.ts        # Discord limits, enums
│   │   │   │   ├── levels.ts         # XP curve, level thresholds
│   │   │   │   └── automations.ts    # Trigger/condition/action definitions
│   │   │   ├── validators/           # Zod schemas
│   │   │   └── utils/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── supabase/            # Supabase config & Edge Functions
│   │   ├── migrations/
│   │   ├── functions/
│   │   │   ├── paypal-webhook/       # PayPal event handler
│   │   │   ├── entitlement-check/    # License key verification
│   │   │   ├── license-validate/     # Universal license validation endpoint — NEW v4
│   │   │   ├── license-heartbeat/    # Session heartbeat for embedded apps — NEW v4
│   │   │   └── cron-tasks/           # Scheduled: subscription checks, giveaway endings, stats
│   │   ├── seed.sql
│   │   └── config.toml
│   │
│   └── license-sdk/           # @somnibot/license-sdk — Universal license validation SDK — NEW v4
│       ├── src/
│       │   ├── index.ts             # Main SDK entry point (TypeScript/Node.js)
│       │   ├── validate.ts          # Core validation logic
│       │   ├── heartbeat.ts         # Session heartbeat manager
│       │   ├── types.ts             # Shared types (LicenseValidationResponse, etc.)
│       │   └── errors.ts            # Typed error classes
│       ├── examples/
│       │   ├── node-example/        # Node.js/Express integration example
│       │   ├── react-example/       # React/Next.js route guard example
│       │   └── electron-example/    # Electron desktop app example
│       ├── reference-implementations/
│       │   ├── python/              # Python reference (requests-based)
│       │   ├── csharp/              # C# / .NET reference
│       │   └── rust/                # Rust reference (reqwest-based)
│       ├── docs/
│       │   ├── README.md            # Full SDK documentation
│       │   ├── QUICKSTART.md        # 5-minute setup guide
│       │   ├── API.md               # Endpoint reference
│       │   ├── PLATFORMS.md         # Per-platform integration guide
│       │   └── SECURITY.md          # Security best practices
│       ├── package.json             # Published as @somnibot/license-sdk
│       ├── tsconfig.json
│       └── README.md
│
├── services/
│   └── lavalink/
│       ├── application.yml
│       ├── Dockerfile
│       └── README.md
│
├── docker-compose.yml        # Dev: Lavalink + Valkey
├── docker-compose.prod.yml   # Prod: full stack
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
└── README.md
```

---

## 5. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           SomniBot Platform                                  │
│                       (Single Guild Architecture)                            │
│                                                                              │
│  ┌──────────────────┐   ┌──────────────┐   ┌────────────────────────────┐  │
│  │  Discord Bot      │   │  Next.js 16  │   │  Supabase                  │  │
│  │  (discord.js)     │◄─►│  Dashboard   │◄─►│  ┌────────────────────┐   │  │
│  │                   │   │  (Admin Only)│   │  │ PostgreSQL         │   │  │
│  │  EXECUTOR:        │   │              │   │  │ ┌────────────────┐ │   │  │
│  │  Server structure │   │  CONTROLS:   │   │  │ │ Auth (OAuth)   │ │   │  │
│  │  Permissions      │   │  Server Setup│   │  │ │ Guild Config   │ │   │  │
│  │  Entitlements     │   │  Templates   │   │  │ │ Templates      │ │   │  │
│  │  Music            │   │  Automations │   │  │ │ Products       │ │   │  │
│  │  Reactions        │   │  Moderation  │   │  │ │ Entitlements   │ │   │  │
│  │  Moderation       │   │  Tickets     │   │  │ │ License Keys   │ │   │  │
│  │  Tickets          │   │  Commands    │   │  │ │ Levels/XP      │ │   │  │
│  │  Automations      │   │  Levels      │   │  │ │ Infractions    │ │   │  │
│  │  Levels/XP        │   │  Giveaways   │   │  │ │ Tickets        │ │   │  │
│  │  Welcome/Goodbye  │   │  Products    │   │  │ │ Automations    │ │   │  │
│  │  Giveaways        │   │  Customers   │   │  │ │ Giveaways      │ │   │  │
│  │  Temp channels    │   │  Audit       │   │  │ │ Audit Logs     │ │   │  │
│  │  Stats channels   │   │  Operations  │   │  │ └────────────────┘ │   │  │
│  │  Custom commands  │   │              │   │  │                    │   │  │
│  │  Scheduled msgs   │   │              │   │  │ Edge Functions     │   │  │
│  └────────┬──────────┘   └──────────────┘   │  │ ┌────────────────┐ │   │  │
│           │                                  │  │ │ Webhooks       │ │   │  │
│           │           ┌──────────────┐       │  │ │ Key Verify     │ │   │  │
│           │           │  PayPal      │──────►│  │ │ Cron Tasks     │ │   │  │
│           │           │  REST API v2 │       │  │ └────────────────┘ │   │  │
│  ┌────────▼──────────┐                       │  │                    │   │  │
│  │  Lavalink v4      │ ┌──────────────┐      │  │ Storage            │   │  │
│  │  ┌──────────┐     │ │  Valkey      │      │  │ (Product Files)    │   │  │
│  │  │ YouTube  │     │ │  (Cache)     │      │  │                    │   │  │
│  │  │ Plugin   │     │ │              │      │  │ Real-time          │   │  │
│  │  │ + OAuth  │     │ │ Queue State  │      │  │ (Subscriptions)    │   │  │
│  │  └──────────┘     │ │ Sessions     │      │  └────────────────────┘   │  │
│  └───────────────────┘ │ Rate Limits  │      └────────────────────────────┘  │
│                        │ XP Cooldowns │                                      │
│                        │ Reaction $   │                                      │
│                        │ Automation $ │                                      │
│                        └──────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Communication Flows

| From → To | Method | Purpose |
|-----------|--------|---------|
| Dashboard → Supabase | REST + Realtime | All data operations, auth, config writes |
| Bot → Supabase | REST + Realtime | Config reads, state writes, audit logging |
| Bot → Lavalink | WebSocket | Music playback control |
| Bot → Valkey | TCP (Redis protocol) | Queue state, XP cooldowns, reaction role cache, automation state, rate limits |
| Bot → Discord | Gateway + REST | Deploy structure, send messages, manage roles, all bot actions |
| PayPal → Supabase | HTTPS Webhooks | Payment events → Edge Function processing |
| Supabase → Bot | Realtime subscriptions | Config changes trigger bot deployments and module reloads |

**Key flow: Dashboard → Supabase → Bot**
The dashboard writes configuration to Supabase. The bot subscribes to Supabase Realtime and receives changes instantly. When the owner saves a new automation, the bot loads it immediately. No direct API between dashboard and bot.

**Key flow: Bot Event → Automation Engine → Actions**
Every bot event (member join, message sent, role gained, level up, purchase completed) passes through the automation engine. If any automation matches, its conditions are checked and actions executed. This is how features connect.

---

## 6. The Member Lifecycle — Central Connection Chain

This is the single most important design document in SomniBot. Every feature connects through this chain. If a feature doesn't fit into this lifecycle, it doesn't belong in the platform.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: ARRIVAL                                                           │
│                                                                             │
│  Stranger clicks invite link                                                │
│    → Joins server                                                           │
│    → Has @everyone role ONLY                                                │
│    → @everyone grants ZERO functional permissions                           │
│    → Member sees: Discord native onboarding screen                          │
│    → Member cannot see ANY channels yet                                     │
│                                                                             │
│  Discord native onboarding:                                                 │
│    → Server rules acceptance (required)                                     │
│    → Age/interest selection (optional, configurable)                        │
│    → Member completes onboarding                                            │
│                                                                             │
│  Bot detects onboarding completion (guildMemberUpdate event):               │
│    → Grants "Member" role (configured in dashboard)                         │
│    → If interests selected → grants additional interest roles               │
│    → Statistics channels update: member count increments                    │
│    → Automation triggers fire: "member verified" event                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 2: WELCOME                                                           │
│                                                                             │
│  Welcome system activates (triggered by Member role grant):                 │
│    → Welcome card posted to #welcome channel                                │
│    → Welcome DM sent with server info                                       │
│    → Auto-roles applied (if configured beyond Member)                       │
│    → Automation actions: any custom welcome workflows fire                  │
│                                                                             │
│  Member now has:                                                            │
│    → @everyone (base, zero perms) + Member role (standard community perms)  │
│    → Access to: general channels, voice, commands                           │
│    → NO access to: staff channels, premium channels, admin areas            │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 3: ENGAGEMENT                                                        │
│                                                                             │
│  Levels/XP system tracks activity:                                          │
│    → Messages earn XP (rate-limited: 1 XP grant per 60s per user)          │
│    → Voice time earns XP (optional)                                         │
│    → Level up → announcement in configured channel                         │
│    → Level threshold → role reward auto-granted                            │
│    → Role reward → new channel access (via permission templates)           │
│    → Automation trigger: "member reached level X"                          │
│                                                                             │
│  Reaction roles available:                                                  │
│    → Color roles, interest roles, notification roles                       │
│    → Some may require minimum level (prerequisite role from level reward)   │
│                                                                             │
│  Community features:                                                        │
│    → Giveaway entries (may require minimum level or role)                   │
│    → Temporary voice channels (create personal rooms)                      │
│    → Custom commands (server-specific interactions)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 4: COMMERCE                                                          │
│                                                                             │
│  Member discovers store (/store or store channel):                          │
│    → Browses products (Components v2 cards)                                │
│    → Clicks "Buy" → Discord OAuth identity check → PayPal checkout         │
│    → Payment completes → license key generated → bound to Discord ID       │
│    → Bot DM: receipt + key + activation instructions                       │
│    → /license activate → entitlement active                                │
│    → Entitled roles granted → premium channels visible                     │
│    → Automation trigger: "member purchased product X"                      │
│    → Premium XP multiplier active (if configured per role)                 │
│    → Premium-only giveaway eligibility                                     │
│    → Statistics channels update: premium member count                      │
│                                                                             │
│  Subscription lifecycle:                                                    │
│    → Monthly billing via PayPal                                            │
│    → Payment fails → grace period (configurable, default 3 days)           │
│    → Grace expires → entitlement suspended → roles revoked                 │
│    → Automation trigger: "subscription lapsed"                             │
│    → Re-payment → entitlement restored → roles re-granted                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 5: SUPPORT                                                           │
│                                                                             │
│  Member needs help:                                                         │
│    → Opens ticket via panel button in #support                             │
│    → Private ticket channel created (member + ticket managers)             │
│    → Ticket has category (billing, technical, general)                     │
│    → Staff can search order number (INS-XXXXX) in dashboard                │
│    → Staff can extend/refund/reissue from dashboard                        │
│    → Ticket closed → transcript saved → audit logged                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 6: MODERATION                                                        │
│                                                                             │
│  Member violates rules:                                                     │
│    → Auto-mod catches violation (or mod issues manual warning)             │
│    → Warning recorded → infraction count increments                        │
│    → Escalation chain: warn(1-2) → mute(3) → kick(4) → ban(5)            │
│    → Mute: uses Discord native timeout — entitlements preserved            │
│    → Kick: can rejoin — entitlements restored on return                    │
│    → Ban: entitlements suspended — can appeal via external method          │
│    → All actions logged to mod-log channel + audit trail                   │
│    → Automation trigger: "member warned/muted/kicked/banned"               │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 7: DEPARTURE                                                         │
│                                                                             │
│  Member leaves:                                                             │
│    → Goodbye message posted (if configured)                                │
│    → Statistics channels update: member count decrements                   │
│    → XP and level data preserved (for potential return)                    │
│    → Entitlements preserved (active subscriptions continue billing)        │
│    → Automation trigger: "member left"                                     │
│                                                                             │
│  Member returns:                                                            │
│    → Bot detects guildMemberAdd                                            │
│    → Checks for existing entitlements → restores roles                    │
│    → Checks for saved level data → restores level roles                   │
│    → Welcome flow fires again (configurable: skip for returning members)  │
│    → Statistics channels update: member count increments                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Feature Connection Map

Every feature in SomniBot connects to at least two other features. This section documents the explicit connections.

### 7.1 Event Bus

All significant events flow through a central event bus in the bot. The automation engine listens to all events. Individual modules also listen for events relevant to them.

```typescript
// Internal event types (not Discord gateway events — these are SomniBot platform events)
type PlatformEvent =
  // Member events
  | { type: 'member.verified'; memberId: string; roles: string[] }
  | { type: 'member.joined'; memberId: string; returning: boolean }
  | { type: 'member.left'; memberId: string }
  // Role events
  | { type: 'role.gained'; memberId: string; roleId: string; source: RoleSource }
  | { type: 'role.lost'; memberId: string; roleId: string; source: RoleSource }
  // Level events
  | { type: 'level.up'; memberId: string; oldLevel: number; newLevel: number }
  | { type: 'level.reward'; memberId: string; roleId: string; level: number }
  // Commerce events
  | { type: 'purchase.completed'; memberId: string; orderId: string; productId: string }
  | { type: 'subscription.activated'; memberId: string; planId: string }
  | { type: 'subscription.lapsed'; memberId: string; planId: string }
  | { type: 'subscription.cancelled'; memberId: string; planId: string }
  | { type: 'entitlement.granted'; memberId: string; entitlementId: string }
  | { type: 'entitlement.revoked'; memberId: string; entitlementId: string }
  // Moderation events
  | { type: 'infraction.created'; memberId: string; type: InfractionType; count: number }
  | { type: 'member.muted'; memberId: string; duration: number }
  | { type: 'member.kicked'; memberId: string; reason: string }
  | { type: 'member.banned'; memberId: string; reason: string }
  // Ticket events
  | { type: 'ticket.opened'; memberId: string; ticketId: string; category: string }
  | { type: 'ticket.closed'; ticketId: string; resolution: string }
  // Giveaway events
  | { type: 'giveaway.ended'; giveawayId: string; winners: string[] }
  // Message events (for automations)
  | { type: 'message.sent'; memberId: string; channelId: string; content: string }
  // Voice events
  | { type: 'voice.joined'; memberId: string; channelId: string }
  | { type: 'voice.left'; memberId: string; channelId: string }
  | { type: 'temp_channel.created'; memberId: string; channelId: string }

type RoleSource = 'manual' | 'reaction_role' | 'level_reward' | 'purchase' | 'automation' | 'onboarding' | 'sync';
```

### 7.2 Cross-Feature Connections

| Feature A | → Connects To | How |
|-----------|--------------|-----|
| **@everyone/Onboarding** | Welcome System | Onboarding completion triggers welcome flow |
| **@everyone/Onboarding** | Statistics Channels | Member count updates on verification |
| **@everyone/Onboarding** | Automations | "member.verified" event available as trigger |
| **Welcome System** | Automations | Welcome can trigger additional automation workflows |
| **Welcome System** | Levels | Returning members get level roles restored alongside welcome |
| **Levels/XP** | Role Management | Level rewards auto-grant roles from permission templates |
| **Levels/XP** | Channel Access | Level reward roles unlock channels via channel templates |
| **Levels/XP** | Commerce | Premium roles can have XP multipliers |
| **Levels/XP** | Giveaways | Giveaway entry can require minimum level |
| **Levels/XP** | Reaction Roles | Reaction roles can require a level-reward role as prerequisite |
| **Levels/XP** | Statistics | Level distribution stats in statistics channels |
| **Commerce** | Role Management | Purchase → entitlement → role grant |
| **Commerce** | Channel Access | Entitled roles unlock premium channels |
| **Commerce** | Ticketing | Order numbers referenced in tickets for support |
| **Commerce** | Moderation | Ban/suspension → entitlement interaction |
| **Commerce** | Giveaways | Products/licenses as giveaway prizes |
| **Commerce** | Automations | "purchase.completed" as trigger |
| **Commerce** | Statistics | Revenue, premium member count in stats channels |
| **Commerce** | Welcome System | Premium welcome for new purchasers |
| **Moderation** | Infractions | Warning count → escalation thresholds |
| **Moderation** | Commerce | Bans → entitlement suspension |
| **Moderation** | Ticketing | Appeal tickets from moderation actions |
| **Moderation** | Automations | Infraction events as triggers |
| **Ticketing** | Commerce | Order lookup, entitlement repair from tickets |
| **Ticketing** | Moderation | Appeal tickets, mod action review |
| **Ticketing** | Automations | Ticket events as triggers |
| **Reaction Roles** | Levels | Level-gated reaction role access |
| **Reaction Roles** | Automations | Role gain/loss events feed automations |
| **Temp Channels** | Music | Personal listening rooms |
| **Temp Channels** | Statistics | Active voice channel count |
| **Giveaways** | Commerce | Product/license as prizes |
| **Giveaways** | Levels | Level-gated entry requirements |
| **Giveaways** | Automations | "giveaway.ended" as trigger |
| **Scheduled Messages** | Automations | Scheduled messages can trigger automations |
| **Custom Commands** | Automations | Custom command execution can trigger automations |
| **Embed Builder** | Custom Commands | Custom commands can send built embeds |
| **Embed Builder** | Welcome System | Welcome messages use embed builder output |
| **Embed Builder** | Ticketing | Ticket panels use embed builder output |
| **Sync Engine** | All features | Drift detection covers roles/channels created by any feature |

### 7.3 The Automation Bridge

The automations engine is the primary cross-feature bridge. Without it, each feature would need hardcoded integrations with every other feature. Instead:

- Features emit platform events
- Automations listen to platform events
- Automations execute actions that affect other features
- No feature needs to know about any other feature directly

Example: "Premium Welcome Flow"
```
Trigger: purchase.completed (Commerce emits this)
Condition: product.name == "VIP Pass"
Action 1: Send message in #vip-lounge → "Welcome to VIP, {user}! 🎉"
Action 2: Give role → "VIP Spotlight" (cosmetic)
Action 3: Send DM → "Your VIP perks include..."
```

Neither Commerce nor the Welcome system needs special code for this. The automation connects them.

---

## 8. Discord Bot (`packages/bot`)

### 8.1 Client Architecture

```typescript
class SomniClient extends Client {
  // Infrastructure
  shoukaku: Shoukaku;              // Lavalink connection manager
  supabase: SupabaseClient;
  valkey: Redis;                   // iovalkey client
  scheduler: CronScheduler;        // node-cron registry

  // Core engines
  permEngine: PermissionEngine;    // Permission analysis & enforcement
  syncEngine: SyncEngine;          // Server state diffing & deployment
  deployer: ServerDeployer;        // Deploys dashboard configs to Discord
  eventBus: PlatformEventBus;      // Internal event routing

  // Feature modules
  musicManager: MusicManager;          // Queue, player state, self-healing
  reactionManager: ReactionManager;    // Reaction role lifecycle
  commerceEnforcer: CommerceEnforcer;  // Entitlement checks & role gating
  automationEngine: AutomationEngine;  // Trigger/condition/action eval
  moderationEngine: ModerationEngine;  // Auto-mod, infractions, escalation
  ticketManager: TicketManager;        // Ticket lifecycle, panels, transcripts
  levelManager: LevelManager;         // XP tracking, level calc, rewards
  welcomeManager: WelcomeManager;     // Welcome/goodbye cards and messages
  giveawayManager: GiveawayManager;   // Giveaway lifecycle
  tempChannelManager: TempChannelManager; // Hub monitoring, channel lifecycle
  statsChannelManager: StatsChannelManager; // Statistics channel updates
  scheduledMessageRunner: ScheduledMessageRunner; // Cron-based message posting
  customCommandRegistry: CustomCommandRegistry;   // Dynamic command execution
  embedPoster: EmbedPoster;           // Posts dashboard-composed embeds
}
```

### 8.2 Slash Commands

The bot has a focused set of slash commands. Server management is NOT done through commands — it's done through the dashboard. Commands exist for things members/customers interact with directly in Discord.

**Music Commands:**
| Command | Description |
|---------|-------------|
| `/play <query\|url>` | Search YouTube, play or queue |
| `/skip` | Vote-skip or force-skip (DJ role) |
| `/queue` | Paginated queue display with button controls |
| `/nowplaying` | Rich now-playing card with progress, controls |
| `/pause` / `/resume` | Toggle playback |
| `/volume <0-100>` | Set volume |
| `/shuffle` | Shuffle queue |
| `/loop <off\|track\|queue>` | Set loop mode |
| `/remove <position>` | Remove track from queue |
| `/clear` | Clear queue |
| `/disconnect` | Disconnect and clear |

**Store Commands (Customer-facing):**
| Command | Description |
|---------|-------------|
| `/store` | Display the product catalog with purchase buttons |
| `/store buy <product>` | Start purchase flow (Discord OAuth → PayPal) |
| `/license activate <key>` | Activate a license key |
| `/license check` | Check your active entitlements |
| `/license info <key>` | View key details (status, product, expiry) |

**Level Commands:**
| Command | Description |
|---------|-------------|
| `/rank [user]` | Show rank card (level, XP, position) |
| `/leaderboard` | Server XP leaderboard (paginated) |

**Ticket Commands:**
| Command | Description |
|---------|-------------|
| `/ticket close [reason]` | Close the current ticket (in ticket channel) |
| `/ticket add <user>` | Add a user to the current ticket |
| `/ticket remove <user>` | Remove a user from the current ticket |
| `/ticket transcript` | Generate transcript of current ticket |

**Temporary Voice Commands:**
| Command | Description |
|---------|-------------|
| `/voice-lock` | Lock your temporary voice channel |
| `/voice-unlock` | Unlock your temporary voice channel |
| `/voice-limit <number>` | Set user limit on your temp channel |
| `/voice-name <name>` | Rename your temporary voice channel |
| `/voice-permit <user>` | Allow a user into your locked channel |
| `/voice-deny <user>` | Block a user from your channel |
| `/voice-claim` | Claim ownership of an orphaned temp channel |
| `/voice-ban <user>` | Ban a user from your temp channel |

**Utility Commands:**
| Command | Description |
|---------|-------------|
| `/help` | Command reference |
| `/info` | Bot status, uptime, version |

**Dynamic Custom Commands:**
Custom commands created in the dashboard are registered as slash commands at runtime. They don't appear in this table because they're user-defined. See §21.

### 8.3 Components v2 Message Design

All bot messages use Components v2 (`IS_COMPONENTS_V2` flag = `1 << 15`) with the **SomniBot default palette**:

```typescript
// packages/shared/src/constants/brand.ts
export const SOMNI_PALETTE = {
  HOT_PINK: 0xFF1493,    // Primary accent, key actions, purchase confirmations
  CYAN: 0x00D4FF,        // Info, music player, secondary highlights
  ORANGE: 0xFF6B00,      // Warnings, important notices, store highlights
  NEAR_BLACK: 0x0D0D0D,  // Container backgrounds — subtle warmth, no harsh pure black
} as const;
```

**Constraints (Discord limits):**
- Max 40 total components per message (nested count)
- Max 4000 characters across all TextDisplay components
- Cannot use `content`, `embeds`, `poll`, or `stickers` with Components v2 flag
- All attached files must be referenced in a component

**Example: Now Playing Card**
```
┌─────────────────────────────────────────────┐
│ Container (accent: #00D4FF Cyan)             │
│                                              │
│  Section:                                    │
│    Text: "🎵 **Now Playing**"                │
│    Thumbnail: YouTube thumbnail              │
│                                              │
│  Text: "**Song Title**"                      │
│  Text: "by Artist Name"                      │
│  Text: "▰▰▰▰▰▱▱▱▱▱ 2:34 / 4:12"           │
│                                              │
│  ActionRow:                                  │
│    [⏮ Prev] [⏸ Pause] [⏭ Skip] [🔀 Shuffle]│
│    [🔁 Loop] [📋 Queue] [🔊 Vol]            │
└─────────────────────────────────────────────┘
```

**Example: Rank Card**
```
┌─────────────────────────────────────────────┐
│ Container (accent: #FF1493 Hot Pink)         │
│                                              │
│  Section:                                    │
│    Text: "📊 **Rank Card**"                  │
│    Thumbnail: User avatar                    │
│                                              │
│  Text: "**Username**"                        │
│  Text: "Level 15 · Rank #3"                 │
│  Text: "▰▰▰▰▰▰▰▱▱▱ 2,340 / 3,000 XP"     │
│  Text: "Total XP: 24,680"                   │
│  Text: "Messages: 1,247"                    │
└─────────────────────────────────────────────┘
```

**Example: Ticket Panel**
```
┌─────────────────────────────────────────────┐
│ Container (accent: #00D4FF Cyan)             │
│                                              │
│  Text: "🎫 **Support Center**"              │
│  Text: "Need help? Open a ticket below."     │
│  Text: "Our team will respond shortly."      │
│                                              │
│  ActionRow:                                  │
│    [💳 Billing] [🔧 Technical] [❓ General] │
└─────────────────────────────────────────────┘
```

**Example: Giveaway**
```
┌─────────────────────────────────────────────┐
│ Container (accent: #FF6B00 Orange)           │
│                                              │
│  Text: "🎉 **GIVEAWAY**"                    │
│  Text: "**Premium Access Pass** (x2)"       │
│  Text: ""                                    │
│  Text: "Ends: <t:1716000000:R>"              │
│  Text: "Winners: 2"                          │
│  Text: "Entries: 47"                         │
│  Text: "Requirement: Level 5+"              │
│                                              │
│  ActionRow:                                  │
│    [🎉 Enter Giveaway]                       │
└─────────────────────────────────────────────┘
```

### 8.4 Event Handling

| Event | Handler | Purpose |
|-------|---------|---------|
| `interactionCreate` | Command router + component handler | Slash commands, buttons, selects, modals |
| `ready` | Startup | Verify guild, check bot role, sync state, load all module configs, register cron jobs |
| `guildMemberAdd` | Onboarding + welcome | Detect returning member, restore entitlements/levels, fire welcome if applicable |
| `guildMemberRemove` | Goodbye | Post goodbye message, update stats, fire automations |
| `guildMemberUpdate` | Role change detection | Detect onboarding completion (pending → member), detect role gains/losses, fire automations |
| `messageCreate` | XP + auto-mod + custom commands | Grant XP (rate-limited), run auto-mod rules, check for custom command triggers |
| `messageReactionAdd` | Reaction roles | Add role on reaction |
| `messageReactionRemove` | Reaction roles | Remove role on unreaction |
| `roleCreate/Update/Delete` | Drift detection | Log changes, flag drift from desired state |
| `channelCreate/Update/Delete` | Drift detection | Log changes, flag drift |
| `voiceStateUpdate` | Music + temp channels | Handle disconnects, auto-leave, temp channel creation/cleanup, voice XP |

### 8.5 Deployer System

When the dashboard saves configuration, the bot deploys it:

```typescript
// Listens for Supabase Realtime changes on guild_desired_state
supabase
  .channel('guild-config-changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'guild_desired_state',
  }, async (payload) => {
    await deployer.deployChanges(payload.new);
  })
  .subscribe();
```

The deployer handles:
- Creating/updating/deleting roles in the correct hierarchy order
- Creating/updating/deleting channels and categories
- Applying permission overrides per channel/role combination
- Rate-limiting API calls to avoid Discord 429s
- Rolling back on failure
- Logging every action to audit trail

### 8.6 Module Hot-Reload

When module configurations change in Supabase, modules reload without bot restart:

```typescript
// Each module subscribes to its config table
supabase
  .channel('automation-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'automations' },
    async (payload) => {
      await automationEngine.reload();
    })
  .subscribe();
```

This applies to: automations, custom commands, moderation rules, ticket panels, scheduled messages, reaction roles, level settings, giveaways, statistics channels, temporary channel hubs, welcome/goodbye config.

---

## 9. Web Dashboard (`packages/dashboard`)

### 9.1 Design System — Discord-Native Dark

The dashboard looks and feels like a natural extension of Discord. Same visual language, same dark theme.

```css
/* Core palette — Discord's current dark theme */
--bg-primary: #313338;       /* Main content background */
--bg-secondary: #2b2d31;     /* Sidebar, cards */
--bg-tertiary: #1e1f22;      /* Deepest background, nav */
--bg-floating: #111214;      /* Modals, dropdowns */
--text-primary: #f2f3f5;     /* Primary text */
--text-secondary: #b5bac1;   /* Secondary text */
--text-muted: #949ba4;       /* Muted text */
--accent-primary: #5865f2;   /* Discord blurple — primary actions */
--accent-success: #23a559;   /* Success states */
--accent-danger: #f23f43;    /* Destructive actions, errors */
--accent-warning: #f0b232;   /* Warnings */
--border-subtle: #3f4147;    /* Subtle borders */
--border-strong: #4e5058;    /* Strong borders */
--radius-card: 8px;          /* Card corners */
--radius-input: 4px;         /* Input corners */
--transition-speed: 150ms;   /* Standard transition */
```

**The bot's Discord messages** use the SomniBot default palette. The dashboard does not.

### 9.2 Authentication & Guild Selection

```
Owner clicks "Login with Discord"
  → Discord OAuth2 with scopes: identify, guilds, guilds.members.read, email
  → Redirect to /api/auth/callback
  → Exchange code for tokens
  → Create/update Supabase user via Discord identity
  → JWT issued with Discord user metadata
  → FIRST TIME: Land on Guild Selection page
  → RETURNING: Land on dashboard home (guild already selected)
```

**Guild Selection Flow (first-time setup):**

Even though SomniBot is a single-guild deployment, the Discord OAuth bot invite process requires the owner to select which guild to add the bot to. This is a Discord requirement — there is no way to skip it.

```
┌───────────────────────────────────────────────────────┐
│ 🏠 Welcome to SomniBot                                │
│                                                       │
│ Select a server to set up SomniBot:                   │
│                                                       │
│ ┌─────────────────────────────────────┐               │
│ │ [Icon] My Server                    │ ← Owner's guild│
│ │        128 members · You are Owner  │               │
│ │        [Select & Add Bot →]         │               │
│ └─────────────────────────────────────┘               │
│ ┌─────────────────────────────────────┐               │
│ │ [Icon] Friend's Server              │ ← Not owner   │
│ │        52 members · You are Admin   │               │
│ │        (Owner only)                 │               │
│ └─────────────────────────────────────┘               │
│                                                       │
│ ℹ️ Only servers where you are the owner are shown.    │
│    SomniBot is a single-server deployment.            │
└───────────────────────────────────────────────────────┘
```

**How it works:**
1. Owner logs in via Discord OAuth → dashboard fetches their guild list via Discord API (`/users/@me/guilds`)
2. Dashboard filters to guilds where the user is the owner (`owner === true`)
3. Owner clicks a guild → dashboard generates a Discord bot invite URL with the guild pre-selected: `https://discord.com/oauth2/authorize?client_id=BOT_ID&scope=bot+applications.commands&permissions=PERMISSION_INT&guild_id=GUILD_ID`
4. Discord shows the standard bot invite confirmation (with guild pre-selected)
5. Owner confirms → bot joins the guild → Discord redirects back to dashboard
6. Dashboard stores the selected `guild_id` in the `guild` table → all future logins skip guild selection and go straight to the dashboard
7. Dashboard is now locked to this one guild. The guild selection page is never shown again unless the owner explicitly resets via settings.

**If the bot is already in the guild** (returning owner):
- Dashboard detects the bot is already in a guild → skips guild selection → goes to home/setup wizard.

**Authorization:**
If the authenticated user is the guild owner or has admin permissions, they're in. Otherwise, access denied.

### 9.3 Feature Gating

The dashboard has a sequential unlock system:

```
┌─────────────────────────────────────────────────┐
│  ALWAYS ACCESSIBLE                              │
│  └─ Setup Wizard                                │
│  └─ Bot Role Position Check                     │
│  └─ Settings                                    │
│  └─ Audit Log (read-only)                       │
├─────────────────────────────────────────────────┤
│  LOCKED until:                                  │
│  ✓ Bot role is position #1 in hierarchy         │
│  ✓ Server setup manually confirmed by owner     │
│  ✓ Bot confirms live database connection         │
│                                                 │
│  SERVER MANAGEMENT:                             │
│  └─ Role Management                             │
│  └─ Channel Management                          │
│  └─ Onboarding & @everyone Configuration        │
│  └─ Welcome & Goodbye                           │
│  └─ Moderation                                  │
│  └─ Ticketing                                   │
│  └─ Automations                                 │
│  └─ Custom Commands                             │
│  └─ Embed Builder                               │
│  └─ Reaction Roles                              │
│                                                 │
│  COMMUNITY:                                     │
│  └─ Levels & XP                                 │
│  └─ Temporary Channels                          │
│  └─ Statistics Channels                         │
│  └─ Scheduled Messages                          │
│  └─ Giveaways                                   │
│                                                 │
│  COMMERCE:                                      │
│  └─ Store Management                            │
│  └─ Customer Management                         │
│  └─ Promotions                                  │
│                                                 │
│  MUSIC:                                         │
│  └─ Music Settings                              │
└─────────────────────────────────────────────────┘
```

### 9.4 Dashboard Sidebar Navigation

```
┌──────────────────────────────┐
│ 🌙 SomniBot                 │
│                              │
│ HOME                         │
│   📊 Dashboard               │
│                              │
│ SERVER MANAGEMENT            │
│   🏗️ Setup Wizard            │
│   👑 Roles                   │
│   📺 Channels                │
│   🚪 Onboarding             │
│   👋 Welcome & Goodbye       │
│   🛡️ Moderation              │
│   🎫 Ticketing               │
│   ⚡ Automations             │
│   💬 Custom Commands         │
│   📝 Embed Builder           │
│   🏷️ Reaction Roles          │
│                              │
│ COMMUNITY                    │
│   📈 Levels & XP             │
│   🔊 Temporary Channels      │
│   📊 Statistics Channels     │
│   📅 Scheduled Messages      │
│   🎉 Giveaways               │
│                              │
│ COMMERCE                     │
│   🛒 Store                   │
│   👥 Customers               │
│   📋 Orders                  │
│   🏷️ Promotions              │
│                              │
│ MUSIC                        │
│   🎵 Music Settings          │
│                              │
│ OPERATIONS                   │
│   📜 Audit Log               │
│   🔧 Diagnostics             │
│   ⚙️ Settings                │
└──────────────────────────────┘
```

### 9.5 Page Summaries (New Pages Only)

**Dashboard Home** (`/`) — Updated
- At-a-glance: bot status, member count, active entitlements, recent orders, level distribution, open tickets, active giveaways
- Setup completion checklist
- Bot role position status
- Quick links to all sections

**Onboarding** (`/onboarding`) — NEW
- Configure @everyone base permissions (zero by default, with explanation)
- Select which role is granted on onboarding completion
- Toggle Discord native onboarding integration
- Configure interest-based role mapping
- Configure returning member behavior

**Welcome & Goodbye** (`/welcome`) — NEW
- Enable/disable welcome messages
- Select welcome channel
- Welcome message editor (rich text with variables: {user}, {server}, {memberCount}, etc.)
- Welcome card toggle (image-based welcome)
- Welcome DM toggle and message editor
- Goodbye message editor
- Goodbye channel (can differ from welcome)
- Preview welcome/goodbye messages

**Moderation** (`/moderation`) — NEW
- Auto-mod rules: create/edit/disable
  - Word filter (custom word lists, regex)
  - Link filter (whitelist/blacklist domains)
  - Invite filter (block Discord invites)
  - Spam filter (message rate, duplicate detection)
  - Caps filter (max uppercase percentage)
  - Mention spam filter (max mentions per message)
- Per-rule actions: delete, warn, mute (duration), kick, ban
- Escalation chain editor: threshold → action mapping
- Mod log channel selection
- Infraction history viewer (search by member)
- Exempted roles (staff roles bypass auto-mod)

**Ticketing** (`/tickets`) — NEW
- Ticket panel builder (visual composer)
  - Panel message (embed builder integration)
  - Ticket types (buttons or dropdown)
  - Per-type: label, emoji, color, category, description
- Ticket manager roles (who can see/manage tickets)
- Ticket category configuration (where channels are created)
- Introduction message editor (what the member sees when ticket opens)
- Transcript settings (enable, channel, DM to creator)
- Active ticket list with quick actions
- Ticket archive/search

**Automations** (`/automations`) — NEW
- Visual automation builder (trigger → condition → action cards)
- Automation list with enable/disable toggles
- Each automation has: name, description, trigger, conditions[], actions[]
- Drag-and-drop condition/action ordering
- Test/preview mode
- Execution log (recent fires, results)
- See §20 for full trigger/condition/action reference.

**Custom Commands** (`/commands`) — NEW
- Command list with quick edit/delete
- Command creator:
  - Name (becomes /commandname)
  - Description
  - Actions (up to 5): send message, send in channel, give role, remove role
  - Allowed roles, allowed channels
  - Cooldown setting
- Variable reference ({user}, {channel}, {server}, arguments)
- Command count (max 200)

**Embed Builder** (`/embeds`) — NEW
- Visual embed composer: title, description, fields, color, image, thumbnail, footer, author
- Live preview panel
- Save as template for reuse
- Schedule posting (date/time, channel)
- Post immediately to a channel
- Integration with ticket panels and welcome messages

**Levels & XP** (`/levels`) — NEW
- Enable/disable levels
- XP rate settings (min/max XP per message, cooldown)
- Level-up announcement channel
- Level-up message template
- Role rewards editor: level → role mapping (drag-and-drop)
- XP multiplier settings: per-role multipliers (e.g., Premium = 1.5x)
- XP channel blacklist/whitelist
- Rank card customization (colors, background)
- Leaderboard settings

**Temporary Channels** (`/temp-channels`) — NEW
- Hub channel selector (which voice channel is the hub)
- Channel naming format (e.g., "#{index} - {username}'s Channel")
- Default user limit
- Default bitrate
- Keep-alive duration (minutes before empty channel deleted)
- Ownership lock duration
- Owner permissions (manage channel, manage permissions, move members)
- Paired text channel toggle
- Moderator roles (can override temp channel settings)

**Statistics Channels** (`/stats`) — NEW
- Channel list with stat types
- Available stats: Total Members, Online Members, Bots, Roles, Channels, Premium Members, Active Tickets, Level Distribution, Custom Counter
- Naming format per stat (e.g., "👥 Members: {count}")
- Update interval (default: 10 minutes)
- Category selector (where stats channels are created)

**Scheduled Messages** (`/scheduled`) — NEW
- Message list with schedules
- Message creator:
  - Content (embed builder integration)
  - Target channel
  - Interval (every X hours/days/weeks)
  - Start date, end date (optional)
  - Active/paused toggle
- Next send preview
- Send history

**Giveaways** (`/giveaways`) — NEW
- Active giveaway list
- Giveaway creator:
  - Prize (text description OR product from store)
  - Winner count
  - Duration
  - Entry requirements: min level, required role, required subscription
  - Target channel
- Ended giveaway archive with winners
- Manual reroll for ended giveaways

### 9.6 Real-Time Updates

Supabase Realtime subscriptions keep the dashboard live:
- Bot status changes
- New audit log entries
- Incoming purchases/orders
- Subscription status changes
- Drift detection alerts
- Bot role position changes
- Ticket opens/closes
- Giveaway entries
- Level-up events
- Moderation actions

---

## 10. Permission Template System

### 10.1 Role Templates

Role templates are semantic permission bundles. They define *what a tier of user can do* without the owner needing to understand individual Discord permission bits. Every single Discord permission is deliberately assigned to exactly one template tier.

#### Template: `@everyone` (Base Role — Not a Template, System Default)
*The default role every member has. Grants ZERO functional permissions in SomniBot's model.*

| Permission | Granted | Rationale |
|------------|---------|-----------|
| All permissions | ❌ Denied | @everyone is the "unverified" state. New members who haven't completed Discord onboarding have ONLY this role. They should see nothing and do nothing until they complete onboarding and receive the Member role. This is the locked door. |

**Implementation note:** When the bot deploys server setup, it explicitly sets @everyone permissions to `0n` (zero). All channel visibility, messaging, voice, and interaction permissions are denied at the @everyone level. This forces all access through role grants — which is how the Member lifecycle works.

**What @everyone members see:** The Discord native onboarding screen (rules, interests). Nothing else.

#### Template: `Cosmetic`
*Display-only roles. Color, hoist, mentionable. Zero functional permissions.*

| Permission | Granted | Rationale |
|------------|---------|-----------|
| All permissions | ❌ Denied | Cosmetic roles grant no functional access. They exist for display (name color, hoisting) only. |

Configuration options: `name`, `color`, `hoist` (show separately in member list), `mentionable`.

#### Template: `Member`
*Standard community member. Can participate in channels they have access to.*

| Permission | Granted | Rationale |
|------------|---------|-----------|
| `VIEW_CHANNEL` | ✅ | Can see channels (controlled per-channel via channel templates) |
| `SEND_MESSAGES` | ✅ | Can chat |
| `SEND_MESSAGES_IN_THREADS` | ✅ | Can participate in threads |
| `CREATE_PUBLIC_THREADS` | ✅ | Can start public threads |
| `EMBED_LINKS` | ✅ | Links auto-preview |
| `ATTACH_FILES` | ✅ | Can upload images/files |
| `ADD_REACTIONS` | ✅ | Can react to messages |
| `USE_EXTERNAL_EMOJIS` | ✅ | Can use emojis from other servers (Nitro) |
| `USE_EXTERNAL_STICKERS` | ✅ | Can use stickers from other servers (Nitro) — standard expression, not disruptive |
| `READ_MESSAGE_HISTORY` | ✅ | Can scroll up |
| `USE_APPLICATION_COMMANDS` | ✅ | Can use slash commands |
| `CONNECT` | ✅ | Can join voice channels |
| `SPEAK` | ✅ | Can talk in voice |
| `USE_VAD` | ✅ | Voice activity detection (no push-to-talk requirement) |
| `STREAM` | ✅ | Can screen share |
| `USE_SOUNDBOARD` | ✅ | Can use server soundboard — standard voice feature |
| `SEND_VOICE_MESSAGES` | ✅ | Can send voice messages in text channels |
| `SEND_POLLS` | ✅ | Can create polls |
| `USE_EXTERNAL_APPS` | ✅ | Can use external app integrations |
| `CHANGE_NICKNAME` | ✅ | Can change own nickname |
| `CREATE_INSTANT_INVITE` | ✅ | Can invite others |
| — | — | — |
| `USE_EXTERNAL_SOUNDS` | ❌ | External soundboard sounds from other servers — can be disruptive, Moderator+ |
| `SEND_TTS_MESSAGES` | ❌ | TTS is disruptive, not needed |
| `MENTION_EVERYONE` | ❌ | Members should not ping everyone |
| `CREATE_PRIVATE_THREADS` | ❌ | Private threads are a moderation tool |
| `PRIORITY_SPEAKER` | ❌ | Voice priority is a moderator tool |
| `USE_EMBEDDED_ACTIVITIES` | ❌ | Activities — server owner can enable separately if desired |
| `REQUEST_TO_SPEAK` | ✅ | Stage channels — all verified members can request to speak. Discord's native stage moderator system handles approval (highest-ranking role present decides). |
| All management/moderation | ❌ | Members don't manage anything |

#### Template: `Moderator`
*Inherits all Member permissions plus moderation tools.*

| Additional Permission | Granted | Rationale |
|----------------------|---------|-----------|
| `MANAGE_MESSAGES` | ✅ | Delete/pin messages |
| `MANAGE_THREADS` | ✅ | Archive, lock, delete threads |
| `CREATE_PRIVATE_THREADS` | ✅ | Staff-only threads |
| `MODERATE_MEMBERS` | ✅ | Timeout/mute members |
| `KICK_MEMBERS` | ✅ | Remove disruptive members |
| `BAN_MEMBERS` | ✅ | Permanent removal |
| `MUTE_MEMBERS` | ✅ | Server-mute in voice |
| `DEAFEN_MEMBERS` | ✅ | Server-deafen in voice |
| `MOVE_MEMBERS` | ✅ | Move members between voice channels |
| `PRIORITY_SPEAKER` | ✅ | Voice priority for announcements |
| `MANAGE_NICKNAMES` | ✅ | Change other members' nicknames |
| `VIEW_AUDIT_LOG` | ✅ | See who did what |
| `MENTION_EVERYONE` | ✅ | Can ping @everyone/@here for announcements |
| `MANAGE_EVENTS` | ✅ | Create/edit server events |
| `CREATE_EVENTS` | ✅ | Create server events |
| `REQUEST_TO_SPEAK` | ✅ | Manage stage channels |
| `USE_EXTERNAL_SOUNDS` | ✅ | External soundboard access |
| `SEND_TTS_MESSAGES` | ✅ | TTS for announcements if needed |
| — | — | — |
| `MANAGE_ROLES` | ❌ | Reserved for Admin |
| `MANAGE_CHANNELS` | ❌ | Reserved for Admin |
| `MANAGE_GUILD` | ❌ | Reserved for Admin |
| `MANAGE_WEBHOOKS` | ❌ | Reserved for Admin |
| `ADMINISTRATOR` | ❌ | Never granted to moderators |

#### Template: `Admin`
*Inherits all Moderator permissions plus full server management.*

| Additional Permission | Granted | Rationale |
|----------------------|---------|-----------|
| `MANAGE_ROLES` | ✅ | Create/edit/assign roles |
| `MANAGE_CHANNELS` | ✅ | Create/edit/delete channels |
| `MANAGE_GUILD` | ✅ | Server settings access |
| `MANAGE_WEBHOOKS` | ✅ | Webhook management |
| `MANAGE_GUILD_EXPRESSIONS` | ✅ | Manage emoji/stickers |
| `CREATE_GUILD_EXPRESSIONS` | ✅ | Create emoji/stickers |
| `VIEW_GUILD_INSIGHTS` | ✅ | Server analytics |
| `VIEW_CREATOR_MONETIZATION_ANALYTICS` | ✅ | Monetization data |
| — | — | — |
| `ADMINISTRATOR` | ❌ | NEVER granted via template. The `ADMINISTRATOR` permission bypasses ALL permission checks including channel overrides. It cannot be scoped. Only the server owner has this implicitly. If the owner wants to grant it manually in Discord, that's their choice — but SomniBot will never set it. |

### 10.2 Custom Templates

Beyond the four built-in tiers, the owner can create custom role templates:
- Start from any built-in tier as a base
- Toggle individual permissions on/off
- Save as a named template for reuse
- Apply to any number of roles

### 10.3 How Role Templates Work in the Dashboard

The role editor shows a vertical hierarchy stack (top = highest):

```
┌──────────────────────────────────────────────────┐
│  [Bot Role] — SomniBot (locked)                  │  ← Must be #1
├──────────────────────────────────────────────────┤
│  [Admin] "Server Admin"                          │  ← User names this
│  [Admin] "Co-Owner"                              │
├──────────────────────────────────────────────────┤
│  [Moderator] "Head Mod"                          │
│  [Moderator] "Moderator"                         │
│  [Moderator] "Trial Mod"                         │
├──────────────────────────────────────────────────┤
│  [Member] "Verified Member"                      │  ← Granted on onboarding
│  [Member] "Booster"                              │
│  [Member] "VIP"                                  │  ← Granted on purchase
│  [Member] "Level 10"                             │  ← Granted by level system
│  [Member] "Level 25"                             │
│  [Member] "Level 50"                             │
├──────────────────────────────────────────────────┤
│  [Cosmetic] "Team Red"                           │
│  [Cosmetic] "Team Blue"                          │
│  [Cosmetic] "Team Green"                         │
│  [Cosmetic] "Birthday 🎂"                        │  ← Auto-granted on birthday
├──────────────────────────────────────────────────┤
│  @everyone                                       │  ← ZERO permissions
└──────────────────────────────────────────────────┘
```

Each role has:
- A **name** (chosen by the owner)
- A **template** (determines permission set)
- A **color** (for display)
- **Hoist** toggle (show separately in member list)
- **Mentionable** toggle
- Drag-and-drop **position** in hierarchy
- **Source tags**: how this role gets assigned (manual, onboarding, level reward, purchase, reaction role, automation)

The template badge shows which permission set this role uses. Clicking the badge opens the full permission breakdown.

---

## 11. Channel Template System

### 11.1 Channel Permission Templates

Channel templates control *who can do what in a specific channel*. They are applied per-role-tier per-channel. They work through Discord's native permission override system.

#### Template: `Member View Only`
*Members can see the channel and read messages. They can react to existing messages but cannot send messages, create threads, or use commands.*

| Permission Override | Value | Rationale |
|-------------------|-------|-----------|
| `VIEW_CHANNEL` | ✅ Allow | Can see the channel |
| `READ_MESSAGE_HISTORY` | ✅ Allow | Can scroll back |
| `SEND_MESSAGES` | ❌ Deny | Cannot send — this is view-only |
| `SEND_MESSAGES_IN_THREADS` | ❌ Deny | Cannot participate in threads |
| `ADD_REACTIONS` | ✅ Allow | Reactions attach to existing messages, don't clutter |
| `CREATE_PUBLIC_THREADS` | ❌ Deny | Cannot create threads |
| `CREATE_PRIVATE_THREADS` | ❌ Deny | Cannot create private threads |
| `USE_APPLICATION_COMMANDS` | ❌ Deny | No commands in read-only channels |

Use cases: `#announcements`, `#rules`, `#changelog`, `#server-info`

#### Template: `Member View & Use`
*Standard channel access. Members can read, write, react, thread, and use commands.*

| Permission Override | Value | Rationale |
|-------------------|-------|-----------|
| `VIEW_CHANNEL` | ✅ Allow | Can see |
| `READ_MESSAGE_HISTORY` | ✅ Allow | Can scroll |
| `SEND_MESSAGES` | ✅ Allow | Can chat |
| `SEND_MESSAGES_IN_THREADS` | ✅ Allow | Can thread |
| `CREATE_PUBLIC_THREADS` | ✅ Allow | Can start threads |
| `ADD_REACTIONS` | ✅ Allow | Can react |
| `EMBED_LINKS` | ✅ Allow | Link previews |
| `ATTACH_FILES` | ✅ Allow | Upload files/images |
| `USE_APPLICATION_COMMANDS` | ✅ Allow | Slash commands |
| `SEND_VOICE_MESSAGES` | ✅ Allow | Voice messages |
| `SEND_POLLS` | ✅ Allow | Polls |
| `USE_EXTERNAL_EMOJIS` | ✅ Allow | External emoji (if Nitro) |
| `USE_EXTERNAL_STICKERS` | ✅ Allow | External stickers (if Nitro) |
| `USE_EXTERNAL_APPS` | ✅ Allow | External apps |

Use cases: `#general`, `#off-topic`, `#media`, `#gaming`

#### Template: `Staff Only`
*Invisible to members. Only moderators and above can see and use.*

| Permission Override | Target | Value | Rationale |
|-------------------|--------|-------|-----------|
| `VIEW_CHANNEL` | @everyone | ❌ Deny | Hidden from all by default |
| `VIEW_CHANNEL` | Moderator+ roles | ✅ Allow | Staff can see |
| `SEND_MESSAGES` | Moderator+ roles | ✅ Allow | Staff can chat |
| All text permissions | Moderator+ roles | ✅ Allow | Full access for staff |
| `MANAGE_MESSAGES` | Moderator+ roles | ✅ Allow | Can moderate |
| `MANAGE_THREADS` | Moderator+ roles | ✅ Allow | Can manage threads |

Use cases: `#staff-chat`, `#mod-log`, `#admin-only`, `#incident-reports`

#### Template: `Premium Only` — NEW
*Invisible to regular members. Only entitled/VIP members and staff can access.*

| Permission Override | Target | Value | Rationale |
|-------------------|--------|-------|-----------|
| `VIEW_CHANNEL` | @everyone | ❌ Deny | Hidden by default |
| `VIEW_CHANNEL` | Premium/VIP roles | ✅ Allow | Purchasers see it |
| `SEND_MESSAGES` | Premium/VIP roles | ✅ Allow | Can chat |
| All Member-level perms | Premium/VIP roles | ✅ Allow | Standard Member access |
| `VIEW_CHANNEL` | Moderator+ roles | ✅ Allow | Staff oversight |
| All Mod-level perms | Moderator+ roles | ✅ Allow | Staff can moderate |

Use cases: `#premium-chat`, `#vip-lounge`, `#exclusive-content`

**Note on Ticket Channels:** Ticket channels are NOT a reusable template. They are dynamically created by the bot at runtime with per-user permission overrides (see §19.4). The ticket panel channel (e.g., `#support`) where the panel message lives is simply a View Only channel. The bot handles all ticket channel permissions programmatically during ticket creation — there is no need for a pre-defined template.

### 11.2 Voice Channel Templates

#### Template: `Member Voice` (default voice access)
| Permission Override | Value |
|-------------------|-------|
| `VIEW_CHANNEL` | ✅ Allow |
| `CONNECT` | ✅ Allow |
| `SPEAK` | ✅ Allow |
| `USE_VAD` | ✅ Allow |
| `STREAM` | ✅ Allow |
| `USE_SOUNDBOARD` | ✅ Allow |

#### Template: `Staff Voice Only`
| Permission Override | Target | Value |
|-------------------|--------|-------|
| `VIEW_CHANNEL` | @everyone | ❌ Deny |
| `VIEW_CHANNEL` | Moderator+ | ✅ Allow |
| `CONNECT` | Moderator+ | ✅ Allow |
| `SPEAK` | Moderator+ | ✅ Allow |
| Full voice perms | Moderator+ | ✅ Allow |

#### Template: `Stage Channel`
| Permission Override | Target | Value | Rationale |
|-------------------|--------|-------|-----------|
| `VIEW_CHANNEL` | @everyone | ✅ Allow | Everyone can see the stage |
| `CONNECT` | @everyone | ✅ Allow | Everyone can join as audience |
| `REQUEST_TO_SPEAK` | Member+ | ✅ Allow | All verified members can request to speak. Discord's native stage moderator system handles approval — the highest-ranking role present in the stage decides who speaks. |
| `MUTE_MEMBERS` | Moderator+ | ✅ Allow | Stage moderation |
| `MOVE_MEMBERS` | Moderator+ | ✅ Allow | Stage moderation |

#### Template: `Temp Channel Hub` — NEW
*The hub voice channel. Members can see and join, but the bot manages what happens next.*

| Permission Override | Target | Value |
|-------------------|--------|-------|
| `VIEW_CHANNEL` | Member+ | ✅ Allow |
| `CONNECT` | Member+ | ✅ Allow |
| `SPEAK` | ❌ Deny | Hub is just a trigger — users are moved to their personal channel |

### 11.3 Custom Channel Templates

Same pattern as role templates — owner can start from any built-in template, adjust individual permission overrides, and save as a named template for reuse.

### 11.4 How Channel Templates Work in the Dashboard

The channel editor shows a tree view:

```
┌──────────────────────────────────────────────────┐
│ 📁 INFORMATION                                   │
│   #announcements    [Member View Only]           │
│   #rules            [Member View Only]           │
│   #server-info      [Member View Only]           │
│                                                  │
│ 📁 GENERAL                                       │
│   #general          [Member View & Use]          │
│   #off-topic        [Member View & Use]          │
│   #media            [Member View & Use]          │
│                                                  │
│ 📁 SUPPORT                                       │
│   #support          [Member View Only]   ← Ticket panel posted here
│   📁 Open Tickets   (category — auto-managed)    │
│   📁 Closed Tickets (category — auto-managed)    │
│                                                  │
│ 📁 PREMIUM                                       │
│   #vip-lounge       [Premium Only]               │
│   #premium-chat     [Premium Only]               │
│                                                  │
│ 📁 STAFF                                         │
│   #staff-chat       [Staff Only]                 │
│   #mod-log          [Staff Only]                 │
│   #ticket-logs      [Staff Only]   ← Transcripts │
│   #admin            [Staff Only]                 │
│                                                  │
│ 📁 VOICE                                         │
│   🔊 General Voice  [Member Voice]               │
│   🔊 Music          [Member Voice]               │
│   🔊 ➕ Create Channel [Temp Channel Hub]        │
│   🔊 Staff Voice    [Staff Voice Only]           │
│                                                  │
│ 📁 STATISTICS                                    │
│   🔊 👥 Members: 1,234  [Member View Only]       │
│   🔊 🟢 Online: 456     [Member View Only]       │
│   🔊 ⭐ Premium: 42     [Member View Only]       │
└──────────────────────────────────────────────────┘
```

---

## 12. Server Setup & Deployment Flow

### 12.1 The Setup Wizard

The setup wizard is a multi-step flow in the dashboard. It is the ONLY way to configure the server structure. The bot does not accept slash commands for server management.

**Step 1: @everyone & Onboarding**
- Configure @everyone to grant zero permissions (enforced, with explanation)
- Enable Discord native onboarding
- Select the Member role that gets granted on onboarding completion
- Map interest selections to additional roles (optional)

**Step 2: Role Design**
- Start with built-in tiers: Cosmetic, Member, Moderator, Admin
- Add roles within each tier
- Name each role, set colors, hoist, mentionable
- Tag roles by source (manual, onboarding, level reward, purchase, reaction role)
- Arrange hierarchy (drag-and-drop)
- Create custom templates if needed

**Step 3: Channel Design**
- Create categories
- Add channels to each category
- Assign channel types (text, voice, forum, stage, announcement)
- Name everything, set topics, slowmode, NSFW flags
- Include support category (for tickets)
- Include statistics category (for stats channels)
- Include temp channel hub (for voice)

**Step 4: Permission Mapping**
- Assign channel templates to each channel
- Visual grid: rows = channels, columns = role templates
- Each cell shows the effective access level
- Color-coded: green = full access, yellow = read-only, red = hidden, gray = inherited
- Premium channels auto-mapped to premium roles
- Staff channels auto-mapped to moderator+ roles

**Step 5: Review**
- Full preview of what will be created in Discord
- Diff view if modifying an existing setup
- Warnings for potential issues (hierarchy conflicts, dangerous permissions)
- Bot permission check (can the bot actually make these changes?)
- @everyone = zero confirmation

**Step 6: Deploy**
- Owner clicks "Deploy to Discord"
- Bot sets @everyone to zero permissions
- Bot creates roles, channels, categories, and permission overrides
- Bot enables Discord native onboarding (if not already)
- Progress indicator for each step
- Audit log entry for every action
- Error handling with rollback capability

**Step 7: Confirm**
- Owner reviews the deployed server in Discord
- Manually clicks "Confirm Setup Complete" in the dashboard
- This is a deliberate gate — no auto-detection
- On confirmation: all locked features unlock
- Bot records the confirmed state as the "desired state" baseline for drift detection

### 12.2 Post-Setup Changes

After initial setup, changes are made through the individual management pages (Roles, Channels, Reactions, etc.). Each change follows the same pattern:
1. Owner edits in dashboard
2. Preview shows what will change
3. Owner confirms
4. Bot deploys the delta (only what changed)
5. Audit log records the change

---

## 13. Discord Permission Engine

### 13.1 Core Concepts

Discord's permission model (as implemented, not simplified):

1. **@everyone base permissions** — Every member starts with these. In SomniBot: ZERO.
2. **Role permissions** — OR'd together from all assigned roles
3. **Channel-level overrides** — Per role or per user, per channel
4. **Override evaluation order**: @everyone overrides → role overrides (all deny first, then all allow) → member-specific overrides
5. **Role hierarchy** — Higher roles can manage lower roles, not vice versa
6. **Server owner** — Has ALL permissions regardless of roles (not part of the role stack)
7. **ADMINISTRATOR bit** — Bypasses ALL permission checks including channel overrides. SomniBot never grants this.
8. **Bot managed role** — The role Discord auto-creates for the bot. Position in hierarchy determines what the bot can manage.

### 13.2 Effective Permission Calculator

```typescript
function computeEffectivePermissions(
  member: GuildMember,
  channel?: GuildChannel
): bigint {
  // Server owner has everything
  if (member.id === member.guild.ownerId) return ALL_PERMISSIONS;

  // Start with @everyone (which is 0n in SomniBot's model)
  let permissions = member.guild.roles.everyone.permissions.bitfield;

  // OR all role permissions
  for (const role of member.roles.cache.values()) {
    permissions |= role.permissions.bitfield;
  }

  // ADMINISTRATOR bypasses everything
  if ((permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  if (channel) {
    // Apply channel overrides (Discord's actual algorithm)
    const overrides = channel.permissionOverwrites.cache;

    // 1. @everyone override
    const everyoneOverride = overrides.get(member.guild.id);
    if (everyoneOverride) {
      permissions &= ~everyoneOverride.deny.bitfield;
      permissions |= everyoneOverride.allow.bitfield;
    }

    // 2. Role overrides (deny first, then allow)
    let roleDeny = 0n;
    let roleAllow = 0n;
    for (const role of member.roles.cache.values()) {
      const override = overrides.get(role.id);
      if (override) {
        roleDeny |= override.deny.bitfield;
        roleAllow |= override.allow.bitfield;
      }
    }
    permissions &= ~roleDeny;
    permissions |= roleAllow;

    // 3. Member-specific override
    const memberOverride = overrides.get(member.id);
    if (memberOverride) {
      permissions &= ~memberOverride.deny.bitfield;
      permissions |= memberOverride.allow.bitfield;
    }

    // VIEW_CHANNEL check — if denied, deny all channel permissions
    if ((permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL) === 0n) {
      return 0n;
    }
  }

  return permissions;
}
```

### 13.3 Safety Checks (pre-deployment)

Before the bot deploys any permission changes:

- **Diff preview**: Exact before/after comparison shown in dashboard
- **Dangerous permission warnings**: Visual alert when any template grants ADMINISTRATOR, MANAGE_GUILD, MANAGE_ROLES to non-admin tiers
- **Hierarchy conflict detection**: Warn if role ordering would prevent the bot from managing certain roles
- **Lock-out prevention**: Block changes that would remove the owner's admin access
- **Bot capability check**: Verify the bot has the permissions needed to make each change
- **ADMINISTRATOR prohibition**: Templates never grant ADMINISTRATOR. Dashboard warns if the owner tries to create a custom template with it.
- **@everyone guard**: Dashboard prevents granting any functional permissions to @everyone. If someone modifies @everyone in Discord directly, drift detection catches it and offers repair.

---

## 14. Bot Role Position Enforcement

### 14.1 Why It Matters

Discord's role hierarchy is strict: a bot can only manage roles *below* its own role in the hierarchy. If SomniBot's role is not at position #1 (directly below the server owner), it cannot manage all roles — which breaks the entire template, sync, moderation, and level reward system.

### 14.2 Detection

On every dashboard load, on bot startup, and on a periodic interval (every 5 minutes):

```typescript
async function checkBotRolePosition(guild: Guild): Promise<BotPositionStatus> {
  const botMember = guild.members.me;
  const botRole = botMember.roles.highest;
  const allRoles = guild.roles.cache.sort((a, b) => b.position - a.position);

  const rolesAboveBot = allRoles.filter(
    r => r.position > botRole.position && !r.managed && r.id !== guild.id
  );

  return {
    isTopPosition: rolesAboveBot.size === 0,
    botRolePosition: botRole.position,
    totalRoles: allRoles.size,
    rolesAboveBot: rolesAboveBot.map(r => ({ id: r.id, name: r.name, position: r.position })),
    unmanagedRoles: rolesAboveBot.map(r => r.name),
  };
}
```

### 14.3 Dashboard Response

**If bot role is NOT at top:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔴 SomniBot Cannot Manage All Roles                            │
│                                                                 │
│ The bot's role is not at the top of the hierarchy.              │
│ It cannot manage these roles: Admin, Moderator, VIP            │
│                                                                 │
│ To fix this:                                                    │
│ 1. Open Discord → Server Settings → Roles                      │
│ 2. Find "SomniBot" in the role list                            │
│ 3. Drag it to the very top (below your server owner badge)     │
│ 4. Click "Save Changes"                                         │
│                                                                 │
│ All management features are locked until this is resolved.      │
│ This page will automatically update when fixed.                 │
└─────────────────────────────────────────────────────────────────┘
```

This red banner appears at the top of EVERY dashboard page. All management features are locked. The banner auto-dismisses when the periodic check detects the fix.

---

## 15. Server Sync & Drift Detection

### 15.1 Desired State Model

When the owner deploys a setup through the dashboard, the resulting configuration is saved as the "desired state" in Supabase. The sync engine continuously compares actual Discord state against this desired state.

### 15.2 Sync Cycle

```
1. SNAPSHOT — Read current Discord state via API
   → All roles (positions, permissions, colors, hoist, mentionable)
   → All channels (type, position, topic, overwrites)
   → All permission overrides
   → @everyone permissions (must be 0n)

2. DIFF — Compare against desired state
   → Added/removed/modified roles
   → Added/removed/modified channels
   → Changed permissions or overrides
   → Hierarchy order changes
   → @everyone permission drift (someone gave @everyone permissions)

3. CLASSIFY — Determine drift type
   → EXTERNAL_CHANGE: Someone changed Discord settings manually
   → MISSING_RESOURCE: A role/channel was deleted outside the dashboard
   → EXTRA_RESOURCE: Something was created outside the dashboard
   → PERMISSION_DRIFT: Overrides changed from expected
   → EVERYONE_DRIFT: @everyone was given permissions (CRITICAL)

4. REPORT — Surface in dashboard
   → Real-time alert via Supabase Realtime
   → Drift details in audit log
   → Dashboard banner showing what drifted
   → EVERYONE_DRIFT gets a red critical alert

5. ACTION — Owner decides
   → "Repair" — Bot reapplies desired state (overwrite manual changes)
   → "Accept" — Update desired state to match current reality
   → "Ignore" — Dismiss this drift (one-time)
   → Auto-repair option (if enabled in settings): bot auto-fixes drift
```

### 15.3 Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sync_enabled` | `true` | Enable/disable sync engine |
| `sync_interval_minutes` | `15` | How often to check for drift |
| `sync_auto_repair` | `false` | Auto-fix drift without owner confirmation |
| `sync_auto_repair_everyone` | `true` | Always auto-repair @everyone drift (recommended) |

---

## 16. @everyone & Onboarding System

### 16.1 The @everyone Contract

In SomniBot, @everyone is **always** set to zero permissions. This is foundational — every other system depends on it.

**Why:**
- New members who join get @everyone automatically
- If @everyone has permissions, unverified members can see/do things before completing onboarding
- The Member role is the gate — it grants the real permissions
- This model ensures the welcome flow, moderation, and feature connections all work correctly

**What @everyone = 0 means:**
- A new member who joins sees ONLY Discord's native onboarding screen
- They cannot see any channels
- They cannot send any messages
- They cannot use any commands
- They cannot join any voice channels
- They are effectively in a lobby until they complete onboarding

### 16.2 Discord Native Onboarding Integration

Discord's built-in onboarding system (Server Settings → Onboarding):
- **Server Rules** — Members must accept rules to proceed
- **Customization Questions** — "What are you interested in?" → Maps to channels/roles
- **Default Channels** — Which channels appear after onboarding

SomniBot configures this through the dashboard and integrates it into the member lifecycle:

```typescript
// Bot detects onboarding completion via guildMemberUpdate event
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  // Discord sets the COMPLETED_ONBOARDING flag when a member finishes onboarding
  const wasOnboarding = oldMember.flags?.has(GuildMemberFlags.CompletedOnboarding) === false;
  const isCompleted = newMember.flags?.has(GuildMemberFlags.CompletedOnboarding) === true;

  if (wasOnboarding && isCompleted) {
    // Member just completed onboarding — grant Member role
    const config = await getGuildConfig(newMember.guild.id);
    await newMember.roles.add(config.member_role_id);

    // Fire platform event
    eventBus.emit({
      type: 'member.verified',
      memberId: newMember.id,
      roles: [config.member_role_id],
    });

    // This triggers the welcome system, automations, stats updates, etc.
  }
});
```

### 16.3 Returning Members

When a previously-known member rejoins:
1. Bot checks `guildMemberAdd` event
2. Looks up member in database by Discord ID
3. If found with active entitlements → restore entitled roles
4. If found with level data → restore level reward roles
5. If configured → skip welcome DM for returning members
6. Always → grant Member role (they still completed onboarding in the past)
7. Fire `member.joined` event with `returning: true`

### 16.4 Dashboard Configuration

The `/onboarding` page shows:

```
┌──────────────────────────────────────────────────────────────────┐
│ @everyone Permissions: 🔒 ZERO (locked — this is by design)     │
│ ℹ️ All permissions come from the Member role and above.         │
│                                                                 │
│ Discord Onboarding: ✅ Enabled                                  │
│                                                                 │
│ Member Role: [Verified Member ▼]  ← granted on completion      │
│                                                                 │
│ Interest Roles:                                                 │
│   "Music Fan" → [Music Lover role ▼]                           │
│   "Gamer" → [Gaming role ▼]                                    │
│   + Add Interest Mapping                                        │
│                                                                 │
│ Returning Members:                                              │
│   ☑ Skip welcome DM for returning members                      │
│   ☑ Auto-restore entitlement roles                             │
│   ☑ Auto-restore level roles                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 17. Welcome & Goodbye System

### 17.1 Welcome Flow

The welcome system activates when a member receives the Member role (either from onboarding completion or manual grant). This is NOT triggered by `guildMemberAdd` directly — that would fire before onboarding.

```
Member receives Member role
  → Welcome system checks configuration:
    1. Welcome channel message enabled? → Post welcome card/message
    2. Welcome DM enabled? → Send DM with server info
    3. Auto-roles configured? → Apply additional roles
    4. Fire automation trigger: "member.verified"
```

### 17.2 Welcome Message Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{user}` | User mention | `@Username` |
| `{user.name}` | Username (no mention) | `Username` |
| `{user.tag}` | Full tag | `Username#0` |
| `{user.avatar}` | Avatar URL | `https://cdn.discord...` |
| `{server}` | Server name | `My Server` |
| `{server.icon}` | Server icon URL | `https://cdn.discord...` |
| `{memberCount}` | Total members | `1,234` |
| `{memberNumber}` | This member's join number | `#1,234` |
| `{level}` | Member's level (for returning) | `15` |

### 17.3 Welcome Card

An image-based welcome card generated with `@napi-rs/canvas`:

```
┌───────────────────────────────────────────────┐
│                                               │
│     [Server Icon]                             │
│                                               │
│     Welcome to {server}!                      │
│                                               │
│     [User Avatar]                             │
│     Username                                  │
│     Member #1,234                             │
│                                               │
│     (SomniBot default theme, configurable)    │
└───────────────────────────────────────────────┘
```

The card background, colors, and layout are configurable in the dashboard. Default uses the SomniBot palette.

### 17.4 Goodbye System

Triggered by `guildMemberRemove`:
- Post goodbye message to configured channel
- Variables available: `{user.name}`, `{memberCount}`, `{duration}` (how long they were a member)
- Update statistics channels
- Fire `member.left` platform event
- XP/level data preserved (not deleted)
- Entitlements preserved (active subscriptions continue billing)

### 17.5 Configuration

Dashboard `/welcome` page:

```
Welcome Message:
  ☑ Enabled
  Channel: [#welcome ▼]
  Message: "Welcome to {server}, {user}! 🎉 You're member #{memberNumber}."
  ☑ Include welcome card image
  Card Background: [Upload or default]

Welcome DM:
  ☑ Enabled
  Message: "Hey {user.name}! Welcome to {server}. Check out #rules and #general to get started."

Auto-Roles (applied alongside Member role):
  + [Select additional roles to grant on welcome]

Goodbye Message:
  ☑ Enabled
  Channel: [#goodbye ▼]
  Message: "{user.name} left. They were with us for {duration}. 👋"
```

---

## 18. Moderation System

### 18.1 Architecture

The moderation system has three layers:

1. **Auto-Mod Rules** — Automated detection and action on rule violations
2. **Infraction System** — Tracking warnings, mutes, kicks, bans per member
3. **Escalation Chain** — Automatic escalation based on infraction count

### 18.2 Auto-Mod Rules

Each rule has: **trigger** (what to detect), **action** (what to do), **exemptions** (who is exempt).

| Rule Type | What It Detects | Default Action |
|-----------|----------------|----------------|
| **Word Filter** | Messages containing banned words/phrases (exact match, wildcard, or regex) | Delete + Warn |
| **Link Filter** | Messages containing URLs. Whitelist (only allowed domains) or blacklist (block specific domains). | Delete + Warn |
| **Invite Filter** | Messages containing Discord invite links (discord.gg/*, discord.com/invite/*) | Delete + Warn |
| **Spam Filter** | Rapid message sending (configurable: X messages in Y seconds) | Delete + Mute (5 min) |
| **Duplicate Filter** | Same message content repeated (configurable threshold) | Delete + Warn |
| **Caps Filter** | Messages exceeding a caps percentage threshold (e.g., >70% uppercase, minimum length) | Delete |
| **Mention Spam** | Messages mentioning more than X users/roles | Delete + Warn |
| **Newline Spam** | Messages with excessive newlines (wall of text) | Delete |

**Per-rule configuration:**
```typescript
interface AutoModRule {
  id: string;
  guildId: string;
  type: AutoModRuleType;
  enabled: boolean;
  config: Record<string, unknown>;  // Rule-specific: word list, threshold, domains, etc.
  action: 'delete' | 'warn' | 'mute' | 'kick' | 'ban';
  muteDurationMinutes?: number;
  exemptRoles: string[];    // Roles that bypass this rule
  exemptChannels: string[];  // Channels where this rule doesn't apply
  logToModChannel: boolean;
  created_at: Date;
}
```

**Exemptions:** By default, all roles using the Moderator or Admin template are exempt from auto-mod. The owner can add additional exempt roles.

### 18.3 Infraction System

Every moderation action (automatic or manual) creates an infraction record:

```typescript
interface Infraction {
  id: string;
  guildId: string;
  memberId: string;
  moderatorId: string;  // 'system' for auto-mod actions
  type: 'warn' | 'mute' | 'kick' | 'ban';
  reason: string;
  autoModRuleId?: string;  // If triggered by auto-mod
  duration?: number;  // For mutes: duration in minutes
  active: boolean;  // false = expired/pardoned
  pardoned: boolean;
  pardonedBy?: string;
  pardonedAt?: Date;
  expiresAt?: Date;  // For warns: when this infraction falls off
  createdAt: Date;
}
```

**Infraction expiry:** Warnings can optionally expire after a configurable period (e.g., 30 days). After expiry, they no longer count toward escalation thresholds but remain in the record.

### 18.4 Escalation Chain

Configurable thresholds that auto-escalate punishment:

```
┌────────────────────────────────────────────────────┐
│ Escalation Chain (Default — fully configurable)     │
│                                                    │
│ Active Warnings 1-2: ⚠️ Warning logged             │
│ Active Warnings 3:   🔇 Auto-mute (1 hour)        │
│ Active Warnings 4:   🔇 Auto-mute (24 hours)      │
│ Active Warnings 5:   👢 Auto-kick                  │
│ Active Warnings 6+:  🔨 Auto-ban                   │
│                                                    │
│ Each step is configurable:                         │
│ - Threshold (number of active warnings)            │
│ - Action (warn/mute/kick/ban)                      │
│ - Duration (for mutes)                             │
│ - Notification (DM the member)                     │
└────────────────────────────────────────────────────┘
```

**Mutes use Discord native timeout** (`MODERATE_MEMBERS` permission → `member.timeout()`). This is preferred over role-based muting because:
- Discord natively shows timeout status
- Timeout respects all channel overrides
- No muted role to manage
- Built-in timer — auto-unmutes

### 18.5 Mod Log

All moderation actions are posted to a configured mod-log channel:

```
┌─────────────────────────────────────────────┐
│ Container (accent: #FF6B00 Orange)           │
│                                              │
│  Text: "⚠️ **Warning Issued**"              │
│  Separator                                   │
│  Text: "**Member:** @Username"               │
│  Text: "**Moderator:** System (Auto-Mod)"    │
│  Text: "**Reason:** Spam filter triggered"   │
│  Text: "**Active Warnings:** 3/5"           │
│  Text: "**Next Escalation:** Mute (1hr)"    │
│                                              │
│  ActionRow:                                  │
│    [👁️ View History] [🔄 Pardon]            │
└─────────────────────────────────────────────┘
```

### 18.6 Moderation ↔ Commerce Interaction

When a member with active entitlements is moderated:

| Action | Entitlement Impact |
|--------|-------------------|
| **Warn** | No impact on entitlements |
| **Mute (timeout)** | No impact — member keeps roles, just can't interact |
| **Kick** | Entitlements preserved. If member rejoins, roles are restored. |
| **Ban** | Entitlements SUSPENDED (not revoked). If unbanned, roles restore. Owner can choose to revoke from dashboard. Subscriptions continue billing unless owner cancels. |

This prevents accidental revenue loss from moderation actions while still protecting the community.

---

## 19. Ticketing System

### 19.1 Architecture

The ticketing system creates private, temporary text channels for 1:1 support conversations between members and staff.

```
Member clicks ticket button in #support
  → Bot creates private channel in "Open Tickets" category
  → Channel permissions: member + ticket managers only
  → Introduction message posted with ticket info
  → Staff notified
  → Conversation happens in channel
  → Staff or member closes ticket
  → Transcript generated and saved
  → Channel deleted (or moved to "Closed" category)
```

### 19.2 Ticket Panels

Ticket panels are the entry point. They are persistent messages in a channel (e.g., #support) with buttons or dropdowns for opening tickets.

```typescript
interface TicketPanel {
  id: string;
  guildId: string;
  name: string;
  channelId: string;            // Where the panel is posted
  messageId: string;            // The posted message ID
  panelMessage: EmbedConfig;    // Built with embed builder
  inputMode: 'buttons' | 'dropdown';
  ticketTypes: TicketType[];
  managerRoles: string[];       // Roles that manage all tickets from this panel
  openCategory: string;         // Discord category for open tickets
  closedCategory?: string;      // Discord category for closed tickets (optional)
  transcriptChannelId?: string; // Channel to post transcripts
  dmTranscriptToCreator: boolean;
  maxOpenPerUser: number;       // Default: 3
  introductionMessage: string;  // Posted when ticket opens
  active: boolean;
  created_at: Date;
}

interface TicketType {
  id: string;
  label: string;                // "Billing", "Technical", "General"
  emoji: string;                // 💳, 🔧, ❓
  color: 'blue' | 'grey' | 'green' | 'red';  // Button color (buttons mode)
  description?: string;         // Dropdown description
  categoryOverride?: string;    // Use different category for this type
  managerRoleOverride?: string[]; // Different managers for this type
  introMessageOverride?: string;  // Different intro for this type
}
```

### 19.3 Ticket Lifecycle

```
OPEN → CLAIMED → CLOSED → DELETED
         ↑                    │
         └── REOPENED ◄───────┘ (optional, within grace period)
```

| State | Description |
|-------|-------------|
| **OPEN** | Channel created, waiting for staff response |
| **CLAIMED** | A staff member claimed the ticket (optional feature) |
| **CLOSED** | Resolved, transcript generated, channel permissions locked |
| **DELETED** | Channel removed from Discord |
| **REOPENED** | Closed ticket reopened within grace period |

### 19.4 Ticket Channel Creation

```typescript
async function createTicket(
  member: GuildMember,
  panel: TicketPanel,
  ticketType: TicketType
): Promise<TextChannel> {
  const ticketNumber = await getNextTicketNumber(panel.guildId);
  const channelName = `ticket-${ticketNumber}-${member.user.username}`;

  const channel = await member.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: ticketType.categoryOverride || panel.openCategory,
    permissionOverwrites: [
      // Deny @everyone
      { id: member.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      // Allow ticket creator
      { id: member.id, allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ]},
      // Allow bot
      { id: member.guild.members.me.id, allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ]},
      // Allow ticket managers
      ...panel.managerRoles.map(roleId => ({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })),
    ],
  });

  // Post introduction message
  await channel.send(buildTicketIntro(member, panel, ticketType, ticketNumber));

  // Save ticket record
  await saveTicket({
    guildId: panel.guildId,
    panelId: panel.id,
    channelId: channel.id,
    ticketNumber,
    creatorId: member.id,
    type: ticketType.id,
    status: 'open',
  });

  // Fire platform event
  eventBus.emit({
    type: 'ticket.opened',
    memberId: member.id,
    ticketId: ticketNumber.toString(),
    category: ticketType.label,
  });

  return channel;
}
```

### 19.5 Commerce Integration

When a ticket is opened with "Billing" type, the ticket introduction message includes:

```
┌─────────────────────────────────────────────┐
│ Container (accent: #00D4FF Cyan)             │
│                                              │
│  Text: "🎫 **Ticket #127 — Billing**"       │
│  Separator                                   │
│  Text: "Welcome {user}! A staff member"      │
│  Text: "will be with you shortly."           │
│  Text: ""                                    │
│  Text: "💡 **Tip:** Include your order"      │
│  Text: "number (e.g., INS-00042) for"        │
│  Text: "faster assistance."                  │
│                                              │
│  ActionRow:                                  │
│    [🔒 Close Ticket] [📋 Transcript]         │
└─────────────────────────────────────────────┘
```

**Note:** The ticket intro message is what the *customer* sees. It never includes staff instructions, internal dashboard URLs, or operational details. Staff instructions (like "use the dashboard to look up orders at /orders") belong in staff documentation and the `#staff-chat` channel topic, not in customer-facing messages.

Staff can search `INS-00042` in the dashboard → see full order history, entitlement status, payment details → take action (extend, refund, reissue) — all without leaving the dashboard.

### 19.6 Transcripts

On ticket close:
1. Bot reads all messages from the ticket channel
2. Generates an HTML transcript (formatted, with timestamps, attachments, embeds)
3. Posts transcript to the configured transcript channel (staff-only)
4. Optionally DMs the transcript file to the ticket creator
5. Records transcript URL/ID in the ticket database record

```typescript
interface TicketTranscript {
  ticketId: string;
  ticketNumber: number;
  creatorId: string;
  closedById: string;
  messageCount: number;
  participantIds: string[];
  htmlFilePath: string;   // Supabase Storage path
  createdAt: Date;
}
```

---

## 20. Automations Engine

### 20.1 Architecture

The automations engine is the central nervous system of SomniBot. It listens to platform events and executes configured workflows.

```
Platform Event fires
  → Automation Engine receives event
  → Iterates all active automations
  → For each automation:
    1. Does the trigger match this event? → If no, skip
    2. Does the event fall within the automation's scope? → If no, skip
    3. Do ALL conditions pass? → If no, skip
    4. Execute all actions in order
    5. Log execution result
```

### 20.2 Triggers

| Trigger | Event Source | Available Data |
|---------|-------------|---------------|
| **Member Joins** | `guildMemberAdd` | `{user}`, `{memberCount}`, `{returning}` |
| **Member Leaves** | `guildMemberRemove` | `{user}`, `{memberCount}`, `{duration}` |
| **Member Verified** | `member.verified` (onboarding complete) | `{user}`, `{memberNumber}` |
| **Sends a Message** | `messageCreate` | `{user}`, `{channel}`, `{message}`, `{content}` |
| **Gains a Role** | `role.gained` | `{user}`, `{role}`, `{source}` |
| **Loses a Role** | `role.lost` | `{user}`, `{role}`, `{source}` |
| **Reaches Level** | `level.up` | `{user}`, `{oldLevel}`, `{newLevel}` |
| **Purchases Product** | `purchase.completed` | `{user}`, `{product}`, `{order}`, `{amount}` |
| **Subscription Activated** | `subscription.activated` | `{user}`, `{plan}` |
| **Subscription Lapsed** | `subscription.lapsed` | `{user}`, `{plan}` |
| **Ticket Opened** | `ticket.opened` | `{user}`, `{ticket}`, `{category}` |
| **Ticket Closed** | `ticket.closed` | `{ticket}`, `{resolution}` |
| **Giveaway Ended** | `giveaway.ended` | `{giveaway}`, `{winners}` |
| **Button Clicked** | Component interaction | `{user}`, `{buttonId}` |
| **Reaction Added** | `messageReactionAdd` | `{user}`, `{emoji}`, `{channel}`, `{message}` |
| **Voice Channel Joined** | `voiceStateUpdate` | `{user}`, `{channel}` |
| **Voice Channel Left** | `voiceStateUpdate` | `{user}`, `{channel}` |
| **Infraction Created** | `infraction.created` | `{user}`, `{type}`, `{reason}`, `{count}` |

### 20.2.1 Trigger Scoping — NEW v4

Every automation trigger has built-in scope filters. These determine *who* and *where* the automation applies before conditions are even evaluated. Scope filters are optional — when empty, the automation applies to the entire server.

```typescript
interface AutomationScope {
  target_user_ids: string[];      // Only fire for these user IDs. Empty = all users.
  target_channel_ids: string[];   // Only fire in these channels. Empty = all channels.
  exclude_user_ids: string[];     // Never fire for these user IDs. Empty = no exclusions.
  exclude_channel_ids: string[];  // Never fire in these channels. Empty = no exclusions.
}

// Evaluation order:
// 1. If target_user_ids is non-empty → user must be in list, else skip
// 2. If exclude_user_ids is non-empty → user must NOT be in list, else skip
// 3. If target_channel_ids is non-empty → channel must be in list, else skip
// 4. If exclude_channel_ids is non-empty → channel must NOT be in list, else skip
// 5. If all scope checks pass → proceed to conditions
```

**Scope vs. Conditions:** Scope is a lightweight pre-filter that runs before conditions. It's faster because it's a simple ID check — no database lookups. Use scope for "this automation only runs in #general for @SpecificUser." Use conditions for complex checks like "user has role X" or "user level ≥ 10."

**Dashboard UI:**

In the automation builder, each trigger has an expandable "Scope" section:

```
┌──────────────────────────────────────────────────────────┐
│ Trigger: Member Sends a Message                          │
│                                                          │
│ ▸ Scope (optional)                                       │
│   ┌────────────────────────────────────────────────────┐ │
│   │ Target Users: [Multi-select user picker]           │ │
│   │ Exclude Users: [Multi-select user picker]          │ │
│   │ Target Channels: [Multi-select channel picker]     │ │
│   │ Exclude Channels: [Multi-select channel picker]    │ │
│   │                                                    │ │
│   │ ℹ️ Leave empty for full server scope.              │ │
│   └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Default:** All scope arrays are empty = the automation applies to the entire server. This is the expected behavior for most automations.

### 20.3 Conditions

Conditions are AND'd — all must pass for the automation to fire.

| Condition | Description |
|-----------|-------------|
| **User Has Role** | Member has a specific role |
| **User Missing Role** | Member does NOT have a specific role |
| **User Level ≥ X** | Member's level is at or above threshold |
| **In Channel** | Event happened in a specific channel/category |
| **Not In Channel** | Event did NOT happen in a specific channel |
| **Message Contains** | Message contains specific words/phrases (case insensitive) |
| **Message Matches Regex** | Message matches a regex pattern |
| **Is Returning Member** | Member has previously been in the server |
| **Is New Member** | Member has never been in the server before |
| **Has Entitlement** | Member has an active entitlement for a specific product |
| **Time Window** | Current time is within a specified range (e.g., weekdays only) |

### 20.4 Actions

Actions execute in order. A delay action pauses before the next action.

| Action | Description | Parameters |
|--------|-------------|-----------|
| **Send Message in Channel** | Post a message (with variables) in a specified channel | `channelId`, `message` (supports variables + embed builder) |
| **Send DM** | DM the triggering user | `message` (supports variables) |
| **Reply to Message** | Reply to the message that triggered the automation | `message` |
| **Give Role** | Assign a role to the triggering user | `roleId` |
| **Remove Role** | Remove a role from the triggering user | `roleId` |
| **Add Reaction** | React to the triggering message | `emoji` |
| **Delete Message** | Delete the triggering message | — |
| **Create Thread** | Create a thread on the triggering message | `name`, `autoArchiveDuration` |
| **Wait/Delay** | Pause for a duration before next action | `seconds` (max 3600) |
| **Grant Entitlement** | Grant a product entitlement (no payment) | `productId` |
| **Log to Channel** | Post an audit entry to a log channel | `channelId`, `message` |

### 20.5 Automation Examples

**Example 1: Premium Welcome**
```yaml
name: "Premium Welcome"
trigger: purchase.completed
conditions:
  - product.name == "VIP Access"
actions:
  - send_message:
      channel: "#vip-lounge"
      message: "🎉 Welcome to VIP, {user}! Enjoy your exclusive perks."
  - give_role: "VIP Spotlight"
  - send_dm: "Thanks for your purchase! Your VIP benefits are now active."
```

**Example 2: Level 10 Unlock**
```yaml
name: "Level 10 Channel Unlock"
trigger: level.up
conditions:
  - newLevel >= 10
  - user.missing_role: "Level 10"
actions:
  - give_role: "Level 10"
  - send_message:
      channel: "#level-ups"
      message: "🎊 {user} just reached Level 10! Welcome to the inner circle."
```

**Example 3: Subscription Recovery**
```yaml
name: "Subscription Lapse Notification"
trigger: subscription.lapsed
conditions: []
actions:
  - send_dm: "Hey {user.name}, your subscription has lapsed. You have 3 days to renew before access is revoked. Visit the server to re-subscribe!"
  - log_to_channel:
      channel: "#staff-chat"
      message: "⚠️ Subscription lapsed: {user} — {plan.name}"
```

**Example 4: Verified Member Routing**
```yaml
name: "Interest-Based Welcome"
trigger: member.verified
conditions:
  - user.has_role: "Music Fan"
actions:
  - send_message:
      channel: "#music-chat"
      message: "🎵 {user} just joined and they're a music fan! Welcome!"
  - delay: 5
  - send_dm: "Since you're into music, check out /play in any voice channel!"
```

### 20.6 Rate Limiting

Automations are rate-limited to prevent abuse:
- Max 10 actions per automation execution
- Max 5 automation fires per user per minute (across all automations)
- Delay between consecutive role grants: 1 second (Discord rate limit protection)
- DM rate limit: 1 DM per user per automation per 5 minutes
- All rate limit state tracked in Valkey

### 20.7 Execution Logging

Every automation execution is logged:

```typescript
interface AutomationExecution {
  automationId: string;
  triggeredBy: string;        // User ID or 'system'
  triggerEvent: string;       // Event type
  conditionsPassed: boolean;
  actionsExecuted: number;
  actionsFailed: number;
  errors: string[];
  duration_ms: number;
  timestamp: Date;
}
```

Dashboard `/automations` page shows recent executions per automation for debugging.

### 20.8 Pre-Built Automation Templates — NEW v4

The dashboard ships with a library of pre-built automation templates. These are production-ready automations that cover common use cases. The owner can deploy them with one click, and the dashboard auto-maps roles/channels from the server's existing configuration.

**Template Library:**

| Template | Trigger | Actions | Notes |
|----------|---------|---------|-------|
| **Welcome DM** | `member.verified` | Send DM with server info and key channels | Auto-maps `{server}`, `{user}` |
| **Level Role Reward** | `level.up` | Grant role at threshold, remove previous tier | Auto-maps to configured level reward roles |
| **Auto-Mute Escalation** | `infraction.created` | Check count → mute → kick → ban | Pre-configured escalation chain. Mirrors §18.4 but as a standalone automation. |
| **Purchase Announcement** | `purchase.completed` | Post to premium channel, DM receipt | Auto-maps to store channel and product roles |
| **Ticket Auto-Claim** | `ticket.opened` | Assign ticket to first available staff member | Requires ticket manager roles configured |
| **Subscription Lapse Warning** | `subscription.lapsed` | DM warning, log to staff | 3-day grace period reminder |
| **Voice XP Bonus** | `voice.joined` | Grant bonus XP for joining voice during events | Scoped to specific voice channels, time window condition |
| **VIP Welcome** | `role.gained` | Post welcome in VIP channel when VIP role added | Scoped to VIP role, auto-maps to premium channel |
| **Inactivity Reminder** | `member.verified` + delay | DM members who haven't chatted in X days | Uses condition: no messages in N days |
| **Birthday Celebration** | (manual trigger) | Post birthday message, grant "Birthday 🎂" role for 24h | Template for manual/scheduled use |
| **Anti-Raid Mode** | `member.joined` | If X joins in Y seconds, lock server | Uses rate condition, auto-mod integration |
| **Content Creator Spotlight** | `message.sent` + condition | If message in #showcase, auto-react with ⭐ and cross-post | Scoped to showcase channel |

**One-Click Deploy Flow:**

```
Owner opens template library → Clicks "Use Template"
  → Dashboard shows pre-filled automation
  → Auto-maps:
    - Roles → Matches template tier names to existing roles
    - Channels → Matches channel purpose to existing channels (or shows dropdown)
    - Variables → Pre-filled with server context
  → Owner reviews, adjusts if needed
  → Clicks "Save & Enable"
  → Automation is live
```

**Auto-Mapping Logic:**
- Role templates named "VIP" → maps to roles with "VIP" in the name, or roles tagged as "purchase" source
- Channels named "#welcome" → maps to the configured welcome channel
- Staff roles → maps to roles using the Moderator or Admin template
- If no match found → field is blank, owner must select manually

Templates are stored in `packages/shared/src/constants/automation-templates.ts` and versioned with the codebase.

---

## 21. Custom Commands

### 21.1 Architecture

Custom commands are slash commands created by the owner in the dashboard. They are registered with Discord's API at runtime and handled by the bot's dynamic command loader.

### 21.2 Command Definition

```typescript
interface CustomCommand {
  id: string;
  guildId: string;
  name: string;                   // Slash command name (lowercase, no spaces, max 32 chars)
  description: string;            // Shown in Discord's command picker
  actions: CustomCommandAction[]; // Up to 5 actions
  allowedRoles: string[];         // Empty = everyone can use
  allowedChannels: string[];      // Empty = all channels
  deniedRoles: string[];          // Roles that cannot use this command
  deniedChannels: string[];       // Channels where command is blocked
  cooldownSeconds: number;        // Per-user cooldown
  ephemeral: boolean;             // Response visible only to user?
  enabled: boolean;
  created_at: Date;
}

type CustomCommandAction =
  | { type: 'send_message'; message: string; channelId?: string }  // Current channel if not specified
  | { type: 'send_embed'; embedConfig: EmbedConfig }
  | { type: 'give_role'; roleId: string }
  | { type: 'remove_role'; roleId: string }
  | { type: 'send_dm'; message: string };
```

### 21.3 Variables

Custom commands support the same variable system as automations:

| Variable | Description |
|----------|-------------|
| `{user}` | Command user mention |
| `{user.name}` | Username |
| `{channel}` | Current channel mention |
| `{server}` | Server name |
| `{memberCount}` | Total members |
| `{arg1}`, `{arg2}`, etc. | Command arguments (if defined) |

### 21.4 Registration

When a custom command is created/updated in the dashboard:
1. Dashboard saves to Supabase
2. Bot receives via Realtime
3. Bot registers/updates the slash command with Discord API (`guild.commands.create()`)
4. Bot adds handler to dynamic command registry

When a custom command is deleted:
1. Dashboard deletes from Supabase
2. Bot receives via Realtime
3. Bot unregisters the slash command from Discord
4. Bot removes handler from registry

### 21.5 Limits

- Max 200 custom commands per guild (Discord allows up to 100 guild commands — implementation note: if Discord's limit is 100, the dashboard caps at 100 with explanation)
- Max 5 actions per command
- Max 32 character command name
- Max 100 character description
- Command names must be unique, lowercase, no spaces

---

## 22. Embed & Message Builder

### 22.1 Purpose

The embed/message builder is a dashboard tool for composing rich messages that the bot posts in Discord. It's used directly AND as a building block for other features (ticket panels, welcome messages, scheduled messages, custom command responses).

### 22.2 Builder Interface

```
┌──────────────────────────────────────────────────────────────────┐
│ Embed Builder                                                     │
│                                                                   │
│ ┌────────────────────────┐  ┌──────────────────────────────────┐ │
│ │ EDITOR                 │  │ LIVE PREVIEW                     │ │
│ │                        │  │                                  │ │
│ │ Title: [_____________] │  │ ┌────────────────────────────┐   │ │
│ │ Description:           │  │ │ Title                      │   │ │
│ │ [__________________]   │  │ │ Description text here...   │   │ │
│ │ [__________________]   │  │ │                            │   │ │
│ │                        │  │ │ Field 1    Field 2         │   │ │
│ │ Color: [#FF1493 ▼]     │  │ │ Value 1    Value 2         │   │ │
│ │ Image: [Upload/URL]    │  │ │                            │   │ │
│ │ Thumbnail: [Upload/URL]│  │ │ [Image]                    │   │ │
│ │ Footer: [_____________]│  │ │                            │   │ │
│ │ Author: [_____________]│  │ │ Footer text                │   │ │
│ │                        │  │ └────────────────────────────┘   │ │
│ │ Fields:                │  │                                  │ │
│ │ + [Add Field]          │  │                                  │ │
│ │                        │  │                                  │ │
│ └────────────────────────┘  └──────────────────────────────────┘ │
│                                                                   │
│ [Save as Template]  [Post to Channel ▼]  [Schedule Post]         │
└──────────────────────────────────────────────────────────────────┘
```

### 22.3 Features

- **Visual editor** — All embed fields with live preview
- **Variable support** — `{user}`, `{server}`, `{memberCount}`, etc.
- **Save as template** — Reusable across features
- **Post immediately** — Select channel, post now
- **Schedule** — Select channel + date/time → scheduled message
- **Components v2 option** — Build as Components v2 message with containers, sections, action rows, buttons
- **Integration** — Ticket panels, welcome messages, custom commands, and scheduled messages can reference saved embed templates

### 22.4 Embed Config Type

```typescript
interface EmbedConfig {
  id: string;
  guildId: string;
  name: string;           // Template name (for saved templates)
  title?: string;
  description?: string;
  color?: number;          // Hex color
  fields: EmbedField[];
  imageUrl?: string;
  thumbnailUrl?: string;
  footerText?: string;
  footerIconUrl?: string;
  authorName?: string;
  authorUrl?: string;
  authorIconUrl?: string;
  timestamp?: boolean;     // Include current timestamp
  useComponentsV2?: boolean; // Send as Components v2 instead of embed
  created_at: Date;
}

interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}
```

---

## 23. Reaction Roles System

### 23.1 Architecture

Reaction roles are configured in the dashboard and cached in Valkey for fast lookup. The bot handles the Discord events.

```typescript
interface ReactionRoleConfig {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  emoji: string;              // Unicode emoji or custom emoji ID
  roleId: string;
  exclusiveGroup?: string;    // Mutual exclusion group name
  requireRole?: string;       // Must have this role to use (e.g., level requirement)
  requireLevel?: number;      // Must be at least this level
  removeOnUnreact: boolean;
  maxPerGroup?: number;       // Max selections from this group
  logActions: boolean;
  active: boolean;
}
```

### 23.2 Flow

**Setup (dashboard only):**
1. Owner creates a reaction role config in `/reactions`
2. Specifies: which channel, message content (via embed builder), emoji-to-role mappings
3. Optional: exclusive groups, prerequisite roles/levels, max selections
4. Dashboard sends config to Supabase
5. Bot receives via Realtime, posts the message with reactions, caches config in Valkey

**Member reacts:**
1. `messageReactionAdd` fires
2. Bot checks Valkey cache: `reactionRoles:${messageId}:${emoji}`
3. Validates: role exists, bot can assign, member meets prerequisites (role + level)
4. If exclusive group: remove other roles in group first
5. If max reached: deny with ephemeral message
6. Assign role
7. Fire `role.gained` platform event (source: `reaction_role`)
8. Log to audit trail

**Member unreacts:**
1. `messageReactionRemove` fires
2. If `removeOnUnreact`: remove role
3. Fire `role.lost` platform event (source: `reaction_role`)
4. Log to audit trail

**Recovery (bot restart):**
1. Load all active configs from Supabase
2. Repopulate Valkey cache
3. Verify all referenced messages still exist (mark orphaned if deleted)
4. Alert dashboard for orphaned configs

### 23.3 Conflict Handling

- **Exclusive groups**: Only one role from a group at a time (e.g., team colors)
- **Prerequisite roles**: Must have a base role to pick from a group (e.g., must be "Verified" to choose team colors)
- **Level prerequisite**: Must be at least level X to use (connects to Levels system)
- **Max per group**: Configurable limit (e.g., max 2 color roles from the cosmetic group)
- **Hierarchy check**: Bot can only assign roles below its own position

---

## 24. Levels & XP System

### 24.1 Architecture

The levels system tracks member activity and rewards progression with roles and channel access.

### 24.2 XP Earning

**Message XP:**
- When a member sends a message, they earn a random amount of XP between `min_xp` and `max_xp` (default: 15-25)
- XP is only granted once per `cooldown_seconds` per user (default: 60 seconds) — tracked in Valkey
- XP is NOT granted in blacklisted channels
- If the channel is in the whitelist (when whitelist is non-empty), only those channels count

**Voice XP (optional):**
- Members earn XP for time spent in voice channels
- Default: 10 XP per 5 minutes of active voice time
- Must not be muted/deafened to earn
- AFK channel does not count
- Temporary channels count

### 24.3 Level Curve

```typescript
// XP required to reach level N
function xpForLevel(level: number): number {
  // Standard curve: 5 * (level^2) + 50 * level + 100
  return 5 * Math.pow(level, 2) + 50 * level + 100;
}

// Total XP from level 0 to level N
function totalXpForLevel(level: number): number {
  let total = 0;
  for (let i = 0; i < level; i++) {
    total += xpForLevel(i);
  }
  return total;
}

// Example levels:
// Level 1:  155 XP
// Level 5:  475 XP
// Level 10: 1,050 XP
// Level 20: 3,100 XP
// Level 50: 15,100 XP
// Level 100: 55,100 XP (per level; total cumulative: ~1.8M)
```

### 24.4 XP Multipliers

Roles can have XP multipliers:

```typescript
interface XpMultiplier {
  roleId: string;
  multiplier: number;  // e.g., 1.5 = 50% bonus
}

// Multiple multipliers stack additively:
// Member (1.0x) + Booster (1.5x) = 1.5x total
// Member (1.0x) + VIP (2.0x) = 2.0x total
// Member (1.0x) + VIP (2.0x) + Weekend Event (1.25x) = 2.25x total
// Highest single multiplier wins (no stacking), OR additive — configurable
```

The default is **highest wins** (simpler, prevents exploitation). Owner can switch to additive in settings.

### 24.5 Role Rewards

When a member reaches a level threshold, they automatically receive a role:

```typescript
interface LevelReward {
  level: number;
  roleId: string;
  removeAtLevel?: number;  // Optional: remove this role at a higher level (upgrade path)
  announcement: boolean;   // Announce this reward
}

// Example:
// Level 5  → "Regular" role (access to #regulars)
// Level 10 → "Trusted" role (access to #trusted, remove "Regular")
// Level 25 → "Veteran" role (access to #veteran, remove "Trusted")
// Level 50 → "Legend" role (cosmetic + access to everything)
```

When `removeAtLevel` is set, the bot automatically removes the lower reward when the higher one is granted. This creates a clean progression path.

The granted roles should use channel templates (e.g., "Premium Only" variant) that unlock specific channels — connecting levels to channel access.

### 24.6 Level-Up Announcements

When a member levels up:
1. If announcement channel is configured: post level-up message
2. If the new level matches a role reward threshold: grant role + post reward message
3. Fire `level.up` platform event
4. If role reward granted: fire `role.gained` event (source: `level_reward`)

Announcement message supports variables:
- `{user}`, `{level}`, `{totalXp}`, `{rank}`, `{nextLevelXp}`

### 24.7 Rank Card

`/rank [user]` generates a visual rank card using `@napi-rs/canvas`:

```
┌───────────────────────────────────────────────┐
│  [Avatar]  Username                           │
│            Level 15 · Rank #3                 │
│            ▰▰▰▰▰▰▰▱▱▱  2,340 / 3,000 XP    │
│            Total: 24,680 XP                   │
│            Messages: 1,247                    │
│            (user-customized or server default) │
└───────────────────────────────────────────────┘
```

**Customization hierarchy:**
1. **Server defaults** — Set by the owner in dashboard `/levels` page. Applies to all members who haven't customized.
2. **Per-user overrides** — Members can customize their own rank card via `/rank customize`. Their settings override server defaults.

**Per-user customizable properties:**
- **Background image** — URL or upload (stored in Supabase Storage `rank-card-assets` bucket)
- **Accent color** — Hex color for progress bar border and highlights
- **Progress bar color** — Hex color for the filled portion
- **Opacity** — Background overlay opacity (0.0–1.0, controls text readability)
- **Font color** — Light or dark text (auto-detected from background, but overridable)

**`/rank customize` command:**
| Subcommand | Description |
|------------|-------------|
| `/rank customize background <url_or_upload>` | Set background image |
| `/rank customize accent <hex_color>` | Set accent color |
| `/rank customize progress-bar <hex_color>` | Set progress bar fill color |
| `/rank customize opacity <0.0-1.0>` | Set background overlay opacity |
| `/rank customize reset` | Reset to server defaults |
| `/rank customize preview` | Preview current card without posting |

Rank card rendering priority:
1. Check `member_rank_settings` for user override → use if present
2. Fall back to `guild_config.rank_card_*` server defaults
3. Fall back to SomniBot palette defaults

**Important:** Rank card customization is purely cosmetic and available to ALL members, not gated by level or purchase. It's a personalization feature.

### 24.8 Leaderboard

`/leaderboard` shows a paginated server leaderboard:

```
┌─────────────────────────────────────────────┐
│ Container (accent: #FF1493 Hot Pink)         │
│                                              │
│  Text: "🏆 **Server Leaderboard**"          │
│  Separator                                   │
│  Text: "1. **Username1** — Level 42 (85K XP)│
│  Text: "2. **Username2** — Level 38 (72K XP)│
│  Text: "3. **Username3** — Level 35 (65K XP)│
│  Text: "4. **Username4** — Level 31 (58K XP)│
│  Text: "5. **Username5** — Level 29 (52K XP)│
│  ... (10 per page)                           │
│                                              │
│  ActionRow:                                  │
│    [◀ Previous] [Page 1/12] [▶ Next]        │
└─────────────────────────────────────────────┘
```

### 24.9 Data Persistence

- XP and level data are stored in Supabase (`member_levels` table)
- XP cooldown tracking is in Valkey (ephemeral, TTL-based)
- When a member leaves and returns, their XP and level are preserved
- Level reward roles are re-granted on return (see §16.3)
- Admin can reset/adjust XP from the dashboard

### 24.10 Configuration

Dashboard `/levels` page:

```
Levels System: ☑ Enabled

XP Settings:
  Min XP per message: [15]
  Max XP per message: [25]
  Cooldown (seconds): [60]
  
Voice XP: ☑ Enabled
  XP per 5 minutes: [10]

Level-Up Announcements:
  Channel: [#level-ups ▼]
  Message: "🎉 {user} just reached **Level {level}**!"

Role Rewards:
  Level 5  → [Regular ▼]    Remove at: [Level 10]
  Level 10 → [Trusted ▼]    Remove at: [Level 25]
  Level 25 → [Veteran ▼]    Remove at: [—]
  + Add Reward

XP Multipliers:
  [Booster ▼] → 1.5x
  [VIP ▼]     → 2.0x
  Stacking: [Highest wins ▼]

Channel Settings:
  Mode: [Blacklist ▼]
  Blacklisted: #bot-commands, #spam

Rank Card (Server Defaults):
  Background: [Upload or URL ▼]
  Accent Color: [#FF1493]
  Progress Bar Color: [#FF1493]
  Overlay Opacity: [0.7]
  
  ℹ️ These are server defaults. Members can customize their own
  rank card via /rank customize. Their settings override these.
```

---

## 25. Temporary Voice Channels

### 25.1 Architecture

The temporary voice channel system creates personal voice channels on demand. Members join a designated "hub" channel, and the bot automatically creates a new voice channel for them and moves them into it. When the channel is empty, it's deleted.

### 25.2 Flow

```
Member joins "➕ Create Channel" (hub voice channel)
  → Bot creates new voice channel: "Username's Channel"
  → Bot moves member into new channel
  → Member is now the "owner" of this channel
  → Owner can: rename, lock, set limit, permit/deny users, ban users
  → When all members leave the channel:
    → Wait {keep_alive_minutes} (default: 1)
    → If still empty: delete the channel
  → If owner leaves and someone else is in:
    → Channel persists, but ownership can be claimed by another member
```

### 25.3 Owner Controls

The channel owner has these commands (slash commands, only work in their temp channel):

| Command | Description |
|---------|-------------|
| `/voice-lock` | Make channel invite-only (deny @everyone CONNECT) |
| `/voice-unlock` | Restore default access |
| `/voice-limit <N>` | Set user limit (0 = unlimited) |
| `/voice-name <name>` | Rename the channel |
| `/voice-permit <user>` | Allow a specific user (even when locked) |
| `/voice-deny <user>` | Block a user from joining |
| `/voice-ban <user>` | Disconnect + deny a user |
| `/voice-claim` | Claim ownership of orphaned channel (when original owner left) |

### 25.4 Implementation

```typescript
interface TempChannelHub {
  id: string;
  guildId: string;
  hubChannelId: string;        // The voice channel that triggers creation
  categoryId: string;          // Category where temp channels are created
  namingFormat: string;        // "{username}'s Channel" or "#{index} — {username}"
  defaultUserLimit: number;    // 0 = unlimited
  defaultBitrate: number;
  keepAliveMinutes: number;    // Minutes to wait before deleting empty channel
  allowTextChannel: boolean;   // Create paired text channel
  moderatorRoles: string[];    // Roles that can manage any temp channel
  active: boolean;
}

interface ActiveTempChannel {
  channelId: string;
  textChannelId?: string;      // Paired text channel (if enabled)
  ownerId: string;
  hubId: string;
  createdAt: Date;
}
```

### 25.5 Events

- `voiceStateUpdate`: Monitor joins/leaves for hub channel, track empty temp channels
- `temp_channel.created` platform event: Triggers automations
- Stats channel updates: Active voice room count

---

## 26. Statistics Channels

### 26.1 Architecture

Statistics channels are voice channels whose names display live server stats. They are view-only — no one joins them. They serve as a dashboard on the server itself.

### 26.2 Available Stats

| Stat Type | Example Display | Source |
|-----------|----------------|--------|
| `total_members` | `👥 Members: 1,234` | Guild member count |
| `online_members` | `🟢 Online: 456` | Guild presence count |
| `bot_count` | `🤖 Bots: 12` | Bot member count |
| `role_count` | `👑 VIPs: 42` | Members with a specific role |
| `channel_count` | `📺 Channels: 28` | Total channel count |
| `premium_members` | `⭐ Premium: 42` | Members with any entitled role |
| `active_tickets` | `🎫 Open Tickets: 3` | Open ticket count |
| `total_xp_earned` | `✨ Total XP: 1.2M` | Sum of all member XP |
| `highest_level` | `🏆 Top Level: 42` | Highest member level |
| `custom_counter` | `🎉 Events: 12` | Manual counter (set via dashboard) |

### 26.3 Update Cycle

Stats channels update on a configurable interval (default: 10 minutes) using `node-cron`:

```typescript
// Every 10 minutes, update all stats channels
cron.schedule('*/10 * * * *', async () => {
  const statsChannels = await getStatsChannelConfigs(guildId);
  for (const config of statsChannels) {
    const value = await computeStat(config.statType, config.statConfig);
    const newName = config.nameFormat.replace('{count}', value.toLocaleString());
    await channel.setName(newName);
    // Rate limit: Discord allows 2 channel name updates per 10 minutes
    await sleep(5000); // Space out updates
  }
});
```

**Discord rate limit**: Channel name can only be changed twice per 10 minutes per channel. The bot schedules updates accordingly and spaces them out.

### 26.4 Configuration

Dashboard `/stats` page:

```
Statistics Channels: ☑ Enabled
Category: [📊 SERVER STATS ▼]
Update Interval: [10 minutes ▼]

Channels:
  [👥 Members: {count}]  Type: [Total Members ▼]   ☑ Active
  [🟢 Online: {count}]   Type: [Online Members ▼]  ☑ Active
  [⭐ Premium: {count}]  Type: [Role Count ▼]       Role: [VIP ▼]   ☑ Active
  [🎫 Tickets: {count}]  Type: [Active Tickets ▼]  ☑ Active
  + Add Stats Channel
```

---

## 27. Scheduled Messages

### 27.1 Architecture

Scheduled messages are recurring bot posts in specified channels. They're managed in the dashboard and executed by `node-cron` in the bot.

### 27.2 Configuration

```typescript
interface ScheduledMessage {
  id: string;
  guildId: string;
  name: string;                     // "Daily Motivation", "Weekly Update"
  channelId: string;
  message: string;                  // Text with variables OR embed template reference
  embedConfigId?: string;           // Reference to saved embed template
  cronExpression: string;           // node-cron expression: "0 9 * * *" = daily at 9am
  timezone: string;                 // "America/New_York"
  startDate?: Date;                 // Don't send before this date
  endDate?: Date;                   // Stop after this date
  maxSends?: number;                // Total sends before auto-disable
  currentSends: number;
  active: boolean;
  lastSentAt?: Date;
  nextSendAt?: Date;                // Computed for dashboard display
  created_at: Date;
}
```

### 27.3 Dashboard Interface

```
Scheduled Messages:

[Daily Motivation]
  Channel: #general
  Schedule: Every day at 9:00 AM EST
  Next: May 17, 2026 at 9:00 AM
  Sends: 42/∞
  Status: ✅ Active
  [Edit] [Pause] [Delete]

[Weekly Update]
  Channel: #announcements
  Schedule: Every Monday at 12:00 PM EST
  Next: May 19, 2026 at 12:00 PM
  Sends: 8/52
  Status: ✅ Active
  [Edit] [Pause] [Delete]

+ Create Scheduled Message
```

### 27.4 Supported Intervals

The dashboard provides friendly interval selection:

| Interval | Cron Expression |
|----------|----------------|
| Every X hours | `0 */X * * *` |
| Daily at time | `0 H * * *` |
| Weekly on day at time | `0 H * * D` |
| Biweekly | `0 H * * D` (with alternating week check) |
| Monthly on day at time | `0 H D * *` |
| Custom cron | Raw cron expression (advanced) |

---

## 28. Giveaways

### 28.1 Architecture

Giveaways are timed events where members enter by clicking a button. When the timer expires, winners are randomly selected.

### 28.2 Configuration

```typescript
interface Giveaway {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;             // The giveaway message
  prize: string;                 // Text description
  prizeProductId?: string;       // Product from store (commerce integration)
  prizeLicenseCount?: number;    // Number of licenses to generate (commerce)
  winnerCount: number;           // How many winners
  endsAt: Date;
  // Requirements
  requiredRoleId?: string;
  requiredLevel?: number;
  requiredEntitlementProductId?: string;  // Must own this product
  // State
  entries: string[];             // Discord user IDs (stored in Supabase, cached in Valkey)
  winners: string[];
  status: 'active' | 'ended' | 'cancelled';
  endedAt?: Date;
  createdBy: string;             // Admin user ID
  created_at: Date;
}
```

### 28.3 Flow

**Creation (dashboard or admin command):**
1. Owner creates giveaway in dashboard with prize, duration, requirements
2. Bot posts giveaway message with "Enter" button (Components v2, Orange accent)
3. Bot schedules end event via `node-cron`

**Entry:**
1. Member clicks "🎉 Enter Giveaway" button
2. Bot checks requirements (role, level, entitlement)
3. If eligible: add to entries, update entry count on message
4. If not: ephemeral error with reason

**Ending:**
1. Timer expires (or admin triggers early end)
2. Bot randomly selects `winnerCount` winners from entries
3. Bot updates giveaway message with winners
4. Bot mentions winners in channel
5. If product prize: bot generates license keys and DMs them to winners
6. Fire `giveaway.ended` platform event
7. Audit log entry

**Reroll:**
1. Admin can reroll from dashboard (e.g., winner left server)
2. New winner selected from remaining entries
3. Previous winner's prize revoked if applicable

### 28.4 Commerce Integration

When a giveaway has a `prizeProductId`:
- Bot generates license keys for winners (same system as purchases)
- Keys are DM'd to winners
- Entitlements are created with source: `giveaway`
- Winners get granted roles (same as if they purchased)
- Order record created with status `completed`, amount `0` (free — won via giveaway)
- Audit trail records the full flow

This means winning a giveaway for a product has the exact same outcome as purchasing it — same roles, same access, same entitlement tracking. The only difference is the price was zero.

---

## 29. Lavalink Music System

### 29.1 Architecture

```
Discord Voice ◄─► Lavalink v4 ◄─► YouTube (via youtube-source plugin)
      ▲                                    ▲
      │                                    │
  Shoukaku 4.x                    YouTube OAuth Token
  (WebSocket)                     (Refreshed automatically)
      │
  SomniClient
      │
  Music Queue (Valkey-backed)
```

### 29.2 Shoukaku Integration

```typescript
const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{
    name: 'main',
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASSWORD,
  }],
  {
    moveOnDisconnect: false,
    resume: true,
    resumeTimeout: 30,
    reconnectTries: 3,
    reconnectInterval: 5000,
  }
);

shoukaku.on('ready', (name) => logger.info(`Lavalink node ${name} ready`));
shoukaku.on('disconnect', (name, reason) => {
  logger.warn(`Lavalink node ${name} disconnected`, reason);
});
shoukaku.on('error', (name, error) => {
  logger.error(`Lavalink node ${name} error`, error);
});
```

### 29.3 Queue System

The music queue is backed by Valkey for persistence across bot restarts:

```typescript
interface QueueEntry {
  track: string;        // Lavalink track string (base64)
  title: string;
  author: string;
  duration: number;     // milliseconds
  uri: string;
  artworkUrl?: string;
  requestedBy: string;  // Discord user ID
  addedAt: number;      // timestamp
}

interface GuildQueue {
  guildId: string;
  channelId: string;      // Voice channel
  textChannelId: string;  // Where commands are issued
  entries: QueueEntry[];
  currentIndex: number;
  loopMode: 'off' | 'track' | 'queue';
  volume: number;          // 0-100
  shuffled: boolean;
  paused: boolean;
}
```

Valkey keys:
- `queue:${guildId}` — Full queue state (JSON)
- `nowplaying:${guildId}` — Current track message ID (for auto-updates)
- `music:votes:${guildId}:${action}` — Vote-skip tracking

### 29.4 Self-Healing

The music system monitors for failures and recovers:

```typescript
class MusicSelfHealer {
  // Track YouTube success/failure rates
  private successRate = new SlidingWindow(100); // last 100 requests

  async onTrackError(player: Player, track: Track, error: TrackExceptionEvent) {
    this.successRate.recordFailure();

    // If elevated failure rate, try recovery strategies
    if (this.successRate.failureRate > 0.3) { // > 30% failures
      // 1. Rotate YouTube client
      await this.rotateYouTubeClient();
      // 2. If still failing, refresh OAuth token
      if (this.successRate.failureRate > 0.5) {
        await this.refreshOAuthToken();
      }
      // 3. If still failing, try alternative search (ytsearch vs ytmusic)
      if (this.successRate.failureRate > 0.7) {
        await this.switchSearchProvider();
      }
    }

    // Always: skip to next track, notify channel
    await this.skipAndNotify(player, track, error);
  }

  async onNodeDisconnect() {
    // Wait and attempt reconnect
    // Shoukaku handles reconnection with configured retries
    // On success: re-read queue from Valkey and resume
  }
}
```

### 29.5 Lavalink Configuration

```yaml
# services/lavalink/application.yml
server:
  port: 2333
  address: 0.0.0.0
lavalink:
  server:
    password: "YOUR_LAVALINK_PASSWORD"
    sources:
      youtube: false     # Disabled — using plugin
      bandcamp: false
      soundcloud: false
      twitch: false
      vimeo: false
      http: true
    filters:
      volume: true
      equalizer: true
      karaoke: false
      timescale: true
      tremolo: false
      vibrato: false
      distortion: false
      rotation: false
      channelMix: false
      lowPass: false
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:1.17.0"
      repository: "https://maven.lavalink.dev/releases"
      snapshot: false

plugins:
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    clients:
      - MUSIC
      - ANDROID_TESTSUITE
      - WEB
      - TVHTML5EMBEDDED
    oauth:
      enabled: true
      refreshToken: "${YOUTUBE_OAUTH_REFRESH_TOKEN}"
```

### 29.6 DJ Role & Permissions

- DJ role configured in dashboard (points to a real Discord role)
- Non-DJ members: can queue tracks, use vote-skip (majority required)
- DJ members: force-skip, clear queue, remove tracks, adjust volume, disconnect
- Alone in channel: all members have DJ privileges automatically

### 29.7 Auto-Behaviors

| Behavior | Default | Description |
|----------|---------|-------------|
| Auto-leave | Enabled | Leave voice when queue ends and channel is empty (after 5 min timeout) |
| Auto-pause | Enabled | Pause when bot is alone in voice |
| Auto-resume | Enabled | Resume when someone joins while paused |
| Auto-destroy | Enabled | Destroy player after 30 min of inactivity |
| Queue save | Enabled | Save queue to Valkey on changes |
| Queue restore | Enabled | Restore queue on bot restart |

---

## 30. Commerce & Universal Licensing Platform — MAJOR v4 EXPANSION

### 30.1 Product Architecture

```
Products
  ├── One-Time Products (single purchase, permanent access)
  │   ├── Web applications           (license_mode: embedded)
  │   ├── Desktop applications        (license_mode: embedded)
  │   ├── Mobile applications         (license_mode: embedded)
  │   ├── CLI tools                   (license_mode: embedded)
  │   ├── Documents / PDFs            (license_mode: portal_watermark)
  │   ├── Links / URLs                (license_mode: portal_only)
  │   ├── Access passes (Discord)     (license_mode: access_pass)
  │   └── Mixed / bundled             (license_mode: varies per file)
  │
  └── Subscriptions (recurring payment, ongoing access)
      ├── Monthly plans
      ├── Annual plans
      └── Custom intervals
```

All product types can grant:
- Discord roles (via `granted_role_ids`)
- Discord channels (via `granted_channel_ids`)
- Downloadable files (via `product_files` — portal-gated with optional watermarking)
- External links (via `product_files` with `external_url` — proxied, real URL never exposed)
- License validation (via `@somnibot/license-sdk` — embedded in apps)
- Feature flags (via `product_license_config.feature_flags` — gate app features by tier)

### 30.2 License Modes

Every product has a `license_mode` that determines how access is controlled:

| Mode | Description | Validation Method |
|------|-------------|-------------------|
| `portal_only` | Customer downloads/accesses through dashboard portal | Portal authentication (Discord OAuth) |
| `portal_watermark` | Customer downloads through portal, files are watermarked with buyer identity | Portal authentication + dynamic watermarking |
| `embedded` | App/tool validates license at runtime via SDK | `@somnibot/license-sdk` phone-home API |
| `access_pass` | Discord role/channel grant — no external validation needed | Discord role presence |

**Default:** `portal_only` for files/links, `access_pass` for Discord-only products.

### 30.3 Identity Chain (No Exceptions)

```
Customer clicks "Buy" in Discord (/store or button)
  → Bot generates a secure PayPal checkout link
  → Link includes Discord user ID in PayPal custom_id field
  → Customer completes PayPal payment
  → PayPal webhook fires → Supabase Edge Function receives
  → Edge Function verifies webhook signature
  → Edge Function extracts Discord user ID from custom_id
  → Edge Function creates: order, customer record, license key, entitlement
  → Bot receives entitlement via Realtime
  → Bot DMs customer: receipt + license key + activation instructions
  → Customer uses /license activate <key>
  → Bot verifies: key hash matches, Discord ID matches bound_discord_id
  → If match: entitlement activated → roles granted → channels visible
  → If mismatch: rejected (key is bound to the purchaser permanently)
```

### 30.4 License Key Format

```
SMNI-XXXX-XXXX-XXXX-XXXX
│     └───────────────────── 16 random alphanumeric characters (4 groups of 4)
└── Prefix: "SMNI" (Somni brand)
```

- Generated using `crypto.randomBytes(12).toString('base64url')` and formatted
- Only SHA-256 hash stored in database
- Plaintext delivered ONCE via bot DM
- `key_prefix` stores first 4 chars ("SMNI") for admin display
- `key_suffix` stores last 4 chars for customer identification
- Key is PERMANENTLY bound to the purchaser's Discord ID at generation time

### 30.5 Entitlement Lifecycle

```
PENDING → ACTIVE → EXPIRED/CANCELLED/SUSPENDED
   │                      │
   │                      ├── EXPIRED: Time ran out (one-time with expiry)
   │                      ├── CANCELLED: Customer cancelled subscription
   │                      ├── SUSPENDED: Payment failed / banned
   │                      │      │
   │                      │      └── GRACE_PERIOD → Re-payment → ACTIVE
   │                      │                      → No payment → roles revoked
   │                      └── REVOKED: Admin manually revoked (refund, ban, etc.)
   │
   └── PENDING_ACTIVATION: Key delivered but /license activate not yet used
```

### 30.6 Role/Channel Grants on Entitlement Activation

```typescript
async function activateEntitlement(entitlement: Entitlement, member: GuildMember) {
  // Grant roles
  for (const roleId of entitlement.granted_role_ids) {
    await member.roles.add(roleId);
    eventBus.emit({ type: 'role.gained', memberId: member.id, roleId, source: 'purchase' });
  }

  // Channel access is handled through roles — channel permission overrides
  // are set up through channel templates. Granting the role automatically
  // unlocks the channels configured in the permission mapping.

  // Fire commerce event
  eventBus.emit({
    type: 'entitlement.granted',
    memberId: member.id,
    entitlementId: entitlement.id,
  });

  // Audit log
  await logAudit({
    action: 'entitlement.activated',
    targetId: member.id,
    details: { productId: entitlement.product_id, roleIds: entitlement.granted_role_ids },
  });
}
```

### 30.7 Subscription Handling

PayPal subscription webhooks:

| PayPal Event | SomniBot Action |
|-------------|-----------------|
| `BILLING.SUBSCRIPTION.ACTIVATED` | Create/update entitlement → ACTIVE, grant roles |
| `BILLING.SUBSCRIPTION.RENEWED` | Update `expires_at`, record payment |
| `PAYMENT.SALE.COMPLETED` | Record payment, update customer total_spent |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Set entitlement → GRACE_PERIOD |
| Grace period expires | Set entitlement → SUSPENDED, revoke roles, fire automation |
| `BILLING.SUBSCRIPTION.CANCELLED` | Set entitlement → CANCELLED on next period end |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Set entitlement → SUSPENDED, revoke roles |
| `BILLING.SUBSCRIPTION.RE-ACTIVATED` | Set entitlement → ACTIVE, re-grant roles |

### 30.8 Universal License Validation API — NEW v4

The license validation API is the single endpoint that ALL external products call to verify a license is valid. It doesn't matter what the product is — web app, desktop app, mobile app, CLI tool — they all call the same endpoint.

**Endpoint:** `POST /api/license/validate`

```typescript
// Request
interface LicenseValidateRequest {
  license_key: string;         // The SMNI-XXXX-XXXX-XXXX-XXXX key
  product_id: string;          // Which product is validating
  device_fingerprint?: string; // Unique device identifier (for multi-device tracking)
  device_name?: string;        // Human-readable device name ("John's MacBook")
  app_version?: string;        // Version of the app validating
}

// Response
interface LicenseValidateResponse {
  valid: boolean;
  status: 'active' | 'expired' | 'suspended' | 'revoked' | 'over_device_limit';
  entitlement_id?: string;
  // Feature flags — apps can gate features by tier
  features: string[];         // e.g., ["basic", "export", "analytics", "api_access"]
  tier?: string;              // e.g., "pro", "enterprise", "starter"
  // Metadata
  customer_discord_id?: string;
  customer_name?: string;     // For watermarking / personalization
  expires_at?: string;        // ISO 8601 — null for permanent
  // Session
  session_id?: string;        // For heartbeat tracking
  heartbeat_interval_seconds?: number; // How often to heartbeat (0 = no heartbeat required)
  // Error info
  error?: string;             // Human-readable error when valid=false
}
```

**Validation Logic (Supabase Edge Function):**

```typescript
async function validateLicense(req: LicenseValidateRequest): Promise<LicenseValidateResponse> {
  // 1. Hash the key and look up
  const keyHash = sha256(req.license_key);
  const licenseKey = await db.from('license_keys').select('*').eq('key_hash', keyHash).single();
  if (!licenseKey) return { valid: false, status: 'revoked', error: 'Invalid license key' };

  // 2. Check key status
  if (licenseKey.status !== 'active') {
    return { valid: false, status: licenseKey.status, error: `License is ${licenseKey.status}` };
  }

  // 3. Check entitlement
  const entitlement = await db.from('entitlements').select('*').eq('license_key_id', licenseKey.id).single();
  if (!entitlement || entitlement.status !== 'active') {
    return { valid: false, status: entitlement?.status || 'revoked', error: 'Entitlement not active' };
  }

  // 4. Check product match
  if (licenseKey.product_id !== req.product_id) {
    return { valid: false, status: 'revoked', error: 'License is not valid for this product' };
  }

  // 5. Check expiry
  if (entitlement.expires_at && new Date(entitlement.expires_at) < new Date()) {
    await db.from('entitlements').update({ status: 'expired' }).eq('id', entitlement.id);
    return { valid: false, status: 'expired', error: 'License has expired' };
  }

  // 6. Multi-device tracking
  const licenseConfig = await db.from('product_license_config').select('*').eq('product_id', req.product_id).single();
  if (req.device_fingerprint && licenseConfig) {
    const activeSessions = await db.from('license_sessions')
      .select('*')
      .eq('license_key_id', licenseKey.id)
      .eq('active', true);

    const existingSession = activeSessions.find(s => s.device_fingerprint === req.device_fingerprint);

    if (!existingSession && activeSessions.length >= (licenseConfig.max_devices || 3)) {
      // Over device limit — invalidate oldest session
      const oldest = activeSessions.sort((a, b) => a.last_seen_at - b.last_seen_at)[0];
      await db.from('license_sessions').update({ active: false }).eq('id', oldest.id);
    }

    // Create or update session
    const session = existingSession
      ? await db.from('license_sessions').update({ last_seen_at: new Date(), device_name: req.device_name, app_version: req.app_version }).eq('id', existingSession.id).select().single()
      : await db.from('license_sessions').insert({ license_key_id: licenseKey.id, device_fingerprint: req.device_fingerprint, device_name: req.device_name, app_version: req.app_version, active: true }).select().single();

    // Log validation
    await db.from('license_validations').insert({
      license_key_id: licenseKey.id,
      product_id: req.product_id,
      device_fingerprint: req.device_fingerprint,
      result: 'valid',
      ip_address: req.ip, // From Edge Function context
    });

    return {
      valid: true,
      status: 'active',
      entitlement_id: entitlement.id,
      features: licenseConfig.feature_flags || [],
      tier: licenseConfig.tier || null,
      customer_discord_id: licenseKey.bound_discord_id,
      customer_name: customer?.discord_username,
      expires_at: entitlement.expires_at,
      session_id: session.id,
      heartbeat_interval_seconds: licenseConfig.heartbeat_interval_seconds || 0,
    };
  }

  // No device tracking — simple validation
  return {
    valid: true,
    status: 'active',
    entitlement_id: entitlement.id,
    features: licenseConfig?.feature_flags || [],
    tier: licenseConfig?.tier || null,
    customer_discord_id: licenseKey.bound_discord_id,
    expires_at: entitlement.expires_at,
    heartbeat_interval_seconds: 0,
  };
}
```

### 30.9 License Heartbeat API — NEW v4

For embedded apps that need continuous validation (desktop, mobile, long-running web sessions), the heartbeat endpoint confirms the session is still active.

**Endpoint:** `POST /api/license/heartbeat`

```typescript
// Request
interface HeartbeatRequest {
  session_id: string;
  license_key: string;
}

// Response
interface HeartbeatResponse {
  valid: boolean;
  status: 'active' | 'revoked' | 'expired' | 'session_invalidated';
  next_heartbeat_seconds: number;
}
```

**How it works:**
1. App calls heartbeat at the interval returned by `/validate`
2. Edge Function updates `license_sessions.last_seen_at`
3. If the entitlement has been revoked since last heartbeat → returns `valid: false`
4. App receives `valid: false` → shows revocation message, disables features
5. If heartbeat stops (app closed/crashed) → session is marked inactive after `offline_grace_period_seconds`

**Real-time revocation:** When the owner revokes an entitlement from the dashboard:
1. `entitlements` row status → `revoked`
2. All `license_sessions` for that key → `active: false`
3. Next heartbeat from ANY device → returns `valid: false, status: 'revoked'`
4. App must disable access immediately

### 30.10 License Session Management — NEW v4

**Endpoint:** `GET /api/license/sessions` — List active sessions for a license key
**Endpoint:** `DELETE /api/license/sessions/:id` — Remotely deactivate a specific device
**Endpoint:** `POST /api/license/deactivate` — Deactivate current device (app uninstall cleanup)

```typescript
// GET /api/license/sessions response
interface SessionListResponse {
  sessions: {
    id: string;
    device_name: string;
    device_fingerprint: string;
    app_version: string;
    first_seen_at: string;
    last_seen_at: string;
    active: boolean;
  }[];
  max_devices: number;
  active_count: number;
}
```

**Dashboard view:** The owner can see all active sessions for any license key in the admin panel:

```
License: SMNI-****-****-****-A3B7
Customer: @Username
Product: Premium Desktop App

Active Sessions (2/3 max):
┌──────────────────────────────────────────────────┐
│ 💻 John's MacBook Pro                            │
│    Last seen: 2 minutes ago                      │
│    App v2.1.0                                    │
│    [Revoke Session]                              │
├──────────────────────────────────────────────────┤
│ 📱 John's iPhone 15                              │
│    Last seen: 1 hour ago                         │
│    App v2.0.5                                    │
│    [Revoke Session]                              │
└──────────────────────────────────────────────────┘
```

### 30.11 Per-Platform Integration Guide — NEW v4

This section documents how each platform type integrates with the universal licensing system.

#### Desktop Applications (Electron, Tauri, native)

```
App Launch
  → Check local license cache (encrypted, with expiry)
  → If cache valid and within offline grace period → allow access
  → If cache expired or missing → call POST /api/license/validate
    → device_fingerprint = machine UUID (os.hostname + cpus + MAC hash)
    → If valid → cache response, start heartbeat loop
    → If invalid → show activation screen
      → User enters SMNI-XXXX-XXXX-XXXX-XXXX
      → Call /api/license/validate with key
      → If valid → cache, grant access, start heartbeat
      → If invalid → show error, remain locked
```

**SDK usage (TypeScript/Electron):**
```typescript
import { SomniLicense } from '@somnibot/license-sdk';

const license = new SomniLicense({
  productId: 'YOUR_PRODUCT_ID',
  apiBaseUrl: 'https://your-dashboard.com/api',
  cacheDir: app.getPath('userData'),
});

// On app start
const result = await license.validate('SMNI-XXXX-XXXX-XXXX-XXXX');
if (!result.valid) {
  showActivationScreen();
  return;
}

// Access features based on tier/flags
if (result.features.includes('export')) {
  enableExportFeature();
}

// Heartbeat runs automatically in background
license.startHeartbeat(); // Uses interval from validation response
license.on('revoked', () => {
  showRevocationMessage();
  lockApp();
});
```

#### Web Applications (Next.js, React, SPA)

```
User visits web app
  → Middleware/route guard checks session
  → If no session → redirect to Discord OAuth login
  → If session exists → call POST /api/license/validate (server-side)
    → device_fingerprint = session ID or browser fingerprint
    → If valid → serve app, inject features into context
    → If invalid → show "License Required" page with purchase link
```

**SDK usage (Next.js middleware):**
```typescript
import { SomniLicense } from '@somnibot/license-sdk';

// middleware.ts
export async function middleware(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.licenseKey) return redirectToLogin();

  const license = new SomniLicense({ productId: 'YOUR_PRODUCT_ID', apiBaseUrl: process.env.SOMNI_API_URL });
  const result = await license.validate(session.licenseKey, { deviceFingerprint: session.id });

  if (!result.valid) return redirectToLicenseRequired();

  // Pass features to app via headers
  const response = NextResponse.next();
  response.headers.set('x-license-features', JSON.stringify(result.features));
  response.headers.set('x-license-tier', result.tier || '');
  return response;
}
```

#### Mobile Applications (React Native, Flutter, native)

Same as desktop — embedded validation + heartbeat. Additional considerations:
- **Deep link OAuth:** `somnibot://auth/callback` for Discord OAuth flow
- **Background heartbeat:** Use background task scheduler (React Native BackgroundFetch, Flutter WorkManager)
- **Offline grace period:** Longer default (72 hours) for mobile since connectivity is intermittent
- **Device fingerprint:** Device UUID from native APIs

#### CLI Tools

```
First run
  → Check ~/.somnibot/license.json for cached key
  → If missing → prompt: "Enter your license key: SMNI-"
  → Call POST /api/license/validate
  → If valid → cache to ~/.somnibot/license.json (encrypted)
  → Subsequent runs → silent re-validate from cache
  → If offline and within grace period → allow
  → If offline and past grace period → show error
```

**SDK usage (Node.js CLI):**
```typescript
import { SomniLicense } from '@somnibot/license-sdk';

const license = new SomniLicense({
  productId: 'YOUR_CLI_PRODUCT_ID',
  apiBaseUrl: 'https://your-dashboard.com/api',
  cacheDir: path.join(os.homedir(), '.somnibot'),
});

// Auto-loads cached key or prompts
const result = await license.validateOrPrompt();
if (!result.valid) {
  console.error('License validation failed:', result.error);
  process.exit(1);
}
```

**Reference implementations for non-Node platforms:**

```python
# Python reference — somnibot_license.py
import requests, hashlib, json, os

class SomniLicense:
    def __init__(self, product_id: str, api_base_url: str):
        self.product_id = product_id
        self.api_base_url = api_base_url

    def validate(self, license_key: str, device_fingerprint: str = None) -> dict:
        resp = requests.post(f"{self.api_base_url}/license/validate", json={
            "license_key": license_key,
            "product_id": self.product_id,
            "device_fingerprint": device_fingerprint or self._get_fingerprint(),
        })
        return resp.json()
```

```csharp
// C# reference — SomniLicense.cs
public class SomniLicense {
    private readonly string _productId;
    private readonly string _apiBaseUrl;

    public async Task<LicenseResult> ValidateAsync(string licenseKey) {
        var client = new HttpClient();
        var response = await client.PostAsJsonAsync($"{_apiBaseUrl}/license/validate", new {
            license_key = licenseKey,
            product_id = _productId,
            device_fingerprint = GetDeviceFingerprint(),
        });
        return await response.Content.ReadFromJsonAsync<LicenseResult>();
    }
}
```

```rust
// Rust reference — somnibot_license.rs
pub struct SomniLicense { product_id: String, api_base_url: String }

impl SomniLicense {
    pub async fn validate(&self, license_key: &str) -> Result<LicenseResult, Error> {
        let client = reqwest::Client::new();
        let resp = client.post(format!("{}/license/validate", self.api_base_url))
            .json(&serde_json::json!({
                "license_key": license_key,
                "product_id": self.product_id,
                "device_fingerprint": self.get_fingerprint(),
            }))
            .send().await?;
        resp.json().await
    }
}
```

#### Documents (PDFs, ZIPs, etc.)

Documents use `portal_watermark` mode:
1. Customer authenticates via Discord OAuth on the dashboard
2. Dashboard serves the file through a protected download endpoint
3. Before serving, the file is dynamically watermarked with the buyer's identity:
   - PDFs: Footer on every page — "Licensed to: Discord Username (SMNI-****-A3B7)"
   - Images: Invisible watermark + visible corner text
   - ZIPs: License file included, README references buyer
4. The real file URL is never exposed — all downloads go through `/api/downloads/:productId/:fileId`
5. Every download is logged in `audit_logs` with customer ID and IP

**Watermarking config (per product):**
```typescript
interface WatermarkConfig {
  enabled: boolean;
  text_template: string;  // "Licensed to: {customer_name} ({key_suffix})"
  position: 'footer' | 'header' | 'corner';
  font_size: number;
  opacity: number;
}
```

#### Links (External URLs)

Links use `portal_only` mode:
1. Customer authenticates via Discord OAuth on the dashboard
2. Dashboard shows a "Your Products" page listing their purchased links
3. When customer clicks "Access" → dashboard proxies/redirects to the real URL
4. The real URL is NEVER exposed in the page source, API responses, or anywhere the customer can inspect
5. Implementation: server-side redirect with entitlement check, or iframe embed with CSP
6. Every access is logged

### 30.12 Product License Configuration — NEW v4

Each product has an optional license configuration that controls validation behavior:

```typescript
interface ProductLicenseConfig {
  product_id: string;         // FK to products.id
  license_mode: 'portal_only' | 'portal_watermark' | 'embedded' | 'access_pass';
  max_devices: number;        // Max concurrent devices per license (default: 3)
  heartbeat_interval_seconds: number;  // 0 = no heartbeat required (default: 300 = 5 min)
  offline_grace_period_seconds: number; // How long app works offline (default: 86400 = 24h)
  feature_flags: string[];    // Features included with this product (e.g., ["basic", "export"])
  tier: string;               // Product tier name (e.g., "pro", "enterprise")
  watermark_config: WatermarkConfig | null;  // For portal_watermark mode
  require_discord_guild_membership: boolean; // Must be in guild to validate (default: true)
  created_at: Date;
  updated_at: Date;
}
```

### 30.13 SDK Documentation Requirement — NEW v4

The `@somnibot/license-sdk` package and all reference implementations MUST include comprehensive documentation in the repo. This is a hard requirement because the SDK is given to other AI agents and chat assistants when building products that sell through the dashboard.

**Required documentation files (in `packages/license-sdk/docs/`):**

| File | Contents |
|------|----------|
| `README.md` | What it is, installation, 30-second example |
| `QUICKSTART.md` | Step-by-step setup for each platform |
| `API.md` | Full endpoint reference with request/response schemas |
| `PLATFORMS.md` | Per-platform integration guide (desktop, web, mobile, CLI, documents, links) |
| `SECURITY.md` | Security model, key storage best practices, what not to do |

**Key documentation principles:**
- Every code example must be copy-pasteable and working
- Include error handling in all examples
- Document every response field and what apps should do with it
- Include a "Troubleshooting" section for common issues
- Reference implementations (Python, C#, Rust) must have their own README files
- The SDK README must be self-contained — an agent reading only the SDK docs should be able to integrate without reading the full architecture doc

---

## 31. Order Lifecycle & Customer Receipts

### 31.1 Order Number Format

`INS-XXXXX` — Sequential, zero-padded, starting from 00001.

```sql
SELECT 'INS-' || LPAD(nextval('order_number_seq')::text, 5, '0') AS order_number;
-- INS-00001, INS-00002, ... INS-99999, INS-100000 (auto-grows)
```

### 31.2 Receipt (Bot DM)

```
┌─────────────────────────────────────────────┐
│ Container (accent: #FF1493 Hot Pink)         │
│                                              │
│  Text: "🧾 **Order Confirmed**"             │
│  Separator                                   │
│  Text: "**Order:** INS-00042"               │
│  Text: "**Product:** Premium Access"         │
│  Text: "**Amount:** $9.99 USD"              │
│  Text: "**Date:** May 16, 2026"             │
│  Separator                                   │
│  Text: "**Your License Key:**"              │
│  Text: "`SMNI-A3B7-C9D2-E4F1-G8H5`"        │
│  Text: ""                                    │
│  Text: "⚠️ **Save this key!** It will not"   │
│  Text: "be shown again."                    │
│  Separator                                   │
│  Text: "To activate: `/license activate`"    │
│  Text: "`SMNI-A3B7-C9D2-E4F1-G8H5`"        │
└─────────────────────────────────────────────┘
```

### 31.3 Dashboard Order View

The `/orders` page shows:
- Order number, customer, product, amount, date, status
- Expandable: full payment details, license key (prefix + suffix only), entitlement status
- Actions: refund, void, reissue key
- Search by order number, customer name, Discord ID

---

## 32. Promotions & Coupons

### 32.1 Types

| Type | Description |
|------|-------------|
| **Percentage** | X% off (e.g., 20% off) |
| **Fixed Amount** | $X off (e.g., $5 off) |

### 32.2 Constraints

| Constraint | Description |
|------------|-------------|
| `coupon_code` | Optional code customer enters at checkout |
| `applies_to_product_ids` | Limit to specific products |
| `applies_to_plan_ids` | Limit to specific subscription plans |
| `start_date` / `end_date` | Time-limited promotions |
| `max_uses` | Total redemptions allowed |
| `min_purchase_cents` | Minimum order amount |
| `first_purchase_only` | Only for customers with no prior orders |

### 32.3 Dashboard Interface

```
Promotions:

[Summer Sale]
  Type: 20% off
  Code: SUMMER2026
  Applies to: All products
  Valid: Jun 1 - Jun 30, 2026
  Uses: 12/100
  Status: ✅ Active

[New Customer Welcome]
  Type: $5 off
  Code: (auto-applied)
  Applies to: All products
  Min purchase: $10
  First purchase only: Yes
  Uses: 45/∞
  Status: ✅ Active

+ Create Promotion
```

---

## 33. Admin, Audit & Operations

### 33.1 Audit Log System

Every significant action in the platform creates an audit log entry:

```typescript
interface AuditLogEntry {
  id: string;
  guildId: string;
  timestamp: Date;
  actorType: 'user' | 'bot' | 'system' | 'webhook' | 'automation';
  actorId: string;       // Discord ID, 'system', automation ID
  action: string;        // e.g., 'role.created', 'entitlement.activated', 'ticket.closed'
  targetType?: string;   // 'member', 'role', 'channel', 'product', 'order', 'ticket', etc.
  targetId?: string;
  details: Record<string, unknown>;  // Action-specific metadata
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}
```

### 33.2 Actions Logged

| Category | Actions |
|----------|---------|
| **Server** | role.created, role.updated, role.deleted, channel.created, channel.updated, channel.deleted, permission.changed, setup.deployed, setup.confirmed |
| **Members** | member.verified, member.left, member.returned, member.role_granted, member.role_removed |
| **Moderation** | warn.issued, mute.applied, kick.executed, ban.executed, infraction.pardoned |
| **Tickets** | ticket.opened, ticket.claimed, ticket.closed, ticket.reopened, ticket.deleted |
| **Commerce** | order.created, order.completed, order.refunded, key.generated, key.activated, entitlement.granted, entitlement.revoked, entitlement.suspended |
| **Subscriptions** | subscription.activated, subscription.renewed, subscription.cancelled, subscription.suspended |
| **Levels** | level.up, reward.granted, reward.removed, xp.reset, xp.adjusted |
| **Automations** | automation.created, automation.updated, automation.deleted, automation.executed |
| **Giveaways** | giveaway.created, giveaway.ended, giveaway.rerolled, giveaway.cancelled |
| **Sync** | sync.started, sync.completed, drift.detected, drift.repaired, drift.accepted |
| **System** | bot.started, bot.stopped, config.updated, webhook.received, webhook.failed |

### 33.3 Dashboard Audit Page

```
Audit Log

[Filter: Category ▼] [Filter: Actor ▼] [Filter: Date Range] [Search]

[Export CSV] [Export JSON]

┌─────────────────────────────────────────────────────────────┐
│ May 16, 2026 3:45 PM                                        │
│ 🤖 System — entitlement.activated                          │
│ Target: @Username (member)                                   │
│ Details: Product "VIP Access", Order INS-00042              │
│ Roles granted: VIP                                           │
├─────────────────────────────────────────────────────────────┤
│ May 16, 2026 3:44 PM                                        │
│ 🔄 Webhook — order.completed                                │
│ Target: INS-00042 (order)                                   │
│ Details: $9.99 USD via PayPal                               │
│ PayPal Order: 4MH2345...                                    │
├─────────────────────────────────────────────────────────────┤
│ May 16, 2026 3:30 PM                                        │
│ ⚡ Automation — "Level 10 Unlock" executed                   │
│ Triggered by: @User2 reached level 10                       │
│ Actions: give_role "Trusted", send_message #level-ups       │
│ Duration: 142ms                                             │
└─────────────────────────────────────────────────────────────┘
```

### 33.4 Diagnostics Dashboard

The `/diagnostics` page shows system health:
- Bot uptime and connection status
- Supabase connection status
- Valkey connection and memory usage
- Lavalink node status (connected, playing tracks, load)
- Discord API rate limit status
- Last sync time and drift status
- Automation execution stats (last hour, failures)
- Scheduled message status (next fires, missed fires)
- Webhook processing stats

---

## 34. Shared Library (`packages/shared`)

### 34.1 Permission Registry

```typescript
// packages/shared/src/constants/permissions.ts

export const DISCORD_PERMISSIONS = {
  // General
  ADMINISTRATOR: 1n << 3n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  CREATE_INSTANT_INVITE: 1n << 0n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_EVENTS: 1n << 33n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_APPS: 1n << 50n,

  // Text
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  ADD_REACTIONS: 1n << 6n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_THREADS: 1n << 34n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_TTS_MESSAGES: 1n << 12n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,

  // Voice
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  STREAM: 1n << 9n,
  USE_SOUNDBOARD: 1n << 42n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  USE_VAD: 1n << 25n,
  PRIORITY_SPEAKER: 1n << 8n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  REQUEST_TO_SPEAK: 1n << 32n,

  // Moderation
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

// Human-readable categories for the dashboard permission matrix
export const PERMISSION_CATEGORIES = {
  'General Server': ['ADMINISTRATOR', 'VIEW_AUDIT_LOG', 'VIEW_GUILD_INSIGHTS', 'MANAGE_GUILD', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD_EXPRESSIONS', 'CREATE_GUILD_EXPRESSIONS', 'VIEW_CREATOR_MONETIZATION_ANALYTICS', 'CREATE_INSTANT_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'MANAGE_EVENTS', 'CREATE_EVENTS', 'USE_EXTERNAL_APPS'],
  'Text Channel': ['VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS', 'USE_EXTERNAL_STICKERS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'MANAGE_THREADS', 'READ_MESSAGE_HISTORY', 'SEND_TTS_MESSAGES', 'USE_APPLICATION_COMMANDS', 'SEND_VOICE_MESSAGES', 'SEND_POLLS'],
  'Voice Channel': ['CONNECT', 'SPEAK', 'STREAM', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS', 'USE_VAD', 'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_EMBEDDED_ACTIVITIES', 'REQUEST_TO_SPEAK'],
  'Moderation': ['KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS'],
} as const;
```

### 34.2 Template Definitions

```typescript
// packages/shared/src/constants/templates.ts

export const ROLE_TEMPLATES = {
  EVERYONE: {
    id: 'everyone',
    name: '@everyone',
    description: 'Base role — ZERO permissions. The locked door.',
    permissions: 0n,
    editable: false,
  },
  COSMETIC: {
    id: 'cosmetic',
    name: 'Cosmetic',
    description: 'Display-only. Zero functional permissions.',
    permissions: 0n,
    editable: false,
  },
  MEMBER: {
    id: 'member',
    name: 'Member',
    description: 'Standard community member. Can participate.',
    permissions: computeMemberPermissions(), // See §10.1
    editable: false,
  },
  MODERATOR: {
    id: 'moderator',
    name: 'Moderator',
    description: 'Community moderator. Member + moderation tools.',
    permissions: computeModeratorPermissions(), // See §10.1
    editable: false,
  },
  ADMIN: {
    id: 'admin',
    name: 'Admin',
    description: 'Server administrator. Moderator + full management.',
    permissions: computeAdminPermissions(), // See §10.1
    editable: false,
  },
} as const;
```

### 34.3 Brand Constants

```typescript
// packages/shared/src/constants/brand.ts
export const SOMNI_PALETTE = {
  HOT_PINK: 0xFF1493,
  CYAN: 0x00D4FF,
  ORANGE: 0xFF6B00,
  NEAR_BLACK: 0x0D0D0D,  // Subtle off-black — premium feel, no harsh contrast
} as const;

export const PALETTE_USAGE = {
  PRIMARY_ACCENT: SOMNI_PALETTE.HOT_PINK,
  SECONDARY_ACCENT: SOMNI_PALETTE.CYAN,
  WARNING_ACCENT: SOMNI_PALETTE.ORANGE,
  CONTAINER_BG: SOMNI_PALETTE.NEAR_BLACK,
} as const;
```

### 34.4 Level Curve Constants

```typescript
// packages/shared/src/constants/levels.ts
export const LEVEL_CONFIG = {
  XP_FORMULA: (level: number) => 5 * Math.pow(level, 2) + 50 * level + 100,
  DEFAULT_MIN_XP: 15,
  DEFAULT_MAX_XP: 25,
  DEFAULT_COOLDOWN_SECONDS: 60,
  DEFAULT_VOICE_XP_PER_INTERVAL: 10,
  DEFAULT_VOICE_INTERVAL_MINUTES: 5,
  MAX_LEVEL: 200,
} as const;
```

### 34.5 Automation Constants

```typescript
// packages/shared/src/constants/automations.ts
export const AUTOMATION_LIMITS = {
  MAX_AUTOMATIONS_PER_GUILD: 100,
  MAX_ACTIONS_PER_AUTOMATION: 10,
  MAX_CONDITIONS_PER_AUTOMATION: 5,
  MAX_DELAY_SECONDS: 3600,
  MAX_FIRES_PER_USER_PER_MINUTE: 5,
  DM_COOLDOWN_SECONDS: 300,
} as const;

export const TRIGGER_TYPES = [
  'member.joined', 'member.left', 'member.verified',
  'message.sent', 'role.gained', 'role.lost',
  'level.up', 'purchase.completed',
  'subscription.activated', 'subscription.lapsed',
  'ticket.opened', 'ticket.closed',
  'giveaway.ended', 'button.clicked',
  'reaction.added', 'voice.joined', 'voice.left',
  'infraction.created',
] as const;
```

### 34.6 Zod Validators

All shared types have corresponding Zod schemas for runtime validation. Used by both bot (incoming webhook payloads, config validation) and dashboard (form validation, API request validation).

---

## 35. Supabase Backend (`packages/supabase`)

### 35.1 Auth Configuration

```
Provider: Discord OAuth2
Scopes: identify, guilds, guilds.members.read, email
Callback: /api/auth/callback
JWT: Contains Discord user metadata (id, username, avatar, guild roles)
Session: 7-day refresh, 1-hour access token
```

### 35.2 Edge Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `paypal-webhook` | HTTP POST from PayPal | Verify signature, process payment events, create orders/entitlements |
| `entitlement-check` | HTTP GET from bot | Verify license key hash, return entitlement status |
| `license-validate` | HTTP POST from SDK/apps | Universal license validation — NEW v4 |
| `license-heartbeat` | HTTP POST from SDK/apps | Session heartbeat for embedded apps — NEW v4 |
| `cron-tasks` | Supabase Cron (pg_cron) | Subscription expiry checks, giveaway endings, grace period enforcement, stale session cleanup |

### 35.3 Storage Buckets

| Bucket | Access | Purpose |
|--------|--------|---------|
| `product-files` | Authenticated + signed URLs | Product downloads (PDFs, ZIPs, etc.) — portal-gated with optional watermarking |
| `ticket-transcripts` | Service role only | HTML ticket transcripts |
| `welcome-assets` | Public | Welcome card backgrounds |
| `embed-assets` | Authenticated | Uploaded images for embed builder |
| `rank-card-assets` | Authenticated | Per-user rank card backgrounds — NEW v4 |

### 35.4 Realtime Subscriptions

The bot subscribes to these tables for live updates:

| Table | Events | Bot Action |
|-------|--------|-----------|
| `guild_config` | UPDATE | Reload module configurations |
| `guild_desired_state` | UPDATE | Deploy server structure changes |
| `automations` | INSERT, UPDATE, DELETE | Reload automation engine |
| `custom_commands` | INSERT, UPDATE, DELETE | Re-register slash commands |
| `reaction_roles` | INSERT, UPDATE, DELETE | Update Valkey cache |
| `automod_rules` | INSERT, UPDATE, DELETE | Reload moderation engine |
| `ticket_panels` | INSERT, UPDATE, DELETE | Update panel messages |
| `level_config` | UPDATE | Reload level settings |
| `scheduled_messages` | INSERT, UPDATE, DELETE | Re-register cron jobs |
| `giveaways` | INSERT, UPDATE | Track active giveaways |
| `temp_channel_hubs` | INSERT, UPDATE, DELETE | Update hub monitoring |
| `stats_channels` | INSERT, UPDATE, DELETE | Update stats cron |
| `entitlements` | INSERT, UPDATE | Grant/revoke roles |
| `embed_configs` | INSERT, UPDATE, DELETE | Update posted embeds |
| `product_license_config` | UPDATE | License config changes → update validation logic — NEW v4 |

---

## 36. Database Schema

```sql
-- ============================================================
-- CORE
-- ============================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id TEXT UNIQUE NOT NULL,
  discord_username TEXT NOT NULL,
  avatar_url TEXT,
  email TEXT,
  is_owner BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guild (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_url TEXT,
  owner_discord_id TEXT NOT NULL,
  bot_joined_at TIMESTAMPTZ DEFAULT now(),
  setup_completed BOOLEAN DEFAULT false,
  setup_confirmed_at TIMESTAMPTZ,
  bot_role_position INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guild_config (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  -- Onboarding
  member_role_id TEXT,
  onboarding_enabled BOOLEAN DEFAULT true,
  interest_role_mapping JSONB DEFAULT '{}',
  returning_member_skip_welcome_dm BOOLEAN DEFAULT true,
  returning_member_restore_entitlements BOOLEAN DEFAULT true,
  returning_member_restore_levels BOOLEAN DEFAULT true,
  -- Welcome
  welcome_enabled BOOLEAN DEFAULT false,
  welcome_channel_id TEXT,
  welcome_message TEXT,
  welcome_card_enabled BOOLEAN DEFAULT true,
  welcome_card_background TEXT,
  welcome_dm_enabled BOOLEAN DEFAULT false,
  welcome_dm_message TEXT,
  welcome_auto_roles TEXT[] DEFAULT '{}',
  -- Goodbye
  goodbye_enabled BOOLEAN DEFAULT false,
  goodbye_channel_id TEXT,
  goodbye_message TEXT,
  -- Moderation
  mod_log_channel_id TEXT,
  escalation_chain JSONB DEFAULT '[]',
  infraction_expiry_days INTEGER DEFAULT 30,
  -- Ticketing (global settings)
  ticket_transcript_enabled BOOLEAN DEFAULT true,
  ticket_dm_transcript BOOLEAN DEFAULT false,
  -- Levels
  levels_enabled BOOLEAN DEFAULT false,
  xp_min INTEGER DEFAULT 15,
  xp_max INTEGER DEFAULT 25,
  xp_cooldown_seconds INTEGER DEFAULT 60,
  voice_xp_enabled BOOLEAN DEFAULT false,
  voice_xp_per_interval INTEGER DEFAULT 10,
  voice_xp_interval_minutes INTEGER DEFAULT 5,
  level_up_channel_id TEXT,
  level_up_message TEXT DEFAULT '🎉 {user} just reached **Level {level}**!',
  xp_multiplier_mode TEXT DEFAULT 'highest' CHECK (xp_multiplier_mode IN ('highest', 'additive')),
  xp_channel_mode TEXT DEFAULT 'blacklist' CHECK (xp_channel_mode IN ('blacklist', 'whitelist')),
  xp_channel_list TEXT[] DEFAULT '{}',
  rank_card_accent_color INTEGER DEFAULT 16716947,
  rank_card_background TEXT,
  -- Music
  music_enabled BOOLEAN DEFAULT true,
  dj_role_id TEXT,
  music_default_volume INTEGER DEFAULT 50,
  music_auto_leave_minutes INTEGER DEFAULT 5,
  music_auto_destroy_minutes INTEGER DEFAULT 30,
  -- Commerce
  store_enabled BOOLEAN DEFAULT false,
  store_channel_id TEXT,
  grace_period_days INTEGER DEFAULT 3,
  -- Stats channels
  stats_enabled BOOLEAN DEFAULT false,
  stats_category_id TEXT,
  stats_update_interval_minutes INTEGER DEFAULT 10,
  -- Temp channels
  temp_channels_enabled BOOLEAN DEFAULT false,
  -- Scheduled messages (global enable)
  scheduled_messages_enabled BOOLEAN DEFAULT true,
  -- Giveaways (global enable)
  giveaways_enabled BOOLEAN DEFAULT true,
  -- Sync
  sync_enabled BOOLEAN DEFAULT true,
  sync_interval_minutes INTEGER DEFAULT 15,
  sync_auto_repair BOOLEAN DEFAULT false,
  sync_auto_repair_everyone BOOLEAN DEFAULT true,
  --
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TEMPLATES & SERVER STRUCTURE (unchanged from v2)
-- ============================================================

CREATE TABLE role_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('everyone', 'cosmetic', 'member', 'moderator', 'admin', 'custom')),
  description TEXT,
  permissions BIGINT NOT NULL,
  permission_details JSONB NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  base_template_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE channel_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  target_channel_type TEXT NOT NULL CHECK (target_channel_type IN ('text', 'voice', 'stage', 'forum', 'announcement')),
  overrides JSONB NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  base_template_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE server_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  template_data JSONB NOT NULL,
  version INTEGER DEFAULT 1,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guild_desired_state (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  server_template_id UUID REFERENCES server_templates(id),
  roles JSONB NOT NULL DEFAULT '[]',
  channels JSONB NOT NULL DEFAULT '[]',
  permission_map JSONB NOT NULL DEFAULT '{}',
  applied_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  drift_detected BOOLEAN DEFAULT false,
  drift_details JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE discord_id_map (
  guild_id TEXT REFERENCES guild(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('role', 'channel', 'category')),
  template_key TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, entity_type, template_key)
);

-- ============================================================
-- REACTION ROLES (unchanged from v2 + level requirement)
-- ============================================================

CREATE TABLE reaction_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  exclusive_group TEXT,
  require_role TEXT,
  require_level INTEGER,
  max_per_group INTEGER,
  remove_on_unreact BOOLEAN DEFAULT true,
  log_actions BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(message_id, emoji)
);

-- ============================================================
-- MODERATION
-- ============================================================

CREATE TABLE automod_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('word_filter', 'link_filter', 'invite_filter', 'spam_filter', 'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam')),
  enabled BOOLEAN DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  action TEXT NOT NULL CHECK (action IN ('delete', 'warn', 'mute', 'kick', 'ban')),
  mute_duration_minutes INTEGER,
  exempt_roles TEXT[] DEFAULT '{}',
  exempt_channels TEXT[] DEFAULT '{}',
  log_to_mod_channel BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE infractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('warn', 'mute', 'kick', 'ban')),
  reason TEXT NOT NULL,
  automod_rule_id UUID REFERENCES automod_rules(id),
  duration_minutes INTEGER,
  active BOOLEAN DEFAULT true,
  pardoned BOOLEAN DEFAULT false,
  pardoned_by TEXT,
  pardoned_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TICKETING
-- ============================================================

CREATE TABLE ticket_panels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  panel_message JSONB NOT NULL,
  input_mode TEXT NOT NULL CHECK (input_mode IN ('buttons', 'dropdown')),
  ticket_types JSONB NOT NULL DEFAULT '[]',
  manager_roles TEXT[] DEFAULT '{}',
  open_category_id TEXT NOT NULL,
  closed_category_id TEXT,
  transcript_channel_id TEXT,
  dm_transcript_to_creator BOOLEAN DEFAULT false,
  max_open_per_user INTEGER DEFAULT 3,
  introduction_message TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  panel_id UUID REFERENCES ticket_panels(id),
  channel_id TEXT,
  ticket_number INTEGER NOT NULL,
  creator_id TEXT NOT NULL,
  type TEXT NOT NULL,
  claimed_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'closed', 'deleted')),
  closed_by TEXT,
  close_reason TEXT,
  transcript_path TEXT,
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE SEQUENCE ticket_number_seq START 1;

-- ============================================================
-- AUTOMATIONS
-- ============================================================

CREATE TABLE automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  trigger_config JSONB DEFAULT '{}',
  -- Scope filters (NEW v4) — empty arrays = full server scope
  target_user_ids TEXT[] DEFAULT '{}',
  target_channel_ids TEXT[] DEFAULT '{}',
  exclude_user_ids TEXT[] DEFAULT '{}',
  exclude_channel_ids TEXT[] DEFAULT '{}',
  conditions JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN DEFAULT true,
  execution_count INTEGER DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID REFERENCES automations(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guild(id),
  triggered_by TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  conditions_passed BOOLEAN NOT NULL,
  actions_executed INTEGER DEFAULT 0,
  actions_failed INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CUSTOM COMMANDS
-- ============================================================

CREATE TABLE custom_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]',
  allowed_roles TEXT[] DEFAULT '{}',
  allowed_channels TEXT[] DEFAULT '{}',
  denied_roles TEXT[] DEFAULT '{}',
  denied_channels TEXT[] DEFAULT '{}',
  cooldown_seconds INTEGER DEFAULT 0,
  ephemeral BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  discord_command_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, name)
);

-- ============================================================
-- EMBED BUILDER
-- ============================================================

CREATE TABLE embed_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  color INTEGER,
  fields JSONB DEFAULT '[]',
  image_url TEXT,
  thumbnail_url TEXT,
  footer_text TEXT,
  footer_icon_url TEXT,
  author_name TEXT,
  author_url TEXT,
  author_icon_url TEXT,
  include_timestamp BOOLEAN DEFAULT false,
  use_components_v2 BOOLEAN DEFAULT false,
  components_v2_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- LEVELS & XP
-- ============================================================

CREATE TABLE member_levels (
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  voice_minutes INTEGER DEFAULT 0,
  last_xp_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, member_id)
);

CREATE TABLE level_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  level INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  remove_at_level INTEGER,
  announce BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, level, role_id)
);

CREATE TABLE xp_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  role_id TEXT NOT NULL,
  multiplier NUMERIC NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(guild_id, role_id)
);

-- Per-user rank card customization — NEW v4
CREATE TABLE member_rank_settings (
  guild_id TEXT REFERENCES guild(id),
  member_id TEXT NOT NULL,
  background_url TEXT,                  -- Custom background image URL
  background_storage_path TEXT,         -- Supabase Storage path (if uploaded)
  accent_color INTEGER,                 -- Hex color for accent/highlights
  progress_bar_color INTEGER,           -- Hex color for progress bar fill
  overlay_opacity NUMERIC DEFAULT 0.7,  -- Background overlay opacity (0.0–1.0)
  font_color_override TEXT CHECK (font_color_override IN ('light', 'dark')),  -- NULL = auto-detect
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, member_id)
);

-- ============================================================
-- TEMPORARY VOICE CHANNELS
-- ============================================================

CREATE TABLE temp_channel_hubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  hub_channel_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  naming_format TEXT DEFAULT '{username}''s Channel',
  default_user_limit INTEGER DEFAULT 0,
  default_bitrate INTEGER DEFAULT 64000,
  keep_alive_minutes INTEGER DEFAULT 1,
  allow_text_channel BOOLEAN DEFAULT false,
  moderator_roles TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE active_temp_channels (
  channel_id TEXT PRIMARY KEY,
  text_channel_id TEXT,
  guild_id TEXT REFERENCES guild(id),
  hub_id UUID REFERENCES temp_channel_hubs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- STATISTICS CHANNELS
-- ============================================================

CREATE TABLE stats_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT,
  stat_type TEXT NOT NULL CHECK (stat_type IN ('total_members', 'online_members', 'bot_count', 'role_count', 'channel_count', 'premium_members', 'active_tickets', 'total_xp_earned', 'highest_level', 'custom_counter')),
  stat_config JSONB DEFAULT '{}',
  name_format TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  last_value TEXT,
  last_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- SCHEDULED MESSAGES
-- ============================================================

CREATE TABLE scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message TEXT,
  embed_config_id UUID REFERENCES embed_configs(id),
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  max_sends INTEGER,
  current_sends INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- GIVEAWAYS
-- ============================================================

CREATE TABLE giveaways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  prize_product_id UUID REFERENCES products(id),
  prize_license_count INTEGER DEFAULT 1,
  winner_count INTEGER NOT NULL DEFAULT 1,
  ends_at TIMESTAMPTZ NOT NULL,
  required_role_id TEXT,
  required_level INTEGER,
  required_entitlement_product_id UUID,
  entries TEXT[] DEFAULT '{}',
  winners TEXT[] DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'cancelled')),
  ended_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- COMMERCE (unchanged from v2)
-- ============================================================

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('one_time', 'subscription')),
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('file', 'link', 'access_pass', 'mixed')),
  paypal_product_id TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  granted_role_ids TEXT[] DEFAULT '{}',
  granted_channel_ids TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE product_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT,
  external_url TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,
  download_count INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  paypal_plan_id TEXT,
  interval_unit TEXT NOT NULL CHECK (interval_unit IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  interval_count INTEGER DEFAULT 1,
  price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  trial_days INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  guild_id TEXT REFERENCES guild(id),
  discord_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  paypal_customer_id TEXT,
  email TEXT,
  first_purchase_at TIMESTAMPTZ,
  total_spent_cents INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(discord_id, guild_id)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  product_id UUID REFERENCES products(id),
  plan_id UUID REFERENCES plans(id),
  paypal_order_id TEXT,
  paypal_subscription_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  discount_cents INTEGER DEFAULT 0,
  promotion_id UUID REFERENCES promotions(id),
  source TEXT DEFAULT 'purchase' CHECK (source IN ('purchase', 'giveaway', 'manual', 'automation')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'refunded', 'disputed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE license_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  product_id UUID REFERENCES products(id),
  guild_id TEXT REFERENCES guild(id),
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  bound_discord_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_activation', 'active', 'expired', 'revoked', 'suspended')),
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  product_id UUID REFERENCES products(id),
  plan_id UUID REFERENCES plans(id),
  license_key_id UUID REFERENCES license_keys(id),
  order_id UUID REFERENCES orders(id),
  type TEXT NOT NULL CHECK (type IN ('one_time', 'subscription')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'suspended', 'cancelled', 'pending', 'grace_period')),
  source TEXT DEFAULT 'purchase' CHECK (source IN ('purchase', 'giveaway', 'manual', 'automation')),
  granted_role_ids TEXT[] DEFAULT '{}',
  granted_channel_ids TEXT[] DEFAULT '{}',
  grace_period_ends_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- UNIVERSAL LICENSING — NEW v4
-- ============================================================

-- Per-product license configuration
CREATE TABLE product_license_config (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  license_mode TEXT NOT NULL DEFAULT 'portal_only' CHECK (license_mode IN ('portal_only', 'portal_watermark', 'embedded', 'access_pass')),
  max_devices INTEGER DEFAULT 3,
  heartbeat_interval_seconds INTEGER DEFAULT 300,
  offline_grace_period_seconds INTEGER DEFAULT 86400,
  feature_flags TEXT[] DEFAULT '{}',
  tier TEXT,
  watermark_config JSONB,
  require_discord_guild_membership BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Active license sessions (multi-device tracking)
CREATE TABLE license_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_id UUID REFERENCES license_keys(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  device_name TEXT,
  app_version TEXT,
  ip_address TEXT,
  active BOOLEAN DEFAULT true,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT CHECK (deactivation_reason IN ('user_deactivated', 'admin_revoked', 'device_limit', 'heartbeat_timeout', 'entitlement_revoked')),
  UNIQUE(license_key_id, device_fingerprint)
);

-- License validation audit log (every validation call)
CREATE TABLE license_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key_id UUID REFERENCES license_keys(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  device_fingerprint TEXT,
  result TEXT NOT NULL CHECK (result IN ('valid', 'invalid_key', 'expired', 'suspended', 'revoked', 'over_device_limit', 'product_mismatch')),
  ip_address TEXT,
  app_version TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- PROMOTIONS (unchanged from v2)
-- ============================================================

CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed_amount')),
  value NUMERIC NOT NULL,
  coupon_code TEXT,
  applies_to_product_ids UUID[] DEFAULT '{}',
  applies_to_plan_ids UUID[] DEFAULT '{}',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  max_uses INTEGER,
  current_uses INTEGER DEFAULT 0,
  min_purchase_cents INTEGER,
  first_purchase_only BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- PAYMENTS (unchanged from v2)
-- ============================================================

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  customer_id UUID REFERENCES customers(id),
  guild_id TEXT REFERENCES guild(id),
  paypal_payment_id TEXT UNIQUE,
  paypal_event_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('completed', 'refunded', 'reversed', 'pending', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- AUDIT & OPERATIONS
-- ============================================================

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT REFERENCES guild(id),
  timestamp TIMESTAMPTZ DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB DEFAULT '{}',
  before_state JSONB,
  after_state JSONB,
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now(),
  payload JSONB NOT NULL,
  result TEXT CHECK (result IN ('success', 'error', 'duplicate')),
  error_details TEXT
);

-- Order and ticket number sequences
CREATE SEQUENCE order_number_seq START 1;
CREATE SEQUENCE ticket_number_seq START 1;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_audit_guild_time ON audit_logs(guild_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_entitlements_customer ON entitlements(customer_id);
CREATE INDEX idx_entitlements_status ON entitlements(guild_id, status);
CREATE INDEX idx_license_keys_hash ON license_keys(key_hash);
CREATE INDEX idx_license_keys_discord ON license_keys(bound_discord_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_reaction_roles_message ON reaction_roles(message_id);
CREATE INDEX idx_reaction_roles_guild ON reaction_roles(guild_id);
CREATE INDEX idx_customers_discord ON customers(discord_id);
CREATE INDEX idx_webhook_events_type ON webhook_events(event_type);
CREATE INDEX idx_product_files_product ON product_files(product_id);
CREATE INDEX idx_infractions_member ON infractions(guild_id, member_id);
CREATE INDEX idx_infractions_active ON infractions(guild_id, active);
CREATE INDEX idx_tickets_guild ON tickets(guild_id, status);
CREATE INDEX idx_tickets_creator ON tickets(creator_id);
CREATE INDEX idx_member_levels_guild ON member_levels(guild_id, level DESC);
CREATE INDEX idx_member_levels_xp ON member_levels(guild_id, xp DESC);
CREATE INDEX idx_automations_guild ON automations(guild_id, enabled);
CREATE INDEX idx_automation_executions_time ON automation_executions(automation_id, created_at DESC);
CREATE INDEX idx_giveaways_active ON giveaways(guild_id, status);
CREATE INDEX idx_custom_commands_guild ON custom_commands(guild_id, enabled);
CREATE INDEX idx_scheduled_messages_guild ON scheduled_messages(guild_id, active);
-- NEW v4 indexes
CREATE INDEX idx_license_sessions_key ON license_sessions(license_key_id, active);
CREATE INDEX idx_license_sessions_fingerprint ON license_sessions(device_fingerprint);
CREATE INDEX idx_license_validations_key ON license_validations(license_key_id, created_at DESC);
CREATE INDEX idx_license_validations_product ON license_validations(product_id, created_at DESC);
CREATE INDEX idx_product_license_config_mode ON product_license_config(license_mode);
CREATE INDEX idx_member_rank_settings_guild ON member_rank_settings(guild_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_desired_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_id_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE reaction_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE automod_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE infractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE embed_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_multipliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_channel_hubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_temp_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE stats_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE giveaways ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- NEW v4
ALTER TABLE product_license_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_rank_settings ENABLE ROW LEVEL SECURITY;

-- Owner full access on all tables
CREATE POLICY "owner_full_access" ON guild
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_owner = true)
  );

-- Similar policies on all tables: owner has full access
-- Webhook events writable only by service role (Edge Functions)
-- Audit logs are append-only from client perspective
```

---

## 37. API Design

### Dashboard API Routes (Next.js Server Actions + Route Handlers)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/callback` | GET | Discord OAuth callback |
| `/api/auth/signout` | POST | Sign out |
| `/api/guild` | GET | Guild status + config |
| `/api/guild/config` | GET/PUT | Bot configuration |
| `/api/guild/status` | GET | Bot role position, setup status, DB connection |
| **Setup** | | |
| `/api/setup/roles` | GET/POST | Role hierarchy + template assignments |
| `/api/setup/channels` | GET/POST | Channel structure + template assignments |
| `/api/setup/permissions` | GET/POST | Permission mapping matrix |
| `/api/setup/preview` | POST | Preview deployment diff |
| `/api/setup/deploy` | POST | Trigger bot deployment |
| `/api/setup/confirm` | POST | Manual setup confirmation |
| **Templates** | | |
| `/api/templates/roles` | GET/POST/PUT/DELETE | Role template CRUD |
| `/api/templates/channels` | GET/POST/PUT/DELETE | Channel template CRUD |
| `/api/templates/server` | GET/POST/PUT/DELETE | Server template CRUD |
| **Sync** | | |
| `/api/sync/status` | GET | Drift detection status |
| `/api/sync/repair` | POST | Trigger repair |
| `/api/sync/accept` | POST | Accept current state as desired |
| **Onboarding** | | |
| `/api/onboarding` | GET/PUT | Onboarding + @everyone config |
| **Welcome** | | |
| `/api/welcome` | GET/PUT | Welcome & goodbye config |
| **Moderation** | | |
| `/api/moderation/rules` | GET/POST/PUT/DELETE | Auto-mod rule CRUD |
| `/api/moderation/escalation` | GET/PUT | Escalation chain config |
| `/api/moderation/infractions` | GET | Infraction search + list |
| `/api/moderation/infractions/[id]/pardon` | POST | Pardon an infraction |
| **Ticketing** | | |
| `/api/tickets/panels` | GET/POST/PUT/DELETE | Ticket panel CRUD |
| `/api/tickets` | GET | Ticket list with filters |
| `/api/tickets/[id]` | GET | Ticket details |
| `/api/tickets/[id]/transcript` | GET | Download transcript |
| **Automations** | | |
| `/api/automations` | GET/POST/PUT/DELETE | Automation CRUD |
| `/api/automations/[id]/toggle` | POST | Enable/disable |
| `/api/automations/[id]/executions` | GET | Execution history |
| **Custom Commands** | | |
| `/api/commands` | GET/POST/PUT/DELETE | Custom command CRUD |
| **Embeds** | | |
| `/api/embeds` | GET/POST/PUT/DELETE | Embed config CRUD |
| `/api/embeds/[id]/post` | POST | Post embed to channel |
| **Reaction Roles** | | |
| `/api/reaction-roles` | GET/POST/PUT/DELETE | Reaction role CRUD |
| **Levels** | | |
| `/api/levels/config` | GET/PUT | Level system config |
| `/api/levels/rewards` | GET/POST/PUT/DELETE | Level reward CRUD |
| `/api/levels/multipliers` | GET/POST/PUT/DELETE | XP multiplier CRUD |
| `/api/levels/leaderboard` | GET | Server leaderboard data |
| `/api/levels/members/[id]` | GET/PUT | Member XP view/adjust |
| **Temp Channels** | | |
| `/api/temp-channels` | GET/POST/PUT/DELETE | Hub config CRUD |
| **Stats Channels** | | |
| `/api/stats-channels` | GET/POST/PUT/DELETE | Stats channel CRUD |
| **Scheduled Messages** | | |
| `/api/scheduled-messages` | GET/POST/PUT/DELETE | Scheduled message CRUD |
| **Giveaways** | | |
| `/api/giveaways` | GET/POST | Giveaway list + create |
| `/api/giveaways/[id]` | GET/PUT | Giveaway details + edit |
| `/api/giveaways/[id]/end` | POST | End early |
| `/api/giveaways/[id]/reroll` | POST | Reroll winner |
| **Commerce** | | |
| `/api/store/products` | GET/POST/PUT/DELETE | Product CRUD |
| `/api/store/products/[id]/files` | GET/POST/DELETE | Product file management |
| `/api/store/plans` | GET/POST/PUT/DELETE | Plan CRUD |
| `/api/store/promotions` | GET/POST/PUT/DELETE | Promotion CRUD |
| `/api/customers` | GET | Customer list + search |
| `/api/customers/[id]` | GET | Customer details |
| `/api/customers/[id]/entitlements` | GET/POST/PUT | Entitlement management |
| `/api/orders` | GET | Order list + search |
| `/api/orders/[id]` | GET | Order details |
| `/api/orders/[id]/refund` | POST | Process refund |
| `/api/license-keys/[key]` | GET | Key lookup (admin) |
| **Universal Licensing — NEW v4** | | |
| `/api/license/validate` | POST | Universal license validation (called by SDK/apps) |
| `/api/license/heartbeat` | POST | Session heartbeat (called by embedded apps) |
| `/api/license/deactivate` | POST | Deactivate current device session |
| `/api/license/sessions` | GET | List active sessions for a license key (admin) |
| `/api/license/sessions/[id]` | DELETE | Remotely revoke a device session (admin) |
| `/api/license/config/[productId]` | GET/PUT | Per-product license config (admin) |
| `/api/downloads/[productId]/[fileId]` | GET | Protected file download with optional watermarking |
| **Levels — NEW v4** | | |
| `/api/levels/rank-settings/[memberId]` | GET/PUT | Per-user rank card customization |
| **Audit & Operations** | | |
| `/api/audit` | GET | Audit log with filters + pagination |
| `/api/audit/export` | GET | Export audit log as CSV/JSON |
| `/api/diagnostics` | GET | System health check |
| **Webhooks** | | |
| `/api/webhooks/paypal` | POST | PayPal webhook receiver |

### Bot ↔ Dashboard Communication

No direct API calls. Supabase is the intermediary:
- **Dashboard writes** → Supabase → **Bot receives via Realtime**
- **Bot writes** → Supabase → **Dashboard shows in real-time**
- **PayPal webhook** → Edge Function → Supabase → **Bot receives entitlement change**

---

## 38. Deployment & Environment Parity

### 38.1 Environment Variables

```
# Discord
DISCORD_TOKEN=
DISCORD_APPLICATION_ID=
DISCORD_GUILD_ID=
DISCORD_PERMISSIONS=

# Supabase
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_DB_PASSWORD=
SUPABASE_JWT_SECRET=

# PayPal
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_SANDBOX=true
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_WEBHOOK_ID=
PAYPAL_WEBHOOK_URL=

# Lavalink
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=YOUR_LAVALINK_PASSWORD

# Valkey
VALKEY_URL=redis://127.0.0.1:6379

# Dashboard
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=

# YouTube OAuth
YOUTUBE_OAUTH_REFRESH_TOKEN=
```

Same env vars, different values. Local or VPS — identical behavior.

### 38.2 Docker Compose (Local Development)

```yaml
version: '3.8'
services:
  lavalink:
    image: ghcr.io/lavalink-devs/lavalink:4
    container_name: somni-lavalink
    restart: unless-stopped
    ports:
      - "2333:2333"
    volumes:
      - ./services/lavalink/application.yml:/opt/Lavalink/application.yml

  valkey:
    image: valkey/valkey:7.2-alpine
    container_name: somni-valkey
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

### 38.3 Production Docker Compose

```yaml
version: '3.8'
services:
  bot:
    build:
      context: .
      dockerfile: packages/bot/Dockerfile
    restart: unless-stopped
    depends_on:
      - lavalink
      - valkey
    env_file: .env

  dashboard:
    build:
      context: .
      dockerfile: packages/dashboard/Dockerfile
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file: .env

  lavalink:
    image: ghcr.io/lavalink-devs/lavalink:4
    restart: unless-stopped
    volumes:
      - ./services/lavalink/application.yml:/opt/Lavalink/application.yml

  valkey:
    image: valkey/valkey:7.2-alpine
    restart: unless-stopped
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

---

## 39. Security Model

### 39.1 Authentication
- **Dashboard**: Discord OAuth2 via Supabase Auth. JWT sessions.
- **Bot**: Bot token (never exposed client-side).
- **Customers in Discord**: Discord OAuth2 for purchase identity verification.
- **PayPal Webhooks**: Signature verification on every incoming event.

### 39.2 Authorization
- **Dashboard**: Only guild owner (or users with admin permissions) can access.
- **Bot commands**: Permission checks before executing anything sensitive.
- **Commerce**: Identity-bound via Discord OAuth chain. Key bound to Discord ID.
- **Supabase RLS**: Row-level policies on every table. Owner has full access. Webhook events writable only by service role.
- **Ticket channels**: Permission overrides ensure only creator + managers see content.
- **Temp channels**: Owner controls who enters; moderator roles can override.

### 39.3 Secrets
- All secrets in `.env` (gitignored)
- `.env.example` documents variables without values
- License keys: plaintext delivered once in bot DM, only SHA-256 hash stored in database
- Bot token, Supabase secret key, PayPal client secret never exposed to browser
- Ticket transcripts stored in private Supabase bucket (service role access only)

### 39.4 Rate Limiting
- **Discord API**: discord.js built-in rate limit handler + Valkey-tracked throttling for bulk deployments
- **PayPal API**: Exponential backoff on errors
- **Dashboard API**: Supabase Edge Function limits + per-user throttling for sensitive operations
- **Lavalink**: YouTube request success/failure tracking, back off on elevated failures
- **Automations**: Per-user, per-automation rate limits in Valkey
- **XP system**: Per-user cooldown in Valkey
- **Stats channels**: Respect Discord's 2 name changes per 10 minutes per channel
- **License validation API**: Per-key rate limit (max 60 requests/minute per license key) — NEW v4
- **License heartbeat API**: Per-session rate limit (max 1 per interval - 10% buffer) — NEW v4

### 39.5 Licensing Security — NEW v4

- **License key storage**: Only SHA-256 hash in DB. Plaintext delivered once via bot DM, never stored.
- **Validation endpoint security**: Public endpoint (no auth header needed — the license key IS the auth). Rate-limited per key. IP logging for abuse detection.
- **Device fingerprinting**: Server-side device limit enforcement. Oldest session auto-invalidated when over limit.
- **Heartbeat enforcement**: Apps that stop heartbeating have sessions marked inactive after `offline_grace_period_seconds`. Does not revoke the license — just the session. Next validation call re-creates the session.
- **Real-time revocation**: Admin revokes entitlement → all sessions invalidated → next heartbeat/validation = denied. No grace period for admin revocation.
- **File download security**: All product file downloads go through authenticated, signed URLs. URLs expire after 5 minutes. Download count tracked per entitlement.
- **Watermark integrity**: Watermarking happens server-side at download time. Customer never accesses the unwatermarked original.
- **Link proxying**: Real URLs for link products are stored server-side only. Never exposed in API responses, HTML source, or network requests visible to the browser.
- **SDK tamper resistance**: The SDK is designed for honest integration, not DRM. Determined attackers can patch it out — the goal is making casual piracy inconvenient and providing audit trails. True security comes from server-side validation + session tracking.

---

## 40. Implementation Phases

### Phase 1: Foundation
- Monorepo setup (Turborepo, pnpm, TypeScript configs)
- Shared package: types, constants, permission registry, brand palette, Zod validators, level curve
- Supabase: full schema migration (all tables from §36), RLS policies, auth with Discord OAuth
- Bot skeleton: client, config (Zod-validated env), event handler, Supabase + Valkey clients, platform event bus
- Dashboard skeleton: Next.js 16, Discord OAuth login, Discord-native dark theme, sidebar layout with all nav items (locked sections grayed out)
- Docker Compose: Lavalink + Valkey
- `.env` system with validation

### Phase 2: Permission Engine + Templates
- Role template system (4 built-in + custom)
- Channel template system (built-in: Member View Only, Member View & Use, Staff Only, Premium Only, Temp Hub + custom). Note: Ticket channels are NOT templates — they are dynamically created by the bot with per-user permission overrides at runtime.
- Permission engine: compute effective permissions, safety checks, hierarchy validation
- @everyone = 0 enforcement
- Dashboard: template editors, permission matrix visualization
- Shared: full Discord permission registry with categorization

### Phase 3: Server Setup & Deployment
- Dashboard setup wizard (7 steps: @everyone/onboarding → roles → channels → permissions → preview → deploy → confirm)
- Bot deployer system: @everyone zeroing, role creation, channel creation, permission override application
- Desired state storage + Discord ID mapping
- Feature gating: locked sections, bot role position enforcement
- Audit logging for all deployment actions

### Phase 4: Onboarding + Welcome + Goodbye
- @everyone = 0 deployment
- Discord native onboarding integration
- Bot detection of onboarding completion (guildMemberUpdate flags)
- Member role grant on completion
- Interest role mapping
- Welcome message system (channel + DM + card + auto-roles)
- Goodbye message system
- Returning member detection and role restoration
- Dashboard: onboarding page, welcome/goodbye page
- `@napi-rs/canvas` welcome card generation

### Phase 5: Sync Engine + Drift Detection
- Server state snapshot via Discord API
- Diff algorithm (desired vs. actual)
- Drift classification (including @everyone drift as critical)
- Dashboard: sync status, repair/accept/ignore
- Optional auto-repair mode
- Event-based drift detection (role/channel update events)

### Phase 6: Moderation System
- Auto-mod rules engine (all 8 rule types)
- Message scanning pipeline (messageCreate)
- Infraction system (create, query, pardon, expire)
- Escalation chain (threshold → action)
- Discord native timeout for mutes
- Mod log channel posting
- Dashboard: moderation page (rules, escalation, infraction history)
- Moderation ↔ commerce interaction (ban → entitlement suspension)

### Phase 7: Ticketing System
- Ticket panel builder (dashboard)
- Panel posting (bot → channel)
- Ticket channel creation with permissions
- Ticket lifecycle (open → claimed → closed → deleted)
- Transcript generation (HTML)
- Commerce integration (INS-XXXXX lookup in tickets)
- Dashboard: ticket management, transcript viewer
- `/ticket` commands

### Phase 8: Automations Engine
- Platform event bus (all event types)
- Trigger matching
- Condition evaluation
- Action execution
- Rate limiting (Valkey)
- Execution logging
- Dashboard: visual automation builder, execution log
- Connect to all existing features (welcome, moderation, tickets, etc.)

### Phase 9: Levels, Reactions, Custom Commands
- XP tracking (message + voice)
- Level calculation + level-up detection
- Role rewards (grant/remove)
- XP multipliers
- Rank card generation (`@napi-rs/canvas`)
- Leaderboard
- `/rank`, `/leaderboard` commands
- Dashboard: levels page, rewards, multipliers, rank card customization
- Reaction roles (Valkey-cached, level prerequisites)
- Custom commands (dashboard CRUD, dynamic Discord registration, execution)
- Embed/message builder (dashboard tool, template system)

### Phase 10: Community Features
- Temporary voice channels (hub monitoring, channel creation/cleanup, owner commands)
- Statistics channels (cron-based updates, all stat types)
- Scheduled messages (cron registration, embed integration)
- Giveaways (lifecycle, entry validation, winner selection, commerce integration)
- Dashboard: all community pages

### Phase 11: Music System
- Shoukaku integration with Lavalink v4
- Queue system (Valkey-backed, persistent)
- All music commands with Components v2 UI (SomniBot palette)
- Self-healing: node monitoring, YouTube client rotation, OAuth refresh
- DJ role support, vote-skip
- Dashboard: music settings, Lavalink health

### Phase 12: Commerce & Universal Licensing Platform — EXPANDED v4
- Product CRUD (dashboard — web apps, desktop apps, mobile apps, CLI tools, documents, links, access passes)
- License mode configuration per product (portal_only, portal_watermark, embedded, access_pass)
- PayPal integration: catalog products, billing plans, orders, subscriptions
- PayPal webhook handler (Supabase Edge Function)
- Identity-bound licensing: Discord OAuth → key generation → binding → activation
- Entitlement system: grant, validate, revoke, suspend
- **Universal License Validation API** (`/api/license/validate` Edge Function)
- **License Heartbeat API** (`/api/license/heartbeat` Edge Function)
- **Multi-device session tracking** (license_sessions table, max device enforcement, oldest-session invalidation)
- **Real-time revocation** (admin revoke → all sessions invalidated → next heartbeat = denied)
- **`@somnibot/license-sdk` npm package** with TypeScript implementation
- **Reference implementations** for Python, C#, Rust
- **SDK documentation** (README, QUICKSTART, API reference, platform guide, security guide)
- **Protected file delivery** with optional dynamic watermarking (buyer identity stamped on downloads)
- **Link proxying** (real URLs never exposed to customers)
- `/store` command: Components v2 product display
- `/license` commands: activate, check, info
- Order lifecycle: INS-XXXXX numbers, receipts (bot DM + dashboard)
- Dashboard: store admin, customer admin, order admin, key lookup, entitlement repair, session management, license config

### Phase 13: Promotions + Operations + Polish
- Promotion/coupon system (dashboard)
- Full audit log with filters, export
- Diagnostics dashboard
- Payment reconciliation tools
- Webhook replay
- Error recovery flows
- Performance optimization (query optimization, Valkey caching review)
- Accessibility pass on dashboard
- Documentation

### Phase 14: Virtual Economy
- Core wallet system (wallet + bank, deposit/withdraw, starting balance)
- Earning commands: daily, weekly, monthly, work, crime, beg, search, collect-income
- Streak system with consecutive-day bonuses
- Spending: pay (with tax), rob (with passive mode protection), shop, buy, sell, use, inventory
- Chat income (passive XP-style currency drip)
- Economy leaderboard (server-side `economy_leaderboard` RPC)
- Economy log channel
- Item system: shop items with rarity, effects, durability, categories
- Role-based passive income (`economy_role_income`)
- All economy tables: wallets, transactions, items, inventory, streaks, role_income
- Dashboard: economy settings, item editor, shop configuration

### Phase 15: Economy Subsystems
- **Player Market**: P2P item trading, configurable fee (currency sink), browse/list/buy/cancel, atomic buy/revert RPCs, reconciliation queue
- **Heist**: Cooperative multi-user heists, recruiting phase, role assignment, configurable cooldown (Valkey NX + DB fallback), payout splitting
- **Lottery**: Periodic drawings, ticket purchasing, jackpot pooling, winner selection
- **Mini-Games**: Coinflip, slots, RPS, dice, blackjack (interactive hit/stand/double), high-low, scratch cards, number guess — all with per-user game locks and daily loss limits
- **Fishing**: Species rarity tiers, catch logging, rod/bait item effects
- **Farming**: Crop planting, growth timers, plot management, harvest yields
- **Crafting**: Recipe system, material requirements, loot tables for gathered materials
- **Gathering**: Location-based material collection, loot-table rolls
- **Adventures**: Multi-scene branching stories, scene choices, reward paths, adventure sessions
- **Pets**: Adopt, feed, play, train, battle, prestige — stat decay timer with DM notifications, 4 types (hunting/guard/foraging/lucky) with gameplay bonuses
- **Quests**: Template-driven daily/weekly quests, progress tracking across all economy actions (market_trade, fish_catch, heist_complete, etc.)
- **Achievements**: Definition-based unlock system, badge display on profiles
- **Prestige**: Reset economy progress for permanent multiplier bonuses
- **Trivia**: Question bank, timed sessions, currency rewards, difficulty scaling
- **Polls & Predictions**: Community polls with multi-option voting + prediction markets with currency betting and pari-mutuel payout

### Phase 16: Community & Protection
- **Profiles**: User cards with title, bio, net worth, pet, prestige, achievements, badges, view counter (atomic RPC)
- **Starboard**: Configurable emoji/threshold, self-star toggle, auto-crosspost to starboard channel, count updates on existing entries
- **Message Log**: Edit/delete tracking, embed posts to configured log channel, attachment logging
- **Anti-Raid**: Sliding-window join flood detection, configurable threshold/window/action (kick/ban/lockdown), minimum account age filter, auto-deactivation after 5m calm, mod log integration

### Phase 17: Desktop Launcher
- Electron app (`packages/launcher`) — one-click bot + dashboard startup
- Credential store (electron-store with obfuscation)
- Supabase cloud sync (push/pull credentials via REST)
- Process manager: fork bot + Next.js dashboard as child processes, IPC heartbeat monitoring
- Lavalink manager: Java detection, one-click JAR download, application.yml generation, child process lifecycle
- Stale-process cleanup on restart (PID tracking)
- Port-conflict detection before dashboard start
- Auto-updater via electron-updater (GitHub Releases)
- First-run onboarding wizard
- Context-isolated preload (no Node.js in renderer)
- Cross-platform: Windows (NSIS), macOS (DMG), Linux (AppImage)

### Phase 18: Dashboard RBAC & Customer Portal
- 5-tier role system: Owner (full access), Admin, Moderator, Manager, Viewer — plus custom roles
- 22 granular permissions (manage_store, manage_team, view_audit, etc.)
- Dashboard team management page: assign/remove roles, create custom roles, edit permissions
- Owner role immutable, system roles undeletable
- **Customer Portal**: Discord OAuth login, session tokens (SHA-256 hashed, 7-day expiry)
- Portal pages: orders (purchase history), licenses (key list + active sessions), downloads (entitled product files)
- Portal API: `/api/portal/auth`, `/api/portal/orders`, `/api/portal/licenses`, `/api/portal/downloads`

---

## 41. Virtual Economy System

The virtual economy is a standalone fake-currency system with **zero connection** to the real-money commerce/licensing platform. It provides engagement mechanics through earning, spending, trading, and competing.

### 41.1 Architecture

```
packages/bot/src/features/
├── economy/
│   ├── economy-manager.ts    # Core wallet + transaction logic (1,300 lines)
│   ├── commands.ts           # 20+ slash commands
│   └── index.ts              # Registration
├── market/                   # P2P item trading (§42)
├── heist/                    # Cooperative heists (§43)
├── lottery/                  # Periodic draws (§44)
├── games/                    # 8 mini-games (§45)
├── fishing/                  # Fish species + catches
├── farming/                  # Crop planting + harvesting
├── crafting/                 # Recipe-based item creation
├── gathering/                # Material collection
├── adventures/               # Branching story events
├── pets/                     # Virtual pet care + battles
├── quests/                   # Daily/weekly objectives
├── achievements/             # Badge/unlock system
├── trivia/                   # Timed Q&A sessions
└── polls/                    # Polls + prediction markets (§49)
```

### 41.2 Wallet System

Every guild member has a dual-balance wallet stored in `economy_wallets`:

| Field | Type | Description |
|---|---|---|
| `guild_id` | TEXT | Guild snowflake |
| `user_id` | TEXT | Discord user ID |
| `wallet` | BIGINT | Spendable balance |
| `bank` | BIGINT | Protected savings (configurable cap) |
| `passive` | BOOLEAN | Robbery protection toggle |
| `total_earned` | BIGINT | Lifetime earnings |
| `total_spent` | BIGINT | Lifetime spending |

- All balance mutations go through atomic Supabase RPCs: `economy_add_balance`, `economy_subtract_balance` — these prevent negative balances and TOCTOU races.
- Every mutation is recorded in `economy_transactions` (type, amount, from/to, metadata).
- Wallets are auto-created on first interaction with configurable `economy_starting_balance`.

### 41.3 Earning Commands

| Command | Behavior | Cooldown |
|---|---|---|
| `/daily` | Fixed reward + streak bonus | 24h (streak resets if missed) |
| `/weekly` | Larger fixed reward | 7 days |
| `/monthly` | Largest fixed reward | 30 days |
| `/work` | Random amount in [work_min, work_max], random job flavor text | Configurable (default 60s) |
| `/crime` | Success (crime_success_pct): earn [crime_min, crime_max]. Fail: lose fine_pct% of wallet | Same as work |
| `/beg` | Small random reward or nothing | Shared work cooldown |
| `/search` | Random location with different payout ranges or empty | Shared work cooldown |
| `/collect-income` | Per-role passive income from `economy_role_income` table | 24h |

**Streak system**: Consecutive daily claims increase the bonus by `streak_bonus_pct` per day. Streaks are tracked in `economy_streaks` with `current_streak`, `longest_streak`, and `last_claimed_at`.

### 41.4 Spending & Transfer

| Command | Behavior |
|---|---|
| `/deposit <amount>` | Move coins from wallet to bank (bank has configurable max) |
| `/withdraw <amount>` | Move coins from bank to wallet |
| `/pay <user> <amount>` | Transfer with configurable tax percentage (currency sink) |
| `/rob <user>` | Steal from another user's wallet. Configurable success rate. Fails = fine. Blocked by passive mode. |
| `/passive` | Toggle robbery protection (prevents robbing AND being robbed) |

### 41.5 Shop & Inventory

- **Items** are defined in `economy_items` with: name, description, emoji, price, category, rarity, effect_type, effect_value, max_stock, sellable flag, sell_price_pct, durability.
- `/shop [category]` — browse available items
- `/buy <item> [quantity]` — purchase items (atomic balance deduction + inventory upsert)
- `/sell <item> [quantity]` — sell back at `sell_price_pct` of original price
- `/inventory [user]` — view owned items with durability
- `/use <item>` — consume an item, applying its effect

Items can have effects like XP boosts, rob protection shields, cooldown reductions, etc. The effect system is extensible through `effect_type` + `effect_value` on the item definition.

### 41.6 Chat Income

When `economy_chat_income_enabled` is true, users passively earn random amounts in [`chat_income_min`, `chat_income_max`] from regular messages. A per-user Valkey cooldown (`chat_income_cooldown_seconds`) prevents farming. This runs inside `messageCreate` and never responds visibly — it's a silent background reward.

### 41.7 Leaderboard

`/economy-leaderboard` calls the server-side `economy_leaderboard` RPC (added in V53-M2) which computes `wallet + bank` as net worth and returns the top N members, sorted descending. This avoids client-side sorting of potentially thousands of wallet rows.

### 41.8 Configuration

All economy settings live in `guild_config` with the `economy_` prefix. Over 30 configurable values control every aspect: enable/disable, currency name/emoji, amounts, cooldowns, percentages, caps, and log channels. Dashboard editors expose all settings.

---

## 42. Player Market

Peer-to-peer item trading marketplace. Players list inventory items for sale, others browse and buy. A configurable market fee acts as a currency sink.

### 42.1 Listing Flow

1. `/market list <item> <quantity> <price>` — checks inventory, atomically decrements via `economy_decrement_inventory` RPC (prevents listing same item twice), creates `economy_market_listings` row with expiration date.
2. If listing insert fails, items are refunded to inventory.
3. Max active listings per user is configurable (`economy_market_max_listings`).

### 42.2 Buy Flow (Atomic Multi-Step)

1. `/market buy <id> [quantity]` — find listing by ID prefix
2. Atomically decrement listing remaining via `economy_market_buy(UUID, INT)` RPC (V53-C1: positive quantity guard)
3. Debit buyer's wallet via `economy_subtract_balance`
4. Credit seller's earnings (total minus fee) via `economy_add_balance`
5. Add items to buyer's inventory via `economy_upsert_inventory`

**Rollback on failure**: If any step fails after the listing decrement, `economy_market_buy_revert(UUID, INT)` restores the listing quantity, and any partial balance changes are reversed. Three distinct rollback paths handle: buyer insufficient funds, seller credit failure, and inventory upsert failure.

### 42.3 Cancel Flow

`/market cancel <id>` uses `economy_market_atomic_cancel` RPC which atomically flips `status` from `active` to `cancelled` (prevents concurrent cancel duplication). Items are returned to inventory; if return fails, a reconciliation entry is queued in `bot_action_queue` for automatic retry.

### 42.4 Browse

`/market browse [search]` — lists active listings with price sorting, ILIKE search (with wildcard-escape to prevent injection), and seller attribution.

---

## 43. Heist System

Multi-user cooperative heist events. One player starts a heist, others join during the recruiting window.

### 43.1 Flow

1. `/heist start` — creates heist with `recruiting` status, opens 60s join window
2. `/heist join` — adds participant with random role (Hacker, Muscle, Lookout, Driver, Demolitions)
3. Timer resolves: base success = `economy_heist_success_pct` + 5% per additional member. Target is randomly selected (Corner Store → Federal Reserve) with difficulty/payout modifiers.
4. **Success**: Pool is split among participants proportional to risk role
5. **Failure**: All participants lose their buy-in

### 43.2 Cooldown

Dual-layer cooldown:
- **Valkey**: `SET heist:cd:{guild} 1 EX {seconds} NX` — atomic, prevents races (V53-L3)
- **DB fallback**: `economy_heists.resolved_at` check — covers Valkey-down scenarios

### 43.3 Database Tables

- `economy_heists`: id, guild_id, channel_id, initiator_id, status (recruiting/in_progress/success/failed), target_name, pool_amount, resolved_at
- `economy_heist_participants`: heist_id, user_id, role, payout

---

## 44. Lottery System

Periodic lottery drawings where players buy tickets for a chance at the jackpot.

### 44.1 Architecture

- `economy_lottery_drawings`: guild_id, status (open/drawing/completed), prize_pool, ticket_price, winner_id, drawn_at
- `economy_lottery_tickets`: drawing_id, user_id, ticket_count, purchased_at

### 44.2 Flow

1. Owner configures lottery schedule and ticket price
2. Members buy tickets (`/lottery buy <count>`) — balance deducted, tickets added to pool
3. Drawing resolves: random weighted winner selection (more tickets = higher chance)
4. Winner receives prize pool minus configurable house-cut

---

## 45. Mini-Games

Eight gambling-style mini-games, all with per-user Valkey-based game locks and daily loss limits.

### 45.1 Game List

| Game | Command | Mechanic |
|---|---|---|
| Coinflip | `/coinflip <bet>` | 50/50, 2x payout |
| Slots | `/slots <bet>` | 3-reel slot machine, symbol matching, up to 10x |
| Rock-Paper-Scissors | `/rps <bet> <choice>` | Classic RPS vs. bot |
| Dice | `/dice <bet>` | Roll 2d6, beat the house |
| Blackjack | `/blackjack <bet>` | Interactive hit/stand/double-down with button collector (V53-L5) |
| High-Low | `/highlow` | Guess if next number is higher or lower |
| Scratch Card | `/scratch <bet>` | Reveal grid for instant prizes |
| Number Guess | `/guess <bet>` | Guess a number 1-10, 5x payout |

### 45.2 Safety Controls

- **Per-user game lock**: Valkey-based lock acquired before bet validation — prevents concurrent games from double-spending the same balance.
- **Daily loss limit**: `economy_daily_losses` table tracks cumulative losses per user per day. Configurable `economy_daily_loss_limit` prevents excessive gambling.
- **Minimum/maximum bet**: Enforced per-game via slash command `minValue`/`maxValue`.
- **Blackjack collector**: Button interaction collector with 60s timeout. On timeout, hand auto-stands and resolves (V53-L5 fix: was previously auto-resolving on deal with no interactive play).

---

## 46. Economy Subsystems (Fishing, Farming, Crafting, Gathering, Adventures, Pets)

### 46.1 Fishing

- `economy_fish_species`: name, rarity (common/uncommon/rare/legendary), base_price, emoji, min_weight, max_weight
- `economy_fish_catches`: user catch log with species, weight, sell price
- Rod/bait items from the shop modify catch rates and rarity chances
- `/fish` — cast a line, roll against rarity table, record catch
- `/fish sell` — sell catches for currency

### 46.2 Farming

- `economy_crops`: name, grow_time_minutes, base_yield, seed_price
- `economy_farm_plots`: guild_id, user_id, plot_number, crop_id, planted_at, watered, harvested
- `/farm plant <crop>` — buy seeds, plant in next available plot
- `/farm water` — water crops (speeds growth)
- `/farm harvest` — collect mature crops, add to inventory
- `/farm status` — view all plots with growth progress

### 46.3 Crafting

- `economy_recipes`: name, materials (JSONB array of item_id + quantity), result_item_id, result_quantity, xp_reward
- `/craft <recipe>` — checks inventory for materials, consumes them, creates result item
- Recipes are admin-defined in the dashboard

### 46.4 Gathering

- `economy_loot_tables`: name, drops (JSONB array of item_id + chance + min_qty + max_qty), energy_cost, cooldown_seconds
- `/gather <location>` — spend energy, roll loot table, receive materials for crafting
- Locations are admin-defined with different drop tables

### 46.5 Adventures

- `economy_adventures`: name, description, min_level, reward_range
- `economy_adventure_scenes`: adventure_id, scene_number, text, choices (JSONB), outcomes (JSONB)
- `economy_adventure_sessions`: user's active adventure state (current scene, choices made, rewards accumulated)
- `/adventure start` — begin a random level-appropriate adventure
- Interactive button choices navigate through branching scenes
- Final outcome determines currency + item rewards

### 46.6 Pets

- `economy_pets`: guild_id, user_id, name, pet_type (hunting/guard/foraging/lucky), level, xp, hunger, happiness, energy, status (happy/sad/sick), prestige
- `economy_pet_battles`: challenger_id, defender_id, winner_id, xp_gained

| Command | Behavior |
|---|---|
| `/pet adopt <type>` | Buy a pet (hunting 🐺, guard 🐕, foraging 🐿️, lucky 🐈) |
| `/pet feed` | Restore hunger |
| `/pet play` | Restore happiness (30s cooldown) |
| `/pet train` | Gain XP, progress toward next level |
| `/pet battle <user>` | PvP pet battle, winner gains XP |
| `/pet status` | View pet stats |

**Stat Decay**: A background timer (`schedulePetDecay`) reduces hunger/happiness periodically. When stats drop below threshold → status changes to `sad`/`sick`. Owner gets a DM notification (if configured). Max level 50, with prestige reset for permanent bonuses.

**Gameplay bonuses**: Hunting pets boost loot, guard pets reduce rob success against you, foraging pets give passive item finds, lucky pets boost gambling.

---

## 47. Quests, Achievements & Prestige

### 47.1 Quest System

- `economy_quest_templates`: type (daily/weekly), description, objective_type (e.g. `market_trade`, `fish_catch`, `heist_complete`), target_count, reward_amount, reward_item_id
- `economy_quest_progress`: user's active quests, current_count, completed flag

Quests are auto-assigned on first daily/weekly interaction. Progress is tracked via `QuestsManager.trackProgress(guildId, userId, objectiveType)` — called from every relevant subsystem (market buy, fish catch, heist resolve, pet battle, etc.).

### 47.2 Achievement System

- `economy_achievement_defs`: name, description, emoji, criteria_type, criteria_value, reward_amount, badge_emoji
- `economy_user_achievements`: which user unlocked which achievement, timestamp

Achievements are checked after significant economy events. Unlocking an achievement grants a badge (displayed on profile) and optional currency reward.

### 47.3 Prestige

- `economy_prestige`: guild_id, user_id, prestige_level, multiplier_pct

Players can prestige (reset wallet/bank/inventory) in exchange for a permanent earnings multiplier. Each prestige level adds to `multiplier_pct`, which is applied to all earning commands.

---

## 48. Trivia System

Timed question-and-answer sessions with currency rewards.

- `economy_trivia_questions`: question, answers (JSONB), correct_answer_index, difficulty, category
- `economy_trivia_sessions`: active session tracking with participants and scores

### 48.1 Flow

1. `/trivia start [category]` — creates a session, posts first question with button options
2. Players answer within the time limit
3. Correct answers earn points + currency based on difficulty and speed
4. After all questions, leaderboard is posted with rewards distributed

---

## 49. Polls & Prediction Markets

### 49.1 Polls

Standard community polls with multi-option voting:

- `polls`: guild_id, channel_id, message_id, question, status (open/closed), created_by, closes_at
- `poll_options`: poll_id, label, emoji, vote_count
- `poll_votes`: poll_id, user_id, option_id (unique constraint prevents double-voting)

`/poll create <question>` — creates poll with up to 10 options. Voting via button interactions. `/poll close <id>` — closes poll and displays results.

### 49.2 Prediction Markets

Currency-backed predictions where users bet on outcomes:

- `predictions`: guild_id, question, status (open/locked/resolved), pool_amount, winning_option_id, created_by
- `prediction_options`: prediction_id, label
- `prediction_bets`: prediction_id, user_id, option_id, amount

`/prediction create <question>` — create with 2+ options. Users place bets (`/prediction bet <id> <option> <amount>`) — currency is deducted atomically. Creator resolves with `/prediction resolve <id> <winning_option>`. Payout is pari-mutuel: winners split the pool proportionally to their bets. If bet placement fails after balance deduction, the deduction is reversed.

---

## 50. Profiles

User profile cards integrating data from across the economy system.

### 50.1 Data Model

`economy_profiles`: guild_id, user_id, title (max 64 chars), bio (max 256 chars), badge_slots (TEXT[]), profile_views (atomic counter via `increment_profile_views` RPC).

### 50.2 Commands

| Command | Behavior |
|---|---|
| `/profile [user]` | Display profile card: title, bio, net worth (wallet + bank), pet, prestige level + multiplier, achievement count, badges, view counter |
| `/title <text>` | Set display title |
| `/bio <text>` | Set profile bio |

Profile view command fetches wallet, pet, prestige, and achievement data in parallel (`Promise.all`) for fast rendering.

---

## 51. Starboard

Highlights popular messages that receive enough star reactions by cross-posting them to a dedicated starboard channel.

### 51.1 Configuration (via `guild_config`)

| Setting | Default | Description |
|---|---|---|
| `starboard_enabled` | false | Enable/disable |
| `starboard_channel_id` | null | Target channel for starred messages |
| `starboard_threshold` | 3 | Minimum reactions to qualify |
| `starboard_emoji` | ⭐ | The emoji that counts |
| `starboard_self_star` | false | Whether author's own reaction counts |

### 51.2 Flow

1. `messageReactionAdd` event fires
2. Check emoji match, threshold, and config
3. If self-star disabled, subtract author's reaction from count
4. If threshold met:
   - **New**: Create embed (author, content, image, jump link, channel) → send to starboard channel → store in `starboard_entries`
   - **Update**: Edit existing starboard message with new count
5. `starboard_entries` tracks: guild_id, source_channel_id, source_message_id, starboard_message_id, star_count, author_id

---

## 52. Message Log

Logs message edits and deletes to a designated channel for moderation transparency.

### 52.1 Configuration (via `guild_config`)

| Setting | Default | Description |
|---|---|---|
| `message_log_enabled` | false | Enable/disable |
| `message_log_channel_id` | null | Target channel for log embeds |

### 52.2 Events Tracked

| Event | Embed Color | Content |
|---|---|---|
| `messageUpdate` | 🟠 Orange | Before/after content, channel, author, jump link |
| `messageDelete` | 🔴 Red | Deleted content, channel, author, attachments list |

Bot messages are ignored. Content is truncated to 1,024 characters (Discord embed field limit). Deletions in the log channel itself are not logged (prevents infinite loops).

---

## 53. Anti-Raid System

Detects join floods and takes automatic protective action.

### 53.1 Configuration (via `guild_config`)

| Setting | Default | Description |
|---|---|---|
| `anti_raid_enabled` | false | Enable/disable |
| `anti_raid_join_threshold` | 10 | Joins in window to trigger raid mode |
| `anti_raid_join_window_seconds` | 10 | Sliding window size |
| `anti_raid_account_age_days` | 7 | Minimum account age (always enforced) |
| `anti_raid_action` | kick | Action on raid: `kick`, `ban`, or `lockdown` |
| `anti_raid_log_channel_id` | null | Channel for raid alerts (falls back to mod_log) |

### 53.2 Detection Flow

1. **Account age filter** (always active): New members younger than `anti_raid_account_age_days` are automatically kicked with a DM explanation.
2. **Join flood detection**: A sliding window tracks recent join timestamps. When count exceeds `anti_raid_join_threshold` within `anti_raid_join_window_seconds`:
   - Raid mode activates
   - All subsequent joins are actioned (kick/ban depending on config)
   - Alert embed posted to log channel
3. **Auto-deactivation**: Raid mode automatically deactivates after 5 minutes of calm (no new threshold violations).

### 53.3 Actions

| Action | Behavior |
|---|---|
| `kick` | DM warning → kick member |
| `ban` | DM warning → ban member (no message deletion) |
| `lockdown` | Log-only (full Discord verification level changes require higher privilege) |

---

## 54. Desktop Launcher (`packages/launcher`)

An Electron desktop application that provides one-click startup of the bot + dashboard for non-technical users.

### 54.1 Architecture

```
packages/launcher/
├── src/
│   ├── main/
│   │   ├── index.ts             # Main process: window, IPC, lifecycle
│   │   ├── config-store.ts      # electron-store credential persistence
│   │   ├── process-manager.ts   # Bot + dashboard child process management
│   │   ├── lavalink-manager.ts  # Java detection, JAR download, Lavalink lifecycle
│   │   ├── supabase-sync.ts     # Cloud credential sync via REST
│   │   ├── updater.ts           # electron-updater auto-updates
│   │   ├── preload.ts           # Context-isolated IPC bridge
│   │   └── validators.ts        # Credential validation
│   └── renderer/
│       ├── index.html           # Launcher UI
│       ├── renderer.js          # UI logic
│       └── styles.css           # Styles
├── electron-builder.yml         # Build configuration
├── package.json
└── tsconfig.json
```

### 54.2 Process Management

The launcher forks the bot and dashboard as Node.js child processes:

- **Bot**: `fork()` with IPC channel for heartbeat monitoring. If no heartbeat for 60s → status changes to `error`.
- **Dashboard**: `fork()` Next.js standalone server on `localhost:3456`. Detects "ready" from stdout.
- **Lavalink**: Optional managed child process (Java required). One-click download from GitHub Releases, auto-generates `application.yml`.

### 54.3 Credential Management

- **Local storage**: `electron-store` with basic obfuscation (`encryptionKey`). Stores Discord credentials, Supabase connection, UI preferences.
- **Cloud sync**: Push/pull credentials to/from Supabase `instance_settings` table via direct REST calls. Bootstrap creds (Supabase URL + secret key) always needed locally; everything else recoverable from cloud.
- **Session token**: Generated fresh each run (`crypto.randomBytes(32)`) for dashboard local-mode auth.

### 54.4 Environment Variables

The launcher builds the complete env var set for child processes from stored credentials:

```
DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID
SUPABASE_URL, SUPABASE_SECRET_KEY
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SESSION_TOKEN (generated per-run)
PORT=3456, HOSTNAME=127.0.0.1
LAVALINK_HOST, LAVALINK_PORT, LAVALINK_PASSWORD
VALKEY_URL
```

### 54.5 Safety Features

- **Single instance lock**: `app.requestSingleInstanceLock()` prevents multiple launchers.
- **Port conflict detection**: Checks port 3456 availability before starting dashboard.
- **Stale process cleanup**: PID tracking in config. On startup, kills any leftover PIDs from a previous crash.
- **Graceful shutdown**: `before-quit` stops all child processes with SIGTERM, followed by SIGKILL after 5s timeout.
- **Context isolation**: Renderer has no direct Node.js access. All IPC goes through the preload bridge.

### 54.6 Auto-Updates

Uses `electron-updater` with GitHub Releases as the update source. The renderer receives update events (checking, available, progress, downloaded) and can trigger install.

### 54.7 Distribution

Configured via `electron-builder.yml`:
- **Windows**: NSIS installer (one-click, per-user)
- **macOS**: DMG (x64 + arm64 universal)
- **Linux**: AppImage (x64)

Published to GitHub Releases (owner: HeyImDionysus, repo: somnibot).

---

## 55. Dashboard RBAC & Team Management

Role-based access control for the web dashboard, allowing the guild owner to delegate dashboard access to team members.

### 55.1 Role Hierarchy

| Role | Source | Permissions |
|---|---|---|
| **Owner** | Discord guild ownership | `dashboard.full_access` — immutable, cannot be modified or deleted |
| **Custom roles** | Created by owner | Any combination of 22 granular permissions |

### 55.2 Available Permissions (22 total)

```
dashboard.full_access          dashboard.view_analytics
dashboard.manage_store         dashboard.manage_products
dashboard.manage_orders        dashboard.manage_customers
dashboard.manage_licenses      dashboard.manage_moderation
dashboard.manage_tickets       dashboard.manage_automations
dashboard.manage_server        dashboard.manage_roles
dashboard.manage_channels      dashboard.manage_team
dashboard.view_audit           dashboard.view_diagnostics
dashboard.manage_incidents     dashboard.view_fraud
dashboard.manage_fraud         dashboard.view_workflows
dashboard.manage_workflows     dashboard.undo_changes
```

### 55.3 Data Model

- `dashboard_roles`: id, guild_id, name, description, permissions (TEXT[]), is_system, priority
- `dashboard_user_roles`: id, guild_id, discord_id, role_id, assigned_by, assigned_at

### 55.4 Auth Resolution (`rbac.ts`)

1. Get authenticated Supabase user → extract Discord ID from metadata
2. Check if user is guild owner → full access
3. Otherwise, look up `dashboard_user_roles` → aggregate permissions from all assigned roles
4. `requirePermission(perm)` throws if user lacks the required permission

### 55.5 API Routes

| Route | Methods | Permission Required |
|---|---|---|
| `/api/rbac/roles` | GET, POST, PATCH, DELETE | `dashboard.manage_team` |
| `/api/rbac/users` | GET, POST, DELETE | `dashboard.manage_team` |

System roles (owner) cannot be modified or deleted. Role creation validates: name (1-100 chars), permissions (max 100), priority (0-999).

### 55.6 Dashboard Page

`/settings/team` — two-tab interface:
- **Members tab**: List team members with their roles, add member (by Discord ID + role), remove assignments
- **Roles tab**: List roles with member counts, create custom roles with permission checkboxes, edit permissions, delete non-system roles

---

## 56. Customer Portal

A customer-facing area of the dashboard where buyers can view their orders, manage licenses, and download purchased products. Separate from the guild-owner dashboard auth.

### 56.1 Authentication

- **Login flow**: Discord OAuth2 → exchange code for access token → fetch `/users/@me` → match `discord_id` against `customers` table
- **Session storage**: `portal_sessions` table with SHA-256 hashed token, 7-day expiry (V53-I4), IP address, user agent, revoke flag
- **Token delivery**: Raw token returned to frontend, included as `x-portal-token` header on subsequent requests
- **Session validation**: GET `/api/portal/auth` checks token hash, expiry, and revoked flag; updates `last_used_at`

### 56.2 Portal Pages

| Page | Route | Data |
|---|---|---|
| **Dashboard** | `/portal` | Overview of customer's account |
| **Orders** | `/portal/orders` | Purchase history with order details, payment status |
| **Licenses** | `/portal/licenses` | License keys with product info, active sessions (device name, fingerprint, IP, last seen) |
| **Downloads** | `/portal/downloads` | Entitled product files, grouped by product |

### 56.3 Portal API Routes

| Route | Auth | Data Source |
|---|---|---|
| `/api/portal/auth` (POST) | Discord OAuth code | `customers` → `portal_sessions` |
| `/api/portal/auth` (GET) | `x-portal-token` | Session validation |
| `/api/portal/orders` | `x-portal-token` | `orders` + `products` + `payments` |
| `/api/portal/licenses` | `x-portal-token` | `license_keys` + `products` + `license_sessions` |
| `/api/portal/downloads` | `x-portal-token` | `entitlements` + `products` + `product_files` |

All portal API routes resolve the customer via token → session lookup, scoping all queries to that customer's ID.

### 56.4 Layout

The portal uses a dedicated layout (`/portal/layout.tsx`) separate from the guild-owner dashboard, with portal-specific navigation (Orders, Licenses, Downloads).

---

*This document is the single source of truth for SomniBot's architecture. No feature described here is optional, an MVP, or a placeholder. Every feature is production-grade. Every feature connects to the platform through the event bus and automation engine. Same behavior on local machines and VPS. If a limitation is discovered during implementation, it will be surfaced immediately with the exact constraint, impact, and best production workaround.*
