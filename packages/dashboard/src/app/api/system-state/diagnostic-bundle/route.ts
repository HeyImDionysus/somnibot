import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { OperationStageSchema } from '@somnibot/shared';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { guildConfigPatchSchema } from '@/lib/guild-config-schema';

const DiagnosticMigrationSchema = z.object({
  filename: z.string().regex(/^\d{14}_[a-z0-9_]+\.sql$/),
  applied_at: z.string().datetime({ offset: true }),
});

const DiagnosticHealthSchema = z.object({
  snapshot_at: z.string().datetime({ offset: true }),
  uptime_seconds: z.number().int().nonnegative(),
  boot_id: z.string().uuid().nullable(),
  valkey_connected: z.boolean(),
});

const DiagnosticProviderObservationSchema = DiagnosticHealthSchema.extend({
  discord_ws_ping: z.number().finite(),
  lavalink_nodes: z.array(z.object({ connected: z.boolean() })).max(100),
});

const DiagnosticConfigurationSchema = guildConfigPatchSchema.pick({
  music_enabled: true,
  economy_enabled: true,
  economy_games_enabled: true,
  store_enabled: true,
  paypal_enabled: true,
  paypal_environment: true,
  automod_enabled: true,
  scheduled_messages_enabled: true,
  diagnostics_snapshot_interval_ms: true,
}).required().strip();

const DiagnosticActionSchema = z.enum([
  'config.updated', 'automation.executed', 'webhook.received', 'webhook.replayed',
  'diagnostics.snapshot_failed', 'diagnostics.alert_raised', 'diagnostics.alert_resolved',
  'sync.completed', 'sync.failed', 'setup.deployed', 'setup.failed',
  'commerce.fulfillment_failed', 'dashboard.adoption_map.published', 'unclassified',
]).catch('unclassified');

const DiagnosticLifecycleSchema = z.object({
  id: z.string().uuid(),
  current_stage: OperationStageSchema,
  outcome: z.enum(['active', 'completed', 'failed', 'recovering', 'rolled_back', 'compensated', 'forward_fixed']),
  source_surface: z.enum(['dashboard', 'discord', 'launcher', 'portal', 'sdk', 'system']),
  configuration_generation: z.number().int().nonnegative().nullable(),
  failure_code: z.enum([
    'provider_rejected', 'provider_uncertain', 'local_commit_failed', 'permission_denied',
    'provider_unavailable', 'delivery_failed', 'audit_failed', 'verification_failed',
    'configuration_changed', 'conflict_detected', 'timeout', 'unclassified',
  ]).nullable().catch('unclassified'),
  updated_at: z.string().datetime({ offset: true }),
});

const DiagnosticIncidentSchema = z.object({
  incident_number: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'critical', 'outage']),
  status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed']),
  started_at: z.string().datetime({ offset: true }).nullable(),
  resolved_at: z.string().datetime({ offset: true }).nullable(),
});

const DiagnosticOperationSchema = z.object({
  action: DiagnosticActionSchema,
  category: z.enum([
    'members', 'moderation', 'tickets', 'commerce', 'subscriptions', 'levels', 'giveaways',
    'economy', 'music', 'polls', 'predictions', 'temp_channels', 'scheduled_messages',
    'starboard', 'stats_channels', 'custom_commands', 'automations', 'webhooks', 'rbac',
    'incidents', 'profiles', 'diagnostics', 'sync', 'system', 'configuration',
  ]).nullable().catch(null),
  correlation_id: z.string().uuid().nullable(),
  success: z.boolean(),
  timestamp: z.string().datetime({ offset: true }),
}).transform((row) => ({
  ...row,
  failureClass: row.success ? null
    : row.action === 'diagnostics.snapshot_failed' ? 'snapshot_failure'
    : row.action === 'commerce.fulfillment_failed' ? 'fulfillment_failure'
    : row.action === 'automation.executed' ? 'automation_failure'
    : row.action === 'sync.failed' || row.action === 'setup.failed' ? 'structure_failure'
    : 'unclassified',
}));

