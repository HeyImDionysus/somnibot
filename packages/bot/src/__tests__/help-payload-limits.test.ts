import { describe, expect, it, vi } from 'vitest';
import type { APIEmbed } from 'discord.js';
import {
  chunkHelpItems,
  handleHelpCategorySelect,
  handleHelpCommand,
} from '../features/help/index.js';

function toEmbedJson(value: unknown): APIEmbed {
  if (typeof value !== 'object' || value === null || !('toJSON' in value)) {
    throw new Error('Expected a Discord embed builder');
  }
  const toJSON = value.toJSON;
  if (typeof toJSON !== 'function') throw new Error('Expected an embed toJSON method');
  return toJSON.call(value) as APIEmbed;
}

function embedCharacterCount(embed: APIEmbed): number {
  return (embed.title?.length ?? 0)
    + (embed.description?.length ?? 0)
    + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function largeRegistry(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `utility-${index}`,
    description: `Detailed utility command ${index} ${'x'.repeat(60)}`,
    type: 1,
  }));
}

describe('help payload limits', () => {
  it('chunks every item below Discord field limits without dropping commands', () => {
    const items = Array.from({ length: 140 }, (_, index) => `\`/utility-${index}\``);
    const chunks = chunkHelpItems(items, ', ');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1024)).toBe(true);
    for (const item of items) expect(chunks.join(', ')).toContain(item);
  });

  it('builds a valid overview for a production-sized uncategorized registry', async () => {
    let replyPayload: unknown;
    const interaction = {
      guildId: null,
      guild: undefined,
      options: { getString: vi.fn(() => null) },
      reply: vi.fn(async (payload: unknown) => { replyPayload = payload; }),
    } as unknown as Parameters<typeof handleHelpCommand>[0];
    const client = {
      _registeredCommands: largeRegistry(140),
    } as unknown as Parameters<typeof handleHelpCommand>[1];

    await handleHelpCommand(interaction, client);

    const embeds = (replyPayload as { embeds: unknown[] }).embeds.map(toEmbedJson);
    expect(embeds).toHaveLength(1);
    expect(embedCharacterCount(embeds[0])).toBeLessThanOrEqual(6000);
    expect(embeds[0].fields?.length).toBeLessThanOrEqual(25);
    expect(embeds[0].fields?.every((field) => field.value.length <= 1024)).toBe(true);
  });

  it('splits a large category across valid Discord embeds', async () => {
    let updatePayload: unknown;
    const interaction = {
      guildId: null,
      guild: undefined,
      values: ['Other'],
      update: vi.fn(async (payload: unknown) => { updatePayload = payload; }),
      reply: vi.fn(),
    } as unknown as Parameters<typeof handleHelpCategorySelect>[0];
    const client = {
      _registeredCommands: largeRegistry(140),
    } as unknown as Parameters<typeof handleHelpCategorySelect>[1];

    await handleHelpCategorySelect(interaction, client);

    const embeds = (updatePayload as { embeds: unknown[] }).embeds.map(toEmbedJson);
    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.length).toBeLessThanOrEqual(10);
    for (const embed of embeds) {
      expect(embedCharacterCount(embed)).toBeLessThanOrEqual(6000);
      expect(embed.fields?.length).toBeLessThanOrEqual(25);
      expect(embed.fields?.every((field) => field.value.length <= 1024)).toBe(true);
    }
  });
});
