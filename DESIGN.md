# SomniBot dashboard design and operator UX contract

This is the implementation contract for dashboard hardening. It codifies the
existing Discord-dark system; it does not authorize a visual redesign. New or
changed dashboard work must follow it, and must not claim a capability or
successful mutation that the authoritative service has not confirmed.

## Purpose and prerequisites

The dashboard lets an authorized operator configure and observe one selected
Discord server and its SomniBot integrations. Every operator surface must say:

- what it changes or observes, in plain language;
- the selected server/context and the prerequisite integration, permission, or
  connection it needs; and
- what to do when that prerequisite is absent or unhealthy.

Use human-readable names first: server, channel, role, member, product, and
action names. Show an ID only as secondary diagnostic detail, never as the sole
way to identify a target; make it copyable when it is useful for support.

Keep coin-economy actions and real-money-store actions visibly distinct. The
navigation's `Coin economy` and `Real-money store` groups are intentional
operator safety labels, not interchangeable categories.

The cross-surface terminology and status vocabulary is exported from
`packages/shared/src/experience/language-system.ts`. Operator copy says
`server`; `guild` is reserved for diagnostics and API contracts. Use the
canonical status labels instead of inventing synonyms such as `okay`, `down`,
or `broken`, and always pair severity color with the status label and a
supported action when `actionRequired` is true.

## Tokens

Use the existing `discord` Tailwind tokens and matching CSS variables. Do not
introduce an alternate dark palette or use a Somni brand color as the general
interactive color.

| Role | Token / value |
| --- | --- |
| app shell | `discord-bg-tertiary` / `#1e1f22` |
| sidebar | `discord-bg-secondary` / `#2b2d31` |
| content | `discord-bg-primary` / `#313338` |
| card elevation | `discord-bg-elevated` / `#383a40` |
| floating surface | `discord-bg-floating` / `#111214` |
| hover / selected | `discord-bg-hover` / `#35373c`; `discord-bg-active` / `#404249` |
| primary / secondary / muted text | `#f2f3f5`; `#b5bac1`; `#949ba4` |
| primary action and focus | `discord-accent` / `#5865f2`; hover `#4752c4` |
| semantic success / danger / warning | `#23a559`; `#f23f43`; `#f0b232` |
| borders | `discord-border-subtle` / `#3f4147`; `discord-border-strong` / `#4e5058` |
| brand mark only | `somni-pink` `#FF1493`, `somni-cyan` `#00D4FF`, `somni-orange` `#FF6B00` |

Blurple is the action, link, focus, and selected-navigation color. Somni brand
accents are reserved for identity or clearly labeled metadata, not a competing
button system. Semantic color always needs a text/icon/state cue as well.

## Typography

Use the global stack: `gg sans`, `Noto Sans`, `Helvetica Neue`, Helvetica,
Arial, sans-serif. Body copy is normally `text-sm`; supporting copy is
`text-xs text-discord-text-muted`; page titles use `text-xl` or `text-2xl`.
Card and section titles use `font-medium` rather than heavy display styling.
Uppercase, tracked `text-[10px]`/`text-[11px]` is reserved for compact labels,
badges, and sidebar group headings. Use monospace only for IDs, commands,
timestamps, and other diagnostic values.

## Spacing and layout

Use Tailwind's existing spacing scale and keep the recurring rhythm: controls
and list rows use 8px-class heights/gaps, forms use `space-y-1` for a label and
field and wider section gaps, and cards use `p-5` (or `p-6` where a page already
uses it). Do not introduce a second spacing scale.

The desktop shell retains the 15rem (`w-60`) sidebar, 3.5rem (`h-14`) brand row,
scrolling navigation, and the content pane on the primary tier. Page content is
centered with a page-appropriate existing `max-w-*` and normally `p-6`; dense
operator tables may use the available width rather than fabricate narrow cards.

Use `rounded-input` (8px) for controls, `rounded-card` (12px) for cards, and
`rounded-panel` (16px) for larger panels. A default `Card` uses the elevated
surface with no decorative border; status cards use their semantic tinted
border/background. Use subtle/strong border tokens to divide surfaces, not
shadows as a substitute for the elevation ladder.

## Materials and depth

Depth comes from the ordered background tiers: tertiary shell, secondary
sidebar, primary content, elevated card, then floating overlay. Dialogs may use
the existing dark translucent backdrop and blur; floating status/toast surfaces
may use a restrained shadow. Do not flatten an elevated card into the sidebar
color, or stack gradients, glows, and heavy shadows on ordinary controls.

## Primitives and states

Use the shared primitives where they fit:

- `Button`: `primary`, `secondary`, `danger`, `success`, or `ghost`, with the
  existing `sm`/`md`/`lg` 32/38/44px control heights. Disabled means visibly
  unavailable and non-actionable, with the reason nearby when it is not obvious.
