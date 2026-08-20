import { describe, expect, it } from 'vitest';
import { buildDiscordTriggerMetadata } from '../features/discord-native/automod-sync.js';

describe('Discord AutoMod config translation', () => {
  it('translates dashboard word, link, invite, and mention settings', () => {
    expect(buildDiscordTriggerMetadata({
      type: 'word_filter',
      config: { words: ['bad phrase'], matchMode: 'regex' },
    })).toEqual({ regexPatterns: ['bad phrase'] });
    expect(buildDiscordTriggerMetadata({
      type: 'link_filter',
      config: { domains: ['blocked.test'], mode: 'blacklist' },
    })).toEqual({ keywordFilter: ['*blocked.test*'] });
    expect(buildDiscordTriggerMetadata({
      type: 'mention_spam',
      config: { maxMentions: 7 },
    })).toEqual({ mentionTotalLimit: 7 });
    expect(buildDiscordTriggerMetadata({
      type: 'invite_filter',
      config: { allowOwnServer: true },
    })).toBeNull();
  });
});
