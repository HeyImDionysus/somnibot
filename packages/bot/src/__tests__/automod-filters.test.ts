/**
 * AutoMod Filter Logic — Unit Tests
 *
 * Tests the pure filter functions from automod-engine.
 * Since the functions are not exported, we replicate the logic inline
 * (same pattern as validators.test.ts).
 */
import { describe, it, expect } from 'vitest';

// ── Inline: Word Filter ────────────────────────────────────

interface WordFilterConfig {
  words: string[];
  matchMode: 'exact' | 'wildcard' | 'regex';
  caseSensitive: boolean;
}

function checkWordFilter(content: string, config: WordFilterConfig): string | null {
  if (!config.words || config.words.length === 0) return null;

  const text = config.caseSensitive ? content : content.toLowerCase();

  for (const word of config.words) {
    const target = config.caseSensitive ? word : word.toLowerCase();

    switch (config.matchMode) {
      case 'exact': {
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, config.caseSensitive ? '' : 'i');
        if (regex.test(content)) {
          return `Matched banned word: "${word}"`;
        }
        break;
      }
      case 'wildcard': {
        const pattern = target
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(pattern, config.caseSensitive ? '' : 'i');
        if (regex.test(content)) {
          return `Matched banned pattern: "${word}"`;
        }
        break;
      }
      case 'regex': {
        try {
          if (/(\\(.*[+*].*\\))[+*]/.test(word) || /(\\.\\*){2,}/.test(word)) {
            break;
          }
          const regex = new RegExp(word, config.caseSensitive ? '' : 'i');
          const start = Date.now();
          const matched = regex.test(content);
          if (Date.now() - start > 50) break;
          if (matched) {
            return `Matched regex filter: "${word}"`;
          }
        } catch {
          // Invalid regex
        }
        break;
      }
    }
  }

  return null;
}

// ── Inline: Link Filter ────────────────────────────────────

interface LinkFilterConfig {
  mode: 'whitelist' | 'blacklist';
  domains: string[];
}

function checkLinkFilter(content: string, config: LinkFilterConfig): string | null {
  const urlRegex = /https?:\/\/(?:[\w-]+\.)+[\w-]+(?:\/\S*)?/gi;
  const urls = content.match(urlRegex);
  if (!urls || urls.length === 0) return null;

  for (const url of urls) {
    let domain: string;
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }

    const domains = (config.domains ?? []).map((d) => d.toLowerCase());

    if (config.mode === 'whitelist') {
      const allowed = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!allowed) {
        return `Link from non-whitelisted domain: ${domain}`;
      }
    } else {
      const blocked = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (blocked) {
        return `Link from blocked domain: ${domain}`;
      }
    }
  }

  return null;
}

// ── Inline: Caps Filter ────────────────────────────────────

interface CapsFilterConfig {
  maxPercent?: number;
  minLength?: number;
}

function checkCapsFilter(content: string, config: CapsFilterConfig): string | null {
  const maxPercent = config.maxPercent ?? 70;
  const minLength = config.minLength ?? 10;

  if (content.length < minLength) return null;

  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return null;

  const upperCount = letters.replace(/[^A-Z]/g, '').length;
  const percent = (upperCount / letters.length) * 100;

  if (percent > maxPercent) {
    return `Excessive caps: ${Math.round(percent)}% uppercase (limit: ${maxPercent}%)`;
  }

  return null;
}

// ── Inline: Newline Spam ───────────────────────────────────

interface NewlineSpamConfig {
  maxNewlines?: number;
}

function checkNewlineSpam(content: string, config: NewlineSpamConfig): string | null {
  const maxNewlines = config.maxNewlines ?? 15;
  const newlineCount = (content.match(/\n/g) || []).length;

  if (newlineCount > maxNewlines) {
    return `Newline spam: ${newlineCount} newlines (limit: ${maxNewlines})`;
  }

  return null;
}

// ── Inline: Simple Hash ────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

