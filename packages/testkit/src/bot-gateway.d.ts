/**
 * Ambient typing for the exported GATEWAY-EVENT handlers testkit drives from
 * @somnibot/bot's compiled output (events/handler.ts).
 *
 * Like bot-dispatcher.d.ts (which types the exported `handleInteraction`), this
 * types the exported `handle<Event>Event` functions that mirror it: each is the
 * awaitable extraction of the corresponding inline `registerEvents` handler, so
 * the loopback harness can drive the exact production gateway pipeline with a
 * synthetic payload and await the DB effect. @somnibot/bot ships no `.d.ts`
 * (declaration: false), so this ambient declaration supplies the signatures.
 *
 * Only `handleMessageCreateEvent` is consumed today (message-XP / chat-income /
 * achievements-announce accrual); the remaining handlers are declared so the
 * follow-on gateway slices (welcome, starboard, reaction-roles, voice) need no
 * edit here.
 */
declare module '@somnibot/bot/dist/events/handler.js' {
  import type {
    GuildMember,
    PartialGuildMember,
    Message,
    MessageReaction,
    PartialMessageReaction,
    User,
    PartialUser,
    VoiceState,
  } from 'discord.js';

  export function handleMessageCreateEvent(message: Message, client: unknown): Promise<void>;
  export function handleGuildMemberAddEvent(member: GuildMember, client: unknown): Promise<void>;
  export function handleGuildMemberRemoveEvent(
    member: GuildMember | PartialGuildMember,
    client: unknown,
  ): Promise<void>;
  export function handleMessageReactionAddEvent(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    client: unknown,
  ): Promise<void>;
  export function handleMessageReactionRemoveEvent(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    client: unknown,
  ): Promise<void>;
  export function handleVoiceStateUpdateEvent(
    oldState: VoiceState,
    newState: VoiceState,
    client: unknown,
  ): Promise<void>;
}
