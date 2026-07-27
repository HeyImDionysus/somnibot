/**
 * /mydata — Member data export command.
 *
 * V53 Phase 3 (Finding 3.3 — B-5)
 *
 * Compiles all user data into a JSON file and DMs it to the member.
 * Uses a single RPC call to aggregate all tables in one query.
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { createLogger } from '@somnibot/shared';
import { applyBrand, resolveBrandKit } from '../branding/index.js';

const log = createLogger('MyData');

// ── Command builder ───────────────────────────────────────

export function buildMyDataCommand() {
  return new SlashCommandBuilder()
    .setName('mydata')
    .setDescription('Export all your data from this server as a JSON file');
}

// ── Handler ───────────────────────────────────────────────

export async function handleMyDataCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client as SomniClient;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  try {
    const data = await collectMemberData(client, guildId, userId);

    const jsonStr = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, {
      name: `mydata-${guildId}-${userId}.json`,
      description: 'Your server data export',
    });

    // Attempt to DM the user
    try {
      const kit = await resolveBrandKit(client.supabase, guildId, {
        fallbackName: interaction.guild?.name,
      });
      const dmChannel = await interaction.user.createDM();
      await dmChannel.send({
        embeds: [
          applyBrand(
            new EmbedBuilder()
              .setTitle('📦 Your Data Export')
              .setDescription(
                `Here's all the data we have stored for you on **${interaction.guild?.name ?? 'this server'}**.`,
              )
              .setFooter({ text: 'This file contains your personal data — keep it safe.' })
              .setTimestamp(),
            kit,
            { intent: 'info' },
          ),
        ],
        files: [attachment],
      });

      await interaction.editReply({
        content: '✅ Your data has been sent to your DMs! Check your direct messages.',
      });
    } catch {
      // DMs disabled — send in the ephemeral reply instead
      await interaction.editReply({
        content:
          "⚠️ I couldn't DM you (you may have DMs disabled). Here's your data directly:",
        files: [attachment],
      });
    }
  } catch (err) {
    log.error('Failed to export data:', { error: String(err) });
    await interaction.editReply({
      content: '❌ Something went wrong exporting your data. Please try again later.',
    });
  }
}

// ── Data collection ───────────────────────────────────────

interface MemberDataExport {
  exported_at: string;
  guild_id: string;
  user_id: string;
  economy: {
    wallet: Record<string, unknown> | null;
    streaks: Record<string, unknown> | null;
    transactions: Record<string, unknown>[];
    inventory: Record<string, unknown>[];
    prestige: Record<string, unknown> | null;
    profile: Record<string, unknown> | null;
  };
  levels: {
    level_data: Record<string, unknown> | null;
    rewards_received: Record<string, unknown>[];
  };
  farming: {
    plots: Record<string, unknown>[];
  };
  fishing: {
    catches: Record<string, unknown>[];
  };
  pets: Record<string, unknown>[];
  achievements: Record<string, unknown>[];
  quests: Record<string, unknown>[];
  market: {
    listings: Record<string, unknown>[];
  };
  adventures: {
    sessions: Record<string, unknown>[];
  };
  moderation: {
    infractions: Record<string, unknown>[];
  };
  tickets: {
    tickets: Record<string, unknown>[];
  };
  polls: {
    votes: Record<string, unknown>[];
  };
}

async function collectMemberData(
  client: SomniClient,
  guildId: string,
  userId: string,
): Promise<MemberDataExport> {
  const sb = client.supabase;

  // Run all queries in parallel for speed
  const [
    walletRes,
    streaksRes,
    transactionsRes,
    inventoryRes,
    prestigeRes,
    profileRes,
    levelRes,
    rewardsRes,
    plotsRes,
    catchesRes,
    petsRes,
    achievementsRes,
    questsRes,
    listingsRes,
    adventuresRes,
    infractionsRes,
    ticketsRes,
    votesRes,
  ] = await Promise.all([
    sb.from('economy_wallets').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle(),
    sb.from('economy_streaks').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle(),
    sb.from('economy_transactions').select('*').eq('guild_id', guildId).eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
    sb.from('economy_inventory').select('*, economy_items(name, description, rarity)').eq('guild_id', guildId).eq('user_id', userId).limit(1000),
    sb.from('economy_prestige').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle(),
    sb.from('economy_profiles').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle(),
    sb.from('member_levels').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle(),
    sb.from('level_rewards').select('*').eq('guild_id', guildId).limit(1000),
    sb.from('economy_farm_plots').select('*, economy_crops(name, emoji)').eq('guild_id', guildId).eq('user_id', userId),
    sb.from('economy_fish_catches').select('*, economy_fish_species(name, emoji, rarity)').eq('guild_id', guildId).eq('user_id', userId).order('caught_at', { ascending: false }).limit(200),
    sb.from('economy_pets').select('*').eq('guild_id', guildId).eq('owner_id', userId).limit(1000),
    sb.from('economy_user_achievements').select('*, economy_achievement_defs(name, description)').eq('guild_id', guildId).eq('user_id', userId).limit(1000),
    sb.from('economy_quest_progress').select('*, economy_quest_templates(title, description)').eq('guild_id', guildId).eq('user_id', userId),
    sb.from('economy_market_listings').select('*').eq('guild_id', guildId).eq('seller_id', userId).order('created_at', { ascending: false }).limit(200),
    sb.from('economy_adventure_sessions').select('*').eq('guild_id', guildId).eq('user_id', userId).order('started_at', { ascending: false }).limit(100),
    sb.from('infractions').select('id, type, reason, moderator_id, created_at, expires_at, active').eq('guild_id', guildId).eq('member_id', userId).order('created_at', { ascending: false }).limit(1000),
    sb.from('tickets').select('id, ticket_number, type, status, created_at, closed_at').eq('guild_id', guildId).eq('creator_id', userId).order('created_at', { ascending: false }).limit(1000),
    sb.from('poll_votes').select('*, polls(title), poll_options(label)').eq('guild_id', guildId).eq('user_id', userId).limit(1000),
  ]);

  return {
    exported_at: new Date().toISOString(),
    guild_id: guildId,
    user_id: userId,
    economy: {
      wallet: walletRes.data,
      streaks: streaksRes.data,
      transactions: transactionsRes.data ?? [],
      inventory: inventoryRes.data ?? [],
      prestige: prestigeRes.data,
      profile: profileRes.data,
    },
    levels: {
      level_data: levelRes.data,
      rewards_received: rewardsRes.data ?? [],
    },
    farming: {
      plots: plotsRes.data ?? [],
    },
    fishing: {
      catches: catchesRes.data ?? [],
    },
    pets: petsRes.data ?? [],
    achievements: achievementsRes.data ?? [],
    quests: questsRes.data ?? [],
    market: {
      listings: listingsRes.data ?? [],
    },
    adventures: {
      sessions: adventuresRes.data ?? [],
    },
    moderation: {
      infractions: infractionsRes.data ?? [],
    },
    tickets: {
      tickets: ticketsRes.data ?? [],
    },
    polls: {
      votes: votesRes.data ?? [],
    },
  };
}
