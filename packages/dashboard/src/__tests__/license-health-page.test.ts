import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('license health dashboard details', () => {
  it('surfaces invalid validation failures whenever they affect health state', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../app/(dashboard)/licenses/page.tsx'),
      'utf8',
    );

    expect(source).toContain('|| health.invalid24h > 0');
    expect(source).toContain(
      '{health.invalid24h} validation(s) were rejected as invalid in the last 24 hours.',
    );
  });
});
