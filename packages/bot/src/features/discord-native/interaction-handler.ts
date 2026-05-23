/**
 * InteractionErrorHandler — Wraps all interaction handlers with:
 *   1. Error catching (no more "This interaction failed")
 *   2. Ephemeral error messages (user sees what went wrong)
 *   3. Deferred reply management (auto-defer for long-running ops)
 *   4. Logging to audit service
 *
 * GAP 5: Discord Native Potential — Interaction error handling + ephemeral follow-ups
 */

import {
  CommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  AutocompleteInteraction,
  InteractionType,
  type Interaction,
  EmbedBuilder,
} from 'discord.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('InteractionHandler');

export type AnyRepliableInteraction =
  | CommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

export type InteractionHandler = (interaction: AnyRepliableInteraction) => Promise<void>;

/**
 * Wrap an interaction handler with error handling and auto-defer.
 */
export function safeInteractionHandler(
  handler: InteractionHandler,
  options: {
    /** Name for logging */
    name: string;
    /** Auto-defer after this many ms (0 = no auto-defer) */
    autoDeferMs?: number;
    /** Whether deferred replies should be ephemeral */
    ephemeral?: boolean;
  } = { name: 'unknown' },
): InteractionHandler {
  return async (interaction: AnyRepliableInteraction) => {
    let deferred = false;
    let deferTimer: NodeJS.Timeout | null = null;

    try {
      // Auto-defer if handler takes too long (Discord 3s limit)
      const autoDeferMs = options.autoDeferMs ?? 2500;
      if (autoDeferMs > 0 && !interaction.replied && !interaction.deferred) {
        deferTimer = setTimeout(async () => {
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.deferReply({ ephemeral: options.ephemeral ?? false });
              deferred = true;
            }
          } catch {
            // Already replied/deferred by handler
          }
        }, autoDeferMs);
      }

      await handler(interaction);
    } catch (err) {
      log.error(`[InteractionHandler:${options.name}] Error:`, err);

      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ Something went wrong')
        .setDescription(
          err instanceof Error
            ? err.message.slice(0, 200)
            : 'An unexpected error occurred. Please try again.',
        )
        .setColor(0xed4245)
        .setFooter({ text: `Handler: ${options.name}` })
        .setTimestamp();

      try {
        if (interaction.replied) {
          await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else if (interaction.deferred) {
          await interaction.editReply({ embeds: [errorEmbed] });
        } else {
          await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
      } catch {
        // Can't reply at all — interaction expired
        log.error(`[InteractionHandler:${options.name}] Failed to send error reply`);
      }
    } finally {
      if (deferTimer) clearTimeout(deferTimer);
    }
  };
}

/**
 * EphemeralFollowUp — Send a follow-up message after a long-running operation.
 * The initial reply is immediate and ephemeral ("Working on it..."),
 * and the follow-up replaces it when done.
 */
export async function withEphemeralProgress<T>(
  interaction: AnyRepliableInteraction,
  options: {
    startMessage?: string;
    successMessage?: string | ((result: T) => string);
    errorMessage?: string;
  },
  work: () => Promise<T>,
): Promise<T | null> {
  const startMsg = options.startMessage ?? '⏳ Working on it...';

  // Send immediate ephemeral response
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({ content: startMsg, ephemeral: true });
  } else if (interaction.deferred) {
    await interaction.editReply({ content: startMsg });
  }

  try {
    const result = await work();

    // Update with success
    const successMsg = typeof options.successMessage === 'function'
      ? options.successMessage(result)
      : options.successMessage ?? '✅ Done!';

    await interaction.editReply({ content: successMsg }).catch(() => { /* interaction may have expired */ });

    return result;
  } catch (err) {
    const errorMsg = options.errorMessage ?? '❌ Something went wrong. Please try again.';
    await interaction.editReply({ content: errorMsg }).catch(() => { /* interaction may have expired */ });
    log.error('Operation failed:', err);
    return null;
  }
}

/**
 * Create a rate-limited interaction handler.
 * Prevents command spam by showing a cooldown message.
 */
export function withCooldown(
  handler: InteractionHandler,
  cooldownMs: number = 5000,
): InteractionHandler {
  const cooldowns = new Map<string, number>();

  return async (interaction) => {
    const userId = interaction.user.id;
    const now = Date.now();
    const lastUse = cooldowns.get(userId) ?? 0;
    const remaining = cooldownMs - (now - lastUse);

    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      await interaction.reply({
        content: `⏳ Please wait ${seconds}s before using this again.`,
        ephemeral: true,
      }).catch((e: unknown) => { log.warn('Suppressed error:', (e as Error)?.message ?? e); });
      return;
    }

    cooldowns.set(userId, now);

    // Cleanup old entries every 100 uses
    if (cooldowns.size > 1000) {
      for (const [uid, ts] of cooldowns) {
        if (now - ts > cooldownMs * 2) cooldowns.delete(uid);
      }
    }

    await handler(interaction);
  };
}
