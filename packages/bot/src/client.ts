import {
  Client,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
} from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import { getSupabase } from './services/supabase.js';
import { getValkey } from './services/valkey.js';
import { eventBus } from './services/event-bus.js';
import { getConfig, type BotEnv } from './config.js';
import { GuildRouter } from './guild-router.js';
import type { GuildContext } from './guild-context.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Client');

export function getPrimaryDiscordGuildId(discordGuildId: string): string {
  return discordGuildId
    .split(',')
    .map((part) => part.trim())
    .find(Boolean) ?? '';
}

/**
 * SomniClient — extends discord.js Client with platform infrastructure.
 *
 * Provides:
 * - Shoukaku (Lavalink music)
 * - Supabase (database)
 * - Valkey (cache)
 * - Platform event bus
 * - GuildRouter (multi-guild context management)
 * - guildId (primary guild — backwards compatible with single-guild usage)
 *
 * V53 Phase 4: Added GuildRouter for multi-guild support. `client.guildId`
 * remains for backwards compat (set to primary/first guild). New code should
 * use `client.router.getContext(guildId)` for guild-specific state.
 */
export class SomniClient extends Client {
  public readonly shoukaku: Shoukaku;
  public readonly supabase: SupabaseClient;
  public readonly valkey: Valkey;
  public readonly eventBus = eventBus;
  public guildId: string;
  public readonly env: BotEnv;
  public router!: GuildRouter;
  public _registeredCommands?: import('discord.js').RESTPostAPIApplicationCommandsJSONBody[];

  constructor() {
    const env = getConfig();

    const options: ClientOptions = {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.AutoModerationConfiguration,
        GatewayIntentBits.AutoModerationExecution,
      ],
      partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.GuildMember,
        Partials.User,
      ],
    };

    super(options);

    this.env = env;
    this.guildId = getPrimaryDiscordGuildId(env.DISCORD_GUILD_ID);
    this.supabase = getSupabase();
    this.valkey = getValkey();

    // Initialize Shoukaku (Lavalink connector)
    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(this),
      [
        {
          name: 'main',
          url: `${env.LAVALINK_HOST}:${env.LAVALINK_PORT}`,
          auth: env.LAVALINK_PASSWORD,
        },
      ],
      {
        moveOnDisconnect: false,
        resume: true,
        resumeTimeout: 30,
        reconnectTries: 5,
        reconnectInterval: 5000,
      },
    );

    this.shoukaku.on('ready', (name) => {
      log.info(`Node "${name}" connected`);
    });

    this.shoukaku.on('error', (name, error) => {
      log.error(`Node "${name}" error:`, error);
    });

    this.shoukaku.on('close', (name, code, reason) => {
      log.warn(`Node "${name}" closed: ${code} — ${reason}`);
    });

    this.shoukaku.on('disconnect', (name, count) => {
      log.warn(`Node "${name}" disconnected, ${count} player(s) affected`);
    });
  }
}
