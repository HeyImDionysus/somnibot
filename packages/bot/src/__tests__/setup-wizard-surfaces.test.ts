import { describe, expect, it } from 'vitest';
import { buildSetupCommand } from '../features/setup-wizard/commands.js';

describe('/setup Discord surface', () => {
  it('registers one guild-only ownership-guidance command', () => {
    const command = buildSetupCommand().toJSON();

    expect(command).toMatchObject({
      name: 'setup',
      dm_permission: false,
      options: [],
    });
  });
});
