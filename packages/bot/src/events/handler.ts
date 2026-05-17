import type { SomniClient } from '../client.js';
import {
  handleMemberJoin,
  handleMemberUpdate,
  handleMemberLeave,
} from '../features/welcome/index.js';
import { processMessage, expireInfractions } from '../features/moderation/index.js';
import { handleTicketInteraction, handleTicketCommand } from '../features/tickets/index.js';
import {
  handleRoleCreate,
  handleRoleUpdate,
  handleRoleDelete,
} from '../sync/role-events.js';
import {
  handleChannelCreate,
  handleChannelUpdate,
  handleChannelDelete,
} from '../sync/channel-events.js';
import {
  processMessageXp,
  handleLevelUp,
} from '../features/levels/index.js';
import { onVoiceStateUpdate } from '../features/levels/voice-xp.js';
import {
  handleReactionAdd,
  handleReactionRemove,
} from '../features/reaction-roles/index.js';
import { handleCustomCommand, isCustomCommand } from '../features/custom-commands/index.js';
import type { EscalationStep } from '@somnibot/shared';

/**
 * Register all Discord gateway event listeners.
 * Phase 1: bot-role guard, basic logging.
 * Phase 4: onboarding detection, welcome/goodbye flows.
 * Phase 8: Automation engine event wiring.
 * Phase 9: Levels/XP, reaction roles, custom commands.
 */
