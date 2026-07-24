/**
 * _run-domain.mjs — run ONE domain proof in a fresh process with a hard timeout.
 *
 * Fresh process per domain avoids cross-domain connection/timer accumulation, and
 * the self-timeout isolates a hanging authored scenario (prints {hang:true} + exits).
 * Prints a single JSON line: { id, pass, gated, fail, error, hang, findings }.
 *
 * Usage: node _run-domain.mjs <domainId>
 */
// Arm the loopback guard env BEFORE importing the bot/testkit (mirrors live-setup.ts).
const DEMO_SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const DEMO_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  DISCORD_GUILD_ID: 'e2e-live-disposable-guild',
  SOMNIBOT_E2E_DISPOSABLE_GUILD_ID: 'e2e-live-disposable-guild',
  DISCORD_TOKEN: 'e2e-live-no-login-dummy-token',
  DISCORD_APPLICATION_ID: '000000000000000000',
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || DEMO_SERVICE,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || DEMO_SERVICE,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || DEMO_ANON,
  // Real Valkey (local docker / CI service) so cooldown/streak/rate-limit legs drive.
  VALKEY_URL: process.env.VALKEY_URL || 'redis://localhost:6379',
  SOMNIBOT_LOOPBACK_E2E_CONFIRMATION:
    'I_UNDERSTAND_THIS_MUTATES_A_DISPOSABLE_DISCORD_GUILD_AND_LOCAL_SUPABASE',
  PAYPAL_ENV: 'sandbox',
});

const id = process.argv[2];
const emit = (o) => console.log('RESULT ' + JSON.stringify({ id, ...o }));

const hardTimeout = setTimeout(() => {
  emit({ hang: true, pass: 0, gated: 0, fail: 0, findings: [] });
  process.exit(0);
}, 150_000);
hardTimeout.unref?.();

try {
  const mod = await import('./dist/scenario-runner/index.js');
  const proof = mod.ALL_DOMAIN_PROOFS.find((p) => p.domainId === id);
  if (!proof) {
    emit({ error: 'no proof for domain', pass: 0, gated: 0, fail: 0, findings: [] });
    process.exit(0);
  }
  const capabilities = await mod.detectCapabilities();
  const report = await mod.runDomainProof(proof, { capabilities });
  const s = mod.summarize(report);
  emit({
    pass: s.pass,
    gated: s.gated,
    fail: s.fail,
    findings: report.findings.map((f) => ({ scenario: f.scenarioClass, class: f.assertionClass, impact: f.impact })),
    errored: report.scenarios.filter((x) => x.error).map((x) => `${x.scenarioClass}: ${x.error}`),
  });
} catch (err) {
  emit({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), pass: 0, gated: 0, fail: 0, findings: [] });
} finally {
  clearTimeout(hardTimeout);
  // Force exit so leaked realtime timers/sockets can't keep the process alive.
  setTimeout(() => process.exit(0), 500).unref?.();
}
