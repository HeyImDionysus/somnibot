import { RuntimeIdentitySchema, type RuntimeIdentity } from '@somnibot/shared';

export interface DashboardHealthPayload {
  status?: unknown;
  services?: unknown;
  runtimeIdentity?: unknown;
}

export interface DashboardHealthEvaluation {
  ok: boolean;
  status: string;
  services: Record<string, string>;
  runtimeIdentity?: RuntimeIdentity;
  error?: string;
}

function extractServices(payload: DashboardHealthPayload | null): Record<string, string> {
  if (!payload?.services || typeof payload.services !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(payload.services as Record<string, unknown>)
      .map(([name, state]) => [name, String(state)]),
  );
}

function formatHealthPayloadError(payload: DashboardHealthPayload | null, services: Record<string, string>): string {
  if (!payload || typeof payload !== 'object') {
    return 'Dashboard health endpoint responded without a healthy JSON payload.';
  }

  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const serviceSummary = Object.entries(services)
    .map(([name, state]) => `${name}=${state}`)
    .join(', ');

  return serviceSummary
    ? `Dashboard health is ${status}; services: ${serviceSummary}.`
    : `Dashboard health is ${status}.`;
}

export function evaluateDashboardHealthPayload(payload: unknown): DashboardHealthEvaluation {
  const body = payload && typeof payload === 'object'
    ? payload as DashboardHealthPayload
    : null;
  const status = typeof body?.status === 'string' ? body.status : 'unknown';
  const services = extractServices(body);
  const runtimeIdentity = RuntimeIdentitySchema.safeParse(body?.runtimeIdentity);

  if (body?.status === 'healthy') {
    return {
      ok: true,
      status,
      services,
      ...(runtimeIdentity.success ? { runtimeIdentity: runtimeIdentity.data } : {}),
    };
  }

  return {
    ok: false,
    status,
    services,
    error: formatHealthPayloadError(body, services),
  };
}
