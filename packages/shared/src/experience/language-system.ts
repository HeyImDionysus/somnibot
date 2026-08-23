export const PRODUCT_TERMINOLOGY = {
  guild: { operator: 'server', diagnostic: 'guild' },
  member: { operator: 'member', diagnostic: 'Discord member' },
  coinEconomy: { operator: 'coin economy', diagnostic: 'game economy' },
  realMoneyStore: { operator: 'real-money store', diagnostic: 'commerce' },
  operation: { operator: 'operation', diagnostic: 'operation' },
  deployment: { operator: 'deployment', diagnostic: 'runtime deployment' },
  provider: { operator: 'provider', diagnostic: 'external provider' },
  recovery: { operator: 'recovery', diagnostic: 'recovery action' },
};

export const STATUS_LANGUAGE = {
  unknown: { label: 'Unknown', severity: 'neutral', actionRequired: false },
  pending: { label: 'Pending', severity: 'info', actionRequired: false },
  ready: { label: 'Ready', severity: 'success', actionRequired: false },
  degraded: { label: 'Degraded', severity: 'warning', actionRequired: true },
  failed: { label: 'Failed', severity: 'danger', actionRequired: true },
  stale: { label: 'Stale', severity: 'warning', actionRequired: true },
  paused: { label: 'Paused', severity: 'neutral', actionRequired: false },
  blocked: { label: 'Blocked', severity: 'danger', actionRequired: true },
  recovering: { label: 'Recovering', severity: 'info', actionRequired: false },
  revoked: { label: 'Revoked', severity: 'danger', actionRequired: true },
};

export type ProductTerm = keyof typeof PRODUCT_TERMINOLOGY;
export type ProductStatus = keyof typeof STATUS_LANGUAGE;
