/**
 * Button Roles — Toggle roles via persistent button interactions.
 *
 * V17 Behavioral Audit — Item 3
 *
 * Complements existing emoji-based reaction roles with a button-based
 * system, which is the 2026 standard (no reaction intent required,
 * cleaner UX, works in embeds).
 *
 * Custom ID format: `btnrole:{panelId}:{roleId}`
 *
 * Dashboard manages button_roles table; bot handles the interactions.
 */

import {
  type ButtonInteraction,
  type Guild,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';

interface ButtonRoleEntry {
  id: string;
  guild_id: string;
  panel_id: string;
  channel_id: string;
  message_id: string | null;
  label: string;
  emoji: string | null;
  role_id: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  sort_order: number;
  active: boolean;
  exclusive_group: string | null;
  require_role: string | null;
  require_level: number | null;
}

const STYLE_MAP: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/**
 * Handle a button role toggle interaction.
 */
export async function handleButtonRoleInteraction(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith('btnrole:')) return false;

  const parts = customId.split(':');
  const panelId = parts[1];
  const roleId = parts[2];

  if (!roleId || !panelId) {
    await interaction.reply({ content: '❌ Invalid button configuration.', ephemeral: true });
    return true;
  }

  const guild = interaction.guild as Guild;
  if (!guild) return true;

  // Fetch the button role entry to check active, requirements, and exclusive group
  const { data: btnRole } = await supabase
    .from('button_roles')
    .select('active, exclusive_group, require_role, require_level')
    .eq('guild_id', guild.id)
    .eq('panel_id', panelId)
    .eq('role_id', roleId)
    .maybeSingle();

  // Respect the active flag — disabled button roles should not toggle
  if (btnRole && btnRole.active === false) {
    await interaction.reply({ content: '❌ This role button is currently disabled.', ephemeral: true });
    return true;
  }

  const member = await guild.members.fetch(interaction.user.id);

  // Check require_role gate
  if (btnRole?.require_role && !member.roles.cache.has(btnRole.require_role)) {
    await interaction.reply({
      content: `❌ You need the <@&${btnRole.require_role}> role to use this button.`,
      ephemeral: true,
    });
    return true;
  }

  // Check require_level gate
  if (btnRole?.require_level && btnRole.require_level > 0) {
    const { data: levelData } = await supabase
      .from('member_levels')
      .select('level')
      .eq('guild_id', guild.id)
      .eq('member_id', member.id)
      .maybeSingle();
    const memberLevel = levelData?.level ?? 0;
    if (memberLevel < btnRole.require_level) {
      await interaction.reply({
        content: `❌ You need to be level ${btnRole.require_level} or higher (you are level ${memberLevel}).`,
        ephemeral: true,
      });
      return true;
    }
  }

  // Toggle role
  const hasRole = member.roles.cache.has(roleId);

  try {
    if (hasRole) {
      await member.roles.remove(roleId, 'Button role toggle');
      await interaction.reply({
        content: `✅ Removed <@&${roleId}>.`,
        ephemeral: true,
      });
    } else {
      // Exclusive group: remove other roles in the same group before adding
      if (btnRole?.exclusive_group) {
        const { data: groupEntries } = await supabase
          .from('button_roles')
          .select('role_id')
          .eq('guild_id', guild.id)
          .eq('exclusive_group', btnRole.exclusive_group)
          .neq('role_id', roleId);

        if (groupEntries) {
          const rolesToRemove = groupEntries
            .map((e) => e.role_id)
            .filter((rid) => member.roles.cache.has(rid));
          for (const rid of rolesToRemove) {
            await member.roles.remove(rid, 'Button role exclusive group swap').catch(() => {});
          }
        }
      }

      await member.roles.add(roleId, 'Button role toggle');
      await interaction.reply({
        content: `✅ Added <@&${roleId}>.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('[ButtonRoles] Failed to toggle role:', err);
    await interaction.reply({
      content: '❌ Failed to update your role. The role may be higher than my highest role.',
      ephemeral: true,
    });
  }

  return true;
}

/**
 * Deploy a button roles panel to a channel (called from dashboard or commands).
 */
export async function deployButtonRolesPanel(
  guild: Guild,
  supabase: SupabaseClient,
  panelId: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: entries } = await supabase
    .from('button_roles')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('panel_id', panelId)
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (!entries || entries.length === 0) {
    return { success: false, error: 'No active roles configured for this panel.' };
  }

  const roles = entries as ButtonRoleEntry[];
  const channelId = roles[0]!.channel_id;

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Role Selection')
    .setDescription('Click a button below to toggle a role on or off.')
    .setTimestamp();

  // Build rows (max 5 buttons per row, max 5 rows)
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  let buttonCount = 0;

  for (const entry of roles) {
    if (buttonCount >= 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
      buttonCount = 0;
    }
    if (rows.length >= 5) break; // Discord limit

    const button = new ButtonBuilder()
      .setCustomId(`btnrole:${panelId}:${entry.role_id}`)
      .setLabel(entry.label)
      .setStyle(STYLE_MAP[entry.style] ?? ButtonStyle.Secondary);

    if (entry.emoji) {
      button.setEmoji(entry.emoji);
    }

    currentRow.addComponents(button);
    buttonCount++;
  }

  if (buttonCount > 0) {
    rows.push(currentRow);
  }

  // Check if message already exists
  const existingMessageId = roles[0]!.message_id;
  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed], components: rows });
      return { success: true };
    } catch {
      // Message deleted — create new one below
    }
  }

  // Send new message
  const msg = await channel.send({ embeds: [embed], components: rows });

  // Update all entries with the message ID
  await supabase
    .from('button_roles')
    .update({ message_id: msg.id })
    .eq('guild_id', guild.id)
    .eq('panel_id', panelId);

  return { success: true };
}
