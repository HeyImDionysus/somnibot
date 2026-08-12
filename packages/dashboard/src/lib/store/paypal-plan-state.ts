import { getPayPalToken, type PayPalRuntimeConfig } from '@/lib/paypal';

type PayPalPlanStateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

async function readPlanStatus(
  config: PayPalRuntimeConfig,
  planId: string,
  token: string,
): Promise<'ACTIVE' | 'INACTIVE' | 'CREATED' | null> {
  const response = await fetch(`${config.apiBase}/v1/billing/plans/${encodeURIComponent(planId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (
    typeof body === 'object'
    && body !== null
    && 'status' in body
    && (body.status === 'ACTIVE' || body.status === 'INACTIVE' || body.status === 'CREATED')
  ) {
    return body.status;
  }
  return null;
}

async function reconcilePayPalPlanState(
  config: PayPalRuntimeConfig,
  planId: string,
  active: boolean,
): Promise<PayPalPlanStateResult> {
  const token = await getPayPalToken(config);
  if (!token) return { ok: false, error: 'PayPal authentication failed while reconciling the billing plan.' };

  const target = active ? 'ACTIVE' : 'INACTIVE';
  const current = await readPlanStatus(config, planId, token);
  if (!current) return { ok: false, error: 'PayPal billing-plan status could not be read.' };
  if (current === target) return { ok: true };
  if (!active && current === 'CREATED') return { ok: true };

  const action = active ? 'activate' : 'deactivate';
  const transition = await fetch(
    `${config.apiBase}/v1/billing/plans/${encodeURIComponent(planId)}/${action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    },
  );
  if (!transition.ok) {
    return { ok: false, error: `PayPal billing plan could not be ${active ? 'activated' : 'deactivated'}.` };
  }

  const verified = await readPlanStatus(config, planId, token);
  return verified === target
    ? { ok: true }
    : { ok: false, error: 'PayPal billing-plan status did not match after reconciliation.' };
}

export async function ensurePayPalPlanState(
  config: PayPalRuntimeConfig,
  planId: string,
  active: boolean,
): Promise<PayPalPlanStateResult> {
  try {
    return await reconcilePayPalPlanState(config, planId, active);
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error
        ? `PayPal billing-plan reconciliation failed: ${caught.message}`
        : 'PayPal billing-plan reconciliation failed unexpectedly.',
    };
  }
}
