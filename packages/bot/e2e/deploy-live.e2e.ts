/**
 * Opt-in live deploy E2E test.
 *
 * This script mutates Discord and Supabase. It must only run against a
 * disposable Discord guild and local Supabase database.
 */
import { ChannelType, Client, GatewayIntentBits, type Guild } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const LIVE_E2E_CONFIRMATION =
  'I_UNDERSTAND_THIS_MUTATES_A_DISPOSABLE_DISCORD_GUILD_AND_LOCAL_SUPABASE';

function failGuard(message: string): never {
  console.error(`Live deploy E2E guard failed: ${message}`);
  console.error('This script mutates Discord and Supabase. Use only with a disposable Discord guild and local Supabase.');
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    failGuard(`Missing required env var: ${name}`);
  }
  return value;
}

function requireLiveDeployE2EEnv() {
  if (process.env.SOMNIBOT_DEPLOY_E2E_CONFIRMATION !== LIVE_E2E_CONFIRMATION) {
    failGuard(`Set SOMNIBOT_DEPLOY_E2E_CONFIRMATION=${LIVE_E2E_CONFIRMATION}`);
  }

  if (process.env.NODE_ENV === 'production') {
    failGuard('NODE_ENV must not be production');
  }

  const discordGuildId = requireEnv('DISCORD_GUILD_ID');
  const disposableGuildId = requireEnv('SOMNIBOT_E2E_DISPOSABLE_GUILD_ID');
  if (discordGuildId !== disposableGuildId) {
    failGuard('DISCORD_GUILD_ID must match SOMNIBOT_E2E_DISPOSABLE_GUILD_ID');
  }

  const supabaseUrl = requireEnv('SUPABASE_URL');
  let parsedSupabaseUrl: URL;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    failGuard('SUPABASE_URL must be a valid URL');
  }

  const localSupabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localSupabaseHosts.has(parsedSupabaseUrl.hostname)) {
    failGuard('SUPABASE_URL must point to local Supabase');
  }

  return {
    discordToken: requireEnv('DISCORD_TOKEN'),
    discordGuildId,
    serviceKey:
      process.env.SUPABASE_SECRET_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || failGuard('Missing required env var: SUPABASE_SECRET_KEY'),
    supabaseUrl,
  };
}

const {
  discordToken: DISCORD_TOKEN,
  discordGuildId: DISCORD_GUILD_ID,
  serviceKey: SERVICE_KEY,
  supabaseUrl: SUPABASE_URL,
} = requireLiveDeployE2EEnv();

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

type DeployResultMapping = {
  entityType: string;
  key: string;
  discordId: string;
};

