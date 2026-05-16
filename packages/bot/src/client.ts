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

/**
 * SomniClient — extends discord.js Client with platform infrastructure.
 *
 * Provides:
 * - Shoukaku (Lavalink music)
 * - Supabase (database)
 * - Valkey (cache)
 * - Platform event bus
 * - Guild ID (single-guild architecture)
 */
export class SomniClient extends Client {
  public readonly shoukaku: Shoukaku;
  public readonly supabase: SupabaseClient;
  public readonly valkey: Valkey;
  public readonly eventBus = eventBus;
  public readonly guildId: string;
  public readonly env: BotEnv;

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
    this.guildId = env.DISCORD_GUILD_ID;
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
      console.log(`[Shoukaku] Node "${name}" connected`);
    });

    this.shoukaku.on('error', (name, error) => {
      console.error(`[Shoukaku] Node "${name}" error:`, error);
    });

    this.shoukaku.on('close', (name, code, reason) => {
      console.warn(`[Shoukaku] Node "${name}" closed: ${code} — ${reason}`);
    });

    this.shoukaku.on('disconnect', (name, players, moved) => {
      if (moved) return;
      console.warn(`[Shoukaku] Node "${name}" disconnected, ${players.size} players affected`);
    });
  }
}
