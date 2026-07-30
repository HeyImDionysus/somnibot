#!/usr/bin/env node

/**
 * Secret-safe, read-only Discord gateway proof.
 *
 * The caller must inject only the approved Discord variables into this process.
 * This script never reads an env file, prints identifiers/tokens, sends messages,
 * registers commands, or mutates the guild.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_APPLICATION_ID'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]?.trim());
if (missingEnv.length > 0) {
  throw new Error(`Missing required Discord environment variable(s): ${missingEnv.join(', ')}`);
}
if (process.env.SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK !== '1') {
  throw new Error(
    'Refusing live Discord readback without SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK=1',
  );
}

const requireFromBot = createRequire(resolve('packages/bot/package.json'));
const {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = requireFromBot('discord.js');

const WALKTHROUGH_COMMANDS = [
  'setup', 'rank', 'leaderboard', 'xp',
  'warn', 'mute', 'kick', 'infractions', 'appeal',
  'poll', 'giveaway', 'tutorial',
  'shop', 'buy', 'inventory', 'use', 'sell',
  'balance', 'daily', 'weekly', 'monthly', 'work', 'crime', 'beg', 'search',
  'deposit', 'withdraw', 'pay', 'rob', 'passive', 'collect-income', 'timers',
  'economy-leaderboard',
  'coinflip', 'dice', 'slots', 'blackjack', 'highlow', 'rps', 'scratch', 'guess',
  'hunt', 'dig', 'mine', 'craft', 'recipes', 'farm', 'fish', 'market',
  'pet', 'quests', 'badges', 'prestige', 'trivia', 'lottery', 'heist', 'adventure',
  'play', 'queue', 'skip', 'np', 'volume', 'loop', 'pause', 'stop',
  'voice', 'store', 'mydata', 'forgetme',
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timeout = setTimeout(() => {
  client.destroy();
}, 20_000);

try {
  await client.login(process.env.DISCORD_TOKEN);
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const [channels, commands, member] = await Promise.all([
    guild.channels.fetch(),
    guild.commands.fetch(),
    guild.members.fetchMe(),
  ]);

  const commandNames = new Set([...commands.values()].map((command) => command.name));
  const missingWalkthroughCommands = WALKTHROUGH_COMMANDS.filter(
    (name) => !commandNames.has(name),
  );
  const setupCommand = commands.find((command) => command.name === 'setup');

  const guildChannels = [...channels.values()].filter((channel) => channel !== null);
  const readableTextChannels = guildChannels.filter((channel) => {
    if (
      channel.type !== ChannelType.GuildText
      && channel.type !== ChannelType.GuildAnnouncement
      && channel.type !== ChannelType.PublicThread
      && channel.type !== ChannelType.PrivateThread
    ) {
      return false;
    }
    const permissions = channel.permissionsFor(member);
    return Boolean(
      permissions?.has(PermissionFlagsBits.ViewChannel)
      && permissions.has(PermissionFlagsBits.ReadMessageHistory),
    );
  });
  const sendableTextChannels = readableTextChannels.filter((channel) =>
    channel.permissionsFor(member)?.has(PermissionFlagsBits.SendMessages),
  );

  const result = {
    gatewayReady: client.isReady(),
    applicationIdentityMatches: client.user?.id === process.env.DISCORD_APPLICATION_ID,
    guildReachable: Boolean(guild),
    guildChannelsReadable: guildChannels.length,
    readableTextChannels: readableTextChannels.length,
    sendableTextChannels: sendableTextChannels.length,
    registeredGuildCommands: commands.size,
    walkthroughCommandsPresent: missingWalkthroughCommands.length === 0,
    missingWalkthroughCommands,
    setupRegistered: Boolean(setupCommand),
    setupDescriptionPresent: Boolean(setupCommand?.description?.trim()),
    botRoleAboveEveryone: member.roles.highest.position > 0,
  };

  console.log(JSON.stringify(result));

  if (
    !result.gatewayReady
    || !result.applicationIdentityMatches
    || !result.guildReachable
    || !result.walkthroughCommandsPresent
    || !result.setupRegistered
    || !result.setupDescriptionPresent
    || !result.botRoleAboveEveryone
    || result.readableTextChannels === 0
  ) {
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timeout);
  client.destroy();
}
