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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type StringSelectMenuInteraction,
  type TextChannel,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { createLogger } from '@somnibot/shared';
import { applyBrand, resolveBrandKit } from '../branding/index.js';

const log = createLogger('ButtonRoles');

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

function selectMenuEmoji(raw: string): { name?: string; id?: string; animated?: boolean } {
  const custom = raw.match(/^<(a?):([^:>]+):(\d+)>$/);
  if (custom) return { animated: custom[1] === 'a', name: custom[2], id: custom[3] };
  return { name: raw };
}

/**
 * Handle a button role toggle interaction.
 */
export async function handleButtonRoleInteraction(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus = defaultEventBus,
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

  // FIX #12: Guard against null btnRole — if no row exists (deleted panel,
  // missing config), the handler must bail out instead of proceeding to
  // toggle the role, which would let users give themselves any role ID
  // embedded in old button messages.
  if (!btnRole) {
    await interaction.reply({ content: '❌ This role button is no longer configured.', ephemeral: true });
    return true;
  }

  // Respect the active flag — disabled button roles should not toggle
  if (btnRole.active === false) {
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
      eventBus.emit('role.lost', guild.id, {
        discordId: member.id,
        roleId,
        roleName: guild.roles.cache.get(roleId)?.name ?? roleId,
        source: 'bot',
      });
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
          .neq('role_id', roleId)
          .limit(1000);

        if (groupEntries) {
          const rolesToRemove = groupEntries
            .map((e) => e.role_id)
            .filter((rid) => member.roles.cache.has(rid));
          for (const rid of rolesToRemove) {
            const removed = await member.roles.remove(rid, 'Button role exclusive group swap')
              .then(() => true)
              .catch((e: unknown) => { log.warn('Role operation failed:', (e as Error)?.message ?? e); return false; });
            if (removed) {
              eventBus.emit('role.lost', guild.id, {
                discordId: member.id,
                roleId: rid,
                roleName: guild.roles.cache.get(rid)?.name ?? rid,
                source: 'bot',
              });
            }
          }
        }
      }

      await member.roles.add(roleId, 'Button role toggle');
      eventBus.emit('role.gained', guild.id, {
        discordId: member.id,
        roleId,
        roleName: guild.roles.cache.get(roleId)?.name ?? roleId,
        source: 'bot',
      });
      await interaction.reply({
        content: `✅ Added <@&${roleId}>.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    log.error('Failed to toggle role:', { error: String(err) });
    await interaction.reply({
      content: '❌ Failed to update your role. The role may be higher than my highest role.',
      ephemeral: true,
    });
  }

  return true;
}

/** Handle a select-menu role panel (`selrole:{panelId}`). */
export async function handleSelectMenuRoleInteraction(
  interaction: StringSelectMenuInteraction,
  supabase: SupabaseClient,
  eventBus: PlatformEventBus = defaultEventBus,
): Promise<boolean> {
  if (!interaction.customId.startsWith('selrole:')) return false;
  const panelId = interaction.customId.slice('selrole:'.length);
  if (!panelId || !interaction.values.length || !interaction.guild) return true;

  const guild = interaction.guild as Guild;
  const { data: entries } = await supabase
    .from('button_roles')
    .select('role_id, active, require_role, require_level, exclusive_group')
    .eq('guild_id', guild.id)
    .eq('panel_id', panelId)
    .in('role_id', interaction.values)
    .limit(25);
  const configured = (entries ?? []) as Array<{
    role_id: string;
    active: boolean;
    require_role: string | null;
    require_level: number | null;
    exclusive_group: string | null;
  }>;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return true;

  let changed = 0;
  for (const entry of configured) {
    if (!entry.active) continue;
    if (entry.require_role && !member.roles.cache.has(entry.require_role)) continue;
    if (entry.require_level && entry.require_level > 0) {
      const { data: levelData } = await supabase.from('member_levels').select('level')
        .eq('guild_id', guild.id).eq('member_id', member.id).maybeSingle();
      if ((levelData?.level ?? 0) < entry.require_level) continue;
    }
    try {
      if (member.roles.cache.has(entry.role_id)) {
        await member.roles.remove(entry.role_id, 'Select-menu role toggle');
        eventBus.emit('role.lost', guild.id, {
          discordId: member.id, roleId: entry.role_id,
          roleName: guild.roles.cache.get(entry.role_id)?.name ?? entry.role_id,
          source: 'bot',
        });
      } else {
        if (entry.exclusive_group) {
          const { data: peers } = await supabase.from('button_roles').select('role_id')
            .eq('guild_id', guild.id).eq('panel_id', panelId)
            .eq('exclusive_group', entry.exclusive_group).neq('role_id', entry.role_id).limit(25);
          for (const peer of peers ?? []) {
            if (member.roles.cache.has(peer.role_id)) await member.roles.remove(peer.role_id, 'Select-menu exclusive group swap');
          }
        }
        await member.roles.add(entry.role_id, 'Select-menu role toggle');
        eventBus.emit('role.gained', guild.id, {
          discordId: member.id, roleId: entry.role_id,
          roleName: guild.roles.cache.get(entry.role_id)?.name ?? entry.role_id,
          source: 'bot',
        });
      }
      changed++;
    } catch (err) {
      log.warn('Select-menu role operation failed:', { error: String(err) });
    }
  }
  await interaction.reply({ content: changed ? `✅ Updated ${changed} role(s).` : '❌ No eligible roles selected.', ephemeral: true });
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
    .order('sort_order', { ascending: true })
    .limit(1000);

  if (!entries || entries.length === 0) {
    return { success: false, error: 'No active roles configured for this panel.' };
  }

  const roles = entries as ButtonRoleEntry[];
  const channelId = roles[0]!.channel_id;

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }

  const kit = await resolveBrandKit(supabase, guild.id, { fallbackName: guild.name });
  const embed = new EmbedBuilder()
    .setTitle('🎭 Role Selection')
    .setDescription('Click a button below to toggle a role on or off.')
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'info' });

  const { data: guildConfig } = await supabase.from('guild_config').select('default_style')
    .eq('guild_id', guild.id).maybeSingle();
  const interactionStyle = guildConfig?.default_style === 'select-menu' ? 'select-menu' : 'buttons';

  // Build the configured Discord surface. Buttons support up to 25 entries;
  // select menus support the same option count in one row.
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (interactionStyle === 'select-menu') {
    const menu = new StringSelectMenuBuilder().setCustomId(`selrole:${panelId}`)
      .setPlaceholder('Choose roles…').setMinValues(1).setMaxValues(Math.min(roles.length, 25));
    for (const entry of roles.slice(0, 25)) {
      const option = new StringSelectMenuOptionBuilder().setLabel(entry.label.slice(0, 100))
        .setValue(entry.role_id);
      if (entry.emoji) option.setEmoji(selectMenuEmoji(entry.emoji));
      menu.addOptions(option);
    }
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
  } else {
    let currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    let buttonCount = 0;
    for (const entry of roles) {
      if (buttonCount >= 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder<MessageActionRowComponentBuilder>();
        buttonCount = 0;
      }
      if (rows.length >= 5) break;
      const button = new ButtonBuilder().setCustomId(`btnrole:${panelId}:${entry.role_id}`)
        .setLabel(entry.label.slice(0, 80)).setStyle(STYLE_MAP[entry.style] ?? ButtonStyle.Secondary);
      if (entry.emoji) button.setEmoji(entry.emoji);
      currentRow.addComponents(button);
      buttonCount++;
    }
    if (buttonCount > 0) rows.push(currentRow);
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

/** Deploy every configured non-reaction panel for a guild after a settings or CRUD change. */
export async function deployButtonRolePanelsForGuild(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  const { data } = await supabase.from('button_roles').select('panel_id')
    .eq('guild_id', guild.id).eq('active', true).limit(1000);
  const rows = (data ?? []) as Array<{ panel_id?: string | null }>;
  const panelIds = [...new Set(
    rows.map((row) => row.panel_id).filter((panelId): panelId is string => Boolean(panelId)),
  )];
  for (const panelId of panelIds) {
    await deployButtonRolesPanel(guild, supabase, panelId).catch((err) => {
      log.warn(`Failed to deploy role panel ${panelId}:`, { error: String(err) });
    });
  }
}
