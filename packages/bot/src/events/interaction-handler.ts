/**
 * Interaction Handler — Routes all Discord interaction events.
 *
 * V5 Audit §6.P3a — Extracted from the 1210-line handler.ts monolith
 * into a dedicated module for maintainability.
 *
 * Handles: buttons, select menus, context menus, modals, autocomplete,
 * and slash commands (via command-registry + inline feature-gated dispatch).
 */

import { EmbedBuilder } from 'discord.js';
import type { Interaction } from 'discord.js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import { lookupCommand } from './command-registry.js';
// Single source of truth for the dispatcher's routing keys (PR4 — E2E harness).
import {
  SLASH,
  MUSIC_COMMANDS,
  ECONOMY_COMMANDS,
  GATHERING_COMMANDS,
  CRAFTING_COMMANDS,
  GAME_COMMANDS,
  PROFILE_COMMANDS,
  BUTTON_PREFIX,
  SELECT_LITERAL,
  MODAL_PREFIX,
  ECON_BUTTON,
  USER_CONTEXT_MENU,
  MESSAGE_CONTEXT_MENU,
} from './dispatch-manifest.js';

// Feature handler imports — buttons & UI
import { handleTicketInteraction } from '../features/tickets/index.js';
import { handleSetupButton, handleSetupModal, handleReconfigureSelect } from '../features/setup-wizard/index.js';
import { handleButtonRoleInteraction } from '../features/reaction-roles/button-roles.js';
import { handleBuyButton } from '../features/commerce/payment-handler.js';
import { handleAdventureButton } from '../features/adventures/adventure-buttons.js';

// Feature handler imports — context menus & modals
import { handleViewProfile, handleWarnUser, handleViewPurchases, handleCreateTicketFromMessage, handleReportMessage } from '../features/discord-ux/index.js';
import { handleModalSubmit } from '../features/discord-ux/modal-handlers.js';
import { handleAutocomplete } from '../features/discord-ux/autocomplete.js';
import { handleHelpCategorySelect } from '../features/help/index.js';
import { resolveBrandKit } from '../features/branding/brand-kit.js';

// Feature handler imports — slash commands
import { handleStoreCommand } from '../features/commerce/store-command.js';
import { handleLicenseCommand } from '../features/commerce/license-commands.js';
import { handleMusicCommand } from '../features/music/commands.js';
import { handleTempChannelCommand } from '../features/temp-channels/commands.js';
import { handleGiveawayCommand } from '../features/giveaways/commands.js';
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
import { handlePetCommand } from '../features/pets/commands.js';
import { handleQuestCommand } from '../features/quests/commands.js';
import { handleHeistCommand } from '../features/heist/commands.js';
import { handleAchievementCommand } from '../features/achievements/commands.js';
import { handleProfileCommand } from '../features/profiles/commands.js';
import { isCustomCommand, handleCustomCommand } from '../features/custom-commands/index.js';

// Manager type imports
import type { TempChannelManager } from '../features/temp-channels/temp-channel-manager.js';
import type { GiveawayManager } from '../features/giveaways/giveaway-manager.js';
import type { MusicPlayerManager } from '../features/music/music-player.js';
import type { EconomyManager } from '../features/economy/economy-manager.js';
import type { TriviaManager } from '../features/trivia/trivia-manager.js';
import type { GamesManager } from '../features/games/games-manager.js';
import type { LotteryManager } from '../features/lottery/lottery-manager.js';
import type { PollsManager } from '../features/polls/polls-manager.js';
import type { PetsManager } from '../features/pets/pets-manager.js';
import type { QuestsManager } from '../features/quests/quests-manager.js';
import type { HeistManager } from '../features/heist/heist-manager.js';
import type { AchievementsManager } from '../features/achievements/achievements-manager.js';
import type { ProfilesManager } from '../features/profiles/profiles-manager.js';
import type { GatheringManager } from '../features/gathering/gathering-manager.js';
import type { CraftingManager } from '../features/crafting/crafting-manager.js';
import type { FarmingManager } from '../features/farming/farming-manager.js';
import type { FishingManager } from '../features/fishing/fishing-manager.js';
import type { AdventureManager } from '../features/adventures/adventure-manager.js';
import type { MarketManager } from '../features/market/market-manager.js';

const log = createLogger('InteractionHandler');

