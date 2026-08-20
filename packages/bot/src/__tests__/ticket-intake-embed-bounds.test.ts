import { describe, expect, it } from 'vitest';
import { buildIntakeResponseEmbeds } from '../features/tickets/ticket-interactions.js';
import { defaultBrandKit } from '../features/branding/brand-kit.js';

describe('ticket intake response embeds', () => {
  it('keeps five maximum-length answers within Discord embed description bounds', () => {
    const responses = Array.from({ length: 5 }, (_, index) => ({
      label: `Question ${index + 1}`,
      value: String(index).repeat(4_000),
    }));

    const embeds = buildIntakeResponseEmbeds(responses, defaultBrandKit('Support'), 'member');

    expect(embeds).toHaveLength(5);
    expect(embeds.every((embed) => (embed.data.description?.length ?? 0) <= 4_096)).toBe(true);
    expect(embeds.map((embed) => embed.data.description)).toEqual(responses.map(({ value }) => value));
  });
});
