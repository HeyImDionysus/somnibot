/**
 * ProfilesManager — user profile cards, titles, bio.
 */
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { writeAuditLog } from '../../services/audit.js';
import {
  BRAND_KIT_COLUMNS,
  brandKitFromConfig,
  defaultBrandKit,
  resolveBrandKit,
  type BrandKit,
} from '../branding/brand-kit.js';
import { applyBrand } from '../branding/branded-embed.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Profiles');

// V10 Audit H-1: Guild-scoped manager registry for cache invalidation.
const _managers = new Map<string, ProfilesManager>();

export function registerProfilesManager(mgr: ProfilesManager, guildId: string): void {
  _managers.set(guildId, mgr);
}

/** V11 Audit M-2: Remove manager reference when guild context is destroyed. */
export function unregisterProfilesManager(guildId: string): void {
  _managers.delete(guildId);
}

export function invalidateProfilesCache(guildId?: string): void {
  if (guildId) {
    _managers.get(guildId)?.clearCache();
  } else {
    for (const mgr of _managers.values()) mgr?.clearCache();
  }
}

interface ProfileConfig {
  profilesEnabled: boolean;
  titleMaxLength: number;
  bioMaxLength: number;
  profileVisibility: 'everyone' | 'members-after-onboarding';
  contentFilterMode: 'lenient' | 'strict';
  showGameStats: boolean;
  /** White-label brand kit projected from the same cached guild_config row. */
  brandKit: BrandKit;
}

const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  profilesEnabled: true,
  titleMaxLength: 64,
  bioMaxLength: 256,
  profileVisibility: 'everyone',
  contentFilterMode: 'lenient',
  showGameStats: true,
  brandKit: defaultBrandKit(),
};

