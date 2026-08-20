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
    })).toEqual({ regexPatterns: [String.raw`https?:\/\/(?:[A-Za-z0-9-]+\.)*blocked\.test(?::\d+)?(?:[\/?#]|$)`] });
    expect(buildDiscordTriggerMetadata({
      type: 'mention_spam',
      config: { maxMentions: 7 },
    })).toEqual({ mentionTotalLimit: 7 });
    expect(buildDiscordTriggerMetadata({
      type: 'invite_filter',
      config: { allowOwnServer: true },
    })).toBeNull();
  });

  it('matches only the configured hostname and its subdomains', () => {
    const metadata = buildDiscordTriggerMetadata({
      type: 'link_filter',
      config: { domains: ['evil.example'], mode: 'blacklist' },
    });
    const regex = new RegExp((metadata?.regexPatterns as string[])[0]!, 'i');
    expect(regex.test('https://evil.example/path')).toBe(true);
    expect(regex.test('https://cdn.evil.example/path')).toBe(true);
    expect(regex.test('https://notevil.example/path')).toBe(false);
    expect(regex.test('https://evil.example.attacker.test/path')).toBe(false);
  });
});
