import type { SomniClient } from '../client.js';

/**
 * Register all Discord gateway event listeners.
 * Each event is handled minimally in Phase 1 — just logging.
 * Full implementations come in later phases.
 */
export function registerEvents(client: SomniClient): void {
  // ── Ready ──────────────────────────────────────────────
  client.once('ready', async (readyClient) => {
    console.log(`[Bot] Logged in as ${readyClient.user.tag}`);
    console.log(`[Bot] Guild: ${client.guildId}`);
    console.log(`[Bot] Gateway: ${readyClient.ws.ping}ms`);

    // Verify bot role position
    const guild = readyClient.guilds.cache.get(client.guildId);
    if (guild) {
      const botMember = guild.members.me;
      if (botMember) {
        const highestRole = botMember.roles.highest;
        console.log(`[Bot] Highest role: "${highestRole.name}" (position ${highestRole.position})`);

        // Check if bot role is position #1 (highest non-owner role)
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

  // ── Guild Member Events ────────────────────────────────
  client.on('guildMemberAdd', async (member) => {
    if (member.guild.id !== client.guildId) return;
    console.log(`[Event] Member joined: ${member.user.tag}`);
    client.eventBus.emit('member.joined', client.guildId, {
      discordId: member.id,
      username: member.user.tag,
      isReturning: false, // TODO: check returning member status in DB
    });
  });

  client.on('guildMemberRemove', async (member) => {
    if (member.guild.id !== client.guildId) return;
    console.log(`[Event] Member left: ${member.user.tag}`);
    client.eventBus.emit('member.left', client.guildId, {
      discordId: member.id,
      username: member.user.tag,
      roles: member.roles.cache.map((r) => r.id),
    });
  });

  // ── Role Updates ───────────────────────────────────────
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (newMember.guild.id !== client.guildId) return;

    // Detect role changes
    const addedRoles = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));

    for (const [, role] of addedRoles) {
      client.eventBus.emit('role.gained', client.guildId, {
        discordId: newMember.id,
        roleId: role.id,
        roleName: role.name,
        source: 'discord',
      });
    }

    for (const [, role] of removedRoles) {
      client.eventBus.emit('role.lost', client.guildId, {
        discordId: newMember.id,
        roleId: role.id,
        roleName: role.name,
        source: 'discord',
      });
    }
  });

  // ── Message Events ─────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.guild?.id !== client.guildId) return;
    // Phase 1: no-op — XP processing added in Phase 5 (Levels)
  });

  // ── Voice State ────────────────────────────────────────
  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.guild.id !== client.guildId) return;
    // Phase 1: no-op — music + temp channels added in later phases
  });

  // ── Interaction Handler ────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild || interaction.guild.id !== client.guildId) return;
    // Phase 1: no slash commands registered yet
    // Command handling added in Phase 2
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