function projectRows<T>(rows: unknown, schema: z.ZodType<T>): readonly T[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

function providerObservations(rows: unknown, queryFailed: boolean, generatedAt: string, maxAgeMs: number) {
  const parsed = DiagnosticProviderObservationSchema.safeParse(Array.isArray(rows) ? rows[0] : null);
  const observation = !queryFailed && parsed.success ? parsed.data : null;
  const checkedAt = observation?.snapshot_at ?? null;
  const ageMs = checkedAt === null ? null : Date.parse(generatedAt) - Date.parse(checkedAt);
  const reason = queryFailed ? 'query_failed' : !observation ? 'not_observed'
    : ageMs !== null && (ageMs > maxAgeMs || ageMs < -30_000) ? 'stale_observation' : null;
  if (!observation || reason !== null) {
    return ['discord', 'valkey', 'lavalink'].map((key) => ({ key, status: 'unknown', checkedAt, reason }));
  }
  const connectedNodes = observation.lavalink_nodes.filter((node) => node.connected).length;
  return [
    { key: 'discord', status: observation.discord_ws_ping >= 0 ? 'ready' : 'unavailable', checkedAt, reason: null },
    { key: 'valkey', status: observation.valkey_connected ? 'ready' : 'unavailable', checkedAt, reason: null },
    {
      key: 'lavalink',
      status: observation.lavalink_nodes.length === 0 ? 'unknown'
        : connectedNodes === 0 ? 'unavailable'
        : connectedNodes === observation.lavalink_nodes.length ? 'ready' : 'degraded',
      checkedAt,
      reason: observation.lavalink_nodes.length === 0 ? 'not_observed' : null,
    },
  ];
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const admin = createAdminSupabase();

  const [migration, diagnostics, incidents, operations, dlq, configuration, lifecycle] = await Promise.all([
    admin.from('schema_migrations').select('filename, applied_at').eq('success', true).order('applied_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('bot_diagnostics').select('snapshot_at, uptime_seconds, boot_id, valkey_connected, discord_ws_ping, lavalink_nodes').eq('guild_id', auth.ctx.guildId).eq('type', 'health').order('snapshot_at', { ascending: false }).limit(5),
    admin.from('incidents').select('incident_number, severity, status, started_at, resolved_at').eq('guild_id', auth.ctx.guildId).order('created_at', { ascending: false }).limit(50),
    admin.from('audit_logs').select('action, category, correlation_id, success, timestamp').eq('guild_id', auth.ctx.guildId).order('timestamp', { ascending: false }).limit(100),
    admin.from('action_queue_dlq').select('id', { count: 'exact', head: true }).eq('guild_id', auth.ctx.guildId).eq('acknowledged', false),
    admin.from('guild_config').select(Object.keys(DiagnosticConfigurationSchema.shape).join(', ')).eq('guild_id', auth.ctx.guildId).maybeSingle(),
    admin.from('significant_operations').select('id, current_stage, outcome, source_surface, configuration_generation, failure_code, updated_at').eq('guild_id', auth.ctx.guildId).order('updated_at', { ascending: false }).limit(100),
  ]);

  const parsedMigration = DiagnosticMigrationSchema.safeParse(migration.data);
  const parsedSha = z.string().regex(/^[0-9a-f]{40}$/i).safeParse(
    process.env.SOMNIBOT_GIT_SHA ?? process.env.GITHUB_SHA,
  );
  const parsedVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/).safeParse(
    process.env.npm_package_version,
  );
  const queryFailures: string[] = [];
  if (migration.error) queryFailures.push('migration');
  if (diagnostics.error) queryFailures.push('health');
  if (incidents.error) queryFailures.push('incidents');
  if (operations.error) queryFailures.push('operations');
  if (dlq.error) queryFailures.push('queue');
  if (configuration.error) queryFailures.push('configuration');
  if (lifecycle.error) queryFailures.push('operation_lifecycle');

  const generatedAt = new Date().toISOString();
  const parsedConfiguration = DiagnosticConfigurationSchema.safeParse(configuration.data);
  const configurationValues = !configuration.error && parsedConfiguration.success ? parsedConfiguration.data : null;

  const bundle = {
    schemaVersion: 1,
    generatedAt,
    deployment: {
      dashboardVersion: parsedVersion.success ? parsedVersion.data : 'unknown',
      exactSha: parsedSha.success ? parsedSha.data : null,
      migrationHead: parsedMigration.success ? parsedMigration.data.filename : null,
      migrationAppliedAt: parsedMigration.success ? parsedMigration.data.applied_at : null,
    },
    health: projectRows(diagnostics.data, DiagnosticHealthSchema),
    configuration: {
      status: configuration.error ? 'query_failed' : configurationValues ? 'available'
        : configuration.data == null ? 'unavailable' : 'invalid',
      values: configurationValues,
    },
    providers: [
      ...providerObservations(diagnostics.data, Boolean(diagnostics.error), generatedAt,
        Math.max(120_000, (configurationValues?.diagnostics_snapshot_interval_ms ?? 60_000) * 2)),
      { key: 'supabase', status: queryFailures.length === 0 ? 'ready' : 'degraded', checkedAt: generatedAt, reason: queryFailures.length === 0 ? null : 'query_failed' },
      { key: 'paypal', status: 'unknown', checkedAt: null, reason: 'not_observed' },
    ],
    queue: { deadLetterDepth: dlq.error ? null : dlq.count ?? 0 },
    incidents: projectRows(incidents.data, DiagnosticIncidentSchema),
    operations: projectRows(operations.data, DiagnosticOperationSchema),
    operationLifecycle: projectRows(lifecycle.data, DiagnosticLifecycleSchema),
    queryFailures,
  };

  return NextResponse.json({ success: true, data: bundle }, {
    headers: {
      'Content-Disposition': `attachment; filename="somnibot-diagnostic-${generatedAt.replace(/:/g, '-')}.json"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
