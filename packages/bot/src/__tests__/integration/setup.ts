import { assertLoopbackUrl, bootstrapLocalSupabase } from './supabase-bootstrap.js';

if (process.env.SOMNIBOT_INTEGRATION_USE_INJECTED_TARGET === '1') {
  const apiUrl = process.env.SUPABASE_URL;
  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiUrl || !dbUrl || !serviceKey || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('Injected integration target requires loopback API/DB URLs and Supabase test keys');
  }
  assertLoopbackUrl(apiUrl, 'SUPABASE_URL');
  assertLoopbackUrl(dbUrl, 'SUPABASE_DB_URL');
} else {
  bootstrapLocalSupabase();
}
