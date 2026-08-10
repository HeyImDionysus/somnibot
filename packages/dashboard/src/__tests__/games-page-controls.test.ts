import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(
  fileURLToPath(new URL('../app/(dashboard)/economy/games/page.tsx', import.meta.url)),
  'utf8',
);

const toggleStart = pageSource.indexOf('function Toggle');
const toggleSource = pageSource.slice(toggleStart, pageSource.indexOf('function NumberField', toggleStart));
const saveConfigStart = pageSource.indexOf('const saveConfig = async');
const saveConfigSource = pageSource.slice(saveConfigStart, pageSource.indexOf('\n  if (loading)', saveConfigStart));

describe('Games page controls', () => {
  it('uses a keyboard-operable switch button with the toggle label', () => {
    // Given: a dashboard toggle
    // When: it is rendered
    // Then: assistive technology receives the native control and current state.
    expect(toggleSource).toContain('<button');
    expect(toggleSource).toContain('type="button"');
    expect(toggleSource).toContain('role="switch"');
    expect(toggleSource).toContain('aria-checked={checked}');
    expect(toggleSource).toContain('aria-label={label}');
  });

  it('commits a daily-loss change only after the API accepts it', () => {
    // Given: a persisted daily-loss limit
    // When: the owner enters -1 and PATCH rejects it
    // Then: the rejected value cannot remain as the committed field value.
    const rejectionGuard = saveConfigSource.indexOf('if (!res.ok) throw new Error();');
    expect(rejectionGuard).toBeGreaterThanOrEqual(0);
    expect(saveConfigSource.slice(0, rejectionGuard)).not.toContain('setConfig(updated)');
    expect(saveConfigSource.slice(rejectionGuard)).toContain('setConfig(updated)');
  });
});