/**
 * Helper to get a typed manager from the guild context.
 *
 * V10 Audit §6.P3a — Uses the GuildRouter's typed getManager() instead
 * of casting the client to Record<string, unknown>. Falls back to the
 * primary guild context if no guild ID is available.
 */
function getManager<T>(client: SomniClient, key: string, guildId?: string): T | undefined {
  const id = guildId ?? client.guildId;
  return client.router?.getContextSync(id)?.getManager<T>(key);
}

/**
 * Whether an interaction belongs to the setup wizard.
 *
 * During setup-verification mode ONLY these are allowed to route (see the gate
 * in handleInteraction); every other command/component is short-circuited so it
 * cannot run against the empty placeholder router and missing guild_config.
 *
 * The set mirrors exactly the setup entry points dispatched below:
 *   - the `/setup` slash command,
 *   - `setup:` buttons,
 *   - the `setup:reconfigure` select menu,
 *   - `setup:modal:` modal submissions.
 */
function isSetupInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) {
    return interaction.commandName === SLASH.setup;
  }
  if (interaction.isButton()) {
    return interaction.customId.startsWith(BUTTON_PREFIX.setup);
  }
  if (interaction.isStringSelectMenu()) {
    return interaction.customId === SELECT_LITERAL.setupReconfigure;
  }
  if (interaction.isModalSubmit()) {
    return interaction.customId.startsWith(MODAL_PREFIX.setup);
  }
  return false;
}

/**
 * Handle a single interactionCreate event.
 * Exported for the main event wiring in handler.ts.
 */
