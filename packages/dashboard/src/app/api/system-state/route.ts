import { NextResponse, type NextRequest } from 'next/server';
import { RuntimeSystemStateSchema, type RuntimeSystemState } from '@somnibot/shared';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkValkeyHealth, readValkeyKey } from '@/lib/api/rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  SystemStateEvidenceSchema,
  buildDashboardSystemState,
  type SystemStateEvidence,
} from '@/lib/system-state';

const BOT_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
const EVIDENCE_ACTIONS = [
  'launcher.backup.database_succeeded',
  'launcher.backup.valkey_succeeded',
  'launcher.restore.rehearsal_succeeded',
] as const;
function parseRuntimeHeartbeat(raw: string | null): RuntimeSystemState | null {
  if (!raw) return null;
  try {
    const heartbeat: unknown = JSON.parse(raw);
    if (heartbeat === null || typeof heartbeat !== 'object' || !('systemState' in heartbeat)) return null;
    const parsed = RuntimeSystemStateSchema.safeParse(heartbeat.systemState);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const admin = createAdminSupabase();
  const [valkeyConnected, heartbeatRaw, evidenceResult, dlqResult, migrationResult] = await Promise.all([
    checkValkeyHealth(),
    readValkeyKey(BOT_HEARTBEAT_KEY),
    admin
      .from('audit_logs')
      .select('action, timestamp, success, details')
      .eq('guild_id', auth.ctx.guildId)
      .in('action', [...EVIDENCE_ACTIONS])
      .order('timestamp', { ascending: false })
      .limit(100),
    admin
      .from('action_queue_dlq')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', auth.ctx.guildId)
      .eq('acknowledged', false),
    admin
      .from('schema_migrations')
      .select('filename')
      .eq('status', 'applied')
      .order('applied_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const evidence: SystemStateEvidence[] = [];
  for (const row of evidenceResult.data ?? []) {
    const parsed = SystemStateEvidenceSchema.safeParse(row);
    if (parsed.success) evidence.push(parsed.data);
  }
  const observedRuntime = parseRuntimeHeartbeat(heartbeatRaw);
  const runtime = observedRuntime && !observedRuntime.identity.migrationHead && migrationResult.data?.filename
    ? {
        ...observedRuntime,
        identity: { ...observedRuntime.identity, migrationHead: migrationResult.data.filename },
      }
    : observedRuntime;
  const state = buildDashboardSystemState({
    observedAt: new Date().toISOString(),
    guildId: auth.ctx.guildId,
    runtime,
    valkeyConnected,
    supabaseConnected: evidenceResult.error === null,
    dlqDepth: dlqResult.error ? null : dlqResult.count ?? 0,
    evidence,
    credentials: [],
  });

  return NextResponse.json({ success: true, data: state });
}
