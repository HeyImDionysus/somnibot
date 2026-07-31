/**
 * Deterministic entitlement selection for portal downloads.
 *
 * Review 3689865702: an unordered find() over a customer's live entitlements
 * bound the signed URL — and the delivery evidence the store control room
 * reads — to an ARBITRARY row. With a re-buy or an overlapping manual grant,
 * the download for the current purchase could be recorded against an older
 * order (or an orderless grant), and the current paid order then reported as
 * missing its required download.
 *
 * Order-bearing entitlements outrank orderless grants; within each group the
 * newest wins. (A route file cannot export helpers — Next's route-type check
 * rejects non-handler exports — hence this module.)
 */
export interface SelectableEntitlement {
  id: string;
  order_id: string | null;
  created_at?: string | null;
}

export function selectDownloadEntitlement<T extends SelectableEntitlement>(
  liveEntitlements: readonly T[],
): T | undefined {
  return [...liveEntitlements].sort((a, b) => {
    const aHasOrder = a.order_id ? 1 : 0;
    const bHasOrder = b.order_id ? 1 : 0;
    if (aHasOrder !== bHasOrder) return bHasOrder - aHasOrder;
    return Date.parse(String(b.created_at ?? 0)) - Date.parse(String(a.created_at ?? 0));
  })[0];
}
