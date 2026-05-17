/**
 * Welcome Card Generator — Creates image-based welcome cards using @napi-rs/canvas.
 *
 * Generates a Discord-native dark-themed card with:
 * - Server icon
 * - User avatar (circular, with border)
 * - Welcome text
 * - Member number
 *
 * The card uses the SomniBot palette by default but can be customized
 * via the dashboard (background image URL, accent color).
 */

import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { join } from 'node:path';
import type { GuildMember, Guild } from 'discord.js';

// ── SomniBot Palette ──────────────────────────────────────────
const COLORS = {
  BG_PRIMARY: '#0D0D0D',       // NEAR_BLACK
  BG_SECONDARY: '#1a1a2e',     // Dark navy tint
  BG_GRADIENT_START: '#0D0D0D',
  BG_GRADIENT_END: '#1a1a2e',
  ACCENT: '#FF1493',           // HOT_PINK
  ACCENT_SECONDARY: '#00D4FF', // CYAN
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: '#B5BAC1',
  TEXT_MUTED: '#949BA4',
  BORDER: '#FF1493',
  AVATAR_RING: '#00D4FF',
} as const;

// ── Card Dimensions ───────────────────────────────────────────
const CARD_WIDTH = 934;
const CARD_HEIGHT = 282;
const AVATAR_SIZE = 160;
const AVATAR_X = CARD_WIDTH / 2;
const AVATAR_Y = 80;
const PADDING = 30;

export interface WelcomeCardOptions {
  member: GuildMember;
  guild: Guild;
  memberNumber: number;
  backgroundUrl?: string | null;
  accentColor?: string;
}

/**
 * Generate a welcome card as a Buffer (PNG).
 */
export async function generateWelcomeCard(
  options: WelcomeCardOptions,
): Promise<Buffer> {
  const { member, guild, memberNumber, backgroundUrl, accentColor } = options;
  const accent = accentColor ?? COLORS.ACCENT;

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  // ── Background ────────────────────────────────────────────
  if (backgroundUrl) {
    try {
      const bgImage = await loadImage(backgroundUrl);
      ctx.drawImage(bgImage, 0, 0, CARD_WIDTH, CARD_HEIGHT);
      // Dark overlay for readability
      ctx.fillStyle = 'rgba(13, 13, 13, 0.65)';
      ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    } catch {
      drawDefaultBackground(ctx);
    }
  } else {
    drawDefaultBackground(ctx);
  }

  // ── Border glow effect ────────────────────────────────────
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 1.5, 1.5, CARD_WIDTH - 3, CARD_HEIGHT - 3, 20);
  ctx.stroke();

  // ── Subtle accent line at top ─────────────────────────────
  const topGradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, 0);
  topGradient.addColorStop(0, 'transparent');
  topGradient.addColorStop(0.3, accent);
  topGradient.addColorStop(0.7, COLORS.ACCENT_SECONDARY);
  topGradient.addColorStop(1, 'transparent');
  ctx.fillStyle = topGradient;
  ctx.fillRect(20, 0, CARD_WIDTH - 40, 3);

  // ── Avatar ────────────────────────────────────────────────
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
  try {
    const avatarImg = await loadImage(avatarUrl);

    // Avatar ring (outer glow)
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_SIZE / 2 + 6, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.AVATAR_RING;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();

    // Clip to circle and draw avatar
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(
      avatarImg,
      AVATAR_X - AVATAR_SIZE / 2,
      AVATAR_Y - AVATAR_SIZE / 2,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    ctx.restore();
  } catch {
    // Fallback: colored circle with initial
    ctx.beginPath();
    ctx.arc(AVATAR_X, AVATAR_Y, AVATAR_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();

    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      member.user.displayName.charAt(0).toUpperCase(),
      AVATAR_X,
      AVATAR_Y,
    );
  }

  // ── Welcome Text ──────────────────────────────────────────
  const welcomeY = AVATAR_Y + AVATAR_SIZE / 2 + 35;

  // "Welcome to {server}!"
  ctx.fillStyle = COLORS.TEXT_PRIMARY;
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`Welcome to ${guild.name}!`, AVATAR_X, welcomeY);

  // Username
  ctx.fillStyle = accent;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(member.user.displayName, AVATAR_X, welcomeY + 36);

  // Member number
  ctx.fillStyle = COLORS.TEXT_MUTED;
  ctx.font = '16px sans-serif';
  ctx.fillText(
    `Member #${memberNumber.toLocaleString()}`,
    AVATAR_X,
    welcomeY + 64,
  );

  return canvas.toBuffer('image/png');
}

/**
 * Draw the default gradient background.
 */
function drawDefaultBackground(ctx: SKRSContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  gradient.addColorStop(0, COLORS.BG_GRADIENT_START);
  gradient.addColorStop(1, COLORS.BG_GRADIENT_END);
  ctx.fillStyle = gradient;
  roundRect(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 20);
  ctx.fill();

  // Subtle noise/texture dots
  ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * CARD_WIDTH;
    const y = Math.random() * CARD_HEIGHT;
    ctx.fillRect(x, y, 1, 1);
  }
}

/**
 * Draw a rounded rectangle path.
 */
function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
