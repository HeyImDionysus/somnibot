/**
 * Tests for command-registry module.
 * V7 Audit §6.P3a — Ensures the registry correctly maps, rejects duplicates,
 * and lists registered commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need a fresh registry for each test. Since the registry is module-level,
// we use vi.resetModules() + dynamic import to get a clean state.
describe('command-registry', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers and looks up a command', async () => {
    const mod = await import('../events/command-registry.js');
    const handler = vi.fn();
    mod.registerCommand('test-cmd', handler);
    expect(mod.lookupCommand('test-cmd')).toBe(handler);
  });

  it('returns undefined for unknown commands', async () => {
    const mod = await import('../events/command-registry.js');
    expect(mod.lookupCommand('nonexistent')).toBeUndefined();
  });

  it('throws on duplicate registration', async () => {
    const mod = await import('../events/command-registry.js');
    const handler = vi.fn();
    mod.registerCommand('dup-cmd', handler);
    expect(() => mod.registerCommand('dup-cmd', handler)).toThrow(
      /Duplicate command registration: "dup-cmd"/,
    );
  });

  it('registeredCommands returns sorted list', async () => {
    const mod = await import('../events/command-registry.js');
    const handler = vi.fn();
    mod.registerCommand('zebra', handler);
    mod.registerCommand('alpha', handler);
    mod.registerCommand('mid', handler);
    const cmds = mod.registeredCommands();
    expect(cmds).toEqual(['alpha', 'mid', 'zebra']);
  });
});
