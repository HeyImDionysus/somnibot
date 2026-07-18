export type PersistedRefundUiState = 'pending' | 'provider_completed' | 'failed' | 'retry';
export type PersistedRefundContext = 'provider' | 'local';

export type ParsedOrderList<T> =
  | {
      ok: true;
      orders: T[];
      total: number;
      refundStates: Record<string, PersistedRefundUiState>;
    }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isPersistedRefundUiState(value: unknown): value is PersistedRefundUiState {
  return ['pending', 'provider_completed', 'failed', 'retry'].includes(value as string);
}

function isPersistedRefundContext(value: unknown): value is PersistedRefundContext {
  return value === 'provider' || value === 'local';
}

export function parseOrderListPayload<T extends { id: string }>(
  responseOk: boolean,
  value: unknown,
): ParsedOrderList<T> {
  const row = asRecord(value);
  if (!responseOk || row?.success !== true) {
    return {
      ok: false,
      error: nonBlankString(row?.error) ?? 'Order list request failed',
    };
  }
  if (
    !Array.isArray(row.data)
    || !Number.isSafeInteger(row.total)
    || (row.total as number) < 0
  ) {
    return { ok: false, error: 'Order list response was malformed' };
  }

  const orders: T[] = [];
  const refundStates: Record<string, PersistedRefundUiState> = {};
  const seenOrderIds = new Set<string>();
  for (const candidate of row.data) {
    const order = asRecord(candidate);
    const id = nonBlankString(order?.id);
    const refundState = order?.refund_state;
    const refundContext = order?.refund_context;
    if (
      !order
      || !id
      || order.id !== id
      || seenOrderIds.has(id)
      || (refundState !== null && !isPersistedRefundUiState(refundState))
      || (refundContext !== null && !isPersistedRefundContext(refundContext))
      || (['pending', 'provider_completed', 'failed'].includes(refundState as string)
        && refundContext !== 'provider')
      || (refundState === 'retry' && refundContext === null)
    ) {
      return { ok: false, error: 'Order list response was malformed' };
    }
    seenOrderIds.add(id);
    if (refundState !== null) refundStates[id] = refundState;
    orders.push(order as T);
  }

  return {
    ok: true,
    orders,
    total: row.total as number,
    refundStates,
  };
}

export interface LatestOrderListLoadHandlers<T> {
  onStart: () => void;
  onSuccess: (value: T) => void;
  onFailure: () => void;
  onFinish: () => void;
}

/**
 * Run one list request while allowing only the latest-started request to
 * mutate component state. `null` means a newer request superseded this one.
 */
export async function runLatestOrderListLoad<T>(
  sequence: { current: number },
  request: () => Promise<T>,
  handlers: LatestOrderListLoadHandlers<T>,
): Promise<boolean | null> {
  const requestSequence = ++sequence.current;
  handlers.onStart();

  let value: T;
  try {
    value = await request();
  } catch {
    if (requestSequence !== sequence.current) return null;
    handlers.onFailure();
    handlers.onFinish();
    return false;
  }

  if (requestSequence !== sequence.current) return null;
  handlers.onSuccess(value);
  handlers.onFinish();
  return true;
}
