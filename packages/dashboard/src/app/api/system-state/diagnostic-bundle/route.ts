import { NextResponse, type NextRequest } from 'next/server';
import { redactDiagnosticValue } from '@somnibot/shared';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const admin = createAdminSupabase();

  const [migration, diagnostics, incidents, operations, dlq, credentials] = await Promise.all([
    admin.from('schema_migrations').select('filename, checksum, applied_at, status').order('applied_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('bot_diagnostics').select('type, snapshot_at, uptime_seconds, boot_id, valkey_connected, lavalink_nodes').eq('guild_id', auth.ctx.guildId).order('snapshot_at', { ascending: false }).limit(5),
    admin.from('incidents').select('id, incident_number, severity, status, source, started_at, resolved_at').eq('guild_id', auth.ctx.guildId).order('created_at', { ascending: false }).limit(50),
    admin.from('audit_logs').select('action, category, target_type, target_id, correlation_id, occurrence_key, success, error_message, timestamp').eq('guild_id', auth.ctx.guildId).order('timestamp', { ascending: false }).limit(100),
    admin.from('action_queue_dlq').select('id', { count: 'exact', head: true }).eq('guild_id', auth.ctx.guildId).eq('acknowledged', false),
    admin.from('instance_settings').select('key, value, updated_at').like('key', '%_encrypted').limit(100),
  ]);

  const bundle = redactDiagnosticValue({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    deployment: {
      dashboardVersion: process.env.npm_package_version ?? 'unknown',
      exactSha: process.env.SOMNIBOT_GIT_SHA ?? process.env.GITHUB_SHA ?? null,
      migrationHead: migration.data ?? null,
    },
    health: diagnostics.data ?? [],
    queue: { deadLetterDepth: dlq.error ? null : dlq.count ?? 0 },
    incidents: incidents.data ?? [],
    operations: operations.data ?? [],
    credentials: (credentials.data ?? []).map((row) => ({
      key: row.key,
      present: typeof row.value === 'string' && row.value.trim().length > 0,
      updatedAt: row.updated_at,
    })),
    queryFailures: [
      migration.error?.message,
      diagnostics.error?.message,
      incidents.error?.message,
      operations.error?.message,
      dlq.error?.message,
      credentials.error?.message,
    ].filter((message) => typeof message === 'string'),
  });

  return NextResponse.json({ success: true, data: bundle }, {
    headers: {
      'Content-Disposition': `attachment; filename="somnibot-diagnostic-${auth.ctx.guildId}.json"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
