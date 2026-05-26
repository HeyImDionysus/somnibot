import { EmbedBuilder } from 'discord.js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import {
  handleMemberJoin,
  handleMemberUpdate,
  handleMemberLeave,
} from '../features/welcome/index.js';
import { processMessage, expireInfractions } from '../features/moderation/index.js';
import {
  handleWarnCommand,
  handleMuteCommand,
  handleKickCommand,
  handleBanCommand,
  handlePardonCommand,
  handleInfractionsCommand,
} from '../features/moderation/commands.js';
import { handleHelpCommand, handleHelpCategorySelect } from '../features/help/index.js';
import { handleForgetMeCommand } from '../features/privacy/forgetme-command.js';
import { handlePrivacyCommand } from '../features/privacy/privacy-command.js';
import { handleMyDataCommand } from '../features/account/mydata-command.js';
import { handleTutorialCommand } from '../features/tutorial/tutorial-command.js';
import {
  handleViewProfile,
  handleWarnUser,
  handleViewPurchases,
  handleCreateTicketFromMessage,
  handleReportMessage,
} from '../features/discord-ux/index.js';
import { handleModalSubmit } from '../features/discord-ux/modal-handlers.js';
import { handleAutocomplete } from '../features/discord-ux/autocomplete.js';
import { handleTicketInteraction, handleTicketCommand, checkInactiveTickets } from '../features/tickets/index.js';
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
import { handleVoiceStateForTempChannels } from '../features/temp-channels/index.js';
import { handleTempChannelCommand } from '../features/temp-channels/commands.js';
import type { TempChannelManager } from '../features/temp-channels/temp-channel-manager.js';
import type { GiveawayManager } from '../features/giveaways/giveaway-manager.js';
import { handleGiveawayCommand } from '../features/giveaways/commands.js';
import type { MusicPlayerManager } from '../features/music/music-player.js';
import { handleMusicCommand } from '../features/music/commands.js';
import { handleStoreCommand } from '../features/commerce/store-command.js';
import { handleLicenseCommand } from '../features/commerce/license-commands.js';
import { handleBuyButton } from '../features/commerce/payment-handler.js';
import {
  handleSetupCommand,
  handleSetupButton,
  handleSetupModal,
  handleReconfigureSelect,
} from '../features/setup-wizard/index.js';
import type { EscalationStep } from '@somnibot/shared';
import { processAntiRaid } from '../features/anti-raid/index.js';
import { handleStarboardReaction } from '../features/starboard/index.js';
import { logMessageEdit, logMessageDelete } from '../features/message-log/index.js';
import { handleXpAdminCommand } from '../features/levels/admin-commands.js';
import { handlePurgeCommand } from '../features/moderation/purge-command.js';
import { handleButtonRoleInteraction } from '../features/reaction-roles/button-roles.js';
import type { EconomyManager } from '../features/economy/economy-manager.js';
import { handleEconomyCommand } from '../features/economy/commands.js';
import { handleTimersCommand } from '../features/economy/timers-command.js';
import { handleGatheringCommand } from '../features/gathering/commands.js';
import { handleCraftingCommand } from '../features/crafting/commands.js';
import { handleFarmingCommand } from '../features/farming/commands.js';
import { handleFishingCommand } from '../features/fishing/commands.js';
import { handleAdventureCommand } from '../features/adventures/commands.js';
import { handleMarketCommand } from '../features/market/commands.js';
import { handleTriviaCommand } from '../features/trivia/commands.js';
import { handleGameCommand } from '../features/games/commands.js';
import { handleLotteryCommand } from '../features/lottery/commands.js';
import { handlePollCommand, handlePredictCommand } from '../features/polls/commands.js';
import type { TriviaManager } from '../features/trivia/trivia-manager.js';
import type { GamesManager } from '../features/games/games-manager.js';
import type { LotteryManager } from '../features/lottery/lottery-manager.js';
import type { PollsManager } from '../features/polls/polls-manager.js';
import { handlePetCommand } from '../features/pets/commands.js';
import { handleQuestCommand } from '../features/quests/commands.js';
import type { HeistManager } from '../features/heist/heist-manager.js';
import { handleHeistCommand } from '../features/heist/commands.js';
import { handleAchievementCommand } from '../features/achievements/commands.js';
import { handleProfileCommand } from '../features/profiles/commands.js';
import type { PetsManager } from '../features/pets/pets-manager.js';
import type { QuestsManager } from '../features/quests/quests-manager.js';
import type { AchievementsManager } from '../features/achievements/achievements-manager.js';
import type { ProfilesManager } from '../features/profiles/profiles-manager.js';
import { handleAdventureButton } from '../features/adventures/adventure-buttons.js';
import type { GatheringManager } from '../features/gathering/gathering-manager.js';
import type { CraftingManager } from '../features/crafting/crafting-manager.js';
import type { FarmingManager } from '../features/farming/farming-manager.js';
import type { FishingManager } from '../features/fishing/fishing-manager.js';
import type { AdventureManager } from '../features/adventures/adventure-manager.js';
import type { MarketManager } from '../features/market/market-manager.js';

