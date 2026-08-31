import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

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

const DiagnosticIncidentSchema = z.object({
  incident_number: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'critical', 'outage']),
  status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed']),
  started_at: z.string().datetime({ offset: true }).nullable(),
  resolved_at: z.string().datetime({ offset: true }).nullable(),
});

const DiagnosticOperationSchema = z.object({
  category: z.enum([
    'members', 'moderation', 'tickets', 'commerce', 'subscriptions', 'levels', 'giveaways',
    'economy', 'music', 'polls', 'predictions', 'temp_channels', 'scheduled_messages',
    'starboard', 'stats_channels', 'custom_commands', 'automations', 'webhooks', 'rbac',
    'incidents', 'profiles', 'diagnostics', 'sync', 'system',
  ]).nullable(),
  correlation_id: z.string().uuid().nullable(),
  success: z.boolean(),
  timestamp: z.string().datetime({ offset: true }),
});

function projectRows<T>(rows: unknown, schema: z.ZodType<T>): readonly T[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const admin = createAdminSupabase();

  const [migration, diagnostics, incidents, operations, dlq] = await Promise.all([
    admin.from('schema_migrations').select('filename, applied_at').order('applied_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('bot_diagnostics').select('snapshot_at, uptime_seconds, boot_id, valkey_connected').eq('guild_id', auth.ctx.guildId).order('snapshot_at', { ascending: false }).limit(5),
    admin.from('incidents').select('incident_number, severity, status, started_at, resolved_at').eq('guild_id', auth.ctx.guildId).order('created_at', { ascending: false }).limit(50),
    admin.from('audit_logs').select('category, correlation_id, success, timestamp').eq('guild_id', auth.ctx.guildId).order('timestamp', { ascending: false }).limit(100),
    admin.from('action_queue_dlq').select('id', { count: 'exact', head: true }).eq('guild_id', auth.ctx.guildId).eq('acknowledged', false),
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

  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    deployment: {
      dashboardVersion: parsedVersion.success ? parsedVersion.data : 'unknown',
      exactSha: parsedSha.success ? parsedSha.data : null,
      migrationHead: parsedMigration.success ? parsedMigration.data.filename : null,
      migrationAppliedAt: parsedMigration.success ? parsedMigration.data.applied_at : null,
    },
    health: projectRows(diagnostics.data, DiagnosticHealthSchema),
    queue: { deadLetterDepth: dlq.error ? null : dlq.count ?? 0 },
    incidents: projectRows(incidents.data, DiagnosticIncidentSchema),
    operations: projectRows(operations.data, DiagnosticOperationSchema),
    queryFailures,
  };

  return NextResponse.json({ success: true, data: bundle }, {
    headers: {
      'Content-Disposition': `attachment; filename="somnibot-diagnostic-${auth.ctx.guildId}.json"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
