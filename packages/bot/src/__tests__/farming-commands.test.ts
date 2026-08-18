import { EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  handleFarmingCommand,
  type FarmingCommandInteraction,
} from '../features/farming/commands.js';

function interactionFor(subcommand: 'plant' | 'water' | 'fertilize'): FarmingCommandInteraction {
  return {
    commandName: 'farm',
    id: `interaction-${subcommand}`,
    user: { id: 'member-1' },
    options: {
      getSubcommand: () => subcommand,
      getString: () => 'Potato',
      getInteger: () => 3,
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

function manager() {
  const result = { embed: new EmbedBuilder() };
  return {
    viewFarm: vi.fn(async () => result),
    plant: vi.fn(async () => result),
    water: vi.fn(async () => result),
    harvest: vi.fn(async () => result),
    fertilize: vi.fn(async () => result),
  };
}

describe('farming command operation identity', () => {
  it('forwards the plant interaction id unchanged', async () => {
    const farming = manager();
    await handleFarmingCommand(interactionFor('plant'), farming);
    expect(farming.plant).toHaveBeenCalledWith('member-1', 'Potato', 'interaction-plant');
  });

  it('forwards the water interaction id unchanged', async () => {
    const farming = manager();
    await handleFarmingCommand(interactionFor('water'), farming);
    expect(farming.water).toHaveBeenCalledWith('member-1', 'interaction-water');
  });

  it('forwards the fertilize interaction id unchanged', async () => {
    const farming = manager();
    await handleFarmingCommand(interactionFor('fertilize'), farming);
    expect(farming.fertilize).toHaveBeenCalledWith('member-1', 3, 'interaction-fertilize');
  });
});
