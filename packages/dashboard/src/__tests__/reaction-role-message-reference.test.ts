import { describe, expect, it } from 'vitest';
import { parseReactionRoleMessageReference } from '@/lib/community/reaction-role-message-reference';

describe('parseReactionRoleMessageReference', () => {
  it('Given a guild message URL, when parsed, then exposes the linked channel and message IDs', () => {
    const result = parseReactionRoleMessageReference(
      'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
    );

    expect(result).toEqual({
      kind: 'valid',
      channelId: '222222222222222222',
      messageId: '333333333333333333',
    });
  });

  it('Given a non-message URL, when parsed, then rejects it without inventing a message target', () => {
    const result = parseReactionRoleMessageReference('https://discord.com/channels/111111111111111111');

    expect(result).toEqual({ kind: 'invalid' });
  });
});
