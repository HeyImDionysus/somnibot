import { describe, expect, it } from 'vitest';
import {
  isAuthoritativeChannelSnapshot,
  normalizeSnapshotChannels,
  resolveSelectedChannels,
} from '@/components/shared/channel-picker';

const NOW = Date.parse('2026-07-31T04:00:00.000Z');
const channel = {
  id: 'channel-1',
  name: 'general',
  type: 0,
  position: 1,
  manageableByBot: true,
  botPermissions: '3072',
};
const category = {
  id: 'category-1',
  name: 'Community',
  position: 0,
  manageableByBot: true,
  botPermissions: '16',
};

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

  it('accepts only a fresh, complete v2 channel snapshot as authoritative', () => {
    expect(isAuthoritativeChannelSnapshot({
      awaitingSnapshot: false,
      snapshotVersion: 2,
      snapshotAt: new Date(NOW - 60_000).toISOString(),
      channels: [channel],
      categories: [category],
    }, NOW)).toBe(true);
  });

  it('includes separately-snapshotted categories in picker options', () => {
    expect(normalizeSnapshotChannels({ channels: [channel], categories: [category] }))
      .toContainEqual(expect.objectContaining({
        id: 'category-1',
        name: 'Community',
        type: 4,
      }));
  });

  it.each([
    ['pending', { awaitingSnapshot: true, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), channels: [channel], categories: [category] }],
    ['legacy', { awaitingSnapshot: false, snapshotVersion: 1, snapshotAt: new Date(NOW).toISOString(), channels: [channel], categories: [category] }],
    ['stale', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW - 10 * 60_000 - 1).toISOString(), channels: [channel], categories: [category] }],
    ['future-dated', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW + 60_001).toISOString(), channels: [channel], categories: [category] }],
    ['malformed channel', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), channels: [{ id: 'channel-1' }], categories: [category] }],
    ['missing categories', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), channels: [channel] }],
    ['malformed category', { awaitingSnapshot: false, snapshotVersion: 2, snapshotAt: new Date(NOW).toISOString(), channels: [channel], categories: [{ id: 'category-1' }] }],
  ])('treats a %s snapshot as unavailable', (_name, payload) => {
    expect(isAuthoritativeChannelSnapshot(payload, NOW)).toBe(false);
  });
});

describe('channelPermissionIssue — stale snapshots cannot vouch for permissions', () => {
  const okChannel = { name: 'general', botPermissions: '3072', missing: false }; // View+Send

  it('accepts a channel whose AUTHORITATIVE snapshot proves the bits', async () => {
    const { channelPermissionIssue } = await import('@/components/shared/channel-picker');
    expect(channelPermissionIssue(okChannel, ['ViewChannel', 'SendMessages'], true)).toBeNull();
  });

  it('refuses the SAME bits when the snapshot is not authoritative', async () => {
    // The review-3689375357 scenario: an expired snapshot still carries old
    // permission bits from before SomniBot lost access. Enabling from them
    // queues an embed send that reports success and never delivers.
    const { channelPermissionIssue } = await import('@/components/shared/channel-picker');
    const issue = channelPermissionIssue(okChannel, ['ViewChannel', 'SendMessages'], false);
    expect(issue).toContain('cannot be verified');
  });

  it('still allows permission-free pickers regardless of authority', async () => {
    const { channelPermissionIssue } = await import('@/components/shared/channel-picker');
    expect(channelPermissionIssue(okChannel, [], false)).toBeNull();
  });

  it('names genuinely missing bits under an authoritative snapshot', async () => {
    const { channelPermissionIssue } = await import('@/components/shared/channel-picker');
    const issue = channelPermissionIssue(
      { name: 'general', botPermissions: '1024', missing: false }, // View only
      ['ViewChannel', 'SendMessages'],
      true,
    );
    expect(issue).toContain('SendMessages');
  });
});
