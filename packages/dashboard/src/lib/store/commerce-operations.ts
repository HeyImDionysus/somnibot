export const LAUNCH_STAGE_KEYS = [
  'product',
  'policy',
  'pricing',
  'integration',
  'sandbox_transaction',
  'webhook',
  'entitlement',
  'fulfillment',
  'reversal',
] as const;
export type LaunchStageKey = (typeof LAUNCH_STAGE_KEYS)[number];
export type LaunchStageState = 'pending' | 'verified' | 'failed' | 'not_applicable';

type LaunchEvaluationInput = {
  readonly productActive: boolean;
  readonly environment: 'sandbox' | 'live';
  readonly stages: Readonly<Record<LaunchStageKey, LaunchStageState>>;
  readonly receiptHash: string | null;
};
export function evaluateLaunchRun(
  input: LaunchEvaluationInput,
): { readonly state: 'ready' | 'blocked'; readonly missing: readonly string[] } {
  const missing: string[] = [];
  if (input.productActive) missing.push('product_inactive');
  if (input.environment !== 'sandbox') missing.push('sandbox_environment');
  for (const stage of LAUNCH_STAGE_KEYS) {
    if (input.stages[stage] !== 'verified' && input.stages[stage] !== 'not_applicable') {
      missing.push(stage);
    }
  }
  if (!input.receiptHash || !/^[a-f0-9]{64}$/.test(input.receiptHash)) {
    missing.push('launch_receipt');
  }
  return missing.length === 0
    ? { state: 'ready', missing }
    : { state: 'blocked', missing };
}
export type AccessNodeKind =
  | 'discord_role'
  | 'private_channel'
  | 'license'
  | 'installation'
  | 'download'
  | 'hosted_access'
  | 'update_access'
  | 'support_access';
