export class CriticalAuditWriteError extends Error {
  readonly name = 'CriticalAuditWriteError';

  constructor(
    readonly operationId: string,
    readonly writeFailure: string,
  ) {
    super(`Critical audit write failed for operation ${operationId}: ${writeFailure}`);
  }
}

export function assertCriticalAuditWriteSucceeded(
  operationId: string,
  writeFailure: string | null,
): void {
  if (writeFailure !== null) {
    throw new CriticalAuditWriteError(operationId, writeFailure);
  }
}
