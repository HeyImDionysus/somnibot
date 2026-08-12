/**
 * Build SUPABASE_DB_URL from the project URL and database password.
 * Kept separate from Electron-backed config storage so the endpoint contract
 * can be exercised directly in unit tests.
 */
export function buildDbUrlEnv(
  supabaseUrl: string,
  dbPassword: string,
  connectionTemplate = '',
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
  if (connectionTemplate) {
    try {
      const template = new URL(connectionTemplate);
      if (
        template.protocol !== 'postgresql:'
        || !template.hostname.endsWith('.pooler.supabase.com')
        || template.port !== '5432'
        || template.password
        || template.search
        || template.hash
      ) return {};
      template.password = dbPassword;
      return { SUPABASE_DB_URL: template.toString() };
    } catch {
      return {};
    }
  }
  return {
    SUPABASE_DB_URL:
      `postgresql://postgres:${encodeURIComponent(dbPassword)}`
      + `@db.${ref}.supabase.co:5432/postgres`,
  };
}