export async function handleInteraction(interaction: Interaction, client: SomniClient): Promise<void> {
  if (!interaction.guild) return;

  // V10 Audit M-4: Single guildId guard replaces 20+ non-null assertions below.
  // Guild interactions always have guildId, but this guard ensures safety if a
  // DM-based interaction ever routes here (Discord API edge cases).
  const guildId = interaction.guildId;
  if (!guildId) return;

  // ── Setup-verification gate (codex round-3 finding #1) ──
  // While the bot is in setup-verification mode it is logged in ONLY so the
  // wizard can confirm it is online; the GuildRouter is an empty placeholder
  // and guild_config rows do not exist yet. Previously registered slash
  // commands or component interactions (e.g. /warn, store/music buttons) can
  // still be routed by Discord — running them now would hit an empty router and
  // missing guild_config, reproducing the pre-setup DB writes/errors this gate
  // is meant to suppress. Let ONLY the setup wizard's own interactions through
  // and short-circuit everything else until the full-boot transition clears the
  // flag.
  if (client.setupVerificationMode === true && !isSetupInteraction(interaction)) {
    return;
  }

  try {
    // ── Setup wizard ──
    if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.setup)) {
      await handleSetupButton(interaction, client);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === SELECT_LITERAL.setupReconfigure) {
      await handleReconfigureSelect(interaction, client);
      return;
    }

    // ── Button & Select Menu routing ──
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handled = await handleTicketInteraction(interaction, client);
      if (handled) return;

      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.giveawayEnter)) {
        const mgr = getManager<GiveawayManager>(client, 'giveawayManager', guildId);
        if (mgr && await mgr.handleEntry(interaction)) return;
      }

      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.buttonRole)) {
        if (await handleButtonRoleInteraction(interaction, client.supabase)) return;
      }

      // Commerce buy buttons — gated by store_enabled
      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.storeBuy)) {
        const { data: storeCfg } = await client.supabase
          .from('guild_config')
          .select('store_enabled')
          .eq('guild_id', guildId)
          .maybeSingle();
        if (storeCfg?.store_enabled === false) {
          await interaction.reply({ content: '❌ The store is currently disabled.', ephemeral: true });
          return;
        }
        const paypalApiBase = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
        const paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
        const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
        const dashboardUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'https://dashboard.somnibot.com';
        if (paypalClientId) {
          await handleBuyButton(interaction, client.supabase, guildId, paypalApiBase, paypalClientId, paypalClientSecret, dashboardUrl);
          return;
        }
      }

      // Music buttons
      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.music)) {
        const musicMgr = getManager<MusicPlayerManager>(client, 'musicPlayer', guildId);
        if (musicMgr) {
          if (interaction.customId.startsWith(BUTTON_PREFIX.musicQueuePage)) {
            const page = parseInt(interaction.customId.split(':')[2] ?? '1', 10);
            const queue = await musicMgr.queueManager.getQueue(guildId);
            if (queue) {
              const { buildQueueEmbed } = await import('../features/music/music-embeds.js');
              const { embeds, components } = buildQueueEmbed(queue, page);
              await interaction.update({ embeds, components });
            } else {
              await interaction.reply({ content: '📭 No active queue.', ephemeral: true });
            }
            return;
          }
          const result = await musicMgr.handleButton(interaction.customId, interaction.user.id);
          await interaction.reply({ content: result.message, ephemeral: true });
          return;
        }
      }

      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.adventure)) {
        await handleAdventureButton(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.trivia)) {
        const trivMgr = getManager<TriviaManager>(client, 'trivia', guildId);
        if (trivMgr) await trivMgr.handleAnswer(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.poll)) {
        const pollMgr = getManager<PollsManager>(client, 'polls', guildId);
        if (pollMgr) await pollMgr.handlePollVote(interaction);
        return;
      }

      // Economy quick-action buttons
      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX.econ)) {
        await handleEconomyButton(interaction, client);
        return;
      }

      // Emit button.clicked event for automations
      if (interaction.isButton()) {
        client.eventBus.emit('button.clicked', interaction.guild!.id, {
          interactionId: interaction.id,
          discordId: interaction.user.id,
          username: interaction.user.username,
          buttonId: interaction.customId,
          channelId: interaction.channelId ?? '',
          messageId: interaction.message?.id ?? '',
        });
      }
    }

    // ── Context Menu Commands ──
    if (interaction.isUserContextMenuCommand()) {
      switch (interaction.commandName) {
        case USER_CONTEXT_MENU.viewProfile:
          await handleViewProfile(interaction, client.supabase, guildId);
          return;
        case USER_CONTEXT_MENU.warnUser:
          await handleWarnUser(interaction);
          return;
        case USER_CONTEXT_MENU.viewPurchases:
          await handleViewPurchases(interaction, client.supabase, guildId);
          return;
      }
    }

    if (interaction.isMessageContextMenuCommand()) {
      switch (interaction.commandName) {
        case MESSAGE_CONTEXT_MENU.createTicket:
          await handleCreateTicketFromMessage(interaction);
          return;
        case MESSAGE_CONTEXT_MENU.reportMessage:
          await handleReportMessage(interaction);
          return;
      }
    }

    // ── Modal Submissions ──
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(MODAL_PREFIX.setup)) {
        await handleSetupModal(interaction, client);
        return;
      }
      const guild = interaction.guild;
      if (guild) {
        await handleModalSubmit(interaction, guild, client.supabase, client.eventBus, client);
      }
      return;
    }

    // ── Autocomplete ──
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, client.supabase, client.shoukaku, guildId);
      return;
    }

    // ── Help select menu ──
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === SELECT_LITERAL.helpCategory) {
        await handleHelpCategorySelect(interaction, client);
        return;
      }
    }

    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, client);
    }
  } catch (err) {
    log.error('Interaction handler error:', { error: String(err) });
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
      }
    } catch (replyErr) {
      // Error handler's own reply failed — nothing more we can do
      log.debug('Error reply itself failed', { error: String(replyErr) });
    }
  }
}

// ── Slash Command Dispatch ──────────────────────────────────────────

