/**
 * gateway-builders — typed factories for synthetic-but-real discord.js-shaped
 * GATEWAY EVENT payloads (Message, …), the counterpart to interaction-builders.
 *
 * Where interaction-builders produces the `Interaction` objects the dispatcher
 * consumes, these produce the gateway-event payloads the exported per-event
 * handlers in `@somnibot/bot/dist/events/handler.js` consume
 * (`handleMessageCreateEvent(message, client)` etc). Each builder returns a plain
 * object that carries exactly the keys the real handler + its downstream feature
 * pipeline read, so the production path runs unchanged against the live stack.
 *
 * Fidelity note: the object is a STRUCTURAL stand-in cast to discord.js's real
 * type at the injection boundary (mirroring interaction-builders). It models only
 * the surface the handlers touch — for `messageCreate` that is
 * `message.{id, content, author.{id,username,bot}, guild.id, guildId, channel.{id,
 * isTextBased(),send()}, channelId, member.roles.cache.{has(),map()}}`. Anything a
 * handler does NOT read is deliberately absent so drift (a handler reaching for a
 * new field) surfaces as an error rather than a silent stub.
 */

// ── Message ────────────────────────────────────────────────────────────────

/** A captured `channel.send(...)` payload from a driven gateway event (e.g. an
 *  achievement-unlock or level-up announcement). Real handlers post these
 *  fire-and-forget; capturing them in-process lets a proof assert the announce
 *  content without a live gateway. */
export interface GatewaySend {
  readonly payload: unknown;
}

/** The member-roles cache stand-in: the `.has()` + `.map()` surface the XP
 *  tracker and automod exemption checks read. */
interface SyntheticRoleCache {
  has(roleId: string): boolean;
  map<T>(fn: (role: { id: string }) => T): T[];
  readonly size: number;
}

export interface SyntheticMessageChannel {
  id: string;
  isTextBased(): boolean;
  send(payload: unknown): Promise<{ id: string }>;
}

export interface SyntheticMessageAuthor {
  id: string;
  username: string;
  bot: boolean;
}

export interface SyntheticMessageMember {
  id: string;
  roles: { cache: SyntheticRoleCache };
}

export interface SyntheticMessageGuild {
  id: string;
  name: string;
  members: { cache: { get(id: string): unknown; size: number } };
}

export interface SyntheticMessage {
  id: string;
  content: string;
  author: SyntheticMessageAuthor;
  guild: SyntheticMessageGuild | null;
  guildId: string | null;
  channel: SyntheticMessageChannel;
  channelId: string;
  member: SyntheticMessageMember | null;
  /** Every `channel.send(...)` the driven pipeline made, in call order. */
  readonly sent: readonly GatewaySend[];
}

export interface BuildMessageParams {
  /** Guild the message was sent in (the booted handle's guild id). */
  guildId: string;
  /** Author's Discord id (run-prefixed by the caller for sweepable isolation). */
  userId: string;
  /** Author username (defaults to the userId). */
  username?: string;
  /** Channel id the message was sent in. */
  channelId?: string;
  /** Message text (defaults to a benign non-empty string). */
  content?: string;
  /** Role ids the author holds (drives no-XP-role + multiplier + automod exempt). */
  memberRoleIds?: string[];
  /** Whether the author is a bot (the handler drops bot messages — default false). */
  bot?: boolean;
  /** Override the message id (defaults to a generated value). */
  id?: string;
}

const DEFAULT_MSG_CHANNEL_ID = '222222222222222222';

let msgIdCounter = 0;
function nextMsgId(): string {
  msgIdCounter += 1;
  return `synthetic-message-${msgIdCounter}`;
}

function makeRoleCache(ids: string[]): SyntheticRoleCache {
  return {
    has: (roleId: string) => ids.includes(roleId),
    map: <T>(fn: (role: { id: string }) => T): T[] => ids.map((id) => fn({ id })),
    get size() {
      return ids.length;
    },
  };
}

/**
 * Build a synthetic `messageCreate` payload. The returned object exposes a live
 * `sent` array that captures any `channel.send(...)` the driven pipeline makes
 * (level-up / achievement announcements), so a proof can assert the announcement
 * in-process without a live gateway.
 */
export function buildSyntheticMessage(params: BuildMessageParams): SyntheticMessage {
  const channelId = params.channelId ?? DEFAULT_MSG_CHANNEL_ID;
  const username = params.username ?? params.userId;
  const roleIds = params.memberRoleIds ?? [];
  const sent: GatewaySend[] = [];

  const author: SyntheticMessageAuthor = {
    id: params.userId,
    username,
    bot: params.bot ?? false,
  };

  const member: SyntheticMessageMember = {
    id: params.userId,
    roles: { cache: makeRoleCache(roleIds) },
  };

  const channel: SyntheticMessageChannel = {
    id: channelId,
    isTextBased: () => true,
    send: async (payload: unknown) => {
      sent.push({ payload });
      return { id: `synthetic-sent-${sent.length}` };
    },
  };

  return {
    id: params.id ?? nextMsgId(),
    content: params.content ?? 'hello world',
    author,
    guild: {
      id: params.guildId,
      name: 'Synthetic Guild',
      members: { cache: { get: () => member, size: 1 } },
    },
    guildId: params.guildId,
    channel,
    channelId,
    member,
    sent,
  };
}
