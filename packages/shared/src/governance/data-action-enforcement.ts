import { z } from 'zod';
import { DataGovernanceSchema } from '../capability-manifests/schema.js';

const GovernedDataActionRequestSchema = z.object({
  action: z.enum(['retention', 'export', 'erasure']),
  operationId: z.string().trim().min(1),
}).strict();

const GovernanceActionReceiptSchema = z.object({
  operationId: z.string().trim().min(1),
  affectedRecords: z.number().int().nonnegative(),
  retainedRecords: z.number().int().nonnegative(),
}).strict();

export type GovernanceActionReceipt = z.output<typeof GovernanceActionReceiptSchema>;

export class GovernanceReceiptError extends Error {
  readonly name = 'GovernanceReceiptError';

  constructor(readonly operationId: string) {
    super(`Governance action receipt did not match operation ${operationId}`);
  }
}

export async function executeGovernedDataAction(
  policyInput: z.input<typeof DataGovernanceSchema>,
  requestInput: z.input<typeof GovernedDataActionRequestSchema>,
  execute: (requirement: string) => Promise<z.input<typeof GovernanceActionReceiptSchema>>,
): Promise<GovernanceActionReceipt> {
  const policy = DataGovernanceSchema.parse(policyInput);
  const request = GovernedDataActionRequestSchema.parse(requestInput);
  const receipt = GovernanceActionReceiptSchema.parse(await execute(requirementFor(policy, request.action)));
  if (receipt.operationId !== request.operationId) {
    throw new GovernanceReceiptError(request.operationId);
  }
  return receipt;
}

function requirementFor(
  policy: z.output<typeof DataGovernanceSchema>,
  action: z.output<typeof GovernedDataActionRequestSchema>['action'],
): string {
  switch (action) {
    case 'retention':
      return `${policy.retention} ${policy.cleanup}`;
    case 'export':
      return policy.exportBehavior;
    case 'erasure':
      return `${policy.erasureBehavior} ${policy.anonymization} ${policy.backupImplications}`;
  }
}
