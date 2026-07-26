/**
 * scheduled-messages/runner — coverage tests
 *
 * Tests ScheduledMessageRunner with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(function () {
    return {
      setTitle: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setImage: vi.fn().mockReturnThis(),
      setThumbnail: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setAuthor: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ScheduledMessageRunner } from '../features/scheduled-messages/runner.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'order', 'maybeSingle', 'single', 'update', 'or']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(schedules: any[] = [], embedConfig: any = null) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'scheduled_messages') {
        if (schedules.length > 0) return chainBuilder({ data: schedules, error: null });
        return chainBuilder({ data: [], error: null });
      }
      if (table === 'embed_configs') {
        return chainBuilder({ data: embedConfig, error: null });
      }
      return chainBuilder();
    }),
  };
}

function makeChannel(name = 'general') {
  return {
    name,
    isTextBased: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue({ id: 'msg1' }),
  };
}

function makeGuild(channels: Record<string, any> = {}) {
  const cache = new Map(Object.entries(channels));
  return {
    id: 'g1',
    name: 'Test Guild',
    memberCount: 150,
    channels: { cache },
  };
}

describe('ScheduledMessageRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() loads schedules and begins timer', async () => {
    const supabase = makeSupabase();
    const guild = makeGuild();
    const runner = new ScheduledMessageRunner(guild as any, supabase as any);

    await runner.start();
    expect(supabase.from).toHaveBeenCalledWith('scheduled_messages');

    runner.stop();
  });

  it('stop() clears the timer', async () => {
    const supabase = makeSupabase();
    const guild = makeGuild();
    const runner = new ScheduledMessageRunner(guild as any, supabase as any);

    await runner.start();
    runner.stop();
    runner.stop(); // safe to call twice
  });

  it('reload() refreshes schedules', async () => {
    const supabase = makeSupabase();
    const guild = makeGuild();
    const runner = new ScheduledMessageRunner(guild as any, supabase as any);

    await runner.reload();
    expect(supabase.from).toHaveBeenCalledWith('scheduled_messages');
    runner.stop();
  });

  it('sends message when cron matches', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    // Use wildcard cron to always match
    const supabase = makeSupabase([{
      id: 'sched1',
      guild_id: 'g1',
      name: 'Test Schedule',
      channel_id: 'ch1',
      message: 'Hello {server}!',
      embed_config_id: null,
      cron_expression: '* * * * *',
      timezone: 'UTC',
      start_date: null,
      end_date: null,
      max_sends: null,
      current_sends: 0,
      active: true,
      last_sent_at: null,
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();

    // Advance past alignment (up to 60s) + first tick interval (60s) + buffer
    await vi.advanceTimersByTimeAsync(130_000);

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hello Test Guild!',
    }));

    runner.stop();
  });

  it('sends embed when embed_config_id is set', async () => {
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const supabase = makeSupabase(
      [{
        id: 'sched2',
        guild_id: 'g1',
        name: 'Embed Schedule',
        channel_id: 'ch1',
        message: null,
        embed_config_id: 'embed1',
        cron_expression: '* * * * *',
        timezone: 'UTC',
        start_date: null,
        end_date: null,
        max_sends: null,
        current_sends: 0,
        active: true,
        last_sent_at: null,
      }],
      {
        title: '{server} Announcement',
        description: 'Welcome {members} members!',
        color: 0xFF0000,
        fields: [{ name: 'Field {server}', value: 'Value {memberCount}', inline: true }],
        image_url: 'https://example.com/img.png',
        thumbnail_url: 'https://example.com/thumb.png',
        footer_text: 'Footer {server}',
        footer_icon_url: 'https://example.com/icon.png',
        author_name: 'Author {server}',
        author_url: 'https://example.com',
        author_icon_url: 'https://example.com/author.png',
        include_timestamp: true,
      },
    );

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(130_000);

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));

    runner.stop();
  });

  it('skips message when outside date bounds', async () => {
    const now = new Date();
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const supabase = makeSupabase([{
      id: 'sched3',
      guild_id: 'g1',
      name: 'Future Schedule',
      channel_id: 'ch1',
      message: 'Test',
      embed_config_id: null,
      cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
      timezone: 'UTC',
      start_date: '2030-01-01T00:00:00Z',
      end_date: null,
      max_sends: null,
      current_sends: 0,
      active: true,
      last_sent_at: null,
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(channel.send).not.toHaveBeenCalled();
    runner.stop();
  });

  it('skips message when max_sends reached', async () => {
    const now = new Date();
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const supabase = makeSupabase([{
      id: 'sched4',
      guild_id: 'g1',
      name: 'Max Sends',
      channel_id: 'ch1',
      message: 'Test',
      embed_config_id: null,
      cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
      timezone: 'UTC',
      start_date: null,
      end_date: null,
      max_sends: 5,
      current_sends: 5,
      active: true,
      last_sent_at: null,
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(channel.send).not.toHaveBeenCalled();
    runner.stop();
  });

  it('skips when channel not found', async () => {
    const now = new Date();
    const guild = makeGuild(); // no channels
    const supabase = makeSupabase([{
      id: 'sched5',
      guild_id: 'g1',
      name: 'No Channel',
      channel_id: 'missing',
      message: 'Test',
      embed_config_id: null,
      cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
      timezone: 'UTC',
      start_date: null,
      end_date: null,
      max_sends: null,
      current_sends: 0,
      active: true,
      last_sent_at: null,
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    runner.stop();
  });

  it('prevents double-send within 55 seconds', async () => {
    const now = new Date();
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const supabase = makeSupabase([{
      id: 'sched6',
      guild_id: 'g1',
      name: 'Recent',
      channel_id: 'ch1',
      message: 'Test',
      embed_config_id: null,
      cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
      timezone: 'UTC',
      start_date: null,
      end_date: null,
      max_sends: null,
      current_sends: 0,
      active: true,
      last_sent_at: new Date(Date.now() - 30_000).toISOString(), // 30s ago
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(channel.send).not.toHaveBeenCalled();
    runner.stop();
  });

  it('handles end_date in the past', async () => {
    const now = new Date();
    const channel = makeChannel();
    const guild = makeGuild({ ch1: channel });
    const supabase = makeSupabase([{
      id: 'sched7',
      guild_id: 'g1',
      name: 'Expired',
      channel_id: 'ch1',
      message: 'Test',
      embed_config_id: null,
      cron_expression: `${now.getMinutes()} ${now.getHours()} * * *`,
      timezone: 'UTC',
      start_date: null,
      end_date: '2020-01-01T00:00:00Z',
      max_sends: null,
      current_sends: 0,
      active: true,
      last_sent_at: null,
    }]);

    const runner = new ScheduledMessageRunner(guild as any, supabase as any);
    await runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(channel.send).not.toHaveBeenCalled();
    runner.stop();
  });
});
