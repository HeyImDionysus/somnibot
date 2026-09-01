import { NextResponse, type NextRequest } from 'next/server';
import { UpgradeGateInputSchema, evaluateUpgradeGate } from '@somnibot/shared';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(request, UpgradeGateInputSchema);
  if (!parsed.ok) return parsed.response;

  const result = evaluateUpgradeGate(parsed.data);
  const { error } = await createAdminSupabase().from('audit_logs').insert({
    guild_id: auth.ctx.guildId,
    actor_type: 'dashboard',
    actor_id: auth.ctx.discordId,
    action: 'upgrade.compatibility_evaluated',
    category: 'infrastructure',
    target_type: 'deployment',
    target_id: result.operationId,
    correlation_id: result.operationId,
    occurrence_key: `upgrade.compatibility_evaluated:${result.operationId}`,
    success: result.status === 'ready',
    details: {
      schemaVersion: result.schemaVersion,
      status: result.status,
      currentVersion: parsed.data.currentVersion,
      candidateVersion: parsed.data.candidateVersion,
      currentSha: parsed.data.currentSha,
      candidateSha: parsed.data.candidateSha,
      blockerCodes: result.blockers.map((blocker) => blocker.code),
      expectedDowntimeSeconds: result.expectedDowntimeSeconds,
      postUpgradeChecks: result.postUpgradeChecks,
    },
    error_message: result.status === 'blocked' ? 'Upgrade compatibility gate blocked activation.' : null,
  });
  if (error) return dbError(error, 'upgrade compatibility audit');

  return NextResponse.json({ success: true, data: result });
}
