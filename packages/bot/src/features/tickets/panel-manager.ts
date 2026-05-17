/**
 * Panel Manager — Handles posting and updating ticket panels in Discord channels.
 *
 * Panels are persistent messages with buttons or dropdowns for opening tickets.
 * Architecture doc §19.2
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
  type TextChannel,
  type Guild,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbTicketPanel, TicketTypeConfig } from '@somnibot/shared';
import { SOMNI_PALETTE } from '@somnibot/shared';

// ── Button Color Mapping ─────────────────────────────────

const BUTTON_STYLE_MAP: Record<string, ButtonStyle> = {
  blue: ButtonStyle.Primary,
  grey: ButtonStyle.Secondary,
  green: ButtonStyle.Success,
  red: ButtonStyle.Danger,
};

// ── Build Panel Message ──────────────────────────────────

function buildPanelEmbed(panel: DbTicketPanel): EmbedBuilder {
  const msg = panel.panel_message;
  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.HOT_PINK)
    .setTitle((msg.title as string) || panel.name || '🎫 Support Tickets')
    .setDescription(
      (msg.description as string) ||
        'Click a button below to open a ticket. Our team will assist you as soon as possible.',
    );

  if (msg.footer) {
    embed.setFooter({ text: msg.footer as string });
  }

  if (msg.thumbnail) {
    embed.setThumbnail(msg.thumbnail as string);
  }

  return embed;
}

function buildButtonsRow(
  panel: DbTicketPanel,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();

  for (let i = 0; i < panel.ticket_types.length; i++) {
    const tt = panel.ticket_types[i];
    const button = new ButtonBuilder()
      .setCustomId(`panel:open:${panel.id}:${tt.id}`)
      .setLabel(tt.label)
      .setStyle(BUTTON_STYLE_MAP[tt.color] || ButtonStyle.Primary);

    if (tt.emoji) {
      button.setEmoji(tt.emoji);
    }

    currentRow.addComponents(button);

    // Discord allows max 5 buttons per row
    if ((i + 1) % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    }
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function buildDropdownRow(
  panel: DbTicketPanel,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`panel:open:${panel.id}`)
    .setPlaceholder('Select a ticket category...')
    .addOptions(
      panel.ticket_types.map((tt) => ({
        label: tt.label,
        value: tt.id,
        description: tt.description || undefined,
        emoji: tt.emoji ? { name: tt.emoji } : undefined,
      })),
    );

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

// ── Post Panel ───────────────────────────────────────────

export async function postPanel(
  guild: Guild,
  panel: DbTicketPanel,
  supabase: SupabaseClient,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const channel = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: `Channel ${panel.channel_id} not found.` };
  }

  const embed = buildPanelEmbed(panel);
  const components =
    panel.input_mode === 'buttons' ? buildButtonsRow(panel) : [buildDropdownRow(panel)];

  try {
    // If the panel already has a message, try to edit it
    if (panel.message_id) {
      try {
        const existing = await channel.messages.fetch(panel.message_id);
        await existing.edit({ embeds: [embed], components });
        return { success: true, messageId: panel.message_id };
      } catch {
        // Message was deleted, post a new one
      }
    }

    const message = await channel.send({ embeds: [embed], components });

    // Update the panel with the message ID
    await supabase
      .from('ticket_panels')
      .update({ message_id: message.id })
      .eq('id', panel.id);

    console.log(`[Tickets] Panel "${panel.name}" posted in #${channel.name} (${message.id})`);
    return { success: true, messageId: message.id };
  } catch (err) {
    console.error('[Tickets] Failed to post panel:', err);
    return { success: false, error: 'Failed to post panel message.' };
  }
}

// ── Delete Panel Message ─────────────────────────────────

export async function deletePanelMessage(
  guild: Guild,
  panel: DbTicketPanel,
): Promise<void> {
  if (!panel.message_id) return;

  const channel = guild.channels.cache.get(panel.channel_id) as TextChannel | undefined;
  if (!channel) return;

  try {
    const message = await channel.messages.fetch(panel.message_id);
    await message.delete();
  } catch {
    // Message already deleted or not found
  }
}
