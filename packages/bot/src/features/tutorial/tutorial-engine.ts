/**
 * Tutorial Engine — Manages interactive server tutorials.
 *
 * V53 Phase 3 (Finding 3.2 — M-8)
 *
 * Displays a paginated embed walkthrough with Previous/Next/Skip buttons.
 * Tracks progress in DB. Can be triggered manually via /tutorial or
 * automatically on first command (configurable).
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ComponentType,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyBrand, brandedEmbed, resolveBrandKit, type BrandKit } from '../branding/index.js';

// ── Types ─────────────────────────────────────────────────

export interface TutorialStep {
  id: string;
  step_order: number;
  title: string;
  description: string;
  image_url: string | null;
  built_in_key: string | null;
  enabled: boolean;
}

interface TutorialProgress {
  guild_id: string;
  user_id: string;
  current_step: number;
  completed: boolean;
}

// ── Built-in steps (default tutorial) ─────────────────────

const BUILT_IN_STEPS: Array<{ key: string; title: string; description: string }> = [
  {
    key: 'welcome',
    title: '👋 Welcome to the Server!',
    description:
      "Hey there! This quick tutorial will show you around the server's features. " +
      "Use the buttons below to navigate — you can always run `/tutorial` again later.",
  },
  {
    key: 'economy',
    title: '💰 Economy System',
    description:
      'Earn coins with `/daily`, `/work`, `/beg`, and `/search`. ' +
      'Grow your wealth through `/rob`, `/crime`, or play it safe with `/passive`.\n\n' +
      '**Pro tip:** Use `/shop` to buy items and `/inventory` to manage them. ' +
      'Check your balance with `/balance`.',
  },
  {
    key: 'leveling',
    title: '📈 Leveling & XP',
    description:
      'You earn XP by chatting! As you level up, you unlock role rewards.\n\n' +
      'Check your rank with `/rank` and see the leaderboard with `/leaderboard`.',
  },
  {
    key: 'music',
    title: '🎵 Music',
    description:
      'Play music in voice channels with `/play <song>`. Use `/queue` to see what\'s up next, ' +
      '`/skip` to skip, and `/nowplaying` for the current track.',
  },
  {
    key: 'tickets',
    title: '🎫 Support Tickets',
    description:
      'Need help? Open a support ticket through the ticket panel in the designated channel. ' +
      'Staff will get back to you as soon as possible.',
  },
  {
    key: 'fun',
    title: '🎮 Fun & Games',
    description:
      "There's plenty to explore — fishing, farming, pets, adventures, and more!\n\n" +
      "Use `/timers` to see your cooldowns and never miss a collection.\n\n" +
      "That's the basics — enjoy your time here! 🎉",
  },
];

// ── Engine ────────────────────────────────────────────────

export class TutorialEngine {
  constructor(
    private supabase: SupabaseClient,
    private guildId: string,
  ) {}

  /**
   * Start or resume a tutorial for the given user.
   */
  async startTutorial(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;

    // Get guild steps
    const steps = await this.getSteps();
    if (steps.length === 0) {
      if ('reply' in interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '📋 No tutorial has been set up for this server yet.',
          ephemeral: true,
        });
      }
      return;
    }

    // Get or create progress
    const progress = await this.getProgress(userId);
    const currentStep = progress?.completed ? 0 : (progress?.current_step ?? 0);

    // Show the tutorial
    await this.showStep(interaction, steps, currentStep, userId);
  }

  /**
   * Check if user should see auto-trigger tutorial (first command).
   */
  async shouldAutoTrigger(userId: string): Promise<boolean> {
    const { data: config } = await this.supabase
      .from('tutorial_configs')
      .select('enabled, auto_trigger, trigger_mode')
      .eq('guild_id', this.guildId)
      .maybeSingle();

    if (!config?.enabled || !config?.auto_trigger) return false;
    if (config.trigger_mode !== 'first_command') return false;

    // Check if user has progress — if not, they haven't seen the tutorial
    const { data: progress } = await this.supabase
      .from('tutorial_progress')
      .select('completed')
      .eq('guild_id', this.guildId)
      .eq('user_id', userId)
      .maybeSingle();

    return !progress; // No record = hasn't started
  }

  // ── Internal ────────────────────────────────────────────

  private async getSteps(): Promise<TutorialStep[]> {
    const { data: customSteps } = await this.supabase
      .from('tutorial_steps')
      .select('*')
      .eq('guild_id', this.guildId)
      .eq('enabled', true)
      .order('step_order', { ascending: true })
      .limit(1000);

    if (customSteps && customSteps.length > 0) {
      return customSteps as TutorialStep[];
    }

    // Fall back to built-in steps
    return BUILT_IN_STEPS.map((s, i) => ({
      id: s.key,
      step_order: i,
      title: s.title,
      description: s.description,
      image_url: null,
      built_in_key: s.key,
      enabled: true,
    }));
  }

  private async getProgress(userId: string): Promise<TutorialProgress | null> {
    const { data } = await this.supabase
      .from('tutorial_progress')
      .select('*')
      .eq('guild_id', this.guildId)
      .eq('user_id', userId)
      .maybeSingle();
    return data as TutorialProgress | null;
  }

  private async updateProgress(userId: string, step: number, completed: boolean): Promise<void> {
    await this.supabase.from('tutorial_progress').upsert(
      {
        guild_id: this.guildId,
        user_id: userId,
        current_step: step,
        completed,
        ...(completed ? { completed_at: new Date().toISOString() } : {}),
      },
      { onConflict: 'guild_id,user_id' },
    );
  }

  private buildEmbed(step: TutorialStep, index: number, total: number, kit: BrandKit): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(step.title)
      .setDescription(step.description)
      .setFooter({ text: `Step ${index + 1} of ${total}` });

    if (step.image_url) {
      embed.setImage(step.image_url);
    }

    return applyBrand(embed, kit, { intent: 'info' });
  }

  private buildButtons(index: number, total: number): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (index > 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('tutorial_prev')
          .setLabel('← Previous')
          .setStyle(ButtonStyle.Secondary),
      );
    }

    if (index < total - 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('tutorial_next')
          .setLabel('Next →')
          .setStyle(ButtonStyle.Primary),
      );
    } else {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('tutorial_finish')
          .setLabel('✅ Done!')
          .setStyle(ButtonStyle.Success),
      );
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId('tutorial_skip')
        .setLabel('Skip Tutorial')
        .setStyle(ButtonStyle.Danger),
    );

    return row;
  }

  private async showStep(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    steps: TutorialStep[],
    stepIndex: number,
    userId: string,
  ): Promise<void> {
    const step = steps[stepIndex]!;
    // Kit resolved once per step render (cached), shared by the step embed and
    // the finish/skip terminal embeds below.
    const kit = await resolveBrandKit(this.supabase, this.guildId, {
      fallbackName: interaction.guild?.name,
    });
    const embed = this.buildEmbed(step, stepIndex, steps.length, kit);
    const row = this.buildButtons(stepIndex, steps.length);

    const messagePayload = { embeds: [embed], components: [row], ephemeral: true as const };

    let message;
    if (interaction instanceof ButtonInteraction) {
      await interaction.update({ embeds: [embed], components: [row] });
      message = interaction.message;
    } else {
      if (interaction.deferred || interaction.replied) {
        message = await interaction.editReply(messagePayload);
      } else {
        message = await interaction.reply({ ...messagePayload, fetchReply: true });
      }
    }

    // Save progress
    await this.updateProgress(userId, stepIndex, false);

    // Wait for button click
    try {
      const collected = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === userId,
        time: 300_000, // 5 minutes
      });

      switch (collected.customId) {
        case 'tutorial_prev':
          await this.showStep(collected, steps, Math.max(0, stepIndex - 1), userId);
          break;
        case 'tutorial_next':
          await this.showStep(collected, steps, Math.min(steps.length - 1, stepIndex + 1), userId);
          break;
        case 'tutorial_finish':
          await this.updateProgress(userId, stepIndex, true);
          await collected.update({
            embeds: [
              brandedEmbed(kit, {
                intent: 'primary',
                title: '🎉 Tutorial Complete!',
                description: "You're all set! Enjoy the server. Run `/tutorial` any time to revisit.",
              }),
            ],
            components: [],
          });
          break;
        case 'tutorial_skip':
          await this.updateProgress(userId, stepIndex, true);
          await collected.update({
            embeds: [
              brandedEmbed(kit, {
                intent: 'warning',
                title: '⏭️ Tutorial Skipped',
                description: 'No worries! Run `/tutorial` any time to see it again.',
              }),
            ],
            components: [],
          });
          break;
      }
    } catch {
      // Timeout — disable buttons
      try {
        if (interaction instanceof ButtonInteraction) {
          await interaction.editReply({ components: [] });
        } else {
          await interaction.editReply({ components: [] });
        }
      } catch {
        // Message may have been deleted
      }
    }
  }
}