async function handleSlashCommand(
  interaction: import('discord.js').ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  // V10 Audit M-4: guildId is guaranteed non-null by handleInteraction's guard
  const guildId = interaction.guildId!;

  // Data-driven registry first (V7 Audit §6.P3a)
  const registeredHandler = lookupCommand(interaction.commandName);
  if (registeredHandler) {
    await registeredHandler(interaction, client);
    return;
  }

  // Level commands
  if (interaction.commandName === SLASH.rank) {
    const { handleRankCommand } = await import('../features/levels/commands.js');
    await handleRankCommand(interaction, client);
    return;
  }
  if (interaction.commandName === SLASH.leaderboard) {
    const { handleLeaderboardCommand } = await import('../features/levels/commands.js');
    await handleLeaderboardCommand(interaction, client);
    return;
  }

  // Temp channel commands
  if (interaction.commandName === SLASH.voice) {
    const mgr = getManager<TempChannelManager>(client, 'tempChannelManager', guildId);
    if (mgr) { await handleTempChannelCommand(interaction, mgr); }
    else { await interaction.reply({ content: '❌ Temp channels are not enabled.', ephemeral: true }); }
    return;
  }

  // Giveaway commands
  if (interaction.commandName === SLASH.giveaway) {
    const mgr = getManager<GiveawayManager>(client, 'giveawayManager', guildId);
    if (mgr) { await handleGiveawayCommand(interaction, mgr); }
    else { await interaction.reply({ content: '❌ Giveaways are not enabled.', ephemeral: true }); }
    return;
  }

  // Music commands — gated by music_enabled
  if (MUSIC_COMMANDS.has(interaction.commandName)) {
    const mgr = getManager<MusicPlayerManager>(client, 'musicPlayer', guildId);
    if (mgr) {
      await handleMusicCommand(interaction, mgr);
      return;
    }
    // No manager is wired. Distinguish an owner-disabled feature
    // (music_enabled=false) from a genuine infrastructure gap so the two decline
    // paths are not conflated.
    const { data: musicFlagCfg } = await client.supabase
      .from('guild_config')
      .select('music_enabled')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (musicFlagCfg?.music_enabled === false) {
      // Catalog `music-disabled`: a branded, guild-named ephemeral embed notice
      // rendered with the owner's white-label brand kit (configured brand name
      // falling back to the guild's name, accent color, powered-by attribution)
      // — never a stock SomniBot string.
      const brandKit = await resolveBrandKit(client.supabase, guildId, { fallbackName: interaction.guild?.name });
      const disabledEmbed = new EmbedBuilder()
        .setColor(brandKit.accentColor)
        .setTitle('🎵 Music is switched off')
        .setDescription(
          `Music is currently switched off in **${brandKit.brandName}** — ` +
            'an admin can flip it back on from the dashboard.',
        );
      if (brandKit.poweredByAttribution) {
        disabledEmbed.setFooter({ text: brandKit.poweredByAttribution });
      }
      await interaction.reply({ embeds: [disabledEmbed], ephemeral: true });
      return;
    }
    // Music is enabled but no manager is available — an infrastructure/startup gap.
    await interaction.reply({
      content: '❌ Music system is temporarily unavailable. Please try again shortly.',
      ephemeral: true,
    });
    return;
  }

  // Commerce commands — gated by store_enabled
  if (interaction.commandName === SLASH.store || interaction.commandName === SLASH.license) {
    const { data: storeFlagCfg } = await client.supabase
      .from('guild_config')
      .select('store_enabled')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (storeFlagCfg?.store_enabled === false) {
      await interaction.reply({ content: '❌ The store is currently disabled.', ephemeral: true });
      return;
    }
    if (interaction.commandName === SLASH.store) {
      await handleStoreCommand(interaction, client.supabase, guildId, process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com');
      return;
    }
    await handleLicenseCommand(interaction, client.supabase, guildId);
    return;
  }

  // Timers command
  if (interaction.commandName === SLASH.timers) {
    await handleTimersCommand(interaction);
    return;
  }

  // Economy commands — gated by economy_enabled
  if (ECONOMY_COMMANDS.has(interaction.commandName)) {
    const mgr = getManager<EconomyManager>(client, 'economy', guildId);
    if (mgr) { await handleEconomyCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The economy system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Gathering commands — /hunt, /dig, /mine
  if (GATHERING_COMMANDS.has(interaction.commandName)) {
    const mgr = getManager<GatheringManager>(client, 'gathering', guildId);
    if (mgr) { await handleGatheringCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The gathering system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Crafting commands — /craft, /recipes
  if (CRAFTING_COMMANDS.has(interaction.commandName)) {
    const mgr = getManager<CraftingManager>(client, 'crafting', guildId);
    if (mgr) { await handleCraftingCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The crafting system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Farming
  if (interaction.commandName === SLASH.farm) {
    const mgr = getManager<FarmingManager>(client, 'farming', guildId);
    if (mgr) { await handleFarmingCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The farming system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Fishing
  if (interaction.commandName === SLASH.fish) {
    const mgr = getManager<FishingManager>(client, 'fishing', guildId);
    if (mgr) { await handleFishingCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The fishing system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Adventures
  if (interaction.commandName === SLASH.adventure) {
    const mgr = getManager<AdventureManager>(client, 'adventures', guildId);
    if (mgr) { await handleAdventureCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The adventure system is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Market
  if (interaction.commandName === SLASH.market) {
    const mgr = getManager<MarketManager>(client, 'market', guildId);
    if (mgr) { await handleMarketCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 The market is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Trivia
  if (interaction.commandName === SLASH.trivia) {
    const mgr = getManager<TriviaManager>(client, 'trivia', guildId);
    if (mgr) { await handleTriviaCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Trivia is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Mini-games
  if (GAME_COMMANDS.includes(interaction.commandName)) {
    const mgr = getManager<GamesManager>(client, 'games', guildId);
    if (mgr) { await handleGameCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Mini-games are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Lottery
  if (interaction.commandName === SLASH.lottery) {
    const mgr = getManager<LotteryManager>(client, 'lottery', guildId);
    if (mgr) { await handleLotteryCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Lottery is not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Polls & Predictions
  if (interaction.commandName === SLASH.poll) {
    const mgr = getManager<PollsManager>(client, 'polls', guildId);
    if (mgr) { await handlePollCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Polls are not enabled on this server.', ephemeral: true }); }
    return;
  }
  if (interaction.commandName === SLASH.predict) {
    const mgr = getManager<PollsManager>(client, 'polls', guildId);
    if (mgr) { await handlePredictCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Predictions are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Pets
  if (interaction.commandName === SLASH.pet) {
    const mgr = getManager<PetsManager>(client, 'pets', guildId);
    if (mgr) { await handlePetCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Pets are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Quests
  if (interaction.commandName === SLASH.quests) {
    const mgr = getManager<QuestsManager>(client, 'quests', guildId);
    if (mgr) { await handleQuestCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Quests are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Heist
  if (interaction.commandName === SLASH.heist) {
    const mgr = getManager<HeistManager>(client, 'heist', guildId);
    if (mgr) { await handleHeistCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Heists are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Achievements & Prestige
  if (interaction.commandName === SLASH.badges || interaction.commandName === SLASH.prestige) {
    const mgr = getManager<AchievementsManager>(client, 'achievements', guildId);
    if (mgr) { await handleAchievementCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Achievements are not enabled on this server.', ephemeral: true }); }
    return;
  }

  // Profiles
  if (PROFILE_COMMANDS.includes(interaction.commandName)) {
    const mgr = getManager<ProfilesManager>(client, 'profiles', guildId);
    if (mgr) { await handleProfileCommand(interaction, mgr); }
    else { await interaction.reply({ content: '🚫 Profiles are not available.', ephemeral: true }); }
    return;
  }

  // Custom commands (check registry)
  if (isCustomCommand(interaction.commandName, interaction.guildId ?? undefined)) {
    await handleCustomCommand(interaction, client.supabase, client.valkey, interaction.guild!);
    return;
  }
}

// ── Economy Quick-Action Buttons ────────────────────────────────────

async function handleEconomyButton(
  interaction: import('discord.js').ButtonInteraction,
  client: SomniClient,
): Promise<void> {
  // V10 Audit M-4: guildId is guaranteed non-null by handleInteraction's guard
  const guildId = interaction.guildId!;
  const econMgr = getManager<EconomyManager>(client, 'economy', guildId);
  if (!econMgr) {
    await interaction.reply({ content: '🚫 Economy is not enabled.', ephemeral: true });
    return;
  }

  switch (interaction.customId) {
    case ECON_BUTTON.daily: {
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
    case ECON_BUTTON.balance: {
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
    case ECON_BUTTON.inventory: {
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
    case ECON_BUTTON.shop: {
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
    case ECON_BUTTON.timers: {
      const timersClient = interaction.client as SomniClient;
      const userId = interaction.user.id;
      // V10 Audit: guildId from outer scope (interaction.guildId) is correct.
      const valkey = timersClient.valkey;
      if (!valkey) {
        await interaction.reply({ content: '⏱️ Cooldown tracking unavailable.', ephemeral: true });
        return;
      }
      const keys = ['daily', 'weekly', 'monthly', 'work', 'crime', 'beg', 'search', 'rob'];
      const ttls = await Promise.all(
        keys.map(async (k) => {
          const ttl = await valkey.ttl(`economy:${guildId}:${userId}:${k}`);
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
