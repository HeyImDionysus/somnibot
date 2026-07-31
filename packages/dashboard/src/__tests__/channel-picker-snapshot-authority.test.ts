import { describe, expect, it } from 'vitest';
import { resolveSelectedChannels } from '@/components/shared/channel-picker';

describe('ChannelPicker snapshot authority', () => {
  it('does not label a configured channel deleted while the live snapshot is pending', () => {
    const [channel] = resolveSelectedChannels(['channel-1'], [], false);

    expect(channel).toMatchObject({
      id: 'channel-1',
      name: 'Configured channel (channel-1) — awaiting live snapshot',
      missing: false,
    });
  });

  it('labels an absent configured channel deleted only after an authoritative snapshot', () => {
    const [channel] = resolveSelectedChannels(['channel-1'], [], true);

    expect(channel).toMatchObject({
      id: 'channel-1',
      name: 'Deleted channel (channel-1)',
      missing: true,
    });
  });
});
