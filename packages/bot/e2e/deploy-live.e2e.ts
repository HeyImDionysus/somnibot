/**
 * Opt-in live deploy E2E test.
 *
 * This script mutates Discord and Supabase. It must only run against a
 * disposable Discord guild and local Supabase database.
 */
import { ChannelType, Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
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

type SupabaseError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ok ${label}`); passed++; }
  else { console.log(`  fail ${label}`); failed++; }
}

function requireSupabaseOk(error: SupabaseError | null | undefined, action: string) {
  if (!error) {
    return;
  }

  const extras = [error.code, error.details, error.hint].filter(Boolean).join(' ');
  throw new Error(`${action} failed: ${error.message}${extras ? ` (${extras})` : ''}`);
}

function toDiscordIdMapRow(mapping: DeployResultMapping) {
  return {
    guild_id: DISCORD_GUILD_ID,
    entity_type: mapping.entityType,
    template_key: `${mapping.entityType}:${mapping.key}`,
    discord_id: mapping.discordId,
  };
}

async function captureSnapshot(supabase: SupabaseClient): Promise<SnapshotState> {
  const { data: desiredState, error: desiredStateErr } = await supabase
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', DISCORD_GUILD_ID)
    .maybeSingle();
  requireSupabaseOk(desiredStateErr, 'Snapshot guild_desired_state');

  const { data: guild, error: guildErr } = await supabase
    .from('guild')
    .select('setup_completed, setup_confirmed_at, bot_role_id, bot_role_position, total_roles')
    .eq('id', DISCORD_GUILD_ID)
    .maybeSingle();
  requireSupabaseOk(guildErr, 'Snapshot guild');

  const { data: discordIdMap, error: discordIdMapErr } = await supabase
    .from('discord_id_map')
    .select('*')
    .eq('guild_id', DISCORD_GUILD_ID);
  requireSupabaseOk(discordIdMapErr, 'Snapshot discord_id_map');

  return {
    desiredState: desiredState ?? null,
    guild: guild ?? null,
    discordIdMap: discordIdMap ?? [],
  };
}

async function ensureLocalGuildRow(
  supabase: SupabaseClient,
  guild: Guild,
  snapshot: SnapshotState,
) {
  if (snapshot.guild) {
    return;
  }

  const { error } = await supabase.from('guild').insert({
    id: guild.id,
    name: guild.name,
    owner_discord_id: guild.ownerId,
  });
  requireSupabaseOk(error, 'Seed local E2E guild row');
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
  const cleanupErrors: string[] = [];

  try {
    for (const mapping of mappings.filter((mapping) => mapping.entityType === 'role')) {
      const role = guild.roles.cache.get(mapping.discordId);
      if (role && !role.managed) {
        try {
          await role.delete(cleanupReason);
          console.log(`  Deleted role: ${role.name}`);
        } catch (err) {
          const message = `Failed to delete role ${mapping.key}: ${err}`;
          cleanupErrors.push(message);
          console.log(`  ${message}`);
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
          const message = `Failed to delete channel ${mapping.key}: ${err}`;
          cleanupErrors.push(message);
          console.log(`  ${message}`);
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
        const message = `Failed to delete role by name ${role.name}: ${err}`;
        cleanupErrors.push(message);
        console.log(`  ${message}`);
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
        const message = `Failed to delete channel by name ${channel.name}: ${err}`;
        cleanupErrors.push(message);
        console.log(`  ${message}`);
      }
    }
  } finally {
    if (originalEveryonePermissions !== null) {
      try {
        await guild.roles.everyone.setPermissions(originalEveryonePermissions, `${cleanupReason} - restore @everyone`);
        console.log('  Restored @everyone permissions');
      } catch (err) {
        const message = `Failed to restore @everyone permissions: ${err}`;
        cleanupErrors.push(message);
        console.log(`  ${message}`);
      }
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`Discord cleanup left resources behind: ${cleanupErrors.join('; ')}`);
  }
}

async function cleanupDatabase(supabase: SupabaseClient, snapshot: SnapshotState | null) {
  if (!snapshot) {
    return;
  }

  const { error: deleteMapErr } = await supabase.from('discord_id_map').delete().eq('guild_id', DISCORD_GUILD_ID);
  requireSupabaseOk(deleteMapErr, 'Delete discord_id_map rows');

  if (snapshot.discordIdMap.length > 0) {
    const { error: restoreMapErr } = await supabase.from('discord_id_map').upsert(snapshot.discordIdMap);
    requireSupabaseOk(restoreMapErr, 'Restore discord_id_map rows');
  }

  // audit_logs is append-only in migrated databases, so cleanup must not delete or replay entries.

  if (snapshot.desiredState) {
    const { error: restoreDesiredStateErr } = await supabase.from('guild_desired_state').upsert(snapshot.desiredState);
    requireSupabaseOk(restoreDesiredStateErr, 'Restore guild_desired_state');
  } else {
    const { error: deleteDesiredStateErr } = await supabase.from('guild_desired_state').delete().eq('guild_id', DISCORD_GUILD_ID);
    requireSupabaseOk(deleteDesiredStateErr, 'Delete guild_desired_state');
  }

  if (snapshot.guild) {
    const { error: restoreGuildErr } = await supabase.from('guild').update(snapshot.guild).eq('id', DISCORD_GUILD_ID);
    requireSupabaseOk(restoreGuildErr, 'Restore guild row');
  } else {
    const { data: purgeResult, error: purgeErr } = await supabase.rpc('purge_guild_data', {
      p_guild_id: DISCORD_GUILD_ID,
    });
    requireSupabaseOk(purgeErr, 'Purge seeded local E2E guild row');
    if (purgeResult?.purge_status !== 'completed' || purgeResult?.guild_deleted !== 1) {
      throw new Error('Purge seeded local E2E guild row returned an unexpected result');
    }
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
    if (!client.isReady()) {
      await new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    }
    guild = client.guilds.cache.get(DISCORD_GUILD_ID) ?? null;
    if (!guild) {
      throw new Error(`Guild ${DISCORD_GUILD_ID} is not available to the logged-in bot`);
    }
    await ensureLocalGuildRow(supabase, guild, snapshot);
    originalEveryonePermissions = guild.roles.everyone.permissions.bitfield;
    preExistingTestEntityIds = getTestEntityIds(guild);
    console.log(`Connected: ${client.user?.tag} in ${guild.name}\n`);

    // Test 1: Supabase
    console.log('Test 1: Supabase Connectivity');
    const { error: guildErr } = await supabase.from('guild').select('id').eq('id', DISCORD_GUILD_ID).single();
    assert(!guildErr, 'Guild table accessible');

    // Test 2: Write desired state
    console.log('\nTest 2: Request Desired State Deployment');
    const requestId = crypto.randomUUID();
    const { data: requestResult, error: writeErr } = await supabase.rpc(
      'request_server_deployment',
      {
        p_guild_id: DISCORD_GUILD_ID,
        p_request_id: requestId,
        p_roles: TEST_DESIRED_STATE.roles,
        p_channels: TEST_DESIRED_STATE.channels,
        p_categories: TEST_DESIRED_STATE.categories,
        p_permission_map: {},
        p_deploy_mode: 'safe',
        p_requested_at: new Date().toISOString(),
      },
    );
    requireSupabaseOk(writeErr, 'Request desired-state deployment');
    assert(requestResult?.disposition === 'accepted', 'Deployment request accepted');

    const { data: readBack } = await supabase.from('guild_desired_state').select('*').eq('guild_id', DISCORD_GUILD_ID).single();
    assert(readBack?.deploy_request_id === requestId, 'Requested lifecycle row stores the exact request ID');
    assert(readBack?.deploy_status === 'requested', 'Desired state is pending an atomic claim');
    assert(readBack?.applied_at === null, 'applied_at remains null before settlement');
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
    console.log('\nTest 4: Live Claimed Deploy (additive, no cleanup)');
    const lifecycle = await import('../src/deploy/deploy-request-lifecycle.js');
    const executor = await import('../src/deploy/deploy-executor.js');
    const { eventBus } = await import('../src/services/event-bus.js');
    const deployClient = Object.assign(client, { supabase, eventBus });
    const requested = lifecycle.parseRequestedDeployRow(readBack, DISCORD_GUILD_ID);
    if (!requested) throw new Error('Stored deployment request did not satisfy the production request schema');
    const claimed = await lifecycle.claimDeployRequest(deployClient, requested);
    if (!claimed) throw new Error('Deployment request could not be claimed');
    assert(claimed.deploy_status === 'running', 'Deployment request claimed as running');
    assert(claimed.deploy_request_id === requestId, 'Claim preserved the exact request ID');
    assert(Boolean(claimed.deploy_claim_token), 'Claim received a private lease token');

    await executor.executeClaimedDeployment(
      deployClient,
      lifecycle.desiredStateFromDeployRow(claimed),
      claimed,
      {
        cleanExisting: false,
        dryRun: false,
        onProgress: (step, total, action) => {
          console.log(`    [${step}/${total}] ${action}`);
        },
      },
    );
    const deployStatus = executor.getDeployStatus(DISCORD_GUILD_ID);
    const result = deployStatus?.result;
    if (!result) throw new Error('Lifecycle executor did not publish a deployment result');

    idMappings = result.idMappings;
    assert(deployStatus?.status === 'success', 'Lifecycle executor reported success');
    assert(result.success, `Deploy succeeded (${result.duration}ms)`);
    console.log(`  Actions: ${result.actions.length}, Errors: ${result.errors.length}, ID mappings: ${result.idMappings.length}`);

    for (const action of result.actions) {
      console.log(`    ${action.success ? 'ok' : 'fail'} ${action.action} ${action.entityType}: ${action.entityName}${action.error ? ' - ' + action.error : ''}`);
    }
    for (const err of result.errors) {
      console.log(`    ERROR: ${err.entityName}: ${err.error}`);
    }

    assert(result.idMappings.length > 0, `ID mappings created (${result.idMappings.length})`);
    const { data: settledState, error: settledStateErr } = await supabase
      .from('guild_desired_state')
      .select('deploy_request_id, deploy_status, deploy_claim_token, deploy_lease_expires_at, deploy_completed_at, applied_at')
      .eq('guild_id', DISCORD_GUILD_ID)
      .single();
    requireSupabaseOk(settledStateErr, 'Read settled deployment lifecycle');
    assert(settledState?.deploy_request_id === requestId, 'Settlement preserved the exact request ID');
    assert(settledState?.deploy_status === 'success', 'Claim settled as success');
    assert(settledState?.deploy_claim_token === null, 'Private claim token cleared on settlement');
    assert(settledState?.deploy_lease_expires_at === null, 'Lease cleared on settlement');
    assert(Boolean(settledState?.deploy_completed_at), 'Completion timestamp persisted');
    assert(Boolean(settledState?.applied_at), 'Successful settlement marked desired state applied');

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
        result.idMappings.map(toDiscordIdMapRow),
        { onConflict: 'guild_id,entity_type,template_key' },
      );
      assert(!mapErr, `ID mappings stored (${mapErr?.message ?? 'ok'})`);

      const { data: mapData } = await supabase.from('discord_id_map').select('*')
        .eq('guild_id', DISCORD_GUILD_ID)
        .limit(1000);
      assert(mapData !== null && mapData.length >= result.idMappings.length, `${mapData?.length} mappings in DB`);
      const expectedTemplateKeys = result.idMappings.map((mapping) => toDiscordIdMapRow(mapping).template_key);
      assert(
        mapData !== null && expectedTemplateKeys.every((templateKey) => (
          mapData.some((row) => row.template_key === templateKey)
        )),
        'production ID mapping keys stored',
      );
    }

    // Test 7: Setup confirm flow
    console.log('\nTest 7: Setup Confirmation');
    const { error: confirmErr } = await supabase.from('guild').update({ setup_completed: true, setup_confirmed_at: new Date().toISOString() }).eq('id', DISCORD_GUILD_ID);
    assert(!confirmErr, 'Setup confirmed');

    const { data: guildData } = await supabase.from('guild').select('setup_completed, setup_confirmed_at').eq('id', DISCORD_GUILD_ID).single();
    assert(guildData?.setup_completed === true, 'setup_completed is true');

    // Test 8: Listener module
    console.log('\nTest 8: Deploy Listener Module');
    const listener = await import('../src/deploy/deploy-listener.js');
    assert(typeof listener.startDeployListener === 'function', 'startDeployListener exported');
    assert(typeof listener.getDeployStatus === 'function', 'getDeployStatus exported');
    assert(listener.getDeployStatus(DISCORD_GUILD_ID)?.status === 'success', 'Listener status exposes the settled deployment');

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