- `Input`/`Select`/`Toggle`: visible label, concise help where needed, clear
  focus state, and a field-local error adjacent to the field. Never rely only
  on a generic page error to explain a validation failure.
- `ChannelPicker`: a labelled native disclosure controlling a searchable
  listbox. Clear/remove actions are sibling buttons rather than nested
  controls; hint and field errors are referenced by the trigger; Arrow keys,
  Home/End, Escape, and focus return remain available from the keyboard.
- `Card`, `Badge`, `EmptyState`, loading skeleton, error boundary, and toast:
  use their semantic variants; loading, empty, error, and successful states are
  distinct states rather than a blank region or a permanently spinning action.
- `ConfirmDialog`: required before a destructive, irreversible, or
  high-impact change. State the target, consequence, and reversibility; label
  the action precisely (for example, `Delete giveaway`, not `Confirm`). Start
  on the safe/cancel action and retain an escape route.

For non-trivial mutations, stage the flow deliberately: describe the target and
effect, collect and validate edits, then expose an explicit Save/Apply/Repair
action. Keep test/send-preview actions separate from persistent Apply actions.
On completion, read the authoritative returned or freshly reloaded state and
show that readback (including relevant target and time), not only an optimistic
toast. If a request is pending, say what is pending; if it fails, preserve the
operator's input where safe and offer a retry or a clear recovery path.

Live status is truthful: display the observed state, source, and last checked
time when it can become stale. Do not label polling, cached data, a queued job,
or an unverified local save as `live`, `synced`, or `complete`. Status surfaces
must distinguish unknown/loading, healthy, degraded, failed, and stale states.

Every configuration feature needs an operator-facing test or recovery path:
show how to send a safe test/preview when the feature supports one, show its
outcome and destination, and link or name the retry/diagnostics path when it
does not. The recovery path must not require the operator to infer an internal
ID or use a developer-only command.

## Motion and reduced motion

The default interaction duration is `transition-standard` (150ms). Motion may
clarify a state change (sidebar collapse, focus, progress, dialog/toast entry),
but never be the only indication of it. New animation must have a
`prefers-reduced-motion: reduce` equivalent that removes non-essential
transforms, pulses, spins, and delayed entrances while preserving final state
and status text.

## Responsive behavior

Treat the fixed desktop sidebar as the wide-screen pattern, not the mobile
answer. At narrow widths, preserve a clear route to navigation and the selected
server; do not let controls, tables, or mutation actions fall off-screen. Forms
stack rather than compress into unreadable columns, action rows wrap with the
destructive action still identifiable, and overlays retain padding and a
scrollable body. Preserve labels and status text rather than replacing them
with unlabeled icons.

## Accessibility

Keyboard and screen-reader behavior is part of done:

- Use native buttons, links, labels, inputs, and headings first. Icon-only
  controls require an accessible name.
- All controls are reachable in a logical order; `:focus-visible` has the
  global blurple 2px outline and components must not remove it without an
  equally visible replacement.
- Inputs expose invalid state and associate help/error text programmatically;
  error summaries move focus or provide links when a form has multiple errors.
- Dialogs are modal, announce title and consequence, trap focus while open,
  restore focus on close, support Escape unless an operation is genuinely
  non-cancellable, and default destructive confirmations to Cancel.
- Announce asynchronous result, error, and recovery messages in an appropriate
  live region. Do not encode meaning only by color, opacity, or animation.
- Respect reduced-motion preferences and maintain readable contrast on every
  token/semantic state.

## Accepted debt and hardening order

This document records current debt; it does not waive the contract for new
work.

1. The palette exists in both `globals.css` CSS variables and
   `tailwind.config.ts`; the values must stay synchronized until a deliberate
   single-source migration is approved.
2. Shared primitives are available but not every route uses them. Some pages
   still use raw Tailwind greys/reds and direct pink controls, so token and
   primitive adoption is an incremental hardening task.
3. The application shell currently has a fixed `w-60` sidebar with no defined
   narrow-screen navigation treatment. Existing isolated responsive layouts do
   not satisfy the shell-level mobile contract.

The shared Input, confirmation dialog, loading/empty states, error boundary,
and dashboard-wide reduced-motion override now form the accessibility baseline.
Their semantic relationships, focus behavior, live regions, and motion fallback
are regression contracts; route-specific components must not bypass them.

Hardening work should close those gaps through shared primitives and shell
behavior before adding route-specific visual variants.

## Source boundary

This contract is grounded in `packages/dashboard/src/styles/globals.css`,
`packages/dashboard/tailwind.config.ts`, and the shared primitives under
`packages/dashboard/src/components/shared/`; the desktop navigation and its
operator labels are in `components/layout/sidebar.tsx`. It intentionally does
not change code, dependencies, routes, or runtime behavior.
