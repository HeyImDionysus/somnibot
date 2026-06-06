export const SETUP_CSRF_UNAVAILABLE_MESSAGE =
  'Security token unavailable. Refresh the setup page and try again.';

export function buildSetupRequestHeaders(csrfHeaders: Record<string, string>): Record<string, string> {
  const token = csrfHeaders['X-CSRF-Token'];
  if (!token) {
    throw new Error(SETUP_CSRF_UNAVAILABLE_MESSAGE);
  }

  return {
    ...csrfHeaders,
    'Content-Type': 'application/json',
  };
}
