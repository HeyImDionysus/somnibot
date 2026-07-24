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
  /**
   * True while the bot is running in setup-verification mode (gate
   * 'in_progress'): logged in only so the setup wizard can confirm it is
   * online, with the heavy per-guild feature init deliberately skipped.
   *
   * Normal Discord event handlers (member joins, messages, reactions, etc.)
   * MUST bail out while this is set — the GuildRouter is an empty placeholder
   * and guild_config rows do not exist yet, so running feature pipelines only
   * produces the pre-setup error noise the gate exists to suppress. The boot
   * sequence clears this flag right before it runs the full boot.
   */
  public setupVerificationMode = false;

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

    // Initialize Shoukaku (Lavalink connector).
    // Music is OPTIONAL: Shoukaku rejects a node whose `auth` is empty
    // ("auth was not found from the given options"), and that rejection during
    // construction took down the whole boot — so an instance without Lavalink
    // configured could never start, even though every non-music feature works
    // fine without it. Register the node only when a password is actually set;
    // otherwise start with no nodes (music commands then report no available
    // node, and the existing lavalink_down alerting covers the degraded state).
    const lavalinkNodes = env.LAVALINK_PASSWORD
      ? [
          {
            name: 'main',
            url: `${env.LAVALINK_HOST}:${env.LAVALINK_PORT}`,
            auth: env.LAVALINK_PASSWORD,
          },
        ]
      : [];
    if (lavalinkNodes.length === 0) {
      log.warn('LAVALINK_PASSWORD not set — music playback disabled (all other features unaffected)');
    }
    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(this),
      lavalinkNodes,
      {
        moveOnDisconnect: false,
        resume: true,
        resumeTimeout: 30,
        // 5 tries x 5s gave only 25s of tolerance — shorter than a routine
        // Lavalink restart/upgrade, after which Shoukaku gave up permanently
        // and music stayed dead until the whole BOT was restarted (observed
        // live). 60 x 5s rides out a ~5 minute outage and self-heals instead.
        reconnectTries: 60,
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
