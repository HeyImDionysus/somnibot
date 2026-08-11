export class ClientApiError extends Error {
  readonly name = 'ClientApiError';

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ApiPayload = Readonly<Record<string, unknown>>;
export type ApiValueGuard<T> = (value: unknown) => value is T;

export function isApiRecord(value: unknown): value is ApiPayload {
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

  if (!isApiRecord(decoded)) {
    throw new ClientApiError(fallback, response.status);
  }

  if (!response.ok || decoded.success !== true) {
    throw new ClientApiError(errorMessage(decoded, fallback), response.status);
  }

  return decoded;
}

export function requireApiArray<T>(
  payload: ApiPayload,
  key: string,
  guard: ApiValueGuard<T>,
  fallback: string,
): T[] {
  const value = payload[key];
  if (!Array.isArray(value) || !value.every(guard)) {
    throw new ClientApiError(fallback, 502);
  }
  return value;
}

export function requireApiRecord(
  payload: ApiPayload,
  key: string,
  fallback: string,
): ApiPayload {
  const value = payload[key];
  if (!isApiRecord(value)) {
    throw new ClientApiError(fallback, 502);
  }
  return value;
}

export function requireReadback(confirmed: boolean, message: string): void {
  if (!confirmed) throw new ClientApiError(message, 409);
}

export function hasStringId(value: unknown): value is ApiPayload & { readonly id: string } {
  return isApiRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}
