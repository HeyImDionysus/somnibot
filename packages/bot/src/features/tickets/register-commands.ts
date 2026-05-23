/**
 * Register ticket slash commands with Discord.
 */

import { REST, Routes } from 'discord.js';
import type { SomniClient } from '../../client.js';
import { ticketCommand } from './ticket-commands.js';

export async function registerTicketCommands(client: SomniClient): Promise<void> {
  try {
    const rest = new REST({ version: '10' }).setToken(client.env.DISCORD_TOKEN);

    // Get existing commands
    const existingCommands = (await rest.get(
      Routes.applicationGuildCommands(client.env.DISCORD_APPLICATION_ID, client.guildId),
    )) as Array<{ name: string; id: string }>;

    // Check if /ticket already exists
    const existing = existingCommands.find((c) => c.name === 'ticket');
    if (existing) {
      console.log('[Boot] /ticket command already registered — updating');
    }

    // Register/update the ticket command
    await rest.put(
      Routes.applicationGuildCommands(client.env.DISCORD_APPLICATION_ID, client.guildId),
      {
        body: [
          ...existingCommands.filter((c) => c.name !== 'ticket').map((c) => c),
          ticketCommand,
        ],
      },
    );

    console.log('[Boot] ✅ /ticket slash command registered');
  } catch (err) {
    console.error('[Boot] Failed to register ticket commands:', err);
  }
}
