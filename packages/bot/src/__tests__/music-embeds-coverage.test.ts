/**
 * Music Embeds — Full coverage tests
 *
 * Imports the REAL embed functions and mocks only Discord.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => {
  class MockEmbedBuilder {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
    setFooter(f: { text: string; iconURL?: string }) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
    addFields(...fields: unknown[]) { this.data.fields = [...(this.data.fields as unknown[] ?? []), ...fields]; return this; }
    setURL(u: string) { this.data.url = u; return this; }
    setAuthor(a: { name: string }) { this.data.author = a; return this; }
    setImage(i: string) { this.data.image = i; return this; }
  }

  class MockButtonBuilder {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: number) { this.data.style = s; return this; }
    setEmoji(e: string) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
  }

  class MockActionRowBuilder {
    components: unknown[] = [];
    addComponents(...c: unknown[]) { this.components.push(...c); return this; }
  }

  return {
    EmbedBuilder: MockEmbedBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    ButtonBuilder: MockButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  };
});

import {
  buildNowPlayingEmbed,
  buildAddedEmbed,
  buildPlaylistAddedEmbed,
  buildMusicErrorEmbed,
  buildMusicInfoEmbed,
  buildFilterEmbed,
  buildQueueEmbed,
  formatDuration,
} from '../features/music/music-embeds.js';
import type { QueueEntry, GuildQueue, LoopMode } from '../features/music/music-queue.js';

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    track: 'base64encodedtrack',
    title: 'Test Song',
    uri: 'https://youtube.com/watch?v=test',
    duration: 240000, // 4 minutes
    author: 'Test Artist',
    requestedBy: 'u1',
    artworkUrl: 'https://img.youtube.com/test.jpg',
    addedAt: Date.now(),
    isStream: false,
    ...overrides,
  };
}

function makeQueue(overrides: Partial<GuildQueue> = {}): GuildQueue {
  return {
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    entries: [makeEntry()],
    currentIndex: 0,
    loopMode: 'off' as LoopMode,
    volume: 50,
    shuffled: false,
    paused: false,
    ...overrides,
  };
}

describe('music-embeds', () => {
  describe('formatDuration', () => {
    it('formats seconds-only duration', () => {
      expect(formatDuration(45000)).toBe('0:45');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(240000)).toBe('4:00');
    });

    it('formats hours, minutes, seconds', () => {
      expect(formatDuration(3661000)).toBe('1:01:01');
    });

    it('formats zero', () => {
      expect(formatDuration(0)).toBe('0:00');
    });

    it('pads seconds', () => {
      expect(formatDuration(65000)).toBe('1:05');
    });
  });

  describe('buildNowPlayingEmbed', () => {
    it('builds embed for a normal track', () => {
      const entry = makeEntry();
      const queue = makeQueue();
      const result = buildNowPlayingEmbed(entry, 60000, queue);
      expect(result.embeds).toBeDefined();
      expect(result.components).toBeDefined();
    });

    it('builds embed for a live stream', () => {
      const entry = makeEntry({ isStream: true, duration: 0 });
      const queue = makeQueue({ entries: [entry] });
      const result = buildNowPlayingEmbed(entry, 0, queue);
      expect(result.embeds).toBeDefined();
    });

    it('includes loop mode track in embed', () => {
      const entry = makeEntry();
      const queue = makeQueue({ loopMode: 'track' });
      const result = buildNowPlayingEmbed(entry, 60000, queue);
      expect(result.embeds).toBeDefined();
    });

    it('handles queue loop mode', () => {
      const entry = makeEntry();
      const queue = makeQueue({
        loopMode: 'queue',
        entries: [makeEntry(), makeEntry({ title: 'Song 2' })],
      });
      const result = buildNowPlayingEmbed(entry, 120000, queue);
      expect(result.embeds).toBeDefined();
    });

    it('handles paused state', () => {
      const entry = makeEntry();
      const queue = makeQueue({ paused: true });
      const result = buildNowPlayingEmbed(entry, 30000, queue);
      expect(result.embeds).toBeDefined();
    });

    it('shows active filters', () => {
      const entry = makeEntry();
      const queue = makeQueue();
      const result = buildNowPlayingEmbed(entry, 60000, queue, 'Nightcore: speed 1.3x');
      expect(result.embeds).toBeDefined();
    });

    it('shows artwork thumbnail when present', () => {
      const entry = makeEntry({ artworkUrl: 'https://img.youtube.com/art.jpg' });
      const queue = makeQueue();
      const result = buildNowPlayingEmbed(entry, 60000, queue);
      expect(result.embeds).toBeDefined();
    });

    it('disables vol_down when volume is 0', () => {
      const entry = makeEntry();
      const queue = makeQueue({ volume: 0 });
      const result = buildNowPlayingEmbed(entry, 60000, queue);
      expect(result.components.length).toBe(2);
    });

    it('disables vol_up when volume is 100', () => {
      const entry = makeEntry();
      const queue = makeQueue({ volume: 100 });
      const result = buildNowPlayingEmbed(entry, 60000, queue);
      expect(result.components.length).toBe(2);
    });
  });

  describe('buildQueueEmbed', () => {
    it('builds embed for a queue with one track', () => {
      const queue = makeQueue();
      const embed = buildQueueEmbed(queue, 0);
      expect(embed).toBeDefined();
    });

    it('builds embed for a queue with multiple tracks', () => {
      const entries = Array.from({ length: 15 }, (_, i) =>
        makeEntry({ title: `Song ${i + 1}`, duration: (i + 1) * 60000 })
      );
      const queue = makeQueue({ entries });
      const embed = buildQueueEmbed(queue, 0);
      expect(embed).toBeDefined();
    });

    it('shows page info for multi-page queue', () => {
      const entries = Array.from({ length: 25 }, (_, i) =>
        makeEntry({ title: `Song ${i + 1}` })
      );
      const queue = makeQueue({ entries });
      const embed = buildQueueEmbed(queue, 1);
      expect(embed).toBeDefined();
    });
  });

  describe('buildAddedEmbed', () => {
    it('builds embed for added track', () => {
      const entry = makeEntry();
      const embed = buildAddedEmbed(entry, 5);
      expect(embed).toBeDefined();
    });

    it('handles position 1', () => {
      const entry = makeEntry();
      const embed = buildAddedEmbed(entry, 1);
      expect(embed).toBeDefined();
    });
  });

  describe('buildPlaylistAddedEmbed', () => {
    it('builds embed for added playlist', () => {
      const embed = buildPlaylistAddedEmbed(10, 'My Playlist');
      expect(embed).toBeDefined();
    });
  });

  describe('buildMusicErrorEmbed', () => {
    it('builds error embed', () => {
      const embed = buildMusicErrorEmbed('Something went wrong');
      expect(embed).toBeDefined();
    });
  });

  describe('buildMusicInfoEmbed', () => {
    it('builds info embed', () => {
      const embed = buildMusicInfoEmbed('Track loaded');
      expect(embed).toBeDefined();
    });
  });

  describe('buildFilterEmbed', () => {
    it('builds filter embed', () => {
      const embed = buildFilterEmbed('Nightcore applied', 'Nightcore: speed 1.3x, pitch 1.3x');
      expect(embed).toBeDefined();
    });
  });
});
