/**
 * /timers — Shows which cooldowns are active and how long until they reset.
 *
 * V53 Phase 3 (Finding 3.1 — B-2)
 *
 * Queries Valkey TTL for all known cooldown keys for the calling user.
 * Groups by category (Economy, Fishing, Gathering, Heist, XP).
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';

// ── Cooldown definitions ──────────────────────────────────

interface CooldownDef {
  /** Human label */
  label: string;
  /** Category for grouping */
  category: string;
  /** Valkey key pattern — {guildId} and {userId} will be replaced */
  keyPattern: string;
  /** Emoji prefix */
  emoji: string;
}

const COOLDOWNS: CooldownDef[] = [
  // Economy — timed rewards
  { label: 'Daily', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:daily', emoji: '📅' },
  { label: 'Weekly', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:weekly', emoji: '📆' },
  { label: 'Monthly', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:monthly', emoji: '🗓️' },
  // Economy — actions
  { label: 'Work', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:work', emoji: '🔨' },
  { label: 'Crime', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:crime', emoji: '🔫' },
  { label: 'Beg', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:beg', emoji: '🙏' },
  { label: 'Search', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:search', emoji: '🔍' },
  { label: 'Rob', category: 'Economy', keyPattern: 'economy:{guildId}:{userId}:rob', emoji: '💰' },
  // Fishing
  { label: 'Fish', category: 'Fishing', keyPattern: 'fishing:{guildId}:{userId}', emoji: '🎣' },
  // Gathering
  { label: 'Hunt', category: 'Gathering', keyPattern: 'economy:gather:{guildId}:{userId}:hunt', emoji: '🏹' },
  { label: 'Dig', category: 'Gathering', keyPattern: 'economy:gather:{guildId}:{userId}:dig', emoji: '⛏️' },
  { label: 'Mine', category: 'Gathering', keyPattern: 'economy:gather:{guildId}:{userId}:mine', emoji: '🪨' },
  // Heist (server-wide cooldown, not per-user)
  { label: 'Heist', category: 'Heist', keyPattern: 'heist:cd:{guildId}', emoji: '🏦' },
  // XP
  { label: 'XP Cooldown', category: 'XP', keyPattern: 'xp:cooldown:{guildId}:{userId}', emoji: '⭐' },
];

// ── Command builder ───────────────────────────────────────

export function buildTimersCommand() {
  return new SlashCommandBuilder()
    .setName('timers')
    .setDescription('See all your active cooldowns and when they reset');
}

// ── Handler ───────────────────────────────────────────────

export async function handleTimersCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client as SomniClient;
  const valkey = client.valkey;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  // Build all keys
  const keys = COOLDOWNS.map((cd) => ({
    ...cd,
    key: cd.keyPattern
      .replace('{guildId}', guildId)
      .replace('{userId}', userId),
  }));

  // Pipeline TTL queries for efficiency
  const pipeline = valkey.pipeline();
  for (const k of keys) {
    pipeline.pttl(k.key); // milliseconds remaining
  }
  const results = await pipeline.exec();

  // Build per-category lines
  const categoryLines: Record<string, string[]> = {};
  for (let i = 0; i < keys.length; i++) {
    const def = keys[i];
    const [err, pttl] = (results?.[i] ?? [null, -2]) as [Error | null, number];
    if (err) continue;

    // pttl: -2 = key doesn't exist (ready), -1 = no expiry (shouldn't happen), >0 = on cooldown
    const onCooldown = pttl > 0;
    const line = onCooldown
      ? `${def.emoji} ${def.label}: ⏳ ${formatMs(pttl)}`
      : `${def.emoji} ${def.label}: ✅ Ready`;

    if (!categoryLines[def.category]) {
      categoryLines[def.category] = [];
    }
    categoryLines[def.category].push(line);
  }

  // Also check role income cooldowns (dynamic — need to query which roles exist)
  try {
    const { data: roleIncomes } = await client.supabase
      .from('economy_role_income')
      .select('role_id, role_name, cooldown_hours')
      .eq('guild_id', guildId);

    if (roleIncomes && roleIncomes.length > 0) {
      const riPipeline = valkey.pipeline();
      for (const ri of roleIncomes) {
        riPipeline.pttl(`economy:${guildId}:${userId}:role_income:${ri.role_id}`);
      }
      const riResults = await riPipeline.exec();
      const riLines: string[] = [];
      for (let i = 0; i < roleIncomes.length; i++) {
        const ri = roleIncomes[i];
        const [err, pttl] = (riResults?.[i] ?? [null, -2]) as [Error | null, number];
        if (err) continue;
        const onCooldown = pttl > 0;
        riLines.push(
          onCooldown
            ? `💼 ${ri.role_name}: ⏳ ${formatMs(pttl)}`
            : `💼 ${ri.role_name}: ✅ Ready`,
        );
      }
      if (riLines.length > 0) {
        if (!categoryLines['Role Income']) categoryLines['Role Income'] = [];
        categoryLines['Role Income'].push(...riLines);
      }
    }
  } catch {
    // Role income lookup failed — skip silently
  }

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle('⏱️ Your Cooldowns')
    .setColor(0x5865f2)
    .setFooter({ text: `Requested by ${interaction.user.displayName}` })
    .setTimestamp();

  const categoryOrder = ['Economy', 'Role Income', 'Fishing', 'Gathering', 'Heist', 'XP'];
  for (const cat of categoryOrder) {
    const lines = categoryLines[cat];
    if (lines && lines.length > 0) {
      embed.addFields({ name: cat, value: lines.join('\n'), inline: false });
    }
  }

  if (embed.data.fields?.length === 0) {
    embed.setDescription('No cooldowns found — the economy system may not be active.');
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Helpers ───────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
