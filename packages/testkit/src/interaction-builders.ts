/**
 * interaction-builders — typed factories for synthetic-but-real discord.js-shaped
 * interactions, wired to a {@link CapturedResponse}.
 *
 * These are the productised, typed version of the ad-hoc `makeInteraction()`
 * helper in packages/bot/src/__tests__/handler-routing.test.ts. Each builder
 * returns a plain object that:
 *   - implements the discord.js `isX()` type-guards the real dispatcher consults
 *     (exactly one returns true; all others return false),
 *   - carries the keys the handlers read (`customId`, `commandName`, `values`,
 *     `options`, `fields`, `targetId`, guild/user/member/channel identity), and
 *   - delegates every response method to a CapturedResponse so the ephemeral
 *     reply bubble is recorded in-process.
 *
 * The object is a structural {@link SyntheticInteraction}; at the injection
 * boundary it is cast to discord.js's `Interaction` (the real `handleInteraction`
 * accepts `Interaction`). Keeping it structural here means testkit takes no
 * value-level dependency on discord.js internals.
 */

import { CapturedResponse } from './captured-response.js';

// ── Shared shapes ──────────────────────────────────────────────────────

export interface SyntheticUser {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  displayAvatarURL(): string;
}

export interface SyntheticGuild {
  id: string;
  name: string;
  /**
   * Minimal members-cache stand-in. Real handlers reach for
   * `guild.members.cache.get(id)`; returning undefined (member not cached) is a
   * valid, handled state that keeps them on their normal path without a live
   * gateway.
   */
  members: { cache: { get(id: string): unknown; size: number } };
}

/** A slash-command option value as supplied to a builder's `options` map. */
export type OptionValue = string | number | boolean | Record<string, unknown> | null;

/**
 * The subset of discord.js's ChatInputCommandInteraction option accessors that
 * the real handlers use, driven from a plain `{ name: value }` map. Unknown
 * options return null; a required getter for a missing option throws, matching
 * discord.js's `CommandInteractionOptionNotFound` behaviour.
 */
export interface SyntheticOptions {
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getNumber(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required?: boolean): unknown;
  getMember(name: string): unknown;
  getChannel(name: string, required?: boolean): unknown;
  getRole(name: string, required?: boolean): unknown;
  getMentionable(name: string, required?: boolean): unknown;
  getAttachment(name: string, required?: boolean): unknown;
  get(name: string, required?: boolean): { name: string; value: OptionValue } | null;
  getSubcommand(required?: boolean): string | null;
  getSubcommandGroup(required?: boolean): string | null;
  getFocused(getFull?: boolean): string | { name: string; value: string; focused: true };
}

/** The modal-fields accessor handlers use. */
export interface SyntheticFields {
  getTextInputValue(customId: string): string;
  getField(customId: string): { customId: string; value: string; type: number };
}

/**
 * A synthetic interaction: structurally compatible with the parts of discord.js's
 * `Interaction` the production dispatcher touches. Cast to `Interaction` at the
 * injection boundary.
 */
export interface SyntheticInteraction {
  id: string;
  applicationId: string;
  guild: SyntheticGuild | null;
  guildId: string | null;
  channelId: string | null;
  user: SyntheticUser;
  member: unknown;
  message: { id: string } | null;
  client: unknown;

  commandName: string;
  customId: string;
  values: string[];
  options: SyntheticOptions;
  fields: SyntheticFields;
  targetId: string | null;
  targetUser: unknown;
  targetMember: unknown;
  targetMessage: unknown;

  // discord.js type-guards
  isButton(): boolean;
  isStringSelectMenu(): boolean;
  isAnySelectMenu(): boolean;
  isModalSubmit(): boolean;
  isAutocomplete(): boolean;
  isCommand(): boolean;
  isChatInputCommand(): boolean;
  isContextMenuCommand(): boolean;
  isUserContextMenuCommand(): boolean;
  isMessageContextMenuCommand(): boolean;
  isRepliable(): boolean;