type GraphState = 'active' | 'pending' | 'failed' | 'expired' | 'revoked' | 'unknown';
type EntitlementGraphInput = {
  readonly order: {
    readonly id: string;
    readonly customerId: string;
    readonly status: string;
    readonly productId: string;
    readonly planId: string | null;
  };
  readonly payment: { readonly id: string; readonly status: string } | null;
  readonly entitlement: { readonly id: string; readonly status: string } | null;
  readonly capabilities: readonly {
    readonly key: string;
    readonly name: string;
    readonly granted: boolean;
  }[];
  readonly access: readonly {
    readonly id: string;
    readonly kind: AccessNodeKind;
    readonly label: string;
    readonly state: GraphState;
  }[];
  readonly operationHistory: readonly {
    readonly operationId: string;
    readonly action: string;
    readonly state: string;
  }[];
  readonly previewAction: 'refund' | 'revoke' | 'cancel' | null;
  readonly productRevision: string;
  readonly policyRevision: string;
};
type EntitlementGraphNode = {
  readonly id: string;
  readonly kind: 'customer' | 'order' | 'payment' | 'product' | 'plan' | 'entitlement' | 'capability' | AccessNodeKind;
  readonly label: string;
  readonly currentState: string;
  readonly intendedState: string;
};
export function buildEntitlementGraph(input: EntitlementGraphInput) {
  const nodes: EntitlementGraphNode[] = [
    {
      id: input.order.customerId,
      kind: 'customer',
      label: 'Customer',
      currentState: 'linked',
      intendedState: 'linked',
    },
    {
      id: input.order.id,
      kind: 'order',
      label: 'Order',
      currentState: input.order.status,
      intendedState: 'completed',
    },
  ];
  if (input.payment) {
    nodes.push({
      id: input.payment.id,
      kind: 'payment',
      label: 'Payment',
      currentState: input.payment.status,
      intendedState: 'completed',
    });
  }
  nodes.push({
    id: input.order.productId,
    kind: 'product',
    label: 'Product',
    currentState: 'configured',
    intendedState: 'configured',
  });
  if (input.order.planId) {
    nodes.push({
      id: input.order.planId,
      kind: 'plan',
      label: 'Plan',
      currentState: 'configured',
      intendedState: 'configured',
    });
  }
  if (input.entitlement) {
    nodes.push({
      id: input.entitlement.id,
      kind: 'entitlement',
      label: 'Entitlement',
      currentState: input.entitlement.status,
      intendedState: 'active',
    });
  }
  for (const capability of input.capabilities) {
    nodes.push({
      id: `capability:${capability.key}`,
      kind: 'capability',
      label: capability.name,
      currentState: capability.granted ? 'active' : 'revoked',
      intendedState: capability.granted ? 'active' : 'revoked',
    });
  }
  for (const access of input.access) {
    nodes.push({
      id: access.id,
      kind: access.kind,
      label: access.label,
      currentState: access.state,
      intendedState: 'active',
    });
  }
  const entitlementId = input.entitlement?.id;
  const affectedNodeIds = input.previewAction
    ? nodes
        .filter((node) => node.id === entitlementId
          || node.kind === 'capability'
          || !['customer', 'order', 'payment', 'product', 'plan'].includes(node.kind))
        .map((node) => node.id)
    : [];

  const productParent = input.order.planId ?? input.order.productId;
  const accessParent = input.entitlement?.id ?? productParent;
  const edges = [
    { from: input.order.customerId, to: input.order.id },
    ...(input.payment ? [{ from: input.order.id, to: input.payment.id }] : []),
    { from: input.order.id, to: input.order.productId },
    ...(input.order.planId ? [{ from: input.order.productId, to: input.order.planId }] : []),
    ...(input.entitlement ? [{ from: productParent, to: input.entitlement.id }] : []),
    ...input.capabilities.map((capability) => ({ from: accessParent, to: `capability:${capability.key}` })),
    ...input.access.map((access) => ({ from: accessParent, to: access.id })),
  ];

  return {
    nodes,
    edges,
    revisions: { product: input.productRevision, policy: input.policyRevision },
    operationHistory: input.operationHistory,
    preview: input.previewAction
      ? {
          action: input.previewAction,
          affectedNodeIds,
          irreversible: input.payment ? [input.payment.id] : [],
        }
      : null,
  };
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function merchantRowsToCsv(
  columns: readonly string[],
  rows: readonly Readonly<Record<string, string | number | boolean | null>>[],
  sortColumn: string,
): string {
  const ordered = [...rows].sort((left, right) => (
    String(left[sortColumn] ?? '').localeCompare(String(right[sortColumn] ?? ''))
  ));
  return `${columns.join(',')}\r\n${ordered
    .map((row) => columns.map((column) => csvCell(row[column] ?? null)).join(','))
    .join('\r\n')}\r\n`;
}

export const RISK_CASE_KINDS = [
  'suspected_fraud',
  'confirmed_fraud',
  'payment_dispute',
  'chargeback',
  'ordinary_refund',
  'duplicate_payment',
  'support_cancellation',
] as const;

export type RiskCaseKind = (typeof RISK_CASE_KINDS)[number];
export type RiskCaseAction = 'confirm_fraud' | 'record_dispute' | 'record_chargeback'
  | 'record_refund' | 'mark_duplicate' | 'support_cancel' | 'dismiss';

const RISK_TRANSITIONS: Readonly<Partial<Record<RiskCaseKind, Readonly<Partial<Record<RiskCaseAction, RiskCaseKind | 'dismissed'>>>>>> = {
  suspected_fraud: { confirm_fraud: 'confirmed_fraud', dismiss: 'dismissed' },
  confirmed_fraud: { record_dispute: 'payment_dispute', record_chargeback: 'chargeback' },
  payment_dispute: { record_chargeback: 'chargeback', record_refund: 'ordinary_refund' },
  ordinary_refund: { dismiss: 'dismissed' },
  duplicate_payment: { record_refund: 'ordinary_refund' },
  support_cancellation: { record_refund: 'ordinary_refund', dismiss: 'dismissed' },
};

export function transitionRiskCase(
  current: RiskCaseKind,
  action: RiskCaseAction,
): RiskCaseKind | 'dismissed' | null {
  return RISK_TRANSITIONS[current]?.[action] ?? null;
}

const RISK_POLICIES = {
  suspected_fraud: ['hold', 'hold'], confirmed_fraud: ['revoke', 'suspend'],
  payment_dispute: ['hold', 'suspend'], chargeback: ['revoke', 'revoke'],
  ordinary_refund: ['revoke', 'revoke'], duplicate_payment: ['hold', 'continue'],
  support_cancellation: ['continue', 'revoke'], dismissed: ['continue', 'continue'],
} as const;

export function riskCasePolicy(kind: RiskCaseKind | 'dismissed') {
  const [fulfillmentAction, entitlementAction] = RISK_POLICIES[kind];
  return { fulfillmentAction, entitlementAction };
}