// Content filter word lists. Lenient blocks only clear violations; strict adds
// broader categories. Kept deliberately small + explicit (not exhaustive) —
// server owners choose the mode; the check is a substring match, case-folded.
const LENIENT_BLOCKLIST = ['nigger', 'faggot', 'kike', 'chink', 'retard'];
const STRICT_EXTRA_BLOCKLIST = ['fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'slut', 'whore'];

function isContentBlocked(text: string, mode: 'lenient' | 'strict'): boolean {
  const lower = text.toLowerCase();
  const list = mode === 'strict' ? [...LENIENT_BLOCKLIST, ...STRICT_EXTRA_BLOCKLIST] : LENIENT_BLOCKLIST;
  return list.some((w) => lower.includes(w));
}

export class ProfilesManager {
  private supabase: SupabaseClient;
  private cache = new Map<string, any>();
  private configCache = new Map<string, { data: ProfileConfig; time: number }>();
  // Lightweight replay fence for /title and /bio, keyed by interaction id. A
  // re-delivered interaction (gateway RESUME/redelivery) must not re-run the
  // write or re-confirm — the writes are value-idempotent, so skipping is safe.
  private processedWrites = new Map<string, number>();
  private static readonly WRITE_DEDUP_TTL_MS = 10 * 60_000;

  private eventBus: PlatformEventBus;

  constructor(supabase: SupabaseClient, eventBus: PlatformEventBus = defaultEventBus) {
    this.supabase = supabase;
    this.eventBus = eventBus;
  }

  clearCache(): void { this.cache.clear(); this.configCache.clear(); this.processedWrites.clear(); }

  /**
   * Returns true when this interaction id was already handled (a replay), else
   * records it and returns false. Prunes expired entries as it goes so the map
   * stays bounded.
   */
  private isReplayedWrite(interactionId: string): boolean {
    const now = Date.now();
    if (this.processedWrites.size > 500) {
      for (const [id, t] of this.processedWrites) {
        if (now - t > ProfilesManager.WRITE_DEDUP_TTL_MS) this.processedWrites.delete(id);
      }
    }
    const seen = this.processedWrites.get(interactionId);
    if (seen !== undefined && now - seen < ProfilesManager.WRITE_DEDUP_TTL_MS) return true;
    this.processedWrites.set(interactionId, now);
    return false;
  }

  private async getConfig(guildId: string): Promise<ProfileConfig> {
    const now = Date.now();
    const cached = this.configCache.get(guildId);
    if (cached && now - cached.time < 60_000) return cached.data;

    const { data } = await this.supabase
      .from('guild_config')
      .select(`profiles_enabled, title_max_length, bio_max_length, profile_visibility, content_filter_mode, show_game_stats, ${BRAND_KIT_COLUMNS}`)
      .eq('guild_id', guildId)
      .maybeSingle();

    const cfg: ProfileConfig = data
      ? {
          profilesEnabled: data.profiles_enabled ?? DEFAULT_PROFILE_CONFIG.profilesEnabled,
          titleMaxLength: data.title_max_length ?? DEFAULT_PROFILE_CONFIG.titleMaxLength,
          bioMaxLength: data.bio_max_length ?? DEFAULT_PROFILE_CONFIG.bioMaxLength,
          profileVisibility: data.profile_visibility === 'members-after-onboarding' ? 'members-after-onboarding' : 'everyone',
          contentFilterMode: data.content_filter_mode === 'strict' ? 'strict' : 'lenient',
          showGameStats: data.show_game_stats ?? DEFAULT_PROFILE_CONFIG.showGameStats,
          brandKit: brandKitFromConfig(data, undefined),
        }
      : { ...DEFAULT_PROFILE_CONFIG };
    this.configCache.set(guildId, { data: cfg, time: now });
    return cfg;
  }

  /** Whether a viewer may see the target's profile under the visibility policy. */
  private async canView(guildId: string, viewerId: string, targetId: string, cfg: ProfileConfig): Promise<boolean> {
    if (cfg.profileVisibility === 'everyone' || viewerId === targetId) return true;
    // members-after-onboarding: the viewer must have completed onboarding.
    const { data } = await this.supabase
      .from('members')
      .select('onboarding_completed')
      .eq('guild_id', guildId)
      .eq('discord_id', viewerId)
      .maybeSingle();
    return data?.onboarding_completed === true;
  }

  /**
   * Load (or create on first use) the member's profile row. Returns null ONLY
   * when the read/write itself FAILED (a database outage) — never for a merely
   * missing row — so callers can degrade honestly instead of rendering a
   * fabricated empty profile from a read that never happened.
   */
  private async getOrCreateProfile(guildId: string, userId: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from('economy_profiles').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle();
    if (data) return data;
    if (error) return null; // the read failed (outage) — unavailable, not "no profile yet"

    const { data: created } = await this.supabase
      .from('economy_profiles').insert({ guild_id: guildId, user_id: userId }).select().single();
    return created ?? null;
  }

  /**
   * The branded profiles-unavailable degradation notice (catalog message
   * `profiles-unavailable`). The brand read is itself outage-safe:
   * resolveBrandKit never throws and the guild name is the fallback, so this
   * reply always lands even while the database is unreachable.
   */
  private async replyProfilesUnavailable(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const brandKit = await resolveBrandKit(this.supabase, guildId, { fallbackName: interaction.guild?.name })
      .catch(() => null);
    const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
    const content = `⚠️ ${name}'s profiles are snoozing for a second — please try again shortly.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }

  async viewProfile(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId!;
    const cfg = await this.getConfig(guildId);

    if (!cfg.profilesEnabled) {
      await interaction.editReply({ content: '❌ Member profiles are disabled on this server.' });
      return;
    }
    if (!(await this.canView(guildId, interaction.user.id, target.id, cfg))) {
      await interaction.editReply({
        content: '🔒 Profiles are visible to onboarded members only — finish onboarding to view others’ profiles.',
      });
      return;
    }

    const profile = await this.getOrCreateProfile(guildId, target.id);
    // DEPFAIL fail-soft: a FAILED profile read is not an empty profile.
    // Rendering a zeroed card during a database outage tells members a
    // data-shaped lie about state the bot could not read — degrade honestly
    // with the branded unavailable notice instead (catalog `profiles-unavailable`).
    if (profile == null) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }

    // V52-L3: await the atomic RPC and log errors instead of fire-and-forget.
    // The old code had a non-atomic read-modify-write fallback that could lose
    // concurrent increments; the RPC has existed since V40 so the fallback was
    // dead code that only hid failures.
    const { error: viewErr } = await this.supabase.rpc('increment_profile_views', {
      p_guild_id: guildId,
      p_user_id: target.id,
    });
    if (viewErr) log.error('increment_profile_views failed:', viewErr.message);

    // Fetch wallet, pet, prestige, achievements in parallel
    const [walletRes, petRes, prestigeRes, achRes] = await Promise.all([
      this.supabase.from('economy_wallets').select('wallet, bank').eq('guild_id', guildId).eq('user_id', target.id).single(),
      this.supabase.from('economy_pets').select('name, pet_type, level, prestige').eq('guild_id', guildId).eq('user_id', target.id).single(),
      this.supabase.from('economy_prestige').select('prestige_level, multiplier_pct').eq('guild_id', guildId).eq('user_id', target.id).single(),
      this.supabase.from('economy_user_achievements').select('*', { count: 'exact', head: true }).eq('guild_id', guildId).eq('user_id', target.id),
    ]);
    // Same fail-soft rule for the standing reads: a genuine read FAILURE (not a
    // merely-missing row — .single() surfaces that as PGRST116) must never
    // render as a zero balance / zero achievements.
    const readFailed = (err: { code?: string } | null): boolean =>
      err != null && err.code !== 'PGRST116';
    if (
      readFailed(walletRes.error) ||
      readFailed(petRes.error) ||
      readFailed(prestigeRes.error) ||
      readFailed(achRes.error)
    ) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }

    const wallet = walletRes.data;
    const pet = petRes.data;
    const prestige = prestigeRes.data;
    const achCount = achRes.count;

    const balance = wallet?.wallet ?? 0;
    const bank = wallet?.bank ?? 0;
    const netWorth = balance + bank;

    const embed = applyBrand(
      new EmbedBuilder()
        .setTitle(`${profile?.title ? `${profile.title} ` : ''}${target.username}`)
        .setThumbnail(target.displayAvatarURL()),
      cfg.brandKit,
      { intent: 'info' },
    );

    if (profile?.bio) embed.setDescription(profile.bio);

    // show-game-stats: play-money standing (net worth / wallet / bank / pet /
    // prestige) is shown only when enabled. Real-store data is never shown here.
    if (cfg.showGameStats) {
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
    // Replay fence: a re-delivered interaction skips the write + confirmation.
    if (this.isReplayedWrite(interaction.id)) return;
    const title = interaction.options.getString('title')!;
    const guildId = interaction.guildId!;
    const cfg = await this.getConfig(guildId);

    if (!cfg.profilesEnabled) {
      await interaction.reply({ content: '❌ Member profiles are disabled on this server.', ephemeral: true });
      return;
    }
    // Enforce the owner-tuned cap server-side (Discord's option cap is 64, but an
    // owner may tighten it below that). Truncate rather than drop the edit.
    const truncated = title.length > cfg.titleMaxLength;
    const finalTitle = truncated ? title.slice(0, cfg.titleMaxLength) : title;
    if (isContentBlocked(finalTitle, cfg.contentFilterMode)) {
      // Catalog failure lane content-filter-rejected: audit the rejected attempt
      // (profiles.content_rejected, success=false); the prior value stays put.
      await writeAuditLog(this.supabase, {
        guildId,
        actorType: 'discord',
        actorId: interaction.user.id,
        action: 'profiles.content_rejected',
        category: 'profiles',
        targetType: 'member',
        targetId: interaction.user.id,
        details: { field: 'title', mode: cfg.contentFilterMode, interactionId: interaction.id },
        success: false,
      });
      await interaction.reply({
        content: '❌ That title was blocked by the content filter. Please choose different wording; contact a moderator to appeal.',
        ephemeral: true,
      });
      return;
    }

    // DEPFAIL fail-soft: never confirm a save that did not land. A failed
    // profile ensure or a failed UPDATE (database outage) degrades to the
    // branded unavailable notice; the prior value stays untouched.
    const titleProfileRow = await this.getOrCreateProfile(guildId, interaction.user.id);
    if (titleProfileRow == null) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }
    const { error: titleWriteErr } = await this.supabase.from('economy_profiles')
      .update({ title: finalTitle, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId).eq('user_id', interaction.user.id);
    if (titleWriteErr) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }

    // [community-profiles] Append-only audit row on the title save (the catalog
    // contracts one audit row per member-profile state change). Written directly
    // so it lands synchronously with the save, not on the batched event pipeline.
    await writeAuditLog(this.supabase, {
      guildId,
      actorType: 'discord',
      actorId: interaction.user.id,
      action: 'profiles.title_updated',
      category: 'profiles',
      targetType: 'member',
      targetId: interaction.user.id,
      details: { value: finalTitle, truncated, interactionId: interaction.id },
    });

    this.eventBus.emit('profile.updated', guildId, {
      userId: interaction.user.id,
      field: 'title',
      value: finalTitle,
      truncated,
    });

    await interaction.reply({
      content: truncated
        ? `✅ Title set (truncated to the ${cfg.titleMaxLength}-char limit): **${finalTitle}**`
        : `✅ Title set to: **${finalTitle}**`,
    });
  }

  async setBio(interaction: ChatInputCommandInteraction): Promise<void> {
    // Replay fence: a re-delivered interaction skips the write + confirmation.
    if (this.isReplayedWrite(interaction.id)) return;
    const bio = interaction.options.getString('bio')!;
    const guildId = interaction.guildId!;
    const cfg = await this.getConfig(guildId);

    if (!cfg.profilesEnabled) {
      await interaction.reply({ content: '❌ Member profiles are disabled on this server.', ephemeral: true });
      return;
    }
    const truncated = bio.length > cfg.bioMaxLength;
    const finalBio = truncated ? bio.slice(0, cfg.bioMaxLength) : bio;
    if (isContentBlocked(finalBio, cfg.contentFilterMode)) {
      // Catalog failure lane content-filter-rejected: audit the rejected attempt
      // (profiles.content_rejected, success=false); the prior value stays put.
      await writeAuditLog(this.supabase, {
        guildId,
        actorType: 'discord',
        actorId: interaction.user.id,
        action: 'profiles.content_rejected',
        category: 'profiles',
        targetType: 'member',
        targetId: interaction.user.id,
        details: { field: 'bio', mode: cfg.contentFilterMode, interactionId: interaction.id },
        success: false,
      });
      await interaction.reply({
        content: '❌ That bio was blocked by the content filter. Please choose different wording; contact a moderator to appeal.',
        ephemeral: true,
      });
      return;
    }

    // DEPFAIL fail-soft: never confirm a save that did not land (see setTitle).
    const bioProfileRow = await this.getOrCreateProfile(guildId, interaction.user.id);
    if (bioProfileRow == null) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }
    const { error: bioWriteErr } = await this.supabase.from('economy_profiles')
      .update({ bio: finalBio, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId).eq('user_id', interaction.user.id);
    if (bioWriteErr) {
      await this.replyProfilesUnavailable(interaction);
      return;
    }

    // [community-profiles] Append-only audit row on the bio save (the catalog
    // contracts one audit row per member-profile state change). Written directly
    // so it lands synchronously with the save, not on the batched event pipeline.
    await writeAuditLog(this.supabase, {
      guildId,
      actorType: 'discord',
      actorId: interaction.user.id,
      action: 'profiles.bio_updated',
      category: 'profiles',
      targetType: 'member',
      targetId: interaction.user.id,
      details: { value: finalBio, truncated, interactionId: interaction.id },
    });

    this.eventBus.emit('profile.updated', guildId, {
      userId: interaction.user.id,
      field: 'bio',
      value: finalBio,
      truncated,
    });

    await interaction.reply({
      content: truncated ? `✅ Bio updated (truncated to the ${cfg.bioMaxLength}-char limit).` : '✅ Bio updated!',
    });
  }
}
