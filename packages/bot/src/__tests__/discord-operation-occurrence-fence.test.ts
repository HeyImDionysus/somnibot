import { describe, expect, it, vi } from 'vitest';
import { markDiscordOccurrenceCleanupPending } from '../services/occurrence-fence.js';

function makeUpdateClient(result: {
  data: { id: string } | null;
  error: { message: string } | null;
}) {
  const chain: any = {};
  for (const method of ['update', 'eq', 'select']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => result);
  return {
    client: { from: vi.fn(() => chain) } as any,
    chain,
  };
}

describe('durable Discord cleanup occurrence persistence', () => {
  it('returns only after the claimed occurrence row was updated', async () => {
    const { client, chain } = makeUpdateClient({
      data: { id: 'occurrence-1' },
      error: null,
    });

    await expect(markDiscordOccurrenceCleanupPending(
      client,
      'occurrence-1',
      'channel-1',
      'Discord deletion failed',
      { stage: 'active_row_insert' },
    )).resolves.toBeUndefined();

    expect(chain.update).toHaveBeenCalledWith({
      resource_id: 'channel-1',
      result: {
        stage: 'active_row_insert',
        channelCleanupPending: true,
      },
      last_error: 'Discord deletion failed',
    });
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'id', 'occurrence-1');
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'status', 'claimed');
    expect(chain.select).toHaveBeenCalledWith('id');
  });

  it('fails closed when the conditional update matched no claimed occurrence', async () => {
    const { client } = makeUpdateClient({ data: null, error: null });

    await expect(markDiscordOccurrenceCleanupPending(
      client,
      'occurrence-stale',
      'channel-survivor',
      'Discord deletion failed',
      { stage: 'active_row_insert' },
    )).rejects.toThrow(
      'Unable to preserve Discord occurrence cleanup job: occurrence occurrence-stale is no longer claimed',
    );
  });
});
