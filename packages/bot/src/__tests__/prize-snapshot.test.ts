import { describe, it, expect } from 'vitest';
import {
  codePointLength,
  codePointSlice,
  prizeSnapshotOf,
  sqlSpaceTrim,
} from '../utils/prize-snapshot.js';

// Cells mirror PostgreSQL semantics exactly: btrim strips only U+0020,
// left() counts code points. Divergence from these cells means a stored
// prize and its SQL-minted snapshot stop agreeing and winner notifications
// dead-letter permanently.
describe('prize-snapshot SQL replicas', () => {
  it('sqlSpaceTrim strips only U+0020, never other whitespace', () => {
    expect(sqlSpaceTrim('  Nitro  ')).toBe('Nitro');
    expect(sqlSpaceTrim('\tNitro')).toBe('\tNitro');
    expect(sqlSpaceTrim('Nitro\n')).toBe('Nitro\n');
    expect(sqlSpaceTrim(' Nitro ')).toBe(' Nitro ');
    expect(sqlSpaceTrim(' \tNitro\n ')).toBe('\tNitro\n');
    expect(sqlSpaceTrim('   ')).toBe('');
  });

  it('codePointLength counts code points, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3);
    // Astral emoji: 2 UTF-16 units each, 1 code point each.
    const emoji = '🎁'.repeat(600);
    expect(emoji.length).toBe(1_200);
    expect(codePointLength(emoji)).toBe(600);
  });

  it('codePointSlice never splits a surrogate pair', () => {
    const emoji = '🎁'.repeat(600);
    expect(codePointSlice(emoji, 1_000)).toBe(emoji);
    const cut = codePointSlice('🎁'.repeat(1_100), 1_000);
    expect(codePointLength(cut)).toBe(1_000);
    expect(cut.endsWith('🎁')).toBe(true);
  });

  it('prizeSnapshotOf equals the SQL transform for the divergent cells', () => {
    // Edge newline survives btrim: snapshot keeps it, and so do we.
    expect(prizeSnapshotOf('1x Nitro\n1x VIP')).toBe('1x Nitro\n1x VIP');
    expect(prizeSnapshotOf(' Discord Nitro ')).toBe('Discord Nitro');
    expect(prizeSnapshotOf('\tNitro ')).toBe('\tNitro');
    // 600 astral emoji: 1200 UTF-16 units but 600 code points — left(1000)
    // keeps all of them.
    const emoji = '🎁'.repeat(600);
    expect(prizeSnapshotOf(emoji)).toBe(emoji);
    // Truncation ending in a space gets the outer btrim, like the SQL.
    const padded = 'a'.repeat(999) + ' b';
    expect(prizeSnapshotOf(padded)).toBe('a'.repeat(999));
  });

  it('canonical creation form is a fixed point of the snapshot transform', () => {
    for (const raw of [' Discord Nitro ', '\tNitro\n', '🎁'.repeat(1_100), '  a  ']) {
      const canonical = codePointSlice(raw.trim(), 1_000).trim();
      expect(prizeSnapshotOf(canonical)).toBe(canonical);
    }
  });
});