/**
 * Register all Discord gateway event listeners.
 * Phase 1: bot-role guard, basic logging.
 * Phase 4: onboarding detection, welcome/goodbye flows.
 * Phase 8: Automation engine event wiring.
 * Phase 9: Levels/XP, reaction roles, custom commands.
 */
const log = createLogger('Events');

export function registerEvents(client: SomniClient): void {
  // Safety nets: prevent unhandled errors from crashing the bot silently
  process.on('unhandledRejection', (error) => {
    log.error('Unhandled promise rejection', { error: String(error) });
  });

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception — process is now unstable, exiting', { error: String(error) });
    // V6 Audit §6.3: Must exit after uncaughtException — Node state is unreliable.
    // Allow 1s for the log to flush, then force-exit.
    setTimeout(() => process.exit(1), 1_000);
  });

  // ── Ready ──────────────────────────────────────────────
  client.once('ready', async (readyClient) => {
    log.info('Logged in', { tag: readyClient.user.tag, gateway: `${readyClient.ws.ping}ms`, guilds: readyClient.guilds.cache.size });
  });

  // ── Guild Member Events (Phase 4: Onboarding + Welcome + Goodbye) ──
  client.on('guildMemberAdd', async (member) => {
    try {
      // Anti-raid check first — if member is actioned, skip welcome flow
      const blocked = await processAntiRaid(member.guild, member, client.supabase);
      if (!blocked) {
        await handleMemberJoin(client, member);
      }
    } catch (err) {
      log.error(' guildMemberAdd handler error:', { error: String(err) });
    }
  });

  client.on('guildMemberRemove', async (member) => {
    try {
      await handleMemberLeave(client, member);
    } catch (err) {
      log.error(' guildMemberRemove handler error:', { error: String(err) });
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      await handleMemberUpdate(client, oldMember, newMember);
    } catch (err) {
      log.error(' guildMemberUpdate handler error:', { error: String(err) });
    }
  });

  // ── Role Events (Phase 5: Drift Detection) ─────────────
  client.on('roleCreate', async (role) => {
    try {
      await handleRoleCreate(client, role);
    } catch (err) {
      log.error(' roleCreate handler error:', { error: String(err) });
    }
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    try {
      await handleRoleUpdate(client, oldRole, newRole);
    } catch (err) {
      log.error(' roleUpdate handler error:', { error: String(err) });
    }
  });

  client.on('roleDelete', async (role) => {
    try {
      await handleRoleDelete(client, role);
    } catch (err) {
      log.error(' roleDelete handler error:', { error: String(err) });
    }
  });

  // ── Channel Events (Phase 5: Drift Detection) ─────────
  client.on('channelCreate', async (channel) => {
    if (!('guild' in channel)) return;
    try {
      await handleChannelCreate(client, channel);
    } catch (err) {
      log.error(' channelCreate handler error:', { error: String(err) });
    }
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!('guild' in newChannel)) return;
    try {
      await handleChannelUpdate(client, oldChannel as typeof newChannel, newChannel);
    } catch (err) {
      log.error(' channelUpdate handler error:', { error: String(err) });
    }
  });

  client.on('channelDelete', async (channel) => {
    if (!('guild' in channel)) return;
    try {
      await handleChannelDelete(client, channel);
    } catch (err) {
      log.error(' channelDelete handler error:', { error: String(err) });
    }
  });

  // ── Message Events (Phase 6: Auto-Mod + Phase 8: Automations + Phase 9: XP) ──
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return; // Multi-guild: accept events from any guild

    // Auto-mod pipeline — runs before any other message processing
    try {
      const modConfig = await loadModConfig(client, message.guild.id);
      const handled = await processMessage(client, message, modConfig);
      if (handled) return; // Message was deleted/actioned by auto-mod
    } catch (err) {
      log.error(' Auto-mod error:', { error: String(err) });
    }

    // Phase 8: Emit message.sent event for automations
    const messageEvent = {
      type: 'message.sent' as const,
      guildId: message.guild!.id,
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
        log.error(' Automation message processing error:', { error: String(err) });
      });
    }

    // Phase 9: XP processing
    try {
      const xpResult = await processMessageXp(
        message,
        client.supabase,
        client.valkey,
        message.guild!.id,
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
      log.error(' XP processing error:', { error: String(err) });
    }

    // Phase 15: Economy chat income (runs alongside XP — separate cooldown)
    try {
      const econMgr = (client as unknown as Record<string, unknown>)._economyManager as EconomyManager | undefined;
      if (econMgr) {
        await econMgr.processChatIncome(message.author.id, message.channelId);
      }
    } catch (err) {
      log.error(' Economy chat income error:', { error: String(err) });
    }

    // Quest progress: 'chat' activity tracking
    try {
      const qMgr = (client as unknown as Record<string, unknown>)._questsManager as QuestsManager | undefined;
      if (qMgr) {
        qMgr.trackProgress(message.guild!.id, message.author.id, 'chat').catch((e: unknown) => { log.warn(' trackProgress failed:', (e as Error)?.message ?? e); });
      }
    } catch {
      // Ignore quest tracking errors
    }
  });

  // ── Reaction Events (Phase 8: Automations + Phase 9: Reaction Roles) ────────────
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    const message = reaction.message;
    if (!message.guild) return; // Multi-guild: accept events from any guild

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
        log.error(' Reaction role add error:', { error: String(err) });
      }
    }

    // Emit reaction.added event for automations
    const reactionEvent = {
      type: 'reaction.added' as const,
      guildId: message.guild!.id,
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
          log.error(' Automation reaction processing error:', { error: String(err) });
        });
      }
    }

    // Also emit to event bus for non-message automations
    client.eventBus.emit('reaction.added', reaction.message.guild!.id, reactionEvent.data);

    // Starboard check
    try {
      await handleStarboardReaction(reaction, user, client.supabase, reaction.message.guild!.id);
    } catch (err) {
      log.error(' Starboard reaction error:', { error: String(err) });
    }
  });

  // Phase 9: Reaction role remove
  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    const message = reaction.message;
    if (!message.guild) return; // Multi-guild: accept events from any guild

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
        log.error(' Reaction role remove error:', { error: String(err) });
      }
    }
  });

  // ── Message Edit/Delete Logging (V17 Behavioral Audit — Item 10) ──
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      await logMessageEdit(client, oldMessage, newMessage);
    } catch (err) {
      log.error(' messageUpdate log error:', { error: String(err) });
    }
  });

  client.on('messageDelete', async (message) => {
    try {
      await logMessageDelete(client, message);
    } catch (err) {
      log.error(' messageDelete log error:', { error: String(err) });
    }
  });

  // ── Voice State (Phase 8: Automations + Phase 9: Voice XP + future Music/Temp Channels) ──
  client.on('voiceStateUpdate', async (oldState, newState) => {
    // Multi-guild: accept voice events from any guild the bot is in
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    // Phase 9: Track voice state for voice XP
    onVoiceStateUpdate(oldState, newState);

    // Phase 11: Music voice state handling (auto-pause, auto-leave)
    const musicPlayer = (client as unknown as Record<string, unknown>)._musicPlayer as MusicPlayerManager | undefined;
    if (musicPlayer) {
      const affectedChannelId = oldState.channelId ?? newState.channelId;
      if (affectedChannelId) {
        musicPlayer.handleVoiceStateChange(affectedChannelId).catch((err) => {
          log.error(' Music voice state handler error:', { error: String(err) });
        });
      }
    }

    // Phase 10: Temp channel creation/cleanup
    const tempMgr = (client as unknown as Record<string, unknown>)._tempChannelManager as TempChannelManager | undefined;
    if (tempMgr) {
      handleVoiceStateForTempChannels(oldState, newState, tempMgr).catch((err) => {
        log.error(' Temp channel voice handler error:', { error: String(err) });
      });
    }

    // Joined a voice channel
    if (!oldState.channelId && newState.channelId) {
      client.eventBus.emit('voice.joined', newState.guild.id, {
        discordId: member.id,
        username: member.user.username,
        channelId: newState.channelId,
        channelName: newState.channel?.name ?? '',
      });
    }

    // Left a voice channel
    if (oldState.channelId && !newState.channelId) {
      client.eventBus.emit('voice.left', oldState.guild.id, {
        discordId: member.id,
        username: member.user.username,
        channelId: oldState.channelId,
        channelName: oldState.channel?.name ?? '',
      });
    }

    // Moved between channels (emit both left and joined)
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      client.eventBus.emit('voice.left', oldState.guild.id, {
        discordId: member.id,
        username: member.user.username,
        channelId: oldState.channelId,
        channelName: oldState.channel?.name ?? '',
      });
      client.eventBus.emit('voice.joined', newState.guild.id, {
        discordId: member.id,
        username: member.user.username,
        channelId: newState.channelId,
        channelName: newState.channel?.name ?? '',
      });
    }
  });

  // ── Interaction Handler (Phase 7: Tickets + Phase 8: Button automations + Phase 9: Commands) ──
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return; // Multi-guild: accept interactions from any guild

    try {
      // Handle setup wizard interactions (buttons + select menu)
      if (interaction.isButton() && interaction.customId.startsWith('setup:')) {
        await handleSetupButton(interaction, client);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'setup:reconfigure') {
        await handleReconfigureSelect(interaction, client);
        return;
      }

      // Handle ticket button/dropdown interactions
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const handled = await handleTicketInteraction(interaction, client);
        if (handled) return;

        // Phase 10: Giveaway entry buttons
        if (interaction.isButton() && interaction.customId.startsWith('giveaway_enter:')) {
          const giveawayMgr = (client as unknown as Record<string, unknown>)._giveawayManager as GiveawayManager | undefined;
          if (giveawayMgr) {
            const gHandled = await giveawayMgr.handleEntry(interaction);
            if (gHandled) return;
          }
        }

        // V17: Button role interactions
        if (interaction.isButton() && interaction.customId.startsWith('btnrole:')) {
          const brHandled = await handleButtonRoleInteraction(interaction, client.supabase);
          if (brHandled) return;
        }

        // Phase 12: Commerce buy buttons — gated by store_enabled
        if (interaction.isButton() && interaction.customId.startsWith('store:buy:')) {
          // Check store_enabled before processing any purchase
          const { data: storeCfg } = await client.supabase
            .from('guild_config')
            .select('store_enabled')
            .eq('guild_id', interaction.guildId!)
            .maybeSingle();
          if (storeCfg?.store_enabled === false) {
            await interaction.reply({ content: '❌ The store is currently disabled.', ephemeral: true });
            return;
          }
          const paypalApiBase = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
          const paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
          const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
          const dashboardUrl = process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://dashboard.somnibot.com';
          if (paypalClientId) {
            await handleBuyButton(
              interaction,
              client.supabase,
              interaction.guildId!,
              paypalApiBase,
              paypalClientId,
              paypalClientSecret,
              dashboardUrl,
            );
            return;
          }
        }

        // Phase 11: Music button interactions
        if (interaction.isButton() && interaction.customId.startsWith('music:')) {
          const musicMgr = (client as unknown as Record<string, unknown>)._musicPlayer as MusicPlayerManager | undefined;
          if (musicMgr) {
            // Queue pagination buttons
            if (interaction.customId.startsWith('music:queue_page:')) {
              const page = parseInt(interaction.customId.split(':')[2] ?? '1', 10);
              const queue = await musicMgr.queueManager.getQueue(interaction.guildId!);
              if (queue) {
                const { buildQueueEmbed } = await import('../features/music/music-embeds.js');
                const { embeds, components } = buildQueueEmbed(queue, page);
                await interaction.update({ embeds, components: components as never[] });
              } else {
                await interaction.reply({ content: '📭 No active queue.', ephemeral: true });
              }
              return;
            }
            // Playback control buttons
            const result = await musicMgr.handleButton(interaction.customId, interaction.user.id);
            await interaction.reply({ content: result.message, ephemeral: true });
            return;
          }
        }

        // Phase 15f: Adventure button interactions
        if (interaction.isButton() && interaction.customId.startsWith('adventure:')) {
          await handleAdventureButton(interaction);
          return;
        }

        // Phase 15h: Trivia answer buttons
        if (interaction.isButton() && interaction.customId.startsWith('trivia:')) {
          const trivMgr = (client as unknown as Record<string, unknown>)._triviaManager as TriviaManager | undefined;
          if (trivMgr) await trivMgr.handleAnswer(interaction);
          return;
        }

        // Phase 15k: Poll vote buttons
        if (interaction.isButton() && interaction.customId.startsWith('poll:')) {
          const pollMgr = (client as unknown as Record<string, unknown>)._pollsManager as PollsManager | undefined;
          if (pollMgr) await pollMgr.handlePollVote(interaction);
          return;
        }

        // V53 Phase 3 (3.4): Economy quick-action buttons
        if (interaction.isButton() && interaction.customId.startsWith('econ_')) {
          const econMgr = (client as unknown as Record<string, unknown>)._economyManager as EconomyManager | undefined;
          if (!econMgr) {
            await interaction.reply({ content: '🚫 Economy is not enabled.', ephemeral: true });
            return;
          }
          switch (interaction.customId) {
            case 'econ_daily': {
              await interaction.deferReply({ ephemeral: true });
              const cfg = await econMgr.loadConfig();
              const result = await econMgr.claimTimedReward(interaction.user.id, 'daily');
              if (result.success) {
                const embed = new EmbedBuilder()
                  .setColor(0x2ecc71)
                  .setTitle(`${cfg.currency_emoji} Daily Reward`)
                  .setDescription(result.message)
                  .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
              } else {
                await interaction.editReply({ content: result.message });
              }
              return;
            }
            case 'econ_balance': {
              const user = interaction.user;
              const cfg = await econMgr.loadConfig();
              const wallet = await econMgr.getOrCreateWallet(user.id);
              const netWorth = wallet.wallet + wallet.bank;
              const embed = new EmbedBuilder()
                .setAuthor({ name: `${user.displayName}'s Balance`, iconURL: user.displayAvatarURL() })
                .setColor(0x5865F2)
                .addFields(
                  { name: '💰 Wallet', value: `${cfg.currency_emoji} ${wallet.wallet.toLocaleString()}`, inline: true },
                  { name: '🏦 Bank', value: `${cfg.currency_emoji} ${wallet.bank.toLocaleString()} / ${wallet.bank_max.toLocaleString()}`, inline: true },
                  { name: '📊 Net Worth', value: `${cfg.currency_emoji} ${netWorth.toLocaleString()}`, inline: true },
                )
                .setTimestamp();
              await interaction.reply({ embeds: [embed], ephemeral: true });
              return;
            }
            case 'econ_inventory': {
              const items = await econMgr.getInventory(interaction.user.id);
              if (items.length === 0) {
                await interaction.reply({ content: '📦 Your inventory is empty.', ephemeral: true });
              } else {
                const lines = items.map((item) => {
                  const durStr = item.durability_remaining !== null ? ` [${item.durability_remaining} uses]` : '';
                  return `${item.item_emoji} **${item.item_name}** ×${item.quantity}${durStr}`;
                });
                const embed = new EmbedBuilder()
                  .setColor(0x9b59b6)
                  .setAuthor({ name: `${interaction.user.displayName}'s Inventory`, iconURL: interaction.user.displayAvatarURL() })
                  .setDescription(lines.join('\n'))
                  .setFooter({ text: `${items.length} items` })
                  .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
              }
              return;
            }
            case 'econ_shop': {
              const cfg = await econMgr.loadConfig();
              const shopItems = await econMgr.getShopItems();
              if (shopItems.length === 0) {
                await interaction.reply({ content: '🏪 The shop is empty!', ephemeral: true });
              } else {
                const shopLines = shopItems.slice(0, 15).map((item) => {
                  const stockStr = item.stock !== null ? ` (${item.stock} left)` : '';
                  return `${item.emoji} **${item.name}** — ${cfg.currency_emoji} ${item.price.toLocaleString()}${stockStr}`;
                });
                const embed = new EmbedBuilder()
                  .setColor(0xf39c12)
                  .setTitle('🏪 Shop')
                  .setDescription(shopLines.join('\n'))
                  .setFooter({ text: `${shopItems.length} items • Use /buy <item> to purchase` })
                  .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
              }
              return;
            }
            case 'econ_timers': {
              // Timers needs SomniClient, but responds ephemeral via button
              const timersClient = interaction.client as unknown as SomniClient;
              const userId = interaction.user.id;
              const guildId2 = timersClient.guildId;
              const valkey = timersClient.valkey;
              if (!valkey) {
                await interaction.reply({ content: '⏱️ Cooldown tracking unavailable.', ephemeral: true });
                return;
              }
              // Quick inline version: check common cooldowns
              const keys = ['daily', 'weekly', 'monthly', 'work', 'crime', 'beg', 'search', 'rob'];
              const ttls = await Promise.all(
                keys.map(async (k) => {
                  const ttl = await valkey.ttl(`economy:${guildId2}:${userId}:${k}`);
                  return { key: k, ttl };
                }),
              );
              const active = ttls.filter((t) => t.ttl > 0);
              if (active.length === 0) {
                await interaction.reply({ content: '⏱️ No active cooldowns! All commands are available.', ephemeral: true });
              } else {
                const lines = active.map((t) => {
                  const m = Math.floor(t.ttl / 60);
                  const s = t.ttl % 60;
                  return `⏳ **${t.key}** — ${m > 0 ? `${m}m ` : ''}${s}s`;
                });
                await interaction.reply({ content: `⏱️ *Active Cooldowns*\n${lines.join('\n')}`, ephemeral: true });
              }
              return;
            }
          }
        }

        // Phase 8: Emit button.clicked event for automations
        if (interaction.isButton()) {
          client.eventBus.emit('button.clicked', interaction.guild!.id, {
            discordId: interaction.user.id,
            username: interaction.user.username,
            buttonId: interaction.customId,
            channelId: interaction.channelId ?? '',
            messageId: interaction.message?.id ?? '',
          });
        }
      }

      // Handle context menu commands (right-click User/Message)
      if (interaction.isUserContextMenuCommand()) {
        switch (interaction.commandName) {
          case 'View Profile':
            await handleViewProfile(interaction, client.supabase, interaction.guildId!);
            return;
          case 'Warn User':
            await handleWarnUser(interaction);
            return;
          case 'View Purchases':
            await handleViewPurchases(interaction, client.supabase, interaction.guildId!);
            return;
        }
      }

      if (interaction.isMessageContextMenuCommand()) {
        switch (interaction.commandName) {
          case 'Create Ticket':
            await handleCreateTicketFromMessage(interaction);
            return;
          case 'Report Message':
            await handleReportMessage(interaction);
            return;
        }
      }

      // Handle modal submissions
      if (interaction.isModalSubmit()) {
        // Setup wizard modals
        if (interaction.customId.startsWith('setup:modal:')) {
          await handleSetupModal(interaction, client);
          return;
        }
        // Context menus and warn user modals
        const guild = interaction.guild;
        if (guild) {
          await handleModalSubmit(interaction, guild, client.supabase, client.eventBus, client);
        }
        return;
      }

      // Handle autocomplete interactions
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, client.supabase, client.shoukaku, interaction.guildId!);
        return;
      }

      // Handle string select menu interactions (help category selector)
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'help:category') {
          await handleHelpCategorySelect(interaction, client);
          return;
        }
      }

      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        // Phase 14: Moderation commands
        switch (interaction.commandName) {
          case 'warn':
            await handleWarnCommand(interaction, client);
            return;
          case 'mute':
            await handleMuteCommand(interaction, client);
            return;
          case 'kick':
            await handleKickCommand(interaction, client);
            return;
          case 'ban':
            await handleBanCommand(interaction, client);
            return;
          case 'pardon':
            await handlePardonCommand(interaction, client);
            return;
          case 'infractions':
            await handleInfractionsCommand(interaction, client);
            return;
          case 'purge':
            await handlePurgeCommand(interaction);
            return;
          case 'xp':
            await handleXpAdminCommand(interaction, client);
            return;
          case 'help':
            await handleHelpCommand(interaction, client);
            return;
          case 'setup':
            await handleSetupCommand(interaction, client);
            return;
          case 'forgetme':
            await handleForgetMeCommand(interaction, client.supabase, interaction.guildId!);
            return;
          case 'privacy':
            await handlePrivacyCommand(interaction);
            return;
          case 'mydata':
            await handleMyDataCommand(interaction);
            return;
          case 'tutorial':
            await handleTutorialCommand(interaction);
            return;
        }

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

        // Phase 10: Voice commands (temp channels)
        if (interaction.commandName === 'voice') {
          const tempMgr = (client as unknown as Record<string, unknown>)._tempChannelManager as TempChannelManager | undefined;
          if (tempMgr) {
            await handleTempChannelCommand(interaction, tempMgr);
          } else {
            await interaction.reply({ content: '❌ Temp channels are not enabled.', ephemeral: true });
          }
          return;
        }

        // Phase 10: Giveaway commands
        if (interaction.commandName === 'giveaway') {
          const giveawayMgr = (client as unknown as Record<string, unknown>)._giveawayManager as GiveawayManager | undefined;
          if (giveawayMgr) {
            await handleGiveawayCommand(interaction, giveawayMgr);
          } else {
            await interaction.reply({ content: '❌ Giveaways are not enabled.', ephemeral: true });
          }
          return;
        }

        // Phase 11: Music commands
        const musicCommands = new Set(['play', 'skip', 'stop', 'queue', 'np', 'volume', 'loop', 'shuffle', 'seek', 'remove', 'pause', 'filter']);
        if (musicCommands.has(interaction.commandName)) {
          const musicMgr = (client as unknown as Record<string, unknown>)._musicPlayer as MusicPlayerManager | undefined;
          if (musicMgr) {
            await handleMusicCommand(interaction, musicMgr);
          } else {
            await interaction.reply({ content: '❌ Music system is not enabled.', ephemeral: true });
          }
          return;
        }

        // Phase 12: Commerce commands — gated by store_enabled (V18 fix)
        if (interaction.commandName === 'store' || interaction.commandName === 'license') {
          const { data: storeFlagCfg } = await client.supabase
            .from('guild_config')
            .select('store_enabled')
            .eq('guild_id', interaction.guildId!)
            .maybeSingle();
          if (storeFlagCfg?.store_enabled === false) {
            await interaction.reply({ content: '❌ The store is currently disabled.', ephemeral: true });
            return;
          }
          if (interaction.commandName === 'store') {
            await handleStoreCommand(
              interaction,
              client.supabase,
              interaction.guildId!,
              process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
            );
            return;
          }
          await handleLicenseCommand(
            interaction,
            client.supabase,
            interaction.guildId!,
          );
          return;
        }

        // V53 Phase 3: /timers — cooldown overview (part of economy, but uses Valkey directly)
        if (interaction.commandName === 'timers') {
          await handleTimersCommand(interaction);
          return;
        }

        // Phase 15: Economy commands — gated by economy_enabled
        const economyCommands = new Set([
          'balance', 'daily', 'weekly', 'monthly', 'work', 'crime', 'beg', 'search',
          'deposit', 'withdraw', 'pay', 'rob', 'passive', 'shop', 'buy', 'sell',
          'inventory', 'use', 'economy-leaderboard', 'collect-income',
        ]);
        if (economyCommands.has(interaction.commandName)) {
          const econMgr = (client as unknown as Record<string, unknown>)._economyManager as EconomyManager | undefined;
          if (econMgr) {
            await handleEconomyCommand(interaction, econMgr);
          } else {
            await interaction.reply({ content: '🚫 The economy system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15b: Gathering commands — /hunt, /dig, /mine
        const gatheringCommands = new Set(['hunt', 'dig', 'mine']);
        if (gatheringCommands.has(interaction.commandName)) {
          const gatherMgr = (client as unknown as Record<string, unknown>)._gatheringManager as GatheringManager | undefined;
          if (gatherMgr) {
            await handleGatheringCommand(interaction, gatherMgr);
          } else {
            await interaction.reply({ content: '🚫 The gathering system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15c: Crafting commands — /craft, /recipes
        const craftingCommands = new Set(['craft', 'recipes']);
        if (craftingCommands.has(interaction.commandName)) {
          const craftMgr = (client as unknown as Record<string, unknown>)._craftingManager as CraftingManager | undefined;
          if (craftMgr) {
            await handleCraftingCommand(interaction, craftMgr);
          } else {
            await interaction.reply({ content: '🚫 The crafting system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15d: Farming commands — /farm
        if (interaction.commandName === 'farm') {
          const farmMgr = (client as unknown as Record<string, unknown>)._farmingManager as FarmingManager | undefined;
          if (farmMgr) {
            await handleFarmingCommand(interaction, farmMgr);
          } else {
            await interaction.reply({ content: '🚫 The farming system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15e: Fishing commands — /fish
        if (interaction.commandName === 'fish') {
          const fishMgr = (client as unknown as Record<string, unknown>)._fishingManager as FishingManager | undefined;
          if (fishMgr) {
            await handleFishingCommand(interaction, fishMgr);
          } else {
            await interaction.reply({ content: '🚫 The fishing system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15f: Adventure commands — /adventure
        if (interaction.commandName === 'adventure') {
          const advMgr = (client as unknown as Record<string, unknown>)._adventureManager as AdventureManager | undefined;
          if (advMgr) {
            await handleAdventureCommand(interaction, advMgr);
          } else {
            await interaction.reply({ content: '🚫 The adventure system is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15g: Market commands — /market
        if (interaction.commandName === 'market') {
          const mktMgr = (client as unknown as Record<string, unknown>)._marketManager as MarketManager | undefined;
          if (mktMgr) {
            await handleMarketCommand(interaction, mktMgr);
          } else {
            await interaction.reply({ content: '🚫 The market is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15h: Trivia commands — /trivia
        if (interaction.commandName === 'trivia') {
          const trivMgr = (client as unknown as Record<string, unknown>)._triviaManager as TriviaManager | undefined;
          if (trivMgr) {
            await handleTriviaCommand(interaction, trivMgr);
          } else {
            await interaction.reply({ content: '🚫 Trivia is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15i: Mini-game commands — /coinflip, /slots, /rps, /dice, /blackjack, /highlow, /scratch, /guess
        const gameNames = ['coinflip', 'slots', 'rps', 'dice', 'blackjack', 'highlow', 'scratch', 'guess'];
        if (gameNames.includes(interaction.commandName)) {
          const gamesMgr = (client as unknown as Record<string, unknown>)._gamesManager as GamesManager | undefined;
          if (gamesMgr) {
            await handleGameCommand(interaction, gamesMgr);
          } else {
            await interaction.reply({ content: '🚫 Mini-games are not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15j: Lottery commands — /lottery
        if (interaction.commandName === 'lottery') {
          const lotMgr = (client as unknown as Record<string, unknown>)._lotteryManager as LotteryManager | undefined;
          if (lotMgr) {
            await handleLotteryCommand(interaction, lotMgr);
          } else {
            await interaction.reply({ content: '🚫 Lottery is not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15k: Poll/Prediction commands — /poll, /predict
        if (interaction.commandName === 'poll') {
          const pollMgr = (client as unknown as Record<string, unknown>)._pollsManager as PollsManager | undefined;
          if (pollMgr) {
            await handlePollCommand(interaction, pollMgr);
          } else {
            await interaction.reply({ content: '🚫 Polls are not enabled on this server.', ephemeral: true });
          }
          return;
        }
        if (interaction.commandName === 'predict') {
          const pollMgr = (client as unknown as Record<string, unknown>)._pollsManager as PollsManager | undefined;
          if (pollMgr) {
            await handlePredictCommand(interaction, pollMgr);
          } else {
            await interaction.reply({ content: '🚫 Predictions are not enabled on this server.', ephemeral: true });
          }
          return;
        }

        // Phase 15l: Pet commands — /pet
        if (interaction.commandName === 'pet') {
          const petMgr = (client as unknown as Record<string, unknown>)._petsManager as PetsManager | undefined;
          if (petMgr) { await handlePetCommand(interaction, petMgr); }
          else { await interaction.reply({ content: '🚫 Pets are not enabled on this server.', ephemeral: true }); }
          return;
        }

        // Phase 15m: Quest commands — /quests
        if (interaction.commandName === 'quests') {
          const qMgr = (client as unknown as Record<string, unknown>)._questsManager as QuestsManager | undefined;
          if (qMgr) { await handleQuestCommand(interaction, qMgr); }
          else { await interaction.reply({ content: '🚫 Quests are not enabled on this server.', ephemeral: true }); }
          return;
        }

        // Phase 15p: Heist commands — /heist
        if (interaction.commandName === 'heist') {
          const heistMgr = (client as unknown as Record<string, unknown>)._heistManager as HeistManager | undefined;
          if (heistMgr) { await handleHeistCommand(interaction, heistMgr); }
          else { await interaction.reply({ content: '🚫 Heists are not enabled on this server.', ephemeral: true }); }
          return;
        }

        // Phase 15n: Achievement/Prestige commands — /badges, /prestige
        if (interaction.commandName === 'badges' || interaction.commandName === 'prestige') {
          const achMgr = (client as unknown as Record<string, unknown>)._achievementsManager as AchievementsManager | undefined;
          if (achMgr) { await handleAchievementCommand(interaction, achMgr); }
          else { await interaction.reply({ content: '🚫 Achievements are not enabled on this server.', ephemeral: true }); }
          return;
        }

        // Phase 15o: Profile commands — /profile, /title, /bio
        if (['profile', 'title', 'bio'].includes(interaction.commandName)) {
          const profMgr = (client as unknown as Record<string, unknown>)._profilesManager as ProfilesManager | undefined;
          if (profMgr) { await handleProfileCommand(interaction, profMgr); }
          else { await interaction.reply({ content: '🚫 Profiles are not available.', ephemeral: true }); }
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
      log.error(' Interaction handler error:', { error: String(err) });
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
    log.error(' Client error:', { error: String(error) });
  });

  client.on('warn', (info) => {
    log.warn(' Warning:', info);
  });

  // ── Infraction Expiry Cron (every 15 minutes) — multi-guild ──
  setInterval(async () => {
    for (const ctx of client.router.all()) {
      try {
        await expireInfractions(client.supabase, ctx.guildId);
      } catch (err) {
        log.error('Infraction expiry error', { guildId: ctx.guildId, error: String(err) });
      }
    }
  }, 15 * 60 * 1000);

  // ── Ticket Inactivity Check (every 30 minutes) — multi-guild ──
  setInterval(async () => {
    for (const ctx of client.router.all()) {
      try {
        await checkInactiveTickets(client.supabase, ctx.guild, client.eventBus);
      } catch (err) {
        log.error('Ticket inactivity check error', { guildId: ctx.guildId, error: String(err) });
      }
    }
  }, 30 * 60 * 1000);

  // ── Data Retention Cron (every 6 hours) — multi-guild ──
  // Audit V2 Finding 13.3 — Prune old audit logs, expired portal sessions,
  // and processed webhook events to comply with data retention policy.
  setInterval(async () => {
    for (const ctx of client.router.all()) {
      try {
        await pruneExpiredData(client.supabase, ctx.guildId);
      } catch (err) {
        log.error('Data retention prune error', { guildId: ctx.guildId, error: String(err) });
      }
    }
  }, 6 * 60 * 60 * 1000);
}

/**
 * Prune expired data for data retention compliance.
 * - Audit logs older than 90 days
 * - Expired portal sessions
 * - Processed webhook events older than 30 days
 */
async function pruneExpiredData(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  guildId: string,
): Promise<void> {
  const now = new Date();

  // 1. Audit logs older than 90 days
  const auditCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { count: auditCount } = await supabase
    .from('audit_logs')
    .delete({ count: 'exact' })
    .eq('guild_id', guildId)
    .lt('created_at', auditCutoff);

  // 2. Expired portal sessions
  const { count: sessionCount } = await supabase
    .from('portal_sessions')
    .delete({ count: 'exact' })
    .eq('guild_id', guildId)
    .lt('expires_at', now.toISOString());

  // 3. Processed webhook events older than 30 days
  const webhookCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: webhookCount } = await supabase
    .from('webhook_events')
    .delete({ count: 'exact' })
    .eq('guild_id', guildId)
    .in('status', ['processed', 'ignored'])
    .lt('created_at', webhookCutoff);

  const total = (auditCount ?? 0) + (sessionCount ?? 0) + (webhookCount ?? 0);
  if (total > 0) {
    log.info('Data pruned', {
      guildId,
      auditLogs: auditCount ?? 0,
      sessions: sessionCount ?? 0,
      webhookEvents: webhookCount ?? 0,
    });
  }
}

// ── Helpers ───────────────────────────────────────────────

/** Per-guild moderation config cache to avoid DB hits per message. */
const _modConfigCache = new Map<string, {
  data: { escalationChain: EscalationStep[]; infractionExpiryDays: number; modLogChannelId: string | null };
  time: number;
}>();
const MOD_CONFIG_TTL = 60_000; // 1 minute

async function loadModConfig(client: SomniClient, guildId?: string): Promise<{
  escalationChain: EscalationStep[];
  infractionExpiryDays: number;
  modLogChannelId: string | null;
}> {
  const id = guildId ?? client.guildId;
  const now = Date.now();
  const cached = _modConfigCache.get(id);
  if (cached && now - cached.time < MOD_CONFIG_TTL) {
    return cached.data;
  }

  const { data } = await client.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', id)
    .maybeSingle();

  const result = {
    escalationChain: Array.isArray(data?.escalation_chain)
      ? (data.escalation_chain as EscalationStep[])
      : [],
    infractionExpiryDays: (data?.infraction_expiry_days as number) ?? 30,
    modLogChannelId: (data?.mod_log_channel_id as string) ?? null,
  };
  _modConfigCache.set(id, { data: result, time: now });

  return result;
}