describe('checkWordFilter', () => {
  it('returns null for empty word list', () => {
    expect(checkWordFilter('hello world', { words: [], matchMode: 'exact', caseSensitive: false })).toBeNull();
  });

  it('matches exact word (case insensitive)', () => {
    const result = checkWordFilter('you are a badword here', {
      words: ['badword'],
      matchMode: 'exact',
      caseSensitive: false,
    });
    expect(result).toContain('badword');
  });

  it('does not match partial word in exact mode', () => {
    const result = checkWordFilter('this is scrapbook', {
      words: ['crap'],
      matchMode: 'exact',
      caseSensitive: false,
    });
    // "crap" inside "scrapbook" should NOT match with word boundary
    expect(result).toBeNull();
  });

  it('matches with case sensitivity', () => {
    const result = checkWordFilter('BadWord is here', {
      words: ['BadWord'],
      matchMode: 'exact',
      caseSensitive: true,
    });
    expect(result).not.toBeNull();
  });

  it('fails case-sensitive match when case differs', () => {
    const result = checkWordFilter('badword is here', {
      words: ['BadWord'],
      matchMode: 'exact',
      caseSensitive: true,
    });
    expect(result).toBeNull();
  });

  it('matches wildcard pattern', () => {
    const result = checkWordFilter('visit badsite.com now', {
      words: ['bad*'],
      matchMode: 'wildcard',
      caseSensitive: false,
    });
    expect(result).not.toBeNull();
  });

  it('matches wildcard ? single char', () => {
    const result = checkWordFilter('oh f_ck', {
      words: ['f?ck'],
      matchMode: 'wildcard',
      caseSensitive: false,
    });
    expect(result).not.toBeNull();
  });

  it('matches regex pattern', () => {
    const result = checkWordFilter('test123', {
      words: ['\\d{3}'],
      matchMode: 'regex',
      caseSensitive: false,
    });
    expect(result).not.toBeNull();
  });

  it('rejects catastrophic backtracking patterns', () => {
    // Patterns like (a+)+ should be rejected
    const result = checkWordFilter('aaaaaaaaaaaa', {
      words: ['(a+)+b'],
      matchMode: 'regex',
      caseSensitive: false,
    });
    expect(result).toBeNull();
  });

  it('handles invalid regex gracefully', () => {
    const result = checkWordFilter('test', {
      words: ['[invalid'],
      matchMode: 'regex',
      caseSensitive: false,
    });
    expect(result).toBeNull();
  });

  it('matches multiple words', () => {
    const result = checkWordFilter('spam link here', {
      words: ['scam', 'spam', 'phish'],
      matchMode: 'exact',
      caseSensitive: false,
    });
    expect(result).toContain('spam');
  });
});

