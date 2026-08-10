/**
 * _run-domain.mjs — run ONE domain proof in a fresh process with a hard timeout.
 *
 * Fresh process per domain avoids cross-domain connection/timer accumulation, and
 * the self-timeout isolates a hanging authored scenario (prints {hang:true} + exits).
 * Prints a single JSON line: { id, pass, gated, fail, error, hang, findings }.
 *
 * Usage: node _run-domain.mjs <domainId>
 */
// Arm the loopback guard env BEFORE importing the bot/testkit (mirrors
// live-setup.ts). Credentials come from an isolated override or the local
// Supabase CLI status; there are no embedded/demo-key fallbacks.
const { resolveLocalSupabaseCredentials } = await import('./dist/local-supabase.js');
const localSupabase = resolveLocalSupabaseCredentials();
// ── Fault proxies ────────────────────────────────────────────────────────────
// Route the WHOLE process through local TCP fault proxies so DEPFAIL/RETRY
// scenarios can sever/restore a REAL network path (ctx.faults). Importing
// dist/fault-proxy.js alone pulls no bot code, so env can still be armed after.
// Falls back to direct URLs if a proxy cannot start (fault scenarios then GATE).
// The child runner does not pass through Vitest's live-setup.ts, so it must
// independently force the same explicit isolated endpoints before importing
// production code. Ambient developer/production connection settings are never
// a valid fleet target.
const DIRECT_SUPABASE = localSupabase.url;
const DIRECT_VALKEY = process.env.SOMNIBOT_E2E_VALKEY_URL || 'redis://127.0.0.1:6379';
const { assertSupabaseUrlIsLocal, assertValkeyUrlIsLocal } = await import('./dist/guard.js');
assertSupabaseUrlIsLocal(DIRECT_SUPABASE, 'SOMNIBOT_E2E_SUPABASE_URL');
assertValkeyUrlIsLocal(DIRECT_VALKEY, 'SOMNIBOT_E2E_VALKEY_URL');

// Never carry unrelated customer/production Supabase variables into the
// isolated child. The resolver has already read the local source of truth.
for (const key of Object.keys(process.env)) {
  if (/^SUPABASE_/i.test(key)) delete process.env[key];
}

let faultControls = null;
let supabaseUrl = DIRECT_SUPABASE;
let valkeyUrl = DIRECT_VALKEY;
try {
  const { startFaultProxy } = await import('./dist/fault-proxy.js');
  const supabaseTarget = new URL(DIRECT_SUPABASE);
  const valkeyTarget = new URL(DIRECT_VALKEY);
  const [sbProxy, vkProxy] = await Promise.all([
    startFaultProxy(supabaseTarget.hostname || '127.0.0.1', Number(supabaseTarget.port) || 54321, 0),
    startFaultProxy(valkeyTarget.hostname || '127.0.0.1', Number(valkeyTarget.port) || 6379, 0),
  ]);
  faultControls = { supabase: sbProxy, valkey: vkProxy };
  supabaseUrl = `http://127.0.0.1:${sbProxy.port}`;
  valkeyUrl = `redis://127.0.0.1:${vkProxy.port}`;
} catch {
  // No proxies — direct connection; fault scenarios gate honestly.
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: supabaseUrl,
  DISCORD_GUILD_ID: 'e2e-live-disposable-guild',
  SOMNIBOT_E2E_DISPOSABLE_GUILD_ID: 'e2e-live-disposable-guild',
  DISCORD_TOKEN: 'e2e-live-no-login-dummy-token',
  DISCORD_APPLICATION_ID: '000000000000000000',
  // The resolver supplied current keys from an isolated E2E shard or local
  // CLI status. Never inherit launcher/customer credentials into this rig.
  SUPABASE_SECRET_KEY: localSupabase.serviceRoleKey,
  SUPABASE_SERVICE_ROLE_KEY: localSupabase.serviceRoleKey,
  SUPABASE_ANON_KEY: localSupabase.anonKey,
  // Real, isolated Valkey so cooldown/streak/rate-limit legs drive.
  VALKEY_URL: valkeyUrl,
  // Disposable Valkey is deliberately unauthenticated. Clearing an ambient
  // password prevents a child from inheriting an established installation's
  // connection shape.
  VALKEY_PASSWORD: '',
  SOMNIBOT_LOOPBACK_E2E_CONFIRMATION:
    'I_UNDERSTAND_THIS_MUTATES_A_DISPOSABLE_DISCORD_GUILD_AND_LOCAL_SUPABASE',
  PAYPAL_ENV: 'sandbox',
});

const id = process.argv[2];
const emit = (o) => console.log('RESULT ' + JSON.stringify({ id, ...o }));
let activeScenario = 'initialization';
const completedScenarios = [];

const hardTimeout = setTimeout(() => {
  emit({
    hang: true,
    pass: 0,
    gated: 0,
    fail: 0,
    findings: [],
    activeScenario,
    completedScenarios,
  });
  process.exit(0);
}, 300_000);
hardTimeout.unref?.();

try {
  const mod = await import('./dist/scenario-runner/index.js');
  // Register AFTER the dist import: fault-proxy.js is the same module instance
  // context.ts reads via getFaultControls(), so ctx.faults resolves these.
  if (faultControls) {
    const { registerFaultControls } = await import('./dist/fault-proxy.js');
    registerFaultControls(faultControls);
  }
  const proof = mod.ALL_DOMAIN_PROOFS.find((p) => p.domainId === id);
  if (!proof) {
    emit({ error: 'no proof for domain', pass: 0, gated: 0, fail: 0, findings: [] });
    process.exit(0);
  }
  const capabilities = await mod.detectCapabilities();
  const report = await mod.runDomainProof(proof, {
    capabilities,
    onScenarioStart(scenarioClass) {
      activeScenario = scenarioClass;
    },
    onScenarioComplete(scenarioClass, elapsedMs) {
      completedScenarios.push({ scenarioClass, elapsedMs });
      activeScenario = 'report-assembly';
    },
  });
  const s = mod.summarize(report);
  // The fleet aggregate closes functional assertion cells, not every internal
  // facet record. A class is GATED when any of its records is gated; emit one
  // deterministic inventory entry per scenario/class so the manifest count
  // matches summarize(report).gated and external receipts cannot be duplicated
  // or silently hidden behind raw facet multiplicity.
  const gates = report.scenarios.flatMap((scenario) =>
    scenario.classes.flatMap((evidence) => {
      if (evidence.status !== 'GATED') return [];
      const record = evidence.records.find((candidate) => candidate.status === 'GATED')
        ?? evidence.records[0];
      return [{
        scenario: scenario.scenarioClass,
        class: evidence.assertionClass,
        channel: record.channel,
        promise: record.promise,
        reason: record.gateReason ?? '(no gate reason recorded)',
      }];
    }),
  );
  emit({
    pass: s.pass,
    gated: s.gated,
    fail: s.fail,
    capabilities: report.capabilities,
    completedScenarios,
    findings: report.findings.map((f) => ({
      scenario: f.scenarioClass,
      class: f.assertionClass,
      promise: f.promise,
      observation: f.observation,
      impact: f.impact,
    })),
    gates,
    errored: report.scenarios.filter((x) => x.error).map((x) => `${x.scenarioClass}: ${x.error}`),
  });
} catch (err) {
  emit({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), pass: 0, gated: 0, fail: 0, findings: [] });
} finally {
  clearTimeout(hardTimeout);
  // Force exit so leaked realtime timers/sockets can't keep the process alive.
  setTimeout(() => process.exit(0), 500).unref?.();
}
