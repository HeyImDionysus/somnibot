import packageMetadata from '../../package.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { SOMNIBOT_VERSION } from '../version.js';

describe('bot advertised version', () => {
  it('keeps package metadata and runtime advertisements on release version', () => {
    expect(SOMNIBOT_VERSION).toBe('1.0.0');
    expect(packageMetadata.version).toBe(SOMNIBOT_VERSION);
  });
});
