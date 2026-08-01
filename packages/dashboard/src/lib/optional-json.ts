/**
 * Fetch optional API data without allowing a failed or malformed secondary
 * response to invalidate authoritative page state that has already loaded.
 */
export async function fetchOptionalJsonArray<T>(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T[]> {
  try {
    const response = await fetchImpl(url);
    const body = await response.json();
    return response.ok && body.success && Array.isArray(body.data)
      ? body.data as T[]
      : [];
  } catch {
    return [];
  }
}