export function registerEvents(client: SomniClient): void {
  // ── Ready ──────────────────────────────────────────────
  client.once('ready', async (readyClient) => {
    console.log(`[Bot] Logged in as ${readyClient.user.tag}`);
    console.log(`[Bot] Guild: ${client.guildId}`);
    console.log(`[Bot] Gateway: ${readyClient.ws.ping}ms`);

    const guild = readyClient.guilds.cache.get(client.guildId);
    if (guild) {
      const botMember = guild.members.me;
      if (botMember) {
        const highestRole = botMember.roles.highest;
        console.log(`[Bot] Highest role: "${highestRole.name}" (position ${highestRole.position})`);

        const sortedRoles = [...guild.roles.cache.values()]
          .sort((a, b) => b.position - a.position);

        const isTopRole = sortedRoles[0]?.id === highestRole.id ||
          (sortedRoles[0]?.managed && sortedRoles[1]?.id === highestRole.id);

        if (!isTopRole) {
          console.warn('[Bot] ⚠️  Bot role is NOT in the #1 position. Features will be locked.');
        } else {
          console.log('[Bot] ✅ Bot role is in the correct position');
        }
      }
    }
  });

  // ── Guild Member Events (Phase 4: Onboarding + Welcome + Goodbye) ──
  client.on('guildMemberAdd', async (member) => {
    await handleMemberJoin(client, member);
  });

  client.on('guildMemberRemove', async (member) => {
    await handleMemberLeave(client, member);
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    await handleMemberUpdate(client, oldMember, newMember);
  });

  // ── Role Events (Phase 5: Drift Detection) ─────────────
  client.on('roleCreate', async (role) => {
    await handleRoleCreate(client, role);
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    await handleRoleUpdate(client, oldRole, newRole);
  });

  client.on('roleDelete', async (role) => {
    await handleRoleDelete(client, role);
  });

  // ── Channel Events (Phase 5: Drift Detection) ─────────
  client.on('channelCreate', async (channel) => {
    if (!('guild' in channel)) return;
    await handleChannelCreate(client, channel);
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!('guild' in newChannel)) return;
    await handleChannelUpdate(client, oldChannel as typeof newChannel, newChannel);
  });

  client.on('channelDelete', async (channel) => {
    if (!('guild' in channel)) return;
    await handleChannelDelete(client, channel);
  });

  // ── Message Events (Phase 6: Auto-Mod + Phase 8: Automations + Phase 9: XP) ──
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.guild?.id !== client.guildId) return;

    // Auto-mod pipeline — runs before any other message processing
    try {
      const modConfig = await loadModConfig(client);
      const handled = await processMessage(client, message, modConfig);
      if (handled) return; // Message was deleted/actioned by auto-mod
    } catch (err) {
      console.error('[Events] Auto-mod error:', err);
    }

    // Phase 8: Emit message.sent event for automations
    const messageEvent = {
      type: 'message.sent' as const,
      guildId: client.guildId,
      timestamp: Date.now(),
      data: {
        discordId: message.author.id,
        username: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
        content: message.content,
      },
    };

    // Process via automation engine directly (needs Message object for reply/react/delete actions)
    const engine = (client as unknown as Record<string, unknown>)._automationEngine as
      | import('../features/automations/automation-engine.js').AutomationEngine
      | undefined;
    if (engine) {
      engine.processMessageEvent(messageEvent, message).catch((err) => {
        console.error('[Events] Automation message processing error:', err);
      });
    }

    // Phase 9: XP processing
    try {
      const xpResult = await processMessageXp(
        message,
        client.supabase,
        client.valkey,
        client.guildId,
      );

      if (xpResult.leveledUp && xpResult.newLevel != null && xpResult.oldLevel != null && xpResult.newXp != null) {
        const guild = message.guild;
        if (guild) {
          await handleLevelUp(
            guild,
            client.supabase,
            client.eventBus,
            message.author.id,
            xpResult.oldLevel,
            xpResult.newLevel,
            xpResult.newXp,
          );
        }
      }
    } catch (err) {
      console.error('[Events] XP processing error:', err);
    }
  });

  // ── Reaction Events (Phase 8: Automations + Phase 9: Reaction Roles) ────────────
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    const message = reaction.message;
    if (message.guild?.id !== client.guildId) return;

    // Phase 9: Reaction roles (check first — higher priority)
    const guild = message.guild;
    if (guild) {
      try {
        const handled = await handleReactionAdd(
          reaction,
          user,
          guild,
          client.supabase,
          client.valkey,
          client.eventBus,
        );
        if (handled) return; // Was a reaction role interaction
      } catch (err) {
        console.error('[Events] Reaction role add error:', err);
      }
    }

    // Emit reaction.added event for automations
    const reactionEvent = {
      type: 'reaction.added' as const,
      guildId: client.guildId,
      timestamp: Date.now(),
      data: {
        discordId: user.id,
        username: user.username ?? user.id,
        emoji: reaction.emoji.name ?? reaction.emoji.toString(),
        channelId: message.channel.id,
        messageId: message.id,
      },
    };

    // Fetch full message if partial
    const fullMessage = reaction.message.partial
      ? await reaction.message.fetch().catch(() => null)
      : reaction.message;

    if (fullMessage) {
      const engine = (client as unknown as Record<string, unknown>)._automationEngine as
        | import('../features/automations/automation-engine.js').AutomationEngine
        | undefined;
      if (engine) {
        engine.processReactionEvent(reactionEvent, fullMessage).catch((err) => {
          console.error('[Events] Automation reaction processing error:', err);
        });
      }
    }

    // Also emit to event bus for non-message automations
    client.eventBus.emit('reaction.added', client.guildId, reactionEvent.data);
  });

  // Phase 9: Reaction role remove
  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    const message = reaction.message;
    if (message.guild?.id !== client.guildId) return;

    const guild = message.guild;
    if (guild) {
      try {
        await handleReactionRemove(
          reaction,
          user,
          guild,
          client.supabase,
          client.valkey,
          client.eventBus,
        );
      } catch (err) {
        console.error('[Events] Reaction role remove error:', err);
      }
    }
  });

  // ── Voice State (Phase 8: Automations + Phase 9: Voice XP + future Music/Temp Channels) ──
  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.guild.id !== client.guildId) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    // Phase 9: Track voice state for voice XP
    onVoiceStateUpdate(oldState, newState);

    // Joined a voice channel
    if (!oldState.channelId && newState.channelId) {
      client.eventBus.emit('voice.joined', client.guildId, {
        discordId: member.id,
        username: member.user.username,
        channelId: newState.channelId,
        channelName: newState.channel?.name ?? '',
      });
    }

    // Left a voice channel
    if (oldState.channelId && !newState.channelId) {
      client.eventBus.emit('voice.left', client.guildId, {
        discordId: member.id,
        username: member.user.username,
        channelId: oldState.channelId,
        channelName: oldState.channel?.name ?? '',
      });
    }

    // Moved between channels (emit both left and joined)
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      client.eventBus.emit('voice.left', client.guildId, {
        discordId: member.id,
        username: member.user.username,
        channelId: oldState.channelId,
        channelName: oldState.channel?.name ?? '',
      });
      client.eventBus.emit('voice.joined', client.guildId, {
        discordId: member.id,
        username: member.user.username,
        channelId: newState.channelId,
        channelName: newState.channel?.name ?? '',
      });
    }
  });

  // ── Interaction Handler (Phase 7: Tickets + Phase 8: Button automations + Phase 9: Commands) ──
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild || interaction.guild.id !== client.guildId) return;

    try {
      // Handle ticket button/dropdown interactions
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const handled = await handleTicketInteraction(interaction, client);
        if (handled) return;

        // Phase 8: Emit button.clicked event for automations
        if (interaction.isButton()) {
          client.eventBus.emit('button.clicked', client.guildId, {
            discordId: interaction.user.id,
            username: interaction.user.username,
            buttonId: interaction.customId,
            channelId: interaction.channelId ?? '',
            messageId: interaction.message?.id ?? '',
          });
        }
      }

      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        // Phase 7: Ticket commands
        if (interaction.commandName === 'ticket') {
          await handleTicketCommand(interaction, client);
          return;
        }

        // Phase 9: Level commands
        if (interaction.commandName === 'rank') {
          const { handleRankCommand } = await import('../features/levels/commands.js');
          await handleRankCommand(interaction, client);
          return;
        }

        if (interaction.commandName === 'leaderboard') {
          const { handleLeaderboardCommand } = await import('../features/levels/commands.js');
          await handleLeaderboardCommand(interaction, client);
          return;
        }

        // Phase 9: Custom commands (check registry)
        if (isCustomCommand(interaction.commandName)) {
          await handleCustomCommand(
            interaction,
            client.supabase,
            client.valkey,
            interaction.guild,
          );
          return;
        }
      }
    } catch (err) {
      console.error('[Events] Interaction handler error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
        }
      } catch {
        // Ignore reply failures
      }
    }
  });

  // ── Error Handling ─────────────────────────────────────
  client.on('error', (error) => {
    console.error('[Bot] Client error:', error);
  });

  client.on('warn', (info) => {
    console.warn('[Bot] Warning:', info);
  });

  process.on('unhandledRejection', (error) => {
    console.error('[Bot] Unhandled rejection:', error);
  });

  // ── Infraction Expiry Cron (every 15 minutes) ─────────
  setInterval(async () => {
    try {
      await expireInfractions(client.supabase, client.guildId);
    } catch (err) {
      console.error('[Events] Infraction expiry error:', err);
    }
  }, 15 * 60 * 1000);
}

// ── Helpers ───────────────────────────────────────────────

/** Cached moderation config to avoid DB hits per message. */
let _modConfigCache: {
  escalationChain: EscalationStep[];
  infractionExpiryDays: number;
  modLogChannelId: string | null;
} | null = null;
let _modConfigCacheTime = 0;
const MOD_CONFIG_TTL = 60_000; // 1 minute

async function loadModConfig(client: SomniClient): Promise<{
  escalationChain: EscalationStep[];
  infractionExpiryDays: number;
  modLogChannelId: string | null;
}> {
  const now = Date.now();
  if (_modConfigCache && now - _modConfigCacheTime < MOD_CONFIG_TTL) {
    return _modConfigCache;
  }

  const { data } = await client.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  _modConfigCache = {
    escalationChain: Array.isArray(data?.escalation_chain)
      ? (data.escalation_chain as EscalationStep[])
      : [],
    infractionExpiryDays: (data?.infraction_expiry_days as number) ?? 30,
    modLogChannelId: (data?.mod_log_channel_id as string) ?? null,
  };
  _modConfigCacheTime = now;

  return _modConfigCache;
}
