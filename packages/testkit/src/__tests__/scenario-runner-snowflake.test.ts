import { describe, expect, it } from 'vitest';

import { deterministicSnowflake } from '../scenario-runner/snowflake.js';

describe('deterministicSnowflake', () => {
  it('returns a stable Discord-snowflake-shaped identifier', () => {
    const first = deterministicSnowflake('run:SET-A:channel');
    const second = deterministicSnowflake('run:SET-A:channel');

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9]{18}$/);
  });

  it('keeps distinct fixture labels distinct', () => {
    expect(deterministicSnowflake('run:SET-A:channel')).not.toBe(
      deterministicSnowflake('run:SET-A:role'),
    );
  });
});
