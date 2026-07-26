/**
 * Rank Card Generator — creates visual rank cards using @napi-rs/canvas.
 *
 * Architecture doc §24.7
 */
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { levelProgress, totalXpForLevel, LEVEL_CONFIG } from '@somnibot/shared';

interface RankCardOptions {
  username: string;
  avatarUrl: string;
  xp: number;
  rank: number;
  totalMessages: number;
  // Customization
  backgroundColor?: string;
  accentColor?: string;
  progressBarColor?: string;
  overlayOpacity?: number;
  backgroundImageUrl?: string;
}

const CARD_WIDTH = 934;
const CARD_HEIGHT = 282;

const DEFAULT_BG = '#1e1f22';
const DEFAULT_ACCENT = '#FF1493';
const DEFAULT_PROGRESS = '#FF1493';
const DEFAULT_OPACITY = 0.7;

function numToHex(n: number | null | undefined): string | undefined {
  if (n == null) return undefined;
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * Load rank card settings for a user (per-user overrides + server defaults).
 */
export async function loadRankCardSettings(
  supabase: SupabaseClient,
  guildId: string,
  memberId: string,
): Promise<{
  backgroundUrl: string | null;
  accentColor: string;
  progressBarColor: string;
  overlayOpacity: number;
}> {
  // Check for per-user overrides
  const { data: userSettings } = await supabase
    .from('member_rank_settings')
    .select('*')
    .eq('guild_id', guildId)
    .eq('member_id', memberId)
    .maybeSingle();

  // Get server defaults
  const { data: guildConfig } = await supabase
    .from('guild_config')
    .select('rank_card_accent_color, rank_card_background')
    .eq('guild_id', guildId)
    .maybeSingle();

  const serverAccent = numToHex(guildConfig?.rank_card_accent_color) ?? DEFAULT_ACCENT;
  const serverBg = guildConfig?.rank_card_background ?? null;

  return {
    backgroundUrl: userSettings?.background_url ?? serverBg,
    accentColor: numToHex(userSettings?.accent_color) ?? serverAccent,
    progressBarColor: numToHex(userSettings?.progress_bar_color) ?? serverAccent,
    overlayOpacity: userSettings?.overlay_opacity ?? DEFAULT_OPACITY,
  };
}

/**
 * Generate a rank card as a PNG buffer.
 */
export async function generateRankCard(options: RankCardOptions): Promise<Buffer> {
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  const accent = options.accentColor ?? DEFAULT_ACCENT;
  const progressColor = options.progressBarColor ?? DEFAULT_PROGRESS;
  const overlayOpacity = options.overlayOpacity ?? DEFAULT_OPACITY;

  // ── Background ────────────────────────────────────
  // Draw base background
  ctx.fillStyle = DEFAULT_BG;
  ctx.beginPath();
  ctx.roundRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 20);
  ctx.fill();
  ctx.clip();

  // Draw background image if provided
  if (options.backgroundImageUrl) {
    try {
      const bgImg = await loadImage(options.backgroundImageUrl);
      ctx.drawImage(bgImg, 0, 0, CARD_WIDTH, CARD_HEIGHT);
      // Overlay for readability
      ctx.fillStyle = `rgba(0, 0, 0, ${overlayOpacity})`;
      ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    } catch {
      // Failed to load background — use solid color
    }
  }

  // ── Avatar ────────────────────────────────────────
  const avatarSize = 160;
  const avatarX = 50;
  const avatarY = (CARD_HEIGHT - avatarSize) / 2;

  try {
    const avatar = await loadImage(options.avatarUrl);
    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
    ctx.restore();

    // Avatar border
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 2, 0, Math.PI * 2);
    ctx.stroke();
  } catch {
    // Draw placeholder circle
    ctx.fillStyle = '#5865f2';
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Text ──────────────────────────────────────────
  const textX = avatarX + avatarSize + 40;
  const textWidth = CARD_WIDTH - textX - 40;

  // Username
  ctx.fillStyle = '#f2f3f5';
  ctx.font = 'bold 32px sans-serif';
  const displayName = options.username.length > 20
    ? options.username.slice(0, 18) + '…'
    : options.username;
  ctx.fillText(displayName, textX, 70);

  // Level-curve parity: derive the displayed level from the SAME XP the
  // progress bar uses (levelProgress), never from a stored level column —
  // the number and the bar can then never disagree.
  const progress = levelProgress(options.xp);

  // Level & Rank
  ctx.fillStyle = '#b5bac1';
  ctx.font = '22px sans-serif';
  ctx.fillText(`Level ${progress.level}  ·  Rank #${options.rank}`, textX, 105);

  // ── Progress Bar ──────────────────────────────────
  const barY = 135;
  const barHeight = 28;
  const barRadius = 14;

  // Background bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.roundRect(textX, barY, textWidth, barHeight, barRadius);
  ctx.fill();

  // Filled bar
  const fillWidth = Math.max(barRadius * 2, (progress.progressPercent / 100) * textWidth);
  ctx.fillStyle = progressColor;
  ctx.beginPath();
  ctx.roundRect(textX, barY, fillWidth, barHeight, barRadius);
  ctx.fill();

  // XP text on bar
  ctx.fillStyle = '#f2f3f5';
  ctx.font = 'bold 14px sans-serif';
  const xpText = `${progress.currentLevelXp.toLocaleString()} / ${progress.xpForNextLevel.toLocaleString()} XP`;
  const xpTextWidth = ctx.measureText(xpText).width;
  ctx.fillText(xpText, textX + textWidth - xpTextWidth - 10, barY + 20);

  // ── Stats Row ─────────────────────────────────────
  const statsY = barY + barHeight + 40;

  ctx.fillStyle = '#949ba4';
  ctx.font = '18px sans-serif';
  ctx.fillText(`Total: ${options.xp.toLocaleString()} XP`, textX, statsY);

  ctx.fillText(`Messages: ${options.totalMessages.toLocaleString()}`, textX + 260, statsY);

  return Buffer.from(canvas.toBuffer('image/png'));
}