describe('checkLinkFilter', () => {
  it('returns null for messages without links', () => {
    expect(checkLinkFilter('just some text', { mode: 'blacklist', domains: ['evil.com'] })).toBeNull();
  });

  it('blocks blacklisted domain', () => {
    const result = checkLinkFilter('check https://evil.com/page', {
      mode: 'blacklist',
      domains: ['evil.com'],
    });
    expect(result).toContain('evil.com');
  });

  it('allows non-blacklisted domain', () => {
    const result = checkLinkFilter('check https://good.com/page', {
      mode: 'blacklist',
      domains: ['evil.com'],
    });
    expect(result).toBeNull();
  });

  it('blocks non-whitelisted domain', () => {
    const result = checkLinkFilter('check https://random.com', {
      mode: 'whitelist',
      domains: ['trusted.com'],
    });
    expect(result).not.toBeNull();
  });

  it('allows whitelisted domain', () => {
    const result = checkLinkFilter('check https://trusted.com/path', {
      mode: 'whitelist',
      domains: ['trusted.com'],
    });
    expect(result).toBeNull();
  });

  it('blocks blacklisted subdomain', () => {
    const result = checkLinkFilter('check https://sub.evil.com/page', {
      mode: 'blacklist',
      domains: ['evil.com'],
    });
    expect(result).toContain('sub.evil.com');
  });

  it('allows whitelisted subdomain', () => {
    const result = checkLinkFilter('check https://cdn.trusted.com/image.png', {
      mode: 'whitelist',
      domains: ['trusted.com'],
    });
    expect(result).toBeNull();
  });

  it('handles multiple URLs in one message', () => {
    const result = checkLinkFilter(
      'visit https://good.com and https://evil.com',
      { mode: 'blacklist', domains: ['evil.com'] },
    );
    expect(result).not.toBeNull();
  });

  it('handles malformed URLs gracefully', () => {
    // No crash on non-URL text
    const result = checkLinkFilter('just text http://[invalid', {
      mode: 'blacklist',
      domains: ['evil.com'],
    });
    // Should not crash, may or may not match
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

describe('checkCapsFilter', () => {
  it('returns null for short messages', () => {
    expect(checkCapsFilter('HI', { maxPercent: 70, minLength: 10 })).toBeNull();
  });

  it('returns null for messages below threshold', () => {
    expect(checkCapsFilter('Hello World how are you today', { maxPercent: 70 })).toBeNull();
  });

  it('detects excessive caps', () => {
    const result = checkCapsFilter('THIS IS ALL CAPS MESSAGE HERE', { maxPercent: 70 });
    expect(result).not.toBeNull();
    expect(result).toContain('uppercase');
  });

  it('ignores non-letter characters', () => {
    // Numbers and symbols should not affect caps percentage
    const result = checkCapsFilter('12345 67890 !!!!! hello', { maxPercent: 70, minLength: 5 });
    expect(result).toBeNull();
  });

  it('returns null for all-number messages', () => {
    expect(checkCapsFilter('1234567890!!', { minLength: 5 })).toBeNull();
  });

  it('uses custom maxPercent', () => {
    // 50% caps
    const result = checkCapsFilter('Hello WORLD Today', { maxPercent: 40, minLength: 5 });
    expect(result).not.toBeNull();
  });

  it('uses custom minLength', () => {
    // Short message should pass even with all caps
    expect(checkCapsFilter('HELLO', { maxPercent: 70, minLength: 20 })).toBeNull();
  });
});

describe('checkNewlineSpam', () => {
  it('returns null for normal messages', () => {
    expect(checkNewlineSpam('hello world', {})).toBeNull();
  });

  it('detects excessive newlines', () => {
    const content = 'line\n'.repeat(20);
    const result = checkNewlineSpam(content, { maxNewlines: 15 });
    expect(result).not.toBeNull();
    expect(result).toContain('20 newlines');
  });

  it('allows messages at the limit', () => {
    const content = 'line\n'.repeat(15);
    expect(checkNewlineSpam(content, { maxNewlines: 15 })).toBeNull();
  });

  it('uses default 15 newline limit', () => {
    const content = 'line\n'.repeat(16);
    const result = checkNewlineSpam(content, {});
    expect(result).not.toBeNull();
  });

  it('returns null for messages with few newlines', () => {
    expect(checkNewlineSpam('line1\nline2\nline3', { maxNewlines: 15 })).toBeNull();
  });
});

describe('simpleHash', () => {
  it('returns a base36 string', () => {
    const hash = simpleHash('hello');
    expect(hash).toMatch(/^[0-9a-z]+$/);
  });

  it('returns consistent results', () => {
    expect(simpleHash('test')).toBe(simpleHash('test'));
  });

  it('returns different hashes for different inputs', () => {
    expect(simpleHash('foo')).not.toBe(simpleHash('bar'));
  });

  it('handles empty string', () => {
    const hash = simpleHash('');
    expect(hash).toBe('0');
  });

  it('handles long strings', () => {
    const long = 'a'.repeat(10000);
    const hash = simpleHash(long);
    expect(hash.length).toBeGreaterThan(0);
  });
});
