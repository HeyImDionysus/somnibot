import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueueDriftItem = vi.fn();

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../sync/drift-debouncer.js', () => ({
  queueDriftItem: (...args: unknown[]) => mockQueueDriftItem(...args),
}));

import { handleChannelCreate } from '../sync/channel-events.js';

function makeSupabase(mapping: Record<string, unknown> | null) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: mapping })),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);

  return { from: vi.fn(() => chain) };
}

function makeChannel(name: string, id: string, safetyAlertsChannelId: string | null = null) {
  return {
    id,
    name,
    type: 0,
    guild: {
      id: 'guild-1',
      rulesChannelId: null,
      publicUpdatesChannelId: null,
      safetyAlertsChannelId,
    },
  };
}

describe('handleChannelCreate ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['moderator-only', 'user-moderator-only'],
    ['ticket-42-owner', 'user-ticket-42'],
  ])('queues an untracked user-created %s channel as drift', async (name, id) => {
    const client = {
      supabase: makeSupabase(null),
    };
    const channel = makeChannel(name, id);

    await handleChannelCreate(client as never, channel as never);

    expect(mockQueueDriftItem).toHaveBeenCalledWith(
      client,
      'guild-1',
      expect.objectContaining({
        type: 'EXTRA_RESOURCE',
        entityType: 'channel',
        entityDiscordId: id,
        entityName: name,
      }),
    );
  });

  it('does not queue a mapped bot-created channel', async () => {
    const client = {
      supabase: makeSupabase({ template_key: 'channel:ticket-42' }),
    };

    await handleChannelCreate(client as never, makeChannel('ticket-42-owner', 'bot-ticket-42') as never);

    expect(mockQueueDriftItem).not.toHaveBeenCalled();
  });

  it('does not queue the exact Discord safety-alerts channel', async () => {
    const client = { supabase: makeSupabase(null) };
    const channel = makeChannel('any-name', 'system-safety-alerts', 'system-safety-alerts');

    await handleChannelCreate(client as never, channel as never);

    expect(mockQueueDriftItem).not.toHaveBeenCalled();
    expect(client.supabase.from).not.toHaveBeenCalled();
  });
});
