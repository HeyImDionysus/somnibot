import type { SomniClient } from '../client.js';
import {
  handleMemberJoin,
  handleMemberUpdate,
  handleMemberLeave,
} from '../features/welcome/index.js';
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

/**
 * Register all Discord gateway event listeners.
 * Phase 1: bot-role guard, basic logging.
 * Phase 4: onboarding detection, welcome/goodbye flows.
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

  // ── Message Events ─────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.guild?.id !== client.guildId) return;
    // XP processing added in Phase 9 (Levels)
  });

  // ── Voice State ────────────────────────────────────────
  client.on('voiceStateUpdate', async (_oldState, newState) => {
    if (newState.guild.id !== client.guildId) return;
    // Music + temp channels added in later phases
  });

  // ── Interaction Handler ────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild || interaction.guild.id !== client.guildId) return;
    // Command handling added in later phases
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
}