  // lifecycle flags (delegated to the recorder)
  readonly replied: boolean;
  readonly deferred: boolean;

  // response surface (delegated to the recorder)
  reply(payload?: unknown): Promise<unknown>;
  editReply(payload?: unknown): Promise<unknown>;
  deferReply(payload?: unknown): Promise<unknown>;
  deleteReply(): Promise<void>;
  followUp(payload?: unknown): Promise<unknown>;
  update(payload?: unknown): Promise<unknown>;
  deferUpdate(payload?: unknown): Promise<unknown>;
  showModal(payload?: unknown): Promise<void>;
  respond(payload?: unknown): Promise<void>;

  /** The recorder capturing this interaction's response effects. */
  readonly captured: CapturedResponse;
}

/** Fields every builder accepts to override the shared interaction identity. */
export interface BaseInteractionParams {
  guildId?: string;
  guildName?: string;
  channelId?: string;
  user?: Partial<SyntheticUser>;
  member?: unknown;
  messageId?: string;
  /** The SomniClient (or a stub). Defaults to `{}`. */
  client?: unknown;
  /** Share an existing recorder instead of creating a fresh one. */
  response?: CapturedResponse;
  /** Override the interaction id (defaults to a generated value). */
  id?: string;
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_GUILD_ID = '111111111111111111';
const DEFAULT_CHANNEL_ID = '222222222222222222';
const DEFAULT_USER_ID = '333333333333333333';

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeUser(overrides?: Partial<SyntheticUser>): SyntheticUser {
  const id = overrides?.id ?? DEFAULT_USER_ID;
  const username = overrides?.username ?? 'synthetic-user';
  return {
    id,
    username,
    displayName: overrides?.displayName ?? username,
    bot: overrides?.bot ?? false,
    displayAvatarURL: overrides?.displayAvatarURL ?? (() => 'https://cdn.example/avatar.png'),
  };
}

const GUARD_NAMES = [
  'isButton',
  'isStringSelectMenu',
  'isAnySelectMenu',
  'isModalSubmit',
  'isAutocomplete',
  'isCommand',
  'isChatInputCommand',
  'isContextMenuCommand',
  'isUserContextMenuCommand',
  'isMessageContextMenuCommand',
] as const;

type GuardName = (typeof GUARD_NAMES)[number];

/**
 * Build the shared skeleton every interaction kind reuses: identity fields, the
 * recorder-delegated response surface and lifecycle getters, and every type-guard
 * defaulting to false. The caller flips the guards that should be true.
 */
function makeBase(params: BaseInteractionParams, trueGuards: GuardName[]): SyntheticInteraction {
  const captured = params.response ?? new CapturedResponse();
  const user = makeUser(params.user);

  const guards = {} as Record<GuardName, () => boolean>;
  const trueSet = new Set<GuardName>(trueGuards);
  for (const name of GUARD_NAMES) {
    const value = trueSet.has(name);
    guards[name] = () => value;
  }

  const emptyOptions = makeOptions({});
  const emptyFields = makeFields({});

  const base: SyntheticInteraction = {
    id: params.id ?? nextId('interaction'),
    applicationId: 'app-synthetic',
    guild: {
      id: params.guildId ?? DEFAULT_GUILD_ID,
      name: params.guildName ?? 'Synthetic Guild',
      members: { cache: { get: () => undefined, size: 0 } },
    },
    guildId: params.guildId ?? DEFAULT_GUILD_ID,
    channelId: params.channelId ?? DEFAULT_CHANNEL_ID,
    user,
    member: params.member ?? { id: user.id, permissions: { has: () => true } },
    message: { id: params.messageId ?? nextId('message') },
    client: params.client ?? {},

    commandName: '',
    customId: '',
    values: [],
    options: emptyOptions,
    fields: emptyFields,
    targetId: null,
    targetUser: null,
    targetMember: null,
    targetMessage: null,

    ...guards,

    isRepliable: () => true,

    get replied() {
      return captured.replied;
    },
    get deferred() {
      return captured.deferred;
    },

    reply: (payload?: unknown) => captured.reply(payload),
    editReply: (payload?: unknown) => captured.editReply(payload),
    deferReply: (payload?: unknown) => captured.deferReply(payload),
    deleteReply: () => captured.deleteReply(),
    followUp: (payload?: unknown) => captured.followUp(payload),
    update: (payload?: unknown) => captured.update(payload),
    deferUpdate: (payload?: unknown) => captured.deferUpdate(payload),
    showModal: (payload?: unknown) => captured.showModal(payload),
    respond: (payload?: unknown) => captured.respond(payload),

    captured,
  } as SyntheticInteraction;

  return base;
}

// ── Options / fields accessors ─────────────────────────────────────────

export interface SlashExtras {
  subcommand?: string;
  subcommandGroup?: string | null;
  focused?: string | { name: string; value: string };
}

function optionNotFound(name: string): never {
  // Mirrors discord.js DiscordjsTypeError[CommandInteractionOptionNotFound].
  throw new Error(`CommandInteractionOptionNotFound: required option "${name}" not found`);
}

function makeOptions(map: Record<string, OptionValue>, extras: SlashExtras = {}): SyntheticOptions {
  const read = <T>(name: string, required?: boolean): T | null => {
    const value = map[name];
    if (value === undefined || value === null) {
      if (required) optionNotFound(name);
      return null;
    }
    return value as unknown as T;
  };

  return {
    getString: (name, required) => read<string>(name, required),
    getInteger: (name, required) => read<number>(name, required),
    getNumber: (name, required) => read<number>(name, required),
    getBoolean: (name, required) => read<boolean>(name, required),
    getUser: (name, required) => read<unknown>(name, required),
    getMember: (name) => read<unknown>(name, false),
    getChannel: (name, required) => read<unknown>(name, required),
    getRole: (name, required) => read<unknown>(name, required),
    getMentionable: (name, required) => read<unknown>(name, required),
    getAttachment: (name, required) => read<unknown>(name, required),
    get: (name, required) => {
      const value = map[name];
      if (value === undefined || value === null) {
        if (required) optionNotFound(name);
        return null;
      }
      return { name, value };
    },
    getSubcommand: (required = true) => {
      if (extras.subcommand === undefined) {
        if (required) throw new Error('CommandInteractionOptionNoSubcommand: no subcommand supplied');
        return null;
      }
      return extras.subcommand;
    },
    getSubcommandGroup: (required = false) => {
      if (extras.subcommandGroup === undefined || extras.subcommandGroup === null) {
        if (required) throw new Error('CommandInteractionOptionNoSubcommandGroup: no subcommand group supplied');
        return null;
      }
      return extras.subcommandGroup;
    },
    getFocused: (getFull = false) => {
      const f = extras.focused;
      if (f === undefined) return getFull ? { name: '', value: '', focused: true } : '';
      if (typeof f === 'string') return getFull ? { name: '', value: f, focused: true } : f;
      return getFull ? { name: f.name, value: f.value, focused: true } : f.value;
    },
  };
}

function makeFields(fields: Record<string, string>): SyntheticFields {
  return {
    getTextInputValue: (customId: string) => {
      const value = fields[customId];
      if (value === undefined) {
        // discord.js throws when the field id is absent from the submitted modal.
        throw new Error(`ModalSubmitFields: no text input value for "${customId}"`);
      }
      return value;
    },
    getField: (customId: string) => {
      const value = fields[customId];
      if (value === undefined) {
        throw new Error(`ModalSubmitFields: no field "${customId}"`);
      }
      return { customId, value, type: 4 };
    },
  };
}

// ── Slash command ──────────────────────────────────────────────────────

export interface BuildSlashParams extends BaseInteractionParams, SlashExtras {
  commandName: string;
  options?: Record<string, OptionValue>;
}

export function buildSlashInteraction(params: BuildSlashParams): SyntheticInteraction {
  const base = makeBase(params, ['isCommand', 'isChatInputCommand']);
  base.commandName = params.commandName;
  base.options = makeOptions(params.options ?? {}, {
    subcommand: params.subcommand,
    subcommandGroup: params.subcommandGroup,
    focused: params.focused,
  });
  return base;
}

// ── Button ─────────────────────────────────────────────────────────────

export interface BuildButtonParams extends BaseInteractionParams {
  customId: string;
}

export function buildButtonInteraction(params: BuildButtonParams): SyntheticInteraction {
  const base = makeBase(params, ['isButton']);
  base.customId = params.customId;
  return base;
}

// ── String select menu ─────────────────────────────────────────────────

export interface BuildSelectParams extends BaseInteractionParams {
  customId: string;
  values?: string[];
}

export function buildSelectInteraction(params: BuildSelectParams): SyntheticInteraction {
  const base = makeBase(params, ['isStringSelectMenu', 'isAnySelectMenu']);
  base.customId = params.customId;
  base.values = params.values ?? [];
  return base;
}

// ── Modal submit ───────────────────────────────────────────────────────

export interface BuildModalParams extends BaseInteractionParams {
  customId: string;
  fields?: Record<string, string>;
}

export function buildModalInteraction(params: BuildModalParams): SyntheticInteraction {
  const base = makeBase(params, ['isModalSubmit']);
  base.customId = params.customId;
  base.fields = makeFields(params.fields ?? {});
  return base;
}

// ── Autocomplete ───────────────────────────────────────────────────────

export interface BuildAutocompleteParams extends BaseInteractionParams {
  commandName: string;
  focused?: string | { name: string; value: string };
  options?: Record<string, OptionValue>;
  subcommand?: string;
}

export function buildAutocompleteInteraction(params: BuildAutocompleteParams): SyntheticInteraction {
  const base = makeBase(params, ['isAutocomplete']);
  base.commandName = params.commandName;
  base.options = makeOptions(params.options ?? {}, {
    subcommand: params.subcommand,
    focused: params.focused,
  });
  // discord.js's AutocompleteInteraction is NOT repliable: it exposes no reply()
  // and its isRepliable() returns false — the only acknowledgement is respond().
  // The dispatcher's error path reads isRepliable() to decide whether to reply,
  // so this must be false or the fallback would attempt an impossible reply().
  base.isRepliable = () => false;
  return base;
}

// ── Context menus ──────────────────────────────────────────────────────

export interface BuildContextMenuParams extends BaseInteractionParams {
  commandName: string;
  targetId?: string;
  targetUser?: unknown;
  targetMember?: unknown;
  targetMessage?: unknown;
}

export function buildUserContextMenuInteraction(params: BuildContextMenuParams): SyntheticInteraction {
  const base = makeBase(params, ['isCommand', 'isContextMenuCommand', 'isUserContextMenuCommand']);
  base.commandName = params.commandName;
  base.targetId = params.targetId ?? DEFAULT_USER_ID;
  base.targetUser = params.targetUser ?? makeUser({ id: base.targetId });
  base.targetMember = params.targetMember ?? { id: base.targetId };
  return base;
}

export function buildMessageContextMenuInteraction(params: BuildContextMenuParams): SyntheticInteraction {
  const base = makeBase(params, ['isCommand', 'isContextMenuCommand', 'isMessageContextMenuCommand']);
  base.commandName = params.commandName;
  base.targetId = params.targetId ?? nextId('target-message');
  base.targetMessage = params.targetMessage ?? {
    id: base.targetId,
    content: '',
    author: makeUser(),
    channel: { id: params.channelId ?? DEFAULT_CHANNEL_ID },
  };
  return base;
}
