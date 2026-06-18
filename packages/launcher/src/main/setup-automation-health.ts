export interface DashboardHealthPayload {
  status?: unknown;
  services?: unknown;
}

function formatHealthPayloadError(payload: DashboardHealthPayload | null): string {
  if (!payload || typeof payload !== 'object') {
    return 'Dashboard health endpoint responded without a healthy JSON payload.';
  }

  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const services = payload.services && typeof payload.services === 'object'
    ? Object.entries(payload.services as Record<string, unknown>)
      .map(([name, state]) => `${name}=${String(state)}`)
      .join(', ')
    : '';

  return services
    ? `Dashboard health is ${status}; services: ${services}.`
    : `Dashboard health is ${status}.`;
}

export function evaluateDashboardHealthPayload(payload: unknown): { ok: boolean; error?: string } {
  const body = payload && typeof payload === 'object'
    ? payload as DashboardHealthPayload
    : null;

  if (body?.status === 'healthy') {
    return { ok: true };
  }

  return { ok: false, error: formatHealthPayloadError(body) };
}
