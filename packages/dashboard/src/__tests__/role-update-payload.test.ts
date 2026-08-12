import { describe, expect, it } from 'vitest';
import { roleUpdatePayload } from '@/lib/api/role-update-payload';

describe('roleUpdatePayload', () => {
  it('retains a selected permission tier when an existing Discord role is saved', () => {
    expect(roleUpdatePayload({
      id: '123456789012345678',
      name: 'Member',
      color: 0,
      position: 3,
      permissions: '0',
      hoist: false,
      mentionable: false,
      managed: false,
      tags: {
        botId: null,
        integrationId: null,
        premiumSubscriberRole: false,
        availableForPurchase: false,
        guildConnections: false,
      },
      templateKey: null,
      tier: 'member',
      source: 'manual',
      memberCount: 0,
    })).toMatchObject({
      roleId: '123456789012345678',
      tier: 'member',
    });
  });
});
