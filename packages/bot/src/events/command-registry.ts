/**
 * Command Registry — Maps slash command names to their handlers.
 *
 * V7 Audit §6.P3a — Reduces the 1200+ line handler.ts monolith by
 * extracting the slash command dispatch into a data-driven registry.
 *
 * Usage:
 *   import { commandRegistry, lookupCommand } from './command-registry.js';
 *   const handler = lookupCommand(interaction.commandName);
 *   if (handler) { await handler(interaction, client); return; }
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { SomniClient } from '../client.js';

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
) => Promise<void>;

/**
 * Static command registry populated at module load.
 * Each entry maps a slash command name to its handler function.
 */
const registry = new Map<string, CommandHandler>();

/**
 * Register a slash command handler.
 */
export function registerCommand(name: string, handler: CommandHandler): void {
  if (registry.has(name)) {
    throw new Error(`Duplicate command registration: "${name}"`);
  }
  registry.set(name, handler);
}

/**
 * Look up a slash command handler by name.
 * Returns undefined if not found (caller should handle unknown commands).
 */
export function lookupCommand(name: string): CommandHandler | undefined {
  return registry.get(name);
}

/**
 * Return all registered command names (for diagnostics/help).
 */
export function registeredCommands(): string[] {
  return [...registry.keys()].sort();
}
