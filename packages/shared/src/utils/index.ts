/**
 * Shared utility functions used by both bot and dashboard.
 */
import { randomInt } from 'node:crypto';

/**
 * Generate an order number in the format SMNI-XXXXX.
 *
 * V10 Audit §4.P3b — Uses crypto.randomInt to avoid collisions under
 * load and for consistency with the CSPRNG policy.
 */
export function generateOrderNumber(): string {
  const seq = randomInt(1, 100000);
  return `SMNI-${seq.toString().padStart(5, '0')}`;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunk an array into groups of a given size.
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Clamp a number between a min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a Discord snowflake ID as a Discord mention string.
 */
export function mentionUser(id: string): string {
  return `<@${id}>`;
}

export function mentionRole(id: string): string {
  return `<@&${id}>`;
}

export function mentionChannel(id: string): string {
  return `<#${id}>`;
}

/**
 * Check if a Discord snowflake ID is valid.
 */
export function isValidSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/**
 * Format a number with commas (e.g., 1,234,567).
 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}
