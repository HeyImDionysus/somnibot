/**
 * ProfilesManager — user profile cards, titles, bio.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Profiles');

let _manager: ProfilesManager | null = null;
export function registerProfilesManager(mgr: ProfilesManager): void { _manager = mgr; }
export function invalidateProfilesCache(): void { _manager?.clearCache(); }

export class ProfilesManager {
  private supabase: SupabaseClient;
  private cache = new Map<string, any>();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase as any;
  }

  clearCache(): void { this.cache.clear(); }

  private async getOrCreateProfile(guildId: string, userId: string): Promise<any> {
    const { data } = await (this.supabase as any)
      .from('economy_profiles').select('*').eq('guild_id', guildId).eq('user_id', userId).single();
    if (data) return data;

    const { data: created } = await (this.supabase as any)
      .from('economy_profiles').insert({ guild_id: guildId, user_id: userId }).select().single();
    return created;
  }

  async viewProfile(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId!;
    const profile = await this.getOrCreateProfile(guildId, target.id);

    // V52-L3: await the atomic RPC and log errors instead of fire-and-forget.
    // The old code had a non-atomic read-modify-write fallback that could lose
    // concurrent increments; the RPC has existed since V40 so the fallback was
    // dead code that only hid failures.
    const { error: viewErr } = await (this.supabase as any).rpc('increment_profile_views', {
      p_guild_id: guildId,
      p_user_id: target.id,
    });
    if (viewErr) log.error('increment_profile_views failed:', viewErr.message);

    // Fetch wallet, pet, prestige, achievements in parallel
    const [walletRes, petRes, prestigeRes, achRes] = await Promise.all([
      (this.supabase as any).from('economy_wallets').select('wallet, bank').eq('guild_id', guildId).eq('user_id', target.id).single(),
      (this.supabase as any).from('economy_pets').select('name, pet_type, level, prestige').eq('guild_id', guildId).eq('user_id', target.id).single(),
      (this.supabase as any).from('economy_prestige').select('prestige_level, multiplier_pct').eq('guild_id', guildId).eq('user_id', target.id).single(),
      (this.supabase as any).from('economy_user_achievements').select('*', { count: 'exact', head: true }).eq('guild_id', guildId).eq('user_id', target.id),
    ]);
    const wallet = walletRes.data;
    const pet = petRes.data;
    const prestige = prestigeRes.data;
    const achCount = achRes.count;

    const balance = wallet?.wallet ?? 0;
    const bank = wallet?.bank ?? 0;
    const netWorth = balance + bank;

    const embed = new EmbedBuilder()
      .setTitle(`${profile?.title ? `${profile.title} ` : ''}${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setColor(0x5865F2);

    if (profile?.bio) embed.setDescription(profile.bio);

    embed.addFields(
      { name: '💰 Net Worth', value: netWorth.toLocaleString(), inline: true },
      { name: '👛 Wallet', value: balance.toLocaleString(), inline: true },
      { name: '🏦 Bank', value: bank.toLocaleString(), inline: true },
    );

    if (pet) {
      embed.addFields({
        name: '🐾 Pet',
        value: `${pet.name} (${pet.pet_type} Lv.${pet.level}${pet.prestige > 0 ? ` ⭐${pet.prestige}` : ''})`,
        inline: true,
      });
    }

    if (prestige && prestige.prestige_level > 0) {
      embed.addFields({
        name: '⭐ Prestige',
        value: `Level ${prestige.prestige_level} (+${prestige.multiplier_pct}% earnings)`,
        inline: true,
      });
    }

    embed.addFields(
      { name: '🏆 Achievements', value: `${achCount ?? 0} unlocked`, inline: true },
      { name: '👁️ Profile Views', value: `${(profile?.profile_views ?? 0) + 1}`, inline: true },
    );

    if (profile?.badge_slots && profile.badge_slots.length > 0) {
      embed.addFields({ name: 'Badges', value: profile.badge_slots.join(' '), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  async setTitle(interaction: ChatInputCommandInteraction): Promise<void> {
    const title = interaction.options.getString('title')!;
    const guildId = interaction.guildId!;
    await this.getOrCreateProfile(guildId, interaction.user.id);

    await (this.supabase as any).from('economy_profiles')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId).eq('user_id', interaction.user.id);

    await interaction.reply({ content: `✅ Title set to: **${title}**` });
  }

  async setBio(interaction: ChatInputCommandInteraction): Promise<void> {
    const bio = interaction.options.getString('bio')!;
    const guildId = interaction.guildId!;
    await this.getOrCreateProfile(guildId, interaction.user.id);

    await (this.supabase as any).from('economy_profiles')
      .update({ bio, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId).eq('user_id', interaction.user.id);

    await interaction.reply({ content: '✅ Bio updated!' });
  }
}
