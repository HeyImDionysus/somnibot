/**
 * Build SUPABASE_DB_URL from the project URL and database password.
 * Kept separate from Electron-backed config storage so the endpoint contract
 * can be exercised directly in unit tests.
 */
export function buildDbUrlEnv(
  supabaseUrl: string,
  dbPassword: string,
): Record<string, string> {
  if (!dbPassword || !supabaseUrl) return {};
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    return {};
  }
  if (parsed.protocol !== 'https:') return {};
  const ref = parsed.hostname.toLowerCase()
    .match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!ref) return {};
  return {
    SUPABASE_DB_URL:
      `postgresql://postgres:${encodeURIComponent(dbPassword)}`
      + `@db.${ref}.supabase.co:5432/postgres`,
  };
}