type SnapshotState = {
  desiredState: Record<string, unknown> | null;
  guild: Record<string, unknown> | null;
  discordIdMap: Record<string, unknown>[];
};

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ok ${label}`); passed++; }
  else { console.log(`  fail ${label}`); failed++; }
}

async function captureSnapshot(supabase: SupabaseClient): Promise<SnapshotState> {
  const { data: desiredState } = await supabase
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', DISCORD_GUILD_ID)
    .maybeSingle();
  const { data: guild } = await supabase
    .from('guild')
    .select('setup_completed, setup_confirmed_at, bot_role_id, bot_role_position, total_roles')
    .eq('id', DISCORD_GUILD_ID)
    .maybeSingle();
  const { data: discordIdMap } = await supabase
    .from('discord_id_map')
    .select('*')
    .eq('guild_id', DISCORD_GUILD_ID);

  return {
    desiredState: desiredState ?? null,
    guild: guild ?? null,
    discordIdMap: discordIdMap ?? [],
  };
}

function getTestEntityIds(guild: Guild) {
  const roleNames = new Set(TEST_DESIRED_STATE.roles.map((role) => role.name));
  const channelNames = new Set([
    ...TEST_DESIRED_STATE.categories.map((category) => category.name),
    ...TEST_DESIRED_STATE.channels.map((channel) => channel.name),
  ]);

  return new Set([
    ...guild.roles.cache.filter((role) => roleNames.has(role.name)).keys(),
    ...guild.channels.cache.filter((channel) => channelNames.has(channel.name)).keys(),
  ]);
}

async function cleanupDiscord(
  guild: Guild | null,
  mappings: DeployResultMapping[],
  preExistingTestEntityIds: Set<string>,
  originalEveryonePermissions: bigint | null,
) {
  if (!guild) {
    return;
  }

  const cleanupReason = 'SomniBot live deploy E2E cleanup';
  const roleNames = new Set(TEST_DESIRED_STATE.roles.map((role) => role.name));
  const channelNames = new Set([
    ...TEST_DESIRED_STATE.categories.map((category) => category.name),
    ...TEST_DESIRED_STATE.channels.map((channel) => channel.name),
  ]);

  try {
    for (const mapping of mappings.filter((mapping) => mapping.entityType === 'role')) {
      const role = guild.roles.cache.get(mapping.discordId);
      if (role && !role.managed) {
        try {
          await role.delete(cleanupReason);
          console.log(`  Deleted role: ${role.name}`);
        } catch (err) {
          console.log(`  Failed to delete role ${mapping.key}: ${err}`);
        }
      }
    }

    for (const mapping of mappings.filter((mapping) => mapping.entityType === 'channel' || mapping.entityType === 'category')) {
      const channel = guild.channels.cache.get(mapping.discordId);
      if (channel) {
        try {
          await channel.delete(cleanupReason);
          console.log(`  Deleted channel: ${channel.name}`);
        } catch (err) {
          console.log(`  Failed to delete channel ${mapping.key}: ${err}`);
        }
      }
    }

    await guild.roles.fetch();
    const remainingTestRoles = guild.roles.cache.filter((role) => (
      roleNames.has(role.name)
      && !role.managed
      && !preExistingTestEntityIds.has(role.id)
    ));
    for (const role of remainingTestRoles.values()) {
      try {
        await role.delete(cleanupReason);
        console.log(`  Deleted role by name: ${role.name}`);
      } catch (err) {
        console.log(`  Failed to delete role by name ${role.name}: ${err}`);
      }
    }

    await guild.channels.fetch();
    const remainingTestChannels = guild.channels.cache.filter((channel) => (
      channelNames.has(channel.name)
      && !preExistingTestEntityIds.has(channel.id)
    ));
    for (const channel of remainingTestChannels.values()) {
      try {
        await channel.delete(cleanupReason);
        console.log(`  Deleted channel by name: ${channel.name}`);
      } catch (err) {
        console.log(`  Failed to delete channel by name ${channel.name}: ${err}`);
      }
    }
  } finally {
    if (originalEveryonePermissions !== null) {
      await guild.roles.everyone.setPermissions(originalEveryonePermissions, `${cleanupReason} - restore @everyone`);
      console.log('  Restored @everyone permissions');
    }
  }
}

async function cleanupDatabase(supabase: SupabaseClient, snapshot: SnapshotState | null) {
  if (!snapshot) {
    return;
  }

  await supabase.from('discord_id_map').delete().eq('guild_id', DISCORD_GUILD_ID);
  if (snapshot.discordIdMap.length > 0) {
    await supabase.from('discord_id_map').upsert(snapshot.discordIdMap);
  }

  // audit_logs is append-only in migrated databases, so cleanup must not delete or replay entries.

  if (snapshot.desiredState) {
    await supabase.from('guild_desired_state').upsert(snapshot.desiredState);
  } else {
    await supabase.from('guild_desired_state').delete().eq('guild_id', DISCORD_GUILD_ID);
  }

  if (snapshot.guild) {
    await supabase.from('guild').update(snapshot.guild).eq('id', DISCORD_GUILD_ID);
  }
}

async function main() {
  console.log('Deploy Live E2E Test');

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  let guild: Guild | null = null;
  let snapshot: SnapshotState | null = null;
  let idMappings: DeployResultMapping[] = [];
  let preExistingTestEntityIds = new Set<string>();
  let originalEveryonePermissions: bigint | null = null;
  let exitCode = 0;

  try {
    snapshot = await captureSnapshot(supabase);

    await client.login(DISCORD_TOKEN);
    await new Promise<void>((resolve) => client.once('ready', () => resolve()));
    guild = client.guilds.cache.get(DISCORD_GUILD_ID) ?? null;
    if (!guild) {
      throw new Error(`Guild ${DISCORD_GUILD_ID} is not available to the logged-in bot`);
    }
    originalEveryonePermissions = guild.roles.everyone.permissions.bitfield;
    preExistingTestEntityIds = getTestEntityIds(guild);
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
    const { checkBotRolePosition, checkBotPermissions } = await import('../src/guards/bot-role-guard.js');
    const roleCheck = await checkBotRolePosition(guild);
    assert(roleCheck.isTopPosition, 'Bot role at position #1');
    const permCheck = checkBotPermissions(guild);
    assert(permCheck.hasRequired, 'Bot has required permissions');

    // Test 4: Deploy with cleanExisting=false (additive only, safe for test server)
    console.log('\nTest 4: Live Deploy (additive, no cleanup)');
    const { deployServerState } = await import('../src/deploy/deployer.js');

    const result = await deployServerState(guild, supabase, TEST_DESIRED_STATE, {
      cleanExisting: false,
      dryRun: false,
      onProgress: (step, total, action) => {
        console.log(`    [${step}/${total}] ${action}`);
      },
    });

    idMappings = result.idMappings;
    assert(result.success, `Deploy succeeded (${result.duration}ms)`);
    console.log(`  Actions: ${result.actions.length}, Errors: ${result.errors.length}, ID mappings: ${result.idMappings.length}`);

    for (const action of result.actions) {
      console.log(`    ${action.success ? 'ok' : 'fail'} ${action.action} ${action.entityType}: ${action.entityName}${action.error ? ' - ' + action.error : ''}`);
    }
    for (const err of result.errors) {
      console.log(`    ERROR: ${err.entityName}: ${err.error}`);
    }

    assert(result.idMappings.length > 0, `ID mappings created (${result.idMappings.length})`);

    // Test 5: Audit log
    console.log('\nTest 5: Audit Log');
    try {
      const { writeAuditLog } = await import('../src/services/audit.js');
      await writeAuditLog(supabase, {
        guildId: DISCORD_GUILD_ID,
        actorType: 'bot',
        actorId: 'deploy-live-e2e',
        action: 'test.e2e.completed',
        details: { actionCount: result.actions.length, duration: result.duration },
        success: true,
      });

      const { data: auditLogs } = await supabase.from('audit_logs').select('action, success')
        .eq('guild_id', DISCORD_GUILD_ID).eq('action', 'test.e2e.completed')
        .order('timestamp', { ascending: false }).limit(1);
      assert(auditLogs !== null && auditLogs.length > 0, 'Audit log written and readable');
      passed++; console.log('  ok writeAuditLog executed without error');
    } catch (err) {
      console.log(`  fail Audit log error: ${err}`);
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
        .eq('guild_id', DISCORD_GUILD_ID)
        .limit(1000);
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
    const listener = await import('../src/deploy/deploy-listener.js');
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

    exitCode = failed > 0 ? 1 : 0;
  } catch (err) {
    console.error('Fatal:', err);
    exitCode = 1;
  } finally {
    console.log('\nCleanup: Restoring live E2E state...');
    let cleanupFailed = false;

    try {
      await cleanupDiscord(guild, idMappings, preExistingTestEntityIds, originalEveryonePermissions);
    } catch (err) {
      console.error('  Discord cleanup failed:', err);
      cleanupFailed = true;
    }

    try {
      await cleanupDatabase(supabase, snapshot);
    } catch (err) {
      console.error('  Database cleanup failed:', err);
      cleanupFailed = true;
    }

    if (cleanupFailed) {
      exitCode = 1;
    } else {
      console.log('  Cleanup complete');
    }

    client.destroy();
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
