export type RefundRequestResult =
  | { ok: true; status: 'completed'; message: null }
  | { ok: true; status: 'pending'; message: string }
  | {
      ok: false;
      httpStatus: number | null;
      status: string | null;
      code: string | null;
      error: string;
    };

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

export async function requestOrderRefund(
  orderId: string,
  csrfHeaders: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<RefundRequestResult> {
  try {
    const response = await fetchImpl(`/api/orders/${encodeURIComponent(orderId)}/refund`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...csrfHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revoke_entitlements: true }),
    });
    const body: unknown = await response.json().catch(() => null);
    const row = asRecord(body);

    if (
      response.ok
      && response.status === 200
      && row?.success === true
      && row.status === 'completed'
    ) {
      return { ok: true, status: 'completed', message: null };
    }
    if (
      response.ok
      && response.status === 202
      && row?.success === true
      && row.status === 'pending'
      && nonBlankString(row.message)
    ) {
      return { ok: true, status: 'pending', message: nonBlankString(row.message)! };
    }

    return {
      ok: false,
      httpStatus: response.status,
      status: nonBlankString(row?.status),
      code: nonBlankString(row?.code),
      error: nonBlankString(row?.error) ?? `Refund request failed (${response.status}).`,
    };
  } catch {
    return {
      ok: false,
      httpStatus: null,
      status: null,
      code: 'NETWORK_ERROR',
      error: 'Refund request could not reach the server. Please retry.',
    };
  }
}
