import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

const ROLE_ID = '100000000000000001';
const REMOVE_ROLE_ID = '100000000000000002';
const ITEM_ID = '00000000-0000-4000-8000-000000000001';

describe('level reward validation', () => {
  it.each([
    {
      type: 'reward',
      reward_type: 'role',
      level: 5,
      role_id: ROLE_ID,
      remove_role_id: REMOVE_ROLE_ID,
      remove_at_level: 10,
      announce: true,
    },
    {
      type: 'reward',
      reward_type: 'currency',
      level: 5,
      currency_amount: 250,
      announce: true,
    },
    {
      type: 'reward',
      reward_type: 'item',
      level: 5,
      item_id: ITEM_ID,
      item_quantity: 2,
      announce: false,
    },
  ])('accepts a complete $reward_type reward contract', (input) => {
    expect(schemas.levelReward.create.safeParse(input).success).toBe(true);
  });

  it.each([
    {
      type: 'reward',
      reward_type: 'role',
      level: 5,
      role_id: ROLE_ID,
      remove_role_id: ROLE_ID,
    },
    {
      type: 'reward',
      reward_type: 'role',
      level: 5,
      role_id: ROLE_ID,
      remove_at_level: 5,
    },
    {
      type: 'reward',
      reward_type: 'currency',
      level: 5,
      currency_amount: 0,
    },
    {
      type: 'reward',
      reward_type: 'item',
      level: 5,
      item_id: ITEM_ID,
      item_quantity: 0,
    },
  ])('rejects an unsafe or incomplete reward contract', (input) => {
    expect(schemas.levelReward.create.safeParse(input).success).toBe(false);
  });
});
