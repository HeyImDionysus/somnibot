import { describe, expect, it } from 'vitest';

import { buildSlashInteraction } from '../interaction-builders.js';

describe('slash interaction option contract', () => {
  it('keeps flat commands unchanged while exposing typed primitive accessors', () => {
    const interaction = buildSlashInteraction({
      commandName: 'balance',
      options: { amount: 50, ratio: 1.5, enabled: true, note: 'hello' },
    });

    expect(interaction.options.getSubcommand(false)).toBeNull();
    expect(interaction.options.getSubcommandGroup()).toBeNull();
    expect(interaction.options.getInteger('amount')).toBe(50);
    expect(interaction.options.getNumber('ratio')).toBe(1.5);
    expect(interaction.options.getBoolean('enabled')).toBe(true);
    expect(interaction.options.getString('note')).toBe('hello');
    expect(interaction.options.get('amount')).toEqual({ name: 'amount', value: 50 });
  });

  it('selects a nested subcommand group and preserves resolved option values', () => {
    const user = { id: 'user-1', bot: false };
    const channel = { id: 'channel-1', type: 0 };
    const role = { id: 'role-1', name: 'Moderators' };
    const interaction = buildSlashInteraction({
      commandName: 'admin',
      subcommandGroup: 'moderation',
      subcommand: 'ban',
      options: {
        user,
        channel,
        role,
        reason: 'spam',
        duration: 15,
        silent: false,
      },
    });

    expect(interaction.options.getSubcommand()).toBe('ban');
    expect(interaction.options.getSubcommandGroup()).toBe('moderation');
    expect(interaction.options.getUser('user')).toBe(user);
    expect(interaction.options.getChannel('channel')).toBe(channel);
    expect(interaction.options.getRole('role')).toBe(role);
    expect(interaction.options.getString('reason', true)).toBe('spam');
    expect(interaction.options.getInteger('duration', true)).toBe(15);
    expect(interaction.options.getBoolean('silent', true)).toBe(false);
  });

  it('matches required and optional missing-option behavior', () => {
    const interaction = buildSlashInteraction({ commandName: 'help' });

    expect(interaction.options.getString('missing')).toBeNull();
    expect(interaction.options.getInteger('missing')).toBeNull();
    expect(interaction.options.getBoolean('missing')).toBeNull();
    expect(interaction.options.getUser('missing')).toBeNull();
    expect(interaction.options.getChannel('missing')).toBeNull();
    expect(interaction.options.getRole('missing')).toBeNull();
    expect(interaction.options.getMember('missing')).toBeNull();
    expect(interaction.options.getSubcommand(false)).toBeNull();
    expect(interaction.options.getSubcommandGroup()).toBeNull();

    expect(() => interaction.options.getString('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getInteger('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getBoolean('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getUser('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getChannel('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getRole('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getMember('missing', true)).toThrow(/required option/);
    expect(() => interaction.options.getSubcommand()).toThrow(/no subcommand/);
    expect(() => interaction.options.getSubcommandGroup(true)).toThrow(/no subcommand group/);
  });

  it('fails closed for malformed nested selections and mismatched primitive values', () => {
    expect(() => buildSlashInteraction({ commandName: 'admin', subcommandGroup: 'moderation' })).toThrow(
      /requires a subcommand/,
    );

    const interaction = buildSlashInteraction({ commandName: 'admin', options: { amount: 'fifty' } });
    expect(() => interaction.options.getInteger('amount')).toThrow(/TypeMismatch/);
    expect(() => interaction.options.getNumber('amount')).toThrow(/TypeMismatch/);
  });
});
