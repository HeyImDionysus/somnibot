/**
 * Phase 3 End-to-End Deploy Test
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

// Load from environment — never hardcode credentials
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!DISCORD_TOKEN || !DISCORD_GUILD_ID || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing required env vars: DISCORD_TOKEN, DISCORD_GUILD_ID, SUPABASE_URL, SUPABASE_SECRET_KEY');
  console.error('   Make sure your .env file is loaded (run from repo root with: source .env && bun run packages/bot/tests/test-deploy-e2e.ts)');
  process.exit(1);
}

const TEST_DESIRED_STATE = {
  everyonePermissions: '0',
  roles: [
    { key: 'test-admin', name: 'Test-Admin', tier: 'admin', permissions: '8', color: 0xFF1493, hoist: true, mentionable: false, position: 1 },
    { key: 'test-member', name: 'Test-Member', tier: 'member', permissions: '1024', color: 0x00D4FF, hoist: false, mentionable: false, position: 0 },
  ],
  categories: [
    { key: 'cat-test', name: 'Test Zone', position: 0 },
  ],
  channels: [
    { key: 'test-general', name: 'test-general', type: ChannelType.GuildText, categoryKey: 'cat-test', position: 0, topic: 'Phase 3 test channel', slowmode: 0, nsfw: false, templateId: 'open', overrides: [] },
    { key: 'test-voice', name: 'Test Voice', type: ChannelType.GuildVoice, categoryKey: 'cat-test', position: 1, topic: null, slowmode: 0, nsfw: false, templateId: 'voice', overrides: [] },
  ],
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Phase 3: Deploy E2E Test                  ║');
  console.log('╚════════════════════════════════════════════╝\n');

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  await client.login(DISCORD_TOKEN);
  await new Promise<void>((resolve) => client.once('ready', () => resolve()));
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID)!;
  console.log(`Connected: ${client.user?.tag} in ${guild.name}\n`);

  // Test 1: Supabase
  console.log('Test 1: Supabase Connectivity');
  const { error: guildErr } = await supabase.from('guild').select('id').eq('id', DISCORD_GUILD_ID).single();
  assert(!guildErr, 'Guild table accessible');

  // Test 2: Write desired state
  console.log('\nTest 2: Write Desired State');
  const { error: writeErr } = await supabase.from('guild_desired_state').upsert({
    guild_id: DISCORD_GUILD_ID,
    roles: TEST_DESIRED_STATE.roles,
    channels: TEST_DESIRED_STATE.channels,
    permission_map: {},
    applied_at: null,
  }, { onConflict: 'guild_id' });
  assert(!writeErr, `Desired state written`);

  const { data: readBack } = await supabase.from('guild_desired_state').select('*').eq('guild_id', DISCORD_GUILD_ID).single();
  assert(readBack?.applied_at === null, 'applied_at is null (deploy pending)');
  assert(Array.isArray(readBack?.roles) && readBack.roles.length === 2, '2 roles in desired state');
  assert(Array.isArray(readBack?.channels) && readBack.channels.length === 2, '2 channels in desired state');

  // Test 3: Deployer pre-flight checks
  console.log('\nTest 3: Pre-Flight Checks');
  const { checkBotRolePosition, checkBotPermissions } = await import('./src/guards/bot-role-guard.js');
  const roleCheck = await checkBotRolePosition(guild);
  assert(roleCheck.isTopPosition, 'Bot role at position #1');
  const permCheck = checkBotPermissions(guild);
  assert(permCheck.hasRequired, 'Bot has required permissions');

  // Test 4: Deploy with cleanExisting=false (additive only — safe for test server)
  console.log('\nTest 4: Live Deploy (additive, no cleanup)');
  const { deployServerState } = await import('./src/deploy/deployer.js');
  
  const result = await deployServerState(guild, supabase, TEST_DESIRED_STATE, {
    cleanExisting: false,
    dryRun: false,
    onProgress: (step, total, action) => {
      console.log(`    [${step}/${total}] ${action}`);
    },
  });
  
  assert(result.success, `Deploy succeeded (${result.duration}ms)`);
  console.log(`  Actions: ${result.actions.length}, Errors: ${result.errors.length}, ID mappings: ${result.idMappings.length}`);
  
  for (const action of result.actions) {
    console.log(`    ${action.success ? '✓' : '✗'} ${action.action} ${action.entityType}: ${action.entityName}${action.error ? ' — ' + action.error : ''}`);
  }
  for (const err of result.errors) {
    console.log(`    ✗ ERROR: ${err.entityName}: ${err.error}`);
  }

  assert(result.idMappings.length > 0, `ID mappings created (${result.idMappings.length})`);

  // Test 5: Audit log
  console.log('\nTest 5: Audit Log');
  try {
    const { writeAuditLog } = await import('./src/services/audit.js');
    await writeAuditLog(supabase, {
      guildId: DISCORD_GUILD_ID,
      actorType: 'bot',
      actorId: 'test-deploy-e2e',
      action: 'test.e2e.completed',
      details: { actionCount: result.actions.length, duration: result.duration },
      success: true,
    });
    
    const { data: auditLogs } = await supabase.from('audit_logs').select('action, success')
      .eq('guild_id', DISCORD_GUILD_ID).eq('action', 'test.e2e.completed')
      .order('timestamp', { ascending: false }).limit(1);
    assert(auditLogs !== null && auditLogs.length > 0, 'Audit log written and readable');
    passed++; console.log('  ✅ writeAuditLog executed without error');
  } catch (err) {
    console.log(`  ❌ Audit log error: ${err}`);
    failed++;
  }

  // Test 6: ID map persistence
  console.log('\nTest 6: ID Map Persistence');
  if (result.idMappings.length > 0) {
    const { error: mapErr } = await supabase.from('discord_id_map').upsert(
      result.idMappings.map(m => ({
        guild_id: DISCORD_GUILD_ID,
        entity_type: m.entityType,
        template_key: m.key,
        discord_id: m.discordId,
      })),
      { onConflict: 'guild_id,entity_type,template_key' },
    );
    assert(!mapErr, `ID mappings stored (${mapErr?.message ?? 'ok'})`);

    const { data: mapData } = await supabase.from('discord_id_map').select('*')
      .eq('guild_id', DISCORD_GUILD_ID);
    assert(mapData !== null && mapData.length >= result.idMappings.length, `${mapData?.length} mappings in DB`);
  }

  // Test 7: Setup confirm flow
  console.log('\nTest 7: Setup Confirmation');
  await supabase.from('guild_desired_state').update({ applied_at: new Date().toISOString(), drift_detected: false }).eq('guild_id', DISCORD_GUILD_ID);
  const { error: confirmErr } = await supabase.from('guild').update({ setup_completed: true, setup_confirmed_at: new Date().toISOString() }).eq('id', DISCORD_GUILD_ID);
  assert(!confirmErr, 'Setup confirmed');

  const { data: guildData } = await supabase.from('guild').select('setup_completed, setup_confirmed_at').eq('id', DISCORD_GUILD_ID).single();
  assert(guildData?.setup_completed === true, 'setup_completed is true');

  // Test 8: Listener module
  console.log('\nTest 8: Deploy Listener Module');
  const listener = await import('./src/deploy/deploy-listener.js');
  assert(typeof listener.startDeployListener === 'function', 'startDeployListener exported');
  assert(typeof listener.getDeployStatus === 'function', 'getDeployStatus exported');
  assert(listener.getDeployStatus() === null, 'No deploy in progress initially');

  // Test 9: Shared engine exports
  console.log('\nTest 9: Shared Engine');
  const shared = await import('@somnibot/shared');
  assert(typeof shared.computeServerPermissions === 'function', 'computeServerPermissions');
  assert(typeof shared.computeStateDiff === 'function', 'computeStateDiff');
  assert(typeof shared.validateDeployment === 'function', 'validateDeployment');
  assert(typeof shared.classifyDrift === 'function', 'classifyDrift');

  // ============================================================
  // Cleanup: remove test roles and channels
  // ============================================================
  console.log('\nCleanup: Removing test entities...');
  
  // Remove test roles
  for (const mapping of result.idMappings.filter(m => m.entityType === 'role')) {
    const role = guild.roles.cache.get(mapping.discordId);
    if (role && !role.managed) {
      try {
        await role.delete('Phase 3 test cleanup');
        console.log(`  Deleted role: ${role.name}`);
      } catch (e) { console.log(`  Failed to delete role ${mapping.key}: ${e}`); }
    }
  }

  // Remove test channels
  for (const mapping of result.idMappings.filter(m => m.entityType === 'channel' || m.entityType === 'category')) {
    const channel = guild.channels.cache.get(mapping.discordId);
    if (channel) {
      try {
        await channel.delete('Phase 3 test cleanup');
        console.log(`  Deleted channel: ${channel.name}`);
      } catch (e) { console.log(`  Failed to delete channel ${mapping.key}: ${e}`); }
    }
  }

  // Clean up DB test data
  await supabase.from('discord_id_map').delete().eq('guild_id', DISCORD_GUILD_ID);
  await supabase.from('guild').update({ setup_completed: false, setup_confirmed_at: null }).eq('id', DISCORD_GUILD_ID);
  console.log('  DB cleaned up');

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 19 - String(passed).length - String(failed).length))}║`);
  console.log(`╚════════════════════════════════════════════╝`);

  client.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
