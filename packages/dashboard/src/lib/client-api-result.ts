export class ClientApiError extends Error {
  readonly name = 'ClientApiError';

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ApiPayload = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is ApiPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(payload: ApiPayload, fallback: string): string {
  return typeof payload.error === 'string' && payload.error.trim()
    ? payload.error
    : fallback;
}

export async function requireApiSuccess(
  response: Response,
  fallback: string,
): Promise<ApiPayload> {
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch (error) {
    throw new ClientApiError(
      response.ok ? fallback : `${fallback} (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!isRecord(decoded)) {
    throw new ClientApiError(fallback, response.status);
  }

  if (!response.ok || decoded.success !== true) {
    throw new ClientApiError(errorMessage(decoded, fallback), response.status);
  }

  return decoded;
}
