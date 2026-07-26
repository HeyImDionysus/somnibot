/**
 * Brand voice table — snapshot tests.
 *
 * THE CONTRACT: the 'default' preset must render BYTE-IDENTICAL copy to the
 * strings shipped in the codebase today, so moving a call site onto voice()
 * is provably behavior-neutral for every unconfigured guild. Each assertion
 * below pins the rendered string against the dominant live phrasing, with the
 * canonical source cited. If one of these fails, the voice table has drifted
 * from live copy — fix the table, not the test.
 */
import { describe, it, expect } from 'vitest';

import { voice, VOICE_KEYS } from '../features/branding/voice.js';
import { BRAND_VOICE_PRESETS } from '../features/branding/brand-kit.js';

describe("voice('default', ...) is byte-identical to current live copy", () => {
  it('unavailable — the branded outage family (e.g. commerce/store-command.ts:53)', () => {
    expect(voice('default', 'unavailable', { brand: 'Acme', feature: 'store' })).toBe(
      "⚠️ Acme's store is temporarily unavailable — please try again in a moment.",
    );
    // ticket-interactions.ts:52
    expect(voice('default', 'unavailable', { brand: 'Cool Server', feature: 'ticket system' })).toBe(
      "⚠️ Cool Server's ticket system is temporarily unavailable — please try again in a moment.",
    );
  });

  it('disabled — feature-off refusal (e.g. crafting-manager.ts:116, farming-manager.ts:114)', () => {
    expect(voice('default', 'disabled', { feature: 'Crafting' })).toBe(
      '❌ Crafting is not enabled on this server.',
    );
  });

  it('cooldown — wait notice (e.g. crafting-manager.ts:194, gathering-manager.ts:211)', () => {
    expect(voice('default', 'cooldown', { time: '5m 30s', action: 'crafting' })).toBe(
      '⏳ You need to wait **5m 30s** before crafting again.',
    );
  });

  it('insufficient_funds — balance refusal (e.g. pets-manager.ts:325, polls-manager.ts:559)', () => {
    expect(voice('default', 'insufficient_funds', { amount: '1,000', currency: 'coins' })).toBe(
      '❌ You need **1,000** coins.',
    );
  });

  it('denied — permission refusal (e.g. moderation/commands.ts:165/315/430/536)', () => {
    expect(voice('default', 'denied', { action: 'warn members' })).toBe(
      '❌ You do not have permission to warn members.',
    );
  });

  it('not_found — lookup miss (e.g. ticket-interactions.ts:297, moderation/commands.ts:330)', () => {
    expect(voice('default', 'not_found', { thing: 'Ticket' })).toBe('❌ Ticket not found.');
    expect(voice('default', 'not_found', { thing: 'Member' })).toBe('❌ Member not found.');
  });

  it('success — checkmark confirmation (e.g. ticket-interactions.ts:328, ticket-commands.ts:115)', () => {
    expect(voice('default', 'success', { message: 'Ticket closed.' })).toBe('✅ Ticket closed.');
  });
});

describe('voice table shape', () => {
  it('defines a non-empty template for every preset × key', () => {
    for (const preset of BRAND_VOICE_PRESETS) {
      for (const key of VOICE_KEYS) {
        const rendered = voice(preset, key, {
          brand: 'Acme',
          feature: 'store',
          time: '5s',
          action: 'testing',
          amount: '1',
          currency: 'coins',
          thing: 'Thing',
          message: 'Done.',
        });
        expect(rendered.length, `${preset}/${key}`).toBeGreaterThan(0);
        // Every provided placeholder must have been consumed or absent — no
        // template may leak an unfilled slot when all vars are supplied.
        expect(rendered, `${preset}/${key}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('non-default presets rephrase without changing the variable contract', () => {
    // Same slots resolve in every preset; only the surrounding copy differs.
    for (const preset of ['professional', 'friendly', 'playful'] as const) {
      expect(voice(preset, 'unavailable', { brand: 'Acme', feature: 'store' })).toContain('Acme');
      expect(voice(preset, 'cooldown', { time: '5m', action: 'fishing' })).toContain('5m');
      expect(voice(preset, 'insufficient_funds', { amount: '50', currency: 'gems' })).toContain('50');
    }
  });

  it('leaves unknown placeholders intact and ignores extra vars', () => {
    // A missing var must not render 'undefined' — the slot stays visible so
    // the bug is diagnosable in staging rather than silent in production.
    expect(voice('default', 'not_found', {})).toBe('❌ {thing} not found.');
    expect(voice('default', 'not_found', { thing: 'Item', extra: 'ignored' })).toBe(
      '❌ Item not found.',
    );
  });

  it('numeric vars are stringified', () => {
    expect(voice('default', 'insufficient_funds', { amount: 500, currency: 'coins' })).toBe(
      '❌ You need **500** coins.',
    );
  });
});
