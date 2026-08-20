import type { EconomyItemUseEffect } from '../types/database.js';

export const ECONOMY_ITEM_EFFECT_TYPES = [
  'padlock',
  'shovel',
  'pickaxe',
  'hunting_rifle',
  'wallet_credit',
  'xp_credit',
  'role_grant',
] as const satisfies ReadonlyArray<EconomyItemUseEffect['type']>;

export const ECONOMY_AUTOMATIC_ITEM_EFFECT_TYPES = [
  'padlock',
  'shovel',
  'pickaxe',
  'hunting_rifle',
] as const satisfies ReadonlyArray<EconomyItemUseEffect['type']>;

export const ECONOMY_MANUAL_ITEM_EFFECT_TYPES = [
  'wallet_credit',
  'xp_credit',
  'role_grant',
] as const satisfies ReadonlyArray<EconomyItemUseEffect['type']>;

export function isManualEconomyItemEffect(
  type: EconomyItemUseEffect['type'],
): boolean {
  return (ECONOMY_MANUAL_ITEM_EFFECT_TYPES as readonly string[]).includes(type);
}
